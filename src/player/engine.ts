import type { XmbEntry } from "../data/types";
import { getJfContext, mediaUrl } from "../jellyfin/context";
import type { JfConfig, JfContext } from "../jellyfin/context";
import { isAbortError, JfError } from "../jellyfin/errors";
import { planPlayback } from "../jellyfin/playback";
import type { PlanOptions, PlaybackPlan } from "../jellyfin/playback";
import { hlsMode } from "../jellyfin/profile";
import { PlaybackReporter } from "../jellyfin/reporter";
import { isDemoEntry, makeDemoPlan } from "./demoPlan";
import { METHOD_LABEL } from "./format";
import { attachHls } from "./hlsLoader";
import type { HlsFatal, HlsHandle } from "./hlsLoader";
import { langKey, loadPrefs, savePrefs } from "./prefs";

/*
 * Die Wiedergabe-Maschine des Players: alles, was mit <video>, hls.js, Planung und Berichten zu tun hat –
 * ohne React. Die Oberfläche liest nur den Zustand (subscribe/getSnapshot) und ruft die Methoden auf.
 *
 * Aufräumen ist die Hauptsorge: jede asynchrone Arbeit trägt die Nummer ihrer "Generation" (gen); wechselt der
 * Titel, schließt der Player oder startet React (StrictMode) neu, sind alte Ergebnisse wertlos und werden verworfen.
 */

/** Ohne ein Lebenszeichen der Quelle (Metadaten bzw. Daten beim Puffern) gilt die Wiedergabe nach so langer Zeit als gescheitert. */
export const LOAD_TIMEOUT_MS = 20_000;
/** Eine Umwandlung muss der Server erst anwerfen – das dauert beim ersten Segment deutlich länger. */
export const TRANSCODE_TIMEOUT_MS = 45_000;
/** Höchste Wartezeit, die das Beenden auf den Server wartet, damit der Wiedergabestand ankommt. */
const FINISH_WAIT_MS = 2500;
/** Ab diesem Anteil zählt "Beenden" als gesehen. */
export const ENDED_RATIO = 0.95;

export interface PlayerFault {
  title: string;
  lines: string[];
  retryable: boolean;
}

export interface PlayerProblem {
  id: number;
  title: string;
  lines: string[];
}

export interface PlayerNotice {
  id: number;
  text: string;
}

export interface EngineState {
  phase: "idle" | "loading" | "ready";
  entry: XmbEntry | null;
  plan: PlaybackPlan | null;
  /** Ladeanzeige in der Mitte (Text + Zweitzeile), null = keine. */
  busy: { text: string; sub?: string } | null;
  /** Das Video wartet auf Daten (erst nach kurzer Verzögerung gesetzt, damit kurze Aussetzer nicht flackern). */
  buffering: boolean;
  seeking: boolean;
  paused: boolean;
  ended: boolean;
  time: number;
  duration: number;
  /** Ende des gepufferten Bereichs um die Position (Sekunden). */
  buffered: number;
  rate: number;
  volume: number;
  muted: boolean;
  /** Der Start war nur stumm erlaubt (Autoplay-Sperre). */
  soundBlocked: boolean;
  /** Gewählter Untertitel (Stream-Index), null = aus. */
  subtitleIndex: number | null;
  /** Gerade sichtbare Untertitelzeilen (VTT-Text). */
  cues: string[];
  /** Ein Standbild der alten Wiedergabe liegt hinter dem Video (beim Umstellen). */
  frozen: boolean;
  fault: PlayerFault | null;
  problem: PlayerProblem | null;
  notice: PlayerNotice | null;
  /** Gewählte Bitrate-Grenze (Bit/s), undefined = Original. */
  maxBitrate: number | undefined;
}

export interface PlayerCloseInfo {
  positionSec: number;
  ended: boolean;
  entry: XmbEntry;
}

export interface EngineOptions {
  jellyfin?: JfConfig | null;
}

/** Eine Quelle ließ sich nicht laden. `unsupported` = das Format geht hier nicht (dann hilft Umwandeln). */
interface AttachFailure {
  aborted?: boolean;
  fault?: PlayerFault;
  unsupported?: boolean;
}

const isAttachFailure = (e: unknown): e is AttachFailure =>
  !!e && typeof e === "object" && ("aborted" in e || "fault" in e || "unsupported" in e);

/* ----------------------------------------------------------------- Meldungen */

export function faultFromError(err: unknown): PlayerFault {
  if (err instanceof JfError) {
    const titles: Record<string, string> = {
      config: "Jellyfin nicht eingerichtet",
      network: "Server nicht erreichbar",
      timeout: "Keine Antwort vom Server",
      auth: "Anmeldung abgelehnt",
      notfound: "Titel nicht gefunden",
      server: "Der Server meldet einen Fehler",
      protocol: "Unerwartete Antwort des Servers",
      unplayable: "Nicht abspielbar",
    };
    return {
      title: titles[err.kind] ?? "Wiedergabe nicht möglich",
      lines: [err.message],
      retryable: err.kind !== "config" && err.kind !== "unplayable" && err.kind !== "notfound",
    };
  }
  return {
    title: "Wiedergabe nicht möglich",
    lines: [err instanceof Error && err.message ? err.message : "Unbekannter Fehler"],
    retryable: true,
  };
}

function describeSource(plan: PlaybackPlan | null): string {
  if (!plan) return "";
  const s = plan.source;
  const parts = [s.container?.toUpperCase(), s.videoCodec, s.audioCodec].filter(Boolean);
  return parts.length ? `Quelle: ${parts.join(" · ")} (${METHOD_LABEL[plan.method]})` : "";
}

function faultFromMedia(code: number, plan: PlaybackPlan | null): PlayerFault {
  const src = describeSource(plan);
  const extra = src ? [src] : [];
  if (code === 2) {
    return {
      title: "Verbindung unterbrochen",
      lines: ["Die Übertragung vom Server ist abgebrochen.", "Prüfe das Netzwerk und versuche es erneut.", ...extra],
      retryable: true,
    };
  }
  if (code === 3) {
    return { title: "Wiedergabefehler", lines: ["Das Video lässt sich nicht dekodieren.", ...extra], retryable: true };
  }
  return {
    title: "Nicht abspielbar",
    lines: ["Dieses Fenster kann das Format der Quelle nicht wiedergeben.", ...extra],
    retryable: true,
  };
}

function faultFromHls(f: HlsFatal, plan: PlaybackPlan | null): PlayerFault {
  const src = describeSource(plan);
  const extra = src ? [src] : [];
  if (f.kind === "network") {
    if (f.status === 401 || f.status === 403) {
      return { title: "Anmeldung abgelehnt", lines: ["Der Server hat den Stream abgelehnt (API-Key ungültig?).", ...extra], retryable: false };
    }
    if (f.status === 404) {
      return { title: "Stream nicht gefunden", lines: ["Der Server kennt diesen Stream nicht (mehr).", ...extra], retryable: true };
    }
    return {
      title: "Verbindung unterbrochen",
      lines: ["Der Stream konnte nicht geladen werden.", "Prüfe das Netzwerk und versuche es erneut.", ...extra],
      retryable: true,
    };
  }
  if (f.kind === "media") {
    return { title: "Wiedergabefehler", lines: ["Der Stream lässt sich nicht dekodieren.", ...extra], retryable: true };
  }
  return { title: "Wiedergabefehler", lines: [`Der Stream ist fehlgeschlagen (${f.details}).`, ...extra], retryable: true };
}

const timeoutFault = (plan: PlaybackPlan | null, seconds: number): PlayerFault => ({
  title: "Keine Daten vom Server",
  lines: [`Seit ${seconds} Sekunden kommen keine Daten an.`, "Prüfe das Netzwerk und den Server und versuche es erneut.", ...(describeSource(plan) ? [describeSource(plan)] : [])],
  retryable: true,
});

/** Ladeanzeige zu einem Plan: Umwandeln wird als solches benannt, mit dem Grund darunter. */
function busyFor(plan: PlaybackPlan): { text: string; sub?: string } {
  if (plan.method === "Transcode") return { text: "Transkodiert …", ...(plan.reason ? { sub: plan.reason } : {}) };
  return { text: "Lade …", ...(plan.method === "DirectStream" && plan.reason ? { sub: plan.reason } : {}) };
}

/** Wählt den anfänglichen Untertitel: gemerkte Sprache, sonst Vorgabe des Servers (nur Text, nie Einbrennen). */
export function chooseInitialSubtitle(plan: PlaybackPlan): number | null {
  if (plan.burnedSubtitle) return plan.subtitleIndex;
  const prefs = loadPrefs();
  const texts = plan.subtitles.filter((s) => s.textBased && !s.burnIn);
  if (prefs.subtitleLang === "off") return null;
  if (prefs.subtitleLang) {
    const want = prefs.subtitleLang;
    const hit =
      texts.find((s) => langKey(s.language) === want && !s.isForced) ?? texts.find((s) => langKey(s.language) === want);
    if (hit) return hit.index;
  }
  const server = plan.subtitleIndex;
  return server !== null && texts.some((s) => s.index === server) ? server : null;
}

/* -------------------------------------------------------------------- Maschine */

export class PlayerEngine {
  private s: EngineState;
  private readonly listeners = new Set<() => void>();
  private readonly video: HTMLVideoElement;
  private readonly cfg: JfConfig | null;

  private gen = 0;
  private disposed = false;
  private work: AbortController | null = null;
  private ctx: JfContext | null = null;
  private plan: PlaybackPlan | null = null;
  private entry: XmbEntry | null = null;
  private demo = false;
  private reporter: PlaybackReporter | null = null;
  private reporterStarted = false;
  private hls: HlsHandle | null = null;
  private sourceActive = false;
  /** Wird gesetzt, solange attach() auf die Metadaten wartet; Fehlerereignisse laufen dann dorthin. */
  private attachFail: ((f: AttachFailure) => void) | null = null;
  private replanning = false;
  private autoStep = 0;
  private trackEl: HTMLTrackElement | null = null;
  private trackUrl: string | null = null;
  private trackToken = 0;
  private autoMuted = false;
  private problemId = 0;
  private noticeId = 0;
  private bufferTimer = 0;
  private stallTimer = 0;
  private frozenTimer = 0;
  private snapshot: HTMLCanvasElement | null = null;
  private lastPos = 0;
  private pendingStart = 0;

  constructor(video: HTMLVideoElement, opts: EngineOptions = {}) {
    this.video = video;
    this.cfg = opts.jellyfin ?? null;
    const prefs = loadPrefs();
    video.volume = prefs.volume;
    video.muted = prefs.muted;
    this.s = {
      phase: "idle",
      entry: null,
      plan: null,
      busy: null,
      buffering: false,
      seeking: false,
      paused: true,
      ended: false,
      time: 0,
      duration: 0,
      buffered: 0,
      rate: 1,
      volume: prefs.volume,
      muted: prefs.muted,
      soundBlocked: false,
      subtitleIndex: null,
      cues: [],
      frozen: false,
      fault: null,
      problem: null,
      notice: null,
      maxBitrate: prefs.maxBitrate,
    };
    const events = [
      "loadedmetadata", "durationchange", "timeupdate", "progress", "play", "pause", "playing", "waiting", "stalled",
      "canplay", "seeking", "seeked", "ended", "error", "volumechange", "ratechange",
    ] as const;
    for (const name of events) video.addEventListener(name, this.onEvent);
  }

  /* ---------------------------------------------------------------- Zustand */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): EngineState => this.s;

  private emit(patch: Partial<EngineState>) {
    if (this.disposed) return;
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof EngineState>) {
      if (this.s[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.s = { ...this.s, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
  }

  /** Für die Standbild-Fläche hinter dem Video (siehe captureFrame). */
  setSnapshotCanvas(canvas: HTMLCanvasElement | null) {
    this.snapshot = canvas;
  }

  /* ------------------------------------------------------------------ Öffnen */

  /** Lädt einen Titel (ersetzt eine laufende Wiedergabe: die alte Position wird noch gemeldet). */
  async open(entry: XmbEntry, startSec = 0): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.gen;
    this.abortWork();
    // Die Position des bisherigen Titels vor dem Abbau festhalten und im Hintergrund melden.
    const hadReporter = this.reporter !== null;
    if (hadReporter) void this.reportStop(this.s.ended, this.position());
    this.teardownMedia();

    this.entry = entry;
    this.demo = isDemoEntry(entry);
    this.autoStep = 0;
    this.replanning = false;
    this.ctx = null;
    this.plan = null;
    this.pendingStart = Math.max(0, startSec);
    this.lastPos = this.pendingStart;
    const work = new AbortController();
    this.work = work;
    this.emit({
      phase: "loading",
      entry,
      plan: null,
      busy: { text: "Lade …" },
      buffering: false,
      seeking: false,
      paused: true,
      ended: false,
      time: this.pendingStart,
      duration: 0,
      buffered: 0,
      cues: [],
      subtitleIndex: null,
      frozen: false,
      fault: null,
      problem: null,
      notice: null,
      soundBlocked: false,
    });

    try {
      let plan: PlaybackPlan;
      if (this.demo) {
        plan = makeDemoPlan(entry, this.pendingStart);
      } else {
        const ref = entry.jellyfin;
        if (!ref) throw new JfError("Kein Jellyfin-Titel", "protocol");
        if (!this.cfg || !this.cfg.url || !this.cfg.apiKey) {
          throw new JfError("Jellyfin ist nicht eingerichtet – bitte im Setup Adresse und API-Key eintragen", "config");
        }
        this.ctx = await getJfContext(this.cfg, { signal: work.signal });
        if (gen !== this.gen) return;
        plan = await planPlayback(this.ctx, ref.id, {
          startSec: this.pendingStart,
          ...(this.s.maxBitrate ? { maxBitrate: this.s.maxBitrate } : {}),
          signal: work.signal,
        });
      }
      if (gen !== this.gen) return;
      await this.activate(plan, this.pendingStart, gen, { play: true, wanted: chooseInitialSubtitle(plan) });
    } catch (err) {
      if (gen !== this.gen || isAbortError(err)) return;
      await this.handleOpenFailure(err, gen);
    }
  }

  /** Nach einem Fehler beim Öffnen: Format nicht unterstützt → einmal automatisch umwandeln, sonst Fehlerdialog. */
  private async handleOpenFailure(err: unknown, gen: number): Promise<void> {
    if (isAttachFailure(err)) {
      if (err.aborted) return;
      if (err.unsupported && (await this.autoFallback(gen, this.pendingStart))) return;
      this.fail(err.fault ?? faultFromMedia(4, this.plan));
      return;
    }
    this.fail(faultFromError(err));
  }

  /**
   * Die Quelle ist hier nicht abspielbar: einmal mit forceTranscode neu planen (alles per HLS); ging die Umwandlung
   * nur als Umpacken durch (Bild wird kopiert) und scheitert ebenfalls, ein zweites Mal mit neu berechnetem Bild.
   * true = eine neue Wiedergabe läuft.
   */
  private async autoFallback(gen: number, pos: number): Promise<boolean> {
    const plan = this.plan;
    if (!plan || this.demo || this.autoStep >= 2) return false;
    if (this.autoStep === 1 && plan.method !== "DirectStream") return false;
    const reencode = this.autoStep === 1;
    this.autoStep += 1;
    const work = new AbortController();
    this.abortWork();
    this.work = work;
    this.teardownMedia();
    this.emit({ busy: { text: "Transkodiert …", sub: "Das Format wird hier nicht direkt abgespielt" }, fault: null });
    try {
      const next = await plan.replan({ forceTranscode: true, reencode, startSec: pos, signal: work.signal });
      if (gen !== this.gen) return true;
      await this.activate(next, pos, gen, { play: true, wanted: this.s.subtitleIndex });
      return true;
    } catch (err) {
      if (gen !== this.gen || isAbortError(err)) return true;
      if (isAttachFailure(err) && err.aborted) return true;
      if (isAttachFailure(err) && err.unsupported) return this.autoFallback(gen, pos);
      this.fail(isAttachFailure(err) && err.fault ? err.fault : faultFromError(err));
      return true;
    }
  }

  /** Lädt die Quelle, verdrahtet Berichte und Untertitel und startet (oder hält an). Wirft AttachFailure/JfError. */
  private async activate(
    plan: PlaybackPlan,
    startSec: number,
    gen: number,
    o: { play: boolean; wanted: number | null; busy?: { text: string; sub?: string } },
  ): Promise<void> {
    this.plan = plan;
    const dur = plan.durationSec;
    this.emit({ plan, busy: o.busy ?? busyFor(plan), duration: dur > 0 ? dur : this.s.duration });
    const clamped = dur > 2 ? Math.min(startSec, dur - 2) : startSec;
    await this.attach(plan, clamped, gen);
    if (gen !== this.gen) throw { aborted: true } satisfies AttachFailure;

    if (!this.demo && this.ctx) {
      if (!this.reporter) {
        this.reporter = new PlaybackReporter(this.ctx, plan);
        this.reporterStarted = false;
      } else {
        this.reporter.replacePlan(plan);
      }
    }
    this.applySubtitle(plan, o.wanted);
    this.video.playbackRate = this.s.rate;
    this.emit({ phase: "ready", time: this.video.currentTime || clamped });
    if (o.play) {
      await this.playNow(gen);
    } else {
      this.video.pause();
      this.emit({ busy: null, paused: true });
      this.releaseFrozenSoon();
    }
  }

  /* ------------------------------------------------------------------ Quelle */

  private detachSource() {
    this.sourceActive = false;
    window.clearTimeout(this.bufferTimer);
    window.clearTimeout(this.stallTimer);
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const v = this.video;
    try {
      v.pause();
    } catch {
      // bewusst ignoriert
    }
    v.removeAttribute("src");
    try {
      v.load();
    } catch {
      // bewusst ignoriert
    }
  }

  /** Alles abbauen, was zur Wiedergabe gehört (Quelle, Untertitelspur, Zeitgeber); der Zustand bleibt. */
  private teardownMedia() {
    this.attachFail?.({ aborted: true });
    this.attachFail = null;
    this.clearTrack();
    this.detachSource();
  }

  private abortWork() {
    this.work?.abort();
    this.work = null;
  }

  /**
   * Setzt die Quelle und wartet auf die Metadaten (dann ist Seeken möglich). Fehler: AttachFailure.
   * Der Zeitgeber meldet "keine Daten", wenn nichts ankommt.
   */
  private attach(plan: PlaybackPlan, startSec: number, gen: number): Promise<void> {
    this.teardownMedia();
    const v = this.video;
    const limit = plan.method === "Transcode" ? TRANSCODE_TIMEOUT_MS : LOAD_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let timer = 0;
      const finish = (failure?: AttachFailure) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        v.removeEventListener("loadedmetadata", onMeta);
        if (this.attachFail === finish) this.attachFail = null;
        if (failure) reject(failure);
        else resolve();
      };
      const onMeta = () => {
        if (gen !== this.gen) return finish({ aborted: true });
        // hls.js startet selbst an startPosition; bei allem anderen springen wir jetzt dorthin.
        if (startSec > 0 && !this.hls) {
          try {
            v.currentTime = startSec;
          } catch {
            // bewusst ignoriert: dann beginnt es eben vorn
          }
        }
        finish();
      };
      this.attachFail = finish;
      v.addEventListener("loadedmetadata", onMeta);
      timer = window.setTimeout(() => finish({ fault: timeoutFault(plan, Math.round(limit / 1000)) }), limit);

      this.sourceActive = true;
      if (plan.protocol === "hls") {
        const mode = hlsMode();
        if (mode === "native") {
          v.src = plan.url;
        } else if (mode === "mse") {
          const ctx = this.ctx;
          void attachHls(v, plan.url, {
            startSec,
            rewriteUrl: ctx && !ctx.viaProxy ? (u) => mediaUrl(ctx, u) : undefined,
            onFatal: (f) => {
              if (gen !== this.gen) return;
              if (this.attachFail) this.attachFail({ fault: faultFromHls(f, plan) });
              else this.fail(faultFromHls(f, plan));
            },
          }).then(
            (handle) => {
              if (done || gen !== this.gen || !this.sourceActive) handle.destroy();
              else this.hls = handle;
            },
            (e: unknown) => finish({ fault: { title: "HLS nicht verfügbar", lines: [e instanceof Error ? e.message : "hls.js konnte nicht geladen werden"], retryable: false } }),
          );
        } else {
          finish({
            fault: {
              title: "Nicht abspielbar",
              lines: ["Dieses Fenster kann keine HLS-Streams abspielen (weder nativ noch über MediaSource)."],
              retryable: false,
            },
          });
        }
      } else {
        v.src = plan.url;
      }
    });
  }

  private async playNow(gen: number): Promise<void> {
    const v = this.video;
    try {
      await v.play();
    } catch (err) {
      if (gen !== this.gen || this.disposed) return;
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError") {
        // Autoplay mit Ton ist gesperrt (WKWebView ohne Nutzeraktion): stumm starten und den Hinweis zeigen.
        v.muted = true;
        this.autoMuted = true;
        this.emit({ soundBlocked: true, muted: true });
        try {
          await v.play();
        } catch {
          // bleibt pausiert; der Nutzer startet mit ✕
        }
      }
    }
    if (gen !== this.gen || this.disposed) return;
    // play() ist erfüllt = es läuft (oder blieb nach einer Sperre pausiert): die Ladeanzeige hat ihren Zweck erfüllt.
    this.emit({ busy: null, ...(v.paused ? { paused: true } : {}) });
  }

  /** Ton nach einem stummen Autoplay-Start wieder einschalten (jede Eingabe löst es aus). */
  unblockSound() {
    if (!this.autoMuted) return;
    this.autoMuted = false;
    const prefs = loadPrefs();
    this.video.muted = prefs.muted;
    this.emit({ soundBlocked: false, muted: prefs.muted });
  }

  /* ---------------------------------------------------------------- Ereignisse */

  private readonly onEvent = (e: Event) => {
    if (this.disposed) return;
    const v = this.video;
    switch (e.type) {
      case "loadedmetadata":
      case "durationchange": {
        const d = this.plan && this.plan.durationSec > 0 ? this.plan.durationSec : Number.isFinite(v.duration) ? v.duration : 0;
        this.emit({ duration: d });
        return;
      }
      case "timeupdate": {
        if (!this.sourceActive) return;
        window.clearTimeout(this.stallTimer);
        this.lastPos = v.currentTime;
        this.emit({ time: v.currentTime, buffered: this.bufferedEnd() });
        if (this.reporterStarted && !v.seeking) this.reporter?.progress(v.currentTime, v.paused);
        return;
      }
      case "progress":
        this.emit({ buffered: this.bufferedEnd() });
        return;
      case "play":
        this.emit({ paused: false });
        return;
      case "pause":
        if (!this.sourceActive) return;
        this.emit({ paused: true });
        if (this.reporterStarted && !v.ended) this.reporter?.progress(v.currentTime, true);
        return;
      case "playing": {
        window.clearTimeout(this.bufferTimer);
        window.clearTimeout(this.stallTimer);
        this.emit({ paused: false, buffering: false, busy: null, ended: false });
        this.releaseFrozenSoon(0);
        if (this.reporter && !this.reporterStarted) {
          this.reporterStarted = true;
          void this.reporter.start(v.currentTime);
        }
        return;
      }
      case "waiting":
      case "stalled": {
        if (!this.sourceActive || this.attachFail) return;
        window.clearTimeout(this.bufferTimer);
        this.bufferTimer = window.setTimeout(() => this.emit({ buffering: true }), 300);
        this.armStall();
        return;
      }
      case "canplay":
        window.clearTimeout(this.bufferTimer);
        window.clearTimeout(this.stallTimer);
        this.emit({ buffering: false });
        return;
      case "seeking":
        if (!this.sourceActive) return;
        this.emit({ seeking: true, ended: false });
        this.armStall();
        return;
      case "seeked":
        window.clearTimeout(this.stallTimer);
        this.emit({ seeking: false, time: v.currentTime, buffering: false });
        if (this.reporterStarted) this.reporter?.progress(v.currentTime, v.paused);
        this.releaseFrozenSoon(0);
        return;
      case "ended":
        if (!this.sourceActive) return;
        this.emit({ ended: true, paused: true, buffering: false, time: v.currentTime });
        // Bis zum Ende gelaufen = gesehen: gleich melden, auch wenn der Nutzer noch vor dem Bild sitzt.
        void this.reportStop(true, v.currentTime);
        return;
      case "volumechange":
        this.emit({ volume: v.volume, muted: v.muted });
        return;
      case "ratechange":
        this.emit({ rate: v.playbackRate });
        return;
      case "error":
        this.onVideoError();
        return;
      default:
        return;
    }
  };

  private bufferedEnd(): number {
    const v = this.video;
    const r = v.buffered;
    const t = v.currentTime;
    for (let i = 0; i < r.length; i++) {
      if (t >= r.start(i) - 0.3 && t <= r.end(i) + 0.3) return r.end(i);
    }
    return t;
  }

  /** Beim Puffern/Spulen: kommen 20 s lang keine Daten, scheitert die Wiedergabe mit einer klaren Meldung. */
  private armStall() {
    window.clearTimeout(this.stallTimer);
    const gen = this.gen;
    this.stallTimer = window.setTimeout(() => {
      if (gen !== this.gen || this.disposed || !this.sourceActive) return;
      this.fail(timeoutFault(this.plan, Math.round(LOAD_TIMEOUT_MS / 1000)));
    }, LOAD_TIMEOUT_MS);
  }

  private onVideoError() {
    // Leeren der Quelle (removeAttribute + load) löst selbst einen Fehler aus: nur echte Quellen zählen.
    if (!this.sourceActive) return;
    const code = this.video.error?.code ?? 0;
    if (code === 1) return; // MEDIA_ERR_ABORTED: von uns ausgelöst
    const unsupported = code === 3 || code === 4;
    if (this.attachFail) {
      this.attachFail({ fault: faultFromMedia(code, this.plan), unsupported });
      return;
    }
    // hls.js meldet seine Fehler selbst (und versucht, sie zu beheben).
    if (this.hls) return;
    const gen = this.gen;
    const pos = this.video.currentTime || this.lastPos;
    if (unsupported) {
      void this.autoFallback(gen, pos).then((handled) => {
        if (!handled && gen === this.gen) this.fail(faultFromMedia(code, this.plan));
      });
      return;
    }
    this.fail(faultFromMedia(code, this.plan));
  }

  /** Zeigt den Fehlerdialog; die Wiedergabe wird angehalten. */
  private fail(fault: PlayerFault) {
    if (this.disposed) return;
    window.clearTimeout(this.bufferTimer);
    window.clearTimeout(this.stallTimer);
    try {
      this.video.pause();
    } catch {
      // bewusst ignoriert
    }
    this.emit({ fault, busy: null, buffering: false, seeking: false, frozen: false, phase: this.s.phase === "idle" ? "loading" : this.s.phase });
  }

  /** "Erneut versuchen": derselbe Titel, an der letzten Stelle. */
  retry() {
    const entry = this.entry;
    if (!entry) return;
    const pos = this.s.ended ? 0 : this.position();
    void this.open(entry, pos);
  }

  /** Von vorn (nach dem Ende). */
  restart() {
    const entry = this.entry;
    if (entry) void this.open(entry, 0);
  }

  /* --------------------------------------------------------------- Steuerung */

  /** Aktuelle Position (nach dem Abbau der Quelle: die letzte bekannte). */
  position(): number {
    return this.sourceActive ? this.video.currentTime || 0 : this.lastPos;
  }

  togglePause() {
    const v = this.video;
    if (!this.sourceActive || this.s.fault) return;
    if (this.s.ended) return this.restart();
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }

  seekTo(sec: number) {
    const v = this.video;
    if (!this.sourceActive || this.attachFail) return;
    const dur = this.s.duration > 0 ? this.s.duration : Number.isFinite(v.duration) ? v.duration : 0;
    const t = Math.min(Math.max(0, sec), dur > 0 ? Math.max(0, dur - 0.1) : Infinity);
    try {
      v.currentTime = t;
    } catch {
      return;
    }
    this.lastPos = t;
    this.emit({ time: t });
  }

  setVolume(volume: number) {
    const v = Math.min(1, Math.max(0, volume));
    this.video.volume = v;
    // Lauter drehen hebt die Stummschaltung auf (wie am Fernseher).
    if (v > 0 && this.video.muted) this.video.muted = false;
    this.autoMuted = false;
    savePrefs({ volume: v, muted: this.video.muted });
    this.emit({ volume: v, muted: this.video.muted, soundBlocked: false });
  }

  setMuted(muted: boolean) {
    this.video.muted = muted;
    this.autoMuted = false;
    savePrefs({ muted });
    this.emit({ muted, soundBlocked: false });
  }

  setRate(rate: number) {
    this.video.playbackRate = rate;
    this.emit({ rate });
  }

  /* --------------------------------------------------------------- Umstellen */

  /**
   * Neue Planung mit geänderten Wünschen (Tonspur, Einbrennen, Bitrate). Position und Pausenzustand bleiben;
   * scheitert es, läuft die bisherige Wiedergabe weiter und ein Meldungsdialog erklärt es. true = umgestellt.
   */
  async replan(patch: Partial<PlanOptions>, what: string): Promise<boolean> {
    const plan = this.plan;
    if (!plan || this.demo || this.replanning || this.disposed || this.attachFail) return false;
    const gen = this.gen;
    const v = this.video;
    const pos = this.position();
    const wasPlaying = !v.paused && !v.ended;
    const wanted = patch.subtitleIndex !== undefined ? patch.subtitleIndex : this.s.subtitleIndex;
    const work = new AbortController();
    this.work = work;
    this.replanning = true;
    this.emit({ busy: { text: "Wird umgestellt …", sub: what } });
    try {
      let next: PlaybackPlan;
      try {
        next = await plan.replan({ ...patch, startSec: pos, signal: work.signal });
      } catch (err) {
        if (gen !== this.gen || isAbortError(err)) return false;
        this.emit({ busy: null });
        this.report("Umstellen nicht möglich", [faultFromError(err).lines[0], "Die bisherige Wiedergabe läuft weiter."]);
        return false;
      }
      if (gen !== this.gen) return false;
      this.captureFrame();
      try {
        await this.activate(next, pos, gen, { play: wasPlaying, wanted, busy: { text: "Wird umgestellt …", sub: what } });
        return true;
      } catch (err) {
        if (gen !== this.gen || (isAttachFailure(err) && err.aborted)) return false;
        const reason = isAttachFailure(err) && err.fault ? err.fault.lines[0] : "Die neue Wiedergabe ließ sich nicht starten";
        try {
          await this.activate(plan, pos, gen, { play: wasPlaying, wanted: this.s.subtitleIndex, busy: { text: "Wird umgestellt …" } });
          this.report("Umstellen nicht möglich", [reason, "Die bisherige Wiedergabe läuft weiter."]);
        } catch (err2) {
          if (gen !== this.gen || (isAttachFailure(err2) && err2.aborted)) return false;
          this.fail(isAttachFailure(err2) && err2.fault ? err2.fault : faultFromError(err2));
        }
        return false;
      }
    } finally {
      this.replanning = false;
    }
  }

  setAudio(index: number): Promise<boolean> {
    const t = this.plan?.audio.find((a) => a.index === index);
    return this.replan({ audioIndex: index }, t ? `Tonspur: ${t.label}` : "Tonspur");
  }

  async setQuality(bps: number | undefined, label: string): Promise<boolean> {
    const ok = await this.replan({ maxBitrate: bps }, `Qualität: ${label}`);
    if (ok) {
      savePrefs({ maxBitrate: bps });
      this.emit({ maxBitrate: bps });
    }
    return ok;
  }

  /** Untertitel wechseln: Text lädt als Spur, Bild-Untertitel (oder ein schon eingebrannter Wechsel) planen neu. */
  async setSubtitle(index: number | null): Promise<boolean> {
    const plan = this.plan;
    if (!plan) return false;
    const track = index === null ? undefined : plan.subtitles.find((s) => s.index === index);
    if (index !== null && !track) return false;
    const lang = track ? langKey(track.language) : "";
    if (index === null || (track && !track.burnIn)) {
      if (plan.burnedSubtitle) {
        // Der eingebrannte Untertitel steckt im Bild: nur eine neue Planung wird ihn los.
        const ok = await this.replan({ subtitleIndex: index }, index === null ? "Untertitel aus" : `Untertitel: ${track?.label ?? ""}`);
        if (ok) savePrefs({ subtitleLang: index === null ? "off" : lang || undefined });
        return ok;
      }
      this.applySubtitle(plan, index);
      savePrefs({ subtitleLang: index === null ? "off" : lang || undefined });
      return true;
    }
    const ok = await this.replan({ subtitleIndex: index }, `Untertitel: ${track?.label ?? ""} (wird eingebrannt)`);
    if (ok) savePrefs({ subtitleLang: lang || undefined });
    return ok;
  }

  /* ------------------------------------------------------------------ Untertitel */

  private applySubtitle(plan: PlaybackPlan, wanted: number | null) {
    if (plan.burnedSubtitle) {
      this.clearTrack();
      this.emit({ subtitleIndex: plan.subtitleIndex, cues: [] });
      return;
    }
    const track = wanted === null ? undefined : plan.subtitles.find((s) => s.index === wanted && s.textBased && !s.burnIn);
    if (!track) {
      this.clearTrack();
      this.emit({ subtitleIndex: null, cues: [] });
      return;
    }
    void this.loadTrack(plan, track.index);
  }

  private clearTrack() {
    this.trackToken += 1;
    if (this.trackEl) {
      this.trackEl.track.removeEventListener("cuechange", this.onCue);
      try {
        this.trackEl.track.mode = "disabled";
      } catch {
        // bewusst ignoriert
      }
      this.trackEl.remove();
      this.trackEl = null;
    }
    if (this.trackUrl) {
      URL.revokeObjectURL(this.trackUrl);
      this.trackUrl = null;
    }
  }

  private readonly onCue = () => {
    const cues = this.trackEl?.track.activeCues;
    const lines: string[] = [];
    if (cues) for (let i = 0; i < cues.length; i++) lines.push((cues[i] as VTTCue).text);
    this.emit({ cues: lines });
  };

  private async loadTrack(plan: PlaybackPlan, index: number) {
    this.clearTrack();
    const token = this.trackToken;
    const info = plan.subtitles.find((s) => s.index === index);
    this.emit({ subtitleIndex: index, cues: [] });
    let src: string;
    try {
      // Mit der Anmeldung der App holen (in Tauri über Rust, kein CORS-Problem) und als Blob an die Spur geben.
      const text = await plan.fetchSubtitle(index);
      if (token !== this.trackToken || this.disposed) return;
      this.trackUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      src = this.trackUrl;
    } catch {
      if (token !== this.trackToken || this.disposed) return;
      src = plan.subtitleUrl(index);
    }
    const el = document.createElement("track");
    el.kind = "subtitles";
    el.label = info?.label ?? "Untertitel";
    if (info?.language) el.srclang = info.language.slice(0, 3);
    el.src = src;
    el.addEventListener("error", () => {
      if (token !== this.trackToken) return;
      this.emit({ subtitleIndex: null });
      this.notify("Untertitel konnten nicht geladen werden");
    });
    this.video.appendChild(el);
    el.track.mode = "hidden";
    el.track.addEventListener("cuechange", this.onCue);
    this.trackEl = el;
  }

  /* ------------------------------------------------------------------ Hilfen */

  /** Standbild der laufenden Wiedergabe in die Fläche hinter dem Video (Umstellen: das Bild bleibt stehen). */
  private captureFrame() {
    const c = this.snapshot;
    const v = this.video;
    if (!c || v.videoWidth === 0 || v.readyState < 2) return;
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      window.clearTimeout(this.frozenTimer);
      this.emit({ frozen: true });
    } catch {
      // Ein "verschmutzter" Canvas (ohne CORS) kann nicht gezeichnet werden: dann eben ohne Standbild.
    }
  }

  private releaseFrozenSoon(ms = 1500) {
    window.clearTimeout(this.frozenTimer);
    if (!this.s.frozen) return;
    if (ms === 0) this.emit({ frozen: false });
    else this.frozenTimer = window.setTimeout(() => this.emit({ frozen: false }), ms);
  }

  private report(title: string, lines: string[]) {
    this.emit({ problem: { id: ++this.problemId, title, lines } });
  }

  clearProblem() {
    this.emit({ problem: null });
  }

  /** Kurze Einblendung am unteren Rand. */
  notify(text: string) {
    this.emit({ notice: { id: ++this.noticeId, text } });
  }

  /** Meldet das Ende des Titels an den Server (Position bzw. gesehen) und gibt die Reporter-Referenz frei. */
  private reportStop(ended: boolean, pos: number): Promise<void> {
    const reporter = this.reporter;
    if (!reporter) return Promise.resolve();
    this.reporter = null;
    const started = this.reporterStarted;
    this.reporterStarted = false;
    const plan = this.plan;
    const dur = this.s.duration || plan?.durationSec || 0;
    // Nie gestartet (abgebrochen vor dem ersten Bild): den bisherigen Stand nicht überschreiben, nur aufräumen.
    const at = started ? (ended && dur > 0 ? dur : pos) : (plan?.resumeSec ?? 0);
    return reporter.stop(at, started && ended).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Beenden durch den Nutzer: Position melden (wartet höchstens kurz auf den Server), Wiedergabe sofort verstummen
   * lassen. Gibt zurück, was der Aufrufer für seine Liste braucht.
   */
  async finish(): Promise<PlayerCloseInfo | null> {
    const entry = this.entry;
    if (!entry) return null;
    const dur = this.s.duration || this.plan?.durationSec || 0;
    const pos = this.position();
    const ended = this.s.ended || (dur > 0 && pos / dur >= ENDED_RATIO);
    this.gen += 1; // alle laufende Arbeit ist hinfällig
    this.abortWork();
    const stop = this.reportStop(ended, pos);
    this.teardownMedia();
    this.emit({ busy: null, buffering: false, fault: null });
    await Promise.race([stop, new Promise<void>((r) => window.setTimeout(r, FINISH_WAIT_MS))]);
    return { positionSec: ended && dur > 0 ? dur : pos, ended, entry };
  }

  /** Alles beenden (Unmount). Meldet – falls noch nicht geschehen – den Stand im Hintergrund. */
  dispose() {
    if (this.disposed) return;
    const pos = this.position();
    const ended = this.s.ended;
    this.gen += 1;
    this.abortWork();
    void this.reportStop(ended, pos);
    this.teardownMedia();
    window.clearTimeout(this.frozenTimer);
    this.disposed = true;
    const v = this.video;
    for (const name of [
      "loadedmetadata", "durationchange", "timeupdate", "progress", "play", "pause", "playing", "waiting", "stalled",
      "canplay", "seeking", "seeked", "ended", "error", "volumechange", "ratechange",
    ]) {
      v.removeEventListener(name, this.onEvent);
    }
    this.listeners.clear();
  }
}
