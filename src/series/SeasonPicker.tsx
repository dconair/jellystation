import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { CheckIcon } from "../ui/popup/parts";
import { scrollFor, seasonStatus } from "./seasons";
import type { Season } from "./seasons";
import "./series.css";

/** Höhe einer Zeile des Auswahlmenüs in rem (siehe series.css --s-menu-row). */
const MENU_ROW = 4.4;
/** Luft oberhalb der ersten und unterhalb der letzten Zeile. */
const MENU_PAD = 0.8;
/** Höchste Menühöhe in rem; längere Listen scrollen. */
const MENU_MAX = 24;

export interface SeasonButtonProps {
  season: Season;
  focused: boolean;
  open: boolean;
  /** Zahl der Staffeln (bei nur einer ist der Knopf nur eine Anzeige). */
  count: number;
  onClick: () => void;
  onHover: () => void;
}

/** Der „Staffel 2 ▾“-Knopf. */
export function SeasonButton({ season, focused, open, count, onClick, onHover }: SeasonButtonProps) {
  const single = count <= 1;
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`series-select${focused ? " is-focused" : ""}${open ? " is-open" : ""}${single ? " is-single" : ""}`}
      aria-haspopup={single ? undefined : "listbox"}
      aria-expanded={single ? undefined : open}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      onClick={onClick}
      onMouseMove={onHover}
    >
      <span className="series-select__label">{season.label}</span>
      {!single && (
        <svg className="series-select__caret" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6.5 9.5 12 15l5.5-5.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

export interface SeasonMenuProps {
  seasons: readonly Season[];
  /** Aktuell gewählte Staffel (bekommt den Haken). */
  current: number;
  /** Zeile mit dem Leuchtbalken. */
  index: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}

/** Aufklappliste der Staffeln mit Folgenzahl und Stand; Leuchtbalken wie in den Listen der App. */
export function SeasonMenu({ seasons, current, index, onHover, onPick }: SeasonMenuProps) {
  const height = Math.min(MENU_MAX, seasons.length * MENU_ROW + MENU_PAD * 2);
  const [scroll, setScroll] = useState(0);
  const [ready, setReady] = useState(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    setScroll((cur) => scrollFor(cur, index, MENU_ROW, seasons.length, height - MENU_PAD * 2));
  }, [index, seasons.length, height]);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const rowAt = (target: EventTarget | null): number | null => {
    if (!(target instanceof Element)) return null;
    const el = target.closest<HTMLElement>("[data-menu-row]");
    const n = el ? Number(el.dataset.menuRow) : NaN;
    return Number.isInteger(n) ? n : null;
  };

  return (
    <div
      className={`series-menu${ready ? " is-ready" : ""}`}
      role="listbox"
      aria-label="Staffel wählen"
      style={{ height: `${height}rem` }}
      // Klicks im Menü sollen nicht als Klick „daneben“ den Screen erreichen.
      onClick={(e) => {
        e.stopPropagation();
        const r = rowAt(e.target);
        if (r !== null) onPick(r);
      }}
      onMouseMove={(e) => {
        const last = pointer.current;
        if (last && last.x === e.clientX && last.y === e.clientY) return;
        pointer.current = { x: e.clientX, y: e.clientY };
        const r = rowAt(e.target);
        if (r !== null && r !== index) onHover(r);
      }}
    >
      <div className="series-menu__view" style={{ top: `${MENU_PAD}rem`, bottom: `${MENU_PAD}rem` }}>
        <div
          className="series-menu__bar"
          aria-hidden="true"
          style={{ height: `${MENU_ROW}rem`, transform: `translate3d(0, ${index * MENU_ROW - scroll}rem, 0)` }}
        >
          <span className="series-bar__halo" />
        </div>
        <div className="series-menu__track" style={{ transform: `translate3d(0, ${-scroll}rem, 0)` }}>
          {seasons.map((s, i) => (
            <div
              key={s.id}
              role="option"
              aria-selected={i === current}
              data-menu-row={i}
              className={`series-menu__row${i === index ? " is-focused" : ""}`}
              style={{ top: `${i * MENU_ROW}rem`, height: `${MENU_ROW}rem` }}
            >
              <span className="series-menu__check">{i === current && <CheckIcon />}</span>
              <span className="series-menu__name">{s.label}</span>
              <span className="series-menu__status">{seasonStatus(s)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
