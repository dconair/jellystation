import type { XmbEntry } from "../data/types";
import type { JfContext } from "./context";
import { artHeaders, jfJson } from "./http";
import { episodeToEntry, itemToRef, parseItems } from "./items";
import type { JfItem } from "./items";
import { hueFromTitle, shortenOverview } from "./library";

/** So viele Einträge zeigt „Zuletzt gesehen“ höchstens aus Jellyfin. */
const LIMIT = 12;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Folge als Eintrag der Zeile „Zuletzt“: Serienname groß, darunter „S02 E03 · Folgentitel“. */
function recentEpisode(ctx: JfContext, item: JfItem, next: boolean): XmbEntry {
  const entry = episodeToEntry(ctx, item);
  const number = [
    item.seasonNumber !== undefined ? `S${pad2(item.seasonNumber)}` : "",
    item.episodeNumber !== undefined ? `E${pad2(item.episodeNumber)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const parts = [number, item.name].filter(Boolean).join(" · ");
  return {
    ...entry,
    id: `recent/${entry.id}`,
    title: item.seriesName || entry.title,
    subtitle: next ? `Als Nächstes · ${parts}` : parts,
  };
}

function recentMovie(ctx: JfContext, item: JfItem): XmbEntry | null {
  const ref = itemToRef(item);
  if (!ref) return null;
  return {
    id: `recent/jf/${item.id}`,
    title: item.name || "Unbenannt",
    subtitle: item.year ? String(item.year) : undefined,
    description: item.overview ? shortenOverview(item.overview) : undefined,
    hue: hueFromTitle(item.name || item.id),
    jellyfin: ref,
    art: item.hasImage
      ? { kind: "http", url: `${ctx.base}/Items/${encodeURIComponent(item.id)}/Images/Primary?fillHeight=600&quality=90`, headers: artHeaders(ctx.apiKey) }
      : { kind: "generated" },
    artShape: "poster",
  };
}

/**
 * Angefangene Filme und Folgen (zuletzt gesehen zuerst) und – dahinter – die nächsten Folgen der Serien, die du schaust.
 * Fehler werden nicht verschluckt (der Aufrufer entscheidet, ob er sie zeigt).
 */
export async function fetchRecent(ctx: JfContext, signal?: AbortSignal): Promise<XmbEntry[]> {
  const common = { enableUserData: true, fields: "Overview", enableImageTypes: "Primary", imageTypeLimit: 1 };
  const [resume, nextUp] = await Promise.all([
    jfJson<unknown>(ctx, "/UserItems/Resume", { signal, query: { userId: ctx.userId, limit: LIMIT, mediaTypes: "Video", ...common } }),
    jfJson<unknown>(ctx, "/Shows/NextUp", { signal, query: { userId: ctx.userId, limit: 8, enableTotalRecordCount: false, ...common } }).catch(() => null),
  ]);
  const out: XmbEntry[] = [];
  const seen = new Set<string>();
  const seriesSeen = new Set<string>();
  for (const item of parseItems(resume)) {
    if (item.isVirtual || seen.has(item.id)) continue;
    const entry = item.type === "Episode" ? recentEpisode(ctx, item, false) : item.type === "Movie" ? recentMovie(ctx, item) : null;
    if (!entry) continue;
    seen.add(item.id);
    if (item.seriesId) seriesSeen.add(item.seriesId);
    out.push(entry);
  }
  if (nextUp) {
    for (const item of parseItems(nextUp)) {
      if (item.isVirtual || item.type !== "Episode" || seen.has(item.id)) continue;
      if (item.seriesId && seriesSeen.has(item.seriesId)) continue; // diese Serie ist oben schon vertreten
      seen.add(item.id);
      out.push(recentEpisode(ctx, item, true));
    }
  }
  return out;
}
