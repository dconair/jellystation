/**
 * Dünne, typisierte Hülle um die Rust-Befehle aus src-tauri/src/downloads.rs (siehe docs/ARCHITEKTUR.md, „Downloads“).
 * Nur in der Tauri-App; im Browser werfen die Aufrufe – die Aufrufer prüfen vorher isTauri().
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DownloadRequest {
  /** Kennung des Vorgangs (für Fortschritt und Abbruch). */
  id: string;
  url: string;
  /** Zielordner; „~“ steht für den Benutzerordner. */
  destDir: string;
  fileName?: string;
  /** Erwartete SHA-256-Prüfsumme (Hex); stimmt sie nicht, wird die Datei verworfen. */
  sha256?: string;
  /** Erlaubte Server (`*.beispiel.de` erlaubt Unterserver); leer = nur der Server der Adresse. */
  allowedHosts?: string[];
  /** true = auch http (nur für Adressen, die der Nutzer selbst eingetragen hat). */
  allowHttp?: boolean;
  /** true = Programmdateien (.exe, .sh …) nicht ablegen. */
  blockExecutables?: boolean;
}

export interface DownloadResult {
  path: string;
  fileName: string;
  size: number;
  resumed: boolean;
  alreadyPresent: boolean;
  sha256: string | null;
}

export type DownloadState = "starting" | "running" | "verifying" | "done" | "failed" | "cancelled";

/** Nutzlast des Ereignisses `download-progress`. */
export interface DownloadProgress {
  id: string;
  received: number;
  total: number | null;
  state: DownloadState;
  message: string | null;
  partPath: string | null;
}

export interface Fingerprint {
  size: number;
  /** Die ersten (höchstens 16) Bytes als Hex. */
  head: string;
  md5: string;
  sha256: string;
}

export interface PlatformInfo {
  os: "macos" | "windows" | "linux" | string;
  arch: "aarch64" | "x86_64" | string;
  emulatorsDir: string;
  home: string;
}

export interface InstallArchiveRequest {
  archive: string;
  id: string;
  destRoot: string;
  /** Regulärer Ausdruck für den Namen der Programmdatei (nur Windows/Linux). */
  exePattern?: string;
  /** true = das Archiv nach erfolgreichem Einspielen löschen. */
  removeArchive?: boolean;
}

export interface InstallArchiveResult {
  path: string;
  root: string;
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : typeof err === "string" ? err : String(err));

export const downloadStart = (req: DownloadRequest) => invoke<DownloadResult>("download_start", { req });
export const downloadCancel = (id: string) => invoke<boolean>("download_cancel", { id });
export const downloadDiscard = (partPath: string) => invoke<void>("download_discard", { partPath });
export const fileFingerprint = (path: string) => invoke<Fingerprint>("file_fingerprint", { path });
export const installPlatform = () => invoke<PlatformInfo>("install_platform");
export const installArchive = (req: InstallArchiveRequest) => invoke<InstallArchiveResult>("install_archive", { req });

/** Meldungen über laufende Downloads; gibt die Abmeldung zurück. */
export async function onDownloadProgress(cb: (p: DownloadProgress) => void): Promise<() => void> {
  return listen<DownloadProgress>("download-progress", (e) => cb(e.payload));
}
