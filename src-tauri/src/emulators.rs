//! Emulatoren finden, prüfen und Spiele starten.
//!
//! Befehle: `emulator_find`, `emulator_inspect`, `game_launch`, `game_kill`, `game_running`, `launch_log_tail`
//! und das Ereignis `game-exit`. Früher startete das Frontend Emulatoren über das Shell-Plugin; das scheiterte
//! an dessen Argument-Prüfung und lieferte keine brauchbaren Fehlermeldungen. Jetzt startet Rust den Prozess selbst,
//! liest stdout/stderr mit und meldet Ende, Exit-Code bzw. Signal und die letzten Ausgabezeilen zurück – damit lässt
//! sich ein fehlgeschlagener Start erklären, statt nur "geht nicht" zu sagen.
//!
//! Alles Wesentliche steckt in Funktionen/Typen ohne Tauri-Abhängigkeit (Suchorte, Ereignis-Ausgang und Protokoll
//! sind injizierbar), die Befehle am Ende sind dünne Hüllen. So lässt sich alles mit `cargo test` prüfen.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Eine vergiftete Sperre heißt nur, dass ein anderer Thread abgestürzt ist; die Daten bleiben nutzbar.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ------------------------------------------------------------------------------------------ Zeit */

/// ISO-8601 in UTC mit Millisekunden, z. B. `2026-10-08T12:34:56.789Z` (eigene Formatierung statt chrono).
pub fn iso_timestamp(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = i64::try_from(since.as_secs()).unwrap_or(i64::MAX / 2);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

/// Tage seit 1970-01-01 → (Jahr, Monat, Tag) im gregorianischen Kalender (Algorithmus von Howard Hinnant).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/* ------------------------------------------------------------------------------- Pfade, Programme */

/// `~` und `~/…` zum Benutzerordner auflösen, Schrägstriche am Ende entfernen (außer bei `/`).
fn expand_path(text: &str, home: &Path) -> PathBuf {
    let text = text.trim();
    let expanded = if text == "~" {
        home.to_path_buf()
    } else if let Some(rest) = text.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(text)
    };
    let as_text = expanded.to_string_lossy();
    let trimmed = as_text.trim_end_matches('/');
    if trimmed.is_empty() && !as_text.is_empty() {
        PathBuf::from("/")
    } else if trimmed.len() == as_text.len() {
        expanded
    } else {
        PathBuf::from(trimmed)
    }
}

fn is_app_bundle(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
}

/// Ausführbar = reguläre Datei mit mindestens einem Ausführungsbit (nur Unix; sonst genügt "ist eine Datei").
fn is_executable(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

fn not_found_or(err: &io::Error, what: &str, path: &Path) -> String {
    if err.kind() == io::ErrorKind::NotFound {
        format!("{what} nicht gefunden: {}", path.display())
    } else {
        format!("{what} nicht lesbar: {} ({err})", path.display())
    }
}

/// Angaben aus `Contents/Info.plist` einer `.app`.
#[derive(Debug, Default, Clone)]
struct BundleInfo {
    executable: Option<String>,
    identifier: Option<String>,
    version: Option<String>,
    name: Option<String>,
}

fn read_bundle_info(app: &Path) -> Result<BundleInfo, String> {
    let file = app.join("Contents").join("Info.plist");
    let value =
        plist::Value::from_file(&file).map_err(|err| format!("Info.plist nicht lesbar: {err}"))?;
    let dict = value
        .as_dictionary()
        .ok_or_else(|| "Info.plist hat ein unerwartetes Format".to_string())?;
    let text = |key: &str| {
        dict.get(key)
            .and_then(|value| value.as_string())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Ok(BundleInfo {
        executable: text("CFBundleExecutable"),
        identifier: text("CFBundleIdentifier"),
        version: text("CFBundleShortVersionString").or_else(|| text("CFBundleVersion")),
        name: text("CFBundleDisplayName").or_else(|| text("CFBundleName")),
    })
}

/// Die Programmdatei einer `.app`: `CFBundleExecutable` aus der Info.plist; fehlt die Angabe oder die Datei,
/// zählt die einzige ausführbare Datei in `Contents/MacOS`.
fn resolve_bundle_executable(app: &Path, executable_name: Option<&str>) -> Result<PathBuf, String> {
    let macos_dir = app.join("Contents").join("MacOS");
    if let Some(name) = executable_name.filter(|name| is_plain_file_name(name)) {
        let candidate = macos_dir.join(name);
        match fs::metadata(&candidate) {
            Ok(meta) if is_executable(&meta) => return Ok(candidate),
            Ok(meta) if meta.is_file() => {
                return Err(format!(
                    "Die Programmdatei ist nicht ausführbar (Ausführungsrecht fehlt): {}",
                    candidate.display()
                ));
            }
            _ => {}
        }
    }
    let mut found: Vec<PathBuf> = fs::read_dir(&macos_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| fs::metadata(path).is_ok_and(|meta| is_executable(&meta)))
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!("Keine ausführbare Datei in {}", macos_dir.display())),
        _ => Err(format!(
            "Mehrere ausführbare Dateien in {} und keine eindeutige Angabe (CFBundleExecutable) in der Info.plist",
            macos_dir.display()
        )),
    }
}

/// Ergebnis der Auflösung eines Programms: die Datei, die tatsächlich gestartet wird.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub executable: PathBuf,
}

/// Löst `program` (`.app`-Bundle oder ausführbare Datei) auf; Fehlertexte sind deutsch und konkret.
pub fn resolve_program(program: &str, home: &Path) -> Result<Resolved, String> {
    if program.trim().is_empty() {
        return Err("Kein Programm angegeben".into());
    }
    let path = expand_path(program, home);
    let meta = fs::metadata(&path).map_err(|err| not_found_or(&err, "Programm", &path))?;
    if meta.is_dir() {
        if !is_app_bundle(&path) {
            return Err(format!(
                "Das ist ein Ordner und kein Programm (.app): {}",
                path.display()
            ));
        }
        let info = read_bundle_info(&path).unwrap_or_default();
        let executable = resolve_bundle_executable(&path, info.executable.as_deref())?;
        return Ok(Resolved { executable });
    }
    if is_executable(&meta) {
        Ok(Resolved { executable: path })
    } else {
        Err(format!(
            "Keine ausführbare Datei (Ausführungsrecht fehlt): {}",
            path.display()
        ))
    }
}

/* ---------------------------------------------------------------------------------- emulator_inspect */

/// Ergebnis von `emulator_inspect`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub path: String,
    pub exists: bool,
    /// `"bundle"` (.app), `"file"` oder `"other"`.
    pub kind: &'static str,
    pub executable: Option<String>,
    pub name: Option<String>,
    pub bundle_id: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Prüft einen vom Nutzer gewählten Pfad (siehe Befehl `emulator_inspect`).
pub fn inspect(path_text: &str, home: &Path) -> Inspection {
    let path = expand_path(path_text, home);
    let mut out = Inspection {
        path: path.to_string_lossy().into_owned(),
        exists: false,
        kind: "other",
        executable: None,
        name: None,
        bundle_id: None,
        version: None,
        error: None,
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(err) => {
            out.error = Some(not_found_or(&err, "Pfad", &path));
            return out;
        }
    };
    out.exists = true;
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned());
    if meta.is_dir() {
        if !is_app_bundle(&path) {
            out.error = Some(format!(
                "Das ist ein Ordner und keine Anwendung (.app): {}",
                path.display()
            ));
            return out;
        }
        out.kind = "bundle";
        let info = read_bundle_info(&path);
        let details = info.as_ref().ok().cloned().unwrap_or_default();
        out.name = details.name.clone().or(stem);
        out.bundle_id = details.identifier.clone();
        out.version = details.version.clone();
        match resolve_bundle_executable(&path, details.executable.as_deref()) {
            Ok(executable) => out.executable = Some(executable.to_string_lossy().into_owned()),
            Err(err) => out.error = Some(err),
        }
    } else if meta.is_file() {
        out.kind = "file";
        out.name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        if is_executable(&meta) {
            out.executable = Some(out.path.clone());
        } else {
            out.error = Some(format!(
                "Die Datei ist nicht ausführbar (Ausführungsrecht fehlt): {}",
                path.display()
            ));
        }
    } else {
        out.error = Some(format!(
            "Weder Anwendung noch Programmdatei: {}",
            path.display()
        ));
    }
    out
}

/* ------------------------------------------------------------------------------------- emulator_find */

/// Ein zu suchender Emulator (Teil des Katalogs im Frontend).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorSpec {
    pub id: String,
    /// Regulärer Ausdruck für den Namen der `.app` (ohne Groß-/Kleinschreibung).
    pub app_pattern: String,
    /// Bundle-Identifier für die Spotlight-Suche.
    #[serde(default)]
    pub bundle_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EmulatorMatch {
    pub path: String,
    /// `applications | user-applications | subfolder | spotlight | downloads | desktop`
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EmulatorHits {
    pub id: String,
    pub matches: Vec<EmulatorMatch>,
    /// Nur gesetzt, wenn `appPattern` nicht als regulärer Ausdruck lesbar war (dann gibt es keine Treffer nach Namen,
    /// Spotlight läuft trotzdem). Fehlt sonst in der Antwort.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Liefert zu einem Bundle-Identifier Pfade von `.app`-Bundles (unter macOS per Spotlight).
pub type SpotlightFn<'a> = &'a dyn Fn(&str) -> Vec<PathBuf>;

/// Die Orte, an denen gesucht wird. Für Tests mit eigenen Ordnern belegbar.
#[derive(Debug, Clone, Default)]
pub struct SearchRoots {
    pub applications: Vec<PathBuf>,
    pub user_applications: Vec<PathBuf>,
    pub downloads: Vec<PathBuf>,
    pub desktop: Vec<PathBuf>,
}

impl SearchRoots {
    /// `/Applications`, `~/Applications`, `~/Downloads`, `~/Desktop`.
    pub fn system(home: &Path) -> SearchRoots {
        SearchRoots {
            applications: vec![PathBuf::from("/Applications")],
            user_applications: vec![home.join("Applications")],
            downloads: vec![home.join("Downloads")],
            desktop: vec![home.join("Desktop")],
        }
    }
}

fn is_hidden_or_trash(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("trash")
}

fn in_trash(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name == ".Trash" || name == ".Trashes" || name == "Trash"
        }
        _ => false,
    })
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Die `.app`-Verzeichnisse direkt in `dir`, nach Namen sortiert.
fn list_apps(dir: &Path) -> Vec<PathBuf> {
    let mut apps: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| is_app_bundle(path) && is_dir(path))
                .collect()
        })
        .unwrap_or_default();
    sort_entries(&mut apps);
    apps
}

/// Reihenfolge innerhalb eines Ordners: echte Verzeichnisse vor Symlinks (Duplikate über Symlinks sollen das
/// Original behalten), dann nach Namen ohne Beachtung der Groß-/Kleinschreibung.
fn sort_entries(paths: &mut [PathBuf]) {
    paths.sort_by_cached_key(|path| {
        let is_link = fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink());
        (
            is_link,
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase()),
        )
    });
}

/// Die direkten Unterordner von `dir` (keine `.app`, nichts Verstecktes, kein Papierkorb), nach Namen sortiert.
fn list_subfolders(dir: &Path) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    !is_app_bundle(path) && !is_hidden_or_trash(&name) && is_dir(path)
                })
                .collect()
        })
        .unwrap_or_default();
    sort_entries(&mut folders);
    folders
}

/// In so vielen Unterordnern eines Ordners wird höchstens nachgesehen (ein riesiger Downloads-Ordner soll die Suche nicht bremsen).
const MAX_SUBFOLDERS: usize = 1000;

/// Apps in den direkten Unterordnern von `dir` (nicht in `dir` selbst).
fn apps_in_subfolders(dir: &Path) -> Vec<PathBuf> {
    list_subfolders(dir)
        .iter()
        .take(MAX_SUBFOLDERS)
        .flat_map(|folder| list_apps(folder))
        .collect()
}

/// `Ok(None)` für ein leeres Muster (keine Suche nach Namen), `Err` mit deutschem Text für ein unlesbares.
fn compile_pattern(pattern: &str) -> Result<Option<Regex>, String> {
    if pattern.trim().is_empty() {
        return Ok(None);
    }
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
        .map(Some)
        .map_err(|err| match err {
            regex::Error::CompiledTooBig(_) => {
                "Das Suchmuster (appPattern) ist zu umfangreich".to_string()
            }
            other => format!(
                "Ungültiges Suchmuster (appPattern): {}",
                other
                    .to_string()
                    .lines()
                    .last()
                    .unwrap_or("unlesbar")
                    .trim()
            ),
        })
}

/// Sammelt Treffer ohne Duplikate (auch über Symlinks hinweg), nur existierende `.app`-Verzeichnisse, nie aus dem Papierkorb.
struct HitCollector {
    seen: HashSet<PathBuf>,
    matches: Vec<EmulatorMatch>,
}

impl HitCollector {
    fn add(&mut self, path: &Path, source: &'static str) {
        if !is_app_bundle(path) || !is_dir(path) || in_trash(path) {
            return;
        }
        let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if in_trash(&real) || !self.seen.insert(real) {
            return;
        }
        self.matches.push(EmulatorMatch {
            path: path.to_string_lossy().into_owned(),
            source,
        });
    }
}

/// Sucht `.app`-Bundles der Emulatoren. Reihenfolge der Quellen (= Güte der Treffer): `applications`,
/// `user-applications`, `subfolder` (direkte Unterordner von /Applications und ~/Applications), `spotlight`, `downloads`, `desktop`.
/// `spotlight` liefert zu einem Bundle-Identifier Pfade (unter macOS `mdfind`; sonst `None`).
pub fn find_emulators(
    roots: &SearchRoots,
    spotlight: Option<SpotlightFn<'_>>,
    specs: &[EmulatorSpec],
) -> Vec<EmulatorHits> {
    // Jeden Ordner nur einmal lesen, egal wie viele Emulatoren gesucht werden.
    let applications: Vec<PathBuf> = roots
        .applications
        .iter()
        .flat_map(|root| list_apps(root))
        .collect();
    let user_applications: Vec<PathBuf> = roots
        .user_applications
        .iter()
        .flat_map(|root| list_apps(root))
        .collect();
    let subfolders: Vec<PathBuf> = roots
        .applications
        .iter()
        .chain(&roots.user_applications)
        .flat_map(|root| apps_in_subfolders(root))
        .collect();
    let downloads: Vec<PathBuf> = roots
        .downloads
        .iter()
        .flat_map(|root| list_apps(root).into_iter().chain(apps_in_subfolders(root)))
        .collect();
    let desktop: Vec<PathBuf> = roots
        .desktop
        .iter()
        .flat_map(|root| list_apps(root).into_iter().chain(apps_in_subfolders(root)))
        .collect();

    let name_matches = |regex: &Regex, path: &Path| {
        path.file_name()
            .is_some_and(|name| regex.is_match(&name.to_string_lossy()))
    };

    specs
        .iter()
        .map(|spec| {
            let (regex, error) = match compile_pattern(&spec.app_pattern) {
                Ok(regex) => (regex, None),
                Err(message) => (None, Some(message)),
            };
            let mut hits = HitCollector {
                seen: HashSet::new(),
                matches: Vec::new(),
            };
            let by_name = |hits: &mut HitCollector, paths: &[PathBuf], source: &'static str| {
                if let Some(regex) = &regex {
                    for path in paths.iter().filter(|path| name_matches(regex, path)) {
                        hits.add(path, source);
                    }
                }
            };
            by_name(&mut hits, &applications, "applications");
            by_name(&mut hits, &user_applications, "user-applications");
            by_name(&mut hits, &subfolders, "subfolder");
            if let Some(spotlight) = spotlight {
                for bundle_id in &spec.bundle_ids {
                    for path in spotlight(bundle_id) {
                        hits.add(&path, "spotlight");
                    }
                }
            }
            by_name(&mut hits, &downloads, "downloads");
            by_name(&mut hits, &desktop, "desktop");
            EmulatorHits {
                id: spec.id.clone(),
                matches: hits.matches,
                error,
            }
        })
        .collect()
}

/// Startet `program` ohne Shell und liefert dessen Ausgabe; nach `timeout` wird der Prozess beendet (dann `None`).
pub fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    let reader = thread::Builder::new()
        .name("spotlight-read".into())
        .spawn(move || {
            let mut buffer = Vec::new();
            let _ = stdout.read_to_end(&mut buffer);
            let _ = sender.send(buffer);
        });
    if reader.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    match receiver.recv_timeout(timeout) {
        Ok(buffer) => {
            let _ = child.wait();
            Some(String::from_utf8_lossy(&buffer).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Spotlight-Suche nach einem Bundle-Identifier (nur macOS sinnvoll). Der Identifier wird geprüft, weil er in die
/// Suchanfrage eingesetzt wird; `mdfind` läuft ohne Shell und höchstens `budget` lang.
pub fn spotlight_bundle(bundle_id: &str, budget: Duration) -> Vec<PathBuf> {
    let valid = !bundle_id.is_empty()
        && bundle_id.len() <= 200
        && bundle_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if !valid || budget.is_zero() {
        return Vec::new();
    }
    let query = format!("kMDItemCFBundleIdentifier == '{bundle_id}'");
    run_with_timeout("/usr/bin/mdfind", &[&query], budget)
        .map(|output| {
            output
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Suche an den echten Orten dieses Rechners. Spotlight nur unter macOS und insgesamt höchstens 5 Sekunden.
pub fn find_on_this_machine(home: &Path, specs: &[EmulatorSpec]) -> Vec<EmulatorHits> {
    let roots = SearchRoots::system(home);
    if cfg!(target_os = "macos") {
        let deadline = Instant::now() + Duration::from_secs(5);
        let spotlight = move |bundle_id: &str| {
            spotlight_bundle(
                bundle_id,
                deadline.saturating_duration_since(Instant::now()),
            )
        };
        find_emulators(&roots, Some(&spotlight), specs)
    } else {
        find_emulators(&roots, None, specs)
    }
}

/* ----------------------------------------------------------------------------------------- Protokoll */

/// Das Protokoll wird auf etwa diese Größe begrenzt …
const LOG_MAX_BYTES: u64 = 256 * 1024;
/// … indem beim Überschreiten nur das letzte Stück behalten wird.
const LOG_KEEP_BYTES: usize = 128 * 1024;
const LOG_LINE_MAX_CHARS: usize = 1000;
/// Obergrenze für `launch_log_tail`.
const LOG_TAIL_MAX_LINES: usize = 1000;

/// `launch.log`: eine Zeile pro Ereignis mit ISO-Zeitstempel. Fehler beim Schreiben werden verschluckt –
/// das Protokoll darf einen Start nie verhindern.
pub struct LaunchLog {
    path: PathBuf,
    write: Mutex<()>,
}

impl LaunchLog {
    pub fn new(path: PathBuf) -> LaunchLog {
        LaunchLog {
            path,
            write: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, text: &str) {
        let _guard = lock(&self.write);
        let single_line: String = text
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(LOG_LINE_MAX_CHARS)
            .collect();
        let line = format!("{} {single_line}\n", iso_timestamp(SystemTime::now()));
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        self.trim_for(line.len());
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| file.write_all(line.as_bytes()));
    }

    /// Macht Platz: wird die Datei zu groß, bleibt nur das letzte Stück (ab einem Zeilenanfang).
    fn trim_for(&self, incoming: usize) {
        let Ok(meta) = fs::metadata(&self.path) else {
            return;
        };
        if meta.len() + incoming as u64 <= LOG_MAX_BYTES {
            return;
        }
        let Ok(data) = fs::read(&self.path) else {
            return;
        };
        let mut start = data.len().saturating_sub(LOG_KEEP_BYTES);
        if start > 0 {
            if let Some(newline) = data[start..].iter().position(|byte| *byte == b'\n') {
                start += newline + 1;
            }
        }
        let _ = fs::write(&self.path, &data[start..]);
    }

    /// Die letzten `lines` Zeilen (höchstens 1000).
    pub fn tail(&self, lines: usize) -> Vec<String> {
        let wanted = lines.min(LOG_TAIL_MAX_LINES);
        if wanted == 0 {
            return Vec::new();
        }
        let Ok(mut file) = fs::File::open(&self.path) else {
            return Vec::new();
        };
        let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        let window = 2 * LOG_MAX_BYTES;
        let cut = size > window;
        if cut && file.seek(SeekFrom::Start(size - window)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut all: Vec<&str> = text.lines().collect();
        if cut && !all.is_empty() {
            all.remove(0); // vermutlich mitten in einer Zeile angefangen
        }
        let skip = all.len().saturating_sub(wanted);
        all.into_iter().skip(skip).map(str::to_string).collect()
    }
}

/* ------------------------------------------------------------------------------- Ausgabe mitlesen */

/// So viele Zeilen je Strom (stdout/stderr) bleiben für die Fehlersuche erhalten.
const TAIL_LINES: usize = 40;
const OUTPUT_LINE_MAX_CHARS: usize = 400;
/// Längere Zeilen werden beim Lesen abgeschnitten (schützt vor endlosen Zeilen ohne Zeilenumbruch).
const OUTPUT_LINE_MAX_BYTES: usize = 4096;

/// Entfernt ANSI-Farbcodes und Steuerzeichen und kürzt auf 400 Zeichen. Fortschrittsanzeigen mit `\r` zeigen nur den letzten Stand.
fn clean_output_line(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let visible = text
        .rsplit('\r')
        .find(|part| !part.trim().is_empty())
        .unwrap_or("");
    let mut out = String::with_capacity(visible.len());
    let mut chars = visible.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    // CSI-Folge: bis zum Abschlusszeichen (@ bis ~) überspringen
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                _ => continue,
            }
        } else if c == '\t' {
            out.push(' ');
        } else if !c.is_control() {
            out.push(c);
        }
    }
    let trimmed = out.trim_end();
    if trimmed.chars().count() > OUTPUT_LINE_MAX_CHARS {
        let mut short: String = trimmed.chars().take(OUTPUT_LINE_MAX_CHARS - 1).collect();
        short.push('…');
        short
    } else {
        trimmed.to_string()
    }
}

fn push_tail(tail: &Mutex<VecDeque<String>>, raw: &[u8]) {
    let line = clean_output_line(raw);
    if line.is_empty() {
        return;
    }
    let mut queue = lock(tail);
    if queue.len() >= TAIL_LINES {
        queue.pop_front();
    }
    queue.push_back(line);
}

/// Liest einen Strom bis zum Ende und behält die letzten Zeilen.
fn pump_lines<R: Read>(mut reader: R, tail: &Mutex<VecDeque<String>>) {
    let mut buffer = [0u8; 8192];
    let mut line: Vec<u8> = Vec::new();
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &byte in &buffer[..count] {
            if byte == b'\n' {
                push_tail(tail, &line);
                line.clear();
            } else if line.len() < OUTPUT_LINE_MAX_BYTES {
                line.push(byte);
            }
        }
    }
    if !line.is_empty() {
        push_tail(tail, &line);
    }
}

/* ------------------------------------------------------------------------------------------ Starten */

/// Ereignis `game-exit`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameExit {
    pub id: String,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub stderr_tail: Vec<String>,
    pub stdout_tail: Vec<String>,
    /// Zusatz zum Vertrag: ein deutscher Hinweis auf eine mögliche Ursache (nur bei Absturz/Signal, sonst `null`).
    pub hint: Option<String>,
}

/// Wohin das Ende eines Spiels gemeldet wird. In der App ein Tauri-Ereignis, in Tests ein Kanal.
pub trait ExitSink: Send + Sync + 'static {
    fn game_exited(&self, event: GameExit);
}

impl<F> ExitSink for F
where
    F: Fn(GameExit) + Send + Sync + 'static,
{
    fn game_exited(&self, event: GameExit) {
        self(event)
    }
}

#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub id: String,
    pub program: String,
    pub args: Vec<String>,
    pub label: Option<String>,
}

/// Antwort von `game_launch`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pub id: String,
    pub pid: u32,
    pub executable: String,
    pub command_line: String,
}

/// "Start nicht möglich: <OS-Fehler>" mit einem Hinweis für die häufigsten Ursachen.
fn describe_spawn_error(err: &io::Error) -> String {
    let hint = match err.kind() {
        io::ErrorKind::NotFound => {
            " – die Datei ist da, aber ihr Interpreter oder ein nötiges Ladeprogramm fehlt"
        }
        io::ErrorKind::PermissionDenied => {
            " – Ausführung nicht erlaubt (Dateirechte oder macOS-Sicherheit)"
        }
        _ if cfg!(target_os = "macos") && err.raw_os_error() == Some(86) => {
            " – die App ist für eine andere Prozessorarchitektur gebaut (Intel-App ohne Rosetta 2?)"
        }
        _ => "",
    };
    format!("Start nicht möglich: {err}{hint}")
}

/// Für die Anzeige: Argumente mit Leer- oder Sonderzeichen in Hochkommas setzen.
fn quote_for_display(argument: &str) -> String {
    let plain = !argument.is_empty()
        && argument.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'_' | b'@' | b'%' | b'+' | b'=' | b':' | b',' | b'.' | b'/' | b'-'
                )
        });
    if plain {
        argument.to_string()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        other => return format!("SIG{other}"),
    };
    name.to_string()
}

/// Ein Hinweis auf die wahrscheinliche Ursache, wenn ein Spiel durch ein Signal endet. Bewusst vorsichtig formuliert
/// ("meist", "oft") und nur dort, wo das Signal etwas aussagt. `stopped_by_us`: das Ende wurde mit `game_kill` verlangt.
pub fn exit_hint(
    signal: Option<&str>,
    duration_ms: u64,
    stopped_by_us: bool,
    macos: bool,
) -> Option<String> {
    let signal = signal?;
    if stopped_by_us && matches!(signal, "SIGTERM" | "SIGKILL") {
        return None;
    }
    match signal {
        "SIGKILL" if macos && duration_ms < 15_000 => Some(
            "macOS hat das Programm sofort beendet (SIGKILL). Meist blockiert die Sicherheitsprüfung (Quarantäne oder ungültige Signatur): \
             den Emulator einmal im Finder per Rechtsklick auf „Öffnen“ starten oder im Terminal „xattr -dr com.apple.quarantine <App>“ ausführen."
                .to_string(),
        ),
        "SIGILL" if macos => Some(
            "Das Programm nutzt Prozessorbefehle, die hier nicht verfügbar sind (SIGILL). Auf Apple-Silicon-Macs hilft meist die arm64-Version des Emulators \
             statt der Intel-Version (unter Rosetta 2 fehlen z. B. AVX-Befehle)."
                .to_string(),
        ),
        "SIGSEGV" | "SIGBUS" | "SIGILL" | "SIGABRT" | "SIGTRAP" | "SIGFPE" => Some(format!(
            "Das Programm ist abgestürzt ({signal}). Die letzten Ausgabezeilen nennen oft den Grund, z. B. fehlende Firmware/BIOS, ein beschädigtes Spielabbild oder ein Grafikproblem."
        )),
        _ => None,
    }
}

#[cfg(unix)]
fn signal_of(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(signal_name)
}

#[cfg(not(unix))]
fn signal_of(_status: &ExitStatus) -> Option<String> {
    None
}

#[derive(Clone, Copy)]
enum Stop {
    Term,
    Kill,
}

/// Schickt ein Signal an die ganze Prozessgruppe des Spiels (der Start legt sie mit `process_group(0)` an, die
/// Gruppen-ID ist die Prozess-ID). Emulatoren starten gern Hilfsprozesse; die sollen mit enden.
fn stop_process_group(pid: u32, how: Stop) {
    #[cfg(unix)]
    {
        // pid 0/1 oder negativ würde die eigene Gruppe bzw. init treffen – nie senden.
        let Some(pid) = i32::try_from(pid).ok().filter(|pid| *pid > 1) else {
            return;
        };
        let signal = match how {
            Stop::Term => libc::SIGTERM,
            Stop::Kill => libc::SIGKILL,
        };
        // SAFETY: reine Systemaufrufe ohne Zeiger; pid > 1 ist geprüft.
        unsafe {
            if libc::killpg(pid, signal) != 0 {
                libc::kill(pid, signal);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = how;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

struct RunningGame {
    pid: u32,
    /// Von `game_kill` gesetzt: ein Ende durch SIGTERM/SIGKILL ist dann gewollt und bekommt keinen Hinweis.
    stop_requested: Arc<AtomicBool>,
}

struct Inner {
    running: Mutex<HashMap<String, RunningGame>>,
    log: LaunchLog,
    /// So lange darf ein Spiel nach SIGTERM noch aufräumen, bevor SIGKILL kommt.
    kill_grace: Duration,
}

/// Verwaltet die laufenden Spiele. Wird als Tauri-State abgelegt und ist billig zu klonen.
#[derive(Clone)]
pub struct GameProcesses {
    inner: Arc<Inner>,
}

/// So lange warten die Leser-Threads nach Prozessende auf das Ende der Pipes (Enkelprozesse könnten sie offen halten).
const READER_GRACE: Duration = Duration::from_millis(800);

impl GameProcesses {
    pub fn new(log_path: PathBuf) -> GameProcesses {
        GameProcesses::with_kill_grace(log_path, Duration::from_secs(3))
    }

    pub fn with_kill_grace(log_path: PathBuf, kill_grace: Duration) -> GameProcesses {
        GameProcesses {
            inner: Arc::new(Inner {
                running: Mutex::new(HashMap::new()),
                log: LaunchLog::new(log_path),
                kill_grace,
            }),
        }
    }

    pub fn log(&self) -> &LaunchLog {
        &self.inner.log
    }

    /// IDs der laufenden Spiele (sortiert).
    pub fn running(&self) -> Vec<String> {
        let mut ids: Vec<String> = lock(&self.inner.running).keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn is_running(&self, id: &str) -> bool {
        lock(&self.inner.running).contains_key(id)
    }

    /// Startet ein Spiel (siehe Befehl `game_launch`). Jeder Fehler wird auch ins Protokoll geschrieben.
    pub fn launch(
        &self,
        request: &LaunchRequest,
        home: &Path,
        sink: Arc<dyn ExitSink>,
    ) -> Result<LaunchInfo, String> {
        let result = self.launch_inner(request, home, sink);
        if let Err(message) = &result {
            self.inner
                .log
                .append(&format!("FEHLER id={} {message}", request.id));
        }
        result
    }

    fn launch_inner(
        &self,
        request: &LaunchRequest,
        home: &Path,
        sink: Arc<dyn ExitSink>,
    ) -> Result<LaunchInfo, String> {
        let id = request.id.trim();
        if id.is_empty() {
            return Err("Keine Spiel-ID angegeben".into());
        }
        let name = request
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .unwrap_or(id);
        let resolved = resolve_program(&request.program, home)?;

        let mut command = Command::new(&resolved.executable);
        command
            .args(&request.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Neutrales Arbeitsverzeichnis: nicht das der App (Entwicklungsordner, "/" bei Finder-Start …).
        if is_dir(home) {
            command.current_dir(home);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Eigene Prozessgruppe: Strg+C im Terminal der App trifft das Spiel nicht, und game_kill erreicht Hilfsprozesse.
            command.process_group(0);
            // SAFETY: Im Kindprozess zwischen fork und exec sind nur async-signal-sichere Aufrufe erlaubt; signal() ist einer.
            // Hintergrund: Rust setzt SIGPIPE für Kindprozesse auf "beenden zurück". Schließt die App (und damit die Pipes),
            // würde ein Emulator beim nächsten Schreiben auf stderr sofort sterben. Mit "ignorieren" bekommt er nur einen Schreibfehler.
            unsafe {
                command.pre_exec(|| {
                    libc::signal(libc::SIGPIPE, libc::SIG_IGN);
                    Ok(())
                });
            }
        }

        let executable = resolved.executable.to_string_lossy().into_owned();
        let command_line = std::iter::once(executable.as_str())
            .chain(request.args.iter().map(String::as_str))
            .map(quote_for_display)
            .collect::<Vec<_>>()
            .join(" ");

        let started = Instant::now();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let mut child = {
            // Prüfen und eintragen unter einer Sperre: zwei gleichzeitige Starts derselben ID können sich nicht überholen.
            let mut running = lock(&self.inner.running);
            if running.contains_key(id) {
                return Err(format!("„{name}“ läuft bereits"));
            }
            let child = command.spawn().map_err(|err| describe_spawn_error(&err))?;
            running.insert(
                id.to_string(),
                RunningGame {
                    pid: child.id(),
                    stop_requested: Arc::clone(&stop_requested),
                },
            );
            child
        };
        let pid = child.id();
        // Vor den Überwachungs-Threads protokollieren, sonst könnte ein sofort endendes Spiel "ENDE" vor "START" schreiben.
        self.inner
            .log
            .append(&format!("START id={id} pid={pid} {command_line}"));
        let abort =
            |this: &GameProcesses, child: &mut std::process::Child, message: String| -> String {
                stop_process_group(pid, Stop::Kill);
                let _ = child.kill();
                let _ = child.wait();
                lock(&this.inner.running).remove(id);
                format!("Start nicht möglich: {message}")
            };

        let stdout_tail = Arc::new(Mutex::new(VecDeque::new()));
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let (done_sender, done_receiver) = mpsc::channel::<()>();
        let mut readers = 0usize;
        for (stream, tail, label) in [
            (
                child
                    .stdout
                    .take()
                    .map(|s| Box::new(s) as Box<dyn Read + Send>),
                Arc::clone(&stdout_tail),
                "stdout",
            ),
            (
                child
                    .stderr
                    .take()
                    .map(|s| Box::new(s) as Box<dyn Read + Send>),
                Arc::clone(&stderr_tail),
                "stderr",
            ),
        ] {
            let Some(stream) = stream else { continue };
            let sender = done_sender.clone();
            let spawned = thread::Builder::new()
                .name(format!("game-{label}"))
                .spawn(move || {
                    pump_lines(stream, &tail);
                    let _ = sender.send(());
                });
            match spawned {
                Ok(_) => readers += 1,
                Err(err) => {
                    return Err(abort(
                        self,
                        &mut child,
                        format!("Thread für die Ausgabe nicht startbar ({err})"),
                    ))
                }
            }
        }
        drop(done_sender);

        let inner = Arc::clone(&self.inner);
        let game_id = id.to_string();
        let waiter = thread::Builder::new()
            .name("game-wait".into())
            .spawn(move || {
                let status = child.wait();
                // Die Leser auslaufen lassen, damit auch die letzten Zeilen im Ereignis landen.
                let deadline = Instant::now() + READER_GRACE;
                for _ in 0..readers {
                    if done_receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .is_err()
                    {
                        break;
                    }
                }
                let duration = started.elapsed();
                // Erst austragen, dann melden: wer das Ereignis erhält, darf sofort neu starten.
                {
                    let mut running = lock(&inner.running);
                    if running.get(&game_id).is_some_and(|game| game.pid == pid) {
                        running.remove(&game_id);
                    }
                }
                let mut stderr_lines: Vec<String> = lock(&stderr_tail).iter().cloned().collect();
                let (code, signal) = match &status {
                    Ok(status) => (status.code(), signal_of(status)),
                    Err(err) => {
                        stderr_lines.push(format!("Warten auf den Prozess fehlgeschlagen: {err}"));
                        (None, None)
                    }
                };
                let duration_ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
                let hint = exit_hint(
                    signal.as_deref(),
                    duration_ms,
                    stop_requested.load(Ordering::SeqCst),
                    cfg!(target_os = "macos"),
                );
                let event = GameExit {
                    id: game_id,
                    code,
                    signal,
                    duration_ms,
                    stderr_tail: stderr_lines,
                    stdout_tail: lock(&stdout_tail).iter().cloned().collect(),
                    hint,
                };
                inner.log_exit(&event);
                sink.game_exited(event);
            });
        if let Err(err) = waiter {
            // Das Kind gehört jetzt dem verworfenen Thread; die Gruppe beenden, damit nichts unbeobachtet weiterläuft.
            stop_process_group(pid, Stop::Kill);
            lock(&self.inner.running).remove(id);
            return Err(format!(
                "Start nicht möglich: Thread zum Überwachen nicht startbar ({err})"
            ));
        }

        Ok(LaunchInfo {
            id: id.to_string(),
            pid,
            executable,
            command_line,
        })
    }

    /// Beendet ein Spiel: SIGTERM an die Prozessgruppe, nach der Gnadenfrist (3 s) SIGKILL. `false`, wenn nichts mit dieser ID läuft.
    pub fn kill(&self, id: &str) -> bool {
        let Some((pid, stop_requested)) = lock(&self.inner.running)
            .get(id)
            .map(|game| (game.pid, Arc::clone(&game.stop_requested)))
        else {
            return false;
        };
        // Ab jetzt gilt ein Ende durch SIGTERM/SIGKILL als gewollt (kein Hinweis auf einen Absturz).
        stop_requested.store(true, Ordering::SeqCst);
        self.inner
            .log
            .append(&format!("BEENDEN id={id} pid={pid} (SIGTERM)"));
        stop_process_group(pid, Stop::Term);
        let inner = Arc::clone(&self.inner);
        let game_id = id.to_string();
        let _ = thread::Builder::new()
            .name("game-kill".into())
            .spawn(move || {
                thread::sleep(inner.kill_grace);
                let still_running = lock(&inner.running)
                    .get(&game_id)
                    .is_some_and(|game| game.pid == pid);
                if still_running {
                    inner.log.append(&format!(
                        "BEENDEN id={game_id} pid={pid} (SIGKILL nach {} ms)",
                        inner.kill_grace.as_millis()
                    ));
                    stop_process_group(pid, Stop::Kill);
                }
            });
        true
    }
}

impl Inner {
    fn log_exit(&self, event: &GameExit) {
        let how = match (&event.signal, event.code) {
            (Some(signal), _) => format!("signal={signal}"),
            (None, Some(code)) => format!("code={code}"),
            (None, None) => "code=?".to_string(),
        };
        self.log.append(&format!(
            "ENDE id={} {how} dauer={}ms",
            event.id, event.duration_ms
        ));
        if let Some(hint) = &event.hint {
            self.log.append(&format!("HINWEIS id={} {hint}", event.id));
        }
        // Bei auffälligem Ende (Fehlercode, Signal) die letzten Ausgaben mitschreiben – das ist meist die Erklärung.
        if event.signal.is_some() || event.code != Some(0) {
            let last = |lines: &[String], n: usize| lines[lines.len().saturating_sub(n)..].to_vec();
            for line in last(&event.stderr_tail, 20) {
                self.log.append(&format!("STDERR id={} | {line}", event.id));
            }
            for line in last(&event.stdout_tail, 10) {
                self.log.append(&format!("STDOUT id={} | {line}", event.id));
            }
        }
    }
}

/* ---------------------------------------------------------------------------------- Tauri-Befehle */

fn home_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Legt den Speicher für laufende Spiele an; das Protokoll liegt als `launch.log` im App-Log-Ordner.
pub fn init_state<R: Runtime>(app: &AppHandle<R>) -> GameProcesses {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("JellyStation"));
    GameProcesses::new(dir.join("launch.log"))
}

/// Sucht `.app`-Bundles der Emulatoren (siehe [`find_emulators`]).
#[tauri::command]
pub async fn emulator_find<R: Runtime>(
    app: AppHandle<R>,
    specs: Vec<EmulatorSpec>,
) -> Result<Vec<EmulatorHits>, String> {
    let home = home_dir(&app);
    tauri::async_runtime::spawn_blocking(move || find_on_this_machine(&home, &specs))
        .await
        .map_err(|err| format!("Suche abgebrochen: {err}"))
}

/// Prüft einen vom Nutzer gewählten Pfad (siehe [`inspect`]).
#[tauri::command]
pub async fn emulator_inspect<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<Inspection, String> {
    let home = home_dir(&app);
    tauri::async_runtime::spawn_blocking(move || inspect(&path, &home))
        .await
        .map_err(|err| format!("Prüfung abgebrochen: {err}"))
}

/// Startet `program` (`.app` oder ausführbare Datei) mit `args` als eigenen Prozess; das Ende kommt als Ereignis `game-exit`.
#[tauri::command]
pub async fn game_launch<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, GameProcesses>,
    id: String,
    program: String,
    args: Option<Vec<String>>,
    label: Option<String>,
) -> Result<LaunchInfo, String> {
    let home = home_dir(&app);
    let processes = state.inner().clone();
    let request = LaunchRequest {
        id,
        program,
        args: args.unwrap_or_default(),
        label,
    };
    let emitter = app.clone();
    let sink: Arc<dyn ExitSink> = Arc::new(move |event: GameExit| {
        let _ = emitter.emit("game-exit", event);
    });
    tauri::async_runtime::spawn_blocking(move || processes.launch(&request, &home, sink))
        .await
        .map_err(|err| format!("Start abgebrochen: {err}"))?
}

/// Beendet ein laufendes Spiel (SIGTERM, nach 3 s SIGKILL). `true`, wenn eines mit dieser ID lief.
#[tauri::command]
pub async fn game_kill(state: State<'_, GameProcesses>, id: String) -> Result<bool, String> {
    Ok(state.kill(&id))
}

/// IDs der laufenden Spiele.
#[tauri::command]
pub async fn game_running(state: State<'_, GameProcesses>) -> Result<Vec<String>, String> {
    Ok(state.running())
}

/// Die letzten `lines` Zeilen von `launch.log`.
#[tauri::command]
pub async fn launch_log_tail(
    state: State<'_, GameProcesses>,
    lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let processes = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || processes.log().tail(lines.unwrap_or(50)))
        .await
        .map_err(|err| format!("Protokoll nicht lesbar: {err}"))
}

#[cfg(all(test, unix))]
mod tests;
