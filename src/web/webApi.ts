import { GAMES_BASE_DIR } from "../config/games";
import { isTauri } from "../platform";

export interface Bookmark {
  id: string;
  name: string;
  url: string;
}

export interface DownloadEvent {
  name: string;
  path: string | null;
  state: "started" | "done" | "failed";
}

/** Download-Ordner: <Spiele-Ordner>/Downloads (Standard-Spiele-Ordner, wenn keiner gewählt ist). */
export const downloadDirOf = (gamesDir?: string) => `${(gamesDir?.trim() || GAMES_BASE_DIR).replace(/\/+$/, "")}/Downloads`;

/** Ergänzt fehlendes http(s):// und prüft die Adresse; null = ungültig. */
export function normalizeWebUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Öffnet die Seite im App-eigenen Fenster (Tauri) bzw. in einem neuen Browser-Tab. */
export async function openWeb(url: string, title: string, gamesDir?: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("web_open", { url, title, downloadDir: downloadDirOf(gamesDir) });
}

/** Meldungen des Web-Fensters über Downloads; gibt die Abmeldung zurück. */
export async function onWebDownload(cb: (e: DownloadEvent) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<DownloadEvent>("web-download", (e) => cb(e.payload));
}

/** Verschiebt einen Download in <Spiele-Ordner>/<System>/; liefert den neuen Pfad. */
export async function importGame(from: string, gamesDir: string | undefined, system: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("game_import", { from, gamesDir: gamesDir?.trim() || GAMES_BASE_DIR, system });
}
