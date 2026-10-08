/**
 * Geräteprofil für Jellyfin: sagt dem Server, was dieses Fenster (WebView) abspielen kann. Daran entscheidet der
 * Server zwischen Direktwiedergabe, Umpacken und Umwandeln (HLS). Vorlage ist jellyfin-web
 * (src/scripts/browserDeviceProfile.js), aber ohne Browser-Erkennung per Namen: In Tauri steckt unter macOS
 * WKWebView (UA ohne "Safari"/"Chrome"), unter Windows WebView2, unter Linux WebKitGTK – deshalb zählen die echten
 * `canPlayType`/`isTypeSupported`-Ergebnisse, und nur wo Engines bekanntermaßen abweichen, die grobe Engine.
 */

/** Was die Engine abspielen kann – austauschbar, damit sich Profile für andere Engines (z. B. WKWebView) prüfen lassen. */
export interface EngineProbe {
  /** `HTMLMediaElement.canPlayType(type) !== ""` */
  canPlay(type: string): boolean;
  /** `MediaSource.isTypeSupported(type)`; ohne MSE immer false. */
  mseSupports(type: string): boolean;
  hasMse: boolean;
  /** Spielt `<video src="….m3u8">` selbst (WebKit; neueres Chromium). */
  nativeHls: boolean;
  engine: "webkit" | "chromium" | "gecko" | "other";
  os: "mac" | "windows" | "linux" | "other";
  mobile: boolean;
}

/** Wie HLS abgespielt wird: `native` = das `<video>`-Element selbst, `mse` = hls.js über Media Source Extensions. */
export type HlsMode = "native" | "mse" | null;

export interface DeviceProfileOptions {
  /** Obergrenze für Streaming in Bit/s (Standard 120 Mbit/s wie in jellyfin-web). */
  maxStreamingBitrate?: number;
  /** Höchste Kanalzahl für umgewandelten Ton (Standard: 6 bei WebKit/Chromium, sonst 2). */
  maxAudioChannels?: number;
}

type Condition = {
  Condition: "Equals" | "NotEquals" | "LessThanEqual" | "GreaterThanEqual" | "EqualsAny";
  Property: string;
  Value: string;
  IsRequired: boolean;
};

export interface JfDeviceProfile {
  Name: string;
  MaxStreamingBitrate: number;
  MaxStaticBitrate: number;
  MusicStreamingTranscodingBitrate: number;
  DirectPlayProfiles: Array<{ Container: string; Type: "Video"; VideoCodec: string; AudioCodec: string }>;
  TranscodingProfiles: Array<{
    Container: "mp4" | "ts";
    Type: "Video";
    VideoCodec: string;
    AudioCodec: string;
    Protocol: "hls";
    Context: "Streaming";
    MaxAudioChannels: string;
    MinSegments: number;
    BreakOnNonKeyFrames: boolean;
  }>;
  ContainerProfiles: never[];
  CodecProfiles: Array<{
    Type: "Video" | "VideoAudio";
    Codec?: string;
    Conditions: Condition[];
  }>;
  SubtitleProfiles: Array<{ Format: string; Method: "External" }>;
}

/* ------------------------------------------------------------------ Erkennung */

/** Fragt die laufende Engine ab. Ohne Dokument (Tests unter Node) können nur Teile erkannt werden. */
export function probeEngine(): EngineProbe {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const video = typeof document === "undefined" ? null : document.createElement("video");
  const MS = typeof window === "undefined" ? undefined : window.MediaSource;

  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua);
  const gecko = /Firefox\//.test(ua);
  const webkit = /AppleWebKit\//.test(ua) && !chromium;
  const canPlay = (type: string) => {
    try {
      return !!video && video.canPlayType(type) !== "";
    } catch {
      return false;
    }
  };
  return {
    canPlay,
    mseSupports: (type) => {
      try {
        return !!MS && MS.isTypeSupported(type);
      } catch {
        return false;
      }
    },
    hasMse: !!MS,
    nativeHls: canPlay("application/vnd.apple.mpegurl") || canPlay("application/x-mpegURL"),
    engine: chromium ? "chromium" : webkit ? "webkit" : gecko ? "gecko" : "other",
    os: /Macintosh|Mac OS X/.test(ua)
      ? "mac"
      : /Windows/.test(ua)
        ? "windows"
        : /Linux|X11/.test(ua)
          ? "linux"
          : "other",
    mobile: /Mobi|Android|iPhone|iPad/.test(ua),
  };
}

/**
 * Wie HLS hier am besten läuft: WebKit spielt es selbst (das ist dort der stabile Weg), alle anderen über hls.js/MSE.
 * Der Player sollte genau diesen Weg nehmen – das Profil verspricht nur Formate, die dieser Weg beherrscht.
 */
export function pickHlsMode(e: EngineProbe): HlsMode {
  if (e.engine === "webkit" && e.nativeHls) return "native";
  if (e.hasMse) return "mse";
  return e.nativeHls ? "native" : null;
}

let cachedEngine: EngineProbe | null = null;
const getEngine = () => (cachedEngine ??= probeEngine());

/** {@link pickHlsMode} für die laufende Engine – der Player nimmt genau diesen Weg. */
export function hlsMode(): HlsMode {
  return pickHlsMode(getEngine());
}

/* ---------------------------------------------------------------------- Profil */

const list = (...items: Array<string | false | null | undefined>): string[] =>
  items.filter((x): x is string => typeof x === "string" && x !== "");

/** Baut das Profil aus den Fähigkeiten einer Engine (rein – gleiche Engine, gleiches Profil). */
export function buildDeviceProfileFor(e: EngineProbe, o: DeviceProfileOptions = {}): JfDeviceProfile {
  const maxBitrate = Math.round(o.maxStreamingBitrate ?? 120_000_000);
  const webkit = e.engine === "webkit";
  const chromium = e.engine === "chromium";
  const gecko = e.engine === "gecko";
  const mac = e.os === "mac";
  const can = e.canPlay;
  const mode = pickHlsMode(e);

  /* --- Videoformate im Datei-Container --- */
  const h264 = can('video/mp4; codecs="avc1.42E01E"');
  const hevc = ["hvc1.1.L120", "hev1.1.L120", "hvc1.1.0.L120", "hev1.1.0.L120"].some((c) =>
    can(`video/mp4; codecs="${c}"`),
  );
  const vp8 = can('video/webm; codecs="vp8"');
  const vp9 = can('video/webm; codecs="vp9"');
  // AV1 nur auf dem Desktop: auf Mobilgeräten wäre es Softwaredekodierung.
  const av1 = !e.mobile && can('video/mp4; codecs="av01.0.15M.08"') && can('video/mp4; codecs="av01.0.15M.10"');

  /* --- Tonformate im Datei-Container --- */
  const aac = can('audio/mp4; codecs="mp4a.40.2"');
  const mp3 = can('audio/mp4; codecs="mp3"') || can('audio/mp4; codecs="mp4a.69"') || can('audio/mp4; codecs="mp4a.6B"');
  const ac3 = can('audio/mp4; codecs="ac-3"');
  const eac3 = ac3 && can('audio/mp4; codecs="ec-3"');
  const opusMp4 = can('audio/mp4; codecs="opus"');
  const opusWebm = can('audio/webm; codecs="opus"');
  const vorbisWebm = can('audio/webm; codecs="vorbis"');
  const flac = can('audio/mp4; codecs="flac"') || can("audio/flac");
  const alac = can('audio/mp4; codecs="alac"');

  const mp4Video = list(h264 && "h264", hevc && "hevc", vp9 && !(gecko && mac) && "vp9", av1 && "av1");
  // WebM in WebKit ist unzuverlässig (Safari 17); der Server packt solche Dateien lieber nach HLS um.
  const webmVideo = webkit ? [] : list(vp8 && "vp8", vp9 && "vp9", av1 && "av1");
  const mp4Audio = list(aac && "aac", mp3 && "mp3", ac3 && "ac3", eac3 && "eac3", opusMp4 && "opus", flac && "flac", alac && "alac");
  const webmAudio = list(vorbisWebm && "vorbis", opusWebm && "opus");
  const mkvAudio = [...new Set([...mp4Audio, ...webmAudio])];
  // Firefox spielt Matroska nur gepuffert ab (lädt erst alles) – für Streaming untauglich.
  const mkv = !gecko && (can("video/x-matroska") || can("video/mkv"));

  const direct: JfDeviceProfile["DirectPlayProfiles"] = [];
  const addDirect = (container: string, video: string[], audioCodecs: string[]) => {
    // Eine leere Codec-Liste würde der Server als "alles erlaubt" lesen – dann lieber gar kein Profil.
    if (video.length && audioCodecs.length) {
      direct.push({ Container: container, Type: "Video", VideoCodec: video.join(","), AudioCodec: audioCodecs.join(",") });
    }
  };
  addDirect("webm", webmVideo, webmAudio);
  addDirect("mp4,m4v", mp4Video, mp4Audio);
  if (mkv) addDirect("mkv", mp4Video, mkvAudio);
  addDirect("mov", list(h264 && "h264", hevc && "hevc"), mp4Audio);

  /* --- HLS (Umwandeln/Umpacken): nur Formate, die der gewählte HLS-Weg beherrscht --- */
  const hlsV = (codec: string) =>
    mode === "mse" ? e.mseSupports(`video/mp4; codecs="${codec}"`) : mode === "native" && can(`video/mp4; codecs="${codec}"`);
  const hlsA = (codec: string) =>
    mode === "mse" ? e.mseSupports(`audio/mp4; codecs="${codec}"`) : mode === "native" && can(`audio/mp4; codecs="${codec}"`);
  // VP9/AV1 in HLS kann WebKit-eigenes HLS nicht; dort bleibt es bei H.264/HEVC.
  const hlsVideo = list(
    hlsV("avc1.42E01E") && "h264",
    hlsV("hvc1.1.6.L93.B0") && "hevc",
    mode === "mse" && hlsV("vp09.00.10.08") && "vp9",
    mode === "mse" && !e.mobile && hlsV("av01.0.05M.08") && "av1",
  );
  // Die erste Tonart ist das Ziel beim Umwandeln: AAC, wo möglich (stereo und Surround, überall dekodierbar).
  const hlsAudioMp4 = list(
    hlsA("mp4a.40.2") && "aac",
    hlsA("ac-3") && "ac3",
    hlsA("ec-3") && "eac3",
    hlsA("flac") && "flac",
    hlsA("alac") && "alac",
    hlsA("opus") && "opus",
  );
  const hlsAudioTs = list(hlsA("mp4a.40.2") && "aac", hlsA("ac-3") && "ac3", hlsA("ec-3") && "eac3");
  const channels = String(o.maxAudioChannels ?? (webkit || chromium ? 6 : 2));
  const hlsCommon = {
    Type: "Video" as const,
    Protocol: "hls" as const,
    Context: "Streaming" as const,
    MaxAudioChannels: channels,
    MinSegments: mac ? 2 : 1,
    // Nur unter WebKit/macOS bzw. ohne eigenes HLS darf an Nicht-Keyframes getrennt werden (wie jellyfin-web).
    BreakOnNonKeyFrames: mac || mode !== "native" || !e.nativeHls,
  };

  const transcoding: JfDeviceProfile["TranscodingProfiles"] = [];
  if (hlsVideo.length && hlsAudioMp4.length) {
    transcoding.push({ ...hlsCommon, Container: "mp4", VideoCodec: hlsVideo.join(","), AudioCodec: hlsAudioMp4.join(",") });
  }
  // MPEG-TS ist der verträglichste Weg für H.264 (auch ältere hls.js/WebKit-Versionen).
  if (hlsVideo.includes("h264") && hlsAudioTs.length) {
    transcoding.push({ ...hlsCommon, Container: "ts", VideoCodec: "h264", AudioCodec: hlsAudioTs.join(",") });
  }

  /* --- Bedingungen je Codec (Profil, Level, HDR) --- */
  const codecProfiles: JfDeviceProfile["CodecProfiles"] = [];
  const cond = (
    Condition: Condition["Condition"],
    Property: string,
    Value: string,
    IsRequired = false,
  ): Condition => ({ Condition, Property, Value, IsRequired });

  // Zweite Tonspur nie direkt abspielen: ein <video> ohne audioTracks kann sie nicht wählen, die statische
  // Datei liefert immer die erste. Der Server packt dann mit der gewählten Spur um.
  codecProfiles.push({ Type: "VideoAudio", Conditions: [cond("Equals", "IsSecondaryAudio", "false")] });
  if (!can('video/mp4; codecs="avc1.640029, mp4a.40.5"')) {
    // HE-AAC wird nicht überall dekodiert; der Server wandelt solche Spuren in normales AAC um.
    codecProfiles.push({
      Type: "VideoAudio",
      Codec: "aac",
      Conditions: [cond("NotEquals", "AudioProfile", "HE-AAC")],
    });
  }

  let maxH264Level = 42;
  let h264Profiles = "high|main|baseline|constrained baseline";
  if (can('video/mp4; codecs="avc1.640833"')) maxH264Level = 51;
  if (can('video/mp4; codecs="avc1.640834"')) maxH264Level = 52;
  // High 10 melden Safari/WebKit zwar als abspielbar, es ruckelt aber (jellyfin-web lässt es dort aus).
  if (can('video/mp4; codecs="avc1.6e0033"') && !webkit && !e.mobile) h264Profiles += "|high 10";

  let maxHevcLevel = 120;
  let hevcProfiles = "main";
  const hevcOk = (profile: string, level: string) =>
    can(`video/mp4; codecs="hvc1.${profile}.4.L${level}"`) || can(`video/mp4; codecs="hev1.${profile}.4.L${level}"`);
  if (hevcOk("1", "123")) maxHevcLevel = 123;
  if (hevcOk("2", "123")) {
    maxHevcLevel = 123;
    hevcProfiles = "main|main 10";
  }
  for (const level of [153, 183, 186]) {
    if (hevcOk("2", String(level))) {
      maxHevcLevel = level;
      hevcProfiles = "main|main 10";
    }
  }

  let maxAv1Level = 15;
  for (const level of [16, 17, 18, 19]) {
    if (can(`video/mp4; codecs="av01.0.${level}M.08"`) && can(`video/mp4; codecs="av01.0.${level}M.10"`)) maxAv1Level = level;
  }

  // HDR: WebKit auf dem Mac und Desktop-Chromium geben HDR10/HLG aus; Dolby Vision nur, wo die Engine es meldet.
  const hdr = (webkit && mac) || (chromium && !e.mobile);
  const dolbyProfile5 = webkit && mac && can('video/mp4; codecs="dvh1.05.06"');
  const dolbyProfile8 = webkit && mac && can('video/mp4; codecs="dvh1.08.06"');
  let hevcRange = "SDR";
  let vp9Range = "SDR";
  let av1Range = "SDR";
  if (hdr) {
    hevcRange += "|HDR10|HDR10Plus|HLG";
    vp9Range += "|HDR10|HDR10Plus|HLG";
    av1Range += "|HDR10|HDR10Plus|HLG";
  }
  if (dolbyProfile5) hevcRange += "|DOVI";
  if (dolbyProfile8) hevcRange += "|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus";

  const interlaced = cond("NotEquals", "IsInterlaced", "true");
  codecProfiles.push({
    Type: "Video",
    Codec: "h264",
    Conditions: [
      cond("EqualsAny", "VideoProfile", h264Profiles),
      cond("EqualsAny", "VideoRangeType", "SDR"),
      cond("LessThanEqual", "VideoLevel", String(maxH264Level)),
      interlaced,
    ],
  });
  codecProfiles.push({
    Type: "Video",
    Codec: "hevc",
    Conditions: [
      cond("EqualsAny", "VideoProfile", hevcProfiles),
      cond("EqualsAny", "VideoRangeType", hevcRange),
      cond("LessThanEqual", "VideoLevel", String(maxHevcLevel)),
      interlaced,
      // Safari/WebKit nimmt nur die Kennung hvc1/dvh1 und höchstens 60 Bilder/s (Erkenntnis aus jellyfin-web).
      ...(webkit
        ? [cond("EqualsAny", "VideoCodecTag", "hvc1|dvh1", true), cond("LessThanEqual", "VideoFramerate", "60", true)]
        : []),
    ],
  });
  codecProfiles.push({ Type: "Video", Codec: "vp9", Conditions: [cond("EqualsAny", "VideoRangeType", vp9Range)] });
  codecProfiles.push({
    Type: "Video",
    Codec: "av1",
    Conditions: [
      cond("EqualsAny", "VideoProfile", "main"),
      cond("EqualsAny", "VideoRangeType", av1Range),
      cond("LessThanEqual", "VideoLevel", String(maxAv1Level)),
      interlaced,
    ],
  });

  return {
    Name: "JellyStation",
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: 100_000_000,
    MusicStreamingTranscodingBitrate: Math.min(maxBitrate, 384_000),
    DirectPlayProfiles: direct,
    TranscodingProfiles: transcoding,
    ContainerProfiles: [],
    CodecProfiles: codecProfiles,
    // Textuntertitel liefert der Server als Datei (WebVTT); ass/ssa/srt gelten als "kann ich selbst", damit er sie nicht
    // einbrennt. Bild-Untertitel (PGS, VobSub) passen in keines dieser Formate und werden eingebrannt.
    SubtitleProfiles: ["vtt", "srt", "subrip", "ass", "ssa"].map((Format) => ({ Format, Method: "External" as const })),
  };
}

/** Profil für die laufende Engine; `options` (z. B. eine niedrigere Bitrate) ändern nur die Grenzen. */
export function buildDeviceProfile(options: DeviceProfileOptions = {}): JfDeviceProfile {
  return buildDeviceProfileFor(getEngine(), options);
}
