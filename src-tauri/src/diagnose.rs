//! Bausteine der Diagnose („Probleme finden und beheben“): Dateien lesend prüfen, das Protokoll eines Emulators
//! einsehen und – als einzige Änderung – die macOS-Quarantäne einer Emulator-App aufheben.
//!
//! Alles hier liest nur. Es werden nie Dateien verschoben, gelöscht oder verändert; die Auswertung (was die Befunde
//! bedeuten und was man dagegen tut) steht im Frontend (`src/diagnose/`).

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::requirements::expand;

/// Mehr Pfade pro Aufruf werden nicht geprüft.
const MAX_PATHS: usize = 2000;
/// So viele Anfangsbytes liefert die Prüfung als Hex-Text (genug für Kennungen wie „SCEUF“ oder „PK“).
const HEAD_BYTES: usize = 16;
/// So viele Namen eines Ordners werden mitgeliefert.
const MAX_NAMES: usize = 60;
/// Eine .cue/.m3u wird nur bis hierhin gelesen und höchstens so viele Verweise werden geprüft.
const MAX_LIST_BYTES: u64 = 1024 * 1024;
const MAX_REFS: usize = 64;
/// Vom Protokoll eines Emulators wird höchstens das Ende gelesen.
const MAX_LOG_BYTES: u64 = 192 * 1024;
const MAX_LOG_LINES: usize = 400;
const MAX_LOG_LINE_CHARS: usize = 400;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefProbe {
    pub name: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    /// Datei: lässt sich öffnen; Ordner: lässt sich auflisten.
    pub readable: bool,
    pub size: u64,
    /// Erste Bytes einer Datei als Hex-Text („53434555460000“), sonst leer.
    pub head_hex: String,
    /// Ordner: Namen der Einträge (höchstens 60).
    pub names: Vec<String>,
    /// Zu einer .cue/.m3u: die genannten Dateien und ob sie neben der Liste liegen.
    pub refs: Vec<RefProbe>,
    /// Nur macOS und nur bei einer .app: trägt das Paket die Quarantäne-Markierung?
    pub quarantined: bool,
    pub error: Option<String>,
}

impl FileProbe {
    fn empty(path: &str) -> Self {
        FileProbe {
            path: path.to_string(),
            exists: false,
            is_dir: false,
            is_file: false,
            readable: false,
            size: 0,
            head_hex: String::new(),
            names: Vec::new(),
            refs: Vec::new(),
            quarantined: false,
            error: None,
        }
    }
}

fn has_parent_component(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Dateinamen aus einer .cue (`FILE "x.bin" BINARY`) oder .m3u (eine Datei je Zeile, `#` = Kommentar).
pub fn parse_refs(ext: &str, text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        let name = match ext {
            "cue" => {
                let upper = line.get(..5).map(|s| s.to_ascii_uppercase());
                if upper.as_deref() != Some("FILE ") {
                    continue;
                }
                let rest = line[5..].trim_start();
                if let Some(after) = rest.strip_prefix('"') {
                    match after.find('"') {
                        Some(end) => after[..end].to_string(),
                        None => continue,
                    }
                } else {
                    rest.split_whitespace().next().unwrap_or("").to_string()
                }
            }
            "m3u" | "m3u8" => {
                if line.starts_with('#') {
                    continue;
                }
                line.to_string()
            }
            _ => continue,
        };
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
        if out.len() >= MAX_REFS {
            break;
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn is_quarantined(path: &Path) -> bool {
    // `xattr -p` endet mit Fehler, wenn das Attribut fehlt. Ohne Shell, Ausgabe wird verworfen.
    std::process::Command::new("/usr/bin/xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_quarantined(_path: &Path) -> bool {
    false
}

fn is_app(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("app"))
        .unwrap_or(false)
}

/// Prüft einen Pfad, ohne etwas zu verändern.
pub fn probe(path_text: &str) -> FileProbe {
    let mut out = FileProbe::empty(path_text);
    let path = expand(path_text);
    if path_text.trim().is_empty() || has_parent_component(&path) {
        out.error = Some("Ungültiger Pfad".into());
        return out;
    }
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                // Vorhanden, aber nicht lesbar (z. B. fehlendes Recht auf den Ordner).
                out.error = Some(e.to_string());
            }
            return out;
        }
    };
    out.exists = true;
    out.is_dir = meta.is_dir();
    out.is_file = meta.is_file();
    out.size = if meta.is_file() { meta.len() } else { 0 };

    if meta.is_dir() {
        match fs::read_dir(&path) {
            Ok(rd) => {
                out.readable = true;
                let mut names: Vec<String> = rd
                    .flatten()
                    .take(MAX_NAMES * 4)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                names.truncate(MAX_NAMES);
                out.names = names;
            }
            Err(e) => out.error = Some(e.to_string()),
        }
        if is_app(&path) {
            out.quarantined = is_quarantined(&path);
        }
        return out;
    }
    if !meta.is_file() {
        return out;
    }

    match File::open(&path) {
        Ok(mut f) => {
            out.readable = true;
            let mut head = [0u8; HEAD_BYTES];
            let mut got = 0;
            // Ein Lesefehler mitten in der Datei (kaputter Datenträger) soll sichtbar werden.
            loop {
                match f.read(&mut head[got..]) {
                    Ok(0) => break,
                    Ok(n) => {
                        got += n;
                        if got == HEAD_BYTES {
                            break;
                        }
                    }
                    Err(e) => {
                        out.readable = false;
                        out.error = Some(e.to_string());
                        break;
                    }
                }
            }
            out.head_hex = hex(&head[..got]);
        }
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    }

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "cue" | "m3u" | "m3u8") && out.readable {
        if let Ok(f) = File::open(&path) {
            let mut text = String::new();
            let mut buf = Vec::new();
            if f.take(MAX_LIST_BYTES).read_to_end(&mut buf).is_ok() {
                text.push_str(&String::from_utf8_lossy(&buf));
            }
            let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
            for name in parse_refs(&ext, &text) {
                // Verweise mit „..“ oder absoluten Pfaden werden nicht verfolgt; sie zählen als vorhanden.
                let rel = Path::new(&name);
                let exists = if rel.is_absolute() || has_parent_component(rel) {
                    true
                } else {
                    base.join(rel).is_file()
                };
                out.refs.push(RefProbe { name, exists });
            }
        }
    }
    out
}

#[tauri::command]
pub async fn diag_probe(paths: Vec<String>) -> Result<Vec<FileProbe>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .take(MAX_PATHS)
            .map(|p| probe(p))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("Die Prüfung ist abgebrochen worden ({e})"))
}

/* ------------------------------------------------------------------------------------------ Protokoll */

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    pub path: String,
    /// Änderungszeit in Millisekunden seit 1970 (0 = unbekannt).
    pub modified_ms: u64,
    pub lines: Vec<String>,
}

/// Entfernt Steuerzeichen und ANSI-Farbcodes und kürzt lange Zeilen.
fn clean_line(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
        } else if c == '\t' {
            out.push(' ');
        } else if !c.is_control() {
            out.push(c);
        }
    }
    let t = out.trim_end();
    if t.chars().count() > MAX_LOG_LINE_CHARS {
        let mut s: String = t.chars().take(MAX_LOG_LINE_CHARS - 1).collect();
        s.push('…');
        s
    } else {
        t.to_string()
    }
}

/// Die letzten `lines` Zeilen einer Datei (liest höchstens 192 KB vom Ende).
pub fn tail_file(path: &Path, lines: usize) -> std::io::Result<Vec<String>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(MAX_LOG_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(MAX_LOG_BYTES).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut all: Vec<&str> = text.lines().collect();
    if start > 0 && !all.is_empty() {
        all.remove(0); // erste Zeile ist vermutlich angeschnitten
    }
    let want = lines.clamp(1, MAX_LOG_LINES);
    let from = all.len().saturating_sub(want);
    Ok(all[from..]
        .iter()
        .map(|l| clean_line(l))
        .filter(|l| !l.is_empty())
        .collect())
}

/// Aus den Kandidaten die zuletzt geänderte Protokolldatei im Benutzerordner wählen und deren Ende liefern.
pub fn newest_log(candidates: &[String], lines: usize, home: Option<&Path>) -> Option<LogTail> {
    let mut best: Option<(u64, PathBuf)> = None;
    for c in candidates {
        let p = expand(c);
        if has_parent_component(&p) {
            continue;
        }
        if let Some(h) = home {
            if !p.starts_with(h) {
                continue;
            }
        }
        let Ok(meta) = fs::metadata(&p) else { continue };
        if !meta.is_file() {
            continue;
        }
        let ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if best.as_ref().map(|(b, _)| ms >= *b).unwrap_or(true) {
            best = Some((ms, p));
        }
    }
    let (ms, p) = best?;
    let tail = tail_file(&p, lines).ok()?;
    Some(LogTail {
        path: p.to_string_lossy().into_owned(),
        modified_ms: ms,
        lines: tail,
    })
}

#[tauri::command]
pub async fn diag_log_tail(candidates: Vec<String>, lines: Option<usize>) -> Option<LogTail> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        newest_log(&candidates, lines.unwrap_or(120), home.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/* ------------------------------------------------------------------------------------------ Quarantäne */

/// Hebt die Quarantäne-Markierung einer Emulator-App auf (`xattr -dr com.apple.quarantine`). Nur für ein
/// vorhandenes `.app`-Paket; sonst wird nichts angefasst.
pub fn clear_quarantine_of(path_text: &str) -> Result<(), String> {
    let path = expand(path_text);
    if has_parent_component(&path) || !path.is_absolute() {
        return Err("Ungültiger Pfad".into());
    }
    if !is_app(&path) || !path.is_dir() {
        return Err("Das ist kein Programmpaket (.app)".into());
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&path)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("xattr lässt sich nicht starten ({e})"))?;
        if out.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!(
                "Die Quarantäne ließ sich nicht aufheben: {}",
                err.trim()
            ))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Die Quarantäne gibt es nur unter macOS".into())
    }
}

#[tauri::command]
pub async fn diag_clear_quarantine(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clear_quarantine_of(&path))
        .await
        .map_err(|e| format!("Der Vorgang ist abgebrochen worden ({e})"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("js-diag-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_cue_and_m3u_references() {
        let cue = "\u{feff}FILE \"Spiel (Track 1).bin\" BINARY\n  TRACK 01 MODE2/2352\nfile Track2.bin BINARY\nFILE \"Spiel (Track 1).bin\" BINARY\n";
        assert_eq!(
            parse_refs("cue", cue),
            vec!["Spiel (Track 1).bin".to_string(), "Track2.bin".to_string()]
        );
        let m3u = "#EXTM3U\nDisc1.chd\n\n# Kommentar\nDisc2.chd\n";
        assert_eq!(
            parse_refs("m3u", m3u),
            vec!["Disc1.chd".to_string(), "Disc2.chd".to_string()]
        );
        assert!(parse_refs("iso", "FILE x").is_empty());
    }

    #[test]
    fn probes_files_folders_and_missing_paths() {
        let d = tmp("probe");
        fs::write(d.join("firmware.pup"), b"SCEUF\0\0\0rest").unwrap();
        fs::write(d.join("leer.bin"), b"").unwrap();
        fs::create_dir_all(d.join("PS3_GAME")).unwrap();

        let p = probe(d.join("firmware.pup").to_str().unwrap());
        assert!(p.exists && p.is_file && p.readable);
        assert_eq!(p.size, 12);
        assert!(p.head_hex.starts_with("5343455546"));

        let e = probe(d.join("leer.bin").to_str().unwrap());
        assert!(e.exists && e.size == 0 && e.head_hex.is_empty());

        let f = probe(d.to_str().unwrap());
        assert!(f.is_dir && f.readable);
        assert!(f.names.contains(&"PS3_GAME".to_string()));

        let m = probe(d.join("gibt-es-nicht.iso").to_str().unwrap());
        assert!(!m.exists && m.error.is_none());

        assert!(probe("").error.is_some());
        assert!(probe("/tmp/../etc").error.is_some());
    }

    #[test]
    fn cue_probe_reports_missing_tracks() {
        let d = tmp("cue");
        fs::write(
            d.join("spiel.cue"),
            "FILE \"spiel (Track 1).bin\" BINARY\nFILE \"spiel (Track 2).bin\" BINARY\n",
        )
        .unwrap();
        fs::write(d.join("spiel (Track 1).bin"), b"x").unwrap();
        let p = probe(d.join("spiel.cue").to_str().unwrap());
        assert_eq!(
            p.refs,
            vec![
                RefProbe { name: "spiel (Track 1).bin".into(), exists: true },
                RefProbe { name: "spiel (Track 2).bin".into(), exists: false },
            ]
        );
    }

    #[test]
    fn tails_the_newest_log_inside_home() {
        let h = tmp("log");
        let old = h.join("alt.log");
        let new = h.join("neu.log");
        fs::write(&old, "alt\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let body: String = (1..=300).map(|i| format!("Zeile {i}\n")).collect();
        fs::write(&new, format!("\u{1b}[31mrot\u{1b}[0m\n{body}")).unwrap();

        let c = vec![
            old.to_string_lossy().into_owned(),
            new.to_string_lossy().into_owned(),
            h.join("fehlt.log").to_string_lossy().into_owned(),
            "/etc/hosts".to_string(),
        ];
        let tail = newest_log(&c, 5, Some(&h)).unwrap();
        assert!(tail.path.ends_with("neu.log"));
        assert_eq!(tail.lines.len(), 5);
        assert_eq!(tail.lines.last().unwrap(), "Zeile 300");
        // außerhalb des Benutzerordners wird nichts gelesen
        assert!(newest_log(&["/etc/hosts".to_string()], 5, Some(&h)).is_none());
        // ANSI-Codes verschwinden
        let all = newest_log(&c, 400, Some(&h)).unwrap();
        assert_eq!(all.lines[0], "rot");
    }

    #[test]
    fn quarantine_only_touches_app_bundles() {
        let d = tmp("quar");
        fs::write(d.join("datei.txt"), b"x").unwrap();
        assert!(clear_quarantine_of(d.join("datei.txt").to_str().unwrap()).is_err());
        assert!(clear_quarantine_of(d.join("fehlt.app").to_str().unwrap()).is_err());
        assert!(clear_quarantine_of("relativ/App.app").is_err());
        assert!(clear_quarantine_of("/Applications/../etc/X.app").is_err());
    }
}
