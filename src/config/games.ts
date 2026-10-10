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
export const GAME_EXTENSIONS = [
  "iso", "app", "pkg", "cue", "chd", "bin", "elf",
  // weitere Abbild-Formate der unterstützten Emulatoren; welcher Emulator zu welchem Systemordner gehört,
  // steht in src/emulators/catalog.ts
  "cso", "pbp", "m3u", "rvz", "wbfs", "gcm", "ciso", "dol", "gcz", "wia",
] as const;
