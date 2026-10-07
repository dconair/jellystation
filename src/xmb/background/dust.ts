import { TAU, mod, mulberry32, spread2 } from "./math";
import type { Palette } from "./palette";

/** Weicher Lichtpunkt als Sprite: einmal gezeichnet, pro Frame nur skaliert gestempelt. */
function sprite(size: number, paint: (g: CanvasRenderingContext2D, r: number) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (g) paint(g, size / 2);
  return c;
}

interface Mote {
  x: number;
  y: number;
  /** Radius in px bei 1080 p. */
  r: number;
  alpha: number;
  /** Aufstieg in px/s bei 1080 p. */
  rise: number;
  sway: number;
  swayF: number;
  phase: number;
  twinkle: number;
  bokeh: boolean;
}

const DUST = 56;
const BOKEH = 9;

function makeMotes(): Mote[] {
  const rnd = mulberry32(2006);
  const motes: Mote[] = [];
  for (let i = 0; i < DUST + BOKEH; i++) {
    const bokeh = i >= DUST;
    const [x, y] = spread2(i + 3);
    motes.push({
      x,
      // Leicht nach unten gewichtet: Dort glitzert es im Original am meisten.
      y: 1 - (1 - y) ** 1.35,
      r: bokeh ? 7 + rnd() * 16 : 0.7 + rnd() * 1.4,
      alpha: bokeh ? 0.05 + rnd() * 0.07 : 0.3 + rnd() * 0.45,
      rise: bokeh ? 3 + rnd() * 5 : 4 + rnd() * 9,
      sway: 6 + rnd() * 16,
      swayF: 0.08 + rnd() * 0.18,
      phase: rnd() * TAU,
      twinkle: 0.2 + rnd() * 0.5,
      bokeh,
    });
  }
  return motes;
}

const MOTES = makeMotes();

export function createDust(ctx: CanvasRenderingContext2D, w: number, h: number, u: number, pal: Palette) {
  const dot = sprite(32, (g, r) => {
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, `hsl(${pal.hue} 40% 97% / 1)`);
    grad.addColorStop(0.35, `hsl(${pal.hue} 60% 90% / 0.45)`);
    grad.addColorStop(1, `hsl(${pal.hue} 70% 80% / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, r * 2, r * 2);
  });
  // Bokeh: kaum gefüllte Scheibe mit etwas hellerem Rand, wie eine unscharfe Linsenblende.
  const bokeh = sprite(128, (g, r) => {
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, `hsl(${pal.hue} 70% 85% / 0.5)`);
    grad.addColorStop(0.7, `hsl(${pal.hue} 70% 85% / 0.7)`);
    grad.addColorStop(0.88, `hsl(${pal.hue} 80% 92% / 0.95)`);
    grad.addColorStop(1, `hsl(${pal.hue} 80% 92% / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, r * 2, r * 2);
  });

  return function draw(t: number) {
    for (const m of MOTES) {
      const r = m.r * u;
      const span = h + r * 4;
      const y = h + r * 2 - mod(m.y * span + m.rise * u * t, span);
      const x = m.x * w + Math.sin(t * m.swayF + m.phase) * m.sway * u;
      const tw = 1 - m.twinkle * (0.5 + 0.5 * Math.sin(t * (0.5 + m.twinkle) + m.phase * 3));
      ctx.globalAlpha = m.alpha * tw * (m.bokeh ? 1 - 0.3 * pal.night : 1);
      // Mindestgröße, damit Staub bei kleinen Fenstern nicht unter einen Pixel fällt.
      const rr = m.bokeh ? r : Math.max(r, 0.9);
      ctx.drawImage(m.bokeh ? bokeh : dot, x - rr, y - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;
  };
}
