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
 * PS3-Original: das seidige Band der XMB. Wie auf der Konsole ist es ein einziges, verdrehtes Tuch aus vielen feinen Fäden: In der Mitte
 * fächern die Fäden weit auf, an den Rändern und an den Engstellen drängen sie sich zusammen und leuchten dort hell auf. Ein zweites,
 * leiseres Band liegt dahinter; dazu funkeln einzelne Lichtpunkte. Das Ganze driftet sehr langsam; die Farbe kommt aus dem Farbthema.
 */
const xmb: StyleFactory = (ctx, w, h, ui, pal) => {
  const n = Math.max(48, Math.min(120, Math.ceil(w / 16)));
  const xs = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) xs[i] = (i / n) * w;
  const mid = new Float32Array(n + 1);
  const half = new Float32Array(n + 1);
  const twist = new Float32Array(n + 1);

  // y/amp: Lage und Schwung (Anteile der Höhe); wid: größte halbe Breite; fil: Zahl der Fäden; gain: Helligkeit.
  const ribbons = [
    { y: 0.68, tilt: -0.2, a1: 0.095, f1: 0.5, s1: 0.05, p1: 0.4, a2: 0.03, f2: 1.1, s2: -0.07, p2: 1.9, wid: 0.17, wf: 0.6, ws: 0.045, wp: 0.3, fil: 30, gain: 1, shift: 6 },
    { y: 0.78, tilt: -0.12, a1: 0.07, f1: 0.62, s1: -0.04, p1: 2.6, a2: 0.025, f2: 1.4, s2: 0.06, p2: 0.7, wid: 0.11, wf: 0.8, ws: -0.05, wp: 2.2, fil: 22, gain: 0.55, shift: -10 },
    { y: 0.56, tilt: -0.06, a1: 0.05, f1: 0.42, s1: 0.035, p1: 4.4, a2: 0.02, f2: 1.7, s2: -0.05, p2: 3.1, wid: 0.05, wf: 1.1, ws: 0.06, wp: 4.0, fil: 12, gain: 0.35, shift: 14 },
  ];
  const lw = Math.max(0.8, ui * 1.05);

  const rand = mulberry32(11);
  const glints = Array.from({ length: 70 }, () => ({
    x: rand(),
    y: 0.12 + rand() * 0.8,
    r: (0.7 + rand() * 1.5) * Math.max(1, ui * 1.3),
    f: 0.25 + rand() * 0.7,
    p: rand() * TAU,
    big: rand() > 0.88,
  }));

  return (t) => {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "lighter";
    ribbons.forEach((d, ri) => {
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        mid[i] =
          (d.y + d.tilt * (u - 0.5) + d.a1 * Math.sin(TAU * d.f1 * u + d.s1 * t + d.p1) + d.a2 * Math.sin(TAU * d.f2 * u + d.s2 * t + d.p2)) * h;
        // Engstellen: dort läuft das Band fast zu einer Linie zusammen.
        const m = 0.5 + 0.5 * Math.sin(TAU * d.wf * u + d.ws * t + d.wp);
        half[i] = d.wid * h * (0.16 + 0.84 * m ** 1.2);
        // Verdrehung: bestimmt, wo sich die Fäden drängen und wo sie auffächern.
        twist[i] = 1.1 * Math.sin(TAU * 0.55 * u + 0.05 * t + d.p1 + ri);
      }
      const breathe = 0.82 + 0.18 * Math.sin(t * 0.13 + ri * 2.1);
      const g = d.gain * breathe;

      // Weiche Fläche des Bandes.
      ctx.beginPath();
      for (let i = 0; i <= n; i++) (i ? ctx.lineTo(xs[i], mid[i] - half[i]) : ctx.moveTo(xs[0], mid[0] - half[0]));
      for (let i = n; i >= 0; i--) ctx.lineTo(xs[i], mid[i] + half[i]);
      ctx.closePath();
      ctx.fillStyle = silk(pal, 0.08 * g, d.shift);
      ctx.fill();

      // Die feinen Fäden. Winkel a verteilt sie über die Bandbreite; an a = ±π/2 (den Rändern) liegen sie dicht beieinander.
      ctx.lineWidth = lw;
      for (let k = 0; k < d.fil; k++) {
        const s = (k / (d.fil - 1)) * 2 - 1;
        const edge = Math.abs(s);
        ctx.strokeStyle = silk(pal, g * (0.1 + 0.28 * edge ** 2), d.shift + s * 8);
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const a = Math.max(-1.45, Math.min(1.45, s * 1.25 + twist[i] * 0.55 * (1 - edge * 0.4)));
          const y = mid[i] + half[i] * Math.sin(a);
          if (i === 0) ctx.moveTo(xs[0], y);
          else ctx.lineTo(xs[i], y);
        }
        ctx.stroke();
      }

      // Leuchtende Ränder: breiter Schein darunter, feine helle Kante obenauf.
      for (const q of [-1, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const y = mid[i] + q * half[i] * 0.97;
          if (i === 0) ctx.moveTo(xs[0], y);
          else ctx.lineTo(xs[i], y);
        }
        ctx.strokeStyle = silk(pal, 0.05 * g, d.shift);
        ctx.lineWidth = Math.max(6, ui * 14);
        ctx.stroke();
        ctx.strokeStyle = silk(pal, 0.1 * g, d.shift);
        ctx.lineWidth = Math.max(2.5, ui * 4.5);
        ctx.stroke();
        ctx.strokeStyle = silk(pal, 0.42 * g, d.shift);
        ctx.lineWidth = lw * 1.3;
        ctx.stroke();
      }
    });

    // Funkelnde Lichtpunkte, einige mit kleinem Kreuzglanz.
    for (const s of glints) {
      const tw = 0.5 + 0.5 * Math.sin(t * s.f + s.p);
      const a = tw * tw;
      if (a < 0.03) continue;
      const x = s.x * w;
      const y = s.y * h;
      ctx.fillStyle = silk(pal, 0.55 * a);
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, TAU);
      ctx.fill();
      if (s.big) {
        const l = s.r * 7 * a;
        ctx.strokeStyle = silk(pal, 0.35 * a);
        ctx.lineWidth = Math.max(0.8, ui);
        ctx.beginPath();
        ctx.moveTo(x - l, y);
        ctx.lineTo(x + l, y);
        ctx.moveTo(x, y - l);
        ctx.lineTo(x, y + l);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = "source-over";
  };
};

export const STYLES: Record<string, StyleFactory> = { xmb, aurora, stars, bubbles, grid };
