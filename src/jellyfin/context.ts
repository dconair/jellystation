import type { ArtSource } from "../data/types";
import { isTauri } from "../platform";
import { getDeviceId } from "./device";
import { abortError, isAbortError, JfError } from "./errors";
import { artHeaders, jfJson } from "./http";
import type { JfAuth } from "./http";
import { isValidServerUrl, normalizeServerUrl } from "./url";

/** Zugangsdaten, wie sie in den Einstellungen stehen (`settings.jellyfin`). */
export interface JfConfig {
  url: string;
  apiKey: string;
  /** Gewählter Benutzer; fehlt er oder ist er ungültig, wird einer ermittelt. */
  userId?: string;
}

/** Jellyfin-Benutzer, wie ihn die Auswahl ("Wer schaut?") braucht. */
export interface JfUser {
  id: string;
  name: string;
  /** ISO-Zeitpunkt der letzten Aktivität (fehlt bei Benutzern, die noch nie aktiv waren). */
  lastActivity?: string;
  isDisabled: boolean;
  isHidden: boolean;
  isAdmin: boolean;
  /** Profilbild, falls vorhanden (für die ArtImage-Pipeline). */
  art?: ArtSource;
}

/**
 * Alles, was eine Wiedergabe oder ein Bericht braucht. Wird einmal pro Zugangsdaten-Paar aufgebaut
 * ({@link createJfContext} bzw. {@link getJfContext}) und darf überall hin weitergereicht werden.
 */
export interface JfContext extends JfAuth {
  userId: string;
  userName: string;
  /** "settings" = der gespeicherte Benutzer war gültig, "auto" = der zuletzt aktive wurde gewählt. */
  userSource: "settings" | "auto";
  /** Präfix für Medien-URLs: in Tauri der lokale Proxy (`http://127.0.0.1:PORT/p/TOKEN`), sonst die Server-Adresse. */
  mediaBase: string;
  /** true = die Anmeldung für Medien-URLs übernimmt der Proxy (kein api_key in der URL nötig). */
  viaProxy: boolean;
  /** Gesetzt, wenn in Tauri der Medien-Proxy nicht gestartet werden konnte (dann gehen Medien direkt zum Server). */
  proxyError?: string;
}

/* ------------------------------------------------------------- Benutzer */

interface UserDto {
  Id?: unknown;
  Name?: unknown;
  LastActivityDate?: unknown;
  LastLoginDate?: unknown;
  PrimaryImageTag?: unknown;
  Policy?: { IsDisabled?: unknown; IsHidden?: unknown; IsAdministrator?: unknown } | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function parseUser(dto: UserDto | null, auth: JfAuth): JfUser | null {
  const id = str(dto?.Id);
  if (!dto || !id) return null;
  const last = str(dto.LastActivityDate) || str(dto.LastLoginDate);
  const user: JfUser = {
    id,
    name: str(dto.Name) || "Unbenannt",
    isDisabled: dto.Policy?.IsDisabled === true,
    isHidden: dto.Policy?.IsHidden === true,
    isAdmin: dto.Policy?.IsAdministrator === true,
  };
  if (last) user.lastActivity = last;
  if (str(dto.PrimaryImageTag)) {
    user.art = {
      kind: "http",
      url: `${auth.base}/Users/${encodeURIComponent(id)}/Images/Primary?fillHeight=300&quality=90`,
      headers: artHeaders(auth.apiKey),
    };
  }
  return user;
}

/** Alle Benutzer des Servers (GET /Users, mit API-Key erlaubt), in Serverreihenfolge. */
export async function fetchJfUsers(auth: JfAuth, signal?: AbortSignal): Promise<JfUser[]> {
  const json = await jfJson<unknown>(auth, "/Users", { signal });
  if (!Array.isArray(json)) throw new JfError("Unerwartete Antwort des Servers", "protocol");
  const users: JfUser[] = [];
  for (const dto of json) {
    const user = parseUser(dto as UserDto | null, auth);
    if (user) users.push(user);
  }
  return users;
}

/**
 * Der Benutzer, zu dem die Anmeldung gehört (`GET /Users/Me`). Das gibt es nur bei einem Benutzer-Token – ein API-Key
 * gehört keinem Benutzer. Dient als Rückfall, wenn jemand statt eines API-Keys den Token eines normalen Benutzers
 * eingetragen hat (der darf die Benutzerliste nicht lesen).
 */
async function fetchCurrentUser(auth: JfAuth, signal?: AbortSignal): Promise<JfUser | null> {
  try {
    return parseUser(await jfJson<UserDto | null>(auth, "/Users/Me", { signal }), auth);
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

/** Benutzerliste; ist der Schlüssel kein Administrator (403), nur der eigene Benutzer des Tokens. Wirft sonst wie {@link fetchJfUsers}. */
export async function fetchSelectableUsers(auth: JfAuth, signal?: AbortSignal): Promise<JfUser[]> {
  try {
    return await fetchJfUsers(auth, signal);
  } catch (err) {
    const me = err instanceof JfError && err.status === 403 ? await fetchCurrentUser(auth, signal) : null;
    if (!me) throw err;
    return [me];
  }
}

const sameId = (a: string, b: string) => a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();
const activityTime = (u: JfUser) => {
  const t = u.lastActivity ? Date.parse(u.lastActivity) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Wählt den Benutzer: der gespeicherte, solange es ihn gibt und er nicht deaktiviert ist; sonst der zuletzt aktive
 * nicht deaktivierte; sonst der erste. (Rein, damit es sich ohne Server prüfen lässt.)
 */
export function pickJfUser(
  users: JfUser[],
  preferredId?: string,
): { user: JfUser; source: "settings" | "auto" } | null {
  if (users.length === 0) return null;
  const wanted = preferredId ? users.find((u) => sameId(u.id, preferredId) && !u.isDisabled) : undefined;
  if (wanted) return { user: wanted, source: "settings" };
  const enabled = users.filter((u) => !u.isDisabled);
  if (enabled.length === 0) return { user: users[0], source: "auto" };
  // Stabil: bei gleicher (oder fehlender) Aktivität bleibt die Serverreihenfolge.
  const sorted = enabled
    .map((u, i) => ({ u, i }))
    .sort((a, b) => activityTime(b.u) - activityTime(a.u) || a.i - b.i);
  return { user: sorted[0].u, source: "auto" };
}

function authFor(cfg: { url: string; apiKey: string }): JfAuth {
  const base = normalizeServerUrl(cfg.url);
  const apiKey = cfg.apiKey.trim();
  if (!isValidServerUrl(base)) throw new JfError("Ungültige Server-Adresse", "config");
  if (!apiKey) throw new JfError("API-Key fehlt", "config");
  return { base, apiKey, deviceId: getDeviceId() };
}

/**
 * Benutzer des Servers für die Auswahl "Wer schaut?": aktive zuerst (nach letzter Aktivität), deaktivierte am Ende.
 */
export async function listJfUsers(
  cfg: { url: string; apiKey: string },
  opts: { signal?: AbortSignal } = {},
): Promise<JfUser[]> {
  const users = await fetchSelectableUsers(authFor(cfg), opts.signal);
  return users
    .map((u, i) => ({ u, i }))
    .sort(
      (a, b) =>
        Number(a.u.isDisabled) - Number(b.u.isDisabled) || activityTime(b.u) - activityTime(a.u) || a.i - b.i,
    )
    .map((x) => x.u);
}

/* --------------------------------------------------------------- Proxy */

/** Startet in Tauri den lokalen Medien-Proxy; im Browser gibt es keinen. */
async function startMediaProxy(base: string, apiKey: string): Promise<{ prefix?: string; error?: string }> {
  if (!isTauri()) return {};
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const prefix = await invoke<string>("media_proxy_start", { baseUrl: base, apiKey });
    if (typeof prefix !== "string" || !/^https?:\/\//i.test(prefix)) {
      throw new Error("Ungültige Antwort des Medien-Proxys");
    }
    return { prefix: prefix.replace(/\/+$/, "") };
  } catch (err) {
    // Tauri liefert Fehler von Rust-Befehlen als reinen Text, nicht als Error-Objekt.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------- Kontext */

/**
 * Baut den Kontext auf: Benutzer ermitteln (GET /Users), feste Geräte-ID bereitstellen, in Tauri den Medien-Proxy starten.
 * Wirft {@link JfError} (deutsche Meldung) bzw. AbortError bei `signal`-Abbruch.
 */
export async function createJfContext(cfg: JfConfig, opts: { signal?: AbortSignal } = {}): Promise<JfContext> {
  const auth = authFor(cfg);
  const users = await fetchSelectableUsers(auth, opts.signal);
  const picked = pickJfUser(users, cfg.userId);
  if (!picked) throw new JfError("Auf dem Jellyfin-Server gibt es keinen Benutzer", "protocol");
  const proxy = await startMediaProxy(auth.base, auth.apiKey);
  if (opts.signal?.aborted) throw abortError();
  return {
    ...auth,
    userId: picked.user.id,
    userName: picked.user.name,
    userSource: picked.source,
    mediaBase: proxy.prefix ?? auth.base,
    viaProxy: proxy.prefix !== undefined,
    ...(proxy.error ? { proxyError: proxy.error } : {}),
  };
}

/** So lange gilt ein zwischengespeicherter Kontext (danach wird der Benutzer erneut geprüft). */
const CONTEXT_TTL_MS = 5 * 60_000;
const contexts = new Map<string, { at: number; promise: Promise<JfContext> }>();

/**
 * Wie {@link createJfContext}, aber zwischengespeichert: wiederholte Aufrufe (jede Wiedergabe, jede Folgenliste)
 * kosten keine zusätzliche Anfrage. Fehler werden nicht gemerkt. Ein `signal` bricht nur das Warten ab, nicht den
 * gemeinsamen Aufbau.
 */
export function getJfContext(cfg: JfConfig, opts: { signal?: AbortSignal } = {}): Promise<JfContext> {
  const key = [normalizeServerUrl(cfg.url), cfg.apiKey.trim(), cfg.userId ?? ""].join("\n");
  let entry = contexts.get(key);
  if (!entry || Date.now() - entry.at > CONTEXT_TTL_MS) {
    const promise = createJfContext(cfg);
    entry = { at: Date.now(), promise };
    contexts.set(key, entry);
    promise.catch(() => {
      if (contexts.get(key)?.promise === promise) contexts.delete(key);
    });
  }
  const shared = entry.promise;
  const { signal } = opts;
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<JfContext>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Vergisst alle zwischengespeicherten Kontexte (nach Änderung der Zugangsdaten; für Tests). */
export function clearJfContextCache(): void {
  contexts.clear();
}

/* ------------------------------------------------------------ Medien-URL */

const hasKeyParam = (query: string) => /(^|&)(api_?key)=/i.test(query);

/**
 * Macht aus einem Server-Pfad (`/Videos/…?…`, auch ohne führenden Slash) eine abspielbare URL:
 * über den Proxy (der meldet sich selbst an – ein mitgelieferter Schlüssel wird entfernt) bzw. im Browser mit
 * angehängtem `ApiKey` (ein `<video>` kann keine Header senden). Fremde absolute URLs bleiben unverändert.
 * `ApiKey` statt `api_key`: neuere Server akzeptieren `api_key` nur noch mit eingeschalteter Legacy-Anmeldung.
 */
export function mediaUrl(ctx: Pick<JfContext, "base" | "apiKey" | "mediaBase" | "viaProxy">, path: string): string {
  let rest = path.trim();
  if (/^https?:\/\//i.test(rest)) {
    if (rest.toLowerCase().startsWith(`${ctx.base.toLowerCase()}/`)) rest = rest.slice(ctx.base.length);
    else return rest;
  }
  rest = rest.replace(/^\/+/, "");
  const q = rest.indexOf("?");
  const pathname = q < 0 ? rest : rest.slice(0, q);
  let query = q < 0 ? "" : rest.slice(q + 1);

  if (ctx.viaProxy) {
    if (query) {
      query = query
        .split("&")
        .filter((pair) => pair !== "" && !/^api_?key(=|$)/i.test(pair))
        .join("&");
    }
  } else if (!hasKeyParam(query)) {
    query = `${query ? `${query}&` : ""}ApiKey=${encodeURIComponent(ctx.apiKey)}`;
  }
  return `${ctx.mediaBase}/${pathname}${query ? `?${query}` : ""}`;
}
