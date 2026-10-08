import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import { ArtImage } from "../../art/ArtImage";
import type { XmbEntry } from "../../data/types";
import type { PadAction } from "../../input/useGamepad";
import { playSfx } from "../../xmb/sound";
import { MaybeFrame, useFrameClaim } from "./OverlayFrame";
import type { OverlayAlign } from "./OverlayFrame";
import { CheckIcon, DotSpinner, HintBar, useResizeGuard } from "./parts";
import { clamp01, computeLayout, initialFocus, nextScroll, resolveFocus } from "./listLayout";
import type { Slot } from "./listLayout";
import type { HintAction, PopupFooter, PopupHint, PopupItem, PopupWidth } from "./types";
import { useOverlayInput } from "./useOverlayInput";
import "./popup.css";

export interface PopupListProps {
  title: string;
  subtitle?: string;
  items: readonly PopupItem[];
  /**
   * Gewünschter Fokus. Ändert sich der Wert, springt der Fokus dorthin (sobald die Zeile existiert);
   * dazwischen bewegt der Nutzer ihn frei. Ohne Angabe: die „abgehakte“ Zeile, sonst die erste anwählbare.
   */
  focusId?: string | null;
  /** ✕ / Enter / Klick auf die fokussierte Zeile. */
  onSelect: (id: string, item: PopupItem) => void;
  /** ○ / Esc / Backspace / Klick neben das Panel. */
  onBack: () => void;
  /** △ / O (Optionen) mit der fokussierten Zeile (null, wenn keine fokussiert ist). Ohne diese Funktion gibt es keinen △-Hinweis. */
  onAlt?: (id: string | null, item: PopupItem | null) => void;
  altLabel?: string;
  /** □ (Zusatzfunktion), sonst wie onAlt. */
  onSquare?: (id: string | null, item: PopupItem | null) => void;
  squareLabel?: string;
  /** Der Fokus hat sich geändert (auch beim ersten Anzeigen), z. B. für eine Vorschau. */
  onFocusChange?: (id: string | null, item: PopupItem | null) => void;
  /** Ersetzt die Hinweisleiste vollständig (Standard: ✕ Auswählen, ○ Zurück, ggf. △ altLabel, □ squareLabel). */
  hints?: readonly PopupHint[];
  /** Statuszeile über der Hinweisleiste, z. B. eine Fehlermeldung. */
  footer?: string | PopupFooter;
  /** false = sichtbar, aber gedimmt und ohne Eingabe (z. B. weil ein Dialog darüber liegt). */
  active?: boolean;
  width?: PopupWidth;
  /** Text bei leerer Liste. */
  emptyText?: string;
  /** Hintergrundarbeit läuft: Ladeanzeige im Kopf. */
  busy?: boolean;
  /** false = kein eigener OverlayFrame (z. B. wenn die Liste in einen eigenen eingebettet wird). Standard: true. */
  frame?: boolean;
  align?: OverlayAlign;
  dim?: boolean | number;
}

/* ------------------------------------------------------------------ Zeile */

interface RowProps {
  item: PopupItem;
  id: string;
  top: number;
  height: number;
  focused: boolean;
  lead: boolean;
  artActive: boolean;
}

const sameSource = (a: XmbEntry["art"], b: XmbEntry["art"]) => {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  if (a.kind === "http" && b.kind === "http") return a.url === b.url && JSON.stringify(a.headers) === JSON.stringify(b.headers);
  return true;
};

const sameArt = (a?: XmbEntry, b?: XmbEntry) =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.hue === b.hue &&
    a.artShape === b.artShape &&
    !!a.game === !!b.game &&
    sameSource(a.art, b.art));

/** Die Eltern erzeugen die Einträge oft bei jedem Rendern neu – gleicher Inhalt soll die Zeile nicht neu zeichnen. */
const sameItem = (a: PopupItem, b: PopupItem) =>
  a === b ||
  (a.id === b.id &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.status === b.status &&
    a.checked === b.checked &&
    a.disabled === b.disabled &&
    a.header === b.header &&
    a.progress === b.progress &&
    a.trailing === b.trailing &&
    sameArt(a.art, b.art));

const rowEqual = (a: RowProps, b: RowProps) =>
  a.id === b.id &&
  a.top === b.top &&
  a.height === b.height &&
  a.focused === b.focused &&
  a.lead === b.lead &&
  a.artActive === b.artActive &&
  sameItem(a.item, b.item);

function RowView({ item, id, top, height, focused, lead, artActive }: RowProps) {
  // Jede Zeile steht mit eigenem `top` an ihrer Stelle. Im normalen Fluss würde das Layout jede Höhe auf 1/64 px
  // kürzen, und die Fehler summierten sich bei langen Listen zu Pixeln – der Fokusbalken säße schief.
  const style = { top: `${top}rem`, height: `${height}rem` };
  if (item.header) {
    return (
      <div className="pop-section" role="presentation" style={style}>
        <span>{item.label}</span>
      </div>
    );
  }
  const p = item.progress !== undefined ? clamp01(item.progress) : null;
  const percent = p === null ? undefined : Math.round(p * 100);
  const cls = `pop-row${focused ? " is-focused" : ""}${item.disabled ? " is-disabled" : ""}${item.art ? " has-art" : ""}`;
  return (
    <div
      id={id}
      role="option"
      data-pop-id={item.id}
      aria-selected={focused}
      aria-disabled={item.disabled || undefined}
      aria-checked={item.checked}
      className={cls}
      style={style}
    >
      <div className="pop-row__inner">
        {lead && (
          <span className="pop-row__lead">
            {item.status === "busy" ? (
              <DotSpinner size="1.6rem" dots={10} />
            ) : item.status ? (
              <i className={`pop-dot is-${item.status}`} />
            ) : item.checked ? (
              <CheckIcon className="pop-check" />
            ) : null}
          </span>
        )}
        {item.art && (
          <span className="pop-row__art" aria-hidden="true">
            <ArtImage entry={item.art} active={artActive} />
            {p !== null && (
              <span className="pop-progress pop-progress--art">
                <i style={{ width: `${p * 100}%` }} />
              </span>
            )}
          </span>
        )}
        <span className="pop-row__text">
          <span className="pop-row__label">{item.label}</span>
          {item.detail && <span className="pop-row__detail">{item.detail}</span>}
          {p !== null && !item.art && (
            <span className="pop-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <i style={{ width: `${p * 100}%` }} />
            </span>
          )}
        </span>
        {item.trailing && <span className="pop-row__trailing">{item.trailing}</span>}
        {item.status && item.checked && <CheckIcon className="pop-check pop-check--end" />}
      </div>
    </div>
  );
}

const Row = memo(RowView, rowEqual);

/* ------------------------------------------------------------------ Liste */

const rootFontPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
/** Bilder werden für Zeilen geladen, die höchstens so weit (rem) neben dem sichtbaren Bereich liegen. */
const ART_MARGIN = 8;

const rowIdOf = (target: EventTarget | null): string | null => {
  const el = target instanceof Element ? target.closest("[data-pop-id]") : null;
  return el ? el.getAttribute("data-pop-id") : null;
};

/**
 * Liste im Stil des PS3-Kontextmenüs. Der Fokus ist ein einziger Leuchtbalken, der zur Zeile gleitet (Transform
 * mit Überschwingen) – die Zeilen selbst bewegen sich nicht. Lange Listen scrollen so, dass der Fokus sichtbar
 * bleibt. Bedienung: ↑↓ / D-Pad / Stick, ✕ / Enter wählt, ○ / Esc geht zurück, △ / O löst onAlt aus, L1/R1 (Q/E,
 * Bild↑/↓) blättern, Pos1/Ende springen, Mausrad bewegt den Fokus, Mausklick wählt.
 */
export function PopupList(props: PopupListProps) {
  const {
    title,
    subtitle,
    items,
    focusId: focusProp,
    onAlt,
    altLabel = "Optionen",
    onSquare,
    squareLabel = "Aktion",
    hints,
    footer,
    active = true,
    width = "normal",
    emptyText,
    busy = false,
    frame = true,
    align,
    dim,
  } = props;

  const focusId = focusProp ?? undefined;
  const uid = useId();
  const titleId = `${uid}-title`;
  const subtitleId = `${uid}-sub`;
  const panelRef = useRef<HTMLElement>(null);
  useFrameClaim();
  useResizeGuard(panelRef);

  const propsRef = useRef(props);
  propsRef.current = props;

  const layout = useMemo(() => computeLayout(items), [items]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /* ---- Fokus (per id; verschwindet die Zeile, rückt er auf die nächste) ---- */

  const [focusedId, setFocusedId] = useState<string | null>(() => initialFocus(layout, focusId));
  const focusRef = useRef<string | null>(focusedId);
  const lastIndex = useRef(0);
  const resolvedId = resolveFocus(layout, focusedId, lastIndex.current);
  const focusSlot: Slot | null = resolvedId !== null ? (layout.byId.get(resolvedId) ?? null) : null;

  useEffect(() => {
    if (focusSlot) lastIndex.current = focusSlot.index;
    // Nur bei einer Korrektur (Zeile verschwunden) nachziehen – sonst könnte ein verspäteter Effekt den
    // Fokus, den eine schnelle Wiederholung gerade weitergesetzt hat, auf den alten Stand zurückdrehen.
    if (resolvedId !== focusedId) {
      focusRef.current = resolvedId;
      setFocusedId(resolvedId);
    }
  }, [resolvedId, focusedId, focusSlot]);

  // focusId von außen: neuer Wert = neuer Wunsch, der erfüllt wird, sobald die Zeile existiert.
  const wanted = useRef<string | undefined>(focusId);
  const lastFocusProp = useRef(focusId);
  useEffect(() => {
    if (lastFocusProp.current === focusId) return;
    lastFocusProp.current = focusId;
    wanted.current = focusId;
  }, [focusId]);
  useEffect(() => {
    const id = wanted.current;
    if (id === undefined) return;
    if (!layout.byId.get(id)?.selectable) return;
    wanted.current = undefined;
    if (focusRef.current !== id) {
      focusRef.current = id;
      setFocusedId(id);
    }
  }, [layout, focusId]);

  const reported = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (reported.current === resolvedId) return;
    reported.current = resolvedId;
    propsRef.current.onFocusChange?.(resolvedId, focusSlot?.item ?? null);
  }, [resolvedId, focusSlot]);

  /** Fokus setzen (Nutzeraktion): sofort in der Ref, damit schnelle Wiederholungen aufeinander aufbauen. */
  const focusTo = (id: string, sound: boolean) => {
    if (focusRef.current === id) return false;
    wanted.current = undefined;
    focusRef.current = id;
    setFocusedId(id);
    if (sound) playSfx("move");
    return true;
  };

  /** Die gerade fokussierte Zeile; fehlt sie (kurz nach einer Änderung der Liste), gilt schon die nächste. */
  const current = (): Slot | undefined => {
    const lay = layoutRef.current;
    const id = resolveFocus(lay, focusRef.current, lastIndex.current);
    return id !== null ? lay.byId.get(id) : undefined;
  };

  const step = (delta: number) => {
    const lay = layoutRef.current;
    if (lay.selectable.length === 0) return;
    const cur = current();
    const from = cur && cur.selPos >= 0 ? cur.selPos : delta > 0 ? -1 : lay.selectable.length;
    const to = Math.min(lay.selectable.length - 1, Math.max(0, from + delta));
    focusTo(lay.slots[lay.selectable[to]].item.id, true);
  };

  const jump = (end: boolean) => {
    const lay = layoutRef.current;
    if (lay.selectable.length === 0) return;
    const i = end ? lay.selectable[lay.selectable.length - 1] : lay.selectable[0];
    focusTo(lay.slots[i].item.id, true);
  };

  const viewRef = useRef(0);
  const page = (dir: 1 | -1) => {
    const lay = layoutRef.current;
    if (lay.selectable.length === 0) return;
    const cur = current();
    if (!cur || cur.selPos < 0) return step(dir);
    // Eine Seite = sichtbare Höhe abzüglich etwas Überlappung, mindestens eine Zeile.
    const span = Math.max(viewRef.current - 4, cur.height);
    let pos = cur.selPos;
    while (pos + dir >= 0 && pos + dir < lay.selectable.length) {
      pos += dir;
      if (Math.abs(lay.slots[lay.selectable[pos]].top - cur.top) >= span) break;
    }
    if (pos !== cur.selPos) focusTo(lay.slots[lay.selectable[pos]].item.id, true);
  };

  const focused = () => {
    const slot = current();
    return slot && slot.selectable ? slot.item : null;
  };

  const select = () => {
    const item = focused();
    if (!item) return;
    playSfx("confirm");
    propsRef.current.onSelect(item.id, item);
  };
  const back = () => {
    playSfx("back");
    propsRef.current.onBack();
  };
  const alt = () => {
    const handler = propsRef.current.onAlt;
    if (!handler) return;
    playSfx("confirm");
    const item = focused();
    handler(item?.id ?? null, item);
  };
  const square = () => {
    const handler = propsRef.current.onSquare;
    if (!handler) return;
    playSfx("confirm");
    const item = focused();
    handler(item?.id ?? null, item);
  };

  const runAction = (action: HintAction) => {
    if (action === "confirm") select();
    else if (action === "back") back();
    else if (action === "triangle") alt();
    else square();
  };

  /* ---- Eingabe ---- */

  useOverlayInput({
    active,
    onAction: (action: PadAction) => {
      switch (action) {
        case "up":
          return step(-1);
        case "down":
          return step(1);
        case "l1":
          return page(-1);
        case "r1":
          return page(1);
        case "confirm":
          return select();
        case "back":
          return back();
        case "triangle":
          return alt();
        case "square":
          return square();
        default:
          return;
      }
    },
    onKey: (e) => {
      switch (e.key) {
        case "Home":
          jump(false);
          return true;
        case "End":
          jump(true);
          return true;
        case "PageUp":
          page(-1);
          return true;
        case "PageDown":
          page(1);
          return true;
        default:
          return false;
      }
    },
  });

  /* ---- Maus ---- */

  const onTrackClick = (e: MouseEvent) => {
    if (!active) return;
    const id = rowIdOf(e.target);
    if (id === null || !layoutRef.current.byId.get(id)?.selectable) return;
    focusTo(id, false);
    select();
  };

  // Der Fokus folgt dem Mauszeiger nur bei echter Bewegung – nicht, wenn beim Scrollen eine andere Zeile unter den ruhenden Zeiger rutscht.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const onTrackMove = (e: MouseEvent) => {
    const last = pointer.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    if (!active) return;
    const id = rowIdOf(e.target);
    if (id === null || id === focusRef.current || !layoutRef.current.byId.get(id)?.selectable) return;
    focusTo(id, false);
  };

  // Mausrad/Trackpad: pro Rastung eine Zeile; Trackpads liefern viele kleine Werte, die erst summiert werden.
  const wheel = useRef({ acc: 0, last: 0 });
  const onWheel = (e: WheelEvent) => {
    if (!active) return;
    const w = wheel.current;
    const now = performance.now();
    if (now - w.last > 300) w.acc = 0;
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1);
    if (Math.sign(dy) !== Math.sign(w.acc)) w.acc = 0;
    w.acc += dy;
    if (Math.abs(w.acc) < 36 || now - w.last < 70) return;
    step(w.acc > 0 ? 1 : -1);
    w.acc = 0;
    w.last = now;
  };

  /* ---- Scrollen ---- */

  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(0);
  // snap = Sprung über mehr als zwei Fensterhöhen: Der Inhalt blendet dann ein, statt in einer Sekunde vorbeizurauschen.
  const [scrollState, setScrollState] = useState({ y: 0, snap: false });
  const scroll = scrollState.y;
  const [ready, setReady] = useState(false);
  viewRef.current = viewH;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight / rootFontPx();
      setViewH((prev) => (Math.abs(prev - h) < 0.02 ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length === 0]);

  useLayoutEffect(() => {
    if (viewH <= 0) return;
    setScrollState((cur) => {
      const next = nextScroll(cur.y, focusSlot, layout.total, viewH);
      if (Math.abs(next - cur.y) < 0.001) return cur.snap ? { y: cur.y, snap: false } : cur;
      return { y: next, snap: Math.abs(next - cur.y) > viewH * 2 };
    });
  }, [focusSlot?.top, focusSlot?.height, layout.total, viewH]);

  // Erst nach dem ersten Bild gleitet alles weich – der Start soll nicht „einfliegen“.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  /* ---- Darstellung ---- */

  const scrollable = viewH > 0 && layout.total > viewH + 0.05;
  const lo = scroll - ART_MARGIN;
  const hi = scroll + (viewH || 34) + ART_MARGIN;
  const hasFocus = focusSlot !== null;
  const footerInfo: PopupFooter | null = typeof footer === "string" ? { text: footer, kind: "info" } : (footer ?? null);

  const shownHints: readonly PopupHint[] = hints ?? [
    { symbol: "cross", label: "Auswählen" },
    { symbol: "circle", label: "Zurück" },
    ...(onAlt ? [{ symbol: "triangle", label: altLabel } as const] : []),
    ...(onSquare ? [{ symbol: "square", label: squareLabel } as const] : []),
  ];

  const empty = items.length === 0;
  const position = focusSlot && focusSlot.selPos >= 0 ? `${focusSlot.selPos + 1} / ${layout.selectable.length}` : undefined;

  return (
    <MaybeFrame frame={frame} reuse align={align} dim={dim} onBack={() => propsRef.current.onBack()} active={active}>
      <section
        ref={panelRef}
        className={`pop-panel pop-panel--${width}${active ? "" : " is-inactive"}${ready ? " is-ready" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        onWheel={onWheel}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 id={titleId} className="pop-title">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className="pop-subtitle">
                {subtitle}
              </p>
            )}
          </div>
          {busy && <DotSpinner size="2.4rem" className="pop-head__spinner" />}
        </header>

        <div className="pop-body">
          {empty ? (
            <p className="pop-empty" role="status">
              {emptyText ?? (busy ? "Wird geladen …" : "Keine Einträge")}
            </p>
          ) : (
            <div
              ref={viewportRef}
              className={`pop-viewport${scrollable ? " is-scrollable" : ""}`}
              style={{ height: `${layout.total}rem` }}
            >
              {/* Der Balken liegt im Raum des Fensters (nicht im scrollenden Inhalt): Er gleitet immer nur die kurze
                  Strecke zur Zeile, auch wenn der Inhalt weit springt. */}
              {hasFocus && (
                <div
                  className="pop-bar"
                  aria-hidden="true"
                  style={{ height: `${focusSlot.height}rem`, transform: `translate3d(0, ${focusSlot.top - scroll}rem, 0)` }}
                >
                  <span className="pop-bar__halo" />
                </div>
              )}
              <div
                className={`pop-track${scrollState.snap ? " is-snap" : ""}`}
                role="listbox"
                aria-label={title}
                aria-busy={busy || undefined}
                aria-activedescendant={focusSlot ? `${uid}-${focusSlot.index}` : undefined}
                style={{ height: `${layout.total}rem`, transform: `translate3d(0, ${-scroll}rem, 0)` }}
                onClick={onTrackClick}
                onMouseMove={onTrackMove}
              >
                {layout.slots.map((slot) => (
                  <Row
                    key={slot.item.id}
                    item={slot.item}
                    id={`${uid}-${slot.index}`}
                    top={slot.top}
                    height={slot.height}
                    focused={slot.item.id === resolvedId}
                    lead={layout.hasLead}
                    artActive={slot.top + slot.height > lo && slot.top < hi}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {footerInfo && (
          <p
            className={`pop-footer is-${footerInfo.kind ?? "info"}`}
            role={footerInfo.kind === "error" ? "alert" : "status"}
          >
            <span>{footerInfo.text}</span>
          </p>
        )}

        <HintBar hints={shownHints} onHint={(a) => active && runAction(a)} end={scrollable ? position : undefined} />
      </section>
    </MaybeFrame>
  );
}
