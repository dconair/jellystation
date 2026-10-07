import type { XmbEntry } from "../data/types";
import { isTauri } from "../platform";
import { isValidServerUrl, normalizeServerUrl } from "./testConnection";

/** So viele Titel pro Typ werden höchstens geladen (der Rest wird gemeldet, nicht still abgeschnitten). */
export const JELLYFIN_ITEM_LIMIT = 300;
/** Zeitlimit pro Anfrage. */
const TIMEOUT_MS = 8000;
/** Beschreibungen werden auf diese Länge gekürzt (die Detailkarte hat nur wenig Platz). */
const OVERVIEW_MAX = 280;

export interface JellyfinLibrary {
  movies: XmbEntry[];
  series: XmbEntry[];
  /**
   * Gesetzt, wenn der Server mehr Titel hat, als geladen wurden – fertiger deutscher Hinweistext,
   * z. B. "nur 300 von 412 Filmen geladen".
   */
  truncated?: string;
}

/** Fehler mit einer Meldung, die direkt angezeigt werden darf. */
export class JellyfinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JellyfinError";
  }
}

interface JellyfinItem {
  Id?: unknown;
  Name?: unknown;
  Overview?: unknown;
  Genres?: unknown;
  ProductionYear?: unknown;
  ChildCount?: unknown;
  ImageTags?: { Primary?: unknown } | null;
}

interface ItemsResponse {
  Items?: unknown;
  TotalRecordCount?: unknown;
}

type ItemKind = "Movie" | "Series";

/** Stabiler Farbton (0–359) aus dem Titel: gleicher Titel = gleiche Kachelfarbe. */
export function hueFromTitle(title: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/**
 * Kürzt eine Inhaltsangabe sauber: bevorzugt am Satzende, sonst an einer Wortgrenze (mit "…").
 * HTML-Reste und Zeilenumbrüche, wie sie manche Metadaten-Quellen liefern, werden entfernt.
 */
export function shortenOverview(raw: string, max = OVERVIEW_MAX): string {
  const text = raw
    .replace(/<br\s*\/?>/gi, " ")
    // Nur echte Tags (<b>, </p> …) – ein "3 < 5 und 7 > 2" im Text bleibt erhalten.
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, e: string) => ENTITIES[e.toLowerCase()] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  // Letztes Satzende im Fenster – aber nur, wenn dadurch nicht fast alles wegfällt.
  let sentenceEnd = -1;
  for (const m of cut.matchAll(/[.!?](?=\s|$)/g)) sentenceEnd = m.index;
  if (sentenceEnd >= max * 0.6) return cut.slice(0, sentenceEnd + 1);

  // Das "…" zählt mit, damit das Ergebnis nie länger als `max` wird.
  const room = cut.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  let words = space >= max * 0.5 ? room.slice(0, space) : room;
  // Kein halbes Surrogatpaar (Emoji) am Ende stehen lassen.
  if (/[\ud800-\udbff]$/.test(words)) words = words.slice(0, -1);
  return `${words.replace(/[\s,;:–—-]+$/, "")}…`;
}

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function subtitleOf(item: JellyfinItem, kind: ItemKind): string | undefined {
  const parts: string[] = [];
  if (typeof item.ProductionYear === "number" && item.ProductionYear > 0) {
    parts.push(String(item.ProductionYear));
  }
  const seasons = typeof item.ChildCount === "number" ? item.ChildCount : 0;
  if (kind === "Series" && seasons > 0) {
    parts.push(`${seasons} ${seasons === 1 ? "Staffel" : "Staffeln"}`);
  } else if (Array.isArray(item.Genres)) {
    const genres = item.Genres.map(clean).filter(Boolean).slice(0, 2);
    if (genres.length) parts.push(genres.join(", "));
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function toEntry(item: JellyfinItem, kind: ItemKind, base: string, apiKey: string): XmbEntry | null {
  const id = clean(item.Id);
  if (!id) return null;
  const title = clean(item.Name) || "Unbenannt";
  const overview = clean(item.Overview);
  const hasImage = clean(item.ImageTags?.Primary) !== "";
  return {
    id: `jf/${id}`,
    title,
    subtitle: subtitleOf(item, kind),
    description: overview ? shortenOverview(overview) : undefined,
    hue: hueFromTitle(title),
    art: hasImage
      ? {
          kind: "http",
          url: `${base}/Items/${encodeURIComponent(id)}/Images/Primary?fillHeight=600&quality=90`,
          headers: { "X-Emby-Token": apiKey },
        }
      : { kind: "generated" },
    artShape: "poster",
  };
}

/** Platzhalter für eine leere Spalte (z. B. Server ohne Serien) – ehrlicher als Demo-Daten. */
export function emptyLibraryEntry(kind: ItemKind): XmbEntry {
  const what = kind === "Movie" ? "Filme" : "Serien";
  return {
    id: `jf-empty/${kind}`,
    title: `Keine ${what} gefunden`,
    subtitle: "Auf dem Jellyfin-Server",
    hue: 215,
  };
}

/** In Tauri über das HTTP-Plugin (Rust, kein CORS/ATS), im Browser über window.fetch. */
async function send(url: string, headers: Record<string, string>, signal: AbortSignal) {
  if (isTauri()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(url, { headers, signal });
  }
  return window.fetch(url, { headers, signal });
}

/** Eine Anfrage mit eigenem Zeitlimit; `outer` bricht sie vorzeitig ab (Fehler dann: AbortError). */
async function getJson(url: string, apiKey: string, outer: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  timeout.addEventListener("abort", abort);
  outer.addEventListener("abort", abort);
  if (outer.aborted) ctl.abort();

  try {
    let res: Response;
    let text: string;
    try {
      res = await send(url, { Authorization: `MediaBrowser Token="${apiKey}"`, "X-Emby-Token": apiKey }, ctl.signal);
      if (res.status === 401 || res.status === 403) throw new JellyfinError("API-Key ungültig");
      if (!res.ok) throw new JellyfinError(`Server antwortet mit Status ${res.status}`);
      text = await res.text();
    } catch (err) {
      if (err instanceof JellyfinError) throw err;
      if (outer.aborted) throw new DOMException("Abgebrochen", "AbortError");
      throw new JellyfinError(
        timeout.aborted ? "Zeitüberschreitung – Server nicht erreichbar" : "Server nicht erreichbar",
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new JellyfinError("Antwort des Servers ist kein gültiges JSON");
    }
  } finally {
    timeout.removeEventListener("abort", abort);
    outer.removeEventListener("abort", abort);
  }
}

async function fetchKind(
  base: string,
  apiKey: string,
  kind: ItemKind,
  signal: AbortSignal,
): Promise<{ entries: XmbEntry[]; loaded: number; total: number }> {
  const query = new URLSearchParams({
    IncludeItemTypes: kind,
    Recursive: "true",
    SortBy: "SortName",
    SortOrder: "Ascending",
    Fields: "Overview,Genres,ProductionYear,ChildCount",
    ImageTypeLimit: "1",
    EnableImageTypes: "Primary",
    Limit: String(JELLYFIN_ITEM_LIMIT),
  });
  const json = (await getJson(`${base}/Items?${query}`, apiKey, signal)) as ItemsResponse | null;
  if (!json || typeof json !== "object" || !Array.isArray(json.Items)) {
    throw new JellyfinError("Unerwartete Antwort des Servers");
  }
  const items = json.Items as JellyfinItem[];
  // Doppelte Ids würden in der XMB denselben React-Schlüssel teilen – jede Id nur einmal.
  const seen = new Set<string>();
  const entries: XmbEntry[] = [];
  for (const item of items) {
    const entry = toEntry(item ?? {}, kind, base, apiKey);
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  // "Abgeschnitten" richtet sich nach dem, was der Server geliefert hat – nicht nach den verwertbaren Einträgen.
  const total = typeof json.TotalRecordCount === "number" ? json.TotalRecordCount : items.length;
  return { entries, loaded: items.length, total };
}

/**
 * Lädt Filme und Serien vom Jellyfin-Server und bildet sie auf XMB-Einträge ab.
 * Wirft bei jedem Problem einen {@link JellyfinError} mit deutscher Meldung; bei `signal`-Abbruch einen AbortError.
 */
export async function fetchJellyfinLibrary(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<JellyfinLibrary> {
  const base = normalizeServerUrl(url);
  const key = apiKey.trim();
  if (!isValidServerUrl(base)) throw new JellyfinError("Ungültige Server-Adresse");
  if (!key) throw new JellyfinError("API-Key fehlt");

  // Scheitert eine der beiden Anfragen, wird die andere gleich mit abgebrochen.
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) ctl.abort();
  try {
    const [movies, series] = await Promise.all([
      fetchKind(base, key, "Movie", ctl.signal),
      fetchKind(base, key, "Series", ctl.signal),
    ]);
    const cut: string[] = [];
    if (movies.total > movies.loaded) cut.push(`${movies.loaded} von ${movies.total} Filmen`);
    if (series.total > series.loaded) cut.push(`${series.loaded} von ${series.total} Serien`);
    return {
      movies: movies.entries,
      series: series.entries,
      truncated: cut.length ? `nur ${cut.join(" und ")} geladen` : undefined,
    };
  } catch (err) {
    // Promise.all meldet den ersten echten Fehler; die Schwester-Anfrage wird hier beendet.
    ctl.abort();
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
