import { TAU, frac, lerp, mod, mulberry32, spread2 } from "./math";

type Kind = "triangle" | "circle" | "cross" | "square";

// Gleiche Geometrie wie PsSymbol (24er-Raster) – hier nur als Umriss auf dem Canvas.
const PATHS: Record<Kind, string> = {
  cross: "M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8",
  circle: "M5.4 12a6.6 6.6 0 1 0 13.2 0a6.6 6.6 0 1 0 -13.2 0Z",
  triangle: "M12 5.2 19 17.8H5Z",
  square: "M6.8 5.8H17.2A1 1 0 0 1 18.2 6.8V17.2A1 1 0 0 1 17.2 18.2H6.8A1 1 0 0 1 5.8 17.2V6.8A1 1 0 0 1 6.8 5.8Z",
};

/** Drehpunkt im Raster: das Dreieck dreht sich um seinen Schwerpunkt, nicht um die Rastermitte. */
const PIVOT: Record<Kind, [number, number]> = {
  cross: [12, 12],
  circle: [12, 12],
  triangle: [12, 13.6],
  square: [12, 12],
};

// Original-Tastenfarben (siehe --ps-* in index.css), RGB für rgba().
const TINT: Record<Kind, string> = {
  triangle: "92, 207, 155",
  circle: "255, 111, 120",
  cross: "127, 166, 255",
  square: "240, 140, 200",
};

const KINDS: Kind[] = ["triangle", "circle", "cross", "square"];
const COUNT = 18;

interface Floater {
  kind: Kind;
  /** 0 = weit hinten (klein, langsam, blass, weich) … 1 = vorn. */
  depth: number;
  x: number;
  y: number;
  /** Kantenlänge in px bei 1080 p. */
  size: number;
  /** Aufstieg und Seitendrift in px/s bei 1080 p. */
  rise: number;
  drift: number;
  spin: number;
  spin0: number;
  sway: number;
  swayF: number;
  phase: number;
  alpha: number;
  rgb: string;
}

function makeFloaters(): Floater[] {
  const rnd = mulberry32(1994);
  const list: Floater[] = [];
  for (let i = 0; i < COUNT; i++) {
    const [x, y] = spread2(i);
    // Tiefe über den goldenen Schnitt: gleichmäßig gemischt, aber nicht mit der Position gekoppelt.
    const depth = frac(0.15 + i * 0.6180339887);
    const kind = KINDS[(i + Math.floor(i / 4)) % 4];
    // Etwa jede vierte Form trägt dezent die Farbe ihrer Taste, der Rest ist weiß.
    const tinted = i % 4 === 1;
    const side = rnd() < 0.5 ? -1 : 1;
    list.push({
      kind,
      depth,
      x,
      y,
      size: lerp(24, 110, depth ** 1.5),
      rise: lerp(4, 14, depth) * (0.85 + rnd() * 0.3),
      drift: side * lerp(0.5, 4, rnd()) * (0.4 + depth),
      spin: (rnd() < 0.5 ? -1 : 1) * lerp(0.03, 0.11, depth) * (0.8 + rnd() * 0.4),
      spin0: rnd() * TAU,
      sway: lerp(6, 22, rnd()) * (0.4 + 0.6 * depth),
      swayF: TAU / lerp(18, 46, rnd()),
      phase: rnd() * TAU,
      // Schein und Kern überlagern sich nur teilweise: Die sichtbare Deckkraft der Linie liegt bei
      // etwa 70–80 % dieses Wertes, so landen ferne wie nahe Formen im Zielbereich von ca. 8–22 %.
      alpha: lerp(0.12, 0.27, depth) * (tinted ? 0.85 : 1),
      rgb: tinted ? TINT[kind] : "255, 255, 255",
    });
  }
  return list;
}

const FLOATERS = makeFloaters();

export function createFloaters(ctx: CanvasRenderingContext2D, w: number, h: number, u: number) {
  const paths = {} as Record<Kind, Path2D>;
  for (const k of KINDS) paths[k] = new Path2D(PATHS[k]);

  return function draw(t: number) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const f of FLOATERS) {
      const size = f.size * u;
      const margin = size * 1.3;
      const spanY = h + margin * 2;
      const spanX = w + margin * 2;
      // Steigt auf und taucht unten wieder auf; Wiedereintritt immer außerhalb des Bildes.
      const py = h + margin - mod(f.y * spanY + f.rise * u * t, spanY);
      const px = mod(f.x * spanX + f.drift * u * t, spanX) - margin + Math.sin(t * f.swayF + f.phase) * f.sway * u;
      const y = py + Math.sin(t * f.swayF * 0.7 + f.phase * 2) * f.sway * 0.4 * u;
      // Außerhalb des Bildes (Wiedereintritts-Rand) gibt es nichts zu zeichnen.
      const reach = size * 0.75;
      if (y < -reach || y > h + reach || px < -reach || px > w + reach) continue;
      const rot = f.spin0 + f.spin * t;
      const breathe = 1 + 0.12 * Math.sin(t * 0.3 + f.phase);
      const a = f.alpha * breathe;

      const [cx, cy] = PIVOT[f.kind];
      const s = size / 24;
      // Strichstärke ≈ 2–3 px unabhängig von der Größe; kleine/ferne Formen sind weicher.
      const lw = Math.max(1.4, lerp(2, 3, f.depth) * Math.max(u, 0.7));
      const soft = 1 - f.depth;

      ctx.save();
      ctx.translate(px, y);
      ctx.rotate(rot);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      const path = paths[f.kind];
      // Zwei Durchgänge (Schein, Kern) ergeben eine weiche, leuchtende Linie; je weiter hinten,
      // desto breiter der Schein und desto schwächer der scharfe Kern.
      const passes: [number, number][] = [
        [lw * (3 + 3.5 * soft), a * (0.17 + 0.1 * soft)],
        [lw * (1 + 0.5 * soft), a * (0.66 - 0.2 * soft)],
      ];
      for (const [width, alpha] of passes) {
        ctx.lineWidth = width / s;
        ctx.strokeStyle = `rgba(${f.rgb}, ${alpha.toFixed(3)})`;
        ctx.stroke(path);
      }
      ctx.restore();
    }
  };
}
