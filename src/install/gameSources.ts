/**
 * Eigene Spiele-Quellen: Adressen, die der Nutzer selbst einträgt (eigene Webseite, NAS, Adressliste).
 * Die App bringt keine Quellen mit und sucht nirgends nach Spielen.
 *
 * Eine Quelle ist entweder eine einzelne Datei (Adresse endet auf eine Spiel-Endung) oder eine Liste:
 *  - Verzeichnisseite eines Webservers (Apache/nginx „Index of …“): alle Links auf Spiel-Dateien,
 *  - Textdatei mit einer Adresse je Zeile (`Adresse` oder `Name | Adresse | System`, `#` beginnt einen Kommentar),
 *  - JSON: Liste von Adressen oder von `{ name, url, system?, size? }` (auch in `games`/`items`/`files`).
 */
import { isTauri } from "../platform";

export interface GameSource {
  id: string;
  name: string;
  /** Adresse der Datei oder der Liste (http/https). */
  url: string;
  /** Unterordner im Spiele-Ordner (z. B. "PS2"), nur als Hinweis; fehlt er, lädt die App direkt in den Spiele-Ordner (das System wird dort automatisch erkannt). */
  system?: string;
  /** Weitere Server, von denen diese Quelle laden darf (vom Nutzer bestätigt). Der Server der Quelle gilt immer. */
  trustedHosts?: string[];
}

export interface RemoteGame {
  name: string;
  url: string;
  system?: string;
  size?: number;
}

/**
 * Endungen, die in einer Liste als Spiel-Datei gelten (Abbilder der unterstützten Emulatoren). Archive zählen
 * dazu, weil viele Seiten gepackt anbieten – die App entpackt Spiele nicht. Welche Dateien der Spiele-Ordner danach
 * als Spiel erkennt, entscheidet `games_scan` (src-tauri/src/library.rs).
 */
const LISTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "iso", "cue", "chd", "bin", "elf", "pkg", "cso", "pbp", "m3u", "rvz", "wbfs", "gcm", "ciso", "dol", "gcz", "wia",
  "zip", "7z", "rar", "gz", "xz", "tar",
]);

const MAX_ITEMS = 500;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export const extensionOf = (name: string) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
};

export const isGameFileUrl = (url: string): boolean => {
  try {
    return LISTED_EXTENSIONS.has(extensionOf(decodeURIComponent(new URL(url).pathname)));
  } catch {
    return false;
  }
};

export function normalizeSourceUrl(input: string): string | null {
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

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const nameFromUrl = (url: string): string => {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return safeDecode(seg) || url;
  } catch {
    return url;
  }
};

const asHttp = (href: string, base: string): string | null => {
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function fromHtml(text: string, base: string): RemoteGame[] {
  const out: RemoteGame[] = [];
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const href = decodeEntities(m[1] ?? m[2] ?? "").trim();
    if (!href || href.startsWith("?") || href.startsWith("#") || href.endsWith("/")) continue; // Sortierlinks, Ordner
    const url = asHttp(href, base);
    if (!url || !isGameFileUrl(url)) continue;
    out.push({ name: nameFromUrl(url), url });
  }
  return out;
}

function fromJson(value: unknown, base: string): RemoteGame[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? ((["games", "items", "files"] as const).map((k) => (value as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  const out: RemoteGame[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const url = asHttp(item.trim(), base);
      if (url) out.push({ name: nameFromUrl(url), url });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const url = typeof o.url === "string" ? asHttp(o.url.trim(), base) : null;
      if (!url) continue;
      out.push({
        name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 120) : nameFromUrl(url),
        url,
        ...(typeof o.system === "string" && o.system.trim() ? { system: o.system.trim().slice(0, 40) } : {}),
        ...(typeof o.size === "number" && Number.isFinite(o.size) && o.size > 0 ? { size: o.size } : {}),
      });
    }
  }
  return out;
}

function fromLines(text: string, base: string): RemoteGame[] {
  const out: RemoteGame[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const urlIndex = parts.findIndex((p) => /^https?:\/\//i.test(p));
    if (urlIndex < 0) continue;
    const url = asHttp(parts[urlIndex], base);
    if (!url) continue;
    const name = urlIndex > 0 && parts[0] ? parts[0] : nameFromUrl(url);
    const system = parts[urlIndex + 1] || undefined;
    out.push({ name: name.slice(0, 120), url, ...(system ? { system: system.slice(0, 40) } : {}) });
  }
  return out;
}

/** Liest eine Liste aus dem Text einer Antwort; erkennt JSON, HTML-Verzeichnisseiten und Adresslisten. */
export function parseListing(text: string, baseUrl: string): RemoteGame[] {
  const body = text.replace(/^﻿/, "").trim();
  let games: RemoteGame[];
  if (body.startsWith("[") || body.startsWith("{")) {
    try {
      games = fromJson(JSON.parse(body), baseUrl);
    } catch {
      games = fromLines(body, baseUrl);
    }
  } else if (/<a\s/i.test(body)) {
    games = fromHtml(body, baseUrl);
  } else {
    games = fromLines(body, baseUrl);
  }
  const seen = new Set<string>();
  const unique = games.filter((g) => (seen.has(g.url) ? false : (seen.add(g.url), true)));
  return unique.slice(0, MAX_ITEMS);
}

export class ListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingError";
  }
}

/** Holt die Liste einer Quelle. Eine einzelne Datei ergibt eine Liste mit einem Eintrag. */
export async function loadListing(source: GameSource, signal?: AbortSignal): Promise<RemoteGame[]> {
  if (isGameFileUrl(source.url)) return [{ name: nameFromUrl(source.url), url: source.url }];
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  timeout.addEventListener("abort", abort);
  signal?.addEventListener("abort", abort);
  try {
    let res: Response;
    if (isTauri()) {
      const { fetch } = await import("@tauri-apps/plugin-http");
      res = await fetch(source.url, { signal: ctl.signal });
    } else {
      res = await window.fetch(source.url, { signal: ctl.signal });
    }
    if (!res.ok) {
      throw new ListingError(
        res.status === 401 || res.status === 403
          ? "Die Seite verlangt eine Anmeldung oder verweigert den Zugriff"
          : res.status === 404
            ? "Die Seite wurde nicht gefunden (Adresse prüfen)"
            : `Die Seite meldet einen Fehler (HTTP ${res.status})`,
      );
    }
    const text = await res.text();
    if (text.length > MAX_LISTING_BYTES) throw new ListingError("Die Liste ist zu groß (über 4 MB)");
    const games = parseListing(text, res.url || source.url);
    if (!games.length) {
      throw new ListingError("Auf der Seite wurden keine Spiel-Dateien gefunden. Erwartet wird eine Verzeichnisseite, eine Textdatei mit Adressen oder JSON.");
    }
    return games;
  } catch (err) {
    if (err instanceof ListingError) throw err;
    if (signal?.aborted) throw err;
    throw new ListingError(timeout.aborted ? "Die Seite antwortet nicht (Zeitüberschreitung)" : "Die Seite ist nicht erreichbar – Adresse und Verbindung prüfen");
  } finally {
    timeout.removeEventListener("abort", abort);
    signal?.removeEventListener("abort", abort);
  }
}

/** Server außerhalb der Quelle, auf die eine Liste verweist (und die noch nicht bestätigt sind). */
export function foreignHosts(source: GameSource, games: readonly RemoteGame[]): string[] {
  const known = new Set([hostOf(source.url), ...(source.trustedHosts ?? []).map((h) => h.toLowerCase())]);
  return [...new Set(games.map((g) => hostOf(g.url)).filter((h) => h && !known.has(h)))];
}

/** Erlaubte Server für Downloads dieser Quelle. */
export const allowedHostsOf = (source: GameSource): string[] => [hostOf(source.url), ...(source.trustedHosts ?? [])].filter(Boolean);

export function sanitizeGameSources(raw: unknown): GameSource[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: GameSource[] = [];
  for (const s of raw.slice(0, 30)) {
    if (!s || typeof s !== "object") continue;
    const { id, name, url, system, trustedHosts } = s as Record<string, unknown>;
    if (typeof id !== "string" || typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    out.push({
      id: id.slice(0, 40),
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : hostOf(url),
      url: url.slice(0, 1000),
      ...(typeof system === "string" && system.trim() ? { system: system.trim().slice(0, 40) } : {}),
      ...(Array.isArray(trustedHosts)
        ? { trustedHosts: trustedHosts.filter((h): h is string => typeof h === "string" && /^[a-z0-9.-]+$/i.test(h)).slice(0, 10) }
        : {}),
    });
  }
  return out.length ? out : undefined;
}
