#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Externe Programme (Emulatoren) starten – Rechte: capabilities/emulators.json
        .plugin(tauri_plugin_shell::init())
        // Spielebibliothek einlesen – Rechte: capabilities/library.json
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri-Anwendung");
}
