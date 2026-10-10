import type { XmbEntry } from "../data/types";
import { JfError } from "../jellyfin/errors";
import type { PlaybackPlan, SubtitleTrack } from "../jellyfin/playback";

/** Länge von public/demo/demo.* in Sekunden. */
export const DEMO_DURATION_SEC = 24;
/** Stream-Index der Demo-Untertitelspur (nur für die Auswahl im Player). */
const DEMO_SUBTITLE_INDEX = 1;

/** true = Demo-Eintrag ohne Server: nichts Jellyfin-Eigenes, also public/demo abspielen. */
export const isDemoEntry = (entry: XmbEntry): boolean => !entry.jellyfin;

const base = () => (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";

/**
 * Welche Demo-Datei diese Engine kann: H.264/AAC (macOS-WebView, Edge) zuerst, sonst WebM (Chromium ohne
 * proprietäre Codecs, WebKitGTK). Ist beides unbekannt, versucht es den Player trotzdem mit WebM.
 */
export function pickDemoFile(): { file: "demo.mp4" | "demo.webm"; container: string; videoCodec: string; audioCodec: string } {
  let mp4 = false;
  try {
    mp4 = document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "";
  } catch {
    // ohne Dokument: WebM
  }
  return mp4
    ? { file: "demo.mp4", container: "mp4", videoCodec: "H.264", audioCodec: "AAC" }
    : { file: "demo.webm", container: "webm", videoCodec: "VP9", audioCodec: "Opus" };
}

/**
 * Ein Wiedergabeplan wie von planPlayback, aber ohne Server: Direktwiedergabe der Demo-Datei, eine deutsche
 * Untertitelspur. So durchläuft der Demo-Player denselben Weg wie ein Jellyfin-Titel.
 */
export function makeDemoPlan(entry: XmbEntry, startSec = 0): PlaybackPlan {
  const pick = pickDemoFile();
  const url = `${base()}demo/${pick.file}`;
  const vtt = `${base()}demo/demo.de.vtt`;
  const track: SubtitleTrack = {
    index: DEMO_SUBTITLE_INDEX,
    label: "Deutsch",
    language: "ger",
    codec: "vtt",
    isDefault: true,
    isForced: false,
    isExternal: true,
    textBased: true,
    burnIn: false,
  };
  return {
    itemId: "demo",
    mediaSourceId: "demo",
    playSessionId: "demo",
    title: entry.title,
    ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
    ref: { id: "demo", type: "Movie" },
    url,
    method: "DirectPlay",
    protocol: "file",
    durationSec: DEMO_DURATION_SEC,
    audio: [],
    subtitles: [track],
    audioIndex: null,
    subtitleIndex: DEMO_SUBTITLE_INDEX,
    subtitleUrl: () => vtt,
    fetchSubtitle: async () => {
      const res = await fetch(vtt);
      if (!res.ok) throw new JfError("Untertitel nicht gefunden", "notfound", res.status);
      return res.text();
    },
    burnedSubtitle: false,
    reason: "",
    resumeSec: 0,
    startSec: Math.max(0, startSec),
    deviceId: "demo",
    source: { container: pick.container, videoCodec: pick.videoCodec, audioCodec: pick.audioCodec, width: 1280, height: 720 },
    replan: () => Promise.reject(new JfError("Nur mit Jellyfin", "unplayable")),
  };
}
