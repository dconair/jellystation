/**
 * Dünne, typisierte Hülle um die Rust-Befehle für Emulatoren (siehe docs/ARCHITEKTUR.md, Abschnitt „Emulatoren“).
 * Alles hier läuft nur in der Tauri-App; im Browser werfen die Aufrufe – die Aufrufer prüfen vorher isTauri().
 *
 * Warum eine eigene Schicht: Die Befehle liefern lose Daten (Felder können fehlen, Fehler kommen als Text). Hier wird
 * einmal sauber normalisiert, damit Erkennung, Dialog und Starter nicht jeweils selbst absichern müssen.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Wo `emulator_find` einen Treffer gefunden hat (beste Quellen zuerst, siehe Rust-Vertrag). */
export type FindSource = "applications" | "user-applications" | "subfolder" | "downloads" | "desktop" | "spotlight";

export interface FindSpec {
  id: string;
  appPattern: string;
  bundleIds: string[];
}

export interface FindMatch {
  path: string;
  source: FindSource | string;
}

export interface FindResult {
  id: string;
  matches: FindMatch[];
}

export interface InspectResult {
  path: string;
  exists: boolean;
  kind: "bundle" | "file" | "other";
  /** true = es gibt eine ausführbare Programmdatei (bei einer .app: die aufgelöste in Contents/MacOS). */
  executable: boolean;
  /** Pfad dieser Programmdatei, falls bekannt. */
  executablePath: string | null;
  name: string | null;
  bundleId: string | null;
  version: string | null;
  error: string | null;
}

export interface LaunchResult {
  id: string;
  pid: number;
  executable: string;
  commandLine: string;
}

/** Nutzlast des Ereignisses `game-exit`. */
export interface GameExit {
  id: string;
  code: number | null;
  signal: string | null;
  durationMs: number;
  stderrTail: string[];
  stdoutTail: string[];
  /** Deutscher Hinweis auf eine mögliche Ursache (nur bei Signalen, z. B. SIGKILL durch die macOS-Sicherheitsprüfung). */
  hint: string | null;
}

/** Fehler von invoke() kommen meist als Text (Err(String) aus Rust), seltener als Error-Objekt. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function emulatorFind(specs: FindSpec[]): Promise<FindResult[]> {
  const raw = await invoke<unknown>("emulator_find", { specs });
  if (!Array.isArray(raw)) return [];
  return raw.map((r): FindResult => {
    const o = (r ?? {}) as { id?: unknown; matches?: unknown };
    const matches = Array.isArray(o.matches) ? o.matches : [];
    return {
      id: String(o.id ?? ""),
      matches: matches
        .map((m) => (m ?? {}) as { path?: unknown; source?: unknown })
        .filter((m) => typeof m.path === "string" && m.path !== "")
        .map((m) => ({ path: m.path as string, source: typeof m.source === "string" ? m.source : "" })),
    };
  });
}

export async function emulatorInspect(path: string): Promise<InspectResult> {
  const raw = (await invoke<unknown>("emulator_inspect", { path })) as Record<string, unknown> | null;
  const o = raw ?? {};
  const kind = o.kind === "bundle" || o.kind === "file" ? o.kind : "other";
  return {
    path: str(o.path) ?? path,
    exists: o.exists === true,
    kind,
    // Rust liefert den Pfad der Programmdatei (oder null), ältere Entwürfe des Vertrags einen Wahrheitswert.
    executable: typeof o.executable === "string" ? o.executable !== "" : o.executable === true,
    executablePath: str(o.executable),
    name: str(o.name),
    bundleId: str(o.bundleId),
    version: str(o.version),
    error: str(o.error),
  };
}

export function gameLaunch(req: { id: string; program: string; args: string[]; label?: string }): Promise<LaunchResult> {
  return invoke<LaunchResult>("game_launch", req);
}

export const gameKill = (id: string) => invoke<boolean>("game_kill", { id });

export async function gameRunning(): Promise<string[]> {
  return strList(await invoke<unknown>("game_running"));
}

/** Letzte Zeilen von launch.log (jeder Start, jedes Ende und jeder Fehler wird dort protokolliert). */
export async function launchLogTail(lines = 40): Promise<string[]> {
  return strList(await invoke<unknown>("launch_log_tail", { lines }));
}

/** Nutzlast von `game-exit` mit Standardwerten für fehlende Felder. */
function normalizeExit(raw: unknown): GameExit | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  return {
    id: o.id,
    code: typeof o.code === "number" ? o.code : null,
    signal: o.signal === null || o.signal === undefined ? null : String(o.signal),
    durationMs: typeof o.durationMs === "number" ? o.durationMs : 0,
    stderrTail: strList(o.stderrTail),
    stdoutTail: strList(o.stdoutTail),
    hint: str(o.hint),
  };
}

/**
 * Hört auf `game-exit`. Die Anmeldung ist asynchron, die Abmeldung deshalb sofort aufrufbar (auch bevor listen()
 * fertig ist – wichtig, weil React im Entwicklungsmodus Effekte gleich zweimal startet).
 */
export function onGameExit(handler: (exit: GameExit) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<unknown>("game-exit", (event) => {
    const exit = normalizeExit(event.payload);
    if (exit && !disposed) handler(exit);
  }).then(
    (fn) => {
      if (disposed) fn();
      else unlisten = fn;
    },
    (err) => console.warn("game-exit: Anmeldung fehlgeschlagen", err),
  );
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
