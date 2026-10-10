import type { ScanResult, ScannedGame } from "./scanGames";

/**
 * Demo-Daten für den Fallback-Modus: drei fiktive Konsolen-Ordner mit je fünf
 * fiktiven Spielen und eine Datei, deren System die App nicht erkennt. Die Einträge laufen durch dieselbe
 * Pipeline wie echte Daten (buildLibraryCategories).
 *
 * Cover: Demo-Einträge bekommen immer das generierte Platzhalter-Cover ({ kind: "generated" },
 * siehe src/art/PlaceholderCover.tsx) – buildLibraryCategories erzwingt das im Mock-Modus, es gibt
 * hier keine Bilddateien und es wird nie auf die Platte zugegriffen.
 */
export const MOCK_LISTING: Record<string, string[]> = {
  PS1: [
    "Pixel Pilot.cue",
    "Pixel Pilot.bin",
    "Dungeon Dwellers.chd",
    "Turbo Kart Mania.cue",
    "Shadow Alley.iso",
    "Blocky Brawl.chd",
  ],
  PS2: [
    "Crimson Tides.iso",
    "Clockwork Chronicles.iso",
    "Skyward Blade.iso",
    "Dustland Racers.iso",
    "Moonlit Samurai.iso",
  ],
  PS3: [
    "Neon Circuit GT.iso",
    "Ashen Kingdoms.iso",
    "Starfall Odyssey.pkg",
    "Iron Harbor.iso",
    "Hollow Reverie.pkg",
  ],
};

export const MOCK_BASE_DIR = "/Demo/JellyStation/Games";

const extOf = (file: string) => file.slice(file.lastIndexOf(".") + 1).toLowerCase();

function mockGame(rel: string, system: string | null): ScannedGame {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return {
    path: `${MOCK_BASE_DIR}/${rel}`,
    rel,
    name,
    kind: "file",
    ext: extOf(name),
    size: 0,
    system,
    how: system ? "folder" : "none",
    uncertain: false,
    guess: system ? null : "PS2",
    serial: null,
    title: null,
    reason: system ? `Ordner „${system}“` : "Weder Inhalt noch Name oder Ordner verraten das System",
  };
}

/** Das Demo-Ergebnis in der Form des echten Scans. */
export function mockScan(): ScanResult {
  const games: ScannedGame[] = [];
  for (const [system, files] of Object.entries(MOCK_LISTING)) {
    // Eine .bin neben gleichnamiger .cue gehört zu ihr und ist kein eigenes Spiel.
    const cueStems = new Set(files.filter((f) => extOf(f) === "cue").map((f) => f.slice(0, f.lastIndexOf(".")).toLowerCase()));
    for (const file of files) {
      if (extOf(file) === "bin" && cueStems.has(file.slice(0, file.lastIndexOf(".")).toLowerCase())) continue;
      games.push(mockGame(`${system}/${file}`, system));
    }
  }
  // Eine Datei, die sich nicht zuordnen lässt – zeigt „Nicht zugeordnet“ und die Zuordnung von Hand.
  games.push(mockGame("Mystery Disc.iso", null));
  return { baseDir: MOCK_BASE_DIR, games, images: [], truncated: false, unreadable: 0 };
}
