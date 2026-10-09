/**
 * Reine Funktionen des Serien-Screens: Folgen-Modell, Gruppieren in Staffeln, Beschriftungen und Formatierung.
 * Nichts hier greift auf React, das Netz oder die Uhr zu.
 */
import type { XmbEntry } from "../data/types";
import { formatRemaining, watchState } from "../xmb/progress";

/** Eine Folge, wie die Oberfläche sie braucht (aus einem Jellyfin-Eintrag oder lokal erzeugt). */
export interface SeriesEpisode {
  /** Eindeutig innerhalb der Serie (= `entry.id`). */
  key: string;
  /** Menü-Eintrag zum Abspielen (Demo-Folgen haben kein `jellyfin`). */
  entry: XmbEntry;
  /** Staffelnummer; 0 = Specials, null = Server nennt keine. */
  season: number | null;
  number: number | null;
  title: string;
  /** Beschreibung; solange die lange noch lädt, der gekürzte Anfang. */
  overview: string;
  /** Laufzeit in Sekunden (0 = unbekannt). */
  runtimeSec: number;
  /** Gespeicherte Position in Sekunden (0 = nicht angefangen). */
  resumeSec: number;
  /** Position, mit der der Player beginnt (bei Demo-Folgen auf den kurzen Demo-Clip umgerechnet). */
  startSec: number;
  /** 0..1, nur bei angefangenen Folgen. */
  ratio: number;
  played: boolean;
  /** ISO-Datum der Erstausstrahlung. */
  premiere?: string;
  /** true = lokal erzeugte Demo-Folge. */
  demo?: boolean;
}

/** Aktualisierbarer Teil einer Folge (Wiedergabestand, nachgeladene Beschreibung). */
export type EpisodePatch = Partial<Pick<SeriesEpisode, "overview" | "premiere" | "resumeSec" | "startSec" | "ratio" | "played">>;

export interface Season {
  /** Eindeutiger Schlüssel: "s1", "s0" (Specials), "s-" (ohne Staffel). */
  id: string;
  number: number | null;
  label: string;
  episodes: SeriesEpisode[];
  /** Ganz gesehene Folgen. */
  seen: number;
}

/* ------------------------------------------------------------------ Modell */

const clean = (raw: string) => raw.replace(/\r\n?/g, "\n");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/**
 * Macht aus einer Server-Beschreibung lesbaren Text: HTML-Reste fallen weg, Absätze (Leerzeile) bleiben,
 * einzelne Zeilenumbrüche und doppelte Leerzeichen werden zu Leerzeichen.
 */
export function cleanOverview(raw: string): string {
  return clean(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, e: string) => ENTITIES[e.toLowerCase()] ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Folge aus einem Menü-Eintrag (Wiedergabestand und Nummern kommen aus `entry.jellyfin`). */
export function episodeFromEntry(entry: XmbEntry, extra: { overview?: string; premiere?: string; demo?: boolean } = {}): SeriesEpisode {
  const j = entry.jellyfin;
  const w = watchState(entry);
  const resumeSec = w?.resumeSec ?? 0;
  return {
    key: entry.id,
    entry,
    season: j?.seasonNumber ?? null,
    number: j?.episodeNumber ?? null,
    title: entry.title,
    overview: extra.overview ?? entry.description ?? "",
    runtimeSec: j?.runTimeTicks ? j.runTimeTicks / 10_000_000 : 0,
    resumeSec,
    startSec: resumeSec,
    ratio: w && !w.played ? w.ratio : 0,
    played: w?.played ?? false,
    ...(extra.premiere ? { premiere: extra.premiere } : {}),
    ...(extra.demo ? { demo: true } : {}),
  };
}

export function patchEpisode(ep: SeriesEpisode, patch: EpisodePatch): SeriesEpisode {
  return { ...ep, ...patch };
}

/** Wiedergabestand nach „als gesehen“ bzw. „als ungesehen markiert“: die Position fällt in beiden Fällen weg. */
export const playedPatch = (played: boolean): EpisodePatch => ({ played, resumeSec: 0, startSec: 0, ratio: 0 });

/* --------------------------------------------------------------- Staffeln */

/** Staffelnummern aufsteigend, Folgen ohne Staffel danach, die Specials (0) ganz zuletzt. */
const seasonRank = (n: number | null) => (n === null ? 9000 : n === 0 ? 9999 : n);

export function seasonLabel(number: number | null): string {
  if (number === 0) return "Specials";
  return number === null ? "Folgen" : `Staffel ${number}`;
}

/** Gruppiert die Folgen (in Serienreihenfolge) nach Staffel; innerhalb einer Staffel bleibt die Reihenfolge erhalten. */
export function groupSeasons(episodes: readonly SeriesEpisode[]): Season[] {
  const byNumber = new Map<number | null, SeriesEpisode[]>();
  for (const ep of episodes) {
    const list = byNumber.get(ep.season);
    if (list) list.push(ep);
    else byNumber.set(ep.season, [ep]);
  }
  return [...byNumber.entries()]
    .sort(([a], [b]) => seasonRank(a) - seasonRank(b))
    .map(([number, list]) => ({
      id: number === null ? "s-" : `s${number}`,
      number,
      label: seasonLabel(number),
      episodes: list,
      seen: list.filter((e) => e.played).length,
    }));
}

/** Zahl der echten Staffeln (ohne Specials und ohne Folgen ohne Staffel). */
export const regularSeasonCount = (seasons: readonly Season[]) => seasons.filter((s) => s.number !== null && s.number > 0).length;

/** Rechter Text in der Staffelliste: „5 Folgen“, „2 von 5 gesehen“ oder „Alle 5 gesehen“. */
export function seasonStatus(season: Pick<Season, "episodes" | "seen">): string {
  const total = season.episodes.length;
  if (total > 0 && season.seen === total) return total === 1 ? "Gesehen" : `Alle ${total} gesehen`;
  if (season.seen > 0) return `${season.seen} von ${total} gesehen`;
  return total === 1 ? "1 Folge" : `${total} Folgen`;
}

/** Position einer Folge in den Staffeln: [Staffelindex, Zeile] oder null. */
export function locateEpisode(seasons: readonly Season[], key: string): [number, number] | null {
  for (let s = 0; s < seasons.length; s++) {
    const row = seasons[s].episodes.findIndex((e) => e.key === key);
    if (row >= 0) return [s, row];
  }
  return null;
}

/* --------------------------------------------------------------- Weiterschauen */

/**
 * Die Folge, mit der es lokal weitergeht (Rückfall, wenn der Server keine „Als Nächstes“-Folge nennt oder sich der
 * Stand geändert hat): die zuletzt begonnene, sonst die erste ungesehene reguläre Folge.
 */
export function pickContinue(episodes: readonly SeriesEpisode[]): SeriesEpisode | null {
  const regular = episodes.filter((e) => e.season !== 0);
  const started = regular.filter((e) => !e.played && e.resumeSec > 0);
  if (started.length) return started[started.length - 1];
  return regular.find((e) => !e.played) ?? null;
}

export interface MainAction {
  episode: SeriesEpisode;
  /** „Weiterschauen“, „Abspielen“ (noch nichts gesehen) oder „Von vorn“ (alles gesehen). */
  verb: "Weiterschauen" | "Abspielen" | "Von vorn";
  /** Position, mit der der Player beginnt. */
  startSec: number;
}

/** Was der große Knopf der Serie tut. `next` ist die Folge laut Server bzw. {@link pickContinue}; null = alles gesehen. */
export function mainAction(episodes: readonly SeriesEpisode[], next: SeriesEpisode | null): MainAction | null {
  if (episodes.length === 0) return null;
  if (!next) {
    const first = episodes.find((e) => e.season !== 0) ?? episodes[0];
    return { episode: first, verb: "Von vorn", startSec: 0 };
  }
  const touched = episodes.some((e) => e.played || e.resumeSec > 0);
  return { episode: next, verb: touched ? "Weiterschauen" : "Abspielen", startSec: next.startSec };
}

/* ------------------------------------------------------------- Formatierung */

/** „S2 E3“, bei Specials „Special 1“, ohne Staffel „Folge 3“; leer, wenn nichts bekannt ist. */
export function episodeCode(ep: Pick<SeriesEpisode, "season" | "number">): string {
  const { season, number } = ep;
  if (season === 0) return number !== null ? `Special ${number}` : "Special";
  if (season !== null && number !== null) return `S${season} E${number}`;
  if (season !== null) return `Staffel ${season}`;
  return number !== null ? `Folge ${number}` : "";
}

/** „42 Min.“ bzw. „1 Std. 05 Min.“; leer, wenn die Laufzeit unbekannt ist. */
export const runtimeText = (sec: number): string => (sec > 0 ? formatRemaining(sec) : "");

/** „noch 18 Min.“ für angefangene Folgen; sonst leer. */
export function remainingText(ep: Pick<SeriesEpisode, "runtimeSec" | "resumeSec" | "played">): string {
  if (ep.played || ep.resumeSec <= 0 || ep.runtimeSec <= 0) return "";
  return `noch ${formatRemaining(Math.max(0, ep.runtimeSec - ep.resumeSec))}`;
}

/** „12. März 2024“ (Datum in UTC, damit es nicht um einen Tag springt); leer, wenn es kein Datum ist. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Die Teile, die da sind, mit „ · “ verbunden. */
export const joinMeta = (parts: ReadonlyArray<string | null | undefined | false>): string =>
  parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");

/* ------------------------------------------------------------------ Scrollen */

/**
 * Neuer Scroll-Versatz (in Zeilenhöhen-Einheiten wie `rowH`, hier rem) einer Liste mit gleich hohen Zeilen, damit die
 * Zeile `row` samt etwas Kontext sichtbar ist. Liegt sie schon im Fenster, ändert sich nichts.
 */
export function scrollFor(current: number, row: number, rowH: number, count: number, viewH: number, context = rowH * 0.6): number {
  const total = count * rowH;
  const max = Math.max(0, total - viewH);
  const s = Math.min(max, Math.max(0, current));
  if (row < 0 || viewH <= 0) return s;
  const margin = Math.min(context, Math.max(0, (viewH - rowH) / 2));
  const top = row * rowH - margin;
  const bottom = (row + 1) * rowH + margin;
  if (top >= s && bottom <= s + viewH) return s;
  return Math.min(max, Math.max(0, top < s ? top : bottom - viewH));
}
