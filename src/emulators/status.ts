/**
 * Zustand eines Emulators (gefunden, gewählt, fehlt …) und die Texte dazu. Rein deklarativ – die eigentliche
 * Suche steht in detect.ts, die Anzeige in EmulatorsDialog.tsx.
 */
import { isTauri } from "../platform";
import type { PopupStatus } from "../ui/popup";
import type { EmulatorDef } from "./catalog";

/** custom = vom Nutzer gewählter Pfad (settings.emulators), auto = automatisch gefunden. */
export type EmulatorSource = "custom" | "auto";

/** Automatisch gefundene App – bleibt auch dann erhalten, wenn ein gewählter Pfad ungültig ist. */
export interface AutoFound {
  path: string;
  version: string | null;
}

export interface EmulatorStatus {
  def: EmulatorDef;
  /** Pfad der .app bzw. des Programms (gewählt oder gefunden); bei einem ungültigen gewählten Pfad ebenfalls gesetzt. */
  path: string | null;
  /** null = weder gewählt noch gefunden. */
  source: EmulatorSource | null;
  /** true = der Pfad existiert und lässt sich starten. */
  valid: boolean;
  /** Version laut Info.plist (CFBundleShortVersionString), falls bekannt. */
  version: string | null;
  /** Warum ein gewählter oder gefundener Pfad nicht taugt (oder die Suche scheiterte). */
  error: string | null;
  /** Hinweis zu einem gültigen Treffer, z. B. „läuft aus Downloads“. */
  hint: string | null;
  /** false = nicht prüfbar (reiner Browser ohne Tauri); dann sind valid/path/error leer. */
  checkable: boolean;
  /** true = die erste Suche läuft noch (Platzhalter). */
  pending: boolean;
  autoFound: AutoFound | null;
}

const base = (def: EmulatorDef): EmulatorStatus => ({
  def,
  path: null,
  source: null,
  valid: false,
  version: null,
  error: null,
  hint: null,
  checkable: true,
  pending: false,
  autoFound: null,
});

/** Platzhalter, solange die erste Suche läuft (im Browser: gleich „nicht prüfbar“). */
export const pendingStatus = (def: EmulatorDef): EmulatorStatus =>
  isTauri() ? { ...base(def), pending: true } : { ...base(def), checkable: false };

/** Im Browser: ohne Fehler „nicht prüfbar“. */
export const uncheckedStatus = (def: EmulatorDef): EmulatorStatus => ({ ...base(def), checkable: false });

export const freshStatus = base;

/** "/Users/anna/Applications/X.app" → "~/Applications/X.app" (nur für die Anzeige, macOS-Heimordner). */
export const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+\//, "~/");

export const NOT_CHECKABLE = "Nur in der Desktop-App prüfbar";

/** Zeile für Listen: Text und Ampelfarbe (undefined = neutral, kein Punkt). */
export function describeStatus(s: EmulatorStatus): { text: string; tone: PopupStatus | undefined } {
  if (s.pending) return { text: "Wird gesucht …", tone: "busy" };
  if (!s.checkable) return { text: NOT_CHECKABLE, tone: undefined };
  if (s.valid && s.path) {
    const version = s.version ? ` (Version ${s.version})` : "";
    const text = `Gefunden: ${tildePath(s.path)}${version}`;
    return s.hint ? { text: `${text} – ${s.hint}`, tone: "warn" } : { text, tone: "ok" };
  }
  if (s.source === "custom") {
    const why = s.error ? `: ${s.error}` : "";
    const auto = s.autoFound ? ` – automatisch gefunden: ${tildePath(s.autoFound.path)}` : "";
    return { text: `Gewählter Pfad nicht nutzbar${why}${auto}`, tone: "error" };
  }
  if (s.error) return { text: s.error, tone: "error" };
  return { text: "Nicht installiert", tone: "warn" };
}

/**
 * Kurzfassung für den Untertitel des Eintrags „Emulatoren“ unter Einstellungen,
 * z. B. „2 von 5 gefunden · fehlt: DuckStation, PPSSPP, Dolphin“.
 */
export function summarizeEmulators(statuses: readonly EmulatorStatus[]): string {
  if (statuses.length === 0) return "Keine Emulatoren hinterlegt";
  if (statuses.some((s) => s.pending)) return "Wird gesucht …";
  if (statuses.every((s) => !s.checkable)) return NOT_CHECKABLE;
  const missing = statuses.filter((s) => !s.valid);
  if (missing.length === 0) return `Alle ${statuses.length} gefunden`;
  const found = statuses.length - missing.length;
  return `${found} von ${statuses.length} gefunden · fehlt: ${missing.map((s) => s.def.name).join(", ")}`;
}
