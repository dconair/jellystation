/**
 * Zentrale Konfiguration der Spielebibliothek.
 *
 * Der echte Spiele-Ordner wird im Setup-Assistenten per Ordnerdialog gewählt und im
 * Tauri-Store gespeichert (src/settings). GAMES_BASE_DIR ist nur der Standardwert,
 * falls (noch) nichts gewählt wurde.
 *
 * Der Ordner ist ein einziger Sammelordner: Spiele (ISO, CHD, CUE/BIN, Spieleordner …) liegen darin
 * unsortiert, auch in beliebigen Unterordnern. Das System erkennt der Rust-Befehl `games_scan`
 * (src-tauri/src/library.rs) am Inhalt, an der Seriennummer, am Dateiformat oder am Ordnernamen; welche
 * Dateiendungen als Spiel gelten, steht ebenfalls dort. Welcher Emulator zu welchem System gehört,
 * steht in src/emulators/catalog.ts.
 *
 * Existiert der Ordner nicht (oder läuft die App nur im Browser), zeigt die XMB
 * automatisch Demo-Daten (siehe src/library/mockLibrary.ts).
 */

/** Standard-Basisordner der Bibliothek. "~" wird zum Home-Verzeichnis aufgelöst. */
export const GAMES_BASE_DIR = "~/JellyStation/Games";
