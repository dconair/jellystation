import { JfError } from "../jellyfin/errors";
import { isTauri } from "../platform";

/** Antwort von `transcode_start` (Rust: transcode.rs). */
export interface TranscodeInfo {
  /** Wiedergabeliste des lokalen HLS-Stroms. */
  url: string;
  durationSec: number;
  /** Bild- und Tonformat der Quelle (z. B. "hevc", "dts"). */
  video: string | null;
  audio: string | null;
}

const MISSING_HELP =
  "ffmpeg wurde nicht gefunden. Installiere es (Windows: „winget install Gyan.FFmpeg“, macOS: „brew install ffmpeg“) und starte JellyStation neu.";

/**
 * Wandelt eine Stream-Adresse lokal mit ffmpeg in einen abspielbaren HLS-Strom um. Wirft JfError("unplayable"),
 * wenn das hier nicht geht (Browser, ffmpeg fehlt, Quelle nicht lesbar).
 */
export async function startTranscode(url: string): Promise<TranscodeInfo> {
  if (!isTauri()) throw new JfError("Umwandeln geht nur in der Desktop-App", "unplayable");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<TranscodeInfo>("transcode_start", { url });
  } catch (err) {
    const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
    throw new JfError(text === "ffmpeg_missing" ? MISSING_HELP : text || "Umwandeln nicht möglich", "unplayable");
  }
}

/** Beendet den lokalen Umwandler (fehlertolerant). */
export async function stopTranscode(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("transcode_stop");
  } catch {
    // bewusst ignoriert
  }
}
