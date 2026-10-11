/**
 * Darstellungs- und Klang-Einstellungen (Helligkeit, Farben, Animationen, Musik).
 *
 * Eine kleine, von React unabhängige Ablage: Der Wert lebt hier, Komponenten lesen ihn mit `useUiPrefs()`,
 * außerhalb von React mit `getUiPrefs()`/`subscribeUiPrefs()`. Gespeichert wird in `settings.ui` (Tauri-Store bzw.
 * localStorage im Browser): App.tsx ruft beim Start `initUiPrefs(gespeichert, onPersist)` auf; jede Änderung ruft
 * danach (entprellt) `onPersist(prefs)` auf.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_MOOD, isMoodId } from "../audio/moods";
import type { MoodId } from "../audio/moods";
import { monthHues } from "../xmb/background/palette";

export type AnimationMode = "full" | "reduced" | "off";

/**
 * Hintergrund-Designs (siehe src/xmb/background/styles.ts). "xmb" ist das seidige Tuch wie auf der PS3 (Standard);
 * "ps3" sind die bisherigen JellyStation-Wellen mit Formen und Partikeln und bleiben als Option erhalten.
 */
export const BACKGROUND_STYLES = [
  { id: "xmb", label: "PS3-Original" },
  { id: "ps3", label: "JellyStation-Wellen (bisher)" },
  { id: "aurora", label: "Nordlicht" },
  { id: "stars", label: "Sternenhimmel" },
  { id: "bubbles", label: "Tiefsee" },
  { id: "grid", label: "Neon-Gitter" },
  { id: "plain", label: "Nur Farbverlauf" },
] as const;
export type BackgroundStyle = (typeof BACKGROUND_STYLES)[number]["id"];

/**
 * Oberflächen-Stil von Menüs, Listen und Player: "classic" ist das bisherige PS3-Design (Standard, bleibt unverändert),
 * "glass" legt zusätzlich „Liquid Glass“ darüber – milchig durchscheinende, unscharf hinterlegte Flächen (glass.css).
 */
export const INTERFACE_STYLES = [
  { id: "classic", label: "Klassisch (PS3)" },
  { id: "glass", label: "Liquid Glass" },
] as const;
export type InterfaceStyle = (typeof INTERFACE_STYLES)[number]["id"];

export interface UiPrefs {
  /** Bildschirmhelligkeit der App, 0.6–1.25 (1 = unverändert). */
  brightness: number;
  /** Farbthema des Hintergrunds: "auto" (Monatsfarbe wie auf der PS3), eine ID aus THEMES oder "custom". */
  themeId: string;
  /** Eigener Farbton 0–359 (nur bei themeId "custom"). */
  customHue: number;
  /**
   * Akzentfarbe der Listen, Dialoge und Untermenüs (Leuchtbalken, Ränder, Tönung der Flächen): "auto" folgt dem Farbthema
   * (bzw. der Monatsfarbe), "weiss" ist das neutrale PS3-Weiß/Grau, sonst eine ID aus THEMES oder "custom".
   */
  accentId: string;
  /** Eigener Akzent-Farbton 0–359 (nur bei accentId "custom"). */
  accentHue: number;
  /** Hintergrund wird nachts dunkler (Tageszeit wie auf der PS3). */
  dayNight: boolean;
  /** Hintergrund-Design. */
  backgroundStyle: BackgroundStyle;
  /** Oberflächen-Stil (klassisch oder Liquid Glass). */
  interfaceStyle: InterfaceStyle;
  /** Start-Animation beim Öffnen der App (Vorspann mit Klang). */
  bootAnimation: boolean;
  /** Hintergrund-Elemente (nur beim Design "JellyStation-Wellen": Wellen und Formen). */
  waves: boolean;
  shapes: boolean;
  dust: boolean;
  /** Geschwindigkeit der Wellen im Hintergrund, 0.25–2. */
  waveSpeed: number;
  /** Menü-Animationen: voll, reduziert (weniger Bewegung) oder aus (springt direkt). */
  animations: AnimationMode;
  /** Tempo der Menü-Federn, 0.6–1.6 (1 = Standard). */
  motionSpeed: number;
  /** Lautstärke der Menü-Töne (Klick, Wechsel …), 0–1. */
  sfxVolume: number;
  /** Atmosphärische Hintergrundmusik im Menü. */
  musicEnabled: boolean;
  musicVolume: number;
  musicMood: MoodId;
  /** Klang der Menü-Töne: "ps3" = Originalklänge der PS3-Systemsoftware (soweit vorhanden), "synth" = synthetisch. */
  soundPack: "ps3" | "synth";
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  brightness: 1,
  themeId: "auto",
  backgroundStyle: "xmb",
  interfaceStyle: "classic",
  bootAnimation: true,
  customHue: 215,
  accentId: "auto",
  accentHue: 215,
  dayNight: true,
  waves: true,
  shapes: true,
  dust: true,
  waveSpeed: 1,
  animations: "full",
  motionSpeed: 1,
  sfxVolume: 1,
  musicEnabled: true,
  musicVolume: 0.4,
  musicMood: DEFAULT_MOOD,
  soundPack: "ps3",
};

export interface Theme {
  id: string;
  label: string;
  /** Farbton 0–359; null = Monatsfarbe wie auf der PS3. */
  hue: number | null;
}

export const THEMES: readonly Theme[] = [
  { id: "auto", label: "Automatisch (Monat)", hue: null },
  { id: "blau", label: "PS3-Blau", hue: 220 },
  { id: "teal", label: "Teal", hue: 178 },
  { id: "gruen", label: "Grün", hue: 130 },
  { id: "gelb", label: "Gold", hue: 42 },
  { id: "orange", label: "Orange", hue: 22 },
  { id: "rot", label: "Rot", hue: 355 },
  { id: "pink", label: "Neon-Pink", hue: 328 },
  { id: "violett", label: "Violett", hue: 270 },
  { id: "custom", label: "Eigener Farbton", hue: null },
];

export interface Accent {
  id: string;
  label: string;
  /** Farbton 0–359; null = folgt dem Farbthema (auto), neutral (weiss) bzw. accentHue (custom). */
  hue: number | null;
}

export const ACCENTS: readonly Accent[] = [
  { id: "auto", label: "Wie Farbthema", hue: null },
  { id: "weiss", label: "PS3-Weiß", hue: null },
  ...THEMES.filter((t) => t.id !== "auto" && t.id !== "custom").map((t) => ({ id: t.id, label: t.label, hue: t.hue })),
  { id: "custom", label: "Eigener Farbton", hue: null },
];

/** Grenzen der Zahlenwerte (für Regler und Prüfung). */
export const LIMITS = {
  brightness: { min: 0.6, max: 1.25, step: 0.05 },
  customHue: { min: 0, max: 359, step: 5 },
  accentHue: { min: 0, max: 359, step: 5 },
  waveSpeed: { min: 0.25, max: 2, step: 0.25 },
  motionSpeed: { min: 0.6, max: 1.6, step: 0.1 },
  sfxVolume: { min: 0, max: 1, step: 0.1 },
  musicVolume: { min: 0, max: 1, step: 0.05 },
} as const;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Macht aus beliebigen gespeicherten Daten gültige Einstellungen (unbekannte/falsche Werte → Standard). */
export function sanitizeUiPrefs(raw: unknown): UiPrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_UI_PREFS;
  const theme = typeof r.themeId === "string" && THEMES.some((t) => t.id === r.themeId) ? r.themeId : d.themeId;
  return {
    brightness: num(r.brightness, d.brightness, LIMITS.brightness.min, LIMITS.brightness.max),
    themeId: theme,
    backgroundStyle: BACKGROUND_STYLES.some((s) => s.id === r.backgroundStyle) ? (r.backgroundStyle as BackgroundStyle) : d.backgroundStyle,
    interfaceStyle: INTERFACE_STYLES.some((s) => s.id === r.interfaceStyle) ? (r.interfaceStyle as InterfaceStyle) : d.interfaceStyle,
    customHue: Math.round(num(r.customHue, d.customHue, LIMITS.customHue.min, LIMITS.customHue.max)),
    accentId: typeof r.accentId === "string" && ACCENTS.some((a) => a.id === r.accentId) ? r.accentId : d.accentId,
    accentHue: Math.round(num(r.accentHue, d.accentHue, LIMITS.accentHue.min, LIMITS.accentHue.max)),
    dayNight: bool(r.dayNight, d.dayNight),
    bootAnimation: bool(r.bootAnimation, d.bootAnimation),
    waves: bool(r.waves, d.waves),
    shapes: bool(r.shapes, d.shapes),
    dust: bool(r.dust, d.dust),
    waveSpeed: num(r.waveSpeed, d.waveSpeed, LIMITS.waveSpeed.min, LIMITS.waveSpeed.max),
    animations: r.animations === "reduced" || r.animations === "off" || r.animations === "full" ? r.animations : d.animations,
    motionSpeed: num(r.motionSpeed, d.motionSpeed, LIMITS.motionSpeed.min, LIMITS.motionSpeed.max),
    sfxVolume: num(r.sfxVolume, d.sfxVolume, LIMITS.sfxVolume.min, LIMITS.sfxVolume.max),
    musicEnabled: bool(r.musicEnabled, d.musicEnabled),
    musicVolume: num(r.musicVolume, d.musicVolume, LIMITS.musicVolume.min, LIMITS.musicVolume.max),
    musicMood: isMoodId(r.musicMood) ? r.musicMood : d.musicMood,
    soundPack: r.soundPack === "ps3" || r.soundPack === "synth" ? r.soundPack : d.soundPack,
  };
}

/* ------------------------------------------------------------------ Ablage */

let current: UiPrefs = DEFAULT_UI_PREFS;
let persist: ((prefs: UiPrefs) => void) | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const PERSIST_DELAY_MS = 400;

/** Setzt die gespeicherten Werte (beim Start) und merkt sich die Speicherfunktion. Löst kein Speichern aus. */
export function initUiPrefs(saved: unknown, onPersist: ((prefs: UiPrefs) => void) | null) {
  current = sanitizeUiPrefs(saved);
  persist = onPersist;
  listeners.forEach((l) => l());
}

export const getUiPrefs = (): UiPrefs => current;

export function setUiPrefs(patch: Partial<UiPrefs>) {
  const next = sanitizeUiPrefs({ ...current, ...patch });
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  listeners.forEach((l) => l());
  if (persist) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist?.(current);
    }, PERSIST_DELAY_MS);
  }
}

export function resetUiPrefs() {
  setUiPrefs({ ...DEFAULT_UI_PREFS });
}

export function subscribeUiPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(subscribeUiPrefs, getUiPrefs, getUiPrefs);
}

/** Der aktuell gewünschte Farbton (null = Monatsfarbe). */
export function themeHue(p: Pick<UiPrefs, "themeId" | "customHue">): number | null {
  if (p.themeId === "custom") return p.customHue;
  return THEMES.find((t) => t.id === p.themeId)?.hue ?? null;
}

/** Farbton und Sättigung (0–1) der Akzentfarbe; `date` bestimmt die Monatsfarbe bei „Automatisch“. */
export function accentColor(p: Pick<UiPrefs, "themeId" | "customHue" | "accentId" | "accentHue">, date: Date = new Date()): { hue: number; sat: number } {
  if (p.accentId === "weiss") return { hue: 220, sat: 0 };
  if (p.accentId === "custom") return { hue: p.accentHue, sat: 1 };
  const own = ACCENTS.find((a) => a.id === p.accentId)?.hue;
  if (p.accentId !== "auto" && typeof own === "number") return { hue: own, sat: 1 };
  return { hue: themeHue(p) ?? monthHues[date.getMonth()], sat: 1 };
}
