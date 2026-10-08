import type { JellyfinRef } from "../data/types";
import { mediaUrl } from "./context";
import type { JfContext } from "./context";
import { abortError, isAbortError, JfError, statusError } from "./errors";
import { jfRaw, jfText } from "./http";
import { getItem, itemToRef } from "./items";
import type { JfItem } from "./items";
import { buildDeviceProfile } from "./profile";
import { ticksToSec } from "./ticks";

/** Wie der Titel zum Player kommt. */
export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";
/** `file` = eine Datei per HTTP (Range-Anfragen), `hls` = Wiedergabeliste mit Segmenten (.m3u8). */
export type PlayProtocol = "file" | "hls";

export interface AudioTrack {
  /** Stream-Index auf dem Server (für `audioIndex`). */
  index: number;
  /** Anzeigename des Servers, z. B. "Deutsch - AC3 - 5.1 - Standard". */
  label: string;
  language?: string;
  codec?: string;
  channels?: number;
  isDefault: boolean;
}

export interface SubtitleTrack {
  index: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault: boolean;
  isForced: boolean;
  /** Eigene Datei neben dem Video (nicht im Container). */
  isExternal: boolean;
  /** Textuntertitel – als WebVTT abrufbar. false = Bild-Untertitel (PGS, VobSub …). */
  textBased: boolean;
  /** Die Auswahl erfordert eine neue Planung, weil der Untertitel ins Video eingebrannt wird (Bild-Untertitel). */
  burnIn: boolean;
}

/** Eingaben für {@link planPlayback}. */
export interface PlanOptions {
  /** Gewünschte Tonspur (Stream-Index); ohne Angabe die Vorgabe des Servers. */
  audioIndex?: number;
  /** Untertitel-Index; `null` = aus; ohne Angabe gilt die Einstellung des Benutzers auf dem Server. */
  subtitleIndex?: number | null;
  /** Höchste Bitrate in Bit/s (Standard 120 Mbit/s). */
  maxBitrate?: number;
  /** Direktwiedergabe/Umpacken ausschließen: immer HLS (z. B. nach einem Abspielfehler). */
  forceTranscode?: boolean;
  /** Zusätzlich Bild und Ton neu berechnen lassen (kein Kopieren der Originalspuren) – letzte Rettung bei Abspielfehlern. */
  reencode?: boolean;
  /** Position, bei der der Player starten soll (Sekunden). Die Planung selbst startet nie "mittendrin". */
  startSec?: number;
  /** Bestimmte Version eines Titels (z. B. 4K statt 1080p). */
  mediaSourceId?: string;
  /** Schon geladener Titel (spart die Abfrage, z. B. bei einer neuen Planung). */
  item?: JfItem;
  signal?: AbortSignal;
}

/** Technische Eckdaten der Quelle (für eine Info-Anzeige). */
export interface PlanSource {
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  bitrate?: number;
}

export interface PlaybackPlan {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  /** Name des Films bzw. der Folge. */
  title: string;
  /** Folgen: "Serienname · S02 E05"; Filme: Erscheinungsjahr (oder fehlt). */
  subtitle?: string;
  /** Verweis wie in den Menü-Einträgen (Typ, Serie/Staffel/Folge). */
  ref: JellyfinRef;
  /** Fertig abspielbare URL (über den Proxy bzw. mit ApiKey) für `<video>`/hls.js. */
  url: string;
  method: PlayMethod;
  protocol: PlayProtocol;
  /** Dauer in Sekunden; 0 = unbekannt. */
  durationSec: number;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  /** Gewählte Tonspur (null = der Titel hat keinen Ton). */
  audioIndex: number | null;
  /** Gewählter Untertitel (null = aus). */
  subtitleIndex: number | null;
  /** WebVTT-URL eines Textuntertitels (`/Videos/{id}/{quelle}/Subtitles/{index}/Stream.vtt`). */
  subtitleUrl(index: number): string;
  /** Lädt den WebVTT-Text mit der Anmeldung der App (kein CORS: in Tauri läuft es über Rust) – z. B. für ein Blob-`<track>`. */
  fetchSubtitle(index: number): Promise<string>;
  /** Der gewählte Untertitel ist ins Bild eingebrannt (dann keinen Text-Track zusätzlich anzeigen). */
  burnedSubtitle: boolean;
  /** Warum umgewandelt/umgepackt wird (deutscher Satz); leer bei Direktwiedergabe. */
  reason: string;
  /** Gespeicherte Position aus dem Wiedergabestand des Benutzers (Sekunden); 0 = nicht begonnen oder fast fertig. */
  resumeSec: number;
  /** Position, bei der der Player starten soll (aus {@link PlanOptions.startSec}). */
  startSec: number;
  /** Geräte-ID, unter der der Server die Umwandlung führt (für `DELETE /Videos/ActiveEncodings`). */
  deviceId: string;
  source: PlanSource;
  /** Neue Planung mit geänderten Wünschen (Tonspur, Untertitel, Bitrate …); Ton/Untertitel bleiben sonst wie gewählt. */
  replan(patch?: Partial<PlanOptions>): Promise<PlaybackPlan>;
}

/* ------------------------------------------------------------------ Hilfen */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Zeitlimit für PlaybackInfo: beim ersten Abruf muss der Server die Datei oft erst untersuchen. */
const PLAYBACK_INFO_TIMEOUT_MS = 20_000;
/** Wie in der XMB (src/xmb/progress.ts): darunter zählt eine Position nicht als "begonnen", darüber als gesehen. */
const MIN_RESUME_SEC = 10;
const PLAYED_RATIO = 0.95;
/** Größte Bitrate, die Jellyfin als Zahl (int32) annimmt. */
const MAX_INT32 = 2_147_483_647;

/** Wert eines Query-Parameters (Groß-/Kleinschreibung egal), ohne Dekodierungsfehler. */
function queryParam(url: string, name: string): string | undefined {
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  const wanted = name.toLowerCase();
  for (const pair of url.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key.toLowerCase() !== wanted) continue;
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return value;
    }
  }
  return undefined;
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  vp8: "VP8",
  vp9: "VP9",
  av1: "AV1",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  vc1: "VC-1",
  aac: "AAC",
  ac3: "AC-3",
  eac3: "E-AC-3",
  dts: "DTS",
  truehd: "TrueHD",
  flac: "FLAC",
  opus: "Opus",
  vorbis: "Vorbis",
  mp3: "MP3",
  mp2: "MP2",
  pcm_s16le: "PCM",
  pcm_s24le: "PCM",
  alac: "ALAC",
};
const codecName = (codec: string | undefined): string => (codec ? (CODEC_NAMES[codec.toLowerCase()] ?? codec.toUpperCase()) : "");

/** Gründe, bei denen das Bild neu berechnet werden muss (sonst genügt Umpacken: Bild wird nur kopiert). */
const VIDEO_REASONS = new Set([
  "VideoCodecNotSupported",
  "VideoProfileNotSupported",
  "VideoLevelNotSupported",
  "VideoResolutionNotSupported",
  "VideoBitDepthNotSupported",
  "VideoFramerateNotSupported",
  "RefFramesNotSupported",
  "AnamorphicVideoNotSupported",
  "InterlacedVideoNotSupported",
  "VideoBitrateNotSupported",
  "ContainerBitrateExceedsLimit",
  "UnknownVideoStreamInfo",
  "VideoRangeTypeNotSupported",
  "VideoCodecTagNotSupported",
  "VideoRotationNotSupported",
  // Eingebrannte Untertitel verändern das Bild.
  "SubtitleCodecNotSupported",
  "DirectPlayError",
]);

/** Ein Satzteil je Transkodierungsgrund (Namen laut Jellyfin-API, `TranscodeReason`). */
function reasonText(reason: string, src: PlanSource): string {
  const video = codecName(src.videoCodec);
  const audio = codecName(src.audioCodec);
  const container = src.container ? src.container.toUpperCase() : "";
  switch (reason) {
    case "ContainerNotSupported":
      return container ? `Containerformat ${container} nicht unterstützt` : "Containerformat nicht unterstützt";
    case "VideoCodecNotSupported":
      return video ? `Videoformat ${video} nicht unterstützt` : "Videoformat nicht unterstützt";
    case "AudioCodecNotSupported":
      return audio ? `Audioformat ${audio} nicht unterstützt` : "Audioformat nicht unterstützt";
    case "SubtitleCodecNotSupported":
      return "Untertitelformat nicht unterstützt (wird ins Bild eingebrannt)";
    case "AudioIsExternal":
      return "Tonspur liegt in einer eigenen Datei";
    case "SecondaryAudioNotSupported":
      return "andere Tonspur gewählt";
    case "VideoProfileNotSupported":
      return "Videoprofil nicht unterstützt";
    case "VideoLevelNotSupported":
      return "Videolevel zu hoch";
    case "VideoResolutionNotSupported":
      return "Auflösung zu hoch";
    case "VideoBitDepthNotSupported":
      return "Farbtiefe nicht unterstützt";
    case "VideoFramerateNotSupported":
      return "Bildrate zu hoch";
    case "RefFramesNotSupported":
      return "Referenzbilder nicht unterstützt";
    case "AnamorphicVideoNotSupported":
      return "Anamorphes Video nicht unterstützt";
    case "InterlacedVideoNotSupported":
      return "Zeilensprungverfahren nicht unterstützt";
    case "AudioChannelsNotSupported":
      return "Anzahl der Tonkanäle nicht unterstützt";
    case "AudioProfileNotSupported":
      return "Audioprofil nicht unterstützt";
    case "AudioSampleRateNotSupported":
      return "Abtastrate des Tons nicht unterstützt";
    case "AudioBitDepthNotSupported":
      return "Bittiefe des Tons nicht unterstützt";
    case "ContainerBitrateExceedsLimit":
    case "VideoBitrateNotSupported":
    case "AudioBitrateNotSupported":
      return "Bitrate über dem Limit";
    case "UnknownVideoStreamInfo":
    case "UnknownAudioStreamInfo":
      return "Angaben zum Stream fehlen";
    case "DirectPlayError":
      return "Direktwiedergabe fehlgeschlagen";
    case "VideoRangeTypeNotSupported":
      return "HDR-Format nicht unterstützt";
    case "VideoCodecTagNotSupported":
      return "Video-Kennung nicht unterstützt";
    case "StreamCountExceedsLimit":
      return "zu viele Spuren in der Datei";
    case "VideoRotationNotSupported":
      return "Bilddrehung nicht unterstützt";
    default:
      return reason;
  }
}

/** Alle Gründe als Liste (aus dem Link oder – bei neueren Servern – aus der Quelle). */
function parseReasons(transcodingUrl: string, source: Obj): string[] {
  const fromUrl = queryParam(transcodingUrl, "TranscodeReasons");
  const raw = fromUrl ?? source.TranscodeReasons;
  const list = Array.isArray(raw) ? raw.map(str) : typeof raw === "string" ? raw.split(",") : [];
  return [...new Set(list.map((r) => r.trim()).filter(Boolean))];
}

function describeReasons(method: PlayMethod, reasons: string[], src: PlanSource, forced: boolean): string {
  if (method === "DirectPlay") return "";
  const verb = method === "DirectStream" ? "packt das Video um" : "wandelt das Video um";
  const parts = reasons.map((r) => reasonText(r, src));
  if (parts.length === 0) {
    return forced ? `Der Server ${verb} (auf Anforderung).` : `Der Server ${verb}, damit es hier läuft.`;
  }
  return `Der Server ${verb}: ${[...new Set(parts)].join(", ")}.`;
}

/** Container-Name für die Stream-URL: der Server nennt meist genau einen, ältere liefern ffprobe-Listen ("matroska,webm"). */
function streamContainer(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t === "matroska" ? "mkv" : t));
  const preferred = ["mp4", "m4v", "webm", "mkv", "mov", "ts", "avi", "wmv", "ogv", "3gp"];
  return preferred.find((p) => tokens.includes(p)) ?? tokens[0] ?? "";
}

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    let id = "";
    for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
  }
}

interface RawStream {
  index: number;
  type: string;
  codec?: string;
  language?: string;
  label: string;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
  isText: boolean;
  delivery?: string;
  channels?: number;
  width?: number;
  height?: number;
  bitrate?: number;
}

function parseStreams(value: unknown): RawStream[] {
  if (!Array.isArray(value)) return [];
  const out: RawStream[] = [];
  for (const entry of value) {
    const s = obj(entry);
    const index = num(s?.Index);
    if (!s || index === undefined) continue;
    const codec = str(s.Codec) || undefined;
    const language = str(s.Language) || undefined;
    const type = str(s.Type);
    out.push({
      index,
      type,
      codec,
      language,
      label:
        str(s.DisplayTitle) ||
        str(s.Title) ||
        [language ? language.toUpperCase() : "", codecName(codec)].filter(Boolean).join(" ") ||
        `${type === "Audio" ? "Tonspur" : type === "Subtitle" ? "Untertitel" : "Spur"} ${index}`,
      isDefault: s.IsDefault === true,
      isForced: s.IsForced === true,
      isExternal: s.IsExternal === true,
      isText: s.IsTextSubtitleStream === true,
      delivery: str(s.DeliveryMethod) || undefined,
      channels: num(s.Channels),
      width: num(s.Width),
      height: num(s.Height),
      bitrate: num(s.BitRate),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------ PlaybackInfo */

interface PlaybackInfo {
  sources: Obj[];
  playSessionId: string;
}

async function requestPlaybackInfo(ctx: JfContext, itemId: string, opts: PlanOptions): Promise<PlaybackInfo> {
  const profile = buildDeviceProfile(opts.maxBitrate ? { maxStreamingBitrate: Math.min(opts.maxBitrate, MAX_INT32) } : {});
  // Position, Audio- und Untertitelwunsch gehören in den Körper (die Query-Fassung ist veraltet); nur userId bleibt in der Query.
  const body: Obj = {
    UserId: ctx.userId,
    MaxStreamingBitrate: profile.MaxStreamingBitrate,
    DeviceProfile: profile,
    EnableDirectPlay: !opts.forceTranscode,
    EnableDirectStream: !opts.forceTranscode,
    EnableTranscoding: true,
    AllowVideoStreamCopy: !opts.reencode,
    AllowAudioStreamCopy: !opts.reencode,
    AutoOpenLiveStream: false,
    AlwaysBurnInSubtitleWhenTranscoding: false,
  };
  if (opts.mediaSourceId) body.MediaSourceId = opts.mediaSourceId;
  if (opts.audioIndex !== undefined) body.AudioStreamIndex = opts.audioIndex;
  if (opts.subtitleIndex !== undefined) body.SubtitleStreamIndex = opts.subtitleIndex === null ? -1 : opts.subtitleIndex;

  const res = await jfRaw(ctx, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
    method: "POST",
    query: { userId: ctx.userId },
    body,
    signal: opts.signal,
    timeoutMs: PLAYBACK_INFO_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw statusError(res.status, {
      403: "Wiedergabe für diesen Benutzer nicht erlaubt",
      404: "Titel auf dem Server nicht gefunden",
      other: (s) =>
        s >= 500
          ? `Der Server konnte die Wiedergabe nicht vorbereiten (Status ${s})`
          : `Der Server hat die Wiedergabe abgelehnt (Status ${s})`,
    });
  }
  let json: Obj | null;
  try {
    json = obj(JSON.parse(res.text));
  } catch {
    throw new JfError("Antwort des Servers ist kein gültiges JSON", "protocol");
  }
  if (!json) throw new JfError("Unerwartete Antwort des Servers", "protocol");

  const code = str(json.ErrorCode);
  if (code === "NotAllowed") throw new JfError("Wiedergabe für diesen Benutzer nicht erlaubt", "unplayable");
  if (code === "RateLimitExceeded") {
    throw new JfError("Zu viele gleichzeitige Wiedergaben – das Limit des Servers ist erreicht", "unplayable");
  }
  if (code === "NoCompatibleStream") {
    throw new JfError(
      "Keine kompatible Quelle: Der Server kann dieses Video weder direkt noch umgewandelt für diesen Player bereitstellen",
      "unplayable",
    );
  }
  const sources = (Array.isArray(json.MediaSources) ? json.MediaSources : []).map(obj).filter((s): s is Obj => !!s);
  if (sources.length === 0) throw new JfError("Keine abspielbare Quelle gefunden", "unplayable");
  return { sources, playSessionId: str(json.PlaySessionId) };
}

const norm = (id: string) => id.toLowerCase().replace(/-/g, "");
const isPlayable = (s: Obj) => s.SupportsDirectPlay === true || s.SupportsDirectStream === true || !!str(s.TranscodingUrl);

/** Die Quelle des Titels selbst, sonst die beste abspielbare (Direktwiedergabe vor Umwandeln). */
function chooseSource(sources: Obj[], itemId: string, wanted?: string): Obj {
  if (wanted) {
    const hit = sources.find((s) => str(s.Id) === wanted);
    if (hit) return hit;
  }
  const own = sources.find((s) => norm(str(s.Id)) === norm(itemId) && isPlayable(s));
  return (
    own ??
    sources.find((s) => s.SupportsDirectPlay === true) ??
    sources.find((s) => !!str(s.TranscodingUrl)) ??
    sources.find((s) => s.SupportsDirectStream === true) ??
    sources[0]
  );
}

/* --------------------------------------------------------------------- Plan */

function subtitleLine(item: JfItem | undefined): string | undefined {
  if (!item) return undefined;
  if (item.type === "Episode") {
    const number = [
      item.seasonNumber !== undefined ? `S${String(item.seasonNumber).padStart(2, "0")}` : "",
      item.episodeNumber !== undefined ? `E${String(item.episodeNumber).padStart(2, "0")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return [item.seriesName, number].filter(Boolean).join(" · ") || undefined;
  }
  return item.year ? String(item.year) : undefined;
}

/** Nur für das Sicherheitsnetz unten: ein einziger Zweitversuch, der nicht in `replan` weitergereicht wird. */
interface Internal {
  depth: number;
  /** Direktwiedergabe ausschließen, ohne dass es als Wunsch des Aufrufers gilt. */
  noDirect?: boolean;
  /** Grund, den der Server in diesem Fall nicht nennt. */
  reason?: string;
}

async function plan(ctx: JfContext, itemId: string, opts: PlanOptions, internal: Internal): Promise<PlaybackPlan> {
  if (opts.signal?.aborted) throw abortError();

  // Titel (Name, Wiedergabestand) und PlaybackInfo gleichzeitig holen.
  const itemResult = opts.item
    ? Promise.resolve({ ok: true as const, item: opts.item })
    : getItem(ctx, itemId, { signal: opts.signal }).then(
        (item) => ({ ok: true as const, item }),
        (error: unknown) => ({ ok: false as const, error }),
      );
  const info = await requestPlaybackInfo(
    ctx,
    itemId,
    internal.noDirect ? { ...opts, forceTranscode: true } : opts,
  );
  const loaded = await itemResult;
  let item: JfItem | undefined;
  if (loaded.ok) {
    item = loaded.item;
  } else if (isAbortError(loaded.error) || (loaded.error instanceof JfError && loaded.error.kind === "notfound")) {
    throw loaded.error;
  }
  if (item && ["Series", "Season", "BoxSet", "Folder", "CollectionFolder", "UserView"].includes(item.type)) {
    throw new JfError(`„${item.name || "Dieser Eintrag"}“ ist kein Film und keine Folge – bitte eine Folge wählen`, "unplayable");
  }

  const ms = chooseSource(info.sources, itemId, opts.mediaSourceId);
  if (!isPlayable(ms)) {
    throw new JfError(
      "Keine abspielbare Quelle: Der Server bietet weder Direktwiedergabe noch Umwandlung an (ist die Umwandlung für diesen Benutzer abgeschaltet?)",
      "unplayable",
    );
  }
  const mediaSourceId = str(ms.Id) || itemId;
  const streams = parseStreams(ms.MediaStreams);
  const audioStreams = streams.filter((s) => s.type === "Audio");
  const subtitleStreams = streams.filter((s) => s.type === "Subtitle");
  const video = streams.find((s) => s.type === "Video");

  /* --- Tonspur und Untertitel, wie sie gelten --- */
  const transcodingUrl = str(ms.TranscodingUrl);
  const usable = transcodingUrl !== "" && ms.SupportsTranscoding !== false;
  const hasAudio = (i: number | undefined) => i !== undefined && audioStreams.some((a) => a.index === i);
  // Beim Umwandeln zählt, was der Server in die URL geschrieben hat – das ist die Spur, die tatsächlich zu hören ist.
  const urlAudio = ms.SupportsDirectPlay !== true && usable ? Number.parseInt(queryParam(transcodingUrl, "AudioStreamIndex") ?? "", 10) : NaN;
  const serverAudio = num(ms.DefaultAudioStreamIndex);
  const audioIndex: number | null = !audioStreams.length
    ? null
    : hasAudio(urlAudio)
      ? urlAudio
      : hasAudio(opts.audioIndex)
        ? (opts.audioIndex as number)
        : hasAudio(serverAudio)
          ? (serverAudio as number)
          : (audioStreams.find((a) => a.isDefault) ?? audioStreams[0]).index;
  const hasSub = (i: number | undefined | null) => typeof i === "number" && i >= 0 && subtitleStreams.some((s) => s.index === i);
  const serverSub = num(ms.DefaultSubtitleStreamIndex);
  const subtitleIndex: number | null =
    opts.subtitleIndex === null
      ? null
      : hasSub(opts.subtitleIndex)
        ? (opts.subtitleIndex as number)
        : opts.subtitleIndex === undefined && hasSub(serverSub)
          ? (serverSub as number)
          : null;

  const source: PlanSource = {
    container: str(ms.Container) || undefined,
    videoCodec: video?.codec,
    audioCodec: audioStreams.find((a) => a.index === audioIndex)?.codec,
    width: video?.width,
    height: video?.height,
    bitrate: num(ms.Bitrate),
  };

  /* --- Methode und URL --- */
  const staticUrl = (): string => {
    const container = streamContainer(str(ms.Container));
    const parts = [
      "static=true",
      `mediaSourceId=${encodeURIComponent(mediaSourceId)}`,
      ...(str(ms.ETag) ? [`tag=${encodeURIComponent(str(ms.ETag))}`] : []),
      `deviceId=${encodeURIComponent(ctx.deviceId)}`,
      `playSessionId=${encodeURIComponent(playSessionId)}`,
    ];
    return mediaUrl(ctx, `/Videos/${encodeURIComponent(itemId)}/stream${container ? `.${container}` : ""}?${parts.join("&")}`);
  };

  const playSessionId = info.playSessionId || queryParam(transcodingUrl, "PlaySessionId") || randomId();

  let method: PlayMethod;
  let protocol: PlayProtocol = "file";
  let url: string;
  let reasons: string[] = [];
  let encodingDeviceId = ctx.deviceId;
  let burnedByUrl = false;
  if (ms.SupportsDirectPlay === true) {
    method = "DirectPlay";
    url = staticUrl();
  } else if (usable) {
    url = mediaUrl(ctx, transcodingUrl);
    const path = transcodingUrl.split("?")[0];
    protocol = str(ms.TranscodingSubProtocol).toLowerCase() === "hls" || /\.m3u8$/i.test(path) ? "hls" : "file";
    reasons = parseReasons(transcodingUrl, ms);
    if (reasons.length === 0 && internal.reason) reasons = [internal.reason];
    // Kopiert der Server das Bild nur (kein Grund, der das Bild betrifft), ist es Umpacken statt Umwandeln.
    const copiesVideo =
      reasons.length > 0 &&
      !reasons.some((r) => VIDEO_REASONS.has(r)) &&
      queryParam(transcodingUrl, "allowVideoStreamCopy")?.toLowerCase() !== "false";
    method = copiesVideo ? "DirectStream" : "Transcode";
    encodingDeviceId = queryParam(transcodingUrl, "DeviceId") || ctx.deviceId;
    burnedByUrl = queryParam(transcodingUrl, "SubtitleMethod")?.toLowerCase() === "encode";
  } else {
    method = "DirectStream";
    url = staticUrl();
  }

  /* --- Sicherheitsnetz: Direktwiedergabe liefert immer die erste Tonspur --- */
  const firstAudio = audioStreams[0]?.index;
  if (
    method === "DirectPlay" &&
    audioIndex !== null &&
    firstAudio !== undefined &&
    audioIndex !== firstAudio &&
    internal.depth < 1
  ) {
    // Eine statische Datei lässt sich nicht auf eine andere Tonspur stellen. Neuere Server packen in dem Fall selbst um
    // (Bedingung "IsSecondaryAudio" im Profil); ein Server, der das nicht tut, wird hier zum Umpacken gezwungen.
    try {
      const forced = await plan(
        ctx,
        itemId,
        { ...opts, item, audioIndex },
        { depth: internal.depth + 1, noDirect: true, reason: "SecondaryAudioNotSupported" },
      );
      if (forced.method !== "DirectPlay") return forced;
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
  }
  const effectiveAudio = method === "DirectPlay" && firstAudio !== undefined ? firstAudio : audioIndex;

  /* --- Spuren --- */
  const audio: AudioTrack[] = audioStreams.map((a) => ({
    index: a.index,
    label: a.label,
    ...(a.language ? { language: a.language } : {}),
    ...(a.codec ? { codec: a.codec } : {}),
    ...(a.channels !== undefined ? { channels: a.channels } : {}),
    isDefault: a.isDefault,
  }));
  const subtitles: SubtitleTrack[] = subtitleStreams.map((s) => {
    const burnIn = s.delivery ? s.delivery === "Encode" : !s.isText;
    return {
      index: s.index,
      label: s.label,
      ...(s.language ? { language: s.language } : {}),
      ...(s.codec ? { codec: s.codec } : {}),
      isDefault: s.isDefault,
      isForced: s.isForced,
      isExternal: s.isExternal,
      textBased: s.isText,
      burnIn,
    };
  });
  const burnedSubtitle =
    subtitleIndex !== null && (burnedByUrl || subtitleStreams.find((s) => s.index === subtitleIndex)?.delivery === "Encode");

  /* --- Zeiten und Titel --- */
  const durationSec = ticksToSec(num(ms.RunTimeTicks)) || ticksToSec(item?.runTimeTicks);
  let resumeSec = ticksToSec(item?.userData?.positionTicks);
  if (resumeSec < MIN_RESUME_SEC || (durationSec > 0 && resumeSec / durationSec >= PLAYED_RATIO)) resumeSec = 0;

  const ref: JellyfinRef =
    (item && itemToRef(item)) ?? ({ id: itemId, type: item?.type === "Episode" ? "Episode" : "Movie" } as JellyfinRef);
  const subtitlePath = (index: number) =>
    `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${index}/Stream.vtt`;
  // Für die nächste Planung (Tonspur/Untertitel wechseln): die jetzigen Wahlen bleiben, bis der Aufrufer etwas anderes sagt.
  const carried: PlanOptions = {
    audioIndex: effectiveAudio ?? undefined,
    subtitleIndex,
    maxBitrate: opts.maxBitrate,
    forceTranscode: opts.forceTranscode,
    reencode: opts.reencode,
    mediaSourceId,
    item,
  };

  return {
    itemId,
    mediaSourceId,
    playSessionId,
    title: item?.name || str(ms.Name) || "Unbenannt",
    ...(subtitleLine(item) ? { subtitle: subtitleLine(item) } : {}),
    ref,
    url,
    method,
    protocol,
    durationSec,
    audio,
    subtitles,
    audioIndex: effectiveAudio,
    subtitleIndex,
    subtitleUrl: (index) => mediaUrl(ctx, subtitlePath(index)),
    fetchSubtitle: (index) =>
      jfText(ctx, subtitlePath(index), { timeoutMs: 15_000 }, { 404: "Untertitel nicht gefunden" }),
    burnedSubtitle,
    reason: usable && ms.SupportsDirectPlay !== true ? describeReasons(method, reasons, source, opts.forceTranscode === true) : "",
    resumeSec,
    startSec: Math.max(0, opts.startSec ?? 0),
    deviceId: encodingDeviceId,
    source,
    replan: (patch = {}) => plan(ctx, itemId, { ...carried, ...patch }, { depth: 0 }),
  };
}

/**
 * Plant die Wiedergabe: fragt den Server (`POST /Items/{id}/PlaybackInfo`) mit dem Geräteprofil dieses Fensters und
 * entscheidet daraus Direktwiedergabe, Umpacken oder Umwandeln (HLS). Tonspur-Wechsel und Bild-Untertitel (Einbrennen)
 * brauchen eine neue Planung – `plan.replan({ audioIndex })` erledigt das.
 *
 * Wirft {@link JfError} mit deutscher Meldung (Server weg, Titel fehlt, keine abspielbare Quelle …) bzw. AbortError.
 */
export function planPlayback(ctx: JfContext, itemId: string, opts: PlanOptions = {}): Promise<PlaybackPlan> {
  return plan(ctx, itemId, opts, { depth: 0 });
}

