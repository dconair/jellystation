import { getUiPrefs } from "../prefs/uiPrefs";
/**
 * Synthetisierte XMB-Klänge (Web Audio) – keine Audiodateien nötig.
 * Alle Eingabewege (Tastatur, Controller, Maus) lösen dieselben Effekte aus.
 *
 * Aufbau:
 *  1. Klangparameter (alle Zahlen zum Nachjustieren stehen hier oben).
 *  2. Synthese: arbeitet mit jedem BaseAudioContext (live oder OfflineAudioContext),
 *     deshalb ohne Lautsprecher renderbar und messbar.
 *  3. Player (Stimmenbegrenzung, Wiederholsperre) und die kleine Live-API
 *     playSfx / isMuted / setMuted.
 */
export type Sfx = "move" | "category" | "confirm" | "back" | "error";

export const SFX_NAMES: readonly Sfx[] = ["move", "category", "confirm", "back", "error"];

// ───────────────────────── 1. Klangparameter ─────────────────────────

/**
 * Gesamtlautstärke nach dem Limiter (1 = volle Skala).
 * Der DynamicsCompressor von Chrome hebt leise Signale selbst um ca. 5 dB an (Makeup-Gain) und braucht
 * nach dem Start des Kontexts rund 0,1 s, bis er seinen Pegel erreicht. Gemessen wird daher erst ab
 * ca. 0,2 s Kontextzeit: Mit 0,3 liegen die Einzelspitzen dann bei ca. −13 dBFS
 * (Fehler/Bewegen/Zurück ≈ 0,2, Bestätigen ≈ 0,12), also in der Größenordnung der alten Klänge (≈ 0,1).
 */
export const MASTER_LEVEL = 0.3;
/** Zufällige Tonhöhenabweichung pro Auslösung (±1,5 %), gegen maschinellen Klang. */
export const PITCH_JITTER = 0.015;
/** Zufällige Lautstärkeabweichung pro Auslösung (±8 %). */
export const LEVEL_JITTER = 0.08;
/** Gleicher Effekt frühestens nach so vielen Sekunden erneut (schnelles Gedrückthalten). */
export const MIN_REPEAT_S = 0.03;
/** Höchstzahl gleichzeitiger Effekte; der älteste wird dafür sanft ausgeblendet. */
export const MAX_VOICES = 6;
/** Ausblendzeit eines verdrängten Effekts (Sekunden) – verhindert Knackser. */
export const STEAL_FADE_S = 0.03;
/**
 * Dämpfung bei dichter Wiederholung: Pegel = 1 / √(1 + REPEAT_DUCK × noch klingende Effekte gleichen Namens).
 * Beim Gedrückthalten schwillt der Klang so nicht an; ein einzelner Effekt bleibt unberührt (0 = aus).
 */
export const REPEAT_DUCK = 0.8;

/** Hüllkurven: Anfangsanstieg, falls eine Ebene keinen eigenen Wert hat (Sekunden). */
export const DEFAULT_ATTACK_S = 0.008;
/** Hüllkurven klingen exponentiell bis auf −60 dB ab und werden dann in so vielen Sekunden auf 0 gezogen. */
export const ENV_TAIL_S = 0.015;
const ENV_FLOOR = 0.001; // −60 dB

/** Synthetischer Hall: Impulsantwort aus gefiltertem Rauschen (Sekunden / Koeffizienten 0..1). */
export const REVERB = {
  /** Nachhallzeit bis −60 dB. */
  seconds: 1.5,
  /** Stille vor dem ersten Hall-Anteil. */
  preDelay: 0.014,
  /** Sanfter Einsatz des Halls. */
  fadeIn: 0.012,
  /** Tiefpass-Koeffizient am Anfang der Hallfahne (hoch = hell) … */
  brightStart: 0.8,
  /** … und am Ende (niedrig = dunkel, wie Luftdämpfung). */
  brightEnd: 0.22,
  /** Pegel des Hallsignals vor dem Limiter. */
  returnLevel: 1.0,
  /** Hall-Rückweg: unten und oben beschneiden, damit er nicht dumpf/zischend wird. */
  highpass: 180,
  lowpass: 7500,
  seedLeft: 0x9e3779b1,
  seedRight: 0x85ebca6b,
} as const;

/** Limiter am Ausgang (DynamicsCompressor), fängt Überlagerungen ab. */
export const LIMITER = {
  threshold: -10, // dB
  knee: 8,
  ratio: 12,
  attack: 0.004,
  release: 0.16,
} as const;

/** Rauschpuffer für das Luftige (Sekunden). */
const NOISE_SECONDS = 1;
const NOISE_SEED = 0x1234abcd;

/** Teilton einer additiven Glocke: [Frequenzfaktor, relative Lautstärke, Abklingfaktor]. */
type PartialSpec = readonly [ratio: number, gain: number, decayScale: number];

/** Glasig/inharmonisch (Stab-/Glockenverhältnisse): hell, kurzes "Tink". */
const GLASS: readonly PartialSpec[] = [
  [1, 1, 1],
  [2.76, 0.4, 0.55],
  [5.4, 0.15, 0.3],
  [8.93, 0.05, 0.18],
];
/** Weich: Grundton mit zarter Oktave und Quinte – für "Zurück". */
const SOFT: readonly PartialSpec[] = [
  [1, 1, 1],
  [2, 0.3, 0.55],
  [2.76, 0.12, 0.35],
];
/** Dumpf: ungefähr Dreieckswelle – für "Fehler". */
const DULL: readonly PartialSpec[] = [
  [1, 1, 1],
  [2, 0.45, 0.7],
  [3, 0.22, 0.5],
];

interface LayerBase {
  /** Startverzögerung innerhalb des Effekts (Sekunden). */
  at?: number;
  /** Anstiegszeit (Sekunden, sinnvoll 0,005–0,015). */
  attack?: number;
  /** Ausklingzeit bis −60 dB (Sekunden). */
  decay: number;
  /** Spitzenpegel dieser Ebene vor Hall/Limiter. */
  gain: number;
  /** Anteil, der in den Hall geschickt wird (0 = trocken). */
  send: number;
}

/** Additive Glocke aus Teiltönen mit eigener Abklingzeit. */
interface BellLayer extends LayerBase {
  kind: "bell";
  freq: number;
  partials: readonly PartialSpec[];
  /** Tonhöhenschwung: Endfaktor und Dauer in Sekunden. */
  glide?: { ratio: number; time: number };
  /** Tiefpass-Grenzfrequenz in Hz (nimmt Schärfe). */
  lowpass: number;
}

/** FM-Glocke: der Modulationsindex klingt schneller ab als der Ton (Anschlag → reiner Nachklang). */
interface FmLayer extends LayerBase {
  kind: "fm";
  freq: number;
  /** Verhältnis Modulator/Träger (ganzzahlig = warm, leicht daneben = Glocke). */
  modRatio: number;
  /** Modulationsindex am Anfang. */
  index: number;
  /** Zeit, in der der Index auf ~0 fällt. */
  indexDecay: number;
  glide?: { ratio: number; time: number };
  lowpass: number;
}

/** Gefiltertes Rauschen, optional mit Filterfahrt (luftiges "Whoosh"). */
interface NoiseLayer extends LayerBase {
  kind: "noise";
  filter: "bandpass" | "highpass" | "lowpass";
  /** Filterfrequenz am Anfang → am Ende der Fahrt (Hz). */
  from: number;
  to: number;
  /** Dauer der Filterfahrt (Sekunden). */
  sweep: number;
  q: number;
}

type Layer = BellLayer | FmLayer | NoiseLayer;

/**
 * Die fünf Effekte. Zur Orientierung: 523 Hz ≈ C5, 659 ≈ E5, 698 ≈ F5, 988 ≈ B5, 196 ≈ G3 (1900 Hz ist ein heller Ping).
 */
export const EFFECTS: Readonly<Record<Sfx, readonly Layer[]>> = {
  // Eintrags-Wechsel: kurzes, weiches, glasig-hohes "Tick/Tink".
  move: [
    { kind: "bell", freq: 1900, partials: GLASS, attack: 0.006, decay: 0.12, gain: 0.34, lowpass: 7500, send: 0.22 },
    // Winziger Luftanteil für den "Tick"-Charakter.
    { kind: "noise", filter: "bandpass", from: 5200, to: 5200, sweep: 0.05, q: 1.4, attack: 0.005, decay: 0.03, gain: 0.03, send: 0.1 },
  ],
  // Kategorie-Wechsel: weicherer, tieferer Ton mit luftigem Whoosh.
  category: [
    { kind: "fm", freq: 523, modRatio: 2, index: 1.5, indexDecay: 0.14, glide: { ratio: 1.06, time: 0.12 }, lowpass: 3800, attack: 0.01, decay: 0.42, gain: 0.37, send: 0.45 },
    { kind: "bell", freq: 1046, partials: SOFT, attack: 0.012, decay: 0.26, gain: 0.06, lowpass: 5200, send: 0.5 },
    { kind: "noise", filter: "bandpass", from: 420, to: 2000, sweep: 0.32, q: 1.3, attack: 0.09, decay: 0.34, gain: 0.11, send: 0.7 },
  ],
  // Bestätigen: warmes, kurzes, aufsteigendes Zwei-Ton-Glockenmotiv (E5 → B5).
  confirm: [
    { kind: "fm", freq: 659, modRatio: 2.01, index: 1.3, indexDecay: 0.16, lowpass: 4600, attack: 0.008, decay: 0.34, gain: 0.16, send: 0.35 },
    { kind: "fm", freq: 988, at: 0.09, modRatio: 2.01, index: 1.4, indexDecay: 0.2, lowpass: 5200, attack: 0.008, decay: 0.62, gain: 0.19, send: 0.45 },
    // Dezente tiefe Oktave für Wärme.
    { kind: "bell", freq: 330, at: 0.09, partials: [[1, 1, 1]], attack: 0.012, decay: 0.4, gain: 0.045, lowpass: 1500, send: 0.3 },
  ],
  // Zurück: ein sanfter, absteigender Ton (F5 gleitet nach unten).
  back: [
    { kind: "bell", freq: 698, partials: SOFT, glide: { ratio: 0.74, time: 0.18 }, attack: 0.01, decay: 0.34, gain: 0.35, lowpass: 3400, send: 0.35 },
  ],
  // Fehler: dumpfer, kurzer, leicht sinkender Ton.
  error: [
    { kind: "bell", freq: 196, partials: DULL, glide: { ratio: 0.88, time: 0.14 }, attack: 0.008, decay: 0.2, gain: 0.42, lowpass: 950, send: 0.08 },
  ],
};

// ───────────────────────── 2. Synthese ─────────────────────────

/** Kleiner deterministischer Zufallsgenerator (damit Hall/Rauschen reproduzierbar sind). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hall-Impulsantwort: abklingendes Rauschen, das mit der Zeit dunkler wird. */
export function makeImpulseResponse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.ceil(rate * (REVERB.seconds * 1.1));
  const buffer = ctx.createBuffer(2, length, rate);
  const fadeOutStart = REVERB.seconds * 1.1 - 0.1;
  // −60 dB (Faktor 0,001) nach REVERB.seconds, als Schritt pro Sample.
  const decayStep = Math.exp(-6.9078 / (REVERB.seconds * rate));
  [REVERB.seedLeft, REVERB.seedRight].forEach((seed, ch) => {
    const rnd = mulberry32(seed);
    const data = buffer.getChannelData(ch);
    let lp = 0;
    let decay = 1;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const x = rnd() * 2 - 1;
      // Einpoliger Tiefpass, dessen Grenzfrequenz mit der Zeit sinkt.
      const k = REVERB.brightStart + (REVERB.brightEnd - REVERB.brightStart) * Math.min(1, t / REVERB.seconds);
      lp += k * (x - lp);
      decay *= decayStep;
      const fadeIn = Math.min(1, Math.max(0, (t - REVERB.preDelay) / REVERB.fadeIn));
      const fadeOut = t > fadeOutStart ? Math.max(0, 1 - (t - fadeOutStart) / 0.1) : 1;
      data[i] = lp * decay * fadeIn * fadeOut;
    }
  });
  return buffer;
}

function makeNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const rnd = mulberry32(NOISE_SEED);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = rnd() * 2 - 1;
  return buffer;
}

/** Gemeinsame Signalkette: trocken + Hall → Limiter → Master → Ziel. */
export interface SfxChain {
  /** Eingang trocken. */
  dry: GainNode;
  /** Eingang Hall-Zuspielung. */
  send: GainNode;
  noise: AudioBuffer;
}

export function createSfxChain(ctx: BaseAudioContext, destination: AudioNode): SfxChain {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  const master = ctx.createGain();
  master.gain.value = MASTER_LEVEL;
  limiter.connect(master).connect(destination);

  const dry = ctx.createGain();
  dry.connect(limiter);

  const send = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = REVERB.highpass;
  const verb = ctx.createConvolver();
  verb.buffer = makeImpulseResponse(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = REVERB.lowpass;
  const ret = ctx.createGain();
  ret.gain.value = REVERB.returnLevel;
  send.connect(hp).connect(verb).connect(lp).connect(ret).connect(limiter);

  return { dry, send, noise: makeNoiseBuffer(ctx) };
}

/** Anstieg → exponentielles Abklingen bis −60 dB → Ausläufer auf exakt 0 (kein Knackser). */
function envelope(param: AudioParam, t0: number, attack: number, peak: number, decay: number) {
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(Math.max(peak * ENV_FLOOR, 1e-6), t0 + attack + decay);
  param.linearRampToValueAtTime(0, t0 + attack + decay + ENV_TAIL_S);
}

function layerEnd(l: Layer): number {
  return (l.at ?? 0) + (l.attack ?? DEFAULT_ATTACK_S) + l.decay + ENV_TAIL_S;
}

/** Ein ausgelöster Effekt: zwei Ausgänge (trocken/Hall), die sich gemeinsam ausblenden lassen. */
export interface Voice {
  name: Sfx;
  /** Endzeitpunkt (AudioContext-Zeit), danach ist alles still. */
  end: number;
  /** Blendet den Effekt ab `when` innerhalb von `fade` Sekunden aus. */
  fadeOut(when: number, fade?: number): void;
}

export interface ScheduleOptions {
  /** Startzeit in AudioContext-Zeit (Standard: jetzt). */
  when?: number;
  /** Tonhöhenfaktor, 1 = unverändert. */
  pitch?: number;
  /** Lautstärkefaktor, 1 = unverändert. */
  level?: number;
  /** Startposition im Rauschpuffer (Sekunden), damit das Whoosh nicht immer identisch ist. */
  noiseOffset?: number;
}

/** Plant einen Effekt ein. Funktioniert mit AudioContext und OfflineAudioContext. */
export function scheduleSfx(ctx: BaseAudioContext, chain: SfxChain, name: Sfx, opts: ScheduleOptions = {}): Voice {
  const when = opts.when ?? ctx.currentTime;
  const pitch = opts.pitch ?? 1;
  const level = opts.level ?? 1;
  const layers = EFFECTS[name];

  const dryBus = ctx.createGain();
  const sendBus = ctx.createGain();
  dryBus.gain.value = level;
  sendBus.gain.value = level;
  dryBus.connect(chain.dry);
  sendBus.connect(chain.send);

  let end = when;
  for (const l of layers) {
    const t0 = when + (l.at ?? 0);
    const attack = l.attack ?? DEFAULT_ATTACK_S;
    const stopAt = when + layerEnd(l);
    end = Math.max(end, stopAt);

    // Schlussknoten dieser Ebene: trocken direkt, Hall über eigenen Zuspielregler.
    const out = ctx.createGain();
    out.connect(dryBus);
    if (l.send > 0) {
      const s = ctx.createGain();
      s.gain.value = l.send;
      out.connect(s).connect(sendBus);
    }

    if (l.kind === "bell") {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = l.lowpass;
      lp.Q.value = 0.6;
      lp.connect(out);
      for (const [ratio, g, decayScale] of l.partials) {
        const f = l.freq * ratio * pitch;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, t0);
        if (l.glide) osc.frequency.exponentialRampToValueAtTime(f * l.glide.ratio, t0 + l.glide.time);
        const env = ctx.createGain();
        envelope(env.gain, t0, attack, l.gain * g, l.decay * decayScale);
        osc.connect(env).connect(lp);
        osc.start(t0);
        osc.stop(stopAt);
      }
    } else if (l.kind === "fm") {
      const f = l.freq * pitch;
      const fm = f * l.modRatio;
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.setValueAtTime(f, t0);
      if (l.glide) carrier.frequency.exponentialRampToValueAtTime(f * l.glide.ratio, t0 + l.glide.time);
      const mod = ctx.createOscillator();
      mod.type = "sine";
      mod.frequency.setValueAtTime(fm, t0);
      if (l.glide) mod.frequency.exponentialRampToValueAtTime(fm * l.glide.ratio, t0 + l.glide.time);
      // Frequenzhub = Index × Modulatorfrequenz; fällt schneller als der Ton selbst.
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(l.index * fm, t0);
      depth.gain.exponentialRampToValueAtTime(Math.max(l.index * fm * 0.02, 1e-3), t0 + l.indexDecay);
      mod.connect(depth).connect(carrier.frequency);
      const env = ctx.createGain();
      envelope(env.gain, t0, attack, l.gain, l.decay);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = l.lowpass;
      lp.Q.value = 0.6;
      carrier.connect(env).connect(lp).connect(out);
      carrier.start(t0);
      mod.start(t0);
      carrier.stop(stopAt);
      mod.stop(stopAt);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = chain.noise;
      const filt = ctx.createBiquadFilter();
      filt.type = l.filter;
      filt.Q.value = l.q;
      filt.frequency.setValueAtTime(l.from * pitch, t0);
      if (l.to !== l.from) filt.frequency.exponentialRampToValueAtTime(l.to * pitch, t0 + l.sweep);
      const env = ctx.createGain();
      envelope(env.gain, t0, attack, l.gain, l.decay);
      src.connect(filt).connect(env).connect(out);
      const offset = Math.max(0, Math.min(chain.noise.duration - (stopAt - t0) - 0.01, opts.noiseOffset ?? 0));
      src.start(t0, offset);
      src.stop(stopAt);
    }
  }

  const voice: Voice = {
    name,
    end,
    fadeOut(at, fade = STEAL_FADE_S) {
      for (const g of [dryBus.gain, sendBus.gain]) {
        g.cancelScheduledValues(at);
        g.setValueAtTime(level, at);
        g.linearRampToValueAtTime(0, at + fade);
      }
      // Ab jetzt zählt der Effekt als beendet.
      voice.end = Math.min(voice.end, at + fade);
    },
  };
  return voice;
}

// ───────────────────────── 3. Player & Live-API ─────────────────────────

export interface SfxPlayer {
  chain: SfxChain;
  /** Spielt einen Effekt; false, wenn die Wiederholsperre ihn verworfen hat. */
  play(name: Sfx, opts?: ScheduleOptions): boolean;
  /** Anzahl gerade klingender Effekte zum Zeitpunkt `when`. */
  active(when?: number): number;
}

/** Wiederholsperre (je Effekt) und Stimmenbegrenzung – unabhängig vom Ziel nutzbar. */
export function createSfxPlayer(ctx: BaseAudioContext, destination: AudioNode): SfxPlayer {
  const chain = createSfxChain(ctx, destination);
  let voices: Voice[] = [];
  const lastStart = new Map<Sfx, number>();

  return {
    chain,
    active(when = ctx.currentTime) {
      return voices.filter((v) => v.end > when).length;
    },
    play(name, opts = {}) {
      const when = opts.when ?? ctx.currentTime;
      const last = lastStart.get(name);
      if (last !== undefined && when - last < MIN_REPEAT_S && when >= last) return false;
      lastStart.set(name, when);

      voices = voices.filter((v) => v.end > when);
      // Zu viele Stimmen: die älteste weich ausblenden statt hart abzuschneiden.
      while (voices.length >= MAX_VOICES) voices.shift()!.fadeOut(when);

      const same = voices.filter((v) => v.name === name).length;
      const duck = 1 / Math.sqrt(1 + REPEAT_DUCK * same);
      voices.push(scheduleSfx(ctx, chain, name, { ...opts, when, level: (opts.level ?? 1) * duck }));
      return true;
    },
  };
}

const MUTE_KEY = "jellystation.muted";

let ctx: AudioContext | null = null;
let player: SfxPlayer | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();

function ensureAudio(): SfxPlayer | null {
  try {
    if (ctx && ctx.state === "closed") {
      ctx = null;
      player = null;
    }
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor({ latencyHint: "interactive" });
      player = createSfxPlayer(ctx, ctx.destination);
    }
    // Browser starten den Kontext erst nach einer Nutzeraktion (Safari: "interrupted").
    if (ctx.state !== "running") Promise.resolve(ctx.resume()).catch(() => undefined);
    return player;
  } catch {
    return null;
  }
}

/** Nach der ersten Nutzeraktion den Kontext anlegen/aufwecken, damit der erste Klang nicht fehlt. */
function installUnlock() {
  if (typeof window === "undefined") return;
  const events = ["pointerdown", "keydown", "touchend"] as const;
  const unlock = () => {
    for (const e of events) window.removeEventListener(e, unlock, true);
    if (!muted) ensureAudio();
  };
  for (const e of events) window.addEventListener(e, unlock, { capture: true, passive: true });
}
installUnlock();

// Beim Neuladen im Entwicklungsserver den alten Kontext freigeben.
import.meta.hot?.dispose(() => {
  void ctx?.close().catch(() => undefined);
});

export function playSfx(name: Sfx) {
  const volume = getUiPrefs().sfxVolume;
  if (muted || volume <= 0) return;
  const p = ensureAudio();
  if (!p) return;
  p.play(name, {
    pitch: 1 + (Math.random() * 2 - 1) * PITCH_JITTER,
    level: (1 + (Math.random() * 2 - 1) * LEVEL_JITTER) * volume,
    noiseOffset: Math.random() * 0.4,
  });
}

export const isMuted = () => muted;

const mutedListeners = new Set<(muted: boolean) => void>();
/** Meldet Änderungen der Stummschaltung (Taste M); gibt die Abmeldung zurück. */
export function onMutedChange(cb: (muted: boolean) => void): () => void {
  mutedListeners.add(cb);
  return () => {
    mutedListeners.delete(cb);
  };
}

export function setMuted(value: boolean) {
  muted = value;
  mutedListeners.forEach((cb) => cb(value));
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* ignorieren */
  }
}
