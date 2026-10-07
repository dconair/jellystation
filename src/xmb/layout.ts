/**
 * Geometrie der XMB in rem (1rem = 1/54 der Bildschirmhöhe, siehe index.css).
 * Alle Positionen werden in React berechnet und per CSS-Transition animiert.
 *
 * Sicherer Bereich: Die Oberfläche ist für mindestens 96 × 54 rem gebaut (16:9).
 * Breitere Fenster bekommen nur mehr Leerraum rechts, höhere (4:3) mehr oben/unten.
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
/** Zusätzlicher Abstand der Einträge oberhalb der Leiste (aus den Werten oben abgeleitet). */
export const ABOVE_GAP = FOCUS_Y - ITEM_PITCH - ABOVE_Y;

/** Wie viele Einträge um den Fokus herum überhaupt gerendert werden (der Rest ist unsichtbar). */
export const ITEM_WINDOW = 8;
/** Bis zu dieser Entfernung zum Fokus lädt ein Eintrag sein Cover. */
export const ART_RANGE = 5;

export const categoryX = (index: number, active: number) =>
  ANCHOR_X + (index - active) * CATEGORY_PITCH;

export const itemY = (index: number, focus: number, pitch: number = ITEM_PITCH) => {
  const delta = index - focus;
  if (delta === 0) return FOCUS_Y;
  // Oberhalb der Leiste: fester Anker, damit nichts in die Kategorie-Icons ragt.
  if (delta < 0) return ABOVE_Y + (delta + 1) * pitch;
  return FOCUS_Y + FOCUS_GAP + delta * pitch;
};

/** Einträge verblassen mit wachsender Entfernung zum Fokus; oberhalb der Leiste schneller. */
export const itemOpacity = (index: number, focus: number) => {
  const delta = index - focus;
  if (delta === 0) return 1;
  if (delta < 0) return delta === -1 ? 0.55 : delta === -2 ? 0.16 : 0;
  return Math.max(0, 0.86 - (delta - 1) * 0.22);
};
