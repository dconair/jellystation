#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Externe Programme (Emulatoren) starten – Rechte: capabilities/emulators.json
        .plugin(tauri_plugin_shell::init())
        // Ordner auflisten / Dateien prüfen – Rechte: capabilities/library.json
        .plugin(tauri_plugin_fs::init())
        // Merkt sich per Dialog gewählte Ordner auch nach einem Neustart (fs-Scope)
        .plugin(tauri_plugin_persisted_scope::init())
        // Dauerhafte Einstellungen (settings.json im App-Datenordner)
        .plugin(tauri_plugin_store::Builder::new().build())
        // Native Datei-/Ordnerdialoge
        .plugin(tauri_plugin_dialog::init())
        // Jellyfin-Server ohne CORS-/ATS-Hürden ansprechen – Rechte: capabilities/jellyfin.json
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri-Anwendung");
}
