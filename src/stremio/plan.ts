import type { XmbEntry } from "../data/types";
import { JfError } from "../jellyfin/errors";
import type { PlaybackPlan } from "../jellyfin/playback";

/**
 * Wiedergabeplan für eine direkte Stream-Adresse aus einem Stremio-Addon: ohne Server, ohne Umwandlung, ohne Berichte.
 * Dauer und Spuren kennt erst das `<video>`; Untertitel und Tonauswahl gibt es hier nicht.
 */
export function makeStremioPlan(entry: XmbEntry, startSec = 0): PlaybackPlan {
  const url = entry.stremio?.streamUrl;
  if (!url) throw new JfError("Kein Stream gewählt", "unplayable");
  const hls = /\.m3u8(?:[?#]|$)/i.test(url);
  const isEpisode = (entry.stremio?.id ?? "").includes(":");
  return {
    itemId: entry.stremio?.id ?? entry.id,
    mediaSourceId: "stremio",
    playSessionId: "stremio",
    title: entry.title,
    ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
    ref: { id: entry.stremio?.id ?? entry.id, type: isEpisode ? "Episode" : "Movie" },
    url,
    method: "DirectPlay",
    protocol: hls ? "hls" : "file",
    durationSec: 0,
    audio: [],
    subtitles: [],
    audioIndex: null,
    subtitleIndex: null,
    subtitleUrl: () => "",
    fetchSubtitle: () => Promise.reject(new JfError("Keine Untertitel", "notfound")),
    burnedSubtitle: false,
    reason: "",
    resumeSec: 0,
    startSec: Math.max(0, startSec),
    deviceId: "stremio",
    source: {},
    replan: () => Promise.reject(new JfError("Nur mit Jellyfin", "unplayable")),
  };
}
