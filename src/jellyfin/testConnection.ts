import { isTauri } from "../platform";
import { fetchSelectableUsers, pickJfUser } from "./context";
import { getDeviceId } from "./device";
import { isValidServerUrl, normalizeServerUrl } from "./url";

// Die Adress-Helfer liegen in url.ts (damit context.ts sie ohne Kreis-Import nutzen kann); die alten Importe bleiben gültig.
export { isValidServerUrl, normalizeServerUrl };

export interface ConnectionResult {
  status: "ok" | "warn" | "fail";
  message: string;
  serverName?: string;
  version?: string;
  /**
   * Nur bei status "ok": Benutzer, dessen Wiedergabestände die App verwenden würde (gespeicherter oder zuletzt aktiver).
   * Fehlt, wenn die Benutzerliste nicht lesbar ist – dann gibt es kein Weiterschauen.
   */
  userName?: string;
  /** Anzahl der Benutzer auf dem Server (nur bei lesbarer Benutzerliste). */
  userCount?: number;
}

/** In Tauri über das HTTP-Plugin (Rust, kein CORS/ATS), im Browser über window.fetch. */
async function request(url: string, headers: Record<string, string>, ms = 6000) {
  const signal = AbortSignal.timeout(ms);
  if (isTauri()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(url, { headers, signal });
  }
  return window.fetch(url, { headers, signal });
}

/**
 * 1. GET /System/Info/Public (ohne Anmeldung) → ist der Server erreichbar?
 * 2. GET /System/Info mit API-Key → ist der Schlüssel gültig?
 */
export async function testJellyfin(urlInput: string, apiKey: string, userId?: string): Promise<ConnectionResult> {
  const base = normalizeServerUrl(urlInput);
  if (!isValidServerUrl(base)) return { status: "fail", message: "Ungültige Server-Adresse" };

  let info: { ServerName?: string; Version?: string };
  try {
    const res = await request(`${base}/System/Info/Public`, {});
    if (!res.ok) return { status: "fail", message: `Server antwortet mit Status ${res.status}` };
    info = await res.json();
  } catch (err) {
    const timeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      status: "fail",
      message: timeout ? "Zeitüberschreitung – Server nicht erreichbar" : "Server nicht erreichbar",
    };
  }
  const found = { serverName: info.ServerName, version: info.Version };
  const label = `${info.ServerName ?? "Jellyfin"}${info.Version ? ` ${info.Version}` : ""}`;

  if (!apiKey.trim()) {
    return { status: "warn", message: `${label} gefunden – API-Key fehlt`, ...found };
  }
  try {
    const key = apiKey.trim();
    const res = await request(`${base}/System/Info`, {
      Authorization: `MediaBrowser Token="${key}"`,
      "X-Emby-Token": key,
    });
    if (res.status === 401 || res.status === 403) {
      return { status: "fail", message: `${label} gefunden – API-Key ungültig`, ...found };
    }
    if (!res.ok) return { status: "fail", message: `Anmeldung fehlgeschlagen (${res.status})`, ...found };
    return { status: "ok", message: `Verbunden mit ${label}`, ...found, ...(await probeUser(base, key, userId)) };
  } catch {
    return { status: "fail", message: "Anmeldung nicht möglich – Verbindung unterbrochen", ...found };
  }
}

/**
 * Zusatzinfo für die Prüfung: welcher Benutzer würde verwendet? Bewusst kurz befristet und folgenlos – eine
 * nicht lesbare Benutzerliste (Schlüssel ohne Administrator-Rechte, alter Server) ändert das Ergebnis nicht.
 */
async function probeUser(
  base: string,
  apiKey: string,
  userId: string | undefined,
): Promise<{ userName?: string; userCount?: number }> {
  try {
    const users = await fetchSelectableUsers({ base, apiKey, deviceId: getDeviceId() }, AbortSignal.timeout(3000));
    const picked = pickJfUser(users, userId);
    return picked ? { userName: picked.user.name, userCount: users.length } : { userCount: 0 };
  } catch {
    return {};
  }
}
