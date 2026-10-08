import type { JellyfinRef, XmbEntry } from "../data/types";
import { fetchSelectableUsers, pickJfUser } from "./context";
import { getDeviceId } from "./device";
import { isAbortError, JfError } from "./errors";
import { artHeaders, jfJson } from "./http";
import type { JfAuth } from "./http";
import { isValidServerUrl, normalizeServerUrl } from "./url";

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
  /** Benutzer, dessen Wiedergabestände (Weiterschauen, Gesehen) in den Einträgen stecken; fehlt, wenn keiner ermittelt werden konnte. */
  userId?: string;
  userName?: string;
}

/**
 * Fehler mit einer Meldung, die direkt angezeigt werden darf. Gleiche Klasse wie {@link JfError} (die ganze
 * Jellyfin-Schicht wirft sie); der alte Name bleibt für bestehenden Code.
 */
export const JellyfinError = JfError;
export type JellyfinError = JfError;

interface JellyfinItem {
  Id?: unknown;
  Name?: unknown;
  Overview?: unknown;
  Genres?: unknown;
  ProductionYear?: unknown;
  ChildCount?: unknown;
  RunTimeTicks?: unknown;
  ImageTags?: { Primary?: unknown } | null;
  UserData?: { PlaybackPositionTicks?: unknown; Played?: unknown } | null;
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
const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

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

/**
 * Verweis auf das Jellyfin-Objekt samt Wiedergabestand. `resumeTicks` fehlt bei nicht begonnenen Titeln,
 * `played` fehlt, wenn der Server keine Benutzerdaten geliefert hat (dann ist "nicht gesehen" nur geraten).
 */
function refOf(id: string, kind: ItemKind, item: JellyfinItem): JellyfinRef {
  const ref: JellyfinRef = { id, type: kind };
  const run = positive(item.RunTimeTicks);
  if (run !== undefined) ref.runTimeTicks = run;
  const data = item.UserData;
  if (data && typeof data === "object") {
    const pos = positive(data.PlaybackPositionTicks);
    if (pos !== undefined) ref.resumeTicks = pos;
    if (typeof data.Played === "boolean") ref.played = data.Played;
  }
  return ref;
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
    jellyfin: refOf(id, kind, item),
    art: hasImage
      ? {
          kind: "http",
          url: `${base}/Items/${encodeURIComponent(id)}/Images/Primary?fillHeight=600&quality=90`,
          headers: artHeaders(apiKey),
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

async function fetchKind(
  auth: JfAuth,
  kind: ItemKind,
  signal: AbortSignal,
  userId: string | undefined,
): Promise<{ entries: XmbEntry[]; loaded: number; total: number }> {
  const json = await jfJson<ItemsResponse | null>(auth, "/Items", {
    signal,
    timeoutMs: TIMEOUT_MS,
    query: {
      // Ohne Benutzer gibt es keine Wiedergabestände – der Server lässt die UserData dann weg.
      userId,
      enableUserData: userId ? true : undefined,
      IncludeItemTypes: kind,
      Recursive: true,
      SortBy: "SortName",
      SortOrder: "Ascending",
      Fields: "Overview,Genres,ProductionYear,ChildCount",
      ImageTypeLimit: 1,
      EnableImageTypes: "Primary",
      Limit: JELLYFIN_ITEM_LIMIT,
    },
  });
  if (!json || typeof json !== "object" || !Array.isArray(json.Items)) {
    throw new JfError("Unerwartete Antwort des Servers", "protocol");
  }
  const items = json.Items as JellyfinItem[];
  // Doppelte Ids würden in der XMB denselben React-Schlüssel teilen – jede Id nur einmal.
  const seen = new Set<string>();
  const entries: XmbEntry[] = [];
  for (const item of items) {
    const entry = toEntry(item ?? {}, kind, auth.base, auth.apiKey);
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
 * Ermittelt den Benutzer für die Wiedergabestände. Ist die Benutzerliste nicht lesbar (Schlüssel ohne
 * Administrator-Rechte, sehr alter Server), lädt die Bibliothek trotzdem – nur eben ohne Weiterschauen.
 * Ein ungültiger Schlüssel (401), ein nicht erreichbarer Server und ein Abbruch zählen dagegen als Fehler.
 */
async function resolveUser(
  auth: JfAuth,
  preferredId: string | undefined,
  signal: AbortSignal,
): Promise<{ id: string; name: string } | undefined> {
  try {
    const picked = pickJfUser(await fetchSelectableUsers(auth, signal), preferredId);
    return picked ? { id: picked.user.id, name: picked.user.name } : undefined;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err instanceof JfError && (err.status === 401 || err.kind === "network" || err.kind === "timeout")) throw err;
    return undefined;
  }
}

/**
 * Lädt Filme und Serien vom Jellyfin-Server und bildet sie auf XMB-Einträge ab.
 * `userId` ist der gewählte Benutzer (Einstellungen); fehlt er oder ist er ungültig, wird der zuletzt aktive gewählt.
 * Wirft bei jedem Problem einen {@link JellyfinError} mit deutscher Meldung; bei `signal`-Abbruch einen AbortError.
 */
export async function fetchJellyfinLibrary(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
  userId?: string,
): Promise<JellyfinLibrary> {
  const base = normalizeServerUrl(url);
  const key = apiKey.trim();
  if (!isValidServerUrl(base)) throw new JfError("Ungültige Server-Adresse", "config");
  if (!key) throw new JfError("API-Key fehlt", "config");
  const auth: JfAuth = { base, apiKey: key, deviceId: getDeviceId() };

  // Scheitert eine der Anfragen, werden die anderen gleich mit abgebrochen.
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) ctl.abort();
  try {
    const user = await resolveUser(auth, userId, ctl.signal);
    const [movies, series] = await Promise.all([
      fetchKind(auth, "Movie", ctl.signal, user?.id),
      fetchKind(auth, "Series", ctl.signal, user?.id),
    ]);
    const cut: string[] = [];
    if (movies.total > movies.loaded) cut.push(`${movies.loaded} von ${movies.total} Filmen`);
    if (series.total > series.loaded) cut.push(`${series.loaded} von ${series.total} Serien`);
    return {
      movies: movies.entries,
      series: series.entries,
      truncated: cut.length ? `nur ${cut.join(" und ")} geladen` : undefined,
      ...(user ? { userId: user.id, userName: user.name } : {}),
    };
  } catch (err) {
    // Promise.all meldet den ersten echten Fehler; die Schwester-Anfrage wird hier beendet.
    ctl.abort();
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
