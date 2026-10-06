import { isTauri } from "../platform";

export interface ConnectionResult {
  status: "ok" | "warn" | "fail";
  message: string;
  serverName?: string;
  version?: string;
}

/** "192.168.1.20:8096/" → "http://192.168.1.20:8096" */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function isValidServerUrl(input: string): boolean {
  try {
    const u = new URL(normalizeServerUrl(input));
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
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
export async function testJellyfin(urlInput: string, apiKey: string): Promise<ConnectionResult> {
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
    return { status: "ok", message: `Verbunden mit ${label}`, ...found };
  } catch {
    return { status: "fail", message: "Anmeldung nicht möglich – Verbindung unterbrochen", ...found };
  }
}
