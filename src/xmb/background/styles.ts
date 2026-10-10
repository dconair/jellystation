/**
 * Weitere Hintergrund-Designs neben den PS3-Wellen. Jedes ist eine Funktion „Palette → Zeichner“: Der Zeichner bekommt die Zeit
 * in Sekunden und malt auf den (transparenten) Canvas; Farben richten sich nach dem Farbton des gewählten Themes.
 */
import { TAU, mod, mulberry32 } from "./math";
import { glowColor, silk } from "./palette";
import type { Palette } from "./palette";

export type Drawer = (t: number) => void;
export type StyleFactory = (ctx: CanvasRenderingContext2D, w: number, h: number, ui: number, pal: Palette) => Drawer;

/** Nordlicht: breite, langsam wehende Lichtvorhänge. */
const aurora: StyleFactory = (ctx, w, h, _ui, pal) => {
  const curtains = [
    { shift: 0, x: 0.28, speed: 0.05, amp: 0.1, alpha: 0.2 },
    { shift: 40, x: 0.55, speed: 0.037, amp: 0.13, alpha: 0.17 },
    { shift: -35, x: 0.78, speed: 0.044, amp: 0.09, alpha: 0.15 },
  ];
  const strips = 64;
  return (t) => {
    ctx.globalCompositeOperation = "lighter";
    curtains.forEach((c, k) => {
      const sw = (w * 0.34) / strips;
      for (let i = 0; i < strips; i++) {
        const u = i / (strips - 1);
        const x = w * c.x + (u - 0.5) * w * 0.34 + Math.sin(t * c.speed * TAU + u * 3 + k) * w * c.amp;
        const wave = 0.55 + 0.45 * Math.sin(t * 0.3 + u * 6 + k * 2);
        const edge = Math.sin(u * Math.PI);
        const top = h * (0.08 + 0.12 * Math.sin(t * 0.07 + k + u * 2));
        const g = ctx.createLinearGradient(0, top, 0, h * 0.85);
        const a = c.alpha * 0.32 * edge * wave;
        g.addColorStop(0, glowColor(pal, 0, c.shift));
        g.addColorStop(0.35, glowColor(pal, a, c.shift));
        g.addColorStop(1, glowColor(pal, 0, c.shift));
        ctx.fillStyle = g;
        ctx.fillRect(x - sw * 2, top, sw * 5, h * 0.85 - top);
      }
    });
    ctx.globalCompositeOperation = "source-over";
  };
};

/** Sternenhimmel: funkelnde Sterne, ganz langsam wandernd, hin und wieder eine Sternschnuppe. */
const stars: StyleFactory = (ctx, w, h, ui, pal) => {
  const rand = mulberry32(7);
  const list = Array.from({ length: 190 }, () => ({
    x: rand(),
    y: rand(),
    r: (0.5 + rand() * 1.5) * Math.max(1, ui * 1.4),
    f: 0.4 + rand() * 1.6,
    p: rand() * TAU,
    z: 0.3 + rand() * 0.7,
  }));
  return (t) => {
    for (const s of list) {
      const x = mod(s.x * w + t * 2.2 * s.z * ui * 6, w);
      const a = (0.25 + 0.55 * s.z) * (0.55 + 0.45 * Math.sin(t * s.f + s.p));
      ctx.fillStyle = silk(pal, a);
      ctx.beginPath();
      ctx.arc(x, s.y * h, s.r, 0, TAU);
      ctx.fill();
    }
    // Sternschnuppe alle ~14 s für knapp 1,2 s
    const k = Math.floor(t / 14);
    const local = t - k * 14;
    if (local < 1.2) {
      const r2 = mulberry32(k + 3);
      const x0 = w * (0.2 + 0.6 * r2());
      const y0 = h * (0.1 + 0.3 * r2());
      const p = local / 1.2;
      const len = w * 0.12;
      const x = x0 + p * w * 0.22;
      const y = y0 + p * h * 0.14;
      const g = ctx.createLinearGradient(x - len, y - len * 0.6, x, y);
      g.addColorStop(0, silk(pal, 0));
      g.addColorStop(1, silk(pal, 0.85 * Math.sin(p * Math.PI)));
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1.2, ui * 2.2);
      ctx.beginPath();
      ctx.moveTo(x - len, y - len * 0.6);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  };
};

/** Tiefsee: aufsteigende Blasen und weiche Lichtstrahlen von oben. */
const bubbles: StyleFactory = (ctx, w, h, ui, pal) => {
  const rand = mulberry32(21);
  const list = Array.from({ length: 46 }, () => ({
    x: rand(),
    y: rand(),
    r: (4 + rand() * 18) * ui * 1.6,
    v: (14 + rand() * 30) * ui * 3,
    sway: 6 + rand() * 16,
    f: 0.3 + rand() * 0.6,
    p: rand() * TAU,
  }));
  return (t) => {
    // Lichtstrahlen
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 4; i++) {
      const x = w * (0.15 + i * 0.24) + Math.sin(t * 0.07 + i) * w * 0.04;
      const g = ctx.createLinearGradient(0, 0, 0, h * 0.8);
      g.addColorStop(0, glowColor(pal, 0.07));
      g.addColorStop(1, glowColor(pal, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.02, 0);
      ctx.lineTo(x + w * 0.02, 0);
      ctx.lineTo(x + w * 0.1, h * 0.8);
      ctx.lineTo(x - w * 0.06, h * 0.8);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    for (const b of list) {
      const y = h + b.r - mod(b.y * h + t * b.v, h + b.r * 2);
      const x = b.x * w + Math.sin(t * b.f + b.p) * b.sway * ui * 3;
      ctx.strokeStyle = silk(pal, 0.4);
      ctx.fillStyle = silk(pal, 0.06);
      ctx.lineWidth = Math.max(1, ui * 1.6);
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = silk(pal, 0.55);
      ctx.beginPath();
      ctx.arc(x - b.r * 0.35, y - b.r * 0.35, b.r * 0.18, 0, TAU);
      ctx.fill();
    }
  };
};

/** Neon-Gitter: Perspektivgitter, das auf den Betrachter zufährt. */
const grid: StyleFactory = (ctx, w, h, ui, pal) => (t) => {
  const horizon = h * 0.58;
  ctx.lineWidth = Math.max(1, ui * 1.8);
  ctx.strokeStyle = glowColor(pal, 0.7, 20);
  // Horizontale Linien: laufen nach unten und werden dabei größer
  const rows = 14;
  for (let i = 0; i < rows; i++) {
    const p = mod(i / rows + t * 0.05, 1);
    const y = horizon + (h - horizon) * p ** 2.2;
    ctx.globalAlpha = 0.15 + 0.85 * p;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // Vertikale Linien laufen im Fluchtpunkt zusammen
  const cols = 22;
  for (let i = -cols; i <= cols; i++) {
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(w / 2 + i * w * 0.012, horizon);
    ctx.lineTo(w / 2 + i * w * 0.2, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Horizont-Leuchten
  const g = ctx.createLinearGradient(0, horizon - h * 0.12, 0, horizon + h * 0.02);
  g.addColorStop(0, glowColor(pal, 0));
  g.addColorStop(1, glowColor(pal, 0.28, 20));
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon - h * 0.12, w, h * 0.14);
};

/**
 * PS3-Original: Das große, seidige Tuch der XMB. Mehrere breite Flächen mit hellem Rand liegen übereinander, darunter fächern
 * feine Fäden auf – alles dreht sich sehr langsam und wirft sanfte Falten. Die Farbe kommt aus dem Farbthema (Monatsfarbe).
 */
const xmb: StyleFactory = (ctx, w, h, ui, pal) => {
  const n = Math.max(40, Math.min(96, Math.ceil(w / 20)));
  const xs = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) xs[i] = (i / n) * w;
  const top = new Float32Array(n + 1);
  const low = new Float32Array(n + 1);

  // Jedes Tuch: Grundlinie (Anteil der Höhe), Welle 1+2, Dicke, Helligkeit, Farbverschiebung.
  const sheets = [
    { y: 0.56, tilt: -0.1, a1: 0.075, f1: 0.62, s1: 0.045, p1: 0.2, a2: 0.03, f2: 1.35, s2: -0.07, p2: 1.7, th: 0.2, fill: 0.1, edge: 0.34, shift: 10 },
    { y: 0.64, tilt: -0.07, a1: 0.085, f1: 0.55, s1: 0.04, p1: 1.0, a2: 0.035, f2: 1.2, s2: -0.06, p2: 3.1, th: 0.24, fill: 0.12, edge: 0.4, shift: 0 },
    { y: 0.72, tilt: -0.04, a1: 0.08, f1: 0.7, s1: -0.05, p1: 2.4, a2: 0.03, f2: 1.5, s2: 0.075, p2: 0.6, th: 0.2, fill: 0.09, edge: 0.3, shift: -12 },
    { y: 0.8, tilt: -0.02, a1: 0.07, f1: 0.5, s1: 0.035, p1: 4.1, a2: 0.025, f2: 1.1, s2: -0.05, p2: 2.2, th: 0.16, fill: 0.07, edge: 0.24, shift: 8 },
  ].map((d) => {
    const nominal = (d.y + d.tilt * 0.5) * h;
    const g = ctx.createLinearGradient(0, nominal - d.a1 * h, 0, nominal + d.th * h);
    g.addColorStop(0, silk(pal, d.fill * 2, d.shift));
    g.addColorStop(0.35, silk(pal, d.fill * 0.95, d.shift));
    g.addColorStop(1, silk(pal, 0, d.shift));
    return { ...d, body: g };
  });
  const line = (shift: number, a: number) => silk(pal, a, shift);
  const strands = 16;

  const curve = (d: (typeof sheets)[number], t: number, u: number, k: number) =>
    (d.y + d.tilt * (u - 0.5) + d.a1 * Math.sin(TAU * d.f1 * u + d.s1 * t + d.p1 + k) + d.a2 * Math.sin(TAU * d.f2 * u + d.s2 * t + d.p2 + k * 1.7)) * h;

  return (t) => {
    ctx.lineJoin = "round";
    sheets.forEach((d, si) => {
      const breathe = 0.85 + 0.15 * Math.sin(t * 0.13 + si * 1.9);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        top[i] = curve(d, t, u, 0);
        // Dicke schwillt entlang des Tuchs an und ab, an den Rändern läuft es spitz zu.
        const bulge = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, u * 0.9 + 0.05))) ** 0.8;
        low[i] = top[i] + d.th * h * bulge * (0.8 + 0.2 * Math.sin(TAU * 0.9 * u + t * 0.05 + si));
      }
      ctx.globalAlpha = breathe;
      ctx.beginPath();
      ctx.moveTo(xs[0], top[0]);
      for (let i = 1; i <= n; i++) ctx.lineTo(xs[i], top[i]);
      for (let i = n; i >= 0; i--) ctx.lineTo(xs[i], low[i]);
      ctx.closePath();
      ctx.fillStyle = d.body;
      ctx.fill();

      // Feine Fäden zwischen Ober- und Unterkante: die Falten des Stoffs.
      ctx.lineWidth = Math.max(0.8, ui * 1.1);
      for (let k = 1; k < strands; k += 1) {
        const q = k / strands;
        ctx.strokeStyle = line(d.shift, d.edge * 0.28 * (1 - q) * breathe);
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const y = top[i] + (low[i] - top[i]) * q ** 1.4 + Math.sin(TAU * 1.3 * (i / n) + t * 0.08 + k * 0.5) * h * 0.006 * q;
          if (i === 0) ctx.moveTo(xs[i], y);
          else ctx.lineTo(xs[i], y);
        }
        ctx.stroke();
      }

      // Heller Rand mit weichem Schein darunter.
      ctx.beginPath();
      ctx.moveTo(xs[0], top[0]);
      for (let i = 1; i <= n; i++) ctx.lineTo(xs[i], top[i]);
      ctx.strokeStyle = line(d.shift, d.edge * 0.22 * breathe);
      ctx.lineWidth = Math.max(4, ui * 7);
      ctx.stroke();
      ctx.strokeStyle = line(d.shift, d.edge * breathe);
      ctx.lineWidth = Math.max(1, ui * 1.6);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  };
};

export const STYLES: Record<string, StyleFactory> = { xmb, aurora, stars, bubbles, grid };
