/**
 * Demo-Daten für den Fallback-Modus: drei fiktive Konsolen-Ordner mit je fünf
 * fiktiven Spielen. Die Einträge entsprechen dem Ergebnis einer Ordner-Auflistung
 * (Systemordner → Dateinamen) und laufen durch dieselbe Pipeline wie echte Daten.
 *
 * Cover: Demo-Einträge bekommen immer das generierte Platzhalter-Cover ({ kind: "generated" },
 * siehe src/art/PlaceholderCover.tsx) – buildSystemCategories erzwingt das im Mock-Modus, es gibt
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
