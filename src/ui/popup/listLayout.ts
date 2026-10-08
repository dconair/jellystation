import type { PopupItem } from "./types";

/*
 * Geometrie von PopupList in rem. Jede Zeile hat eine feste Höhe, die sich nur aus ihrem Typ ergibt
 * (Text wird nie umbrochen, sondern gekürzt). Dadurch sitzt der wandernde Fokusbalken ohne jede Messung
 * exakt auf der Zeile, und das Scrollen lässt sich vorab berechnen – es gibt keine Layout-Sprünge.
 */
export const ROW = {
  /** Nur ein Name. */
  plain: 3.6,
  /** Name + gedimmte Zeile darunter. */
  detail: 4.6,
  /** Zeile mit 16:9-Kachel. */
  art: 5.7,
  /** Zusatz für den Fortschrittsbalken unter dem Text (bei Kacheln liegt er auf dem Bild). */
  progressExtra: 0.75,
  /** Abschnittsüberschrift inkl. Abstand nach oben … */
  header: 3.4,
  /** … und als allererste Zeile (ohne Abstand). */
  headerFirst: 2.4,
} as const;

/** Luft oberhalb der ersten und unterhalb der letzten Zeile: Platz für das Leuchten und die Kantenabblendung. */
export const PAD = 1;

/** Wie viel Kontext (rem) beim Scrollen hinter dem Fokus sichtbar bleibt. */
const CONTEXT = 3.4;

export interface Slot {
  item: PopupItem;
  /** Position in `items`. */
  index: number;
  /** Oberkante in rem, gemessen vom Anfang der Liste (inkl. PAD). */
  top: number;
  height: number;
  /** Anwählbar: keine Überschrift und nicht deaktiviert. */
  selectable: boolean;
  /** Position unter den anwählbaren Zeilen (-1 = nicht anwählbar). */
  selPos: number;
}

export interface Layout {
  slots: Slot[];
  /** Gesamthöhe in rem. */
  total: number;
  /** Indizes (in `slots`) der anwählbaren Zeilen. */
  selectable: number[];
  byId: Map<string, Slot>;
  /** Mindestens eine Zeile hat Status oder Häkchen: dann bekommen alle eine Spalte dafür. */
  hasLead: boolean;
}

export const isSelectable = (item: PopupItem) => !item.header && !item.disabled;

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function rowHeight(item: PopupItem, first: boolean): number {
  if (item.header) return first ? ROW.headerFirst : ROW.header;
  if (item.art) return ROW.art;
  const base = item.detail ? ROW.detail : ROW.plain;
  return item.progress !== undefined ? base + ROW.progressExtra : base;
}

export function computeLayout(items: readonly PopupItem[]): Layout {
  const slots: Slot[] = [];
  const selectable: number[] = [];
  const byId = new Map<string, Slot>();
  let y = PAD;
  let hasLead = false;
  items.forEach((item, index) => {
    const height = rowHeight(item, index === 0);
    const sel = isSelectable(item);
    const slot: Slot = { item, index, top: y, height, selectable: sel, selPos: sel ? selectable.length : -1 };
    if (sel) selectable.push(index);
    if (!item.header && (item.status !== undefined || item.checked)) hasLead = true;
    if (!byId.has(item.id)) byId.set(item.id, slot);
    slots.push(slot);
    y += height;
  });
  return { slots, total: y + PAD, selectable, byId, hasLead };
}

/** Anfangsfokus: gewünschte id, sonst die erste „abgehakte“ Zeile (aktuelle Auswahl), sonst die erste anwählbare. */
export function initialFocus(layout: Layout, wanted: string | undefined): string | null {
  if (wanted !== undefined) {
    const slot = layout.byId.get(wanted);
    if (slot?.selectable) return wanted;
  }
  for (const i of layout.selectable) if (layout.slots[i].item.checked) return layout.slots[i].item.id;
  return layout.selectable.length ? layout.slots[layout.selectable[0]].item.id : null;
}

/**
 * Fokus nach einer Änderung der Liste: bleibt die Zeile erhalten, bleibt der Fokus; verschwindet sie,
 * rückt der Fokus auf die nächste anwählbare Zeile an derselben Stelle (sonst die davor).
 */
export function resolveFocus(layout: Layout, id: string | null, lastIndex: number): string | null {
  if (id !== null && layout.byId.get(id)?.selectable) return id;
  if (layout.selectable.length === 0) return null;
  for (const i of layout.selectable) if (i >= lastIndex) return layout.slots[i].item.id;
  return layout.slots[layout.selectable[layout.selectable.length - 1]].item.id;
}

/**
 * Neuer Scroll-Versatz (rem), damit die fokussierte Zeile samt etwas Kontext sichtbar ist. Liegt sie schon
 * im sichtbaren Bereich, ändert sich nichts; bei weiten Sprüngen wird sie in die Mitte gesetzt.
 */
export function nextScroll(current: number, slot: Slot | null, total: number, viewH: number): number {
  const max = Math.max(0, total - viewH);
  let s = Math.min(max, Math.max(0, current));
  if (!slot || viewH <= 0) return s;
  const margin = Math.min(CONTEXT, Math.max(0, (viewH - slot.height) / 2));
  const top = slot.top - margin;
  const bottom = slot.top + slot.height + margin;
  if (top >= s && bottom <= s + viewH) return s;
  const jump = top < s ? s - top : bottom - (s + viewH);
  if (jump > viewH * 0.6) s = slot.top + slot.height / 2 - viewH / 2;
  else if (top < s) s = top;
  else s = bottom - viewH;
  return Math.min(max, Math.max(0, s));
}
