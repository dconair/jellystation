/**
 * Download-Archiv aus den GitHub-Releases eines Emulator-Projekts wählen.
 *
 * `pickAsset` ist eine reine Funktion (Gegenstück zum PICK_JS in scripts/install-emulators.sh): Sie bekommt die
 * Release-Antwort der GitHub-API und wählt anhand der Regeln aus src/emulators/emulators.json (bzw. sources.ts) das
 * passende Archiv für Betriebssystem und Prozessor. Dateinamen werden nie geraten, sondern zur Laufzeit gelesen.
 */
import { isTauri } from "../platform";

export const GITHUB_API = "https://api.github.com";

export type HwArch = "arm64" | "x86_64";
export type RepoArch = "arm64" | "x86_64" | "any";

export interface GhAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  digest?: unknown;
  state?: unknown;
}

export interface GhRelease {
  tag_name?: unknown;
  draft?: unknown;
  assets?: unknown;
}

export interface AssetRules {
  /** Regex-Liste, ALLE müssen auf den Dateinamen passen (ohne Groß-/Kleinschreibung). */
  include: readonly string[];
  /** Regex-Liste, KEINE darf passen. */
  exclude: readonly string[];
}

export interface ArchHints {
  arm64: string;
  x86_64: string;
  universal: string;
}

export interface PickedAsset {
  tag: string;
  name: string;
  url: string;
  /** SHA-256 aus dem „digest“-Feld der GitHub-Antwort, falls vorhanden. */
  sha256: string | null;
  size: number | null;
  /** true = es ist ein Build für die andere Prozessor-Bauart (läuft über Rosetta 2 bzw. x64-Emulation). */
  emulated: boolean;
}

export interface PickResult {
  asset: PickedAsset | null;
  /** Namen der gesehenen Dateien (für die Fehlermeldung „vorhanden: …“). */
  seen: string[];
}

const re = (source: string) => new RegExp(source, "i");

/**
 * Wählt in den Releases (neueste zuerst) das erste Release mit passendem Archiv und darin das beste Archiv:
 * erst nach Bauart (passend > neutral > fremd; reine ARM-Builds laufen nicht auf Intel), dann nach Archivart.
 */
export function pickAsset(
  releases: readonly GhRelease[],
  rules: AssetRules,
  repoArch: RepoArch,
  hw: HwArch,
  hints: ArchHints,
  extensionOrder: readonly string[],
): PickResult {
  const inc = rules.include.map(re);
  const exc = rules.exclude.map(re);
  const reArm = re(hints.arm64);
  const reX64 = re(hints.x86_64);
  const reUni = re(hints.universal);
  const ext = extensionOrder.map(re);
  const wanted: HwArch = repoArch === "any" ? hw : repoArch;
  const seen: string[] = [];
  for (const r of releases) {
    if (!r || typeof r !== "object" || r.draft === true) continue;
    let best: { a: GhAsset; name: string; url: string; score: number; isArm: boolean; isX64: boolean; isUni: boolean } | null = null;
    for (const a of Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []) {
      if (!a || typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
      const name = a.name;
      seen.push(name);
      if (typeof a.state === "string" && a.state !== "uploaded") continue;
      if (!inc.every((x) => x.test(name))) continue;
      if (exc.some((x) => x.test(name))) continue;
      const isArm = reArm.test(name);
      const isX64 = reX64.test(name);
      const isUni = reUni.test(name);
      let archScore: number;
      if (isUni) archScore = 2.5;
      else if (wanted === "arm64") archScore = isArm ? 3 : isX64 ? 0 : 2;
      else archScore = isX64 ? 3 : isArm ? -1 : 2;
      if (archScore < 0) continue;
      let e = ext.findIndex((x) => x.test(name));
      e = e < 0 ? 0 : ext.length - e;
      const score = archScore * 100 + e;
      if (!best || score > best.score) best = { a, name, url: a.browser_download_url, score, isArm, isX64, isUni };
    }
    if (best) {
      const m = typeof best.a.digest === "string" ? /^sha256:([0-9a-fA-F]{64})$/.exec(best.a.digest) : null;
      const size = typeof best.a.size === "number" && Number.isInteger(best.a.size) && best.a.size > 0 ? best.a.size : null;
      const emulated = hw === "arm64" && !best.isUni && !best.isArm && (repoArch === "x86_64" || best.isX64);
      return {
        asset: {
          tag: typeof r.tag_name === "string" ? r.tag_name : "",
          name: best.name,
          url: best.url,
          sha256: m ? m[1].toLowerCase() : null,
          size,
          emulated,
        },
        seen,
      };
    }
  }
  return { asset: null, seen };
}

/* ------------------------------------------------------------------ Abruf */

export class GithubError extends Error {
  /** true = GitHub ist gerade nicht brauchbar (Netz, Abruflimit) – ein anderes Repository hilft nicht. */
  readonly fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = "GithubError";
    this.fatal = fatal;
  }
}

async function send(url: string, signal?: AbortSignal): Promise<Response> {
  const init = { signal, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } };
  if (isTauri()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(url, init);
  }
  return window.fetch(url, init);
}

/** GET auf die GitHub-API. `undefined` = 404 (gibt es nicht), sonst das JSON; andere Fehler werfen eine GithubError. */
export async function githubGet(path: string, signal?: AbortSignal): Promise<unknown | undefined> {
  let res: Response;
  try {
    res = await send(`${GITHUB_API}${path}`, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new GithubError("GitHub ist nicht erreichbar – Internetverbindung prüfen", true);
  }
  if (res.status === 404) return undefined;
  if (res.status === 403 || res.status === 429) {
    throw new GithubError("GitHub bremst gerade (Abruflimit für diese Internetadresse) – in einer Stunde erneut versuchen", true);
  }
  if (!res.ok) throw new GithubError(`GitHub meldet einen Fehler (HTTP ${res.status})`, true);
  try {
    return await res.json();
  } catch {
    throw new GithubError("Die Antwort von GitHub war nicht lesbar (Anmeldeseite eines WLANs?)", true);
  }
}

const asList = (json: unknown): GhRelease[] =>
  Array.isArray(json) ? (json as GhRelease[]) : json && typeof json === "object" ? [json as GhRelease] : [];

/**
 * Sucht in einem Repository: zuerst im angegebenen Release (`latest` oder `tags/<Tag>`), dann in den letzten 10.
 * Liefert das Archiv oder eine Begründung (`why`), warum nichts Passendes dabei war.
 */
export async function findAssetInRepo(
  repo: string,
  releasesPath: string,
  rules: AssetRules,
  repoArch: RepoArch,
  hw: HwArch,
  hints: ArchHints,
  extensionOrder: readonly string[],
  signal?: AbortSignal,
): Promise<{ asset: PickedAsset | null; why: string }> {
  const first = asList(await githubGet(`/repos/${repo}/releases/${releasesPath}`, signal));
  let seen: string[] = [];
  if (first.length) {
    const r = pickAsset(first, rules, repoArch, hw, hints, extensionOrder);
    if (r.asset) return { asset: r.asset, why: "" };
    seen = r.seen;
  }
  const more = asList(await githubGet(`/repos/${repo}/releases?per_page=10`, signal));
  const r = pickAsset(more, rules, repoArch, hw, hints, extensionOrder);
  if (r.asset) return { asset: r.asset, why: "" };
  if (!seen.length) seen = r.seen;
  const list = seen.slice(0, 6).join(", ");
  return { asset: null, why: `In ${repo} gibt es kein passendes Download-Archiv${list ? ` (vorhanden: ${list}${seen.length > 6 ? ", …" : ""})` : ""}` };
}
