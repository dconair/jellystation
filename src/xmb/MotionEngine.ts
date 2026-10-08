import {
  CATEGORY_FOCUS_SCALE,
  CATEGORY_PITCH,
  ITEM_D_MAX,
  ITEM_D_MIN,
  ROW_Y,
  WINDOW_AFTER,
  WINDOW_BEFORE,
  categoryOpacityAt,
  categoryXAt,
  itemOpacityAt,
  itemYCurve,
} from "./layout";
import {
  APPEAR_OMEGA,
  BOB_KEYFRAMES,
  BOB_REM,
  CAT_BOB_MS,
  CAT_LEAN_DEG_PER_REM_S,
  CAT_LEAN_MAX_DEG,
  CAT_OMEGA,
  CAT_STRETCH_MAX,
  CAT_STRETCH_PER_REM_S,
  CAT_ZETA,
  COLUMN_FADE_FROM,
  COLUMN_FADE_TO,
  COLUMN_GATE_FROM,
  COLUMN_GATE_TO,
  COLUMN_RISE_REM,
  DETAIL_CALM_MS,
  DETAIL_IN_OMEGA,
  DETAIL_OUT_OMEGA,
  DETAIL_RISE_REM,
  DETAIL_SWAP_ALPHA,
  DT_MAX,
  IDLE_ARM_MS,
  IDLE_FRAME_MS,
  ITEM_BOB_MS,
  ITEM_OMEGA,
  ITEM_STRETCH_MAX,
  ITEM_STRETCH_PER_REM_S,
  ITEM_ZETA,
  JUMP_DRIFT_ITEMS,
  JUMP_ENTER_ITEMS,
  JUMP_FAR_ITEMS,
  JUMP_IN_OMEGA,
  JUMP_OUT_OMEGA,
  JUMP_SWAP_ALPHA,
  LABEL_FADE_FROM,
  LABEL_SLIDE_REM,
  REST_POS,
  REST_VEL,
  SLOT_OMEGA,
  SQUASH_RATIO,
  STALL_S,
  TITLE_WEIGHT,
  TITLE_WEIGHT_FOCUS,
  clamp,
  evalCurve,
  focusCurve,
  makeSpring,
  smoothstep,
  stepSpring,
} from "./motion";
import type { Curve, Spring } from "./motion";

/**
 * Bewegungsmaschine der XMB.
 *
 * React kennt nur den logischen Zustand (gewählte Kategorie, Fokus je Spalte). Die sichtbare Position – je eine
 * Gleitkomma-Koordinate für die Kategorie-Achse und für jede Spalte – folgt dem Ziel per Feder (motion.ts) und
 * wird hier pro Bild direkt auf die DOM-Knoten geschrieben. Jedes Element ist dabei eine reine Funktion seines
 * Abstands zur Position; es gibt keine zeitgesteuerten CSS-Übergänge für Bewegung, Größe oder Deckkraft.
 *
 * React rendert während der Bewegung NICHT neu: Das Render-Fenster (welche Einträge im DOM stehen) wird aus
 * Position und Ziel berechnet (`windowOf`) und ändert sich nur mit dem logischen Zustand.
 */

/** Knoten einer Kategorie in der Leiste. */
export interface CategoryNodes {
  /** Äußerster Knoten: Ort (translate3d) und Deckkraft. */
  button: HTMLElement;
  /** Nur Schweben (translateY); eigene Ebene, damit der Ruhezustand ohne Neuzeichnen auskommt. */
  bob: HTMLElement;
  /** Größe, Streckung und Neigung. */
  scale: HTMLElement;
  /** Leuchten-Ebene (statischer Filter), ihre Deckkraft folgt dem Fokus. */
  glow: HTMLElement | null;
  label: HTMLElement | null;
}

/** Knoten eines Eintrags in einer Spalte. */
export interface ItemNodes {
  /** Ort (translate3d) und Deckkraft. */
  outer: HTMLElement;
  /** Nur Schweben (translateY): eigene Ebene, im Ruhezustand wird sie ohne Neuzeichnen bewegt. */
  float: HTMLElement;
  /** Fokus-Skalierung und Streckung der Kachel (liegt unter der Schwebe-Ebene, damit der Inhalt scharf bleibt). */
  scale: HTMLElement;
  /** Fokus-Skalierung des Textes (um dieselbe Mitte wie die Kachel). */
  text: HTMLElement;
  /** Abdunklung (Deckkraft = 1 − Fokus). */
  shade: HTMLElement | null;
  /** Leuchten (Deckkraft = Fokus). */
  glow: HTMLElement | null;
  title: HTMLElement | null;
}

/** Was die Maschine von React braucht. */
export interface MotionHost {
  /** Das Render-Fenster hat sich geändert (z. B. nach einem weiten Sprung): bitte neu rendern. */
  requestRender(): void;
  /** Die Detailkarte ist unsichtbar: bitte auf den aktuell gewünschten Eintrag umstellen. */
  swapDetail(): void;
}

/** Metadaten einer Kategorie/Spalte beim Abgleich mit React. */
export interface ColumnMeta {
  id: string;
  count: number;
  /** Zeilenabstand der Spalte (ITEM_PITCH oder ITEM_PITCH_ART). */
  pitch: number;
  /** Logischer Fokus-Index (bereits begrenzt). */
  focus: number;
}

const NaNv = Number.NaN;
/** Zeitschritt für das erste Bild nach einer Ruhephase (s). */
const FIRST_DT = 1 / 60;
const TWO_PI = Math.PI * 2;
const MODE_NORMAL = 0;
const MODE_OUT = 1;

interface ItemNode extends ItemNodes {
  index: number;
  focusScale: number;
  // zuletzt geschriebene Werte (NaN = noch nie)
  ky: number;
  ko: number;
  ksc: number;
  kbob: number;
  kst: number;
  kshade: number;
  kglow: number;
  kweight: number;
  /** pointer-events: none gesetzt? */
  kpe: boolean;
}

interface CatState {
  id: string;
  /** Logischer Platz in der Leiste. */
  index: number;
  /** Sichtbarer Platz (Feder zum Index): Einfügen/Entfernen anderer Kategorien lässt die Leiste gleiten. */
  slot: Spring;
  /** 0 → 1 für neu hinzugekommene Kategorien. */
  appear: Spring;
  nodes: CategoryNodes | null;
  kx: number;
  ko: number;
  ksc: number;
  kbob: number;
  kst: number;
  klean: number;
  kglow: number;
  klabelA: number;
  glowVisible: boolean;
}

interface ColState {
  id: string;
  count: number;
  pitch: number;
  curve: Curve;
  /** Sichtbare Position (Index-Einheiten) und Geschwindigkeit. */
  pos: Spring;
  target: number;
  mode: number;
  /** Bei weitem Sprung: das Ziel, zu dem nach dem Ausblenden gewechselt wird. */
  pending: number;
  dir: number;
  /** Deckkraft-Feder des Spaltenausschnitts (weiter Sprung: aus → Tausch → ein). */
  fade: Spring;
  /** Anlauf nach einem weiten Sprung: kritisch gedämpft. */
  entering: boolean;
  el: HTMLElement | null;
  items: Map<number, ItemNode>;
  kx: number;
  krise: number;
  kalpha: number;
  /** 1 = sichtbar, 0 = versteckt, −1 = noch nicht geschrieben. */
  kvis: number;
}

interface DetailState {
  el: HTMLElement | null;
  alpha: Spring;
  wantedId: string | null;
  shownId: string | null;
  wantedAt: number;
  swapAsked: boolean;
  ko: number;
  kt: number;
  kvis: number;
}

/** Ein Knoten, dessen Schweben im Ruhezustand eine Web-Animation übernimmt. */
interface Floater {
  anim: Animation;
  /** Schreibt den Schwebe-Versatz (rem) per Hand und merkt ihn sich (Übergabe zurück an die Schleife). */
  write: (bob: number) => void;
  period: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const differs = (a: number, b: number, eps: number) => !(Math.abs(a - b) <= eps);

export class MotionEngine {
  private host: MotionHost | null = null;
  private reduced = false;

  private readonly cats = new Map<string, CatState>();
  private readonly cols = new Map<string, ColState>();
  private readonly catPos: Spring = makeSpring(0);
  private catTarget = 0;
  private activeId: string | null = null;
  private synced = false;

  private readonly detail: DetailState = {
    el: null,
    alpha: makeSpring(0),
    wantedId: null,
    shownId: null,
    wantedAt: 0,
    swapAsked: false,
    ko: NaNv,
    kt: NaNv,
    kvis: -1,
  };

  private raf = 0;
  private last = 0;
  private lastApply = 0;
  private wasMoving = true;
  private idleSince = 0;
  private running = false;
  private renderAsked = false;
  private syncSig = "";
  /** Schwebende Knoten, die gerade von einer Web-Animation bewegt werden (nur im Ruhezustand). */
  private floaters: Floater[] = [];

  setHost(host: MotionHost | null) {
    this.host = host;
  }

  /** Reduzierte Bewegung: Positionen springen direkt, kein Schweben, keine Streckung. */
  setReduced(reduced: boolean) {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    if (reduced) this.snapAll();
    this.wake();
  }

  get isReduced() {
    return this.reduced;
  }

  /* ------------------------------------------------------------------ Registrierung der Knoten */

  attachCategory(id: string, nodes: CategoryNodes): () => void {
    const c = this.cat(id);
    c.nodes = nodes;
    c.kx = c.ko = c.ksc = c.kbob = c.kst = c.klean = c.kglow = c.klabelA = NaNv;
    c.glowVisible = false;
    this.applyCategory(c, performance.now());
    this.wake();
    return () => {
      this.wake();
      if (c.nodes === nodes) c.nodes = null;
    };
  }

  attachColumn(id: string, el: HTMLElement): () => void {
    const col = this.col(id);
    col.el = el;
    col.kx = col.krise = col.kalpha = NaNv;
    col.kvis = -1;
    this.applyColumn(col, performance.now());
    return () => {
      if (col.el === el) col.el = null;
    };
  }

  /** Neu eingehängte Einträge bekommen ihre Position und Deckkraft sofort (vor dem ersten Paint). */
  attachItem(colId: string, index: number, nodes: ItemNodes, focusScale: number): () => void {
    const col = this.col(colId);
    const node: ItemNode = {
      ...nodes,
      index,
      focusScale,
      ky: NaNv,
      ko: NaNv,
      ksc: NaNv,
      kbob: NaNv,
      kst: NaNv,
      kshade: NaNv,
      kglow: NaNv,
      kweight: NaNv,
      kpe: false,
    };
    col.items.set(index, node);
    this.writeItem(col, node, performance.now(), true);
    this.wake();
    return () => {
      this.wake();
      if (col.items.get(index) === node) col.items.delete(index);
    };
  }

  attachDetail(el: HTMLElement): () => void {
    const d = this.detail;
    d.el = el;
    d.ko = d.kt = NaNv;
    d.kvis = -1;
    this.applyDetail();
    this.wake();
    return () => {
      if (d.el === el) d.el = null;
    };
  }

  /* ------------------------------------------------------------------ Zustand von React */

  /**
   * Gleicht Kategorien und Spalten mit dem logischen Zustand ab (nach jedem Render). Neue Kategorien gleiten
   * hinein, entfernte verschwinden; ändert sich der Platz der aktiven Kategorie nur durch Einfügen davor,
   * verschiebt sich die Leiste mit, ohne dass der Fokus springt.
   */
  sync(list: ColumnMeta[], activeIndex: number) {
    const first = !this.synced;
    // Nichts geändert (z. B. Neurendern durch die Uhr): weder anwenden noch aufwecken – der Ruhezustand bleibt ruhig
    const sig = `${activeIndex}|${list.map((m) => `${m.id}:${m.count}:${m.pitch}:${m.focus}`).join(",")}`;
    if (!first && sig === this.syncSig) return;
    this.syncSig = sig;
    this.synced = true;

    const active = list[activeIndex];
    // Einfügen/Entfernen VOR der aktiven Kategorie verschiebt ihren Platz: Das Koordinatensystem der Leiste wird mit
    // verschoben (alle Plätze und die Leistenposition), damit nichts springt. Die Kategorien davor gleiten dann auf
    // ihren neuen Platz, die ab der Einfügestelle bleiben, wo sie sind.
    if (!first && active && this.activeId === active.id && this.catTarget !== activeIndex) {
      const delta = activeIndex - this.catTarget;
      this.catPos.x += delta;
      for (const c of this.cats.values()) c.slot.x += delta;
      this.catTarget = activeIndex;
    }

    const ids = new Set<string>();
    list.forEach((m, i) => {
      ids.add(m.id);
      const c = this.cats.get(m.id) ?? this.cat(m.id, i, first);
      c.index = i;
      const col = this.col(m.id);
      const countChanged = col.count !== m.count;
      col.count = m.count;
      if (col.pitch !== m.pitch) {
        col.pitch = m.pitch;
        col.curve = itemYCurve(m.pitch);
      }
      const target = clamp(m.focus, 0, Math.max(0, m.count - 1));
      // Eingaben stellen das Ziel schon vorher (retargetColumn) und sind maßgeblich; hier zählt nur, was sich durch
      // eine geänderte Listenlänge ergibt (Fokus wird begrenzt bzw. kehrt zurück): dann ohne Animation übernehmen.
      if (first) this.snapColumn(col, target);
      else if (countChanged) {
        if (col.mode === MODE_OUT) col.pending = target;
        else this.snapColumn(col, target);
      }
    });
    for (const id of [...this.cats.keys()]) {
      if (!ids.has(id)) {
        this.cats.delete(id);
        this.cols.delete(id);
      }
    }

    if (active) {
      if (first || this.activeId === null) {
        this.catPos.x = activeIndex;
        this.catPos.v = 0;
        this.catTarget = activeIndex;
      } else if (this.activeId !== active.id) {
        // Die aktive Kategorie ist verschwunden: zur neuen gleiten
        this.catTarget = activeIndex;
      }
      this.activeId = active.id;
    }
    if (first) this.snapSlots();
    // Kein Bild mit alten Werten zeigen: sofort schreiben, noch vor dem Paint
    this.apply(performance.now());
    this.wake();
  }

  /** Eingabe: andere Kategorie gewählt. */
  retargetCategory(id: string, index: number) {
    this.activeId = id;
    this.catTarget = index;
    if (this.reduced) this.snapAll();
    this.wake();
  }

  /** Eingabe: anderer Fokus in einer Spalte. */
  retargetColumn(id: string, target: number, count: number) {
    const col = this.col(id);
    col.count = count;
    const t = clamp(target, 0, Math.max(0, count - 1));
    if (this.reduced) {
      this.snapColumn(col, t);
      this.wake();
      return;
    }
    if (col.mode === MODE_OUT) {
      col.pending = t;
      this.wake();
      return;
    }
    if (Math.abs(t - col.pos.x) > JUMP_FAR_ITEMS) {
      if (this.columnLive(col)) {
        // Weiter Sprung: Liste ausblenden, Ausschnitt tauschen, vom Ziel her einblenden
        col.mode = MODE_OUT;
        col.pending = t;
        col.dir = Math.sign(t - col.pos.x) || 1;
        col.target = col.pos.x + col.dir * JUMP_DRIFT_ITEMS;
        this.host?.requestRender(); // das Fenster um das neue Ziel muss schon im DOM stehen
      } else {
        this.snapColumn(col, t); // unsichtbare Liste: nichts zu animieren
      }
    } else {
      col.target = t;
    }
    this.wake();
  }

  /**
   * Welche Index-Bereiche der Spalte im DOM stehen sollen. Aus Position und Ziel berechnet: Alles, was während
   * der Fahrt sichtbar werden kann, ist schon da; Einträge am Rand haben dort Deckkraft 0 (kein Poppen).
   */
  windowOf(id: string, count: number, focus: number): Array<[number, number]> {
    const col = this.cols.get(id);
    const span = (a: number, b: number): [number, number] => [
      Math.floor(Math.min(a, b)) - WINDOW_BEFORE,
      Math.ceil(Math.max(a, b)) + WINDOW_AFTER,
    ];
    let ranges: Array<[number, number]>;
    if (!col) ranges = [span(focus, focus)];
    else if (col.mode === MODE_OUT) {
      // alter Ausschnitt (blendet aus) und neuer Ausschnitt samt Anlauf (blendet ein)
      ranges = [span(col.pos.x, col.target), span(col.pending - col.dir * JUMP_ENTER_ITEMS, col.pending)];
    } else ranges = [span(col.pos.x, focus), span(col.target, focus)];
    const out: Array<[number, number]> = [];
    for (const [a, b] of ranges.sort((p, q) => p[0] - q[0])) {
      const lo = Math.max(0, a);
      const hi = Math.min(count - 1, b);
      if (hi < lo) continue;
      const prev = out[out.length - 1];
      if (prev && lo <= prev[1] + 1) prev[1] = Math.max(prev[1], hi);
      else out.push([lo, hi]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ Detailkarte */

  setDetailWanted(id: string | null) {
    const d = this.detail;
    if (d.wantedId === id) return;
    d.wantedId = id;
    d.wantedAt = performance.now();
    this.wake();
  }

  setDetailShown(id: string | null) {
    const d = this.detail;
    if (d.shownId === id) return;
    d.shownId = id;
    d.swapAsked = false;
    this.wake();
  }

  /* ------------------------------------------------------------------ Schleife */

  start() {
    this.running = true;
    this.last = 0;
    this.wake();
  }

  stop() {
    this.running = false;
    this.disarmFloat();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private wake() {
    if (this.floaters.length) this.disarmFloat();
    this.idleSince = 0;
    if (!this.running || this.raf) return;
    this.last = 0; // nach einer Ruhephase beginnt die Zeitmessung neu (kein Riesen-Zeitschritt)
    this.raf = requestAnimationFrame(this.xmbFrame);
  }

  /** Alles sofort auf den Zielzustand setzen (reduzierte Bewegung, lange Pause). */
  private snapAll() {
    this.catPos.x = this.catTarget;
    this.catPos.v = 0;
    this.snapSlots();
    for (const col of this.cols.values()) {
      if (col.mode === MODE_OUT) {
        // Der Sprung ist beendet; der alte Ausschnitt kann aus dem DOM
        this.snapColumn(col, col.pending);
        this.renderLater();
      } else this.snapColumn(col, col.target);
    }
    for (const c of this.cats.values()) {
      c.appear.x = 1;
      c.appear.v = 0;
    }
    this.detail.alpha.v = 0;
  }

  private snapSlots() {
    for (const c of this.cats.values()) {
      c.slot.x = c.index;
      c.slot.v = 0;
    }
  }

  private snapColumn(col: ColState, target: number) {
    col.mode = MODE_NORMAL;
    col.target = target;
    col.pos.x = target;
    col.pos.v = 0;
    col.fade.x = 1;
    col.fade.v = 0;
    col.entering = false;
  }

  private renderLater() {
    if (this.renderAsked) return;
    this.renderAsked = true;
    queueMicrotask(() => {
      this.renderAsked = false;
      this.host?.requestRender();
    });
  }

  private cat(id: string, index = 0, instant = true): CatState {
    let c = this.cats.get(id);
    if (!c) {
      c = {
        id,
        index,
        slot: makeSpring(index),
        appear: makeSpring(instant ? 1 : 0),
        nodes: null,
        kx: NaNv,
        ko: NaNv,
        ksc: NaNv,
        kbob: NaNv,
        kst: NaNv,
        klean: NaNv,
        kglow: NaNv,
        klabelA: NaNv,
        glowVisible: false,
      };
      this.cats.set(id, c);
    }
    return c;
  }

  private col(id: string): ColState {
    let col = this.cols.get(id);
    if (!col) {
      const pitch = 6.2;
      col = {
        id,
        count: 0,
        pitch,
        curve: itemYCurve(pitch),
        pos: makeSpring(0),
        target: 0,
        mode: MODE_NORMAL,
        pending: 0,
        dir: 1,
        fade: makeSpring(1),
        entering: false,
        el: null,
        items: new Map(),
        kx: NaNv,
        krise: NaNv,
        kalpha: NaNv,
        kvis: -1,
      };
      this.cols.set(id, col);
    }
    return col;
  }

  /** Anteil, mit dem die Spalte an der Leiste steht (1 = genau dort, 0 = ≥ 1 Platz entfernt). */
  private columnShare(col: ColState): number {
    const c = this.cats.get(col.id);
    if (!c) return 0;
    return Math.max(0, 1 - Math.abs(c.slot.x - this.catPos.x));
  }

  private columnLive(col: ColState): boolean {
    return this.columnShare(col) > 0.001;
  }

  /* ------------------------------------------------------------------ Bild für Bild */

  /** Der Name erscheint in Messungen der rAF-Callbacks ("xmbFrame"). */
  private xmbFrame = (stamp: number): void => {
    this.raf = 0;
    if (!this.running) return;
    // Das erste Bild nach einer Ruhephase trägt mitunter einen veralteten Zeitstempel: dort die echte Uhr nehmen
    const first = this.last === 0;
    const now = first ? performance.now() : stamp;
    const rawDt = first ? FIRST_DT : (now - this.last) / 1000;
    this.last = now;
    let forced = false;
    if (rawDt > STALL_S) {
      // Lange Pause (Tab im Hintergrund, Standby): nicht in einer alten Bewegung weiterlaufen
      this.snapAll();
      forced = true;
    }
    const moving = this.step(Math.min(Math.max(rawDt, 0), DT_MAX), now);
    // Im Ruhezustand genügt ein Teil der Bilder für das langsame Schweben
    if (moving || this.wasMoving || forced || now - this.lastApply >= IDLE_FRAME_MS - 3) {
      this.lastApply = now;
      this.apply(now);
    }
    this.wasMoving = moving;
    if (moving) this.idleSince = 0;
    else if (this.idleSince === 0) this.idleSince = now;
    if (moving) {
      this.raf = requestAnimationFrame(this.xmbFrame);
    } else if (this.reduced) {
      // Reduzierte Bewegung: nichts schwebt, die Schleife ruht bis zur nächsten Eingabe
    } else if (now - this.idleSince >= IDLE_ARM_MS && this.armFloat()) {
      // Schweben läuft jetzt im Browser; die Schleife ruht bis zur nächsten Eingabe
    } else {
      this.raf = requestAnimationFrame(this.xmbFrame);
    }
  };

  /**
   * Übergibt das Schweben im Ruhezustand an Web-Animationen (laufen ohne Hauptthread). Rückgabe false, wenn die
   * Schleife weiterlaufen muss (kein Browser-Support).
   */
  private armFloat(): boolean {
    if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return false;
    this.apply(performance.now()); // Endzustand sicher geschrieben
    const t = performance.now();
    const make = (el: HTMLElement, period: number, write: (bob: number) => void) => {
      const frames: Keyframe[] = [];
      for (let k = 0; k <= BOB_KEYFRAMES; k++) {
        const u = k / BOB_KEYFRAMES;
        frames.push({ offset: u, transform: `translate3d(0,${r3(-BOB_REM * (1 - Math.cos(u * TWO_PI)) * 0.5)}rem,0)` });
      }
      const anim = el.animate(frames, { duration: period, iterations: Infinity, easing: "linear" });
      anim.id = "xmb-float";
      anim.currentTime = ((t % period) + period) % period; // gleiche Phase wie die Schleife
      this.floaters.push({ anim, write, period });
    };
    const cat = this.activeId ? this.cats.get(this.activeId) : undefined;
    if (cat?.nodes && Math.abs(cat.slot.x - this.catPos.x) < 1e-6) {
      const n = cat.nodes;
      make(n.bob, CAT_BOB_MS, (bob) => {
        cat.kbob = bob;
        n.bob.style.transform = `translate3d(0,${r3(bob)}rem,0)`;
      });
    }
    const col = this.activeId ? this.cols.get(this.activeId) : undefined;
    if (col && col.mode === MODE_NORMAL && col.pos.v === 0 && this.columnShare(col) > 0.999) {
      const n = col.items.get(col.pos.x);
      if (n) {
        make(n.float, ITEM_BOB_MS, (bob) => {
          n.kbob = bob;
          n.float.style.transform = `translate3d(0,${r3(bob)}rem,0)`;
        });
      }
    }
    return true;
  }

  /** Nimmt die Web-Animationen weg und schreibt den aktuellen Versatz, damit die Schleife nahtlos übernimmt. */
  private disarmFloat() {
    if (!this.floaters.length) return;
    const now = performance.now();
    const list = this.floaters;
    this.floaters = [];
    for (const f of list) {
      f.anim.cancel();
      f.write(-BOB_REM * (1 - Math.cos((now / f.period) * TWO_PI)) * 0.5);
    }
  }

  /** Rechnet alle Federn einen Schritt weiter. Rückgabe: bewegt sich noch etwas? */
  private step(dt: number, now: number): boolean {
    let moving = false;

    // Kategorie-Achse
    const cp = this.catPos;
    if (cp.x !== this.catTarget || cp.v !== 0) {
      stepSpring(cp, this.catTarget, CAT_OMEGA, CAT_ZETA, dt);
      if (Math.abs(cp.x - this.catTarget) < REST_POS && Math.abs(cp.v) < REST_VEL) {
        cp.x = this.catTarget;
        cp.v = 0;
      } else moving = true;
    }

    for (const c of this.cats.values()) {
      if (c.slot.x !== c.index || c.slot.v !== 0) {
        stepSpring(c.slot, c.index, SLOT_OMEGA, 1, dt);
        if (Math.abs(c.slot.x - c.index) < REST_POS && Math.abs(c.slot.v) < REST_VEL) {
          c.slot.x = c.index;
          c.slot.v = 0;
        } else moving = true;
      }
      if (c.appear.x !== 1) {
        stepSpring(c.appear, 1, APPEAR_OMEGA, 1, dt);
        if (1 - c.appear.x < 0.002 && Math.abs(c.appear.v) < 0.02) {
          c.appear.x = 1;
          c.appear.v = 0;
        } else moving = true;
      }
    }

    // Spalten
    for (const col of this.cols.values()) {
      // Die logisch aktive Spalte läuft immer; unsichtbare brauchen keine Animation.
      if (col.mode === MODE_NORMAL && col.id !== this.activeId && !this.columnLive(col)) {
        if (col.pos.x !== col.target || col.pos.v !== 0) this.snapColumn(col, col.target);
        continue;
      }
      if (col.mode === MODE_OUT) {
        stepSpring(col.fade, 0, JUMP_OUT_OMEGA, 1, dt);
        if (col.fade.x < JUMP_SWAP_ALPHA) {
          // Alte Liste ist weg: Ausschnitt tauschen und vom Ziel her hineingleiten
          col.mode = MODE_NORMAL;
          col.pos.x = col.pending - col.dir * JUMP_ENTER_ITEMS;
          col.pos.v = 0;
          col.target = col.pending;
          col.entering = true;
          col.fade.v = 0;
          this.host?.requestRender(); // der alte Ausschnitt kann aus dem DOM
        }
        moving = true;
      } else if (col.fade.x !== 1) {
        stepSpring(col.fade, 1, JUMP_IN_OMEGA, 1, dt);
        if (1 - col.fade.x < 0.002 && Math.abs(col.fade.v) < 0.02) {
          col.fade.x = 1;
          col.fade.v = 0;
        } else moving = true;
      }
      const p = col.pos;
      if (p.x !== col.target || p.v !== 0) {
        stepSpring(p, col.target, ITEM_OMEGA, col.entering ? 1 : ITEM_ZETA, dt);
        if (col.mode === MODE_NORMAL && Math.abs(p.x - col.target) < REST_POS && Math.abs(p.v) < REST_VEL) {
          p.x = col.target;
          p.v = 0;
          col.entering = false;
        } else moving = true;
      }
    }

    // Detailkarte
    const d = this.detail;
    const mismatch = d.wantedId !== d.shownId;
    if (this.reduced) {
      d.alpha.x = d.shownId ? 1 : 0;
      d.alpha.v = 0;
      if (mismatch && !d.swapAsked) {
        d.swapAsked = true;
        this.host?.swapDetail();
      }
    } else {
      const aTarget = mismatch ? 0 : d.shownId ? 1 : 0;
      stepSpring(d.alpha, aTarget, mismatch ? DETAIL_OUT_OMEGA : DETAIL_IN_OMEGA, 1, dt);
      if (d.alpha.x < 0) d.alpha.x = 0;
      else if (d.alpha.x > 1) d.alpha.x = 1;
      if (Math.abs(d.alpha.x - aTarget) < 0.002 && Math.abs(d.alpha.v) < 0.02) {
        d.alpha.x = aTarget;
        d.alpha.v = 0;
      } else moving = true;
      if (mismatch) {
        moving = true; // wartet auf Ausblenden und Ruhe
        const calm = now - d.wantedAt >= DETAIL_CALM_MS;
        if (!d.swapAsked && calm && (d.alpha.x < DETAIL_SWAP_ALPHA || !d.shownId)) {
          d.swapAsked = true;
          this.host?.swapDetail();
        }
      }
    }
    return moving;
  }

  /** Schreibt alle sichtbaren Knoten. Erst rechnen, dann schreiben; keine Layout-Lesezugriffe. */
  private apply(now: number) {
    for (const c of this.cats.values()) this.applyCategory(c, now);
    for (const col of this.cols.values()) this.applyColumn(col, now);
    this.applyDetail();
  }

  private applyCategory(c: CatState, now: number) {
    const n = c.nodes;
    if (!n) return;
    const d = c.slot.x - this.catPos.x;
    const x = categoryXAt(d);
    const op = categoryOpacityAt(d) * c.appear.x;
    const g = focusCurve(d);
    const reduced = this.reduced;

    if (differs(x, c.kx, 0.002)) {
      c.kx = x;
      n.button.style.transform = `translate3d(${r3(x)}rem,${ROW_Y}rem,0)`;
    }
    if (differs(op, c.ko, 0.003)) {
      c.ko = op;
      n.button.style.opacity = String(r3(op));
    }

    // Schweben (nur das Icon der aktiven Kategorie, Amplitude folgt dem Fokus)
    const bob = reduced ? 0 : -BOB_REM * g * (1 - Math.cos((now / CAT_BOB_MS) * TWO_PI)) * 0.5;
    if (differs(bob, c.kbob, 0.0015)) {
      c.kbob = bob;
      n.bob.style.transform = `translate3d(0,${r3(bob)}rem,0)`;
    }

    // Größe, Streckung und Neigung: waagerechte Geschwindigkeit in rem/s
    const vx = -CATEGORY_PITCH * this.catPos.v;
    const st = reduced ? 0 : Math.min(CAT_STRETCH_MAX, Math.abs(vx) * CAT_STRETCH_PER_REM_S);
    const lean = reduced ? 0 : clamp(vx * CAT_LEAN_DEG_PER_REM_S, -CAT_LEAN_MAX_DEG, CAT_LEAN_MAX_DEG);
    const sc = 1 + (CATEGORY_FOCUS_SCALE - 1) * g;
    if (differs(sc, c.ksc, 0.0008) || differs(st, c.kst, 0.0006) || differs(lean, c.klean, 0.02)) {
      c.ksc = sc;
      c.kst = st;
      c.klean = lean;
      const sx = sc * (1 + st);
      const sy = sc * (1 - st * SQUASH_RATIO);
      n.scale.style.transform = `rotate(${r3(lean)}deg) scale(${r4(sx)},${r4(sy)})`;
    }

    if (n.glow && differs(g, c.kglow, 0.004)) {
      c.kglow = g;
      n.glow.style.opacity = String(r3(g));
      const show = g > 0.004;
      if (show !== c.glowVisible) {
        c.glowVisible = show;
        n.glow.style.visibility = show ? "visible" : "hidden"; // ohne Leuchten keine Filterarbeit
      }
    }

    if (n.label) {
      const a = smoothstep(LABEL_FADE_FROM, 1, 1 - Math.abs(d));
      if (differs(a, c.klabelA, 0.004)) {
        c.klabelA = a;
        n.label.style.opacity = String(r3(a));
        n.label.style.transform = `translate(-50%,${r3(-LABEL_SLIDE_REM * (1 - a))}rem)`;
      }
    }
  }

  private applyColumn(col: ColState, now: number) {
    const el = col.el;
    const share = this.columnShare(col);
    const live = share > 0.001 || col.mode === MODE_OUT;
    if (!live) {
      if (el && col.kvis !== 0) {
        col.kvis = 0;
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        el.dataset.live = "0";
        col.kalpha = 0;
      }
      return;
    }
    const cat = this.cats.get(col.id);
    const slot = cat ? cat.slot.x : 0;
    const appear = cat ? cat.appear.x : 1;
    // Bei schneller Fahrt der Leiste bleiben die Listen aus (Geschwindigkeit der Kategorie-Achse, stetig)
    const gate = 1 - smoothstep(COLUMN_GATE_FROM, COLUMN_GATE_TO, Math.abs(this.catPos.v));
    const alpha = smoothstep(COLUMN_FADE_FROM, COLUMN_FADE_TO, share) * clamp(col.fade.x, 0, 1) * appear * gate;
    const x = categoryXAt(slot - this.catPos.x);
    const rise = COLUMN_RISE_REM * (1 - alpha);
    if (el) {
      const visible = alpha > 0.002;
      if (visible !== (col.kvis === 1)) {
        col.kvis = visible ? 1 : 0;
        el.style.visibility = visible ? "visible" : "hidden";
        el.dataset.live = visible ? "1" : "0"; // Ebenen (will-change) gibt es nur für sichtbare Spalten
      }
      if (differs(x, col.kx, 0.002) || differs(rise, col.krise, 0.002)) {
        col.kx = x;
        col.krise = rise;
        el.style.transform = `translate3d(${r3(x)}rem,${r3(rise)}rem,0)`;
      }
      if (differs(alpha, col.kalpha, 0.003)) {
        col.kalpha = alpha;
        el.style.opacity = String(r3(alpha));
      }
    }
    if (alpha <= 0.002) return; // nichts zu sehen: Einträge müssen nicht nachgeführt werden
    for (const n of col.items.values()) this.writeItem(col, n, now, false, share);
  }

  /** Berechnet einen Eintrag aus seinem Abstand zur Position und schreibt nur geänderte Werte. */
  private writeItem(col: ColState, n: ItemNode, now: number, force: boolean, share = 1) {
    const d = n.index - col.pos.x;
    const reduced = this.reduced;
    if (d <= ITEM_D_MIN || d >= ITEM_D_MAX) {
      // Außerhalb des sichtbaren Bereichs: nur noch ausblenden (einmal), nicht mehr nachführen
      if (force || n.ko !== 0) {
        n.ko = 0;
        n.outer.style.opacity = "0";
        if (force || !n.kpe) {
          n.kpe = true;
          n.outer.style.pointerEvents = "none";
        }
        if (force) {
          n.ky = evalCurve(col.curve, d);
          n.outer.style.transform = `translate3d(0,${r3(n.ky)}rem,0)`;
        }
      }
      return;
    }
    const y = evalCurve(col.curve, d);
    const op = itemOpacityAt(d);
    const g = focusCurve(d);

    if (force || differs(y, n.ky, 0.0015)) {
      n.ky = y;
      n.outer.style.transform = `translate3d(0,${r3(y)}rem,0)`;
    }
    if (force || differs(op, n.ko, 0.003)) {
      n.ko = op;
      n.outer.style.opacity = String(r3(op));
    }
    const faint = op < 0.05;
    if (force || faint !== n.kpe) {
      n.kpe = faint;
      n.outer.style.pointerEvents = faint ? "none" : "";
    }

    // Streckung (senkrecht, nur als Bewegungsgefühl) aus der Geschwindigkeit der Kachel in rem/s
    let st = 0;
    if (!reduced && col.pos.v !== 0) {
      const h = 0.02;
      const slope = (evalCurve(col.curve, d + h) - evalCurve(col.curve, d - h)) / (2 * h);
      st = Math.min(ITEM_STRETCH_MAX, Math.abs(slope * col.pos.v) * ITEM_STRETCH_PER_REM_S);
    }
    const sc = 1 + (n.focusScale - 1) * g;
    if (force || differs(sc, n.ksc, 0.0008) || differs(st, n.kst, 0.0006)) {
      const textChanged = force || differs(sc, n.ksc, 0.0008);
      n.ksc = sc;
      n.kst = st;
      if (textChanged) n.text.style.transform = `scale(${r4(sc)})`;
      n.scale.style.transform =
        st > 0.0006 ? `scale(${r4(sc * (1 - st * SQUASH_RATIO))},${r4(sc * (1 + st))})` : `scale(${r4(sc)})`;
    }

    // Schweben (eigene Ebene)
    const bob = reduced ? 0 : -BOB_REM * g * share * (1 - Math.cos((now / ITEM_BOB_MS) * TWO_PI)) * 0.5;
    if (force || differs(bob, n.kbob, 0.0015)) {
      n.kbob = bob;
      n.float.style.transform = `translate3d(0,${r3(bob)}rem,0)`;
    }

    if (n.shade && (force || differs(1 - g, n.kshade, 0.004))) {
      n.kshade = 1 - g;
      n.shade.style.opacity = String(r3(1 - g));
    }
    if (n.glow && (force || differs(g, n.kglow, 0.004))) {
      const was = n.kglow > 0.004;
      n.kglow = g;
      n.glow.style.opacity = String(r3(g));
      const show = g > 0.004;
      if (force || show !== was) n.glow.style.visibility = show ? "visible" : "hidden"; // nur der Fokus braucht eine Ebene
    }
    if (n.title) {
      const w = Math.round((TITLE_WEIGHT + (TITLE_WEIGHT_FOCUS - TITLE_WEIGHT) * g) / 10) * 10;
      if (force || w !== n.kweight) {
        n.kweight = w;
        n.title.style.fontWeight = String(w);
      }
    }
  }

  private applyDetail() {
    const d = this.detail;
    const el = d.el;
    if (!el) return;
    const a = d.alpha.x;
    const visible = a >= 0.004;
    if (visible !== (d.kvis === 1)) {
      d.kvis = visible ? 1 : 0;
      el.style.visibility = visible ? "visible" : "hidden";
    }
    if (differs(a, d.ko, 0.003)) {
      d.ko = a;
      el.style.opacity = String(r3(a));
    }
    const rise = DETAIL_RISE_REM * (1 - a);
    if (differs(rise, d.kt, 0.002)) {
      d.kt = rise;
      el.style.transform = `translate3d(0,${r3(rise)}rem,0)`;
    }
  }
}
