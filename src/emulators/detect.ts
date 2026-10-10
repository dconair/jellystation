/**
 * Emulatoren erkennen: gewählter Pfad (Einstellungen) prüfen, sonst automatisch suchen (`emulator_find`),
 * dazu Homebrew erkennen. Die Funktionen hier sind frei von React und werden vom Hook (useEmulators), vom
 * Starter (useGameLauncher) und vom Setup-Check (setup/checks.ts) gemeinsam genutzt.
 *
 * Nichts davon wirft: Jeder Fehler landet als Text in `EmulatorStatus.error`, damit eine kaputte Suche nie den
 * Start der App oder des Menüs verhindert. Im Browser (kein Tauri) sind alle Emulatoren „nicht prüfbar“.
 */
import { isTauri } from "../platform";
import { emulatorFind, emulatorInspect, errorText } from "./backend";
import type { FindMatch, FindSpec, InspectResult } from "./backend";
import { EMULATORS } from "./catalog";
import type { EmulatorDef } from "./catalog";
import { freshStatus, uncheckedStatus } from "./status";
import type { EmulatorStatus } from "./status";

/** Wo Homebrew liegt und welcher Programmname im Shell-Scope (capabilities/emulators.json) dazu gehört. */
export interface BrewInfo {
  available: boolean;
  path: string | null;
  /** Programmname für Command.create(): Apple Silicon "brew-arm", Intel "brew-intel". */
  command: "brew-arm" | "brew-intel" | null;
}

export const NO_BREW: BrewInfo = { available: false, path: null, command: null };

const BREW_CANDIDATES = [
  { path: "/opt/homebrew/bin/brew", command: "brew-arm" },
  { path: "/usr/local/bin/brew", command: "brew-intel" },
] as const;

export interface DetectResult {
  statuses: EmulatorStatus[];
  brew: BrewInfo;
}

export interface DetectOptions {
  /** true = Zwischenspeicher ignorieren und neu suchen (nach Installation, „Erneut suchen“, Setup-Prüfung). */
  force?: boolean;
  /** Eigene Emulator-Liste (Tests); Standard: der Katalog. */
  defs?: readonly EmulatorDef[];
}

/* ------------------------------------------------------------------ Prüfen eines Pfads */

type Verdict = { ok: true; inspect: InspectResult } | { ok: false; error: string };

/** Übersetzt das Ergebnis von `emulator_inspect` in „startbar“ oder einen verständlichen Grund. */
function judge(r: InspectResult): Verdict {
  if (!r.exists) return { ok: false, error: r.error ?? "Der Pfad existiert nicht" };
  if (r.kind === "other") return { ok: false, error: r.error ?? "Das ist keine Anwendung (.app) und keine ausführbare Datei" };
  if (!r.executable) return { ok: false, error: r.error ?? "Das Programm lässt sich nicht ausführen (fehlende Berechtigung?)" };
  return { ok: true, inspect: r };
}

async function inspectSafe(path: string): Promise<Verdict> {
  try {
    return judge(await emulatorInspect(path));
  } catch (err) {
    return { ok: false, error: `Prüfung fehlgeschlagen: ${errorText(err)}` };
  }
}

/**
 * Kurzer Hinweis zu einem gültigen Fundort, z. B. wenn die App noch im Downloads-Ordner liegt. Solche Apps starten
 * zwar, liegen aber an einem unsicheren Ort (Aufräumen, Auswerfen, macOS-Isolierung); dazu passt immer derselbe
 * Rat: nach „Programme“ verschieben (siehe LOCATION_ADVICE).
 */
export function locationHint(path: string, source: string | null): string | null {
  if (path.includes("/AppTranslocation/")) return "läuft isoliert von macOS";
  if (source === "downloads" || /\/Downloads\//.test(path)) return "läuft aus Downloads";
  if (source === "desktop" || /\/Desktop\//.test(path)) return "liegt auf dem Schreibtisch";
  if (path.startsWith("/Volumes/")) return "liegt auf einem Datenträger";
  return null;
}

/** Rat zu einem Hinweis von locationHint(). */
export const LOCATION_ADVICE = "Verschiebe die App am besten in den Ordner „Programme“.";

/* ------------------------------------------------------------------ Status eines Emulators */

/**
 * Bestimmt den Status eines Emulators. `override` ist der gewählte Pfad, `matches` die Treffer der automatischen
 * Suche (beste zuerst), `searchError` der Grund, falls die Suche selbst scheiterte.
 */
async function resolveStatus(
  def: EmulatorDef,
  override: string | undefined,
  matches: readonly FindMatch[],
  searchError: string | null,
): Promise<EmulatorStatus> {
  const status = freshStatus(def);

  // 1) Gewählter Pfad hat Vorrang – auch wenn er kaputt ist (dann bleibt er sichtbar und lässt sich korrigieren).
  let customError: string | null = null;
  if (override) {
    const v = await inspectSafe(override);
    if (v.ok) {
      return {
        ...status,
        path: override,
        source: "custom",
        valid: true,
        version: v.inspect.version,
        hint: locationHint(override, null),
      };
    }
    customError = v.error;
  }

  // 2) Automatisch gefunden: den ersten Treffer nehmen, der sich wirklich starten lässt.
  let auto: { path: string; source: string; version: string | null } | null = null;
  let autoError: string | null = null;
  for (const m of matches) {
    const v = await inspectSafe(m.path);
    if (v.ok) {
      auto = { path: m.path, source: m.source, version: v.inspect.version };
      break;
    }
    autoError ??= `${m.path} gefunden, aber nicht startbar: ${v.error}`;
  }

  if (override) {
    return {
      ...status,
      path: override,
      source: "custom",
      valid: false,
      error: customError,
      autoFound: auto ? { path: auto.path, version: auto.version } : null,
    };
  }
  if (auto) {
    return {
      ...status,
      path: auto.path,
      source: "auto",
      valid: true,
      version: auto.version,
      hint: locationHint(auto.path, auto.source),
      autoFound: { path: auto.path, version: auto.version },
    };
  }
  return { ...status, error: autoError ?? searchError };
}

const specOf = (def: EmulatorDef): FindSpec => ({ id: def.id, appPattern: def.appPattern, bundleIds: def.bundleIds });

/** Einen einzelnen Emulator neu prüfen (z. B. kurz vor dem Spielstart, wenn er als „fehlt“ gilt). */
export async function detectOne(def: EmulatorDef, override?: string): Promise<EmulatorStatus> {
  if (!isTauri()) return uncheckedStatus(def);
  let matches: FindMatch[] = [];
  let searchError: string | null = null;
  try {
    const found = await emulatorFind([specOf(def)]);
    matches = found.find((f) => f.id === def.id)?.matches ?? [];
  } catch (err) {
    searchError = `Suche fehlgeschlagen: ${errorText(err)}`;
  }
  return resolveStatus(def, override, matches, searchError);
}

/* ------------------------------------------------------------------ Homebrew */

export async function detectBrew(): Promise<BrewInfo> {
  if (!isTauri()) return NO_BREW;
  const results = await Promise.all(BREW_CANDIDATES.map((c) => inspectSafe(c.path)));
  const i = results.findIndex((r) => r.ok);
  return i < 0 ? NO_BREW : { available: true, path: BREW_CANDIDATES[i].path, command: BREW_CANDIDATES[i].command };
}

/* ------------------------------------------------------------------ Alles zusammen, mit Zwischenspeicher */

const keyOf = (overrides: Record<string, string> | undefined, defs: readonly EmulatorDef[]) =>
  JSON.stringify([defs.map((d) => d.id), Object.entries(overrides ?? {}).filter(([, v]) => v).sort(([a], [b]) => (a < b ? -1 : 1))]);

let cache: { key: string; result: DetectResult } | null = null;
let inflight: { key: string; promise: Promise<DetectResult> } | null = null;
/** Der zuletzt gestartete Lauf – nur er darf den Zwischenspeicher füllen (ältere, spät fertige Läufe sind überholt). */
let latest: Promise<DetectResult> | null = null;

/** Ergebnis der letzten Suche für genau diese Einstellungen (ohne zu suchen), sonst null. */
export function cachedDetection(overrides?: Record<string, string>, defs: readonly EmulatorDef[] = EMULATORS): DetectResult | null {
  const key = keyOf(overrides, defs);
  return cache && cache.key === key ? cache.result : null;
}

async function runDetection(overrides: Record<string, string> | undefined, defs: readonly EmulatorDef[]): Promise<DetectResult> {
  if (!isTauri()) return { statuses: defs.map(uncheckedStatus), brew: NO_BREW };

  let found: Awaited<ReturnType<typeof emulatorFind>> = [];
  let searchError: string | null = null;
  try {
    found = await emulatorFind(defs.map(specOf));
  } catch (err) {
    // Z. B. ältere App ohne den Befehl: gewählte Pfade lassen sich trotzdem prüfen.
    searchError = `Suche fehlgeschlagen: ${errorText(err)}`;
  }
  const [statuses, brew] = await Promise.all([
    Promise.all(
      defs.map((def) =>
        resolveStatus(def, overrides?.[def.id] || undefined, found.find((f) => f.id === def.id)?.matches ?? [], searchError),
      ),
    ),
    detectBrew(),
  ]);
  return { statuses, brew };
}

/**
 * Sucht alle Emulatoren und Homebrew. Gleiche Anfragen teilen sich eine laufende Suche; das Ergebnis wird
 * zwischengespeichert (ein Eintrag, passend zu den gewählten Pfaden) und nur mit `force` neu ermittelt –
 * das Fenster wird also nicht bei jedem Fokus neu durchsucht.
 */
export function detectEmulators(overrides?: Record<string, string>, opts: DetectOptions = {}): Promise<DetectResult> {
  const defs = opts.defs ?? EMULATORS;
  const key = keyOf(overrides, defs);
  if (!opts.force) {
    if (cache && cache.key === key) return Promise.resolve(cache.result);
    if (inflight && inflight.key === key) return inflight.promise;
  }
  const promise = runDetection(overrides, defs)
    .catch((err): DetectResult => ({
      // Sollte nie passieren (alles oben fängt selbst); trotzdem nie ablehnen.
      statuses: defs.map((d) => ({ ...freshStatus(d), error: `Suche fehlgeschlagen: ${errorText(err)}` })),
      brew: NO_BREW,
    }))
    .then((result) => {
      if (inflight?.promise === promise) inflight = null;
      if (!latest || latest === promise) cache = { key, result };
      return result;
    });
  inflight = { key, promise };
  latest = promise;
  return promise;
}

/** Zwischenspeicher leeren (Tests). */
export function resetDetectionCache() {
  cache = null;
  inflight = null;
  latest = null;
}
