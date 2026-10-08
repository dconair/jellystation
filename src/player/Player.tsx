import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { XmbEntry } from "../data/types";
import { getJfContext } from "../jellyfin/context";
import type { JfConfig } from "../jellyfin/context";
import { getEpisodes } from "../jellyfin/items";
import { ConfirmDialog, MessageDialog } from "../ui/popup";
import type { PadAction } from "../input/useGamepad";
import { useOverlayInput } from "../ui/popup";
import type { KeyMap } from "../ui/popup";
import { playSfx } from "../xmb/sound";
import { toggleFullscreen } from "../xmb/fullscreen";
import { isDemoEntry } from "./demoPlan";
import { PlayerEngine } from "./engine";
import type { EngineState, PlayerCloseInfo } from "./engine";
import { formatBitrate, headlineOf, METHOD_LABEL, METHOD_SHORT } from "./format";
import { NextEpisode } from "./NextEpisode";
import { OptionsMenu, qualityLabel } from "./OptionsMenu";
import type { FitMode } from "./OptionsMenu";
import { Busy, CenterFlash, Cues, Osd, VolumeHud } from "./Osd";
import type { HintKey } from "./Osd";
import "./player.css";

export type { PlayerCloseInfo } from "./engine";

export interface PlayerProps {
  /** Der abzuspielende Titel. Mit `entry.jellyfin` wird über den Server gespielt, ohne gilt er als Demo (public/demo). */
  entry: XmbEntry;
  /** Zugangsdaten; für Demo-Einträge nicht nötig. */
  jellyfin?: JfConfig | null;
  /** Startposition in Sekunden. Fehlt sie, beginnt der Titel vorn (das Fortsetzen fragt der Aufrufer ab). */
  startSec?: number;
  /** Folgen derselben Serie in Reihenfolge (für „Nächste Folge“). Fehlt sie bei einer Folge, lädt der Player die Liste selbst. */
  playlist?: XmbEntry[];
  onClose(info: PlayerCloseInfo): void;
}

/** Wie lange das Bedienfeld nach der letzten Eingabe stehen bleibt. */
const OSD_IDLE_MS = 4000;
const VOLUME_MS = 1800;
const NEXT_COUNTDOWN_S = 8;
const VOLUME_STEP = 0.05;
/** Mindestabstand zweier Sprünge beim Gedrückthalten. */
const SEEK_REPEAT_MS = 100;
/** Zeitraum, nach dem Eingaben nicht mehr als Gedrückthalten gelten. */
const SEEK_HOLD_GAP_MS = 700;
/** Nach der letzten Eingabe wird das Spulen übernommen … */
const SEEK_COMMIT_MS = 220;
/** … und die Zielzeit-Blase bleibt noch kurz stehen. */
const SEEK_LINGER_MS = 800;

const noopSubscribe = () => () => undefined;
const EMPTY: EngineState = {
  phase: "idle", entry: null, plan: null, busy: { text: "Lade …" }, buffering: false, seeking: false, paused: true, ended: false,
  time: 0, duration: 0, buffered: 0, rate: 1, volume: 1, muted: false, soundBlocked: false, subtitleIndex: null, cues: [],
  frozen: false, fault: null, problem: null, notice: null, maxBitrate: undefined,
};
const getEmpty = () => EMPTY;

/** Tastatur: ergänzt die Standardbelegung von useOverlayInput (Enter/Leertaste = ✕, Esc = ○, O = △, Pfeile). */
const KEYS: KeyMap = {
  k: "confirm", K: "confirm",
  j: "l1", J: "l1",
  l: "r1", L: "r1",
  PageUp: "l2", p: "l2", P: "l2",
  PageDown: "r2", n: "r2", N: "r2",
};

const sameEpisode = (a: XmbEntry, b: XmbEntry) => a.id === b.id || (!!a.jellyfin && a.jellyfin.id === b.jellyfin?.id);

/**
 * Vollbild-Player im PS3-Stil. Die Wiedergabe-Logik steckt in PlayerEngine, hier sind Eingabe, Bedienfeld und die
 * Dialoge (Optionen, Fehler, Stream-Info, Nächste Folge).
 */
export function Player({ entry, jellyfin = null, startSec = 0, playlist, onClose }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const snapRef = useRef<HTMLCanvasElement>(null);
  const cfgRef = useRef(jellyfin);
  cfgRef.current = jellyfin;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [engine, setEngine] = useState<PlayerEngine | null>(null);
  const st = useSyncExternalStore(engine ? engine.subscribe : noopSubscribe, engine ? engine.getSnapshot : getEmpty);

  // Der Motor gehört zum <video>; React (StrictMode) baut ihn im Dev zweimal auf – der erste wird nie benutzt.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const e = new PlayerEngine(video, { jellyfin: cfgRef.current });
    e.setSnapshotCanvas(snapRef.current);
    setEngine(e);
    return () => {
      e.setSnapshotCanvas(null);
      e.dispose();
    };
  }, []);

  /* ------------------------------------------------------------ Titel / Folgen */

  const [current, setCurrent] = useState<XmbEntry>(entry);
  const startRef = useRef(Math.max(0, startSec));
  useEffect(() => {
    if (!engine) return;
    void engine.open(current, startRef.current);
  }, [engine, current]);

  const demo = isDemoEntry(current);

  // Eine Folge ohne mitgelieferte Liste: die Folgen der Serie selbst laden (für „Nächste Folge“).
  const [fetched, setFetched] = useState<{ seriesId: string; list: XmbEntry[] } | null>(null);
  const seriesId = current.jellyfin?.type === "Episode" ? current.jellyfin.seriesId : undefined;
  useEffect(() => {
    if (playlist || !seriesId || !jellyfin || !jellyfin.url || !jellyfin.apiKey) return;
    if (fetched?.seriesId === seriesId) return;
    const ac = new AbortController();
    void getJfContext(jellyfin, { signal: ac.signal })
      .then((ctx) => getEpisodes(ctx, seriesId, { signal: ac.signal }))
      .then((list) => setFetched({ seriesId, list }))
      .catch(() => undefined); // ohne Liste gibt es eben keine „Nächste Folge“
    return () => ac.abort();
    // jellyfin bewusst nicht als Abhängigkeit: ein neues Objekt mit gleichen Werten soll nicht neu laden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist, seriesId, fetched?.seriesId]);

  const list = playlist ?? (fetched && fetched.seriesId === seriesId ? fetched.list : undefined);
  const at = list ? list.findIndex((e) => sameEpisode(e, current)) : -1;
  const prevEntry = list && at > 0 ? list[at - 1] : null;
  const nextEntry = list && at >= 0 && at + 1 < list.length ? list[at + 1] : null;

  /* ---------------------------------------------------------------- Bedienfeld */

  const [osdOn, setOsdOn] = useState(true);
  const [pinned, setPinned] = useState(false);
  const osdTimer = useRef(0);
  const poke = useCallback(() => {
    setOsdOn(true);
    window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsdOn(false), OSD_IDLE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(osdTimer.current);
  }, [poke]);

  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [fit, setFit] = useState<FitMode>("contain");
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  const dialogOpen = menu || info || !!st.fault || !!st.problem;
  const visible = pinned || osdOn || st.paused || st.ended || dialogOpen || st.phase !== "ready";

  /* ---- Schließen ---- */

  const close = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const done = engine ? await engine.finish() : null;
    onCloseRef.current(done ?? { positionSec: 0, ended: false, entry: current });
  }, [engine, current]);

  /* ---- Spulen ---- */

  const [scrub, setScrub] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const commitTimer = useRef(0);
  const lingerTimer = useRef(0);
  const hold = useRef({ dir: 0, start: 0, last: 0 });
  useEffect(
    () => () => {
      window.clearTimeout(commitTimer.current);
      window.clearTimeout(lingerTimer.current);
    },
    [],
  );

  const durationOf = () => (engine?.getSnapshot().duration ?? 0) || 0;

  /** Ziel vormerken; übernommen wird es kurz nach der letzten Eingabe (nicht bei jeder Wiederholung neu seeken). */
  const scrubTo = (target: number, commitNow = false) => {
    if (!engine) return;
    const dur = durationOf();
    const t = Math.min(Math.max(0, target), dur > 0 ? dur : Infinity);
    pending.current = t;
    setScrub(t);
    window.clearTimeout(lingerTimer.current);
    window.clearTimeout(commitTimer.current);
    const commit = () => {
      const goal = pending.current;
      pending.current = null;
      if (goal !== null) engine.seekTo(goal);
      lingerTimer.current = window.setTimeout(() => setScrub(null), SEEK_LINGER_MS);
    };
    if (commitNow) commit();
    else commitTimer.current = window.setTimeout(commit, SEEK_COMMIT_MS);
  };

  const nudge = (delta: number) => {
    if (!engine || st.phase !== "ready" || st.ended) return;
    scrubTo((pending.current ?? engine.position()) + delta);
  };

  /** ←/→: der erste Druck springt 10 s, gehalten werden die Schritte größer (30 s, dann 60 s). */
  const seekHeld = (dir: 1 | -1) => {
    const now = performance.now();
    const h = hold.current;
    if (h.dir !== dir || now - h.last > SEEK_HOLD_GAP_MS) {
      h.dir = dir;
      h.start = now;
    } else if (now - h.last < SEEK_REPEAT_MS) {
      return;
    }
    h.last = now;
    const held = now - h.start;
    nudge(dir * (held < 1200 ? 10 : held < 3000 ? 30 : 60));
  };

  /* ---- Lautstärke, Anzeige ---- */

  const [volumeOn, setVolumeOn] = useState(false);
  const volumeTimer = useRef(0);
  const lastVolume = useRef<{ v: number; m: boolean } | null>(null);
  useEffect(() => {
    const prev = lastVolume.current;
    lastVolume.current = { v: st.volume, m: st.muted };
    if (!prev || !engine) return;
    if (prev.v === st.volume && prev.m === st.muted) return;
    if (st.soundBlocked) return;
    setVolumeOn(true);
    window.clearTimeout(volumeTimer.current);
    volumeTimer.current = window.setTimeout(() => setVolumeOn(false), VOLUME_MS);
  }, [st.volume, st.muted, st.soundBlocked, engine]);
  useEffect(() => () => window.clearTimeout(volumeTimer.current), []);

  const [flash, setFlash] = useState<{ id: number; kind: "play" | "pause" } | null>(null);
  const flashId = useRef(0);
  const flashTimer = useRef(0);
  const showFlash = (kind: "play" | "pause") => {
    flashId.current += 1;
    setFlash({ id: flashId.current, kind });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 800);
  };
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // Hinweis (Toast) für kleine Meldungen
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastTimer = useRef(0);
  useEffect(() => {
    if (!st.notice) return;
    setToast(st.notice);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }, [st.notice]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /* ---- Pause / Wiedergabe ---- */

  const togglePause = () => {
    if (!engine) return;
    if (st.ended) return engine.restart();
    if (st.phase !== "ready") return;
    showFlash(st.paused ? "play" : "pause");
    engine.togglePause();
  };

  /* ---- Folgen ---- */

  const [countdown, setCountdown] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const nextShown = st.ended && !!nextEntry && !dismissed && !closing;

  const playEntry = useCallback((target: XmbEntry) => {
    startRef.current = 0;
    setDismissed(false);
    setCountdown(null);
    setScrub(null);
    pending.current = null;
    window.clearTimeout(commitTimer.current);
    setCurrent(target);
  }, []);

  useEffect(() => {
    if (!nextShown) {
      setCountdown(null);
      return;
    }
    setCountdown(NEXT_COUNTDOWN_S);
    const id = window.setInterval(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearInterval(id);
  }, [nextShown, nextEntry?.id]);

  useEffect(() => {
    if (nextShown && nextEntry && countdown !== null && countdown <= 0) playEntry(nextEntry);
  }, [countdown, nextShown, nextEntry, playEntry]);

  // Ende ohne Nachfolger: zurück zur Liste (die Wiedergabe ist als gesehen gemeldet).
  useEffect(() => {
    if (!st.ended || nextEntry || !engine || st.fault) return;
    const id = window.setTimeout(() => void close(), 700);
    return () => window.clearTimeout(id);
  }, [st.ended, nextEntry, engine, st.fault, close]);

  /* ---- Eingabe ---- */

  const handle = (action: PadAction | HintKey) => {
    if (closingRef.current) return;
    poke();
    if (engine && st.soundBlocked) engine.unblockSound();
    if (nextShown && nextEntry) {
      if (action === "confirm" || action === "r2") return playEntry(nextEntry);
      if (action === "back") {
        playSfx("back");
        return setDismissed(true);
      }
      if (action !== "up" && action !== "down" && action !== "l2") return;
    }
    switch (action) {
      case "confirm":
        return togglePause();
      case "back":
        playSfx("back");
        return void close();
      case "triangle":
      case "options":
        if (st.phase === "ready" && !st.ended) {
          playSfx("confirm");
          setMenu(true);
        }
        return;
      case "square":
        return setPinned((p) => !p);
      case "left":
        return seekHeld(-1);
      case "right":
        return seekHeld(1);
      case "up":
      case "down": {
        if (!engine) return;
        const base = st.muted ? 0 : st.volume;
        engine.setVolume(Math.round((base + (action === "up" ? VOLUME_STEP : -VOLUME_STEP)) * 100) / 100);
        return;
      }
      case "l1":
        return nudge(-30);
      case "r1":
        return nudge(30);
      case "l2":
        if (prevEntry) {
          playSfx("category");
          playEntry(prevEntry);
        }
        return;
      case "r2":
        if (nextEntry) {
          playSfx("category");
          playEntry(nextEntry);
        }
        return;
      default:
        return;
    }
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (closingRef.current) return true;
    const key = e.key;
    if (/^[0-9]$/.test(key)) {
      poke();
      const dur = durationOf();
      if (engine && dur > 0 && st.phase === "ready" && !e.repeat) scrubTo((Number(key) / 10) * dur, true);
      return true;
    }
    switch (key) {
      case "m":
      case "M":
        poke();
        if (engine && !e.repeat) engine.setMuted(!(st.muted && !st.soundBlocked));
        return true;
      case "f":
      case "F":
      case "F11":
        poke();
        if (!e.repeat) void toggleFullscreen();
        return true;
      case "Home":
        poke();
        if (engine && st.phase === "ready" && !st.ended) scrubTo(0, true);
        return true;
      default:
        // jede andere Taste: Ton nach stummem Start freigeben, Bedienfeld zeigen
        if (engine && st.soundBlocked) engine.unblockSound();
        return false;
    }
  };

  useOverlayInput({
    active: !dialogOpen && !closing,
    keyMap: KEYS,
    onAction: (action) => handle(action),
    onKey,
  });

  /* ---- Maus ---- */

  const lastMouse = useRef({ x: -1, y: -1 });
  const onMouseMove = (e: React.MouseEvent) => {
    const m = lastMouse.current;
    if (Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y) < 3) return;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    poke();
  };
  const onScreenClick = () => {
    poke();
    if (dialogOpen || closing) return;
    if (engine && st.soundBlocked) engine.unblockSound();
    togglePause();
  };

  /* --------------------------------------------------------------- Darstellung */

  const headline = useMemo(() => headlineOf(current, st.plan), [current, st.plan]);
  const retryableFault = st.fault?.retryable === true;
  const busy = st.busy ?? (st.buffering && !st.paused && !st.fault ? { text: "Puffert …" } : null);
  const showBusy = busy !== null;
  const method = st.plan && !demo ? METHOD_SHORT[st.plan.method] : undefined;

  return (
    <div
      className={`player${visible ? "" : " is-idle"}`}
      role="application"
      aria-label={`Videoplayer: ${headline.title}${headline.subtitle ? `, ${headline.subtitle}` : ""}`}
      onMouseMove={onMouseMove}
      onClick={onScreenClick}
      onDoubleClick={() => {
        if (!dialogOpen && !closing) void toggleFullscreen();
      }}
    >
      <canvas ref={snapRef} className={`player-snap player-fit--${fit}${st.frozen ? " is-on" : ""}`} aria-hidden="true" />
      <video
        ref={videoRef}
        className={`player-video player-fit--${fit}`}
        playsInline
        crossOrigin="anonymous"
        preload="auto"
        disablePictureInPicture
        controlsList="nodownload noremoteplayback"
      />

      <Cues lines={st.cues} raised={visible} />

      <Osd
        visible={visible}
        headline={headline}
        paused={st.paused}
        time={st.time}
        duration={st.duration}
        buffered={st.buffered}
        scrub={scrub}
        methodLabel={method ? `${method}${st.plan && st.plan.source.bitrate ? ` · ${formatBitrate(st.plan.source.bitrate)}` : ""}` : undefined}
        onToggle={togglePause}
        onHint={(key) => handle(key)}
        onScrub={(ratio, commit) => {
          poke();
          const dur = durationOf();
          if (dur > 0) scrubTo(ratio * dur, commit);
        }}
      />

      <VolumeHud shown={volumeOn} volume={st.volume} muted={st.muted} />

      {flash && !showBusy && <CenterFlash id={flash.id} kind={flash.kind} />}
      {showBusy && busy && <Busy text={busy.text} sub={busy.sub} />}

      {st.soundBlocked && (
        <div className="player-sound" role="status">
          Ton aus – beliebige Taste
        </div>
      )}
      {toast && (
        <div key={toast.id} className={`player-toast${visible ? " is-raised" : ""}`} role="status">
          {toast.text}
        </div>
      )}

      {nextShown && nextEntry && countdown !== null && (
        <NextEpisode
          entry={nextEntry}
          seconds={countdown}
          total={NEXT_COUNTDOWN_S}
          onNow={() => playEntry(nextEntry)}
          onCancel={() => setDismissed(true)}
        />
      )}

      {closing && <div className="player-closing" aria-hidden="true" />}

      {/* Dialoge: alle in dieser Ebene, damit sie über dem Bild liegen (z-index 40 < 50 gilt nur innerhalb des Players). */}
      {menu && engine && (
        <OptionsMenu
          st={st}
          demo={demo}
          fit={fit}
          onClose={() => setMenu(false)}
          onAudio={(index) => {
            setMenu(false);
            if (index !== st.plan?.audioIndex) void engine.setAudio(index);
          }}
          onSubtitle={(index) => {
            setMenu(false);
            if (index !== st.subtitleIndex) void engine.setSubtitle(index);
          }}
          onQuality={(bps) => {
            setMenu(false);
            if (bps !== st.maxBitrate) void engine.setQuality(bps, qualityLabel(bps));
          }}
          onFit={(f) => {
            setFit(f);
            setMenu(false);
          }}
          onSpeed={(r) => {
            engine.setRate(r);
            setMenu(false);
          }}
          onInfo={() => {
            setMenu(false);
            setInfo(true);
          }}
          onFullscreen={() => {
            setMenu(false);
            void toggleFullscreen();
          }}
        />
      )}

      {info && st.plan && (
        <MessageDialog
          title="Stream-Info"
          kind="info"
          lines={[METHOD_LABEL[st.plan.method], ...(st.plan.reason ? [st.plan.reason] : [])]}
          detail={streamInfoLines(st)}
          detailStart="top"
          onClose={() => setInfo(false)}
        />
      )}

      {st.fault &&
        (retryableFault ? (
          <ConfirmDialog
            title={st.fault.title}
            message={st.fault.lines}
            confirmLabel="Erneut versuchen"
            cancelLabel="Beenden"
            onConfirm={() => engine?.retry()}
            onCancel={() => void close()}
          />
        ) : (
          <MessageDialog title={st.fault.title} kind="error" lines={st.fault.lines} okLabel="Beenden" onClose={() => void close()} />
        ))}

      {st.problem && !st.fault && (
        <MessageDialog title={st.problem.title} kind="error" lines={st.problem.lines} onClose={() => engine?.clearProblem()} />
      )}
    </div>
  );
}

/** Technische Eckdaten für den Stream-Info-Dialog (Monospace-Block). */
function streamInfoLines(st: EngineState): string[] {
  const plan = st.plan;
  if (!plan) return [];
  const s = plan.source;
  const rows: Array<[string, string]> = [
    ["Methode", METHOD_LABEL[plan.method]],
    ["Protokoll", plan.protocol === "hls" ? "HLS (Segmente)" : "Datei (HTTP)"],
    ["Container", s.container ? s.container.toUpperCase() : "–"],
    ["Video", [s.videoCodec, s.width && s.height ? `${s.width}×${s.height}` : ""].filter(Boolean).join(" · ") || "–"],
    ["Audio", s.audioCodec || "–"],
    ["Bitrate", formatBitrate(s.bitrate) || "–"],
    ["Limit", qualityLabel(st.maxBitrate)],
  ];
  if (plan.reason) rows.push(["Grund", plan.reason]);
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width + 2)}${v}`);
}
