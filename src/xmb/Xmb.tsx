import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { XmbCategory, XmbEntry } from "../data/types";
import { useGamepad } from "../input/useGamepad";
import type { PadAction } from "../input/useGamepad";
import { ArtImage } from "../art/ArtImage";
import { Background } from "./Background";
import { CategoryIcon } from "./CategoryIcon";
import { DetailCard, useDetailLayers } from "./DetailCard";
import { Float } from "./Float";
import { toggleFullscreen } from "./fullscreen";
import { Hints } from "./Hints";
import {
  ART_RANGE,
  ITEM_PITCH,
  ITEM_PITCH_ART,
  ITEM_WINDOW,
  ROW_Y,
  categoryX,
  itemOpacity,
  itemY,
} from "./layout";
import { isMuted, playSfx, setMuted } from "./sound";
import { useClock } from "./useClock";
import "./xmb.css";

interface XmbProps {
  categories: XmbCategory[];
  /** Wird beim Bestätigen (Enter / ✕ / Klick) des fokussierten Eintrags aufgerufen. */
  onActivate?: (entry: XmbEntry, category: XmbCategory, notify: (text: string) => void) => void;
  /** IDs von Einträgen, die gerade laufen (z. B. gestartete Spiele). */
  runningIds?: ReadonlySet<string>;
  /** Kleiner Hinweis in der Kopfzeile, z. B. "Vorschau-Modus". */
  notice?: string;
}

interface NavState {
  categoryId: string;
  /** Pro Kategorie der zuletzt fokussierte Eintrag. */
  focus: Record<string, number>;
  /**
   * Nach einem weiten Fokussprung (z. B. ○ zurück zum Anfang einer langen Liste): der alte Fokus.
   * Seine Einträge bleiben noch kurz im DOM, damit sie weich ausblenden statt zu verschwinden.
   */
  trail: Record<string, number>;
}

/** So lange (ms) bleiben die Einträge des alten Fokus nach einem weiten Sprung erhalten. */
const TRAIL_MS = 1000;
/** Gerendert wird nur dieser Bereich um den Fokus; alles dahinter ist ohnehin unsichtbar. */
const RENDER_RANGE = ITEM_WINDOW + 1;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Indizes der Einträge, die gerendert werden: um den Fokus und ggf. um den alten Fokus (Nachlauf). */
function renderIndices(count: number, focus: number, trail: number | undefined) {
  const centers = trail === undefined ? [focus] : [trail, focus];
  const set = new Set<number>();
  for (const c of centers) {
    for (let i = Math.max(0, c - RENDER_RANGE); i <= Math.min(count - 1, c + RENDER_RANGE); i++) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

const dateFormat = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });

export function Xmb({ categories, onActivate, runningIds, notice }: XmbProps) {
  const [nav, setNav] = useState<NavState>(() => ({
    categoryId: categories[Math.min(1, categories.length - 1)].id,
    focus: {},
    trail: {},
  }));
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [activatedId, setActivatedId] = useState<string | null>(null);
  const [muted, setMutedState] = useState(isMuted);
  const now = useClock();

  // Navigationszustand ist ID-basiert: Kategorien dürfen nachträglich (z. B. nach dem
  // Bibliotheks-Scan) dazukommen, ohne dass der Fokus springt.
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const navRef = useRef(nav);
  navRef.current = nav;

  const catIndex = Math.max(0, categories.findIndex((c) => c.id === nav.categoryId));
  const category = categories[catIndex];
  const focusOf = (id: string, count: number) => clamp(nav.focus[id] ?? 0, 0, Math.max(0, count - 1));
  const focusIndex = focusOf(category.id, category.entries.length);
  const focusedEntry = category.entries[focusIndex];

  const commit = useCallback((next: NavState) => {
    const prev = navRef.current;
    let trail = next.trail;
    for (const id of Object.keys(next.focus)) {
      const from = prev.focus[id] ?? 0;
      if (Math.abs(from - next.focus[id]) <= 1) continue;
      trail = { ...trail, [id]: from };
      window.setTimeout(() => {
        const cur = navRef.current;
        if (cur.trail[id] !== from) return;
        const { [id]: _gone, ...rest } = cur.trail;
        const cleared = { ...cur, trail: rest };
        navRef.current = cleared;
        setNav(cleared);
      }, TRAIL_MS);
    }
    const merged = trail === next.trail ? next : { ...next, trail };
    navRef.current = merged;
    setNav(merged);
  }, []);

  const notify = useCallback((text: string) => setToast({ id: Date.now(), text }), []);

  /** Zentrale Eingabe: Tastatur, Controller und Mausrad laufen alle hier durch. */
  const dispatch = useCallback(
    (action: PadAction) => {
      const cats = categoriesRef.current;
      const state = navRef.current;
      const ci = Math.max(0, cats.findIndex((c) => c.id === state.categoryId));
      const cat = cats[ci];
      const fi = clamp(state.focus[cat.id] ?? 0, 0, Math.max(0, cat.entries.length - 1));

      switch (action) {
        case "left":
        case "right": {
          const next = clamp(ci + (action === "left" ? -1 : 1), 0, cats.length - 1);
          if (next === ci) return;
          commit({ ...state, categoryId: cats[next].id });
          playSfx("category");
          return;
        }
        case "up":
        case "down": {
          const next = clamp(fi + (action === "up" ? -1 : 1), 0, Math.max(0, cat.entries.length - 1));
          if (next === fi) return;
          commit({ ...state, focus: { ...state.focus, [cat.id]: next } });
          playSfx("move");
          return;
        }
        case "back": {
          // ○ / Esc: zurück zum ersten Eintrag der Kategorie.
          if (fi === 0) return;
          commit({ ...state, focus: { ...state.focus, [cat.id]: 0 } });
          playSfx("back");
          return;
        }
        case "confirm": {
          const entry = cat.entries[fi];
          if (!entry) return;
          playSfx("confirm");
          setActivatedId(entry.id);
          window.setTimeout(() => setActivatedId((id) => (id === entry.id ? null : id)), 500);
          onActivateRef.current?.(entry, cat, notify);
          return;
        }
        default:
          // △ / □ haben im Hauptmenü (noch) keine Funktion.
          return;
      }
    },
    [commit, notify],
  );

  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  const { controller } = useGamepad({ onAction: dispatch });

  // Tastatur
  useEffect(() => {
    const keyMap: Record<string, PadAction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      Enter: "confirm",
      Escape: "back",
      Backspace: "back",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "F11") {
        e.preventDefault();
        if (!e.repeat) void toggleFullscreen();
        return;
      }
      if (e.key === "m" || e.key === "M") {
        if (e.repeat) return;
        const next = !isMuted();
        setMuted(next);
        setMutedState(next);
        if (!next) playSfx("confirm");
        return;
      }
      const action = keyMap[e.key];
      if (!action) return;
      e.preventDefault();
      if (action === "confirm" && e.repeat) return;
      dispatch(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  // Mausrad / Trackpad (gedrosselt, damit die Animation Zeit zum Schweben hat)
  const lastWheel = useRef(0);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const t = performance.now();
      if (t - lastWheel.current < 140) return;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      const amount = horizontal ? e.deltaX || e.deltaY : e.deltaY;
      if (Math.abs(amount) < 4) return;
      lastWheel.current = t;
      dispatch(horizontal ? (amount < 0 ? "left" : "right") : amount < 0 ? "up" : "down");
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [dispatch]);

  // Toast automatisch ausblenden
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Controller-Verbindung melden
  useEffect(() => {
    if (controller) notify(`${controller} verbunden`);
  }, [controller, notify]);

  const clock = useMemo(
    () => ({ date: dateFormat.format(now), time: timeFormat.format(now) }),
    [now],
  );
  const anyRunning = (runningIds?.size ?? 0) > 0;

  // Spalten mit Cover-Kacheln brauchen mehr Zeilenabstand als Spalten mit Icon-Kacheln.
  const pitchById = useMemo(
    () =>
      new Map(
        categories.map((c) => [c.id, c.entries.some((e) => e.art) ? ITEM_PITCH_ART : ITEM_PITCH]),
      ),
    [categories],
  );

  const detailLayers = useDetailLayers(
    focusedEntry ? { entry: focusedEntry, icon: category.icon } : null,
  );

  return (
    <div className="xmb" aria-label="XrossMediaBar">
      <Background paused={anyRunning} />
      <div className="xmb-vignette" aria-hidden="true" />

      <header className="xmb-header">
        {notice && <span className="xmb-chip xmb-notice">{notice}</span>}
        {muted && <span className="xmb-chip xmb-muted">Ton aus</span>}
        {controller && <span className="xmb-pad">{controller}</span>}
        <span className="xmb-clock">
          <span className="xmb-clock__date">{clock.date}</span>
          <span className="xmb-clock__time">{clock.time}</span>
        </span>
      </header>

      <div className="xmb-stage">
        {/* Horizontale Achse: Kategorien */}
        <nav className="xmb-categories" aria-label="Kategorien">
          {categories.map((cat, i) => {
            const active = i === catIndex;
            return (
              <button
                key={cat.id}
                type="button"
                tabIndex={-1}
                className={`xmb-category${active ? " is-active" : ""}`}
                style={
                  {
                    transform: `translate3d(${categoryX(i, catIndex)}rem, ${ROW_Y}rem, 0)`,
                    "--dist": Math.abs(i - catIndex),
                  } as CSSProperties
                }
                onClick={() => {
                  if (!active) {
                    commit({ ...navRef.current, categoryId: cat.id });
                    playSfx("category");
                  }
                }}
              >
                <Float active={active} period={4200} className="xmb-category__float">
                  <CategoryIcon name={cat.icon} />
                </Float>
                <span className="xmb-category__label">{cat.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Vertikale Achse: Einträge der Kategorien (nur die aktive ist sichtbar) */}
        {categories.map((cat, ci) => {
          const colActive = ci === catIndex;
          const f = focusOf(cat.id, cat.entries.length);
          const x = categoryX(ci, catIndex);
          const pitch = pitchById.get(cat.id) ?? ITEM_PITCH;
          return (
            <div
              key={cat.id}
              className={`xmb-column${colActive ? " is-active" : ""}`}
              role="listbox"
              aria-label={cat.label}
              aria-hidden={!colActive}
            >
              {renderIndices(cat.entries.length, f, nav.trail[cat.id]).map((ei) => {
                const entry = cat.entries[ei];
                const focused = colActive && ei === f;
                const running = runningIds?.has(entry.id) ?? false;
                // Weit entfernte Einträge teilen sich eine unsichtbare Parkposition: Das hält die
                // Zahl der laufenden Animationen klein, auch bei Bibliotheken mit tausenden Titeln.
                const parked = clamp(ei - f, -(ITEM_WINDOW + 1), ITEM_WINDOW + 1) + f;
                const opacity = itemOpacity(parked, f);
                const trailing = nav.trail[cat.id];
                // Cover nur für Einträge in Fokusnähe (inkl. der ausblendenden nach einem Sprung).
                const near = (range: number) =>
                  Math.abs(ei - f) <= range || (trailing !== undefined && Math.abs(ei - trailing) <= range);
                return (
                  <div
                    key={entry.id}
                    role="option"
                    aria-selected={focused}
                    aria-posinset={ei + 1}
                    aria-setsize={cat.entries.length}
                    className={
                      "xmb-item" +
                      (entry.art ? " has-art" : pitch === ITEM_PITCH_ART ? " in-art-col" : "") +
                      (focused ? " is-focused" : "") +
                      (opacity < 0.05 ? " is-hidden" : "") +
                      (Math.abs(ei - f) > RENDER_RANGE ? " is-trailing" : "") +
                      (activatedId === entry.id ? " is-activated" : "")
                    }
                    style={
                      {
                        transform: `translate3d(${x}rem, ${itemY(parked, f, pitch)}rem, 0)`,
                        opacity,
                        "--hue": entry.hue,
                        "--stagger": Math.min(Math.abs(ei - f), 6),
                      } as CSSProperties
                    }
                    onClick={() => {
                      if (ei === f) dispatch("confirm");
                      else {
                        commit({
                          ...navRef.current,
                          focus: { ...navRef.current.focus, [cat.id]: ei },
                        });
                        playSfx("move");
                      }
                    }}
                  >
                    <div className="xmb-item__inner">
                      <Float active={focused} period={3800} className="xmb-item__float">
                        {entry.art ? (
                          <span className="xmb-item__cover">
                            {near(ART_RANGE + 1) && (
                              <ArtImage entry={entry} active={colActive && near(ART_RANGE)} className="xmb-art" />
                            )}
                          </span>
                        ) : (
                          <span className="xmb-item__tile">
                            <CategoryIcon name={cat.icon} variant="tile" />
                          </span>
                        )}
                      </Float>
                      <span className="xmb-item__text">
                        <span className="xmb-item__title">{entry.title}</span>
                        {entry.subtitle && (
                          <span className="xmb-item__subtitle">{entry.subtitle}</span>
                        )}
                        {running && <span className="xmb-item__badge">Läuft</span>}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Detailkarte des fokussierten Eintrags (alte Karte blendet aus, neue ein) */}
      {detailLayers.map((layer) => (
        <DetailCard key={layer.key} entry={layer.entry} icon={layer.icon} leaving={layer.leaving} />
      ))}

      <Hints />

      {toast && (
        <div key={toast.id} className="xmb-toast" role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
