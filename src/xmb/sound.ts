/**
 * Synthetisierte XMB-Klänge (Web Audio) – keine Audiodateien nötig.
 * Alle Eingabewege (Tastatur, Controller, Maus) lösen dieselben Effekte aus.
 */
export type Sfx = "move" | "category" | "confirm" | "back" | "error";

const MUTE_KEY = "jellystation.muted";

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();

function ensureAudio(): { ctx: AudioContext; bus: GainNode } | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      // Master + kurzes, weiches Echo für den typischen "schwebenden" Klang.
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.13;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.28;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(master);
      bus = ctx.createGain();
      bus.connect(master);
      bus.connect(delay);
    }
    // Browser starten den Kontext erst nach einer Nutzeraktion.
    if (ctx.state === "suspended") void ctx.resume();
    return bus ? { ctx, bus } : null;
  } catch {
    return null;
  }
}

interface Tone {
  from: number;
  to?: number;
  at?: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
}

function tone(a: { ctx: AudioContext; bus: GainNode }, t: Tone) {
  const start = a.ctx.currentTime + (t.at ?? 0);
  const osc = a.ctx.createOscillator();
  const env = a.ctx.createGain();
  osc.type = t.type ?? "sine";
  osc.frequency.setValueAtTime(t.from, start);
  if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.dur);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(t.gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
  osc.connect(env).connect(a.bus);
  osc.start(start);
  osc.stop(start + t.dur + 0.02);
}

const recipes: Record<Sfx, Tone[]> = {
  move: [{ from: 1250, to: 900, dur: 0.07, gain: 0.07 }],
  category: [
    { from: 520, to: 760, dur: 0.14, gain: 0.09 },
    { from: 1040, to: 1520, dur: 0.1, gain: 0.025 },
  ],
  confirm: [
    { from: 660, dur: 0.18, gain: 0.09 },
    { from: 990, at: 0.07, dur: 0.24, gain: 0.08 },
  ],
  back: [{ from: 720, to: 400, dur: 0.14, gain: 0.08 }],
  error: [{ from: 220, to: 180, dur: 0.16, gain: 0.07, type: "triangle" }],
};

export function playSfx(name: Sfx) {
  if (muted) return;
  const a = ensureAudio();
  if (!a) return;
  for (const t of recipes[name]) tone(a, t);
}

export const isMuted = () => muted;

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* ignorieren */
  }
}
