import type { XmbEntry } from "../data/types";
import { JfError } from "../jellyfin/errors";
import type { PlaybackPlan } from "../jellyfin/playback";
import { startTranscode } from "./transcode";

/**
 * Wiedergabeplan für eine direkte Stream-Adresse aus einem Stremio-Addon: ohne Server, ohne Umwandlung, ohne Berichte.
 * Dauer und Spuren kennt erst das `<video>`; Untertitel und Tonauswahl gibt es hier nicht.
 * `replan({ forceTranscode })` wandelt den Stream lokal mit ffmpeg um (siehe transcode.ts / transcode.rs), wenn das
 * WebView ihn nicht abspielt (HEVC, DTS, MKV …) – in der Desktop-App, sonst bleibt es bei der Fehlermeldung.
 */
export function makeStremioPlan(entry: XmbEntry, startSec = 0): PlaybackPlan {
  const url = entry.stremio?.streamUrl;
  if (!url) throw new JfError("Kein Stream gewählt", "unplayable");
  const hls = /\.m3u8(?:[?#]|$)/i.test(url);
  const isEpisode = (entry.stremio?.id ?? "").includes(":");
  const plan: PlaybackPlan = {
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
    replan: async (patch = {}) => {
      if (!patch.forceTranscode) throw new JfError("Nur mit Jellyfin", "unplayable");
      const info = await startTranscode(url);
      const src = [info.video, info.audio].filter(Boolean).join(" · ");
      return {
        ...plan,
        url: info.url,
        method: "Transcode",
        protocol: "hls",
        durationSec: info.durationSec,
        reason: src ? `JellyStation wandelt lokal um (Quelle: ${src}).` : "JellyStation wandelt lokal um.",
        startSec: Math.max(0, patch.startSec ?? startSec),
        source: { ...(info.video ? { videoCodec: info.video } : {}), ...(info.audio ? { audioCodec: info.audio } : {}) },
        // Ein umgewandelter Strom lässt sich nicht weiter umwandeln.
        replan: () => Promise.reject(new JfError("Bereits umgewandelt", "unplayable")),
      };
    },
  };
  return plan;
}
