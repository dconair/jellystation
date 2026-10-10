import type { JellyfinRef, XmbEntry } from "../data/types";
import type { JfContext } from "./context";
import { isAbortError, JfError, statusError } from "./errors";
import { artHeaders, jfJson, jfRaw } from "./http";
import { hueFromTitle, shortenOverview } from "./library";
import { TICKS_PER_SECOND } from "./ticks";

/** Wiedergabestand eines Titels für den gewählten Benutzer. */
export interface JfUserData {
  positionTicks: number;
  played: boolean;
  playCount: number;
  /** ISO-Zeitpunkt, zu dem der Titel zuletzt gespielt wurde. */
  lastPlayed?: string;
}

/** Ein Titel vom Server in handlicher Form (camelCase, geprüfte Typen). */
export interface JfItem {
  id: string;
  name: string;
  /** Jellyfin-Typ: "Movie", "Episode", "Series", "Season", "Video" … */
  type: string;
  overview: string;
  year?: number;
  runTimeTicks?: number;
  /** Der Titel hat ein eigenes Hauptbild (Primary). */
  hasImage: boolean;
  /** Nicht vorhanden, wenn der Server keine Benutzerdaten geliefert hat. */
  userData?: JfUserData;
  /** "Virtual" = fehlende Folge (nur Platzhalter, nicht abspielbar). */
  isVirtual: boolean;
  /** Genres (nur wenn der Server sie mitliefert, z. B. bei Einzelabfragen). */
  genres?: string[];
  /** ISO-Datum der Erstausstrahlung bzw. Veröffentlichung. */
  premiereDate?: string;
  // Nur bei Folgen:
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** Folge als Menü-Eintrag; `jellyfin` ist hier immer gesetzt. */
export type JfEpisodeEntry = XmbEntry & { jellyfin: JellyfinRef };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Liest einen Titel aus der Server-Antwort; ohne Id gibt es null. */
export function parseItem(raw: unknown): JfItem | null {
  if (!raw || typeof raw !== "object") return null;
  const dto = raw as Record<string, unknown>;
  const id = text(dto.Id);
  if (!id) return null;
  const item: JfItem = {
    id,
    name: text(dto.Name),
    type: text(dto.Type),
    overview: text(dto.Overview),
    hasImage: text((dto.ImageTags as { Primary?: unknown } | null | undefined)?.Primary) !== "",
    isVirtual: text(dto.LocationType) === "Virtual",
  };
  const year = finite(dto.ProductionYear);
  if (year !== undefined && year > 0) item.year = year;
  const run = finite(dto.RunTimeTicks);
  if (run !== undefined && run > 0) item.runTimeTicks = run;
  const data = dto.UserData;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    item.userData = {
      positionTicks: Math.max(0, finite(d.PlaybackPositionTicks) ?? 0),
      played: d.Played === true,
      playCount: Math.max(0, finite(d.PlayCount) ?? 0),
      ...(text(d.LastPlayedDate) ? { lastPlayed: text(d.LastPlayedDate) } : {}),
    };
  }
  if (Array.isArray(dto.Genres)) {
    const genres = dto.Genres.map(text).filter(Boolean);
    if (genres.length) item.genres = genres;
  }
  const premiere = text(dto.PremiereDate);
  if (premiere) item.premiereDate = premiere;
  const seriesId = text(dto.SeriesId);
  if (seriesId) item.seriesId = seriesId;
  const seriesName = text(dto.SeriesName);
  if (seriesName) item.seriesName = seriesName;
  const season = finite(dto.ParentIndexNumber);
  if (season !== undefined) item.seasonNumber = season;
  const episode = finite(dto.IndexNumber);
  if (episode !== undefined) item.episodeNumber = episode;
  return item;
}

export function parseItems(json: unknown): JfItem[] {
  const list = (json as { Items?: unknown } | null)?.Items;
  if (!Array.isArray(list)) throw new JfError("Unerwartete Antwort des Servers", "protocol");
  const items: JfItem[] = [];
  for (const raw of list) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  return items;
}

/** Verweis (`entry.jellyfin`) für einen Titel samt Wiedergabestand. */
export function itemToRef(item: JfItem): JellyfinRef | null {
  const type = item.type === "Movie" || item.type === "Series" || item.type === "Episode" ? item.type : null;
  if (!type) return null;
  const ref: JellyfinRef = { id: item.id, type };
  if (item.runTimeTicks !== undefined) ref.runTimeTicks = item.runTimeTicks;
  if (item.userData) {
    if (item.userData.positionTicks > 0) ref.resumeTicks = item.userData.positionTicks;
    ref.played = item.userData.played;
  }
  if (type === "Episode") {
    if (item.seriesId) ref.seriesId = item.seriesId;
    if (item.seriesName) ref.seriesName = item.seriesName;
    if (item.seasonNumber !== undefined) ref.seasonNumber = item.seasonNumber;
    if (item.episodeNumber !== undefined) ref.episodeNumber = item.episodeNumber;
  }
  return ref;
}

/* --------------------------------------------------------------- Einzeltitel */

/**
 * Ein Titel samt Wiedergabestand (`GET /Items/{id}?userId=…`). Server bis 10.8 kennen nur
 * `/Users/{userId}/Items/{id}` (und antworten auf GET /Items/{id} mit 405, weil es dort nur POST/DELETE gibt) –
 * bei 404/405 wird deshalb dieser Pfad versucht.
 */
export async function getItem(ctx: JfContext, id: string, opts: { signal?: AbortSignal } = {}): Promise<JfItem> {
  const { signal } = opts;
  let res = await jfRaw(ctx, `/Items/${encodeURIComponent(id)}`, { signal, query: { userId: ctx.userId } });
  if (res.status === 404 || res.status === 405) {
    const legacy = await jfRaw(ctx, `/Users/${encodeURIComponent(ctx.userId)}/Items/${encodeURIComponent(id)}`, {
      signal,
    });
    if (legacy.ok) res = legacy;
  }
  if (!res.ok) throw statusError(res.status, { 404: "Titel auf dem Server nicht gefunden" });
  let item: JfItem | null;
  try {
    item = parseItem(JSON.parse(res.text));
  } catch {
    throw new JfError("Antwort des Servers ist kein gültiges JSON", "protocol");
  }
  if (!item) throw new JfError("Unerwartete Antwort des Servers", "protocol");
  return item;
}

/* -------------------------------------------------------------------- Folgen */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "S01 E03 · 42 Min" (Teile, die es nicht gibt, fallen weg). */
function episodeSubtitle(item: JfItem): string | undefined {
  const parts: string[] = [];
  const number = [
    item.seasonNumber !== undefined ? `S${pad2(item.seasonNumber)}` : "",
    item.episodeNumber !== undefined ? `E${pad2(item.episodeNumber)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (number) parts.push(number);
  if (item.runTimeTicks) parts.push(`${Math.max(1, Math.round(item.runTimeTicks / (TICKS_PER_SECOND * 60)))} Min`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Folge → Menü-Eintrag (Querbild, Verweis mit Serie/Staffel/Folge und Wiedergabestand). */
export function episodeToEntry(
  ctx: Pick<JfContext, "base" | "apiKey">,
  item: JfItem,
  fallbackSeriesId?: string,
): JfEpisodeEntry {
  const title = item.name || (item.episodeNumber !== undefined ? `Folge ${item.episodeNumber}` : "Unbenannt");
  const ref = itemToRef({ ...item, type: "Episode", seriesId: item.seriesId ?? fallbackSeriesId }) as JellyfinRef;
  return {
    id: `jf/${item.id}`,
    title,
    subtitle: episodeSubtitle(item),
    description: item.overview ? shortenOverview(item.overview) : undefined,
    hue: hueFromTitle(title),
    jellyfin: ref,
    art: item.hasImage
      ? {
          kind: "http",
          url: `${ctx.base}/Items/${encodeURIComponent(item.id)}/Images/Primary?fillHeight=400&quality=90`,
          headers: artHeaders(ctx.apiKey),
        }
      : { kind: "generated" },
    artShape: "landscape",
  };
}

/** Staffel 0 ("Specials") kommt ans Ende, Folgen ohne Nummer hinter die nummerierten. */
function orderKey(item: JfItem): [number, number] {
  const season = item.seasonNumber === undefined ? 9999 : item.seasonNumber === 0 ? 9000 : item.seasonNumber;
  return [season, item.episodeNumber ?? 99999];
}

async function loadEpisodes(ctx: JfContext, seriesId: string, signal?: AbortSignal): Promise<JfItem[]> {
  const json = await jfJson<unknown>(
    ctx,
    `/Shows/${encodeURIComponent(seriesId)}/Episodes`,
    {
      signal,
      query: {
        userId: ctx.userId,
        fields: "Overview",
        enableUserData: true,
        // Fehlende Folgen (nur Platzhalter, nicht abspielbar) gar nicht erst liefern lassen.
        isMissing: false,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary",
      },
    },
    { 404: "Serie auf dem Server nicht gefunden" },
  );
  return parseItems(json)
    .filter((i) => !i.isVirtual)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const [sa, ea] = orderKey(a.item);
      const [sb, eb] = orderKey(b.item);
      return sa - sb || ea - eb || a.index - b.index;
    })
    .map((x) => x.item);
}

/** Alle Folgen einer Serie, nach Staffel und Folge sortiert (Specials zuletzt), mit Wiedergabestand. */
export async function getEpisodes(
  ctx: JfContext,
  seriesId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<JfEpisodeEntry[]> {
  return (await loadEpisodes(ctx, seriesId, opts.signal)).map((item) => episodeToEntry(ctx, item, seriesId));
}

/** Eine Folge als Menü-Eintrag samt Rohdaten (volle Beschreibung, Premierendatum). */
export interface JfEpisodeInfo {
  entry: JfEpisodeEntry;
  item: JfItem;
}

/** Wie {@link getEpisodes}, aber mit den Rohdaten jeder Folge (für Oberflächen, die mehr als den gekürzten Eintrag zeigen). */
export async function getEpisodeInfos(
  ctx: JfContext,
  seriesId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<JfEpisodeInfo[]> {
  return (await loadEpisodes(ctx, seriesId, opts.signal)).map((item) => ({
    entry: episodeToEntry(ctx, item, seriesId),
    item,
  }));
}

/**
 * Markiert einen Titel als gesehen bzw. ungesehen (`POST`/`DELETE /UserPlayedItems/{id}?userId=…`). Server bis 10.8
 * kennen nur `/Users/{userId}/PlayedItems/{id}` – bei 404/405 wird dieser Pfad versucht. Liefert den neuen Wiedergabestand.
 */
export async function setItemPlayed(
  ctx: JfContext,
  id: string,
  played: boolean,
  opts: { signal?: AbortSignal } = {},
): Promise<JfUserData> {
  const { signal } = opts;
  const method = played ? "POST" : "DELETE";
  let res = await jfRaw(ctx, `/UserPlayedItems/${encodeURIComponent(id)}`, { method, signal, query: { userId: ctx.userId } });
  if (res.status === 404 || res.status === 405) {
    const legacy = await jfRaw(ctx, `/Users/${encodeURIComponent(ctx.userId)}/PlayedItems/${encodeURIComponent(id)}`, {
      method,
      signal,
    });
    if (legacy.ok) res = legacy;
  }
  if (!res.ok) throw statusError(res.status, { 404: "Titel auf dem Server nicht gefunden" });
  // Die Antwort enthält den neuen Stand; fehlt sie oder ist sie unlesbar, gilt, was gewünscht war.
  try {
    const d = JSON.parse(res.text) as Record<string, unknown>;
    return {
      positionTicks: Math.max(0, finite(d.PlaybackPositionTicks) ?? 0),
      played: typeof d.Played === "boolean" ? d.Played : played,
      playCount: Math.max(0, finite(d.PlayCount) ?? 0),
    };
  } catch {
    return { positionTicks: 0, played, playCount: 0 };
  }
}

/** Positionen unter dieser Grenze zählen nicht als "angefangen" (wie in der XMB, src/xmb/progress.ts). */
const STARTED_MIN_TICKS = 10 * TICKS_PER_SECOND;

/**
 * Die Folge, mit der es weitergeht: laut Server ("Als Nächstes"), sonst die zuletzt angefangene, sonst die erste
 * ungesehene. `null`, wenn alles gesehen ist (oder die Serie keine Folgen hat) – dann bietet die Oberfläche
 * "Von vorn" an.
 */
export async function getNextUp(
  ctx: JfContext,
  seriesId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<JfEpisodeEntry | null> {
  const { signal } = opts;
  try {
    const json = await jfJson<unknown>(ctx, "/Shows/NextUp", {
      signal,
      query: {
        userId: ctx.userId,
        seriesId,
        limit: 1,
        fields: "Overview",
        enableUserData: true,
        enableImageTypes: "Primary",
        imageTypeLimit: 1,
        enableTotalRecordCount: false,
      },
    });
    const first = parseItems(json).find((i) => i.type === "Episode" && !i.isVirtual);
    if (first) return episodeToEntry(ctx, first, seriesId);
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Sehr alte Server oder ein Fehler hier: unten aus der Folgenliste ermitteln (scheitert die ebenfalls, kommt deren Fehler).
  }

  // Der Server kennt nur Serien mit mindestens einer gesehenen Folge – bei neuen Serien bleibt die Antwort leer.
  const episodes = await loadEpisodes(ctx, seriesId, signal);
  const regular = episodes.filter((i) => i.seasonNumber !== 0);
  const started = regular.filter((i) => !i.userData?.played && (i.userData?.positionTicks ?? 0) >= STARTED_MIN_TICKS);
  let pick: JfItem | undefined;
  if (started.length) {
    // Die zuletzt gesehene; ohne Zeitstempel die spätere in der Reihenfolge.
    const stamp = (i: JfItem) => Date.parse(i.userData?.lastPlayed ?? "") || 0;
    pick = started.reduce((best, i) => (stamp(i) >= stamp(best) ? i : best));
  } else {
    pick = regular.find((i) => !i.userData?.played);
  }
  return pick ? episodeToEntry(ctx, pick, seriesId) : null;
}

/** Die Folge nach `currentId` in der Reihenfolge von {@link getEpisodes}; null bei der letzten (z. B. für "Nächste Folge"). */
export function findNextEpisode(episodes: JfEpisodeEntry[], currentId: string): JfEpisodeEntry | null {
  const id = currentId.replace(/^jf\//, "");
  const at = episodes.findIndex((e) => e.jellyfin.id === id);
  return at >= 0 && at + 1 < episodes.length ? episodes[at + 1] : null;
}
