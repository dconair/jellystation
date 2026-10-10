//! Dateien herunterladen (mit Fortschritt, Fortsetzen und Abbrechen), prüfen und Emulator-Archive einspielen.
//!
//! Verwendet für drei Dinge in „Einrichtung & Downloads“: Emulatoren aus den GitHub-Releases der Projekte,
//! Firmware von einer offiziellen Hersteller-Adresse und Spiele von Adressen, die der Nutzer selbst einträgt.
//! Die App bringt keine Download-Quellen für Spiele, BIOS oder Firmware mit.
//!
//! Sicherheitsregeln: nur https (http nur, wenn der Aufrufer es für eine selbst eingetragene Adresse erlaubt),
//! Weiterleitungen nur auf erlaubte Server und nie von https zu http, Dateinamen werden bereinigt (kein Pfad,
//! keine Windows-Sonderzeichen), vorhandene Dateien werden nie überschrieben, Archive werden nur mit den
//! Bordmitteln des Systems entpackt (`ditto`/`hdiutil`, `tar`, `unzip`) – es kommen keine neuen Pakete hinzu.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use regex::RegexBuilder;
use reqwest::header::{
    CONTENT_DISPOSITION, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::hashing;

/// Text des Fehlers, wenn der Nutzer abbricht (das Frontend vergleicht darauf nicht, es kennt seinen eigenen Abbruch).
pub const CANCELLED: &str = "Der Download wurde abgebrochen";
/// Ohne ein einziges Byte so lange wartet der Download, bevor er als hängend gilt.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const PROGRESS_EVERY: Duration = Duration::from_millis(200);
const MAX_REDIRECTS: usize = 5;
/// Endungen, die der Spiele-Download nie ablegt (Programme gehören nicht in den Spiele-Ordner).
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jar", "sh", "command", "app", "dmg", "pkg_installer", "lnk",
];

#[derive(Default)]
pub struct Downloads {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    /// Kennung des Vorgangs (für Fortschritt und Abbruch), z. B. "game-3".
    pub id: String,
    pub url: String,
    /// Zielordner; `~` steht für den Benutzerordner. Wird angelegt.
    pub dest_dir: String,
    /// Wunschname; fehlt er, gilt der Name aus der Antwort (Content-Disposition) bzw. aus der Adresse.
    pub file_name: Option<String>,
    /// Erwartete SHA-256-Prüfsumme (Hex); stimmt sie nicht, wird die Datei verworfen.
    pub sha256: Option<String>,
    /// Erlaubte Server (`github.com`, `*.githubusercontent.com`); leer = nur der Server der Adresse.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    /// true = auch http (nur für Adressen, die der Nutzer selbst eingetragen hat, z. B. im Heimnetz).
    #[serde(default)]
    pub allow_http: bool,
    /// true = Programmdateien (.exe, .sh, …) nicht ablegen.
    #[serde(default)]
    pub block_executables: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// true = ein früher begonnener Download wurde fortgesetzt.
    pub resumed: bool,
    /// true = die Datei lag schon vollständig im Zielordner (nichts geladen).
    pub already_present: bool,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub received: u64,
    pub total: Option<u64>,
    /// "starting" | "running" | "verifying" | "done" | "failed" | "cancelled"
    pub state: &'static str,
    pub message: Option<String>,
    /// Pfad der unfertigen Datei (`.part`), solange sie existiert.
    pub part_path: Option<String>,
}

/* ---------------------------------------------------------------- Hilfsfunktionen */

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `~`, `~/x` und `~\x` werden zum Benutzerordner; alles andere bleibt unverändert.
pub fn expand_home(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(trimmed));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// `*.beispiel.de` trifft Unterserver (nicht `beispiel.de` selbst), sonst muss der Name gleich sein (ohne Groß-/Kleinschreibung).
pub fn host_allowed(host: &str, patterns: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    patterns.iter().any(|p| {
        let p = p.trim().to_ascii_lowercase();
        match p.strip_prefix("*.") {
            Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
            None => !p.is_empty() && host == p,
        }
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(v) = input.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3",
    "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Macht aus beliebigem Text einen sicheren einzelnen Dateinamen (nie leer, ohne Pfadanteile).
pub fn sanitize_file_name(raw: &str) -> String {
    // Nur der letzte Pfadteil zählt.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let mut name: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\') {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name.trim().trim_end_matches(['.', ' ']).to_string();
    if name.starts_with('.') {
        name = format!("_{}", name.trim_start_matches('.'));
    }
    if name.is_empty() {
        name = "download".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        name = format!("_{name}");
    }
    // Länge begrenzen, Endung behalten.
    if name.chars().count() > 150 {
        let ext: String = match name.rfind('.') {
            Some(i) if name.len() - i <= 12 => name[i..].to_string(),
            _ => String::new(),
        };
        let keep = 150 - ext.chars().count();
        name = name.chars().take(keep).collect::<String>() + &ext;
    }
    name
}

fn name_from_url(url: &Url) -> Option<String> {
    let seg = url.path_segments()?.rfind(|s| !s.is_empty())?;
    let decoded = percent_decode(seg);
    (!decoded.trim().is_empty()).then(|| sanitize_file_name(&decoded))
}

/// Dateiname aus einem Content-Disposition-Kopf (`filename*=UTF-8''…` hat Vorrang vor `filename="…"`).
pub fn name_from_disposition(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if let Some(i) = lower.find("filename*=") {
        let rest = value[i + "filename*=".len()..].split(';').next()?.trim();
        // Zeichensatz'Sprache'Wert
        let encoded = rest.splitn(3, '\'').nth(2).unwrap_or(rest);
        let decoded = percent_decode(encoded.trim_matches('"'));
        if !decoded.trim().is_empty() {
            return Some(sanitize_file_name(&decoded));
        }
    }
    let i = lower.find("filename=")?;
    let rest = value[i + "filename=".len()..].trim_start();
    let raw = if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        rest.split(';').next()?.trim()
    };
    (!raw.trim().is_empty()).then(|| sanitize_file_name(raw))
}

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}

fn describe_net_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "Der Server antwortet nicht (Zeitüberschreitung)".into()
    } else if err.is_connect() {
        "Keine Verbindung zum Server – Internet und Adresse prüfen".into()
    } else if err.is_redirect() {
        "Der Server leitet auf einen nicht erlaubten Server oder zu oft weiter".into()
    } else {
        format!("Netzwerkfehler: {err}")
    }
}

fn describe_status(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "Der Server verweigert den Zugriff (Anmeldung oder Berechtigung nötig)".into(),
        404 | 410 => "Die Datei wurde auf dem Server nicht gefunden (Adresse prüfen)".into(),
        429 => "Der Server bremst gerade (zu viele Anfragen) – später erneut versuchen".into(),
        500..=599 => format!("Der Server meldet einen Fehler (HTTP {})", status.as_u16()),
        code => format!("Unerwartete Antwort des Servers (HTTP {code})"),
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartMeta {
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    // "bytes 100-199/200" oder "bytes 100-199/*"
    let rest = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total.trim().parse().ok()))
}

fn build_client(allowed: Vec<String>, allow_http: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("JellyStation/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .https_only(!allow_http)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let url = attempt.url();
            let host_ok = url.host_str().is_some_and(|h| host_allowed(h, &allowed));
            let scheme_ok = url.scheme() == "https" || (allow_http && url.scheme() == "http");
            let downgrade = attempt.previous().last().is_some_and(|p| p.scheme() == "https") && url.scheme() == "http";
            if attempt.previous().len() < MAX_REDIRECTS && host_ok && scheme_ok && !downgrade {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|err| format!("Netzwerk nicht verfügbar: {err}"))
}

/* ---------------------------------------------------------------- Download */

/// Der eigentliche Ablauf; `emit` bekommt den Fortschritt. Getrennt vom Tauri-Befehl, damit Tests ohne Fenster laufen.
pub async fn run_download(
    req: DownloadRequest,
    cancel: Arc<AtomicBool>,
    emit: &(dyn Fn(Progress) + Send + Sync),
) -> Result<DownloadResult, String> {
    let id = req.id.clone();
    let mut part_path_for_events: Option<String> = None;
    let result = download_inner(&req, &cancel, emit, &mut part_path_for_events).await;
    let (state, message) = match &result {
        Ok(_) => ("done", None),
        Err(e) if e == CANCELLED => ("cancelled", Some(e.clone())),
        Err(e) => ("failed", Some(e.clone())),
    };
    let (received, total) = match &result {
        Ok(r) => (r.size, Some(r.size)),
        Err(_) => (0, None),
    };
    // Der Abschluss kommt immer als eigenes Ereignis (auch wenn der Fortschritt davor gedrosselt war).
    emit(Progress {
        id,
        received,
        total,
        state,
        message,
        part_path: if result.is_err() { part_path_for_events } else { None },
    });
    result
}

async fn download_inner(
    req: &DownloadRequest,
    cancel: &Arc<AtomicBool>,
    emit: &(dyn Fn(Progress) + Send + Sync),
    part_for_events: &mut Option<String>,
) -> Result<DownloadResult, String> {
    let url = Url::parse(req.url.trim()).map_err(|_| "Die Adresse ist ungültig".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if req.allow_http => {}
        "http" => return Err("Nur https-Adressen sind erlaubt".into()),
        _ => return Err("Nur http- und https-Adressen sind erlaubt".into()),
    }
    let host = url.host_str().ok_or("Die Adresse enthält keinen Server")?.to_string();
    let allowed: Vec<String> = if req.allowed_hosts.is_empty() {
        vec![host.clone()]
    } else {
        req.allowed_hosts.clone()
    };
    if !host_allowed(&host, &allowed) {
        return Err(format!("Der Server „{host}“ steht nicht auf der Liste der erlaubten Server"));
    }
    let dir = expand_home(&req.dest_dir);
    if !dir.is_absolute() {
        return Err("Der Zielordner muss ein vollständiger Pfad sein".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Zielordner nicht anlegbar: {} ({e})", dir.display()))?;

    let provisional = req
        .file_name
        .as_deref()
        .map(sanitize_file_name)
        .or_else(|| name_from_url(&url))
        .unwrap_or_else(|| "download".into());
    let check_ext = |name: &str| {
        if req.block_executables && BLOCKED_EXTENSIONS.contains(&extension_of(name).as_str()) {
            Err(format!("Dateien vom Typ „.{}“ werden nicht in den Spiele-Ordner geladen", extension_of(name)))
        } else {
            Ok(())
        }
    };
    check_ext(&provisional)?;

    let part = dir.join(format!("{provisional}.part"));
    let meta_path = dir.join(format!("{provisional}.part.json"));
    let client = build_client(allowed, req.allow_http)?;

    emit(Progress {
        id: req.id.clone(),
        received: 0,
        total: None,
        state: "starting",
        message: None,
        part_path: None,
    });

    let mut attempt = 0;
    let (resp, offset, total) = loop {
        attempt += 1;
        let mut offset = 0u64;
        let saved: Option<PartMeta> = fs::read(&meta_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .filter(|m: &PartMeta| m.url == req.url);
        if let (Some(_), Ok(md)) = (&saved, fs::metadata(&part)) {
            offset = md.len();
        } else if part.exists() {
            let _ = fs::remove_file(&part); // Reste eines anderen Downloads
        }
        let mut rb = client.get(url.clone());
        if offset > 0 {
            rb = rb.header(RANGE, format!("bytes={offset}-"));
            if let Some(v) = saved.as_ref().and_then(|m| m.etag.clone().or_else(|| m.last_modified.clone())) {
                rb = rb.header(IF_RANGE, v);
            }
        }
        let resp = rb.send().await.map_err(|e| describe_net_error(&e))?;
        let status = resp.status();
        if status.as_u16() == 416 && offset > 0 && attempt < 3 {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&meta_path);
            continue;
        }
        if !status.is_success() {
            return Err(describe_status(status));
        }
        if status.as_u16() == 206 {
            let range = resp
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_content_range);
            match range {
                Some((start, total)) if start == offset => break (resp, offset, total),
                _ => {
                    // Der Server liefert ein anderes Stück als angefragt: von vorn.
                    let _ = fs::remove_file(&part);
                    let _ = fs::remove_file(&meta_path);
                    if attempt >= 3 {
                        return Err("Der Server unterstützt das Fortsetzen nicht zuverlässig".into());
                    }
                    continue;
                }
            }
        }
        // 200: der ganze Inhalt, ein vorhandener Teil wird ersetzt
        let total = resp.content_length();
        break (resp, 0, total);
    };

    if let Some(ct) = resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        let ext = extension_of(&provisional);
        if ct.to_ascii_lowercase().starts_with("text/html") && ext != "html" && ext != "htm" {
            return Err("Die Adresse liefert eine Webseite statt einer Datei (Anmeldung nötig oder falscher Link?)".into());
        }
    }
    let final_name = if req.file_name.is_some() {
        provisional.clone()
    } else {
        resp.headers()
            .get(CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(name_from_disposition)
            .unwrap_or_else(|| provisional.clone())
    };
    check_ext(&final_name)?;

    // Liegt die Datei schon vollständig da, wird nichts geladen.
    let final_path = dir.join(&final_name);
    if let (Some(total), Ok(md)) = (total, fs::metadata(&final_path)) {
        if md.is_file() && md.len() == total && offset == 0 && req.sha256.is_none() {
            return Ok(DownloadResult {
                path: final_path.to_string_lossy().into_owned(),
                file_name: final_name,
                size: md.len(),
                resumed: false,
                already_present: true,
                sha256: None,
            });
        }
    }

    let meta = PartMeta {
        url: req.url.clone(),
        etag: resp.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(String::from),
        last_modified: resp
            .headers()
            .get(LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(String::from),
    };
    if let Ok(text) = serde_json::to_vec(&meta) {
        let _ = fs::write(&meta_path, text);
    }

    let file = if offset > 0 {
        OpenOptions::new().append(true).open(&part)
    } else {
        File::create(&part)
    }
    .map_err(|e| format!("Datei nicht schreibbar: {} ({e})", part.display()))?;
    *part_for_events = Some(part.to_string_lossy().into_owned());
    let mut out = BufWriter::with_capacity(1024 * 1024, file);

    // Gesamtgröße: bei 206 steht sie im Content-Range, bei 200 in der Content-Length.
    let total_size = total;
    let mut received = offset;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = out.flush();
            return Err(CANCELLED.into());
        }
        let next = match tokio::time::timeout(STALL_TIMEOUT, stream.next()).await {
            Ok(n) => n,
            Err(_) => {
                let _ = out.flush();
                return Err("Der Server sendet nichts mehr (Zeitüberschreitung) – erneut starten, um fortzusetzen".into());
            }
        };
        match next {
            None => break,
            Some(Err(e)) => {
                let _ = out.flush();
                return Err(format!(
                    "Die Verbindung wurde unterbrochen ({}) – erneut starten, um fortzusetzen",
                    describe_net_error(&e)
                ));
            }
            Some(Ok(chunk)) => {
                out.write_all(&chunk)
                    .map_err(|e| format!("Schreiben fehlgeschlagen: {e} (Platz auf dem Laufwerk?)"))?;
                received += chunk.len() as u64;
                if last_emit.elapsed() >= PROGRESS_EVERY {
                    last_emit = Instant::now();
                    emit(Progress {
                        id: req.id.clone(),
                        received,
                        total: total_size,
                        state: "running",
                        message: None,
                        part_path: None,
                    });
                }
            }
        }
    }
    out.flush()
        .map_err(|e| format!("Schreiben fehlgeschlagen: {e} (Platz auf dem Laufwerk?)"))?;
    let file = out.into_inner().map_err(|e| format!("Schreiben fehlgeschlagen: {e}"))?;
    let _ = file.sync_all();
    drop(file);

    if let Some(total) = total_size {
        if received != total {
            return Err(format!(
                "Der Download ist unvollständig ({received} von {total} Bytes) – erneut starten, um fortzusetzen"
            ));
        }
    }

    let mut digest = None;
    if let Some(want) = req.sha256.as_deref().map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()) {
        emit(Progress {
            id: req.id.clone(),
            received,
            total: total_size,
            state: "verifying",
            message: None,
            part_path: None,
        });
        let p = part.clone();
        let fp = tauri::async_runtime::spawn_blocking(move || hashing::fingerprint(&p))
            .await
            .map_err(|e| format!("Prüfsumme nicht berechenbar: {e}"))?
            .map_err(|e| format!("Prüfsumme nicht berechenbar: {e}"))?;
        if fp.sha256 != want {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&meta_path);
            *part_for_events = None;
            return Err("Die Prüfsumme (SHA-256) stimmt nicht – die Datei wurde verworfen".into());
        }
        digest = Some(fp.sha256);
    }

    let target = unique_path(&dir, &final_name);
    fs::rename(&part, &target).map_err(|e| format!("Datei nicht ablegbar: {} ({e})", target.display()))?;
    let _ = fs::remove_file(&meta_path);
    *part_for_events = None;
    Ok(DownloadResult {
        path: target.to_string_lossy().into_owned(),
        file_name: target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(final_name),
        size: received,
        resumed: offset > 0,
        already_present: false,
        sha256: digest,
    })
}

/// Lädt eine Datei. Fortschritt kommt als Ereignis `download-progress` ([`Progress`]).
#[tauri::command]
pub async fn download_start(
    app: AppHandle,
    state: State<'_, Downloads>,
    req: DownloadRequest,
) -> Result<DownloadResult, String> {
    if req.id.is_empty() || req.id.len() > 80 {
        return Err("Ungültige Download-Kennung".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = lock(&state.active);
        if active.contains_key(&req.id) {
            return Err("Dieser Download läuft schon".into());
        }
        active.insert(req.id.clone(), cancel.clone());
    }
    let id = req.id.clone();
    let handle = app.clone();
    let emit = move |p: Progress| {
        let _ = handle.emit("download-progress", p);
    };
    let result = run_download(req, cancel, &emit).await;
    lock(&state.active).remove(&id);
    result
}

/// Bricht einen laufenden Download ab. Die unfertige Datei bleibt für „Fortsetzen“ liegen.
#[tauri::command]
pub fn download_cancel(state: State<'_, Downloads>, id: String) -> bool {
    match lock(&state.active).get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// Löscht eine unfertige Datei (`….part`) samt Merkzettel. Andere Dateien werden nie angefasst.
#[tauri::command]
pub fn download_discard(part_path: String) -> Result<(), String> {
    let path = expand_home(&part_path);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.ends_with(".part") || !path.is_absolute() {
        return Err("Das ist keine unfertige Download-Datei".into());
    }
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(path.with_file_name(format!("{name}.json")));
    Ok(())
}

/* ---------------------------------------------------------------- Prüfen */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintResult {
    pub size: u64,
    pub head: String,
    pub md5: String,
    pub sha256: String,
}

/// Größe, erste Bytes, MD5 und SHA-256 einer Datei (für die BIOS-/Firmware-Prüfung).
#[tauri::command]
pub async fn file_fingerprint(path: String) -> Result<FingerprintResult, String> {
    let p = expand_home(&path);
    tauri::async_runtime::spawn_blocking(move || hashing::fingerprint(&p))
        .await
        .map_err(|e| format!("Die Prüfung wurde abgebrochen ({e})"))?
        .map(|f| FingerprintResult {
            size: f.size,
            head: f.head,
            md5: f.md5,
            sha256: f.sha256,
        })
        .map_err(|e| format!("Datei nicht lesbar: {e}"))
}

/* ---------------------------------------------------------------- Plattform */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "macos" | "windows" | "linux"
    pub os: &'static str,
    /// "aarch64" | "x86_64" | …
    pub arch: &'static str,
    /// Hier landen heruntergeladene Emulatoren (macOS: ~/Applications, sonst ein JellyStation-Ordner im Datenordner).
    pub emulators_dir: String,
    pub home: String,
}

#[tauri::command]
pub fn install_platform(app: AppHandle) -> PlatformInfo {
    let home = app
        .path()
        .home_dir()
        .ok()
        .or_else(home_dir)
        .unwrap_or_default();
    let emulators_dir = if cfg!(target_os = "macos") {
        home.join("Applications")
    } else {
        app.path()
            .local_data_dir()
            .unwrap_or_else(|_| home.join(".local/share"))
            .join("JellyStation")
            .join("Emulators")
    };
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        emulators_dir: emulators_dir.to_string_lossy().into_owned(),
        home: home.to_string_lossy().into_owned(),
    }
}

/* ---------------------------------------------------------------- Archive einspielen */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub archive: String,
    /// Emulator-ID; unter Windows/Linux der Name des Zielordners.
    pub id: String,
    /// Zielordner aus `install_platform().emulatorsDir`.
    pub dest_root: String,
    /// Regulärer Ausdruck für den Namen der Programmdatei (Windows/Linux), z. B. "^rpcs3\\.exe$".
    pub exe_pattern: Option<String>,
    /// true = das Archiv nach erfolgreichem Einspielen löschen (es ist ohnehin ein eigener Download).
    #[serde(default)]
    pub remove_archive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    /// Die `.app` (macOS) bzw. die Programmdatei.
    pub path: String,
    /// Ordner, in dem der Emulator jetzt liegt.
    pub root: String,
}

fn run_tool(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{program} nicht startbar ({e})"))?;
    if output.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let first = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    Err(format!("{program} meldet einen Fehler{}", if first.is_empty() { String::new() } else { format!(": {first}") }))
}

fn windows_tar() -> String {
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(root).join("System32").join("tar.exe");
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    "tar".into()
}

/// Entpackt `archive` nach `dest` (existiert schon) mit Bordmitteln.
fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let name = archive.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let a = archive.to_string_lossy().into_owned();
    let d = dest.to_string_lossy().into_owned();
    let hint = |why: String| {
        format!(
            "{why}. Entpacke die Datei von Hand (z. B. mit 7-Zip) und lege den Emulator selbst ab: {}",
            archive.display()
        )
    };
    if name.ends_with(".zip") {
        if cfg!(target_os = "macos") {
            return run_tool("ditto", &["-x", "-k", &a, &d]).map_err(hint);
        }
        if cfg!(windows) {
            return run_tool(&windows_tar(), &["-xf", &a, "-C", &d]).map_err(hint);
        }
        return run_tool("unzip", &["-q", "-o", &a, "-d", &d])
            .or_else(|_| run_tool("tar", &["-xf", &a, "-C", &d]))
            .map_err(hint);
    }
    if name.ends_with(".7z") {
        // macOS und Windows 11 lesen 7z über ihr tar (libarchive); sonst 7-Zip, falls installiert.
        let tar = if cfg!(windows) { windows_tar() } else { "tar".into() };
        let mut last = run_tool(&tar, &["-xf", &a, "-C", &d]);
        if last.is_err() {
            for tool in ["7zz", "7z", "7za"] {
                let out = format!("-o{d}");
                if run_tool(tool, &["x", "-y", &out, &a]).is_ok() {
                    last = Ok(());
                    break;
                }
            }
        }
        return last.map_err(|e| hint(format!("{e} (7z-Archive lassen sich auf diesem System nicht ohne 7-Zip entpacken)")));
    }
    if [".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2", ".tar"].iter().any(|e| name.ends_with(e)) {
        let tar = if cfg!(windows) { windows_tar() } else { "tar".into() };
        return run_tool(&tar, &["-xf", &a, "-C", &d]).map_err(hint);
    }
    Err(format!("Dieses Archivformat wird nicht unterstützt: {name}"))
}

/// macOS: Abbild einhängen, die `.app` hinein nach `dest` kopieren, Abbild wieder auswerfen.
fn extract_dmg(dmg: &Path, dest: &Path) -> Result<(), String> {
    let mount = dest.join(".mnt");
    fs::create_dir_all(&mount).map_err(|e| format!("Temporärer Ordner nicht anlegbar ({e})"))?;
    let m = mount.to_string_lossy().into_owned();
    let d = dmg.to_string_lossy().into_owned();
    run_tool("hdiutil", &["attach", "-nobrowse", "-readonly", "-noverify", "-noautoopen", "-mountpoint", &m, &d])
        .map_err(|e| format!("Das Disk-Abbild ließ sich nicht öffnen: {e}"))?;
    let copied = (|| -> Result<(), String> {
        let app = find_app(&mount, 1).ok_or("Im Disk-Abbild liegt keine App")?;
        let target = dest.join(app.file_name().ok_or("Ungültiger App-Name")?);
        run_tool("ditto", &[&app.to_string_lossy(), &target.to_string_lossy()])
    })();
    let _ = run_tool("hdiutil", &["detach", &m, "-force"]);
    copied
}

fn find_app(dir: &Path, depth: usize) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "__MACOSX" {
            continue;
        }
        if p.is_dir() {
            if name.to_ascii_lowercase().ends_with(".app") {
                return Some(p);
            }
            dirs.push(p);
        }
    }
    if depth == 0 {
        return None;
    }
    dirs.into_iter().find_map(|d| find_app(&d, depth - 1))
}

fn find_exe(dir: &Path, re: &regex::Regex, depth: usize) -> Option<PathBuf> {
    let mut subdirs = Vec::new();
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_file() && re.is_match(&e.file_name().to_string_lossy()) {
            return Some(p);
        }
        if p.is_dir() {
            subdirs.push(p);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs.into_iter().find_map(|d| find_exe(&d, re, depth - 1))
}

/// Kopiert den Inhalt von `src` nach `dst` und überschreibt gleichnamige Dateien; andere Dateien in `dst`
/// (Einstellungen, Spielstände des Emulators) bleiben liegen.
fn copy_merge(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let from = e.path();
        let to = dst.join(e.file_name());
        let ty = e.file_type()?;
        if ty.is_dir() {
            copy_merge(&from, &to)?;
        } else if ty.is_symlink() {
            #[cfg(unix)]
            {
                let _ = fs::remove_file(&to);
                std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
            }
        } else {
            if to.exists() {
                let _ = fs::remove_file(&to);
            }
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Wenn der entpackte Inhalt aus genau einem Ordner besteht, gilt dieser Ordner als Wurzel.
fn single_root(dir: &Path) -> PathBuf {
    let entries: Vec<_> = fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .filter(|e| e.file_name() != "__MACOSX" && !e.file_name().to_string_lossy().starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    match entries.as_slice() {
        [only] if only.path().is_dir() && !only.file_name().to_string_lossy().to_ascii_lowercase().ends_with(".app") => only.path(),
        _ => dir.to_path_buf(),
    }
}

fn install_sync(req: &InstallRequest) -> Result<InstallResult, String> {
    let archive = expand_home(&req.archive);
    if !archive.is_file() {
        return Err(format!("Archiv nicht gefunden: {}", archive.display()));
    }
    let id = sanitize_file_name(&req.id);
    let root = expand_home(&req.dest_root);
    if !root.is_absolute() {
        return Err("Der Zielordner muss ein vollständiger Pfad sein".into());
    }
    fs::create_dir_all(&root).map_err(|e| format!("Zielordner nicht anlegbar: {} ({e})", root.display()))?;
    let tmp = root.join(format!(".jellystation-install-{id}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| format!("Temporärer Ordner nicht anlegbar ({e})"))?;
    let result = (|| -> Result<InstallResult, String> {
        let lower = archive.to_string_lossy().to_ascii_lowercase();
        if lower.ends_with(".dmg") {
            if !cfg!(target_os = "macos") {
                return Err("Disk-Abbilder (.dmg) lassen sich nur auf dem Mac öffnen".into());
            }
            extract_dmg(&archive, &tmp)?;
        } else {
            extract(&archive, &tmp)?;
        }
        if cfg!(target_os = "macos") {
            let app = find_app(&tmp, 3).ok_or("Im Archiv liegt keine App (.app)")?;
            let target = root.join(app.file_name().ok_or("Ungültiger App-Name")?);
            if target.exists() {
                fs::remove_dir_all(&target)
                    .map_err(|e| format!("Die alte Version ließ sich nicht entfernen: {} ({e})", target.display()))?;
            }
            run_tool("ditto", &[&app.to_string_lossy(), &target.to_string_lossy()])?;
            // Selbst geladene Dateien tragen keine Quarantäne; falls doch, entfernen (Fehler egal).
            let _ = Command::new("xattr")
                .args(["-dr", "com.apple.quarantine", &target.to_string_lossy()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            return Ok(InstallResult {
                path: target.to_string_lossy().into_owned(),
                root: root.to_string_lossy().into_owned(),
            });
        }
        let target = root.join(&id);
        copy_merge(&single_root(&tmp), &target).map_err(|e| format!("Kopieren fehlgeschlagen: {e}"))?;
        let pattern = req.exe_pattern.as_deref().ok_or("Kein Muster für die Programmdatei angegeben")?;
        let re = RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
            .map_err(|e| format!("Ungültiges Muster für die Programmdatei: {e}"))?;
        let exe = find_exe(&target, &re, 3).ok_or("Im Archiv wurde keine Programmdatei gefunden")?;
        Ok(InstallResult {
            path: exe.to_string_lossy().into_owned(),
            root: target.to_string_lossy().into_owned(),
        })
    })();
    let _ = fs::remove_dir_all(&tmp);
    if result.is_ok() && req.remove_archive {
        let _ = fs::remove_file(&archive);
    }
    result
}

/// Entpackt ein heruntergeladenes Emulator-Archiv und legt den Emulator ab (siehe `InstallRequest`).
#[tauri::command]
pub async fn install_archive(req: InstallRequest) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_sync(&req))
        .await
        .map_err(|e| format!("Die Installation wurde abgebrochen ({e})"))?
}

#[cfg(test)]
mod tests;
