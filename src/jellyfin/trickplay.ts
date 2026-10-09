import { mediaUrl } from "./context";
import type { JfContext } from "./context";
import { jfJson } from "./http";
import { TICKS_PER_SECOND } from "./ticks";

/*
 * Vorschaubilder der Zeitleiste ("Trickplay", Jellyfin ab 10.9): Der Server schneidet das Video in Einzelbilder im
 * festen Abstand und legt sie zu Kachelbildern zusammen (z. B. 10 × 10 Bilder je JPG). Hier steckt alles Reine
 * (Metadaten lesen, Auflösung wählen, Zeit → Bild/Kachel/Ausschnitt, URLs) plus der eine Abruf der Metadaten.
 * Das Laden und Anzeigen der Bilder macht der Player (src/player/previews.ts).
 */

/** Eine vom Server erzeugte Auflösung. Zeiten in Millisekunden, wie sie der Server liefert. */
export interface TrickplayInfo {
  /** Breite eines einzelnen Vorschaubilds (zugleich der Schlüssel in der Antwort und der Pfad der Kachelbilder). */
  width: number;
  height: number;
  /** Vorschaubilder je Zeile / je Spalte eines Kachelbilds. */
  tileWidth: number;
  tileHeight: number;
  thumbnailCount: number;
  intervalMs: number;
  bandwidth: number;
}

/** Ein Kapitel des Titels (Beginn in Sekunden). */
export interface PreviewChapter {
  startSec: number;
  name: string;
}

/** Was der Server zur Vorschau weiß: erzeugte Auflösungen und Kapitel. */
export interface PreviewMeta {
  trickplay: TrickplayInfo[];
  chapters: PreviewChapter[];
}

/** Gewünschte Breite eines Vorschaubilds in Pixeln (das Bild erscheint etwa 200–340 px breit). */
export const PREVIEW_TARGET_WIDTH = 320;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
const sameId = (a: string, b: string) => a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();

/* ------------------------------------------------------------------ Metadaten */

function parseInfo(raw: unknown, widthKey: number): TrickplayInfo | null {
  const o = obj(raw);
  if (!o) return null;
  const width = posInt(o.Width) ?? (Number.isFinite(widthKey) ? posInt(widthKey) : undefined);
  const height = posInt(o.Height);
  const tileWidth = posInt(o.TileWidth);
  const tileHeight = posInt(o.TileHeight);
  const thumbnailCount = posInt(o.ThumbnailCount);
  const intervalMs = posInt(o.Interval);
  if (!width || !height || !tileWidth || !tileHeight || !thumbnailCount || !intervalMs) return null;
  const bandwidth = typeof o.Bandwidth === "number" && Number.isFinite(o.Bandwidth) ? o.Bandwidth : 0;
  return { width, height, tileWidth, tileHeight, thumbnailCount, intervalMs, bandwidth };
}

/**
 * Liest das Feld `Trickplay` eines Titels: `{ [mediaSourceId]: { [breite]: {Width, Height, TileWidth, TileHeight,
 * ThumbnailCount, Interval, Bandwidth} } }`. Gilt die Quellen-Id nirgends, aber es gibt nur eine Quelle, gilt deren Eintrag
 * (dieselbe Datei). Ungültige Einträge entfallen; Ergebnis nach Breite aufsteigend.
 */
export function parseTrickplay(raw: unknown, mediaSourceId: string): TrickplayInfo[] {
  const bySource = obj(raw);
  if (!bySource) return [];
  const keys = Object.keys(bySource);
  const key = keys.find((k) => sameId(k, mediaSourceId)) ?? (keys.length === 1 ? keys[0] : undefined);
  const widths = key === undefined ? null : obj(bySource[key]);
  if (!widths) return [];
  const infos: TrickplayInfo[] = [];
  for (const [w, value] of Object.entries(widths)) {
    const info = parseInfo(value, Number(w));
    if (info) infos.push(info);
  }
  return infos.sort((a, b) => a.width - b.width);
}

/** Kapitel eines Titels (`Chapters`): nach Beginn sortiert, ohne Einträge ohne Namen. */
export function parseChapters(raw: unknown): PreviewChapter[] {
  if (!Array.isArray(raw)) return [];
  const out: PreviewChapter[] = [];
  for (const entry of raw) {
    const o = obj(entry);
    const name = typeof o?.Name === "string" ? o.Name.trim() : "";
    const ticks = o?.StartPositionTicks;
    if (!name || typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) continue;
    out.push({ startSec: ticks / TICKS_PER_SECOND, name });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Das Kapitel, in dem `sec` liegt (null vor dem ersten bzw. ohne Kapitel). */
export function chapterAt(chapters: readonly PreviewChapter[], sec: number): PreviewChapter | null {
  let hit: PreviewChapter | null = null;
  for (const c of chapters) {
    if (c.startSec <= sec) hit = c;
    else break;
  }
  return hit;
}

/**
 * Wählt die Auflösung, die am besten zur gewünschten Breite passt (Verhältnis, nicht Differenz: 160 und 640 sind
 * zu 320 gleich weit weg; bei Gleichstand die größere, sie wird verkleinert und bleibt scharf).
 */
export function pickTrickplay(infos: readonly TrickplayInfo[], target = PREVIEW_TARGET_WIDTH): TrickplayInfo | null {
  let best: TrickplayInfo | null = null;
  let bestDist = Infinity;
  for (const info of infos) {
    const dist = Math.abs(Math.log(info.width / target));
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && best && info.width > best.width)) {
      best = info;
      bestDist = dist;
    }
  }
  return best;
}

/* ------------------------------------------------------------ Zeit → Kachel */

/** Wo ein Vorschaubild liegt: welches Kachelbild, in welcher Spalte/Zeile. */
export interface TileSlot {
  thumb: number;
  sheet: number;
  col: number;
  row: number;
}

/** Nummer des Vorschaubilds, das zur Zeit gehört (das nächstliegende; Bild i zeigt die Zeit i · Abstand). */
export function thumbIndex(info: TrickplayInfo, sec: number): number {
  const i = Math.round((Math.max(0, Number.isFinite(sec) ? sec : 0) * 1000) / info.intervalMs);
  return Math.min(info.thumbnailCount - 1, Math.max(0, i));
}

/** Kachelbild, Spalte und Zeile zu einer Bildnummer. */
export function tileSlot(info: TrickplayInfo, thumb: number): TileSlot {
  const perSheet = info.tileWidth * info.tileHeight;
  const t = Math.min(info.thumbnailCount - 1, Math.max(0, Math.floor(thumb)));
  const within = t % perSheet;
  return { thumb: t, sheet: Math.floor(t / perSheet), col: within % info.tileWidth, row: Math.floor(within / info.tileWidth) };
}

export const slotAt = (info: TrickplayInfo, sec: number): TileSlot => tileSlot(info, thumbIndex(info, sec));

/** Anzahl der Kachelbilder. */
export const sheetCount = (info: TrickplayInfo): number => Math.ceil(info.thumbnailCount / (info.tileWidth * info.tileHeight));

/** Bereich der Bildnummern, die ein Kachelbild enthält (einschließlich). */
export function sheetRange(info: TrickplayInfo, sheet: number): [number, number] {
  const perSheet = info.tileWidth * info.tileHeight;
  return [sheet * perSheet, Math.min(info.thumbnailCount, (sheet + 1) * perSheet) - 1];
}

/** Abrufbare Adresse eines Kachelbilds (`GET /Videos/{id}/Trickplay/{breite}/{nr}.jpg`). */
export function trickplaySheetUrl(
  ctx: Pick<JfContext, "base" | "apiKey" | "mediaBase" | "viaProxy">,
  itemId: string,
  mediaSourceId: string,
  width: number,
  sheet: number,
): string {
  const query = mediaSourceId ? `?mediaSourceId=${encodeURIComponent(mediaSourceId)}` : "";
  return mediaUrl(ctx, `/Videos/${encodeURIComponent(itemId)}/Trickplay/${width}/${sheet}.jpg${query}`);
}

/* -------------------------------------------------------------------- Abruf */

/**
 * Holt Trickplay-Auflösungen und Kapitel eines Titels. `GET /Items/{id}` kennt keinen `fields`-Parameter, die Liste
 * (`GET /Items?ids=…&fields=Trickplay,Chapters`) schon. Wirft bei Fehlern (der Aufrufer fällt dann ohne Meldung zurück);
 * ältere Server ohne Trickplay antworten ohne das Feld → leere Liste.
 */
export async function fetchPreviewMeta(
  ctx: JfContext,
  itemId: string,
  mediaSourceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PreviewMeta> {
  const json = await jfJson<unknown>(ctx, "/Items", {
    signal: opts.signal,
    timeoutMs: 15_000,
    query: {
      ids: itemId,
      userId: ctx.userId,
      fields: "Trickplay,Chapters",
      enableUserData: false,
      enableImages: false,
      enableTotalRecordCount: false,
    },
  });
  const first = obj(Array.isArray(obj(json)?.Items) ? (obj(json)?.Items as unknown[])[0] : null);
  if (!first) return { trickplay: [], chapters: [] };
  return { trickplay: parseTrickplay(first.Trickplay, mediaSourceId), chapters: parseChapters(first.Chapters) };
}
