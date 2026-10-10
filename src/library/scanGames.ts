import { GAMES_BASE_DIR, GAME_EXTENSIONS } from "../config/games";
import type { XmbCategory, XmbEntry } from "../data/types";
import { isTauri } from "../platform";

const GAME_EXT = new Set<string>(GAME_EXTENSIONS);

/**
 * Ergebnis einer Auflistung: Systemordner → Dateinamen darin.
 * Dateien aus den Cover-Unterordnern stehen mit relativem Pfad in derselben Liste
 * (z. B. "covers/Pixel Pilot.png" oder "media/covers/Pixel Pilot.png"), damit sich
 * das Format für bestehende Aufrufer nicht ändert.
 */
export type SystemListing = Record<string, string[]>;

export interface ScanResult {
  baseDir: string;
  listing: SystemListing;
}

const extOf = (file: string) => {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
};

/** Dateiname ohne Endung → Anzeigetitel. */
export const titleOf = (file: string) => file.slice(0, file.lastIndexOf("."));

/** Stabiler Farbton (0–359) aus einem Text, damit jede Kachel ihre eigene Farbe behält. */
const hueOf = (text: string) => {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

/** Bildendungen für Cover; die Reihenfolge ist zugleich der Vorrang (PNG vor JPG vor WebP). */
export const COVER_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/**
 * Unterordner eines System-Ordners, in denen Cover liegen dürfen (klein geschrieben, Groß-/Kleinschreibung
 * des echten Ordners ist egal). Die Reihenfolge ist der Vorrang: Cover direkt neben dem Spiel gehen vor
 * "covers", dann "media/covers", dann "images".
 */
export const COVER_DIRS = ["covers", "media/covers", "images"] as const;

const isHidden = (name: string) => name.startsWith(".");
const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });

/** Wählt Spieldateien aus: bekannte Endung, nicht versteckt, kein .bin neben gleichnamiger .cue. */
export function pickGameFiles(files: string[]): string[] {
  const cueStems = new Set(
    files.filter((f) => extOf(f) === "cue").map((f) => titleOf(f).toLowerCase()),
  );
  return files
    // Einträge mit "/" stammen aus Cover-Unterordnern und sind nie Spiele.
    .filter((f) => !f.includes("/") && !isHidden(f) && GAME_EXT.has(extOf(f)))
    .filter((f) => !(extOf(f) === "bin" && cueStems.has(titleOf(f).toLowerCase())))
    .sort(naturalSort);
}

/* ------------------------------------------------------------------ Cover */

/** Vergleichsform für Dateinamen: Unicode-normalisiert (macOS liefert oft NFD) und ohne Groß-/Kleinschreibung. */
const normName = (text: string) => text.normalize("NFC").toLowerCase();

const COVER_EXT_RANK = new Map<string, number>(COVER_EXTENSIONS.map((e, i) => [e, i]));

interface CoverCandidate {
  /** Pfad relativ zum System-Ordner, wie in der Auflistung. */
  path: string;
  /** 0 = neben dem Spiel, sonst Index in COVER_DIRS + 1. */
  dirRank: number;
  /** 0 = Dateiname mit Suffix "-cover"/"_cover", 1 = nur gleichnamig. */
  nameRank: number;
  extRank: number;
}

const compareCandidates = (a: CoverCandidate, b: CoverCandidate) =>
  a.dirRank - b.dirRank ||
  a.nameRank - b.nameRank ||
  a.extRank - b.extRank ||
  naturalSort(a.path, b.path);

/** Bildname (ohne Endung) → alle passenden Bilddateien; Schlüssel ist der normalisierte Name. */
export type CoverIndex = Map<string, CoverCandidate[]>;

/** Name ohne Endung; Dateien ohne Punkt bleiben ganz (anders als titleOf, das für Spiele immer eine Endung erwartet). */
const stemOf = (file: string) => {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};

/**
 * Sammelt alle Bilddateien eines System-Ordners, die als Cover in Frage kommen: direkt im Ordner oder
 * in COVER_DIRS. Versteckte Dateien (".DS_Store", "._Spiel.png" von macOS) und andere Unterordner zählen nicht.
 */
export function buildCoverIndex(files: string[]): CoverIndex {
  const index: CoverIndex = new Map();
  for (const rel of files) {
    const slash = rel.lastIndexOf("/");
    const dir = slash < 0 ? "" : normName(rel.slice(0, slash));
    const name = rel.slice(slash + 1);
    if (rel.split("/").some(isHidden)) continue;
    const extRank = COVER_EXT_RANK.get(extOf(name));
    if (extRank === undefined) continue;
    const dirRank = dir === "" ? 0 : (COVER_DIRS as readonly string[]).indexOf(dir) + 1;
    if (dirRank === 0 && dir !== "") continue;
    const stem = normName(stemOf(name));
    const suffixed = /[-_]cover$/.test(stem);
    const cand: CoverCandidate = { path: rel, dirRank, nameRank: suffixed ? 0 : 1, extRank };
    const list = index.get(stem);
    if (list) list.push(cand);
    else index.set(stem, [cand]);
  }
  return index;
}

/** Bestes Cover zu einem Spiel (Dateiname ohne Endung), oder undefined. */
export function findCover(index: CoverIndex, gameTitle: string): string | undefined {
  const stem = normName(gameTitle);
  const found = [stem, `${stem}-cover`, `${stem}_cover`].flatMap((k) => index.get(k) ?? []);
  return found.sort(compareCandidates)[0]?.path;
}

/** Ordnet jeder Spieldatei ihr Cover zu (relativer Pfad); Spiele ohne Cover fehlen im Ergebnis. */
export function pairCovers(files: string[]): Record<string, string> {
  const index = buildCoverIndex(files);
  const pairs: Record<string, string> = {};
  for (const game of pickGameFiles(files)) {
    const cover = findCover(index, titleOf(game));
    if (cover) pairs[game] = cover;
  }
  return pairs;
}

/** Wandelt die Auflistung in XMB-Kategorien um – je Systemordner eine Kategorie. */
export function buildSystemCategories(
  listing: SystemListing,
  baseDir: string,
  mock: boolean,
): XmbCategory[] {
  const categories = Object.keys(listing)
    .sort(naturalSort)
    .map((system): XmbCategory | null => {
      const files = pickGameFiles(listing[system]);
      if (files.length === 0) return null;
      // Demo-Daten haben keine Dateien: immer generierte Cover, nie ein Zugriff auf die Platte.
      const covers = mock ? new Map() : buildCoverIndex(listing[system]);
      const entries: XmbEntry[] = files.map((file) => {
        const cover = findCover(covers, titleOf(file));
        return {
          id: `games/${system}/${file}`,
          title: titleOf(file),
          subtitle: `${system} · .${extOf(file)}`,
          description: mock ? "Demo-Eintrag – Vorschau ohne echte Datei." : file,
          hue: hueOf(titleOf(file)),
          game: { system, path: `${baseDir}/${system}/${file}`, mock },
          art: cover ? { kind: "file", path: `${baseDir}/${system}/${cover}` } : { kind: "generated" },
          artShape: "landscape",
        };
      });
      return {
        id: `games-${system.toLowerCase()}`,
        label: `Spiele · ${system}`,
        icon: "games",
        entries,
      };
    });
  const found = categories.filter((c): c is XmbCategory => c !== null);
  if (found.length > 0) return found;

  // Ordner vorhanden, aber leer: Hinweis statt leerer Spalte.
  return [
    {
      id: "games-empty",
      label: "Spiele",
      icon: "games",
      entries: [
        {
          id: "games-empty-hint",
          title: "Keine Spiele gefunden",
          subtitle: `Lege Dateien in ${baseDir}/<System>/ ab`,
          hue: 215,
        },
      ],
    },
  ];
}

/** Löst "~" im konfigurierten Basisordner auf. */
async function resolveBaseDir(configured: string): Promise<string> {
  if (!configured.startsWith("~")) return configured.replace(/\/+$/, "");
  const { homeDir } = await import("@tauri-apps/api/path");
  const home = (await homeDir()).replace(/[\\/]+$/, "");
  return (home + configured.slice(1)).replace(/\/+$/, "");
}

/**
 * Listet die Cover-Unterordner eines System-Ordners (eine Ebene, plus "media/covers") und liefert die Dateien
 * darin als relative Pfade. Nicht lesbare oder fehlende Ordner werden still übergangen – Cover sind optional.
 */
async function listCoverFolders(
  readDir: typeof import("@tauri-apps/plugin-fs").readDir,
  sysPath: string,
  inner: { name: string; isDirectory: boolean }[],
): Promise<string[]> {
  const out: string[] = [];
  const add = async (rel: string) => {
    try {
      for (const e of await readDir(`${sysPath}/${rel}`)) {
        if (!e.isDirectory && !isHidden(e.name)) out.push(`${rel}/${e.name}`);
      }
    } catch {
      /* Ordner nicht lesbar: ignorieren */
    }
  };
  const dirs = inner.filter((e) => e.isDirectory && !isHidden(e.name));
  for (const d of dirs) {
    const lower = normName(d.name);
    if (lower === "covers" || lower === "images") await add(d.name);
    else if (lower === "media") {
      try {
        for (const m of await readDir(`${sysPath}/${d.name}`)) {
          if (m.isDirectory && normName(m.name) === "covers") await add(`${d.name}/${m.name}`);
        }
      } catch {
        /* ignorieren */
      }
    }
  }
  return out;
}

/**
 * Liest den Basisordner mit der Tauri-FS-API: Jeder Unterordner ist ein System,
 * dessen Dateien sind die Spiele (Bilder daneben und in Cover-Unterordnern sind deren Cover). Wirft, wenn der Basisordner nicht existiert
 * oder nicht lesbar ist – der Aufrufer fällt dann auf die Demo-Daten zurück.
 */
export async function scanGamesDir(configuredDir: string = GAMES_BASE_DIR): Promise<ScanResult> {
  if (!isTauri()) throw new Error("Dateisystemzugriff nur in der Tauri-App verfügbar");

  const { exists, readDir } = await import("@tauri-apps/plugin-fs");
  const baseDir = await resolveBaseDir(configuredDir);
  if (!(await exists(baseDir))) throw new Error(`Basisordner nicht gefunden: ${baseDir}`);

  const listing: SystemListing = {};
  for (const sys of await readDir(baseDir)) {
    if (!sys.isDirectory || isHidden(sys.name)) continue;
    try {
      const sysPath = `${baseDir}/${sys.name}`;
      const inner = await readDir(sysPath);
      // .app-Bundles sind unter macOS Ordner, zählen aber als Spiel.
      listing[sys.name] = [...inner.map((e) => e.name), ...(await listCoverFolders(readDir, sysPath, inner))];
    } catch (err) {
      console.warn(`System-Ordner "${sys.name}" nicht lesbar`, err);
    }
  }
  return { baseDir, listing };
}
