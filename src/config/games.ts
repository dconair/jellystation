/**
 * Zentrale Konfiguration der Spielebibliothek.
 *
 * ┌─ Echten Ordner einrichten ────────────────────────────────────────────────┐
 * │ 1. GAMES_BASE_DIR unten auf den echten Pfad setzen.                       │
 * │ 2. Denselben Pfad in src-tauri/capabilities/library.json eintragen        │
 * │    (fs-Scope, dort als "$HOME/…" geschrieben).                            │
 * │ 3. Struktur:  <GAMES_BASE_DIR>/<System>/<Spiel>.<Endung>                  │
 * │    z. B.      ~/JellyStation/Games/PS3/Gran Turismo 5.iso                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 * Existiert der Ordner nicht (oder läuft die App nur im Browser), zeigt die XMB
 * automatisch Demo-Daten (siehe src/library/mockLibrary.ts).
 */

/** Basisordner der Bibliothek. "~" wird zum Home-Verzeichnis aufgelöst. PLATZHALTER! */
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
  /** Kommandozeilenargumente zum Starten einer Spieldatei. */
  args: (gamePath: string) => string[];
}

/** Zuordnung System-Ordnername (klein geschrieben) → Emulator. */
export const EMULATORS: Record<string, EmulatorConfig> = {
  ps3: {
    name: "RPCS3",
    command: "rpcs3",
    args: (gamePath) => ["--no-gui", gamePath],
  },
};
