// Hintergrundfarbe wechselt wie auf der PS3 mit dem Monat.
const monthHues = [215, 265, 130, 330, 100, 190, 20, 160, 285, 35, 230, 0];

export interface Palette {
  /** Ändert sich nur, wenn Monat oder Tageszeit-Stufe wechseln (zum Neuaufbau der Verläufe). */
  key: string;
  hue: number;
  /** 0 = Tag, 1 = tiefe Nacht. */
  night: number;
  top: string;
  mid: string;
  bottom: string;
}

// Ziel-Helligkeit (relative Luminanz) der Verlaufsstufen am Tag. Über die Luminanz statt über
// HSL-Helligkeit bleibt jeder Farbton gleich hell – Gelb/Grün wirkt sonst viel greller als Blau
// und der weiße Text verlöre dort an Kontrast.
const Y_TOP = 0.1;
const Y_MID = 0.04;
const Y_BOTTOM = 0.008;
/** Nachts ist der Verlauf auf diesen Anteil abgedunkelt. */
const NIGHT_FACTOR = 0.55;

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hslLuminance(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return 0.2126 * linear(f(0)) + 0.7152 * linear(f(8)) + 0.0722 * linear(f(4));
}

/** HSL-Helligkeit (0..1), bei der der Farbton h mit Sättigung s die Luminanz y erreicht. */
function lightnessFor(h: number, s: number, y: number) {
  let lo = 0.02;
  let hi = 0.9;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (hslLuminance(h, s, mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const css = (h: number, s: number, y: number) =>
  `hsl(${h} ${Math.round(s * 100)}% ${(lightnessFor(h, s, y) * 100).toFixed(1)}%)`;

/** Nachtfaktor 0..1: um 14 Uhr 0, um 2 Uhr nachts 1, dazwischen weich. */
export function nightAt(date: Date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  return 0.5 - 0.5 * Math.cos(((hour - 14) / 24) * Math.PI * 2);
}

export function paletteFor(date: Date): Palette {
  const hue = monthHues[date.getMonth()];
  // In Zehn-Minuten-Stufen gerechnet: so ändert sich der Verlauf ohne sichtbaren Sprung.
  const step = Math.floor((date.getHours() * 60 + date.getMinutes()) / 10);
  const night = nightAt(new Date(2000, 0, 1, 0, step * 10));
  const k = 1 - (1 - NIGHT_FACTOR) * night;
  return {
    key: `${date.getMonth()}:${step}`,
    hue,
    night,
    top: css(hue, 0.72, Y_TOP * k),
    mid: css(hue, 0.68, Y_MID * k),
    bottom: css(hue, 0.62, Y_BOTTOM * k),
  };
}

/** Helles, leicht eingefärbtes Weiß (wie die seidigen Bänder der PS3) mit Alpha. */
export const silk = (p: Palette, alpha: number, shift = 0) =>
  `hsl(${(p.hue + shift + 360) % 360} 70% 88% / ${alpha})`;

/** Kräftigere Farbe des Farbtons für Lichtschein und Dunst. */
export const glowColor = (p: Palette, alpha: number, shift = 0) =>
  `hsl(${(p.hue + shift + 360) % 360} 85% 62% / ${alpha})`;
