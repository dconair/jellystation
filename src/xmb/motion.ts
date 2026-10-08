/**
 * Bewegungs-Feeling der XMB – alle Zahlen zum Nachjustieren stehen hier oben.
 *
 * Prinzip: Pro Achse gibt es EINE kontinuierliche Position (Kategorien: `catPos`, Einträge je Spalte:
 * `itemPos`), die per Feder dem logischen Ziel folgt. Jedes Element wird in jedem Bild als reine Funktion
 * dieser Position berechnet (Abstand d = index − pos → Ort, Größe, Deckkraft, Leuchten). Es gibt deshalb
 * keine unabhängig laufenden Übergänge mehr: nichts hängt hinterher, nichts bleibt als Geisterbild stehen,
 * und neue Tasten ändern nur das Ziel – die Geschwindigkeit bleibt erhalten.
 *
 * Aufbau:
 *  1. Federn (wie straff, wie viel Überschwingen)
 *  2. Spalten, Sprünge und Detailkarte
 *  3. Lebendigkeit (Schweben, Streckung, Neigung)
 *  4. Mathe-Helfer (exakte Feder-Lösung, Übergangskurven)
 */

// ───────────────────────── 1. Federn ─────────────────────────

/**
 * Eigenfrequenz der Federn in rad/s: Größer = straffer und schneller (Einschwingzeit ≈ 6 / ω).
 * Empfohlen 18–32; unter 15 wirkt es träge, über 36 ruckartig.
 */
export const CAT_OMEGA = 22;
export const ITEM_OMEGA = 25;

/**
 * Dämpfung: 1 = kritisch (kein Überschwingen), kleiner = leichtes Nachschwingen.
 * Überschwingen eines Einzelschritts ≈ exp(−π·ζ/√(1−ζ²)): 0,75 → 2,8 %, 0,8 → 1,5 %, 0,85 → 0,6 %, 0,9 → 0,2 %.
 * Beim Auslaufen aus schnellem Tastenwiederholen (Gedrückthalten) schwingt es etwa 3–4× so weit über wie bei einem
 * Einzelschritt; mit 0,85 bleibt auch das unter 3 %. Empfohlen 0,8–0,95 (unter 0,75 wird es wabbelig).
 */
export const CAT_ZETA = 0.82;
export const ITEM_ZETA = 0.85;

/** Feder, mit der Kategorien beim Einfügen/Entfernen auf ihren neuen Platz gleiten (kritisch gedämpft). */
export const SLOT_OMEGA = 13;
/** Einblenden neu hinzugekommener Kategorien (ω, kritisch gedämpft). */
export const APPEAR_OMEGA = 10;

/**
 * Größter Zeitschritt der Simulation (s). Bei Hängern (langer Frame) rechnet die Feder höchstens so weit
 * weiter, damit die Bewegung nicht springt.
 */
export const DT_MAX = 0.05;
/**
 * Ab so viel Stillstand zwischen zwei Bildern (s; z. B. Tab im Hintergrund, Standby) springt alles direkt
 * auf den Zielzustand, statt mitten in einer alten Bewegung weiterzulaufen.
 */
export const STALL_S = 0.25;
/** Restabstand (in Einträgen/Kategorien) und Restgeschwindigkeit (pro s), ab denen eine Feder einrastet. */
export const REST_POS = 0.0006;
export const REST_VEL = 0.012;

// ───────────────────────── 2. Spalten, Sprünge, Detailkarte ─────────────────────────

/**
 * Spaltenwechsel = Kreuzblende aus derselben Kategorie-Position: Eine Spalte ist sichtbar, solange ihre
 * Kategorie nahe an der Leiste steht. Anteil = 1 − |Abstand|; zwischen FROM und TO blendet sie weich ein.
 * FROM höher = die neue Liste erscheint später (weniger Überlappung mit der alten).
 */
export const COLUMN_FADE_FROM = 0.3;
export const COLUMN_FADE_TO = 0.96;
/** So weit (rem) steigt eine einblendende Spalte von unten auf (und sinkt die ausblendende ab). */
export const COLUMN_RISE_REM = 1.8;
/**
 * Beim schnellen Durchschalten der Kategorien (Geschwindigkeit der Leiste in Kategorien pro Sekunde) bleiben die
 * Listen unsichtbar und blenden erst ein, wenn die Leiste langsamer wird – sonst blitzt bei jeder Kategorie eine
 * halbtransparente Liste auf. Ein einzelner Schritt (Spitze ≈ 7 /s) wird kaum verzögert.
 */
export const COLUMN_GATE_FROM = 3;
export const COLUMN_GATE_TO = 7;

/**
 * Weite Sprünge (z. B. ○ zurück zum Anfang einer langen Liste) würden tausende Einträge durchrauschen.
 * Ab dieser Entfernung (in Einträgen) wird stattdessen die Liste kurz ausgeblendet, der Ausschnitt getauscht
 * und die Liste vom neuen Ziel her wieder eingeblendet. Kürzere Strecken werden komplett durchfahren.
 */
export const JUMP_FAR_ITEMS = 9;
/** Ausblenden der alten Liste (ω) und Einblenden der neuen (ω). Höher = knackiger. */
export const JUMP_OUT_OMEGA = 46;
export const JUMP_IN_OMEGA = 24;
/** Sobald die alte Liste unter diese Deckkraft fällt, wird getauscht. */
export const JUMP_SWAP_ALPHA = 0.07;
/** So viele Einträge treibt die alte Liste beim Ausblenden noch in Sprungrichtung weiter. */
export const JUMP_DRIFT_ITEMS = 2.5;
/**
 * So viele Einträge vor dem Ziel setzt die neue Liste an und gleitet dann hinein (kritisch gedämpft, also ohne
 * Überschwingen – bei langer Strecke würde die Unterdämpfung sonst sichtbar nachschwingen).
 */
export const JUMP_ENTER_ITEMS = 4.5;

/**
 * Detailkarte rechts: genau eine Karte. Bei Fokuswechsel blendet sie schnell aus (ω), wird erst dann – und nur
 * nach DETAIL_CALM_MS Ruhe (Entprellen, damit schnelles Blättern nicht flackert) – mit dem NEUEREN Eintrag
 * getauscht und blendet wieder ein.
 */
export const DETAIL_OUT_OMEGA = 52;
export const DETAIL_IN_OMEGA = 22;
export const DETAIL_CALM_MS = 90;
/** Unter dieser Deckkraft gilt die Karte als unsichtbar genug zum Tauschen. */
export const DETAIL_SWAP_ALPHA = 0.05;
/** Die Karte steigt beim Einblenden um so viele rem von unten auf. */
export const DETAIL_RISE_REM = 0.9;

// ───────────────────────── 3. Lebendigkeit ─────────────────────────

/** Schweben des fokussierten Icons: Hub (rem) und Dauer eines Auf-und-ab (ms). Amplitude folgt dem Fokus stetig. */
export const BOB_REM = 0.3;
export const CAT_BOB_MS = 4200;
export const ITEM_BOB_MS = 3800;
/** Bis zur Ruhe wird das Schweben nur so oft aktualisiert (ms): Es ist langsam, 30 Bilder/s reichen. */
export const IDLE_FRAME_MS = 33;
/**
 * Nach so langer Ruhe (ms) übernimmt für das Schweben eine Web-Animation, die der Browser ohne Hauptthread
 * abspielt: Im Ruhezustand läuft dann keine Schleife mehr. Beim nächsten Tastendruck übernimmt wieder die Schleife
 * (am selben Punkt der Kurve, kein Sprung).
 */
export const IDLE_ARM_MS = 250;
/** Stützstellen je Schwebe-Periode der Web-Animation (die Sinuskurve ist damit auf < 0,1 px genau). */
export const BOB_KEYFRAMES = 32;

/**
 * Streckung bewegter Icons nur als Bewegungsgefühl (keine Doppelbilder, keine Unschärfe):
 * in Bewegungsrichtung länger, quer dazu schmaler. Streckung = min(MAX, Geschwindigkeit[rem/s] · PRO_REM_S).
 * Einträge strecken sich senkrecht, Kategorie-Icons waagerecht (plus leichte Neigung in Fahrtrichtung).
 */
export const ITEM_STRETCH_PER_REM_S = 0.00065;
export const ITEM_STRETCH_MAX = 0.09;
export const CAT_STRETCH_PER_REM_S = 0.0007;
export const CAT_STRETCH_MAX = 0.1;
/** Anteil der Streckung, um den die Querrichtung schrumpft (0,5 ≈ Volumen bleibt ungefähr gleich). */
export const SQUASH_RATIO = 0.5;
/** Neigung der Kategorie-Icons in Fahrtrichtung: Grad pro rem/s, höchstens MAX Grad. */
export const CAT_LEAN_DEG_PER_REM_S = 0.04;
export const CAT_LEAN_MAX_DEG = 4;

/** Schriftstärke des Titels: unfokussiert → fokussiert (läuft stetig mit dem Fokus mit; variable Schrift). */
export const TITLE_WEIGHT = 300;
export const TITLE_WEIGHT_FOCUS = 400;
/** Beschriftung der aktiven Kategorie erscheint erst, wenn das Icon fast an der Leiste ist (Fokus-Anteil ab …). */
export const LABEL_FADE_FROM = 0.55;
/** So weit (rem) gleitet die Beschriftung beim Einblenden nach unten. */
export const LABEL_SLIDE_REM = 0.7;

// ───────────────────────── 4. Mathe-Helfer ─────────────────────────

export interface Spring {
  /** Position. */
  x: number;
  /** Geschwindigkeit (Einheiten pro Sekunde). */
  v: number;
}

export const makeSpring = (x = 0): Spring => ({ x, v: 0 });

/**
 * Exakte Lösung der gedämpften Schwingung x'' = −ω²(x − ziel) − 2ζω·x' für beliebiges dt.
 * Dadurch verhält sich die Bewegung bei 30, 60 oder 144 Hz gleich und bleibt bei langen Frames stabil.
 */
export function stepSpring(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  if (dt <= 0) return;
  const e = s.x - target;
  const v = s.v;
  if (zeta >= 0.999) {
    // kritisch gedämpft
    const ex = Math.exp(-omega * dt);
    const b = v + omega * e;
    s.x = target + ex * (e + b * dt);
    s.v = ex * (v - omega * b * dt);
    return;
  }
  const alpha = zeta * omega;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const ex = Math.exp(-alpha * dt);
  const c = Math.cos(wd * dt);
  const sn = Math.sin(wd * dt);
  s.x = target + ex * (e * c + ((v + alpha * e) / wd) * sn);
  s.v = ex * (v * c - ((alpha * v + omega * omega * e) / wd) * sn);
}

export const clamp = (n: number, min: number, max: number) => (n < min ? min : n > max ? max : n);
export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Weicher Übergang 0 → 1 zwischen a und b (Steigung an beiden Enden 0). */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Fokus-Anteil f = max(0, 1 − |d|) weich geformt: stetig, an Spitze und Rand ohne Knick. */
export function focusCurve(d: number): number {
  const f = 1 - Math.abs(d);
  return f <= 0 ? 0 : f * f * (3 - 2 * f);
}

/**
 * Monoton-kubische Interpolation (PCHIP) durch ganzzahlige Stützstellen. Liefert eine stetig differenzierbare
 * Kurve, die exakt durch die Ruhewerte läuft – ohne Knicke in der Geschwindigkeit an den Stützstellen.
 */
export interface Curve {
  /** Erste Stützstelle (ganzzahlig). */
  first: number;
  values: number[];
  slopes: number[];
}

export function makeCurve(first: number, values: number[]): Curve {
  const n = values.length;
  const secant: number[] = [];
  for (let i = 0; i < n - 1; i++) secant.push(values[i + 1] - values[i]);
  const slopes: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = secant[i - 1];
    const b = secant[i];
    // Vorzeichenwechsel oder Plateau: flache Tangente (Spitze bleibt rund, nichts schwingt über)
    slopes[i] = a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  }
  // Ränder: einseitige Sekante (verlängert die Kurve gerade weiter)
  slopes[0] = secant[0] ?? 0;
  slopes[n - 1] = secant[n - 2] ?? 0;
  return { first, values, slopes };
}

/** Wert der Kurve an der Stelle d; außerhalb der Stützstellen linear fortgesetzt. */
export function evalCurve(c: Curve, d: number): number {
  const n = c.values.length;
  const u = d - c.first;
  if (u <= 0) return c.values[0] + c.slopes[0] * u;
  if (u >= n - 1) return c.values[n - 1] + c.slopes[n - 1] * (u - (n - 1));
  const i = Math.floor(u);
  const t = u - i;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * c.values[i] +
    (t3 - 2 * t2 + t) * c.slopes[i] +
    (-2 * t3 + 3 * t2) * c.values[i + 1] +
    (t3 - t2) * c.slopes[i + 1]
  );
}
