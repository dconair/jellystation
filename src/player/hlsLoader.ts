/**
 * HLS über hls.js (Media Source Extensions) – für alle Engines, die HLS nicht selbst abspielen (Chromium, WebView2,
 * WebKitGTK). WKWebView/Safari spielen `.m3u8` nativ und brauchen das nicht (siehe hlsMode in jellyfin/profile.ts).
 * hls.js wird erst bei Bedarf geladen, damit der Start der App nichts davon kostet.
 */

export interface HlsFatal {
  kind: "network" | "media" | "other";
  /** hls.js-Detailname (z. B. "manifestLoadError"), für das Protokoll. */
  details: string;
  /** HTTP-Status einer fehlgeschlagenen Anfrage, falls bekannt. */
  status?: number;
}

export interface HlsHandle {
  destroy(): void;
}

export interface AttachHlsOptions {
  startSec: number;
  /** Fatal = nicht mehr zu retten (nach den Wiederholungen). */
  onFatal(error: HlsFatal): void;
  /** Passt jede Anfrage an (Browser ohne Proxy: ApiKey an Segment-URLs hängen). */
  rewriteUrl?(url: string): string;
}

/** Wie oft Netzwerk- bzw. Medienfehler zuerst wiederholt werden, bevor der Player aufgibt. */
const NETWORK_RETRIES = 3;
const MEDIA_RETRIES = 2;

/** Geduld mit dem Server: lange auf das erste Byte warten, Fehler dagegen schnell und mehrfach wiederholen. */
const LOAD_POLICY = {
  default: {
    maxTimeToFirstByteMs: 60_000,
    maxLoadTimeMs: 180_000,
    timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000 },
    errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000, backoff: "linear" as const },
  },
};

export async function attachHls(video: HTMLVideoElement, url: string, opts: AttachHlsOptions): Promise<HlsHandle> {
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) throw new Error("Dieses Fenster unterstützt keine HLS-Wiedergabe (MediaSource fehlt)");

  const rewrite = opts.rewriteUrl;
  const hls = new Hls({
    startPosition: opts.startSec > 0 ? opts.startSec : -1,
    enableWorker: true,
    // Filme, kein Live-Stream: lieber großzügig vorpuffern als an der Grenze ruckeln. Die Vorgabe von hls.js (30 s, höchstens
    // 60 MB) ist bei hohen Bitraten schon nach etwa 10 s voll; die Obergrenzen sind hier deshalb höher.
    maxBufferLength: 60,
    maxMaxBufferLength: 180,
    maxBufferSize: 240 * 1000 * 1000,
    // Kleine Lücken im Strom (ungenaue Zeitstempel beim Umpacken) überspringen, statt zu warten.
    maxBufferHole: 0.5,
    backBufferLength: 30,
    startFragPrefetch: true,
    // Jellyfin startet ffmpeg erst bei der ersten Anfrage (und nach einem Sprung neu): Das erste Byte kann dauern.
    // Die Vorgaben (hls.js bricht nach wenigen Sekunden ab und wiederholt) lösen sonst unnötige Fehler und Neustarts aus.
    manifestLoadPolicy: LOAD_POLICY,
    playlistLoadPolicy: LOAD_POLICY,
    fragLoadPolicy: LOAD_POLICY,
    ...(rewrite
      ? {
          xhrSetup: (xhr: XMLHttpRequest, requestUrl: string) => {
            const next = rewrite(requestUrl);
            if (next !== requestUrl) xhr.open("GET", next, true);
          },
        }
      : {}),
  });

  let networkTries = 0;
  let mediaTries = 0;
  let retryTimer = 0;
  let destroyed = false;

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (destroyed || !data.fatal) return;
    const status = data.response?.code;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // HTTP-Fehler wie 404 ändern sich durch Wiederholen kaum; kurze Netzausfälle aber schon.
      if (networkTries < NETWORK_RETRIES && !(typeof status === "number" && status >= 400 && status < 500 && status !== 408)) {
        networkTries += 1;
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          if (!destroyed) hls.startLoad();
        }, 700 * networkTries);
        return;
      }
      opts.onFatal({ kind: "network", details: data.details, ...(typeof status === "number" ? { status } : {}) });
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (mediaTries < MEDIA_RETRIES) {
        mediaTries += 1;
        // Beim zweiten Versuch zusätzlich den Tondecoder tauschen (hilft bei manchen Audio-Fehlern).
        if (mediaTries === 2) hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      }
      opts.onFatal({ kind: "media", details: data.details });
    } else {
      opts.onFatal({ kind: "other", details: data.details });
    }
  });

  hls.loadSource(url);
  hls.attachMedia(video);

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(retryTimer);
      try {
        hls.destroy();
      } catch {
        // bewusst ignoriert
      }
    },
  };
}
