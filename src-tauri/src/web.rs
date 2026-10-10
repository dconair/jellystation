//! Web-Bereich: Seiten in einem eigenen App-Fenster öffnen und Downloads in den Spiele-Ordner legen.
//!
//! Das Fenster lädt Fremdseiten und bekommt deshalb KEINEN Zugriff auf Tauri-Befehle (keine Capability für sein Label).
//! Downloads landen in `<Spiele-Ordner>/Downloads`; die Oberfläche fragt danach, in welches System sie gehören
//! (`game_import`). Es wird nichts automatisch geladen oder entpackt.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::requirements::expand;

const WINDOW_LABEL: &str = "web";
const MAX_NAME: usize = 150;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPayload {
    pub name: String,
    pub path: Option<String>,
    /// "started" | "done" | "failed"
    pub state: &'static str,
}

/// Macht aus dem vom Server vorgeschlagenen Namen einen harmlosen Dateinamen (nur der letzte Teil, keine Steuerzeichen).
pub fn safe_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let mut name: String = trimmed.chars().take(MAX_NAME).collect();
    if name.is_empty() {
        name = "download".into();
    }
    name
}

/// `name`, sonst `name (2)`, `name (3)` … – überschreibt nie eine vorhandene Datei.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem} (neu){ext}"))
}

fn valid_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Das ist keine gültige Webadresse".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().map(str::is_empty).unwrap_or(true)
    {
        return Err("Es sind nur Adressen mit http:// oder https:// erlaubt".into());
    }
    Ok(url)
}

/// Öffnet `url` im App-Fenster „web“ (oder lädt sie dort, falls es schon offen ist).
#[tauri::command]
pub async fn web_open(
    app: AppHandle,
    url: String,
    title: Option<String>,
    download_dir: String,
) -> Result<(), String> {
    let url = valid_url(&url)?;
    let dir = expand(&download_dir);
    if dir.components().any(|c| matches!(c, Component::ParentDir)) || !dir.is_absolute() {
        return Err("Der Download-Ordner ist ungültig".into());
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Der Download-Ordner lässt sich nicht anlegen ({e})"))?;

    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        win.navigate(url)
            .map_err(|e| format!("Die Seite lässt sich nicht öffnen ({e})"))?;
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let pending: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
    let emitter = app.clone();
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "JellyStation – Web".into());
    let download_target = dir.clone();
    let mut builder = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url));
    // Eigenes Profil: Unter Linux teilen sich Fenster sonst einen WebContext, und nur der Download-Handler des ersten
    // Fensters käme zum Zug. Nebenbei bleiben Cookies der Fremdseiten getrennt von der App.
    #[cfg(not(target_os = "macos"))]
    if let Ok(cache) = app.path().app_cache_dir() {
        builder = builder.data_directory(cache.join("web-profile"));
    }
    builder
        .title(title)
        .inner_size(1180.0, 780.0)
        .min_inner_size(640.0, 420.0)
        .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about" | "blob"))
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let proposed = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let name = safe_name(&proposed);
                    let target = unique_path(&download_target, &name);
                    *destination = target.clone();
                    if let Ok(mut map) = pending.lock() {
                        map.insert(url.to_string(), target.clone());
                    }
                    let _ = emitter.emit(
                        "web-download",
                        DownloadPayload {
                            name: file_name_of(&target),
                            path: None,
                            state: "started",
                        },
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    // Unter macOS ist `path` immer leer – deshalb merkt sich `Requested` das Ziel.
                    let remembered = pending
                        .lock()
                        .ok()
                        .and_then(|mut m| m.remove(&url.to_string()));
                    let target = path.or(remembered);
                    let name = target
                        .as_deref()
                        .map(file_name_of)
                        .unwrap_or_else(|| "Download".into());
                    let ok = success && target.as_ref().map(|p| p.is_file()).unwrap_or(false);
                    let _ = emitter.emit(
                        "web-download",
                        DownloadPayload {
                            name,
                            path: if ok {
                                target.map(|p| p.to_string_lossy().into_owned())
                            } else {
                                None
                            },
                            state: if ok { "done" } else { "failed" },
                        },
                    );
                }
                _ => {}
            }
            true
        })
        .build()
        .map_err(|e| format!("Das Web-Fenster lässt sich nicht öffnen ({e})"))?;
    Ok(())
}

fn file_name_of(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Schließt das Web-Fenster, falls offen.
#[tauri::command]
pub async fn web_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn valid_system(system: &str) -> bool {
    !system.is_empty()
        && system.len() <= 32
        && !system.starts_with('.')
        && system
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
}

/// Verschiebt eine heruntergeladene Datei aus `<Spiele-Ordner>/Downloads` in `<Spiele-Ordner>/<System>/`.
pub fn import_into(from: &str, games_dir: &str, system: &str) -> Result<String, String> {
    if !valid_system(system) {
        return Err("Ungültiger Systemname".into());
    }
    let base = fs::canonicalize(expand(games_dir))
        .map_err(|e| format!("Der Spiele-Ordner ist nicht lesbar ({e})"))?;
    let downloads = base.join("Downloads");
    let src =
        fs::canonicalize(expand(from)).map_err(|e| format!("Die Datei ist nicht mehr da ({e})"))?;
    if src.parent() != fs::canonicalize(&downloads).ok().as_deref() || !src.is_file() {
        return Err("Nur Dateien aus dem Download-Ordner lassen sich übernehmen".into());
    }
    let name = safe_name(&file_name_of(&src));
    let dest_dir = base.join(system);
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Der System-Ordner lässt sich nicht anlegen ({e})"))?;
    let dest = unique_path(&dest_dir, &name);
    if fs::rename(&src, &dest).is_err() {
        // Anderes Laufwerk: kopieren, dann erst das Original entfernen.
        fs::copy(&src, &dest).map_err(|e| format!("Verschieben fehlgeschlagen ({e})"))?;
        let _ = fs::remove_file(&src);
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn game_import(
    from: String,
    games_dir: String,
    system: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || import_into(&from, &games_dir, &system))
        .await
        .map_err(|e| format!("Das Verschieben ist abgebrochen worden ({e})"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("js-web-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn safe_names_drop_paths_and_junk() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\x\\spiel.iso"), "spiel.iso");
        assert_eq!(safe_name("  .hidden "), "hidden");
        assert_eq!(safe_name("a:b*c?.iso"), "abc.iso");
        assert_eq!(safe_name(""), "download");
        assert!(safe_name(&"x".repeat(400)).len() <= MAX_NAME);
    }

    #[test]
    fn unique_paths_never_overwrite() {
        let d = tmp("uniq");
        fs::write(d.join("a.iso"), b"1").unwrap();
        assert_eq!(unique_path(&d, "a.iso"), d.join("a (2).iso"));
        fs::write(d.join("a (2).iso"), b"2").unwrap();
        assert_eq!(unique_path(&d, "a.iso"), d.join("a (3).iso"));
        assert_eq!(unique_path(&d, "neu.iso"), d.join("neu.iso"));
    }

    #[test]
    fn only_http_urls_are_allowed() {
        assert!(valid_url("https://example.org/x").is_ok());
        assert!(valid_url("http://127.0.0.1:8080").is_ok());
        assert!(valid_url("file:///etc/passwd").is_err());
        assert!(valid_url("javascript:alert(1)").is_err());
        assert!(valid_url("data:text/html,x").is_err());
        assert!(valid_url("kein url").is_err());
    }

    #[test]
    fn import_moves_only_from_downloads_into_a_clean_system_folder() {
        let base = tmp("imp");
        fs::create_dir_all(base.join("Downloads")).unwrap();
        fs::write(base.join("Downloads/Spiel.iso"), b"x").unwrap();
        fs::write(base.join("draussen.iso"), b"y").unwrap();
        let b = base.to_str().unwrap();
        let moved =
            import_into(base.join("Downloads/Spiel.iso").to_str().unwrap(), b, "PS2").unwrap();
        assert!(moved.ends_with("PS2/Spiel.iso"));
        assert!(!base.join("Downloads/Spiel.iso").exists());
        assert!(import_into(base.join("draussen.iso").to_str().unwrap(), b, "PS2").is_err());
        fs::write(base.join("Downloads/B.iso"), b"x").unwrap();
        assert!(import_into(base.join("Downloads/B.iso").to_str().unwrap(), b, "../x").is_err());
        assert!(import_into(base.join("Downloads/B.iso").to_str().unwrap(), b, "").is_err());
        assert!(import_into(
            base.join("Downloads/B.iso").to_str().unwrap(),
            b,
            ".versteckt"
        )
        .is_err());
        assert!(import_into(
            base.join("Downloads/../draussen.iso").to_str().unwrap(),
            b,
            "PS2"
        )
        .is_err());
    }
}
