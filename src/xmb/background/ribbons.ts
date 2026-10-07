import { TAU } from "./math";
import { silk, type Palette } from "./palette";

/**
 * Ein seidiges Band: Mittellinie aus zwei überlagerten Sinuswellen, dazu eine Dicke, die
 * langsam anschwillt und fast zusammenläuft (wie ein verdrehtes Tuch). Alle Längen sind
 * Anteile der Bildhöhe, Frequenzen Zyklen pro Bildbreite, Geschwindigkeiten rad/s.
 */
interface RibbonDef {
  y: number;
  a1: number;
  f1: number;
  s1: number;
  p1: number;
  a2: number;
  f2: number;
  s2: number;
  p2: number;
  /** Maximale halbe Dicke. */
  th: number;
  tf: number;
  ts: number;
  tp: number;
  /** Deckkraft der Füllung (Spitze) und der Kantenlinie. */
  fill: number;
  edge: number;
  /** Farbtonverschiebung gegenüber dem Grundton (Grad). */
  shift: number;
}

// Schwerpunkt im unteren Bildbereich wie im Original; ein zartes Band weiter oben.
const DEFS: RibbonDef[] = [
  { y: 0.5, a1: 0.05, f1: 0.8, s1: 0.07, p1: 0.4, a2: 0.025, f2: 1.7, s2: -0.1, p2: 2.2, th: 0.08, tf: 1.1, ts: 0.06, tp: 0.5, fill: 0.07, edge: 0.18, shift: 14 },
  { y: 0.62, a1: 0.08, f1: 0.95, s1: 0.09, p1: 1.6, a2: 0.035, f2: 1.9, s2: -0.12, p2: 4.1, th: 0.12, tf: 0.9, ts: -0.07, tp: 2.6, fill: 0.11, edge: 0.26, shift: 0 },
  { y: 0.7, a1: 0.07, f1: 1.25, s1: -0.08, p1: 3.3, a2: 0.04, f2: 0.7, s2: 0.06, p2: 0.9, th: 0.1, tf: 1.4, ts: 0.08, tp: 4.4, fill: 0.1, edge: 0.24, shift: -12 },
  { y: 0.78, a1: 0.09, f1: 0.75, s1: 0.06, p1: 5.0, a2: 0.03, f2: 2.1, s2: 0.14, p2: 1.3, th: 0.14, tf: 0.8, ts: -0.06, tp: 1.1, fill: 0.12, edge: 0.28, shift: 8 },
  { y: 0.84, a1: 0.06, f1: 1.5, s1: -0.11, p1: 2.4, a2: 0.035, f2: 0.95, s2: 0.09, p2: 3.7, th: 0.09, tf: 1.7, ts: 0.1, tp: 5.2, fill: 0.09, edge: 0.22, shift: 0 },
  { y: 0.9, a1: 0.05, f1: 1.1, s1: 0.1, p1: 4.2, a2: 0.025, f2: 2.4, s2: -0.15, p2: 0.2, th: 0.1, tf: 1.25, ts: -0.09, tp: 3.0, fill: 0.1, edge: 0.2, shift: -8 },
  { y: 0.74, a1: 0.11, f1: 0.55, s1: -0.05, p1: 0.8, a2: 0.045, f2: 1.2, s2: 0.07, p2: 5.6, th: 0.06, tf: 0.65, ts: 0.05, tp: 2.0, fill: 0.05, edge: 0.16, shift: 20 },
];

/**
 * Zeichnet die Bänder mit möglichst wenigen, billigen Operationen: einfarbige Flächen statt
 * Farbverläufen (die kosten beim Rastern ein Vielfaches), dafür eine zweite, hellere Fläche
 * auf der oberen Bandhälfte und eine feine Linie an der Oberkante. Jede Linie kostet ungefähr
 * so viel wie eine Fläche, deshalb gibt es keine Strähnen oder breiten Scheine.
 * `unit` ist die Breite einer feinen Linie in px.
 */
export function createRibbons(ctx: CanvasRenderingContext2D, w: number, h: number, unit: number, pal: Palette) {
  const n = Math.max(32, Math.min(80, Math.ceil(w / 32)));
  const xs = new Float32Array(n + 1);
  const mid = new Float32Array(n + 1);
  const half = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) xs[i] = (i / n) * w;

  // Etwas zurückgenommen, damit Listentexte davor lesbar bleiben; nachts leuchten die Bänder noch leiser.
  const level = 0.9 - 0.22 * pal.night;

  const ribbons = DEFS.map((d) => ({
    d,
    body: silk(pal, d.fill * level, d.shift),
    sheen: silk(pal, d.fill * 0.55 * level, d.shift),
    edge: silk(pal, d.edge * level, d.shift),
  }));

  // Kante des Bandes: q = -1 Oberkante, 0 Mittellinie, +1 Unterkante.
  const trace = (q: number) => {
    ctx.moveTo(xs[0], mid[0] + q * half[0]);
    for (let i = 1; i <= n; i++) ctx.lineTo(xs[i], mid[i] + q * half[i]);
  };

  return function draw(t: number) {
    ctx.lineJoin = "bevel";
    ctx.lineCap = "butt";
    for (const { d, body, sheen, edge } of ribbons) {
      // Das Licht auf jedem Band schwillt sehr langsam an und ab.
      ctx.globalAlpha = 0.86 + 0.14 * Math.sin(t * 0.17 * (1 + d.f1 * 0.4) + d.p1);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        mid[i] =
          (d.y + d.a1 * Math.sin(TAU * d.f1 * u + d.s1 * t + d.p1) + d.a2 * Math.sin(TAU * d.f2 * u + d.s2 * t + d.p2)) * h;
        const m = 0.5 + 0.5 * Math.sin(TAU * d.tf * u + d.ts * t + d.tp);
        half[i] = d.th * h * (0.1 + 0.9 * m * m);
      }

      // Fläche zwischen Ober- und Unterkante, darüber die hellere obere Hälfte.
      ctx.beginPath();
      trace(-1);
      for (let i = n; i >= 0; i--) ctx.lineTo(xs[i], mid[i] + half[i]);
      ctx.closePath();
      ctx.fillStyle = body;
      ctx.fill();

      ctx.beginPath();
      trace(-1);
      for (let i = n; i >= 0; i--) ctx.lineTo(xs[i], mid[i]);
      ctx.closePath();
      ctx.fillStyle = sheen;
      ctx.fill();

      // Oberkante: feine helle Linie, an der das Licht "hängenbleibt".
      ctx.beginPath();
      trace(-1);
      ctx.strokeStyle = edge;
      ctx.lineWidth = unit * 1.4;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
}
