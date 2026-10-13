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

/**
 * Der erste Zugriff über Tailscale braucht oft mehrere Sekunden, bis der Tunnel steht (Hole-Punching bzw. Umweg über
 * einen Relay-Server) – 6 s waren dafür zu knapp und meldeten den Server fälschlich als unerreichbar.
 */
const TEST_TIMEOUT_MS = 10_000;
/** Wartezeit der Hintergrundprüfung für die zweite Adresse (Tailscale); die Heimadresse antwortet im LAN sofort oder gar nicht. */
export const ALT_PING_TIMEOUT_MS = 8000;

/** In Tauri über das HTTP-Plugin (Rust, kein CORS/ATS), im Browser über window.fetch. */
async function request(url: string, headers: Record<string, string>, ms = TEST_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(ms);
  try {
    if (isTauri()) {
      const { fetch } = await import("@tauri-apps/plugin-http");
      return await fetch(url, { headers, signal });
    }
    return await window.fetch(url, { headers, signal });
  } catch (err) {
    // Das HTTP-Plugin meldet den Abbruch als Text „Request canceled“ statt als TimeoutError – an der Frist erkennen.
    if (signal.aborted) throw new DOMException("Zeitüberschreitung", "TimeoutError");
    throw err;
  }
}

/** Meldung zu einem HTTP-Fehlerstatus der Server-Info. 403 kommt von Jellyfin, wenn „Fernzugriff“ aus ist und die Anfrage von außerhalb des LAN kommt. */
function statusHint(status: number): string {
  if (status === 403) {
    return "Server lehnt die Anfrage ab (403) – in Jellyfin unter Dashboard → Netzwerk „Fernverbindungen zu diesem Server erlauben“ aktivieren (Tailscale-Adressen zählen als extern)";
  }
  return `Server antwortet mit Status ${status}`;
}

/** Meldung zu einem Netzwerkfehler; hängt den technischen Grund an, damit sich Ursachen unterscheiden lassen. */
function networkHint(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "Zeitüberschreitung – Server nicht erreichbar. Läuft Tailscale auf beiden Geräten, und erlaubt die Firewall des Servers Port 8096 auch im Tailscale-Netz?";
  }
  const detail = (err instanceof Error ? err.message : typeof err === "string" ? err : "").trim().replace(/\s+/g, " ");
  if (!detail) return "Server nicht erreichbar";
  // „error sending request“ heißt: keine Verbindung (Port zu, Name unbekannt, Netz weg) – der Grund steckt nicht in der Meldung.
  const hint = /error sending request/i.test(detail)
    ? ". Adresse und Port 8096 prüfen; unterwegs muss Tailscale auf beiden Geräten laufen."
    : "";
  return `Server nicht erreichbar (${detail.slice(0, 160)})${hint}`;
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
    if (!res.ok) return { status: "fail", message: statusHint(res.status) };
    info = await res.json();
  } catch (err) {
    return { status: "fail", message: networkHint(err) };
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

/** Antwortet der Server unter dieser Adresse? (GET /System/Info/Public, ohne Anmeldung) */
export async function pingServer(urlInput: string, ms = 3000): Promise<boolean> {
  const base = normalizeServerUrl(urlInput);
  if (!isValidServerUrl(base)) return false;
  try {
    const res = await request(`${base}/System/Info/Public`, {}, ms);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Prüft Heimadresse und – falls eingetragen – die zweite Adresse (Tailscale) einzeln und fasst das Ergebnis zusammen.
 * Ist nur eine der beiden erreichbar, gilt das als „ok“ (die App wechselt dann selbst); die Meldung nennt beide Ergebnisse.
 */
export async function testJellyfinAddresses(
  urlInput: string,
  altInput: string,
  apiKey: string,
  userId?: string,
): Promise<ConnectionResult> {
  const hasAlt = !!altInput.trim() && isValidServerUrl(altInput) && normalizeServerUrl(altInput) !== normalizeServerUrl(urlInput);
  if (!hasAlt) return testJellyfin(urlInput, apiKey, userId);
  const [home, alt] = await Promise.all([testJellyfin(urlInput, apiKey, userId), testJellyfin(altInput, apiKey, userId)]);
  const best = home.status === "ok" ? home : alt.status === "ok" ? alt : home.status === "warn" ? home : alt.status === "warn" ? alt : home;
  const summary = `Heimadresse: ${home.message} · Zweite Adresse: ${alt.message}`;
  return { ...best, message: summary };
}
