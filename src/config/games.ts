/**
 * Zentrale Konfiguration der Spielebibliothek.
 *
 * Der echte Spiele-Ordner wird im Setup-Assistenten per Ordnerdialog gewählt und im
 * Tauri-Store gespeichert (src/settings). GAMES_BASE_DIR ist nur der Standardwert,
 * falls (noch) nichts gewählt wurde.
 *
 * Struktur:  <Basisordner>/<System>/<Spiel>.<Endung>
 * z. B.      ~/JellyStation/Games/PS3/Gran Turismo 5.iso
 *
 * Existiert der Ordner nicht (oder läuft die App nur im Browser), zeigt die XMB
 * automatisch Demo-Daten (siehe src/library/mockLibrary.ts).
 */

/** Standard-Basisordner der Bibliothek. "~" wird zum Home-Verzeichnis aufgelöst. */
export const GAMES_BASE_DIR = "~/JellyStation/Games";

/** Dateiendungen (klein geschrieben, ohne Punkt), die als Spiel erkannt werden. */
export const GAME_EXTENSIONS = ["iso", "app", "pkg", "cue", "chd", "bin", "elf"] as const;

export interface EmulatorConfig {
  /** Anzeigename in Meldungen. */
  name: string;
  /**
   * Programmname aus dem Shell-Scope in src-tauri/capabilities/emulators.json.
   * Dort steht auch der absolute Systempfad der Anwendung.
   */
  command: string;
  /** Standard-Installationspfad (macOS) – nur für den Abhängigkeits-Check im Setup. */
  binary: string;
  /** Kommandozeilenargumente zum Starten einer Spieldatei. */
  args: (gamePath: string) => string[];
}

/** Zuordnung System-Ordnername (klein geschrieben) → Emulator. */
export const EMULATORS: Record<string, EmulatorConfig> = {
  ps3: {
    name: "RPCS3",
    command: "rpcs3",
    // Muss mit "cmd" in src-tauri/capabilities/emulators.json übereinstimmen.
    binary: "/Applications/RPCS3.app/Contents/MacOS/rpcs3",
    args: (gamePath) => ["--no-gui", gamePath],
  },
};
