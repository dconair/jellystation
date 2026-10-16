//! Selbstreparatur vor dem Start eines PS3-Spiels in RPCS3.
//!
//! Befehl: `rpcs3_prepare`. Er liest nur und legt höchstens kleine Schlüsseldateien ab:
//!
//! - **Datenordner von RPCS3** bestimmen (so wie RPCS3 selbst, `fs::get_config_dir`): ein Ordner `portable` neben der
//!   Programmdatei, sonst unter Windows die Umgebungsvariable `RPCS3_CONFIG_DIR` bzw. der Ordner der `rpcs3.exe`,
//!   unter macOS `~/Library/Application Support/rpcs3`, sonst `~/.config/rpcs3`. Daran erkennt die App sicher, ob die
//!   Firmware eingespielt ist (`dev_flash/sys/external/liblv2.sprx`).
//! - **Disc-Schlüssel** (`.dkey`/`.key`, 16 oder 32 Byte) für eine verschlüsselte `.iso`: RPCS3 sucht sie neben dem
//!   Abbild unter dem Namen des Abbilds und in `<Datenordner>/data/redump/` (alle Dateien dort werden probiert,
//!   `Loader/ISO.cpp`). Liegt kein passender Schlüssel neben dem Abbild, kopiert die App die Schlüssel, die der Nutzer
//!   selbst neben das Spiel oder in den BIOS-Ordner gelegt hat, dorthin. Nichts wird überschrieben, nichts geladen.
//! - **Firmware-Datei** (`PS3UPDAT.PUP`) im BIOS-Ordner finden, damit die App sie mit `rpcs3 --installfw` einspielen kann.
//!
//! BIOS, Firmware und Schlüssel bringt weiterhin der Nutzer mit; hier wird nur verschoben, was er selbst abgelegt hat.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::requirements::expand;

/// Ein Disc-Schlüssel ist 16 Byte (binär) oder 32 Zeichen (Hex) groß.
const KEY_SIZES: [u64; 2] = [16, 32];
/// Höchstens so viele Schlüsseldateien werden kopiert, wenn keine zum Namen des Abbilds passt.
const MAX_KEYS_COPIED: usize = 200;
/// Höchstens so viele Einträge je Ordner werden angesehen.
const MAX_ENTRIES: usize = 5000;
/// Die PS3-Firmware ist rund 200 MB groß.
const MIN_PUP_BYTES: u64 = 50 * 1024 * 1024;
/// Kennung am Anfang einer PS3-Update-Datei.
const PUP_MAGIC: &[u8] = b"SCEUF";

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rpcs3Prep {
    /// Datenordner von RPCS3 (Einstellungen, `dev_flash`, `data/redump`, unter Windows auch `log`).
    pub config_dir: Option<String>,
    /// `dev_flash/sys/external/liblv2.sprx` liegt im Datenordner – die Firmware ist eingespielt.
    pub firmware_installed: bool,
    /// Das Spiel ist eine `.iso`-Datei.
    pub is_iso: bool,
    /// Neben der `.iso` liegt schon ein Schlüssel mit ihrem Namen – RPCS3 findet ihn selbst.
    pub key_next_to_game: bool,
    /// Pfade der Schlüsseldateien, die jetzt in `data/redump` kopiert wurden.
    pub keys_copied: Vec<String>,
    /// Warum Schlüssel nicht kopiert werden konnten (z. B. keine Schreibrechte).
    pub keys_error: Option<String>,
    /// Eine brauchbare `PS3UPDAT.PUP` im BIOS-Ordner.
    pub pup: Option<String>,
}

fn has_parent_component(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

fn home_dir() -> Option<PathBuf> {
    let (first, second) = if cfg!(windows) { ("USERPROFILE", "HOME") } else { ("HOME", "USERPROFILE") };
    std::env::var_os(first).or_else(|| std::env::var_os(second)).map(PathBuf::from)
}

/// Ordner der Programmdatei; bei einer macOS-`.app` (dort liegt kein `portable` daneben) `None`.
fn exe_dir_of(app: &Path) -> Option<PathBuf> {
    let is_bundle = app.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"));
    if is_bundle {
        return None;
    }
    app.parent().filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf)
}

/// Datenordner von RPCS3 wie `fs::get_config_dir`. Die Umgebung wird übergeben, damit sich das prüfen lässt.
fn config_dir_in(exe_dir: Option<&Path>, home: Option<&Path>, xdg_config: Option<PathBuf>, env_override: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = exe_dir {
        let portable = dir.join("portable");
        if portable.is_dir() {
            return Some(portable);
        }
    }
    if cfg!(windows) {
        if let Some(dir) = env_override.filter(|p| !p.as_os_str().is_empty()) {
            return Some(dir);
        }
        return exe_dir.map(Path::to_path_buf);
    }
    if cfg!(target_os = "macos") {
        return home.map(|h| h.join("Library/Application Support/rpcs3"));
    }
    let base = xdg_config.filter(|p| !p.as_os_str().is_empty()).or_else(|| home.map(|h| h.join(".config")))?;
    Some(base.join("rpcs3"))
}

fn config_dir(app: &Path) -> Option<PathBuf> {
    config_dir_in(
        exe_dir_of(app).as_deref(),
        home_dir().as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("RPCS3_CONFIG_DIR").map(PathBuf::from),
    )
}

fn has_ext(p: &Path, exts: &[&str]) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// Dateien (und die eine Ebene darunter) eines Ordners, die `keep` annimmt.
fn files_in(dir: &Path, keep: &dyn Fn(&Path, u64) -> bool) -> Vec<PathBuf> {
    let mut dirs = vec![dir.to_path_buf()];
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten().take(MAX_ENTRIES) {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                dirs.push(e.path());
            }
        }
    }
    let mut out = Vec::new();
    for d in dirs {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten().take(MAX_ENTRIES) {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_file() && keep(&p, meta.len()) {
                out.push(p);
            }
        }
    }
    out
}

fn is_key_file(p: &Path, size: u64) -> bool {
    has_ext(p, &["dkey", "key"]) && KEY_SIZES.contains(&size)
}

/// Schlüssel neben dem Abbild oder im BIOS-Ordner in `key_dir` ablegen, falls RPCS3 sie sonst nicht fände.
/// Rückgabe: (Schlüssel liegt schon neben dem Abbild, kopierte Dateien, Fehlertext).
fn place_keys(game: &Path, extra_dirs: &[PathBuf], key_dir: &Path) -> (bool, Vec<String>, Option<String>) {
    for ext in ["dkey", "key"] {
        if game.with_extension(ext).is_file() {
            return (true, Vec::new(), None);
        }
    }
    let stem = game.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = game.parent() {
        dirs.push(parent.to_path_buf());
    }
    dirs.extend(extra_dirs.iter().cloned());

    let mut found: Vec<PathBuf> = Vec::new();
    for d in &dirs {
        for p in files_in(d, &is_key_file) {
            if !found.contains(&p) {
                found.push(p);
            }
        }
    }
    if found.is_empty() {
        return (false, Vec::new(), None);
    }
    // Ein Schlüssel mit dem Namen des Abbilds gewinnt; sonst alle (RPCS3 probiert jeden gegen das Abbild).
    let named: Vec<PathBuf> = found
        .iter()
        .filter(|p| p.file_stem().is_some_and(|s| s.to_string_lossy().to_lowercase() == stem))
        .cloned()
        .collect();
    let chosen = if named.is_empty() { found.into_iter().take(MAX_KEYS_COPIED).collect() } else { named };

    if let Err(e) = fs::create_dir_all(key_dir) {
        return (false, Vec::new(), Some(format!("Der Schlüsselordner von RPCS3 lässt sich nicht anlegen ({e})")));
    }
    let mut copied = Vec::new();
    for p in chosen {
        let Some(name) = p.file_name() else { continue };
        let dest = key_dir.join(name);
        if dest.exists() {
            continue;
        }
        match fs::copy(&p, &dest) {
            Ok(_) => copied.push(dest.to_string_lossy().into_owned()),
            Err(e) => return (false, copied, Some(format!("Der Schlüssel {} ließ sich nicht kopieren ({e})", name.to_string_lossy()))),
        }
    }
    (false, copied, None)
}

fn looks_like_pup(p: &Path) -> bool {
    let mut head = [0u8; 5];
    fs::File::open(p).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head == PUP_MAGIC
}

/// Die neueste brauchbare Firmware-Datei (`.pup`, Kopf „SCEUF“) in den Ordnern und eine Ebene darunter.
fn find_pup(dirs: &[PathBuf], min_size: u64) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for d in dirs {
        for p in files_in(d, &|p, size| has_ext(p, &["pup"]) && size >= min_size) {
            if !looks_like_pup(&p) {
                continue;
            }
            let modified = fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().map(|(t, _)| modified >= *t).unwrap_or(true) {
                best = Some((modified, p));
            }
        }
    }
    best.map(|(_, p)| p)
}

fn prepare(game: &Path, extra_dirs: &[PathBuf], config: Option<PathBuf>, min_pup: u64) -> Rpcs3Prep {
    let mut prep = Rpcs3Prep::default();
    if let Some(cfg) = &config {
        prep.config_dir = Some(cfg.to_string_lossy().into_owned());
        prep.firmware_installed = cfg.join("dev_flash/sys/external/liblv2.sprx").is_file();
    }
    prep.is_iso = game.is_file() && has_ext(game, &["iso"]);
    if prep.is_iso {
        match &config {
            Some(cfg) => {
                let (next, copied, error) = place_keys(game, extra_dirs, &cfg.join("data/redump"));
                prep.key_next_to_game = next;
                prep.keys_copied = copied;
                prep.keys_error = error;
            }
            None => prep.keys_error = Some("Der Datenordner von RPCS3 ist nicht bekannt".into()),
        }
    }
    if !prep.firmware_installed {
        prep.pup = find_pup(extra_dirs, min_pup).map(|p| p.to_string_lossy().into_owned());
    }
    prep
}

/// Bereitet den Start eines PS3-Spiels vor (siehe Moduldoku). `app_path` ist die Programmdatei bzw. `.app` von RPCS3,
/// `game_path` das Spiel, `extra_dirs` enthält den BIOS-Ordner der App.
#[tauri::command]
pub async fn rpcs3_prepare(app_path: String, game_path: String, extra_dirs: Vec<String>) -> Result<Rpcs3Prep, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = expand(&app_path);
        let game = expand(&game_path);
        let extra: Vec<PathBuf> = extra_dirs.iter().map(|d| expand(d)).collect();
        if [&app, &game].into_iter().chain(extra.iter()).any(|p| has_parent_component(p)) {
            return Err("Ungültiger Pfad".to_string());
        }
        Ok(prepare(&game, &extra, config_dir(&app), MIN_PUP_BYTES))
    })
    .await
    .map_err(|e| format!("Die Vorbereitung für RPCS3 ist abgebrochen worden ({e})"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("jellystation-rpcs3-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn portable_folder_wins_for_the_config_dir() {
        let exe = tmp("portable");
        fs::create_dir_all(exe.join("portable")).unwrap();
        let got = config_dir_in(Some(&exe), Some(Path::new("/home/u")), None, None);
        assert_eq!(got, Some(exe.join("portable")));
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_config_dir_follows_xdg_then_home() {
        let exe = tmp("nolocal");
        assert_eq!(config_dir_in(Some(&exe), Some(Path::new("/home/u")), None, None), Some(PathBuf::from("/home/u/.config/rpcs3")));
        assert_eq!(
            config_dir_in(Some(&exe), Some(Path::new("/home/u")), Some(PathBuf::from("/x")), None),
            Some(PathBuf::from("/x/rpcs3"))
        );
        assert_eq!(config_dir_in(None, None, None, None), None);
    }

    #[test]
    fn app_bundles_have_no_exe_dir() {
        assert_eq!(exe_dir_of(Path::new("/Applications/RPCS3.app")), None);
        assert_eq!(exe_dir_of(Path::new("/opt/rpcs3/rpcs3")), Some(PathBuf::from("/opt/rpcs3")));
    }

    #[test]
    fn copies_a_key_from_the_games_folder_without_overwriting() {
        let root = tmp("keys");
        let games = root.join("games");
        let cfg = root.join("cfg");
        fs::create_dir_all(&games).unwrap();
        let iso = games.join("Gran Turismo 5.iso");
        fs::write(&iso, b"x").unwrap();
        // Schlüssel mit anderem Namen, dazu ein zu großer Fremdling
        fs::write(games.join("redump-123.dkey"), [7u8; 32]).unwrap();
        fs::write(games.join("notes.key"), vec![1u8; 500]).unwrap();

        let prep = prepare(&iso, &[], Some(cfg.clone()), 1);
        assert!(prep.is_iso && !prep.key_next_to_game);
        assert_eq!(prep.keys_copied.len(), 1);
        assert!(cfg.join("data/redump/redump-123.dkey").is_file());
        assert!(!cfg.join("data/redump/notes.key").exists());

        // zweiter Lauf: nichts mehr zu tun
        let again = prepare(&iso, &[], Some(cfg), 1);
        assert!(again.keys_copied.is_empty() && again.keys_error.is_none());
    }

    #[test]
    fn a_key_with_the_games_name_is_left_alone_and_preferred() {
        let root = tmp("named");
        let games = root.join("games");
        let bios = root.join("bios");
        let cfg = root.join("cfg");
        fs::create_dir_all(&games).unwrap();
        fs::create_dir_all(&bios).unwrap();
        let iso = games.join("Spiel.ISO");
        fs::write(&iso, b"x").unwrap();
        fs::write(games.join("Spiel.dkey"), [1u8; 16]).unwrap();
        let prep = prepare(&iso, &[bios.clone()], Some(cfg.clone()), 1);
        assert!(prep.key_next_to_game && prep.keys_copied.is_empty());

        // Ohne Schlüssel neben dem Abbild: der gleichnamige im BIOS-Ordner gewinnt gegen den anderen.
        fs::remove_file(games.join("Spiel.dkey")).unwrap();
        fs::write(bios.join("spiel.dkey"), [2u8; 32]).unwrap();
        fs::write(bios.join("anderes.dkey"), [3u8; 32]).unwrap();
        let prep = prepare(&iso, &[bios], Some(cfg.clone()), 1);
        assert_eq!(prep.keys_copied.len(), 1);
        assert!(cfg.join("data/redump/spiel.dkey").is_file());
        assert!(!cfg.join("data/redump/anderes.dkey").exists());
    }

    #[test]
    fn folders_need_no_keys_and_firmware_marker_is_checked() {
        let root = tmp("fw");
        let cfg = root.join("cfg");
        let game = root.join("game");
        fs::create_dir_all(game.join("PS3_GAME")).unwrap();
        let prep = prepare(&game, &[], Some(cfg.clone()), 1);
        assert!(!prep.is_iso && !prep.firmware_installed && prep.keys_copied.is_empty());

        fs::create_dir_all(cfg.join("dev_flash/sys/external")).unwrap();
        fs::write(cfg.join("dev_flash/sys/external/liblv2.sprx"), b"x").unwrap();
        assert!(prepare(&game, &[], Some(cfg), 1).firmware_installed);
    }

    #[test]
    fn finds_the_newest_real_pup_only() {
        let root = tmp("pup");
        let bios = root.join("bios");
        fs::create_dir_all(bios.join("PS3")).unwrap();
        fs::write(bios.join("falsch.pup"), b"<html>nope").unwrap();
        fs::write(bios.join("PS3/PS3UPDAT.PUP"), b"SCEUF-rest-of-the-file").unwrap();
        let got = find_pup(&[bios.clone()], 1).unwrap();
        assert!(got.ends_with("PS3UPDAT.PUP"));
        // zu klein für die echte Mindestgröße
        assert!(find_pup(&[bios], MIN_PUP_BYTES).is_none());
    }
}
