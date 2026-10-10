/**
 * Atmosphärische Hintergrundmusik, erzeugt mit WebAudio (keine Audiodateien, kein Urheberrecht):
 * langsam wandernde, weiche Klangflächen über einer Akkordfolge, ein tiefer Grundton und seltene, glockige Töne mit viel Hall –
 * in der Art der ruhigen PS4-Startseite. Vier Stimmungen (siehe moods.ts).
 *
 * Aufbau: Jede Stimmung ist eine `Layer` (eigene Knoten, eigener Zufallsgenerator). Beim Wechsel blendet die alte aus und die neue
 * ein. `scheduleUntil(t)` plant alle Töne bis zur Audio-Zeit t im Voraus – die Laufzeit ruft es einmal pro Sekunde auf, der
 * Offline-Test (renderMood) einmal für die ganze Länge.
 */
import { DEFAULT_MOOD } from "./moods";
import type { MoodId } from "./moods";

interface MoodDef {
  /** MIDI-Noten je Akkord. */
  chords: number[][];
  chordSec: number;
  /** Grenzfrequenz der Klangfläche (Hz) und Tiefe der langsamen Bewegung. */
  cutoff: number;
  lfoDepth: number;
  /** Töne für die Glocken (MIDI) und mittlerer Abstand (s). */
  bells: number[];
  bellEvery: number;
  bellGain: number;
  padGain: number;
  droneGain: number;
  seed: number;
}

const MOODS: Record<MoodId, MoodDef> = {
  // Warm, Dur-lastig: Cmaj9 – Am9 – Fmaj9 – Gsus
  sanft: {
    chords: [[48, 55, 59, 64, 71], [45, 52, 59, 64, 72], [41, 48, 57, 64, 69], [43, 50, 57, 62, 69]],
    chordSec: 16, cutoff: 1100, lfoDepth: 260, bells: [72, 74, 76, 79, 81, 84], bellEvery: 6, bellGain: 0.05, padGain: 0.05, droneGain: 0.07, seed: 11,
  },
  // Tief und dunkel, kaum Glocken: Dm9 – Bbmaj7 – Gm9 – Asus
  tiefsee: {
    chords: [[38, 45, 53, 57, 64], [34, 41, 50, 57, 62], [31, 38, 46, 53, 60], [33, 40, 45, 52, 59]],
    chordSec: 20, cutoff: 650, lfoDepth: 160, bells: [62, 65, 69, 72], bellEvery: 11, bellGain: 0.04, padGain: 0.055, droneGain: 0.1, seed: 23,
  },
  // Schwebend, Moll/sus, leise Funken: Am(add9) – Fmaj7#11 – Em7 – Dsus2
  nacht: {
    chords: [[45, 52, 57, 59, 64], [41, 48, 55, 57, 64], [40, 47, 55, 59, 62], [38, 45, 52, 57, 64]],
    chordSec: 14, cutoff: 850, lfoDepth: 220, bells: [76, 79, 81, 83, 88], bellEvery: 4.5, bellGain: 0.04, padGain: 0.048, droneGain: 0.08, seed: 37,
  },
  // Hell und offen (lydisch): Dmaj9 – Gmaj7#11 – Bm11 – Aadd9
  morgen: {
    chords: [[50, 57, 61, 66, 73], [43, 50, 59, 66, 74], [47, 54, 61, 66, 69], [45, 52, 61, 64, 69]],
    chordSec: 12, cutoff: 1500, lfoDepth: 340, bells: [74, 76, 78, 81, 83, 86], bellEvery: 4, bellGain: 0.055, padGain: 0.045, droneGain: 0.05, seed: 41,
  },
};

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Kleiner, deterministischer Zufallsgenerator (mulberry32): gleiche Stimmung klingt in jedem Test gleich. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hall: gefiltertes, abklingendes Rauschen. */
export function makeReverbIR(ctx: BaseAudioContext, seconds = 4.5, decay = 2.6): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  const r = rng(99);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const env = (1 - i / len) ** decay;
      lp += 0.35 * ((r() * 2 - 1) - lp); // dunkler werdender Hall
      d[i] = lp * env;
    }
  }
  return buf;
}

class Layer {
  readonly out: GainNode;
  private pad: GainNode;
  private lfo: OscillatorNode;
  private readonly def: MoodDef;
  private readonly rand: () => number;
  private chordAt: number;
  private chordIdx = 0;
  private bellAt: number;
  private disposed = false;
  private stopAt = Infinity;

  constructor(private ctx: BaseAudioContext, dest: AudioNode, mood: MoodId, startAt: number, fadeIn: number, private bellBus: AudioNode) {
    this.def = MOODS[mood] ?? MOODS[DEFAULT_MOOD];
    this.rand = rng(this.def.seed);
    this.chordAt = startAt;
    this.bellAt = startAt + 4 + this.rand() * 3;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, startAt);
    this.out.gain.linearRampToValueAtTime(1, startAt + fadeIn);
    this.out.connect(dest);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = this.def.cutoff;
    filter.Q.value = 0.5;
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.06 + this.rand() * 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = this.def.lfoDepth;
    this.lfo.connect(lfoGain).connect(filter.frequency);
    this.lfo.start(startAt);
    this.pad = ctx.createGain();
    this.pad.gain.value = 1;
    this.pad.connect(filter).connect(this.out);
  }

  /** Plant alle Töne, die vor der Audio-Zeit `t` beginnen. */
  scheduleUntil(t: number) {
    if (this.disposed) return;
    while (this.chordAt < t && this.chordAt < this.stopAt) {
      this.chord(this.chordAt, this.def.chords[this.chordIdx % this.def.chords.length]);
      this.chordIdx++;
      this.chordAt += this.def.chordSec;
    }
    while (this.bellAt < t && this.bellAt < this.stopAt) {
      this.bell(this.bellAt);
      this.bellAt += this.def.bellEvery * (0.5 + this.rand());
    }
  }

  private chord(t0: number, notes: number[]) {
    const { ctx } = this;
    const dur = this.def.chordSec;
    const attack = Math.min(4, dur * 0.3);
    const release = 5;
    notes.forEach((m, i) => {
      // Der tiefste Ton ist ein Sinus-Grundton (warm, trägt), die anderen sind leicht verstimmte Sägezähne.
      const low = i === 0;
      const g = ctx.createGain();
      const level = low ? this.def.droneGain : this.def.padGain * (0.8 + this.rand() * 0.4);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(level, t0 + attack);
      g.gain.setValueAtTime(level, t0 + dur);
      g.gain.linearRampToValueAtTime(0, t0 + dur + release);
      g.connect(low ? this.out : this.pad);
      const detunes = low ? [0] : [-7, 7];
      for (const cents of detunes) {
        const o = ctx.createOscillator();
        o.type = low ? "sine" : "sawtooth";
        o.frequency.value = midiHz(low ? m - 12 : m);
        o.detune.value = cents + (this.rand() - 0.5) * 3;
        o.connect(g);
        o.start(t0);
        o.stop(t0 + dur + release + 0.2);
      }
    });
  }

  private bell(t0: number) {
    const { ctx } = this;
    const m = this.def.bells[Math.floor(this.rand() * this.def.bells.length)];
    const f = midiHz(m);
    const g = ctx.createGain();
    const peak = this.def.bellGain * (0.6 + this.rand() * 0.6);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.5);
    g.connect(this.out);
    g.connect(this.bellBus);
    // Grundton + ein unharmonischer Oberton: klingt glockig statt nach Orgel.
    for (const [ratio, amp] of [[1, 1], [2.76, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * ratio;
      const a = ctx.createGain();
      a.gain.value = amp;
      o.connect(a).connect(g);
      o.start(t0);
      o.stop(t0 + 4.6);
    }
  }

  /** Blendet aus; danach plant die Ebene nichts mehr. */
  fadeOut(now: number, dur: number) {
    this.stopAt = now;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + dur);
  }

  dispose(at: number) {
    this.disposed = true;
    try {
      this.lfo.stop(at);
    } catch {
      /* war schon gestoppt */
    }
    window.setTimeout?.(() => this.out.disconnect(), 100);
  }
}

export interface AmbientGraph {
  /** Stimmung starten oder wechseln (Überblendung). */
  setMood(mood: MoodId, fadeIn?: number): void;
  /** Plant die Töne bis zur Audio-Zeit `t`. */
  scheduleUntil(t: number): void;
  /** Gesamtlautstärke 0..1 (wird auf einen angenehm leisen Pegel abgebildet). */
  setVolume(v: number): void;
  /** Weiches Aus-/Einblenden (Film läuft, Stummschaltung, Fenster verborgen). */
  setSuspended(on: boolean): void;
}

/** Baut Hall, Pegelbegrenzung und die Ebenen an `destination`. Funktioniert mit AudioContext und OfflineAudioContext. */
export function buildAmbient(ctx: BaseAudioContext, destination: AudioNode): AmbientGraph {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.05;
  comp.release.value = 0.6;
  const master = ctx.createGain();
  master.gain.value = 0;
  const fade = ctx.createGain();
  fade.gain.value = 1;
  comp.connect(master).connect(fade).connect(destination);

  const mix = ctx.createGain();
  const reverb = ctx.createConvolver();
  reverb.buffer = makeReverbIR(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.7;
  const dry = ctx.createGain();
  dry.gain.value = 0.65;
  mix.connect(dry).connect(comp);
  mix.connect(reverb).connect(wet).connect(comp);

  // Echo nur für die Glocken.
  const bellBus = ctx.createGain();
  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = 0.52;
  const fb = ctx.createGain();
  fb.gain.value = 0.38;
  const echo = ctx.createGain();
  echo.gain.value = 0.5;
  bellBus.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(echo).connect(mix);

  let layer: Layer | null = null;
  let mood: MoodId | null = null;
  let volume = 0.4;
  const apply = (at: number) => {
    master.gain.cancelScheduledValues(at);
    master.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)) ** 2 * 0.9, at, 0.25);
  };

  return {
    setMood(next, fadeIn = 3) {
      if (mood === next && layer) return;
      const now = ctx.currentTime;
      if (layer) {
        layer.fadeOut(now, fadeIn);
        layer.dispose(now + fadeIn + 0.2);
      }
      mood = next;
      layer = new Layer(ctx, mix, next, now + 0.05, fadeIn, bellBus);
      apply(now);
    },
    scheduleUntil(t) {
      layer?.scheduleUntil(t);
    },
    setVolume(v) {
      volume = v;
      apply(ctx.currentTime);
    },
    setSuspended(on) {
      const now = ctx.currentTime;
      fade.gain.cancelScheduledValues(now);
      fade.gain.setValueAtTime(fade.gain.value, now);
      fade.gain.linearRampToValueAtTime(on ? 0 : 1, now + (on ? 1.5 : 2.5));
    },
  };
}

/** Rechnet eine Stimmung offline durch (für Tests): Samples links/rechts. */
export async function renderMood(mood: MoodId, seconds: number, volume = 0.4, sampleRate = 22050): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * sampleRate), sampleRate);
  const g = buildAmbient(ctx, ctx.destination);
  g.setVolume(volume);
  g.setMood(mood, 1.5);
  g.scheduleUntil(seconds);
  return ctx.startRendering();
}

/* ------------------------------------------------------------------ Laufzeit */

export interface AmbientMusic {
  /** Startet (nach der ersten Eingabe des Nutzers); mehrfaches Aufrufen ist harmlos. */
  start(): void;
  setMood(mood: MoodId): void;
  setVolume(v: number): void;
  setSuspended(on: boolean): void;
  dispose(): void;
}

export function createAmbientMusic(): AmbientMusic {
  let ctx: AudioContext | null = null;
  let graph: AmbientGraph | null = null;
  let timer = 0;
  let mood: MoodId = DEFAULT_MOOD;
  let volume = 0.4;
  let suspended = false;
  let suspendTimer = 0;

  const tick = () => {
    if (ctx && graph) graph.scheduleUntil(ctx.currentTime + 6);
  };

  const ensure = () => {
    if (ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor({ latencyHint: "playback" });
    graph = buildAmbient(ctx, ctx.destination);
    graph.setVolume(volume);
    graph.setMood(mood, 4);
    tick();
    timer = window.setInterval(tick, 1000);
    (window as unknown as { __ambientDebug?: unknown }).__ambientDebug = { ctx };
  };

  const applySuspend = () => {
    if (!ctx || !graph) return;
    window.clearTimeout(suspendTimer);
    graph.setSuspended(suspended);
    if (suspended) {
      // Erst nach dem Ausblenden den Kontext anhalten (spart CPU).
      suspendTimer = window.setTimeout(() => void ctx?.suspend().catch(() => undefined), 1800);
    } else {
      void ctx.resume().catch(() => undefined);
    }
  };

  return {
    start() {
      if (suspended) return;
      ensure();
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    },
    setMood(next) {
      mood = next;
      graph?.setMood(next);
    },
    setVolume(v) {
      volume = v;
      graph?.setVolume(v);
    },
    setSuspended(on) {
      if (suspended === on) return;
      suspended = on;
      applySuspend();
    },
    dispose() {
      window.clearInterval(timer);
      window.clearTimeout(suspendTimer);
      void ctx?.close().catch(() => undefined);
      ctx = null;
      graph = null;
    },
  };
}
