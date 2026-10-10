import { GAMES_BASE_DIR } from "../config/games";
import type { GameRef, XmbCategory, XmbEntry } from "../data/types";
import { isTauri } from "../platform";

/**
 * Spielebibliothek aus EINEM Ordner: Der Rust-Befehl `games_scan` (src-tauri/src/library.rs) durchsucht ihn rekursiv und
 * erkennt für jedes Spiel das System (Inhalt, Seriennummer, Dateiformat, Ordnername). Hier wird daraus das Menü: je System
 * eine Kategorie, dazu „Nicht zugeordnet“ und „Programme“ (macOS-.app). Dateien werden nie verschoben.
 */

/** Die Systeme, die ein Spiel haben kann (Namen wie im Emulator-Katalog, siehe src/emulators/catalog.ts). */
export const GAME_SYSTEMS = ["PS1", "PS2", "PS3", "PSP", "GameCube", "Wii"] as const;
export type GameSystem = (typeof GAME_SYSTEMS)[number];

/** Wert in `settings.gameSystems`: Spiel nicht anzeigen. */
export const IGNORE = "ignore";

/** Name der Sammel-Kategorien. */
export const UNASSIGNED_LABEL = "Nicht zugeordnet";
export const PROGRAMS_LABEL = "Programme";

export const isGameSystem = (value: string | null | undefined): value is GameSystem =>
  !!value && (GAME_SYSTEMS as readonly string[]).includes(value);

/** Ein vom Rust-Scan gefundenes Spiel (Felder wie `ScannedGame` in library.rs). */
export interface ScannedGame {
  /** Absoluter Pfad mit "/". */
  path: string;
  /** Pfad relativ zum Spiele-Ordner. */
  rel: string;
  name: string;
  kind: "file" | "folder" | "bundle";
  /** Endung in Kleinbuchstaben ohne Punkt, bei Ordnern leer. */
  ext: string;
  size: number;
  system: string | null;
  how: "content" | "serial" | "format" | "folder" | "size" | "none";
  uncertain: boolean;
  guess: string | null;
  serial: string | null;
  /** Titel aus dem Spiel selbst (PARAM.SFO, Disc-Kopf). */
  title: string | null;
  reason: string;
}

export interface ScanResult {
  baseDir: string;
  games: ScannedGame[];
  /** Alle Bilder im Ordner (relative Pfade) – mögliche Cover. */
  images: string[];
  /** Es gab mehr Dateien als erlaubt. */
  truncated: boolean;
  /** Ordner, die sich nicht lesen ließen. */
  unreadable: number;
}

const naturalSort = (a: string, b: string) => a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });

/** Stabiler Farbton (0–359) aus einem Text, damit jede Kachel ihre eigene Farbe behält. */
const hueOf = (text: string) => {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

/** Datei- oder Ordnername ohne Endung. */
const stemOf = (file: string) => {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};

const isHidden = (name: string) => name.startsWith(".");

/** Anzeigetitel: Dateiname ohne Endung; heißt die Datei nur wie eine Seriennummer, gilt der Titel aus dem Spiel. */
export function titleOfGame(game: Pick<ScannedGame, "name" | "kind" | "title">): string {
  const base = game.kind === "folder" ? game.name : stemOf(game.name);
  const generic = /^[A-Z]{4}-?\d{5}$/i.test(base) || /^(PS3|PSP)_GAME$/i.test(base);
  return (generic && game.title ? game.title : base) || game.name;
}

/* ------------------------------------------------------------------ Cover */

/** Bildendungen für Cover; die Reihenfolge ist zugleich der Vorrang (PNG vor JPG vor WebP). */
export const COVER_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/**
 * Unterordner neben den Spielen, in denen Cover liegen dürfen (klein geschrieben, Groß-/Kleinschreibung
 * des echten Ordners ist egal). Die Reihenfolge ist der Vorrang: Cover direkt neben dem Spiel gehen vor
 * "covers", dann "media/covers", dann "images".
 */
export const COVER_DIRS = ["covers", "media/covers", "images"] as const;

const extOf = (file: string) => {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
};

/** Vergleichsform für Dateinamen: Unicode-normalisiert (macOS liefert oft NFD) und ohne Groß-/Kleinschreibung. */
const normName = (text: string) => text.normalize("NFC").toLowerCase();

const COVER_EXT_RANK = new Map<string, number>(COVER_EXTENSIONS.map((e, i) => [e, i]));

interface CoverCandidate {
  /** Pfad relativ zum Ordner, für den der Index gebaut wurde. */
  path: string;
  /** 0 = neben dem Spiel, sonst Index in COVER_DIRS + 1. */
  dirRank: number;
  /** 0 = Dateiname mit Suffix "-cover"/"_cover", 1 = nur gleichnamig. */
  nameRank: number;
  extRank: number;
}

const compareCandidates = (a: CoverCandidate, b: CoverCandidate) =>
  a.dirRank - b.dirRank || a.nameRank - b.nameRank || a.extRank - b.extRank || naturalSort(a.path, b.path);

/** Bildname (ohne Endung) → alle passenden Bilddateien; Schlüssel ist der normalisierte Name. */
export type CoverIndex = Map<string, CoverCandidate[]>;

/**
 * Sammelt alle Bilddateien eines Ordners, die als Cover in Frage kommen: direkt im Ordner oder in COVER_DIRS.
 * `files` sind Namen relativ zum Ordner ("Spiel.png", "covers/Spiel.png"). Versteckte Dateien (".DS_Store",
 * "._Spiel.png" von macOS) und andere Unterordner zählen nicht.
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

/**
 * Cover-Suche für beliebig viele Spiele aus der Bilderliste des Scans. Ein Spiel findet sein Cover neben sich, in
 * `covers`/`media/covers`/`images` daneben und – erst danach – im selben Sinn im obersten Spiele-Ordner (praktisch,
 * wenn alle Cover in einem Ordner "covers" liegen, die Spiele aber in Unterordnern).
 */
export function makeCoverFinder(images: string[]): (gameRel: string, gameTitle: string) => string | undefined {
  // Ordner (normalisiert, "" = Wurzel) → Dateinamen darin
  const byDir = new Map<string, string[]>();
  for (const rel of images) {
    const slash = rel.lastIndexOf("/");
    const dir = slash < 0 ? "" : normName(rel.slice(0, slash));
    const list = byDir.get(dir);
    if (list) list.push(rel.slice(slash + 1));
    else byDir.set(dir, [rel.slice(slash + 1)]);
  }
  const cache = new Map<string, CoverIndex>();
  const indexFor = (dir: string): CoverIndex => {
    const key = normName(dir);
    let index = cache.get(key);
    if (!index) {
      const prefix = key === "" ? "" : `${key}/`;
      const files = [...(byDir.get(key) ?? [])];
      for (const sub of COVER_DIRS) files.push(...(byDir.get(`${prefix}${sub}`) ?? []).map((n) => `${sub}/${n}`));
      index = buildCoverIndex(files);
      cache.set(key, index);
    }
    return index;
  };
  const join = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);
  // Die Bilder behalten ihre echte Schreibweise: der Pfad kommt aus der Liste, nicht aus dem normalisierten Schlüssel.
  const real = new Map<string, string>(images.map((rel) => [normName(rel), rel]));
  const resolve = (dir: string, found: string | undefined) => {
    if (!found) return undefined;
    const full = join(dir, found);
    return real.get(normName(full)) ?? full;
  };
  return (gameRel, gameTitle) => {
    const slash = gameRel.lastIndexOf("/");
    const dir = slash < 0 ? "" : gameRel.slice(0, slash);
    return (
      resolve(dir, findCover(indexFor(dir), gameTitle)) ??
      (dir === "" ? undefined : resolve("", findCover(indexFor(""), gameTitle)))
    );
  };
}

/* ------------------------------------------------------------------ Kategorien */

const BASE_DIR_FALLBACK = GAMES_BASE_DIR;

function describe(game: ScannedGame, system: string | null, manual: boolean): string {
  const why = manual ? "Von dir zugeordnet" : game.reason;
  if (system) return `${game.rel} · ${why}`;
  return game.guess ? `${why}. Vorschlag: ${game.guess}. Bestätigen zum Zuordnen.` : `${why}. Bestätigen zum Zuordnen.`;
}

/**
 * Wandelt das Scan-Ergebnis in XMB-Kategorien um: je System eine Kategorie, dahinter „Programme“ (macOS-.app) und
 * „Nicht zugeordnet“. `overrides` sind die Zuordnungen von Hand (Pfad relativ zum Spiele-Ordner → System oder "ignore").
 */
export function buildLibraryCategories(
  scan: ScanResult,
  overrides: Readonly<Record<string, string>> | undefined,
  mock: boolean,
): XmbCategory[] {
  // Demo-Daten haben keine Dateien: immer generierte Cover, nie ein Zugriff auf die Platte.
  const coverOf = mock ? () => undefined : makeCoverFinder(scan.images);
  const groups = new Map<string, XmbEntry[]>();
  const add = (group: string, entry: XmbEntry) => {
    const list = groups.get(group);
    if (list) list.push(entry);
    else groups.set(group, [entry]);
  };

  for (const game of scan.games) {
    const override = overrides?.[game.rel];
    if (override === IGNORE) continue;
    const manual = isGameSystem(override);
    const system = manual ? override : game.system;
    const native = game.kind === "bundle";
    const unassigned = !native && !system;
    const title = titleOfGame(game);
    const cover = coverOf(game.rel, stemOf(game.name));
    const ref: GameRef = {
      system: native || unassigned ? "" : (system ?? ""),
      path: game.path,
      mock,
      rel: game.rel,
      ...(unassigned ? { unassigned: true, ...(game.guess ? { guess: game.guess } : {}) } : {}),
      ...(!manual && !native && game.uncertain && system ? { uncertain: true } : {}),
      ...(manual ? { manual: true } : {}),
    };
    const kindText = game.kind === "folder" ? "Ordner" : native ? "Programm" : `.${game.ext}`;
    const label = native ? PROGRAMS_LABEL : unassigned ? UNASSIGNED_LABEL : system;
    const subtitle = unassigned
      ? `${UNASSIGNED_LABEL} · ${kindText}`
      : `${native ? PROGRAMS_LABEL : system} · ${kindText}${ref.uncertain ? " · vermutet" : ""}`;
    add(label as string, {
      id: `games/${game.rel}`,
      title,
      subtitle,
      description: native ? `${game.rel} · startet direkt, ohne Emulator` : describe(game, system, manual),
      hue: hueOf(title),
      game: ref,
      art: cover ? { kind: "file", path: `${scan.baseDir}/${cover}` } : { kind: "generated" },
      artShape: "landscape",
    });
  }

  const rank = (name: string) => (name === UNASSIGNED_LABEL ? 2 : name === PROGRAMS_LABEL ? 1 : 0);
  const categories = [...groups.keys()]
    .sort((a, b) => rank(a) - rank(b) || naturalSort(a, b))
    .map((name): XmbCategory => {
      const entries = (groups.get(name) ?? []).sort((a, b) => naturalSort(a.title, b.title));
      return {
        id: `games-${name === UNASSIGNED_LABEL ? "unassigned" : name === PROGRAMS_LABEL ? "programs" : name.toLowerCase()}`,
        label: `Spiele · ${name}`,
        icon: "games",
        entries,
      };
    });
  if (categories.length > 0) return categories;

  // Ordner vorhanden, aber ohne Spiele: Hinweis statt leerer Spalte.
  return [
    {
      id: "games-empty",
      label: "Spiele",
      icon: "games",
      entries: [
        {
          id: "games-empty-hint",
          title: "Keine Spiele gefunden",
          subtitle: `Lege Spiele einfach in ${scan.baseDir || BASE_DIR_FALLBACK} ab`,
          description: "ISO, CHD, CUE/BIN, Spieleordner … – auch in Unterordnern. JellyStation erkennt das System selbst.",
          hue: 215,
        },
      ],
    },
  ];
}

/**
 * Liest den Spiele-Ordner mit dem Rust-Befehl `games_scan`. Wirft, wenn der Ordner nicht existiert oder nicht lesbar ist
 * (oder die App nur im Browser läuft) – der Aufrufer fällt dann auf die Demo-Daten zurück.
 */
export async function scanGamesDir(configuredDir: string = GAMES_BASE_DIR): Promise<ScanResult> {
  if (!isTauri()) throw new Error("Dateisystemzugriff nur in der Tauri-App verfügbar");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const raw = await invoke<{
      root: string;
      games: ScannedGame[];
      images: string[];
      truncated: boolean;
      unreadable: number;
    }>("games_scan", { dir: configuredDir || GAMES_BASE_DIR });
    return { baseDir: raw.root, games: raw.games, images: raw.images, truncated: raw.truncated, unreadable: raw.unreadable };
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Kurzfassung für Setup und Prüfungen: Anzahl Spiele je System, dazu „Nicht zugeordnet“ und „Programme“. */
export function countBySystem(
  scan: Pick<ScanResult, "games">,
  overrides?: Readonly<Record<string, string>>,
): { systems: Record<string, number>; unassigned: number; programs: number } {
  const systems: Record<string, number> = {};
  let unassigned = 0;
  let programs = 0;
  for (const game of scan.games) {
    const override = overrides?.[game.rel];
    if (override === IGNORE) continue;
    if (game.kind === "bundle") programs++;
    else {
      const system = isGameSystem(override) ? override : game.system;
      if (system) systems[system] = (systems[system] ?? 0) + 1;
      else unassigned++;
    }
  }
  return { systems, unassigned, programs };
}
