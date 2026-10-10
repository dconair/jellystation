import { evalCurve, makeCurve } from "./motion";
import type { Curve } from "./motion";

/**
 * Geometrie der XMB in rem (1rem = 1/54 der Bildschirmhöhe, siehe index.css).
 *
 * Die Werte beschreiben das RUHELAYOUT (ganzzahlige Abstände d = Index − Position). Zwischen den ganzzahligen
 * Abständen laufen stetige Kurven durch genau diese Werte; die Bewegung selbst (Feder, Streckung, Schweben)
 * steht in motion.ts, ihre Anwendung auf die Knoten in MotionEngine.ts.
 *
 * Sicherer Bereich: Die Oberfläche ist für mindestens 96 × 54 rem gebaut (16:9). Breitere Fenster bekommen
 * nur mehr Leerraum rechts, höhere (4:3) mehr oben/unten.
 */
export const ANCHOR_X = 15; // x-Mitte der ausgewählten Kategorie
export const CATEGORY_PITCH = 8.6; // Abstand zwischen Kategorien
export const ROW_Y = 13.5; // y-Mitte der Kategorie-Leiste
export const FOCUS_Y = ROW_Y + 9.7; // y-Mitte des fokussierten Eintrags (unter dem Kategorie-Label)

/** Abstand zwischen Einträgen mit quadratischer Icon-Kachel. */
export const ITEM_PITCH = 5.3;
/** Abstand zwischen Einträgen mit Cover-Kachel (Querformat, höher als die Icon-Kachel). */
export const ITEM_PITCH_ART = 6.2;
/** Zusätzlicher Platz unter dem fokussierten Eintrag: Er ist größer skaliert und braucht Luft. */
export const FOCUS_GAP = 0.6;
/** y-Mitte des ersten Eintrags oberhalb der Leiste (Unterkante bleibt über dem Kategorie-Icon). */
export const ABOVE_Y = ROW_Y - 5.9;

/** Skalierung des aktiven Kategorie-Icons und des fokussierten Eintrags (Icon-Kachel / Cover). */
export const CATEGORY_FOCUS_SCALE = 1.4;
export const ITEM_FOCUS_SCALE_TILE = 1.24;
export const ITEM_FOCUS_SCALE_COVER = 1.2;

/** Bis zu dieser Entfernung zum Fokus lädt ein Eintrag sein Cover. */
export const ART_RANGE = 5;

/**
 * Render-Fenster je Spalte (in Einträgen relativ zur Position): Außerhalb von ITEM_D_MIN … ITEM_D_MAX ist ein
 * Eintrag völlig durchsichtig. Das Fenster ist um je einen Eintrag größer, damit jeder Eintrag, der ein- oder
 * ausgehängt wird, schon (noch) Deckkraft 0 hat – so poppt nichts an den Rändern.
 */
export const ITEM_D_MIN = -3;
export const ITEM_D_MAX = 5;
export const WINDOW_BEFORE = 4;
export const WINDOW_AFTER = 6;

/* ------------------------------------------------------------------ Kategorien (waagerecht) */

/** x-Mitte einer Kategorie bei Abstand d (= Platz − Position) zur Leiste. */
export const categoryXAt = (d: number) => ANCHOR_X + d * CATEGORY_PITCH;

/** Deckkraft nach Abstand |d|: aktiv 1, Nachbarn 0,6, dann je Platz −0,1 bis 0,14. */
const categoryOpacityCurve: Curve = (() => {
  const c = makeCurve(0, [1, 0.6, 0.5, 0.4, 0.3, 0.2, 0.14, 0.14]);
  c.slopes[0] = 0; // gerade Funktion: an der Leiste keine Spitze
  return c;
})();
export const categoryOpacityAt = (d: number) => evalCurve(categoryOpacityCurve, Math.abs(d));

/* ------------------------------------------------------------------ Einträge (senkrecht) */

/** Ruhe-y (rem) eines Eintrags bei ganzzahligem Abstand d zum Fokus. */
export const itemRestY = (d: number, pitch: number) => {
  if (d === 0) return FOCUS_Y;
  // Oberhalb der Leiste: fester Anker, damit nichts in die Kategorie-Icons ragt.
  if (d < 0) return ABOVE_Y + (d + 1) * pitch;
  return FOCUS_Y + FOCUS_GAP + d * pitch;
};

/** Ruhe-Deckkraft bei ganzzahligem Abstand: Einträge verblassen mit der Entfernung, oberhalb der Leiste schneller. */
export const itemRestOpacity = (d: number) => {
  if (d === 0) return 1;
  if (d < 0) return d === -1 ? 0.55 : d === -2 ? 0.16 : 0;
  return Math.max(0, 0.86 - (d - 1) * 0.22);
};

const D_FIRST = ITEM_D_MIN - 1;
const D_LAST = ITEM_D_MAX + 1;
const knots = Array.from({ length: D_LAST - D_FIRST + 1 }, (_, i) => D_FIRST + i);

const opacityCurve: Curve = makeCurve(D_FIRST, knots.map(itemRestOpacity));
const yCurves = new Map<number, Curve>();

/** Stetige y-Kurve (rem) einer Spalte mit dem gegebenen Zeilenabstand; läuft exakt durch das Ruhelayout. */
export function itemYCurve(pitch: number): Curve {
  let c = yCurves.get(pitch);
  if (!c) {
    c = makeCurve(D_FIRST, knots.map((d) => itemRestY(d, pitch)));
    yCurves.set(pitch, c);
  }
  return c;
}

/** Deckkraft eines Eintrags bei (gebrochenem) Abstand d zum Fokus. */
export const itemOpacityAt = (d: number) => {
  if (d <= ITEM_D_MIN || d >= ITEM_D_MAX) return 0;
  const o = evalCurve(opacityCurve, d);
  return o < 0 ? 0 : o > 1 ? 1 : o;
};

/** y-Mitte (rem) eines Eintrags bei (gebrochenem) Abstand d zum Fokus. */
export const itemYAt = (d: number, curve: Curve) => evalCurve(curve, d);

/** Ableitung dy/dd (rem pro Eintrag) – für die geschwindigkeitsabhängige Streckung. */
export const itemYSlopeAt = (d: number, curve: Curve) => {
  const h = 0.02;
  return (evalCurve(curve, d + h) - evalCurve(curve, d - h)) / (2 * h);
};
