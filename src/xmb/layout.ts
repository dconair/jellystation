/**
 * Geometrie der XMB in rem (1rem = 1/54 der Bildschirmhöhe, siehe index.css).
 * Alle Positionen werden in React berechnet und per CSS-Transition animiert.
 */
export const ANCHOR_X = 15; // x-Mitte der ausgewählten Kategorie
export const CATEGORY_PITCH = 8.6; // Abstand zwischen Kategorien
export const ROW_Y = 14; // y-Mitte der Kategorie-Leiste
export const FOCUS_Y = ROW_Y + 7.6; // y-Mitte des fokussierten Eintrags
export const ITEM_PITCH = 5.4; // Abstand zwischen Einträgen
export const ABOVE_GAP = 6.6; // zusätzlicher Abstand, damit Einträge über der Leiste Platz lassen

export const categoryX = (index: number, active: number) =>
  ANCHOR_X + (index - active) * CATEGORY_PITCH;

export const itemY = (index: number, focus: number) => {
  const delta = index - focus;
  return FOCUS_Y + delta * ITEM_PITCH - (delta < 0 ? ABOVE_GAP : 0);
};

/** Einträge verblassen mit wachsender Entfernung zum Fokus; oberhalb der Leiste schneller. */
export const itemOpacity = (index: number, focus: number) => {
  const delta = index - focus;
  if (delta === 0) return 1;
  if (delta < 0) return Math.max(0, 0.6 + (delta + 1) * 0.35);
  return Math.max(0, 0.82 - (delta - 1) * 0.13);
};
