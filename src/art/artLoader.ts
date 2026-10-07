import type { ArtSource } from "../data/types";
import { isTauri } from "../platform";

/** Quellen, die wirklich geladen werden müssen (alles außer dem generierten Cover). */
export type RemoteArtSource = Exclude<ArtSource, { kind: "generated" }>;

/** So viele Bilder (Blob-URLs) hält der Cache höchstens vor – ältere, gerade ungenutzte werden verdrängt. */
export const ART_CACHE_MAX = 120;
/** Höchstens so viele Bilder werden gleichzeitig geladen, damit Jellyfin und die Platte nicht überrollt werden. */
export const ART_MAX_PARALLEL = 3;
/** Nach so langer Zeit gilt ein Ladevorgang als gescheitert; das generierte Cover bleibt stehen. */
export const ART_TIMEOUT_MS = 20_000;
/** Ein gescheitertes Bild wird so lange nicht erneut versucht (kein Fehlerspam bei jedem Fokuswechsel). */
const FAIL_RETRY_MS = 60_000;
/** Größere Dateien sind kein Cover mehr (Schutz vor versehentlich gewählten Riesenbildern/Videos). */
const MAX_BYTES = 32 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

const IMAGE_MIMES = new Set(Object.values(MIME_BY_EXT));

/** Erkennt das Bildformat an den ersten Bytes (verlässlicher als Endung oder Content-Type). */
function sniffMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 //   "WEBP"
  ) {
    return "image/webp";
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // "ftyp" + Marke "avif"/"avis"
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Eindeutiger Cache-Schlüssel einer Quelle (Header gehören dazu: andere Anmeldung = anderes Bild möglich). */
export function artKey(source: RemoteArtSource): string {
  if (source.kind === "file") return `file:${source.path}`;
  const headers = source.headers
    ? Object.entries(source.headers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k.toLowerCase()}=${v}`)
        .join("&")
    : "";
  return headers ? `http:${source.url}|${headers}` : `http:${source.url}`;
}

/* ------------------------------------------------------------------ Laden */

async function readLocal(path: string): Promise<Blob> {
  if (!isTauri()) throw new Error("Lokale Bilder gibt es nur in der Tauri-App");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_BYTES) throw new Error("Bild zu groß");
  const mime = sniffMime(bytes) ?? MIME_BY_EXT[extOf(path)];
  if (!mime) throw new Error("Unbekanntes Bildformat");
  return new Blob([bytes], { type: mime });
}

async function fetchRemote(
  source: Extract<RemoteArtSource, { kind: "http" }>,
  signal: AbortSignal,
): Promise<Blob> {
  // In der App über das HTTP-Plugin (kein CORS/ATS-Ärger), im Browser über das normale fetch.
  const doFetch: typeof fetch = isTauri()
    ? (await import("@tauri-apps/plugin-http")).fetch
    : window.fetch.bind(window);
  const res = await doFetch(source.url, { headers: source.headers, signal });
  // Ungelesene Antworten freigeben (beim HTTP-Plugin hängt sonst die Antwort auf der Rust-Seite).
  const discard = () => void res.body?.cancel().catch(() => {});
  if (!res.ok) {
    discard();
    throw new Error(`HTTP ${res.status}`);
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) {
    discard();
    throw new Error("Bild zu groß");
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error("Bild zu groß");
  const bytes = new Uint8Array(buf);
  const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  // Der Inhalt zählt: ein Server, der HTML mit Status 200 liefert, ist kein Bild.
  const mime = sniffMime(bytes) ?? (IMAGE_MIMES.has(declared) ? declared : null);
  if (!mime) throw new Error("Antwort ist kein Bild");
  return new Blob([buf], { type: mime });
}

/* ------------------------------------------------------------------ Cache */

type SlotState = "queued" | "loading" | "ready" | "failed";

interface Slot {
  key: string;
  source: RemoteArtSource;
  /** Wie viele Anzeigen das Bild gerade brauchen. Nur Einträge ohne Nutzer dürfen verdrängt/abgebrochen werden. */
  refs: number;
  /** Zeitstempel der letzten Nutzung (LRU). */
  tick: number;
  state: SlotState;
  urgent: boolean;
  url: string | null;
  failedAt: number;
  /** Wurde abgebrochen, weil niemand das Bild mehr braucht. */
  cancelled: boolean;
  controller: AbortController | null;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
}

const slots = new Map<string, Slot>();
const queue: Slot[] = [];
let running = 0;
let clock = 0;
let pumpScheduled = false;
const stats = { created: 0, revoked: 0, started: 0, failed: 0, aborted: 0 };

const CANCELLED = new Error("Abgebrochen");

function newSlot(key: string, source: RemoteArtSource, urgent: boolean): Slot {
  let resolve!: (url: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // Fehler sind erwartet; Verbraucher behandeln sie selbst
  return {
    key,
    source,
    refs: 0,
    tick: 0,
    state: "queued",
    urgent,
    url: null,
    failedAt: 0,
    cancelled: false,
    controller: null,
    promise,
    resolve,
    reject,
  };
}

function dropSlot(s: Slot) {
  if (s.url) {
    URL.revokeObjectURL(s.url);
    s.url = null;
    stats.revoked++;
  }
  if (slots.get(s.key) === s) slots.delete(s.key);
}

/** Verdrängt die am längsten ungenutzten Bilder, aber nie eines, das gerade angezeigt wird. */
function evict() {
  let over = slots.size - ART_CACHE_MAX;
  if (over <= 0) return;
  const idle = [...slots.values()]
    .filter((s) => s.refs === 0 && (s.state === "ready" || s.state === "failed"))
    .sort((a, b) => a.tick - b.tick);
  for (const s of idle) {
    if (over-- <= 0) break;
    dropSlot(s);
  }
}

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  // Erst nach dem aktuellen Render: kurzlebige Anforderungen (React-StrictMode, schnelles Durchblättern)
  // werden so abgebrochen, bevor ein Netzwerkzugriff entsteht.
  queueMicrotask(() => {
    pumpScheduled = false;
    pump();
  });
}

function takeNext(): Slot | undefined {
  let idx = queue.findIndex((s) => s.urgent);
  if (idx < 0) idx = 0;
  return queue.splice(idx, 1)[0];
}

function pump() {
  while (running < ART_MAX_PARALLEL && queue.length > 0) {
    const s = takeNext();
    if (s) void run(s);
  }
}

async function run(s: Slot) {
  s.state = "loading";
  running++;
  stats.started++;
  const controller = new AbortController();
  s.controller = controller;
  const timer = window.setTimeout(() => controller.abort(), ART_TIMEOUT_MS);
  try {
    const work = s.source.kind === "file" ? readLocal(s.source.path) : fetchRemote(s.source, controller.signal);
    // readFile kennt keinen Abbruch: der Timeout lässt dort nur das Warten enden.
    const timeout = new Promise<never>((_, rej) =>
      controller.signal.addEventListener("abort", () => rej(new Error("Zeitüberschreitung")), { once: true }),
    );
    const blob = await Promise.race([work, timeout]);
    if (s.cancelled) throw CANCELLED;
    s.url = URL.createObjectURL(blob);
    stats.created++;
    s.state = "ready";
    s.resolve(s.url);
  } catch (err) {
    if (s.cancelled) {
      stats.aborted++;
      dropSlot(s);
      s.reject(CANCELLED);
    } else {
      stats.failed++;
      s.state = "failed";
      s.failedAt = Date.now();
      s.reject(err);
      // Nicht s.key loggen: bei HTTP-Quellen stehen dort die Header (API-Key) drin.
      if (import.meta.env.DEV) {
        const where = s.source.kind === "file" ? s.source.path : s.source.url;
        console.debug("Cover nicht geladen:", where, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    window.clearTimeout(timer);
    s.controller = null;
    running--;
    evict();
    pump();
  }
}

/* ---------------------------------------------------------------- Zugriff */

export interface ArtHandle {
  /** Fertige Blob-URL, falls das Bild schon im Cache liegt (synchron); sonst null. */
  readonly url: string | null;
  /** Löst mit der Blob-URL auf; lehnt bei Fehlern, Zeitüberschreitung oder Abbruch ab. */
  readonly promise: Promise<string>;
  /** Gibt das Bild frei. Ohne weitere Nutzer wird ein laufender Ladevorgang abgebrochen bzw. der Eintrag verdrängbar. */
  release(): void;
  /** Das Bild ließ sich nicht darstellen (kaputte Datei): nicht erneut versuchen. */
  markBroken(): void;
}

/**
 * Fordert ein Bild an. Mehrere Anzeigen derselben Quelle teilen sich einen Ladevorgang und eine Blob-URL.
 * Jeder Aufruf muss mit release() beendet werden.
 *
 * @param urgent  Dringend (z. B. Detailkarte des Fokus-Eintrags): wird in der Warteschlange vorgezogen.
 */
export function acquireArt(source: RemoteArtSource, urgent = false): ArtHandle {
  const key = artKey(source);
  let slot = slots.get(key);
  if (slot && slot.state === "failed" && Date.now() - slot.failedAt > FAIL_RETRY_MS && slot.refs === 0) {
    dropSlot(slot);
    slot = undefined;
  }
  // Ein gerade abgebrochener Ladevorgang liefert kein Bild mehr: neu anfangen.
  if (slot?.cancelled) {
    slots.delete(key);
    slot = undefined;
  }
  const s = slot ?? newSlot(key, source, urgent);
  s.refs++;
  s.tick = ++clock;
  if (!slot) {
    slots.set(key, s);
    queue.push(s);
    schedulePump();
  } else if (urgent && s.state === "queued") {
    s.urgent = true;
  }

  const promise = s.state === "failed" ? Promise.reject(new Error("Bild nicht verfügbar")) : s.promise;
  if (s.state === "failed") promise.catch(() => {});
  let released = false;
  return {
    get url() {
      return s.state === "ready" ? s.url : null;
    },
    promise,
    release() {
      if (released) return;
      released = true;
      s.refs--;
      if (s.refs > 0) return;
      if (s.state === "queued") {
        const i = queue.indexOf(s);
        if (i >= 0) queue.splice(i, 1);
        s.cancelled = true;
        dropSlot(s);
        s.reject(CANCELLED);
      } else if (s.state === "loading") {
        // HTTP lässt sich abbrechen; eine Datei wird fertig gelesen und bleibt dann (verdrängbar) im Cache.
        if (s.source.kind === "http") {
          s.cancelled = true;
          s.controller?.abort();
        }
      } else {
        evict();
      }
    },
    markBroken() {
      if (s.state === "ready") {
        s.state = "failed";
        s.failedAt = Date.now();
      }
    },
  };
}

/** Messwerte für Tests und Fehlersuche. */
export function getArtStats() {
  const all = [...slots.values()];
  return {
    ...stats,
    slots: all.length,
    ready: all.filter((s) => s.state === "ready").length,
    liveUrls: all.filter((s) => s.url !== null).length,
    inUse: all.filter((s) => s.refs > 0).length,
    queued: queue.length,
    running,
  };
}
