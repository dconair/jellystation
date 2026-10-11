/**
 * Hülle um die Rust-Befehle der Diagnose (siehe docs/ARCHITEKTUR.md, Abschnitt „Diagnose“). Nur in der Tauri-App.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ProbeRef {
  name: string;
  exists: boolean;
}

export interface FileProbe {
  path: string;
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  /** Datei: lässt sich öffnen; Ordner: lässt sich auflisten. */
  readable: boolean;
  size: number;
  /** Erste Bytes als Hex-Text (klein geschrieben), leer bei Ordnern und leeren Dateien. */
  headHex: string;
  names: string[];
  refs: ProbeRef[];
  quarantined: boolean;
  error: string | null;
}

export interface LogTail {
  path: string;
  modifiedMs: number;
  lines: string[];
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function normalizeProbe(raw: unknown, path: string): FileProbe {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    path: typeof o.path === "string" ? o.path : path,
    exists: o.exists === true,
    isDir: o.isDir === true,
    isFile: o.isFile === true,
    readable: o.readable === true,
    size: typeof o.size === "number" ? o.size : 0,
    headHex: typeof o.headHex === "string" ? o.headHex.toLowerCase() : "",
    names: strList(o.names),
    refs: Array.isArray(o.refs)
      ? o.refs
          .map((r) => (r ?? {}) as { name?: unknown; exists?: unknown })
          .filter((r) => typeof r.name === "string")
          .map((r) => ({ name: r.name as string, exists: r.exists === true }))
      : [],
    quarantined: o.quarantined === true,
    error: typeof o.error === "string" && o.error !== "" ? o.error : null,
  };
}

/** Prüft Pfade (nur lesend). Das Ergebnis hat dieselbe Reihenfolge wie `paths`. */
export async function diagProbe(paths: string[]): Promise<FileProbe[]> {
  if (paths.length === 0) return [];
  const raw = await invoke<unknown>("diag_probe", { paths });
  const list = Array.isArray(raw) ? raw : [];
  return paths.map((p, i) => normalizeProbe(list[i], p));
}

/** Ende des zuletzt geänderten Protokolls unter den Kandidaten; null, wenn keines existiert. */
export async function diagLogTail(candidates: string[], lines = 120): Promise<LogTail | null> {
  const raw = (await invoke<unknown>("diag_log_tail", { candidates, lines })) as Record<string, unknown> | null;
  if (!raw || typeof raw.path !== "string") return null;
  return { path: raw.path, modifiedMs: typeof raw.modifiedMs === "number" ? raw.modifiedMs : 0, lines: strList(raw.lines) };
}

/** Hebt die macOS-Quarantäne einer Emulator-App auf. */
export const diagClearQuarantine = (path: string) => invoke<void>("diag_clear_quarantine", { path });
