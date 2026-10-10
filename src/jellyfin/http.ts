import { isTauri } from "../platform";
import { APP_VERSION } from "../version";
import { getDeviceName } from "./device";
import { abortError, JfError, statusError } from "./errors";
import type { StatusMessages } from "./errors";

/** Alles, was für eine angemeldete Anfrage an den Server nötig ist (ein {@link JfContext} passt hier hinein). */
export interface JfAuth {
  /** Server-Adresse ohne abschließenden Slash. */
  base: string;
  apiKey: string;
  deviceId: string;
}

/** Zeitlimit für JSON-Anfragen, wenn der Aufrufer nichts anderes vorgibt. */
export const DEFAULT_TIMEOUT_MS = 8000;

export type QueryValue = string | number | boolean | null | undefined;

export interface JfRequestInit {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, QueryValue>;
  /** JSON-Körper (wird serialisiert, Content-Type kommt automatisch). */
  body?: unknown;
  /** Bricht die Anfrage vorzeitig ab (Fehler dann: AbortError). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface JfRawResponse {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * Anmelde-Header. `Authorization: MediaBrowser …` ist der Weg, den alle Serverversionen kennen – neuere Server lehnen
 * `X-Emby-Token` und `?api_key=` ab, solange "EnableLegacyAuthorization" aus ist. Ältere kennen `X-Emby-Token` ebenfalls,
 * deshalb gehen beide mit. Der Server liest Client/Gerät/Version mit, daher dürfen die Werte weder Komma noch Anführungszeichen enthalten.
 */
export function authHeaders(auth: JfAuth): Record<string, string> {
  const clean = (s: string) => s.replace(/["\\,\r\n]/g, "");
  return {
    Authorization:
      `MediaBrowser Client="JellyStation", Device="${clean(getDeviceName())}", ` +
      `DeviceId="${clean(auth.deviceId)}", Version="${clean(APP_VERSION)}", Token="${clean(auth.apiKey)}"`,
    "X-Emby-Token": auth.apiKey,
    Accept: "application/json",
  };
}

/**
 * Header für Bilder, die die ArtImage-Pipeline lädt (kein Client/Gerät nötig). Beide Schreibweisen,
 * weil neuere Server `X-Emby-Token` ablehnen und ältere `Authorization` ohne Client/Gerät nicht immer annehmen.
 */
export function artHeaders(apiKey: string): Record<string, string> {
  return { "X-Emby-Token": apiKey, Authorization: `MediaBrowser Token="${apiKey}"` };
}

/** Hängt Pfad und Query an die Server-Adresse; leere Werte (undefined/null) fallen weg. */
export function buildUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${base}${clean}${pairs.length ? (clean.includes("?") ? "&" : "?") + pairs.join("&") : ""}`;
}

/** In Tauri über das HTTP-Plugin (Rust, kein CORS/ATS), im Browser über window.fetch. */
async function send(url: string, init: RequestInit): Promise<Response> {
  if (isTauri()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(url, init);
  }
  return window.fetch(url, init);
}

/** Eine Frist plus ein optionaler äußerer Abbruch in einem Signal; `dispose()` räumt die Hörer auf. */
function linkSignals(outer: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  timeout.addEventListener("abort", abort);
  outer?.addEventListener("abort", abort);
  if (outer?.aborted) ctl.abort();
  return {
    signal: ctl.signal,
    timedOut: () => timeout.aborted,
    dispose() {
      timeout.removeEventListener("abort", abort);
      outer?.removeEventListener("abort", abort);
    },
  };
}

/**
 * Eine Anfrage; wirft nur bei Netzwerkfehler, Zeitüberschreitung oder Abbruch – den HTTP-Status wertet der Aufrufer aus
 * (manche Aufrufe wollen 404/405 gezielt behandeln, z. B. beim Rückfall auf ältere Pfade).
 */
export async function jfRaw(auth: JfAuth, path: string, init: JfRequestInit = {}): Promise<JfRawResponse> {
  const headers = authHeaders(auth);
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }
  const link = linkSignals(init.signal, init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await send(buildUrl(auth.base, path, init.query), {
      method: init.method ?? "GET",
      headers,
      body,
      signal: link.signal,
    });
    // Der Körper gehört noch zur Frist: ein Server, der mitten in der Antwort hängt, soll nicht ewig blockieren.
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    if (init.signal?.aborted) throw abortError();
    if (err instanceof JfError) throw err;
    const timedOut = link.timedOut();
    throw new JfError(
      timedOut ? "Zeitüberschreitung – Server nicht erreichbar" : "Server nicht erreichbar",
      timedOut ? "timeout" : "network",
    );
  } finally {
    link.dispose();
  }
}

/** JSON-Antwort mit Fehlerstatus → {@link JfError}. */
export async function jfJson<T = unknown>(
  auth: JfAuth,
  path: string,
  init: JfRequestInit = {},
  messages?: StatusMessages,
): Promise<T> {
  const res = await jfRaw(auth, path, init);
  if (!res.ok) throw statusError(res.status, messages);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new JfError("Antwort des Servers ist kein gültiges JSON", "protocol");
  }
}

/** Antwort als Text (z. B. WebVTT) mit Fehlerstatus → {@link JfError}. */
export async function jfText(
  auth: JfAuth,
  path: string,
  init: JfRequestInit = {},
  messages?: StatusMessages,
): Promise<string> {
  const res = await jfRaw(auth, path, init);
  if (!res.ok) throw statusError(res.status, messages);
  return res.text;
}
