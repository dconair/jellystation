import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CategoryIconName, XmbCategory, XmbEntry } from "../data/types";
import { useGamepad } from "../input/useGamepad";
import type { PadAction } from "../input/useGamepad";
import { ArtImage } from "../art/ArtImage";
import { Background } from "./Background";
import { CategoryIcon } from "./CategoryIcon";
import { DetailCard } from "./DetailCard";
import type { DetailData } from "./DetailCard";
import { toggleFullscreen } from "./fullscreen";
import { Hints } from "./Hints";
import {
  ART_RANGE,
  ITEM_FOCUS_SCALE_COVER,
  ITEM_FOCUS_SCALE_TILE,
  ITEM_PITCH,
  ITEM_PITCH_ART,
} from "./layout";
import { MotionEngine } from "./MotionEngine";
import { isMuted, playSfx, setMuted } from "./sound";
import { watchState } from "./progress";
import { useClock } from "./useClock";
import { getUiPrefs, subscribeUiPrefs } from "../prefs/uiPrefs";
import "./xmb.css";

interface XmbProps {
  categories: XmbCategory[];
  /** Wird beim Bestätigen (Enter / ✕ / Klick) des fokussierten Eintrags aufgerufen. */
  onActivate?: (entry: XmbEntry, category: XmbCategory, notify: (text: string) => void) => void;
  /** IDs von Einträgen, die gerade laufen (z. B. gestartete Spiele). */
  runningIds?: ReadonlySet<string>;
  /** Kleiner Hinweis in der Kopfzeile, z. B. "Vorschau-Modus". */
  notice?: string;
  /**
   * false, solange ein Overlay (Player, Dialog) offen ist: Tastatur, Mausrad, Klicks und
   * Controller werden dann ignoriert, das Menü bleibt aber im Hintergrund erhalten.
   */
  inputEnabled?: boolean;
  /** △ bzw. Taste "O" (Optionen) auf dem fokussierten Eintrag, z. B. für ein Kontextmenü. */
  onSecondary?: (entry: XmbEntry, category: XmbCategory, notify: (text: string) => void) => void;
  /** Kategorie, auf der das Menü beim ersten Aufbau steht (Standard: die zweite, direkt hinter der Suche). */
  startCategoryId?: string;
}

/** Logischer Zustand (sofort aktuell). Die sichtbare Position folgt ihm in der MotionEngine per Feder. */
interface NavState {
  categoryId: string;
  /** Pro Kategorie der zuletzt fokussierte Eintrag. */
  focus: Record<string, number>;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const dateFormat = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });

/** Fortschrittsbalken ("Weiterschauen") und Haken ("Gesehen") auf einer Cover-Kachel. */
function WatchMarks({ entry }: { entry: XmbEntry }) {
  const w = watchState(entry);
  if (!w) return null;
  if (w.ratio > 0) {
    return (
      <span
        className="xmb-progress"
        role="progressbar"
        aria-label="Gesehen"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(w.ratio * 100)}
      >
        <span className="xmb-progress__fill" style={{ transform: `scaleX(${w.ratio})` }} />
      </span>
    );
  }
  return w.played ? (
    <span className="xmb-played" title="Gesehen" aria-label="Gesehen">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6.5 12.5 3.6 3.6 7.4-8.2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  ) : null;
}

/* ------------------------------------------------------------------ Kategorie-Leiste */

interface CategoryButtonProps {
  motion: MotionEngine;
  id: string;
  label: string;
  icon: CategoryIconName;
  active: boolean;
  onPick: (id: string) => void;
}

/** Ort, Größe, Deckkraft, Leuchten und Beschriftung setzt die MotionEngine pro Bild – hier steht nur der Aufbau. */
const CategoryButton = memo(function CategoryButton({ motion, id, label, icon, active, onPick }: CategoryButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  const bob = useRef<HTMLSpanElement>(null);
  const scale = useRef<HTMLSpanElement>(null);
  const glow = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!button.current || !bob.current || !scale.current) return;
    return motion.attachCategory(id, {
      button: button.current,
      bob: bob.current,
      scale: scale.current,
      glow: glow.current,
      label: text.current,
    });
  }, [motion, id]);

  return (
    <button
      ref={button}
      type="button"
      tabIndex={-1}
      className={`xmb-category${active ? " is-active" : ""}`}
      onClick={() => onPick(id)}
    >
      <span ref={bob} className="xmb-category__bob">
        <span ref={scale} className="xmb-category__scale">
          {/* Leuchten: zweite Kopie mit statischem Filter, nur die Deckkraft wird bewegt */}
          <span ref={glow} className="xmb-category__glow" aria-hidden="true">
            <CategoryIcon name={icon} variant="tile" />
          </span>
          <CategoryIcon name={icon} />
        </span>
      </span>
      <span ref={text} className="xmb-category__label">
        {label}
      </span>
    </button>
  );
});

/* ------------------------------------------------------------------ Spalten und Einträge */

interface ItemProps {
  motion: MotionEngine;
  catId: string;
  icon: CategoryIconName;
  entry: XmbEntry;
  index: number;
  count: number;
  /** Logisch fokussiert (und Spalte aktiv). Die Hervorhebung selbst folgt stetig der Position. */
  focused: boolean;
  /** Cover darf geladen werden (Eintrag liegt nahe am Fokus). */
  artActive: boolean;
  pitchArt: boolean;
  running: boolean;
  activated: boolean;
  onSelect: (catId: string, index: number) => void;
}

const Item = memo(function Item({
  motion,
  catId,
  icon,
  entry,
  index,
  count,
  focused,
  artActive,
  pitchArt,
  running,
  activated,
  onSelect,
}: ItemProps) {
  const outer = useRef<HTMLDivElement>(null);
  const float = useRef<HTMLSpanElement>(null);
  const scale = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const shade = useRef<HTMLSpanElement>(null);
  const glow = useRef<HTMLSpanElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  const hasArt = Boolean(entry.art);
  const focusScale = hasArt ? ITEM_FOCUS_SCALE_COVER : ITEM_FOCUS_SCALE_TILE;

  // Vor dem ersten Paint anmelden: Die Maschine setzt Ort und Deckkraft sofort – nichts blitzt an (0,0) auf.
  useLayoutEffect(() => {
    if (!outer.current || !float.current || !scale.current || !text.current) return;
    return motion.attachItem(
      catId,
      index,
      {
        outer: outer.current,
        float: float.current,
        scale: scale.current,
        text: text.current,
        shade: shade.current,
        glow: glow.current,
        title: title.current,
      },
      focusScale,
    );
  }, [motion, catId, index, focusScale, hasArt]);

  return (
    <div
      ref={outer}
      role="option"
      aria-selected={focused}
      aria-posinset={index + 1}
      aria-setsize={count}
      className={
        "xmb-item" +
        (hasArt ? " has-art" : pitchArt ? " in-art-col" : "") +
        (focused ? " is-focused" : "") +
        (activated ? " is-activated" : "")
      }
      style={{ "--hue": entry.hue } as CSSProperties}
      onClick={() => onSelect(catId, index)}
    >
      <div className="xmb-item__inner">
        <span ref={float} className="xmb-item__float">
          <span ref={scale} className="xmb-item__scale">
            <span ref={glow} className="xmb-item__glow" aria-hidden="true" />
            {hasArt ? (
              <span className="xmb-item__cover">
                <ArtImage entry={entry} active={artActive} className="xmb-art" />
                <WatchMarks entry={entry} />
                <span ref={shade} className="xmb-item__shade" aria-hidden="true" />
              </span>
            ) : (
              <span className="xmb-item__tile">
                <CategoryIcon name={icon} variant="tile" />
                <span ref={shade} className="xmb-item__shade" aria-hidden="true" />
              </span>
            )}
          </span>
        </span>
        <span ref={text} className="xmb-item__text">
          <span ref={title} className="xmb-item__title">
            {entry.title}
          </span>
          {entry.subtitle && <span className="xmb-item__subtitle">{entry.subtitle}</span>}
          {running && <span className="xmb-item__badge">Läuft</span>}
        </span>
      </div>
    </div>
  );
});

interface ColumnProps {
  motion: MotionEngine;
  cat: XmbCategory;
  active: boolean;
  focus: number;
  pitchArt: boolean;
  ranges: Array<[number, number]>;
  runningIds?: ReadonlySet<string>;
  activatedId: string | null;
  onSelect: (catId: string, index: number) => void;
}

function Column({ motion, cat, active, focus, pitchArt, ranges, runningIds, activatedId, onSelect }: ColumnProps) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (el.current ? motion.attachColumn(cat.id, el.current) : undefined), [motion, cat.id]);

  const items = [];
  for (const [lo, hi] of ranges) {
    for (let ei = lo; ei <= hi; ei++) {
      const entry = cat.entries[ei];
      items.push(
        <Item
          key={entry.id}
          motion={motion}
          catId={cat.id}
          icon={cat.icon}
          entry={entry}
          index={ei}
          count={cat.entries.length}
          focused={active && ei === focus}
          artActive={active && Math.abs(ei - focus) <= ART_RANGE}
          pitchArt={pitchArt}
          running={runningIds?.has(entry.id) ?? false}
          activated={activatedId === entry.id}
          onSelect={onSelect}
        />,
      );
    }
  }
  return (
    <div
      ref={el}
      className={`xmb-column${active ? " is-active" : ""}`}
      role="listbox"
      aria-label={cat.label}
      aria-hidden={!active}
    >
      {items}
    </div>
  );
}

/* ------------------------------------------------------------------ Hauptkomponente */

export function Xmb({ categories, onActivate, runningIds, notice, inputEnabled = true, onSecondary, startCategoryId }: XmbProps) {
  const [nav, setNav] = useState<NavState>(() => ({
    categoryId: (startCategoryId && categories.find((c) => c.id === startCategoryId)?.id) || categories[Math.min(1, categories.length - 1)].id,
    focus: {},
  }));
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [activatedId, setActivatedId] = useState<string | null>(null);
  const [muted, setMutedState] = useState(isMuted);
  const now = useClock();
  const [, requestRender] = useReducer((n: number) => n + 1, 0);

  // Bewegungsmaschine: hält die sichtbaren Positionen und schreibt sie pro Bild direkt in den DOM.
  const [motion] = useState(() => {
    const m = new MotionEngine();
    const apply = () => {
      const p = getUiPrefs();
      m.setReduced(prefersReducedMotion() || p.animations === "off");
      m.setSpeed(p.motionSpeed * (p.animations === "reduced" ? 1.8 : 1));
    };
    apply();
    subscribeUiPrefs(apply);
    return m;
  });

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

  /** Übernimmt einen neuen logischen Zustand und gibt der Maschine sofort die neuen Ziele. */
  const commit = useCallback(
    (next: NavState) => {
      const prev = navRef.current;
      const cats = categoriesRef.current;
      if (next.categoryId !== prev.categoryId) {
        const ci = cats.findIndex((c) => c.id === next.categoryId);
        if (ci >= 0) motion.retargetCategory(next.categoryId, ci);
      }
      for (const id of Object.keys(next.focus)) {
        if (next.focus[id] === (prev.focus[id] ?? 0)) continue;
        const cat = cats.find((c) => c.id === id);
        if (cat) motion.retargetColumn(id, next.focus[id], cat.entries.length);
      }
      navRef.current = next;
      setNav(next);
    },
    [motion],
  );

  const notify = useCallback((text: string) => setToast({ id: Date.now(), text }), []);

  // Eingabe-Sperre per Ref: Die Listener bleiben registriert (kein erneutes "Controller verbunden",
  // kein Doppelauslösen), reagieren aber nicht, solange ein Overlay offen ist.
  const inputEnabledRef = useRef(inputEnabled);
  inputEnabledRef.current = inputEnabled;
  const onSecondaryRef = useRef(onSecondary);
  onSecondaryRef.current = onSecondary;

  /** Zentrale Eingabe: Tastatur, Controller und Mausrad laufen alle hier durch. */
  const dispatch = useCallback(
    (action: PadAction) => {
      if (!inputEnabledRef.current) return;
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
        case "triangle": {
          const entry = cat.entries[fi];
          if (entry) onSecondaryRef.current?.(entry, cat, notify);
          return;
        }
        default:
          // □, Schultertasten usw. haben im Hauptmenü keine Funktion.
          return;
      }
    },
    [commit, notify],
  );

  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  /** Klick auf einen Eintrag: fokussieren, bzw. bestätigen, wenn er schon fokussiert ist. */
  const onSelectItem = useCallback(
    (catId: string, index: number) => {
      if (!inputEnabledRef.current) return;
      const state = navRef.current;
      const cats = categoriesRef.current;
      const cat = cats[Math.max(0, cats.findIndex((c) => c.id === state.categoryId))];
      if (!cat || cat.id !== catId) return; // Eintrag einer ausblendenden Spalte
      const fi = clamp(state.focus[catId] ?? 0, 0, Math.max(0, cat.entries.length - 1));
      if (index === fi) dispatch("confirm");
      else {
        commit({ ...state, focus: { ...state.focus, [catId]: index } });
        playSfx("move");
      }
    },
    [commit, dispatch],
  );

  const onPickCategory = useCallback(
    (id: string) => {
      if (!inputEnabledRef.current) return;
      const state = navRef.current;
      const cats = categoriesRef.current;
      if (cats[Math.max(0, cats.findIndex((c) => c.id === state.categoryId))]?.id === id) return; // schon aktiv
      commit({ ...state, categoryId: id });
      playSfx("category");
    },
    [commit],
  );

  const { controller } = useGamepad({ onAction: dispatch });

  // Tastatur
  useEffect(() => {
    const keyMap: Record<string, PadAction> = {
      o: "triangle",
      O: "triangle",
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      Enter: "confirm",
      Escape: "back",
      Backspace: "back",
    };
    const onKey = (e: KeyboardEvent) => {
      if (!inputEnabledRef.current) return;
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

  // Mausrad / Trackpad (gedrosselt: mehr als ~7 Schritte pro Sekunde braucht niemand)
  const lastWheel = useRef(0);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!inputEnabledRef.current) return;
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

  /* ---- Detailkarte: genau eine; die Maschine blendet aus, lässt tauschen und blendet den neueren Eintrag ein ---- */
  const wanted: DetailData | null = focusedEntry
    ? { key: `${category.id}/${focusedEntry.id}`, entry: focusedEntry, icon: category.icon }
    : null;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const [shown, setShown] = useState<DetailData | null>(wanted);
  const swapDetail = useCallback(() => setShown(wantedRef.current), []);

  useEffect(() => {
    motion.setHost({ requestRender, swapDetail });
    motion.start();
    // Reduzierte Bewegung live verfolgen (Betriebssystem-Einstellung kann sich ändern)
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const onChange = () => motion.setReduced(Boolean(mq?.matches));
    onChange();
    if (mq) {
      // Ältere WebKit-Versionen (macOS 10.x) kennen nur das veraltete addListener.
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else mq.addListener(onChange);
    }
    return () => {
      motion.stop();
      motion.setHost(null);
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener("change", onChange);
        else mq.removeListener(onChange);
      }
    };
  }, [motion, swapDetail]);

  // Angezeigt wird der "gewünschte" Eintrag, sobald es derselbe ist (Daten-Updates ohne Überblendung)
  // oder die Bewegung reduziert ist; sonst bleibt der alte stehen, bis die Karte unsichtbar ist.
  const shownData = motion.isReduced || (shown && wanted && shown.key === wanted.key) ? wanted : shown;

  // Nach jedem Render: Maschine mit dem logischen Zustand abgleichen (vor dem Paint)
  useLayoutEffect(() => {
    motion.sync(
      categories.map((c) => ({
        id: c.id,
        count: c.entries.length,
        pitch: pitchById.get(c.id) ?? ITEM_PITCH,
        focus: focusOf(c.id, c.entries.length),
      })),
      catIndex,
    );
    motion.setDetailWanted(wanted ? wanted.key : null);
    motion.setDetailShown(shownData ? shownData.key : null);
  });

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
          {categories.map((cat, i) => (
            <CategoryButton
              key={cat.id}
              motion={motion}
              id={cat.id}
              label={cat.label}
              icon={cat.icon}
              active={i === catIndex}
              onPick={onPickCategory}
            />
          ))}
        </nav>

        {/* Vertikale Achse: Einträge der Kategorien (sichtbar ist, wer nahe an der Leiste steht) */}
        {categories.map((cat, ci) => {
          const f = focusOf(cat.id, cat.entries.length);
          const pitch = pitchById.get(cat.id) ?? ITEM_PITCH;
          return (
            <Column
              key={cat.id}
              motion={motion}
              cat={cat}
              active={ci === catIndex}
              focus={f}
              pitchArt={pitch === ITEM_PITCH_ART}
              ranges={motion.windowOf(cat.id, cat.entries.length, f)}
              runningIds={runningIds}
              activatedId={activatedId}
              onSelect={onSelectItem}
            />
          );
        })}
      </div>

      {/* Detailkarte des fokussierten Eintrags (eine Karte: aus → tauschen → ein) */}
      <DetailCard data={shownData} motion={motion} />

      <Hints />

      {toast && (
        <div key={toast.id} className="xmb-toast" role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
