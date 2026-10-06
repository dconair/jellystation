import { GAMES_BASE_DIR, GAME_EXTENSIONS } from "../config/games";
import type { XmbCategory, XmbEntry } from "../data/types";
import { isTauri } from "../platform";

const GAME_EXT = new Set<string>(GAME_EXTENSIONS);

/** Ergebnis einer Auflistung: Systemordner → Dateinamen darin. */
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

const isHidden = (name: string) => name.startsWith(".");
const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });

/** Wählt Spieldateien aus: bekannte Endung, nicht versteckt, kein .bin neben gleichnamiger .cue. */
export function pickGameFiles(files: string[]): string[] {
  const cueStems = new Set(
    files.filter((f) => extOf(f) === "cue").map((f) => titleOf(f).toLowerCase()),
  );
  return files
    .filter((f) => !isHidden(f) && GAME_EXT.has(extOf(f)))
    .filter((f) => !(extOf(f) === "bin" && cueStems.has(titleOf(f).toLowerCase())))
    .sort(naturalSort);
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
      const entries: XmbEntry[] = files.map((file) => ({
        id: `games/${system}/${file}`,
        title: titleOf(file),
        subtitle: `${system} · .${extOf(file)}`,
        description: mock ? "Demo-Eintrag – Vorschau ohne echte Datei." : file,
        hue: hueOf(titleOf(file)),
        game: { system, path: `${baseDir}/${system}/${file}`, mock },
      }));
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
 * Liest den Basisordner mit der Tauri-FS-API: Jeder Unterordner ist ein System,
 * dessen Dateien sind die Spiele. Wirft, wenn der Basisordner nicht existiert
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
      const inner = await readDir(`${baseDir}/${sys.name}`);
      // .app-Bundles sind unter macOS Ordner, zählen aber als Spiel.
      listing[sys.name] = inner.map((e) => e.name);
    } catch (err) {
      console.warn(`System-Ordner "${sys.name}" nicht lesbar`, err);
    }
  }
  return { baseDir, listing };
}
