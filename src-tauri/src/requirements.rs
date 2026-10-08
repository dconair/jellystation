//! BIOS- und Firmware-Dateien der Emulatoren finden und (auf Wunsch) in den Emulator übernehmen.
//!
//! Die App liefert und lädt solche Dateien nie herunter: Sie prüft nur, ob sie im BIOS-Ordner des Nutzers oder schon
//! im Datenordner des Emulators liegen, und kopiert eine vom Nutzer bereitgestellte Datei auf Wunsch dorthin.

use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

/// Mehr Einträge pro Ordner werden nicht angesehen (ein Spiele- statt BIOS-Ordner soll die Suche nicht lahmlegen).
const MAX_ENTRIES: usize = 3000;
/// Größte Datei, die `bios_copy` übernimmt (die PS3-Firmware ist etwa 200 MB groß).
const MAX_COPY_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// "emulator" (Datenordner des Emulators) oder "folder" (BIOS-Ordner des Nutzers).
    pub kind: String,
    pub dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementSpec {
    pub id: String,
    pub locations: Vec<Location>,
    /// Regulärer Ausdruck für den Dateinamen (ohne Groß-/Kleinschreibung); fehlt er, zählt nur `markers`.
    pub name_regex: Option<String>,
    #[serde(default)]
    pub min_size: u64,
    /// 0 = keine Obergrenze.
    #[serde(default)]
    pub max_size: u64,
    /// Pfade relativ zum Ordner, die existieren müssen (z. B. "sys/external/liblv2.sprx").
    #[serde(default)]
    pub markers: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: String,
    pub dir: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct RequirementResult {
    pub id: String,
    pub found: Vec<Found>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// "~" und "~/…" durch den Benutzerordner ersetzen.
pub fn expand(path: &str) -> PathBuf {
    if path == "~" {
        return home().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home() {
            return h.join(rest);
        }
    }
    PathBuf::from(path)
}

fn has_parent_component(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

/// Eine Anforderung gegen ihre Orte prüfen. Ohne Treffer ist `found` leer.
pub fn scan(spec: &RequirementSpec) -> Result<Vec<Found>, String> {
    let re = match &spec.name_regex {
        Some(r) => Some(
            RegexBuilder::new(r)
                .case_insensitive(true)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| format!("Ungültiges Dateimuster für {}: {e}", spec.id))?,
        ),
        None => None,
    };
    let mut found = Vec::new();
    for loc in &spec.locations {
        let dir = expand(&loc.dir);
        if has_parent_component(&dir) || !dir.is_dir() {
            continue;
        }
        for marker in &spec.markers {
            let rel = Path::new(marker);
            if rel.is_absolute() || has_parent_component(rel) {
                continue;
            }
            let p = dir.join(rel);
            if let Ok(meta) = fs::metadata(&p) {
                if meta.is_file() {
                    found.push(Found {
                        kind: loc.kind.clone(),
                        dir: dir.to_string_lossy().into_owned(),
                        path: p.to_string_lossy().into_owned(),
                        size: meta.len(),
                    });
                }
            }
        }
        if let Some(re) = &re {
            // Der Ordner selbst und (beim BIOS-Ordner) eine Ebene darunter, z. B. BIOS/PS2/scph10000.bin.
            let mut dirs = vec![dir.clone()];
            if loc.kind == "folder" {
                if let Ok(rd) = fs::read_dir(&dir) {
                    for e in rd.flatten().take(MAX_ENTRIES) {
                        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            dirs.push(e.path());
                        }
                    }
                }
            }
            for d in dirs {
                let Ok(rd) = fs::read_dir(&d) else { continue };
                for e in rd.flatten().take(MAX_ENTRIES) {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') || !re.is_match(&name) {
                        continue;
                    }
                    let Ok(meta) = e.metadata() else { continue };
                    if !meta.is_file() {
                        continue;
                    }
                    let size = meta.len();
                    if size < spec.min_size || (spec.max_size > 0 && size > spec.max_size) {
                        continue;
                    }
                    found.push(Found {
                        kind: loc.kind.clone(),
                        dir: dir.to_string_lossy().into_owned(),
                        path: e.path().to_string_lossy().into_owned(),
                        size,
                    });
                }
            }
        }
    }
    Ok(found)
}

#[tauri::command]
pub async fn requirements_scan(
    specs: Vec<RequirementSpec>,
) -> Result<Vec<RequirementResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specs
            .iter()
            .map(|s| {
                scan(s).map(|found| RequirementResult {
                    id: s.id.clone(),
                    found,
                })
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|e| format!("Die Suche nach BIOS-Dateien ist abgebrochen worden ({e})"))?
}

/// Kopiert eine vom Nutzer bereitgestellte Datei in den Datenordner eines Emulators. Ziel muss im Benutzerordner
/// liegen; eine vorhandene Datei wird nicht überschrieben. Rückgabe: Pfad der Kopie.
pub fn copy_into(from: &str, to_dir: &str) -> Result<String, String> {
    let from = expand(from);
    let to_dir = expand(to_dir);
    let h = home().ok_or("Der Benutzerordner ist unbekannt")?;
    if has_parent_component(&to_dir)
        || has_parent_component(&from)
        || !to_dir.starts_with(&h)
        || to_dir == h
    {
        return Err("Der Zielordner liegt außerhalb des Benutzerordners".into());
    }
    let meta =
        fs::metadata(&from).map_err(|e| format!("Die Datei lässt sich nicht lesen ({e})"))?;
    if !meta.is_file() {
        return Err("Das ist keine Datei".into());
    }
    if meta.len() > MAX_COPY_BYTES {
        return Err("Die Datei ist größer als erwartet – bitte von Hand kopieren".into());
    }
    let name = from.file_name().ok_or("Die Datei hat keinen Namen")?;
    fs::create_dir_all(&to_dir)
        .map_err(|e| format!("Der Zielordner lässt sich nicht anlegen ({e})"))?;
    let dest = to_dir.join(name);
    if dest.exists() {
        return Err(format!("{} liegt dort schon", name.to_string_lossy()));
    }
    fs::copy(&from, &dest).map_err(|e| format!("Kopieren fehlgeschlagen ({e})"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn bios_copy(from: String, to_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || copy_into(&from, &to_dir))
        .await
        .map_err(|e| format!("Das Kopieren ist abgebrochen worden ({e})"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("js-req-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn spec(dir: &Path, kind: &str, re: Option<&str>, min: u64, max: u64) -> RequirementSpec {
        RequirementSpec {
            id: "t".into(),
            locations: vec![Location {
                kind: kind.into(),
                dir: dir.to_string_lossy().into_owned(),
            }],
            name_regex: re.map(String::from),
            min_size: min,
            max_size: max,
            markers: vec![],
        }
    }

    #[test]
    fn finds_by_name_and_size_and_looks_one_level_deeper_in_user_folder() {
        let d = tmp("size");
        fs::create_dir_all(d.join("PS1")).unwrap();
        fs::write(d.join("PS1/SCPH1001.BIN"), vec![0u8; 512]).unwrap();
        fs::write(d.join("zu_klein.bin"), vec![0u8; 10]).unwrap();
        fs::write(d.join(".versteckt.bin"), vec![0u8; 512]).unwrap();
        let found = scan(&spec(&d, "folder", Some(r"\.bin$"), 512, 512)).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("SCPH1001.BIN"));
        // Im Emulator-Ordner wird nicht in Unterordner geschaut.
        let found = scan(&spec(&d, "emulator", Some(r"\.bin$"), 512, 512)).unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn finds_marker_files() {
        let d = tmp("marker");
        fs::create_dir_all(d.join("sys/external")).unwrap();
        fs::write(d.join("sys/external/liblv2.sprx"), b"x").unwrap();
        let mut s = spec(&d, "emulator", None, 0, 0);
        s.markers = vec!["sys/external/liblv2.sprx".into(), "../etc/passwd".into()];
        let found = scan(&s).unwrap();
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn rejects_bad_regex_and_missing_dirs() {
        let d = tmp("bad");
        assert!(scan(&spec(&d, "folder", Some("("), 0, 0)).is_err());
        assert!(
            scan(&spec(&d.join("gibt-es-nicht"), "folder", Some("x"), 0, 0))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn copy_stays_inside_home_and_never_overwrites() {
        let h = tmp("home");
        std::env::set_var("HOME", &h);
        let src = h.join("BIOS");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("scph.bin"), b"abc").unwrap();
        let dest = copy_into(
            src.join("scph.bin").to_str().unwrap(),
            "~/Library/Application Support/X/bios",
        )
        .unwrap();
        assert!(dest.ends_with("X/bios/scph.bin"));
        assert_eq!(fs::read(&dest).unwrap(), b"abc");
        assert!(copy_into(
            src.join("scph.bin").to_str().unwrap(),
            "~/Library/Application Support/X/bios"
        )
        .is_err());
        assert!(copy_into(src.join("scph.bin").to_str().unwrap(), "/tmp").is_err());
        assert!(copy_into(src.join("scph.bin").to_str().unwrap(), "~/../x").is_err());
        assert!(copy_into(src.to_str().unwrap(), "~/Library/y").is_err());
    }
}
