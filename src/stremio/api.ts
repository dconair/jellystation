import { isTauri } from "../platform";
import { abortError } from "../jellyfin/errors";
import type { Manifest, ManifestCatalog, ManifestResource, Meta, MetaVideo, StremioStream, StremioType } from "./types";

/*
 * Stremio-Addon-Protokoll (https://github.com/Stremio/stremio-addon-sdk): ein Addon ist ein Webserver mit
 *   <Basis>/manifest.json                      Name, Typen, Ressourcen, Kataloge
 *   <Basis>/catalog/<typ>/<katalog>.json       { metas: [...] }
 *   <Basis>/meta/<typ>/<id>.json               { meta: {..., videos: [...]} }
 *   <Basis>/stream/<typ>/<id>.json             { streams: [...] }
 * Die App hat keine eigenen Addons und ruft nur Adressen auf, die der Nutzer selbst eingetragen hat.
 */

export class StremioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StremioError";
  }
}

const TIMEOUT_MS = 12_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/* ------------------------------------------------------------------ Adressen */

/**
 * Macht aus dem, was Nutzer einfügen, die Adresse der `manifest.json`: `stremio://` wird zu `https://`, ein fehlendes
 * `/manifest.json` wird ergänzt. null = keine brauchbare http(s)-Adresse.
 */
export function normalizeAddonUrl(input: string): string | null {
  let text = input.trim().replace(/^[<"'“„]+|[>"'”“]+$/g, "").trim();
  if (!text) return null;
  if (/^stremio:\/\//i.test(text)) text = `https://${text.slice("stremio://".length)}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
  url.hash = "";
  // Wer die „Konfigurieren“-Seite eines Addons kopiert (…/configure), meint dessen manifest.json.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/configure$/i, "");
  url.pathname = /\/manifest\.json$/i.test(path) ? path : `${path}/manifest.json`;
  return url.toString();
}

/** Basisadresse eines Addons: die Manifest-Adresse ohne `/manifest.json` (Query bleibt, wird aber hinter den Pfad gesetzt). */
function resourceUrl(manifestUrl: string, path: string): string {
  const url = new URL(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/i, "") + path;
  return url.toString();
}

const seg = (value: string) => encodeURIComponent(value);

/* ------------------------------------------------------------------ Netz */

interface RequestInit2 {
  method?: "GET" | "POST";
  /** JSON-Körper (wird serialisiert). */
  body?: unknown;
}

async function send(url: string, signal: AbortSignal, init: RequestInit2): Promise<Response> {
  const headers: Record<string, string> = init.body !== undefined ? { "Content-Type": "application/json" } : { Accept: "application/json" };
  const opts: RequestInit = {
    signal,
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  if (isTauri()) {
    // Erst über das HTTP-Plugin (Rust, kein CORS); scheitert es (Proxy, TLS, Plugin), versucht es noch das Fetch des Fensters.
    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      return await fetch(url, opts);
    } catch (err) {
      if (signal.aborted) throw err;
      try {
        return await window.fetch(url, opts);
      } catch {
        throw err;
      }
    }
  }
  return window.fetch(url, opts);
}

/** Der Rechnername einer Adresse für Fehlertexte. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Technische Ursache eines abgelehnten fetch (Tauri liefert Text, der Browser einen TypeError), gekürzt für die Anzeige. */
function detailOf(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Ruft eine Adresse mit Zeitlimit ab und liefert Status und Text; Netzfehler werden zu einem StremioError. */
async function fetchText(url: string, outer: AbortSignal | undefined, init: RequestInit2 = {}): Promise<{ status: number; ok: boolean; text: string }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  timeout.addEventListener("abort", abort);
  outer?.addEventListener("abort", abort);
  if (outer?.aborted) ctl.abort();
  try {
    const res = await send(url, ctl.signal, init);
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (err) {
    if (outer?.aborted) throw abortError();
    if (err instanceof StremioError) throw err;
    const host = hostOf(url);
    if (timeout.aborted) throw new StremioError(`Zeitüberschreitung – ${host} antwortet nicht`);
    const detail = detailOf(err);
    // Im Browser meldet fetch bei fehlendem CORS-Header, Netzfehler und Blocker nur „Failed to fetch“ – die Desktop-App hat dieses Problem nicht.
    const hint = isTauri() ? "Internetverbindung, VPN oder Firewall prüfen" : "im Browser kann auch CORS blockieren – die Desktop-App hat das Problem nicht";
    throw new StremioError(`${host} ist nicht erreichbar (${detail ? `${detail}; ` : ""}${hint})`);
  } finally {
    timeout.removeEventListener("abort", abort);
    outer?.removeEventListener("abort", abort);
  }
}

async function getJson(url: string, outer?: AbortSignal): Promise<unknown> {
  const res = await fetchText(url, outer);
  if (res.status === 404) throw new StremioError("Das Addon kennt diese Anfrage nicht (404)");
  if (!res.ok) throw new StremioError(`Das Addon meldet einen Fehler (HTTP ${res.status})`);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new StremioError(/^\s*<(!doctype|html)/i.test(res.text) ? "Die Adresse liefert eine Webseite statt der manifest.json" : "Antwort des Addons ist kein gültiges JSON");
  }
}

/** POST an die Stremio-API (Konto): liefert das geparste JSON auch bei HTTP-Fehlern, damit deren Meldung gelesen werden kann. */
export async function postStremioApi(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchText(`https://api.strem.io/api/${path}`, signal, { method: "POST", body });
  try {
    return JSON.parse(res.text);
  } catch {
    throw new StremioError(res.ok ? "Antwort von Stremio ist kein gültiges JSON" : `Stremio meldet einen Fehler (HTTP ${res.status})`);
  }
}

/* ------------------------------------------------------------------ Manifest */

function parseResource(raw: unknown): ManifestResource | null {
  if (typeof raw === "string") return raw.trim() ? { name: raw.trim() } : null;
  const o = obj(raw);
  if (!o || !str(o.name)) return null;
  const types = strList(o.types);
  const idPrefixes = strList(o.idPrefixes);
  return { name: str(o.name), ...(types.length ? { types } : {}), ...(idPrefixes.length ? { idPrefixes } : {}) };
}

function parseCatalog(raw: unknown): ManifestCatalog | null {
  const o = obj(raw);
  if (!o || !str(o.type) || !str(o.id)) return null;
  // Neues Format: extra: [{ name, isRequired }]; altes: extraRequired: ["search"].
  const extra = Array.isArray(o.extra) ? o.extra.map(obj).filter((e): e is Obj => !!e) : [];
  const needsExtra = extra.some((e) => e.isRequired === true) || strList(o.extraRequired).length > 0;
  const searchable =
    extra.some((e) => str(e.name) === "search") || strList(o.extraSupported).includes("search") || strList(o.extraRequired).includes("search");
  return { type: str(o.type), id: str(o.id), name: str(o.name) || str(o.id), needsExtra, searchable };
}

export function parseManifest(json: unknown): Manifest {
  const o = obj(json);
  const catalogs = (Array.isArray(o?.catalogs) ? o.catalogs : []).map(parseCatalog).filter((c): c is ManifestCatalog => !!c);
  // Ältere Addons nennen keine `resources`: dann liefern sie Kataloge samt Infos.
  const rawResources = Array.isArray(o?.resources) ? o.resources : catalogs.length ? ["catalog", "meta"] : null;
  const id = str(o?.id) || str(o?.name);
  const name = str(o?.name) || str(o?.id);
  if (!o || !id || !name || !rawResources) {
    throw new StremioError("Das ist kein Stremio-Addon (Manifest unvollständig)");
  }
  const idPrefixes = strList(o.idPrefixes);
  return {
    id,
    name,
    ...(str(o.description) ? { description: str(o.description) } : {}),
    ...(str(o.version) ? { version: str(o.version) } : {}),
    types: strList(o.types),
    ...(idPrefixes.length ? { idPrefixes } : {}),
    resources: rawResources.map(parseResource).filter((r): r is ManifestResource => !!r),
    catalogs,
  };
}

export async function fetchManifest(manifestUrl: string, signal?: AbortSignal): Promise<Manifest> {
  let json: unknown;
  try {
    json = await getJson(manifestUrl, signal);
  } catch (err) {
    if (err instanceof StremioError && /\(404\)/.test(err.message)) {
      throw new StremioError("Unter dieser Adresse gibt es kein Addon (404) – kopiere den Link über „Installieren“ → „Link kopieren“ der Addon-Seite");
    }
    throw err;
  }
  return parseManifest(json);
}

/** Kann das Addon diese Ressource für Typ und ID liefern? (Manifest-Regeln: Ressource, sonst oberste Ebene.) */
export function supports(manifest: Manifest, resource: "catalog" | "meta" | "stream", type: string, id?: string): boolean {
  const res = manifest.resources.find((r) => r.name === resource);
  if (!res) return false;
  const types = res.types ?? manifest.types;
  if (types.length > 0 && !types.includes(type)) return false;
  const prefixes = res.idPrefixes ?? manifest.idPrefixes;
  if (id !== undefined && prefixes && prefixes.length > 0 && !prefixes.some((p) => id.startsWith(p))) return false;
  return true;
}

/** Alle Kataloge für diesen Typ, die ohne Zusatzangabe eine Liste liefern (die „Startseiten“ des Addons). */
export function listCatalogs(manifest: Manifest, type: StremioType): ManifestCatalog[] {
  if (!supports(manifest, "catalog", type)) return [];
  return manifest.catalogs.filter((c) => c.type === type && !c.needsExtra);
}

/** Der erste Katalog für diesen Typ, der eine Suche versteht. */
export function findSearchCatalog(manifest: Manifest, type: StremioType): ManifestCatalog | null {
  if (!supports(manifest, "catalog", type)) return null;
  return manifest.catalogs.find((c) => c.type === type && c.searchable) ?? null;
}

/* ------------------------------------------------------------------ Katalog und Meta */

const YEAR_RE = /^(\d{4})(?:\s*[-–—]\s*(\d{4})?)?/;

function parseVideo(raw: unknown): MetaVideo | null {
  const o = obj(raw);
  if (!o) return null;
  const id = str(o.id);
  const season = num(o.season);
  const episode = num(o.episode) ?? num(o.number);
  if (!id || season === undefined || episode === undefined) return null;
  return {
    id,
    title: str(o.title) || str(o.name) || `Folge ${episode}`,
    season,
    episode,
    ...(str(o.released) ? { released: str(o.released) } : {}),
    ...(str(o.thumbnail) ? { thumbnail: str(o.thumbnail) } : {}),
    ...(str(o.overview) || str(o.description) ? { overview: str(o.overview) || str(o.description) } : {}),
  };
}

export function parseMeta(raw: unknown): Meta | null {
  const o = obj(raw);
  if (!o) return null;
  const id = str(o.id);
  const name = str(o.name);
  if (!id || !name) return null;
  const release = str(o.releaseInfo) || (num(o.year) !== undefined ? String(num(o.year)) : "");
  const year = YEAR_RE.test(release) ? release.replace(/\s+/g, "") : "";
  const genres = strList(o.genres).length ? strList(o.genres) : strList(o.genre);
  return {
    id,
    type: str(o.type),
    name,
    ...(/^https?:\/\//i.test(str(o.poster)) ? { poster: str(o.poster) } : {}),
    ...(/^https?:\/\//i.test(str(o.background)) ? { background: str(o.background) } : {}),
    ...(str(o.description) ? { description: str(o.description) } : {}),
    ...(year ? { year } : {}),
    genres,
    ...(str(o.runtime) ? { runtime: str(o.runtime) } : {}),
    videos: (Array.isArray(o.videos) ? o.videos : []).map(parseVideo).filter((v): v is MetaVideo => !!v),
  };
}

/** Erste Seite eines Katalogs (Addons liefern meist bis zu 100 Einträge). */
export async function fetchCatalog(manifestUrl: string, type: StremioType, catalogId: string, signal?: AbortSignal): Promise<Meta[]> {
  const json = obj(await getJson(resourceUrl(manifestUrl, `/catalog/${seg(type)}/${seg(catalogId)}.json`), signal));
  const metas = Array.isArray(json?.metas) ? json.metas : [];
  return metas.map(parseMeta).filter((m): m is Meta => !!m);
}

/** Suchtreffer eines Katalogs: `…/catalog/<typ>/<katalog>/search=<Begriff>.json`. */
export async function fetchCatalogSearch(manifestUrl: string, type: StremioType, catalogId: string, query: string, signal?: AbortSignal): Promise<Meta[]> {
  const json = obj(await getJson(resourceUrl(manifestUrl, `/catalog/${seg(type)}/${seg(catalogId)}/search=${seg(query)}.json`), signal));
  const metas = Array.isArray(json?.metas) ? json.metas : [];
  return metas.map(parseMeta).filter((m): m is Meta => !!m);
}

export async function fetchMeta(manifestUrl: string, type: StremioType, id: string, signal?: AbortSignal): Promise<Meta> {
  const json = obj(await getJson(resourceUrl(manifestUrl, `/meta/${seg(type)}/${seg(id)}.json`), signal));
  const meta = parseMeta(json?.meta);
  if (!meta) throw new StremioError("Das Addon hat keine Angaben zu diesem Titel");
  return meta;
}

/* ------------------------------------------------------------------ Streams */

/**
 * Wandelt die Stream-Liste eines Addons um. Abspielbar ist nur eine direkte http(s)-Adresse ohne besondere Header;
 * Torrent (`infoHash`), YouTube (`ytId`), externe Seiten und Nzb/Archive zählt der Rückgabewert als übersprungen.
 */
export function parseStreams(raw: unknown, addonId: string, addonName: string): { playable: StremioStream[]; skipped: number } {
  const playable: StremioStream[] = [];
  let skipped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    const o = obj(item);
    if (!o) continue;
    const url = str(o.url);
    const hints = obj(o.behaviorHints);
    const needsHeaders = !!obj(hints?.proxyHeaders);
    if (!/^https?:\/\//i.test(url) || needsHeaders) {
      skipped += 1;
      continue;
    }
    playable.push({
      addonId,
      addonName,
      url,
      name: str(o.name).replace(/\s*\n\s*/g, " "),
      description: (str(o.description) || str(o.title)).replace(/\s*\n\s*/g, " · "),
      risky: hints?.notWebReady === true,
    });
  }
  return { playable, skipped };
}

export async function fetchStreams(manifestUrl: string, addonId: string, addonName: string, type: StremioType, id: string, signal?: AbortSignal) {
  const json = obj(await getJson(resourceUrl(manifestUrl, `/stream/${seg(type)}/${seg(id)}.json`), signal));
  return parseStreams(json?.streams, addonId, addonName);
}
