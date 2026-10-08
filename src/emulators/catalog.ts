/**
 * Katalog der unterstützten Emulatoren – die EINE Stelle, an der Systeme, Startargumente,
 * Installationshilfen und Suchmuster stehen.
 *
 * Die Startargumente stammen aus der Kommandozeilen-Dokumentation der Emulatoren. Weichen sie in
 * einer neueren Version ab, genügt es, hier die passende `buildArgs`-Funktion anzupassen.
 */

export interface LaunchArgs {
  /** Argumente, die dem Emulator übergeben werden. */
  args: string[];
  /** Optionaler Hinweis, der nach dem Start angezeigt wird (z. B. bei Installationspaketen). */
  note?: string;
}

export interface EmulatorDef {
  /** Stabile ID (Schlüssel in settings.emulators). */
  id: string;
  /** Anzeigename. */
  name: string;
  /** Wofür der Emulator da ist, z. B. "PlayStation 3". */
  consoles: string;
  /**
   * Ordnernamen im Spiele-Ordner, die diesem Emulator zugeordnet werden (siehe normalizeSystem:
   * klein geschrieben, ohne Leerzeichen, Binde- und Unterstriche).
   */
  systems: string[];
  /** Regulärer Ausdruck (ohne Groß-/Kleinschreibung) für den Namen der .app, z. B. "^RPCS3\\.app$". */
  appPattern: string;
  /** Bundle-Identifier für die Spotlight-Suche (optional, nur ein zusätzlicher Suchweg). */
  bundleIds: string[];
  /** Kommandozeile zum Start einer Spieldatei. */
  buildArgs: (gamePath: string) => LaunchArgs;
  /** Homebrew-Cask zum Installieren, falls es einen gibt. */
  brewCask?: string;
  /** Offizielle Download-Seite (öffnet im Browser). */
  downloadUrl: string;
  /** Hinweis zur Einrichtung (z. B. Firmware), wird im Emulator-Dialog gezeigt. */
  setupNote?: string;
}

const extOf = (path: string) => {
  const m = /\.([^./\\]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
};

export const EMULATORS: EmulatorDef[] = [
  {
    id: "rpcs3",
    name: "RPCS3",
    consoles: "PlayStation 3",
    systems: ["ps3", "playstation3"],
    appPattern: "^RPCS3.*\\.app$",
    bundleIds: ["net.rpcs3.rpcs3"],
    buildArgs: (gamePath) =>
      extOf(gamePath) === "pkg"
        ? {
            // .pkg ist bei RPCS3 ein Installationspaket und lässt sich nicht direkt starten.
            args: [],
            note: "Installationspaket: In RPCS3 über „Datei → .pkg installieren“ einspielen, danach das Spiel dort starten.",
          }
        : { args: ["--no-gui", gamePath] },
    downloadUrl: "https://rpcs3.net/download",
    setupNote: "Beim ersten Start in RPCS3 die PS3-Firmware installieren (Datei → Firmware installieren).",
  },
  {
    id: "duckstation",
    name: "DuckStation",
    consoles: "PlayStation 1",
    systems: ["ps1", "psx", "psone", "playstation", "playstation1"],
    appPattern: "^DuckStation.*\\.app$",
    bundleIds: ["org.duckstation.duckstation"],
    buildArgs: (gamePath) => ({ args: ["-batch", "-fullscreen", "--", gamePath] }),
    downloadUrl: "https://www.duckstation.org/",
    setupNote: "Beim ersten Start ein PS1-BIOS im DuckStation-Einrichtungsassistenten angeben.",
  },
  {
    id: "pcsx2",
    name: "PCSX2",
    consoles: "PlayStation 2",
    systems: ["ps2", "playstation2"],
    appPattern: "^PCSX2.*\\.app$",
    bundleIds: ["net.pcsx2.pcsx2"],
    buildArgs: (gamePath) => ({ args: ["-batch", "-fullscreen", "--", gamePath] }),
    brewCask: "pcsx2",
    downloadUrl: "https://pcsx2.net/downloads",
    setupNote: "Beim ersten Start ein PS2-BIOS im PCSX2-Einrichtungsassistenten angeben.",
  },
  {
    id: "ppsspp",
    name: "PPSSPP",
    consoles: "PlayStation Portable",
    systems: ["psp", "playstationportable"],
    appPattern: "^PPSSPP.*\\.app$",
    bundleIds: ["org.ppsspp.ppsspp"],
    buildArgs: (gamePath) => ({ args: [gamePath, "--fullscreen"] }),
    brewCask: "ppsspp-emulator",
    downloadUrl: "https://www.ppsspp.org/download",
  },
  {
    id: "dolphin",
    name: "Dolphin",
    consoles: "GameCube und Wii",
    systems: ["gc", "gcn", "ngc", "gamecube", "nintendogamecube", "wii", "nintendowii"],
    appPattern: "^Dolphin.*\\.app$",
    bundleIds: ["org.dolphin-emu.dolphin"],
    buildArgs: (gamePath) => ({ args: ["-b", "-e", gamePath] }),
    brewCask: "dolphin",
    downloadUrl: "https://dolphin-emu.org/download/",
  },
];

/** "PlayStation 3", "ps_3" → "playstation3" / "ps3": klein, ohne Leer-, Binde- und Unterstriche. */
export const normalizeSystem = (name: string) => name.toLowerCase().replace(/[\s_\-.]+/g, "");

export function getEmulator(id: string): EmulatorDef | undefined {
  return EMULATORS.find((e) => e.id === id);
}

/** Emulator für einen Systemordner (z. B. "PS3", "PlayStation 2"); undefined, wenn keiner bekannt ist. */
export function emulatorForSystem(system: string): EmulatorDef | undefined {
  const key = normalizeSystem(system);
  return EMULATORS.find((e) => e.systems.includes(key));
}
