pub mod emulators;
pub mod media_proxy;

#[cfg(test)]
mod config_tests;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Webseiten öffnen und Homebrew-Installation (brew install --cask) – Rechte: capabilities/default.json
        // und capabilities/emulators.json; erlaubte Adressen für open(): plugins.shell.open in tauri.conf.json.
        // Spiele starten NICHT über dieses Plugin, sondern über den Befehl game_launch (emulators.rs).
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
        // Lokaler Medien-Proxy für <video>/hls.js (Anmeldung, http im LAN) – media_proxy.rs
        .manage(media_proxy::MediaProxy::default())
        .setup(|app| {
            // Laufende Spiele und launch.log (App-Log-Ordner) – emulators.rs
            let processes = emulators::init_state(app.handle());
            app.manage(processes);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media_proxy::media_proxy_start,
            media_proxy::media_proxy_stop,
            emulators::emulator_find,
            emulators::emulator_inspect,
            emulators::game_launch,
            emulators::game_kill,
            emulators::game_running,
            emulators::launch_log_tail,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri-Anwendung");
}
