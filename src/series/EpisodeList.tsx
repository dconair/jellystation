import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, WheelEvent } from "react";
import { EpisodeRow, rowOf } from "./EpisodeRow";
import { scrollFor } from "./seasons";
import type { Season } from "./seasons";
import "./series.css";

/** Höhe einer Folgenzeile in rem – muss zu series.css (--s-row) passen; der Wert wird von hier aus gesetzt. */
export const ROW_H = 9.4;
/** Abstand zwischen Leuchtbalken und Zeilenrand (oben/unten). */
const BAR_INSET = 0.35;
/** Wie weit (in rem) über den sichtbaren Bereich hinaus Bilder schon laden. */
const ART_MARGIN = ROW_H * 1.5;

const rootFontPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export interface EpisodeListProps {
  season: Season;
  /** Fokussierte Zeile (bleibt auch ohne Fokus gemerkt, damit die Liste dort steht). */
  row: number;
  /** true = der Fokus liegt in der Liste (Leuchtbalken sichtbar, Zeilen hell). */
  focused: boolean;
  /** Ausblendende Kopie der vorigen Staffel (Überblendung beim Staffelwechsel). */
  leaving?: boolean;
  /** Richtung des Wechsels: 1 = nächste Staffel (Inhalt gleitet nach links), -1 = vorige. */
  dir?: 1 | -1;
  /** Beim Einblenden animieren (nicht beim ersten Anzeigen). */
  animate?: boolean;
  onFocusRow: (row: number) => void;
  onOpenRow: (row: number) => void;
  /** Mausrad: eine Zeile weiter (1) bzw. zurück (-1). */
  onStep: (delta: 1 | -1) => void;
}

/** Folgen einer Staffel als senkrechte Liste mit wanderndem Leuchtbalken; scrollt so, dass die fokussierte Zeile sichtbar bleibt. */
export function EpisodeList({ season, row, focused, leaving, dir = 1, animate, onFocusRow, onOpenRow, onStep }: EpisodeListProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [ready, setReady] = useState(false);
  const count = season.episodes.length;

  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight / rootFontPx();
      setViewH((prev) => (Math.abs(prev - h) < 0.02 ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (viewH <= 0) return;
    setScroll((cur) => {
      const next = scrollFor(cur, row, ROW_H, count, viewH);
      return Math.abs(next - cur) < 0.001 ? cur : next;
    });
  }, [row, count, viewH]);

  // Erst nach dem ersten Bild gleitet alles weich – die Liste soll beim Erscheinen nicht „einfliegen“.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const click = (e: MouseEvent) => {
    if (leaving) return;
    const r = rowOf(e.target);
    if (r !== null && r < count) onOpenRow(r);
  };

  const pointer = useRef<{ x: number; y: number } | null>(null);
  const move = (e: MouseEvent) => {
    const last = pointer.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    if (leaving) return;
    const r = rowOf(e.target);
    if (r !== null && r < count && !(focused && r === row)) onFocusRow(r);
  };

  // Mausrad/Trackpad: pro Rastung eine Zeile; Trackpads liefern viele kleine Werte, die erst summiert werden.
  const wheel = useRef({ acc: 0, last: 0 });
  const onWheel = (e: WheelEvent) => {
    if (leaving) return;
    const w = wheel.current;
    const now = performance.now();
    if (now - w.last > 300) w.acc = 0;
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1);
    if (Math.sign(dy) !== Math.sign(w.acc)) w.acc = 0;
    w.acc += dy;
    if (Math.abs(w.acc) < 36 || now - w.last < 70) return;
    onStep(w.acc > 0 ? 1 : -1);
    w.acc = 0;
    w.last = now;
  };

  const total = count * ROW_H;
  const scrollable = viewH > 0 && total > viewH + 0.05;
  const canUp = scroll > 0.05;
  const canDown = scrollable && scroll < total - viewH - 0.05;
  const lo = scroll - ART_MARGIN;
  const hi = scroll + (viewH || 40) + ART_MARGIN;

  return (
    <div
      className={`series-list${leaving ? " is-leaving" : ""}${animate && !leaving ? " is-entering" : ""}${ready ? " is-ready" : ""}`}
      data-dir={dir}
      aria-hidden={leaving || undefined}
      onWheel={onWheel}
    >
      <div
        ref={viewRef}
        className="series-viewport"
        style={{ "--fade-top": canUp ? "2.4rem" : "0rem", "--fade-bottom": canDown ? "3rem" : "0rem" } as CSSProperties}
      >
        <div
          className={`series-bar${focused ? " is-on" : ""}`}
          aria-hidden="true"
          style={{
            height: `${ROW_H - BAR_INSET * 2}rem`,
            transform: `translate3d(0, ${row * ROW_H + BAR_INSET - scroll}rem, 0)`,
          }}
        >
          <span className="series-bar__halo" />
        </div>
        <div
          className="series-track"
          role="listbox"
          aria-label={season.label}
          style={{ height: `${total}rem`, transform: `translate3d(0, ${-scroll}rem, 0)` }}
          onClick={click}
          onMouseMove={move}
        >
          {season.episodes.map((ep, i) => {
            const top = i * ROW_H;
            return (
              <EpisodeRow
                key={ep.key}
                episode={ep}
                index={i}
                top={top}
                focused={focused && i === row}
                artActive={top + ROW_H > lo && top < hi}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
