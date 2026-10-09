//! Spiele-Cover: Grafiken aus dem Spiel selbst und – wenn erlaubt – aus dem Netz, mit Cache.
//!
//! Befehle: `cover_resolve`, `cover_cache_stats`, `cover_cache_clear`.
//!
//! Ablauf von `cover_resolve({ system, path, title, online, retry? })`:
//! 1. Cache (`<App-Cache>/covers/<system>/<hash>.png|jpg|webp`) – schon geholt oder gelesen? Ein Merker
//!    "nicht gefunden" (7 Tage) bzw. "Netzfehler" (10 Minuten) beendet die Suche sofort (außer bei `retry`).
//! 2. Eingebettet ([`embedded`]): `ICON0.PNG` aus PS3-/PSP-Abbildern und -Ordnern, ohne zu mounten.
//! 3. Online, nur bei `online: true`: libretro-Thumbnails (<https://thumbnails.libretro.com>), ohne Schlüssel.
//!    Die Dateiliste des Systems wird einmal geholt und 30 Tage im Cache gehalten; der Spielname wird per
//!    Fuzzy-Abgleich ([`matching`]) einer Datei zugeordnet (Boxart, sonst Snap, sonst Titelbild).
//!
//! Datenschutz: Es gehen nur der Systemname und der Dateiname des Bildes an thumbnails.libretro.com. Mit
//! `online: false` wird nichts abgerufen. Heruntergeladen werden höchstens zwei Dateien gleichzeitig mit kurzer
//! Pause; Zeit- und Größenlimits, nur https (Weiterleitungen nur innerhalb desselben Hosts), nur echte
//! Bilder (PNG/JPEG/WebP, geprüft an den Bytes). Bilder werden unverändert gespeichert, atomar (temp + rename).
//! Nicht Gefundenes wird 7 Tage nicht erneut gesucht, Netzfehler nach 10 Minuten wieder.
//!
//! Alles Wesentliche hängt nicht an Tauri ([`Covers`]); die Befehle am Ende sind dünne Hüllen.

mod embedded;
mod image;
mod iso;
mod matching;
mod system;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod testsupport;

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Semaphore;

use image::{peek_image, sniff_image, ImageInfo};
use matching::{
    image_url, libretro_file_name, listing_url, parse_listing_html, parse_name, Listing,
    IMAGE_KINDS,
};
use system::{cache_slug, Platform};

/// Standard-Adresse der libretro-Thumbnails.
pub const DEFAULT_BASE: &str = "https://thumbnails.libretro.com";
/// Mehr als das ist kein Cover.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Die größte Dateiliste (PS2-Boxarts) ist wenige MB groß.
const MAX_LISTING_BYTES: usize = 16 * 1024 * 1024;
/// So lange gilt eine geholte Dateiliste.
const LISTING_TTL_SECS: u64 = 30 * 24 * 3600;
/// So lange wird ein nicht gefundenes Cover nicht erneut gesucht.
const MISS_TTL_SECS: u64 = 7 * 24 * 3600;
/// So lange wird nach einem Netzfehler nicht erneut versucht.
const NET_ERROR_TTL_SECS: u64 = 10 * 60;
/// Nach einem Verbindungsfehler wird so lange gar nicht erst versucht (offline: nicht jedes Spiel einzeln warten lassen).
const OFFLINE_BACKOFF: Duration = Duration::from_secs(60);
/// Gleichzeitige Anfragen an den Server.
const MAX_PARALLEL: usize = 2;
const IMAGE_EXTENSIONS: [&str; 3] = ["png", "jpg", "webp"];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Eine vergiftete Sperre heißt nur, dass ein anderer Thread abgestürzt ist; die Daten bleiben nutzbar.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/* ------------------------------------------------------------------------------ Anfrage, Antwort */

/// Ergebnis von `cover_resolve`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverResult {
    /// Absoluter Pfad der Bilddatei im Cache; `None`, wenn es kein Cover gibt.
    pub path: Option<String>,
    /// `embedded` (gerade aus dem Spiel gelesen), `online` (gerade geholt) oder `cache` (früher gespeichert).
    pub source: Option<&'static str>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Seriennummer bzw. Spiel-ID, falls im Spiel gefunden.
    pub serial: Option<String>,
    /// Netzproblem, das die Suche verhindert hat (kein "nicht gefunden").
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CoverRequest {
    /// Name des Systemordners, z. B. `PS3`.
    pub system: String,
    /// Absoluter Pfad der Spieldatei bzw. des Spielordners.
    pub path: String,
    /// Anzeigetitel (Dateiname ohne Endung).
    pub title: String,
    /// false = nichts aus dem Netz holen.
    pub online: bool,
    /// true = auch Spiele noch einmal suchen, die als "nicht gefunden" gemerkt sind (manuelle Suche).
    pub retry: bool,
}

impl CoverRequest {
    fn validate(&self) -> Result<(), String> {
        if self.system.trim().is_empty() || self.system.len() > 64 {
            return Err("Kein gültiger Systemname".into());
        }
        if self.path.is_empty() || self.path.len() > 4096 {
            return Err("Kein gültiger Spielpfad".into());
        }
        if self.title.len() > 512 {
            return Err("Der Spieltitel ist zu lang".into());
        }
        Ok(())
    }

    /// Name, nach dem im Cache abgelegt wird: der Titel, sonst der Dateiname.
    fn game_name(&self) -> String {
        let title = self.title.trim();
        if !title.is_empty() {
            return title.to_string();
        }
        Path::new(&self.path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// Größe des Cache.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    /// Anzahl der gespeicherten Bilder.
    pub count: u32,
    /// Platz aller Dateien im Cache (Bilder, Listen, Merker).
    pub bytes: u64,
}

/* ----------------------------------------------------------------------------------------- Cache */

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Dateiname (ohne Endung) im Cache: Hash aus System und Spielname – nie Teil eines Pfades aus Nutzereingaben.
fn cache_key(system: &str, name: &str) -> String {
    let text = format!(
        "{}\0{}",
        system.trim().to_lowercase(),
        name.trim().to_lowercase()
    );
    format!("{:016x}", fnv1a64(text.as_bytes()))
}

fn find_cached(dir: &Path, key: &str) -> Option<PathBuf> {
    IMAGE_EXTENSIONS
        .iter()
        .map(|ext| dir.join(format!("{key}.{ext}")))
        .find(|path| fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0))
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Schreibt über eine temporäre Datei und benennt sie um: Ein abgebrochener Schreibvorgang hinterlässt nie
/// ein halbes Bild unter dem endgültigen Namen.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("kein Ordner"))?;
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()
    })()
    .and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Merker "nicht gefunden" bzw. "Netzfehler" mit Zeitpunkt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Miss {
    NotFound(u64),
    NetError(u64),
}

impl Miss {
    fn active(self, now: u64) -> bool {
        match self {
            Miss::NotFound(at) => now < at.saturating_add(MISS_TTL_SECS),
            Miss::NetError(at) => now < at.saturating_add(NET_ERROR_TTL_SECS),
        }
    }

    fn text(self) -> String {
        match self {
            Miss::NotFound(at) => format!("notfound {at}\n"),
            Miss::NetError(at) => format!("neterr {at}\n"),
        }
    }

    fn parse(text: &str) -> Option<Miss> {
        let (kind, at) = text.trim().split_once(' ')?;
        let at = at.trim().parse().ok()?;
        match kind {
            "notfound" => Some(Miss::NotFound(at)),
            "neterr" => Some(Miss::NetError(at)),
            _ => None,
        }
    }
}

fn read_miss(path: &Path) -> Option<Miss> {
    Miss::parse(&fs::read_to_string(path).ok()?)
}

fn read_listing_file(path: &Path) -> Option<(u64, Vec<String>)> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let at = lines.next()?.strip_prefix("# ")?.trim().parse().ok()?;
    let files: Vec<String> = lines
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    (!files.is_empty()).then_some((at, files))
}

fn write_listing_file(path: &Path, at: u64, files: &[String]) {
    let mut text = format!("# {at}\n");
    for file in files {
        text.push_str(file);
        text.push('\n');
    }
    let _ = write_atomic(path, text.as_bytes());
}

/// Zählt Bilder und Platzbedarf im Cache.
pub fn cache_stats(root: &Path) -> CacheStats {
    let mut stats = CacheStats::default();
    visit_cache_files(root, &mut |path, len| {
        stats.bytes += len;
        if is_image_file(path) {
            stats.count += 1;
        }
    });
    stats
}

/// Löscht alles im Cache (Bilder, Dateilisten, Merker). Gibt (Anzahl Bilder, Bytes) zurück. Es werden nur
/// gewöhnliche Dateien in den Unterordnern des Cache-Ordners gelöscht – keine Links, nichts außerhalb.
pub fn cache_clear(root: &Path) -> (u32, u64) {
    let (mut images, mut bytes) = (0u32, 0u64);
    let mut files = Vec::new();
    visit_cache_files(root, &mut |path, len| files.push((path.to_path_buf(), len)));
    for (path, len) in files {
        if fs::remove_file(&path).is_ok() {
            bytes += len;
            if is_image_file(&path) {
                images += 1;
            }
        }
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                let _ = fs::remove_dir(entry.path()); // nur, wenn leer
            }
        }
    }
    (images, bytes)
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| IMAGE_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// Ruft `visit` für jede gewöhnliche Datei in `root/*/` und `root/` auf (Verknüpfungen werden übergangen).
fn visit_cache_files(root: &Path, visit: &mut dyn FnMut(&Path, u64)) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() {
            visit(
                &entry.path(),
                entry.metadata().map(|m| m.len()).unwrap_or(0),
            );
        } else if kind.is_dir() {
            if let Ok(inner) = fs::read_dir(entry.path()) {
                for file in inner.flatten() {
                    if file.file_type().is_ok_and(|t| t.is_file()) {
                        visit(&file.path(), file.metadata().map(|m| m.len()).unwrap_or(0));
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------------------------------ Netz */

/// Zeitlimits der Abrufe.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub connect: Duration,
    /// Von der Anfrage bis zum letzten Byte.
    pub total: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            connect: Duration::from_secs(8),
            total: Duration::from_secs(20),
        }
    }
}

/// Ausgang eines Abrufs ohne Netzfehler.
#[derive(Debug)]
enum Fetched {
    Body(Vec<u8>),
    /// 404, 403 und Weiterleitungen, die wir nicht mitgehen.
    NotFound,
    /// Größer als erlaubt.
    TooBig,
}

struct ListingSlot {
    /// `None`: Der Server hat keine brauchbare Liste (dann werden Dateinamen direkt versucht).
    listing: Option<Arc<Listing>>,
    at: u64,
}

/// Zustand der Cover-Suche: Adresse, Begrenzungen und die geladenen Dateilisten.
pub struct Covers {
    base: String,
    /// Eine selbst gewählte Adresse (Tests, Entwicklung): http erlaubt, kein System-Proxy.
    custom_base: bool,
    pause: Duration,
    limits: Limits,
    permits: Arc<Semaphore>,
    client: Mutex<Option<reqwest::Client>>,
    listings: Mutex<HashMap<String, ListingSlot>>,
    listing_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    offline_until: Mutex<Option<Instant>>,
}

/// Adresse der Thumbnails. `JELLYSTATION_COVER_BASE` überschreibt sie – nur in Debug-Builds und Tests.
fn configured_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("JELLYSTATION_COVER_BASE") {
            let value = value.trim().trim_end_matches('/');
            if value.starts_with("http://") || value.starts_with("https://") {
                return value.to_string();
            }
        }
    }
    DEFAULT_BASE.to_string()
}

impl Default for Covers {
    fn default() -> Covers {
        Covers::new(
            &configured_base(),
            Duration::from_millis(250),
            Limits::default(),
        )
    }
}

impl Covers {
    pub fn new(base: &str, pause: Duration, limits: Limits) -> Covers {
        let base = base.trim().trim_end_matches('/').to_string();
        Covers {
            custom_base: base != DEFAULT_BASE,
            base,
            pause,
            limits,
            permits: Arc::new(Semaphore::new(MAX_PARALLEL)),
            client: Mutex::new(None),
            listings: Mutex::new(HashMap::new()),
            listing_gates: Mutex::new(HashMap::new()),
            offline_until: Mutex::new(None),
        }
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        let mut slot = lock(&self.client);
        if let Some(client) = slot.as_ref() {
            return Ok(client.clone());
        }
        let host = reqwest::Url::parse(&self.base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string));
        let allow_http = self.custom_base;
        let mut builder = reqwest::Client::builder()
            .user_agent(concat!("JellyStation/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(self.limits.connect)
            .timeout(self.limits.total)
            .https_only(!allow_http)
            // Weiterleitungen nur innerhalb desselben Hosts (und nie von https zu http)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                let url = attempt.url();
                let same_host = url.host_str().map(str::to_string) == host;
                let scheme_ok = url.scheme() == "https" || (allow_http && url.scheme() == "http");
                if attempt.previous().len() < 3 && same_host && scheme_ok {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }));
        if self.custom_base {
            builder = builder.no_proxy();
        }
        let client = builder
            .build()
            .map_err(|err| format!("Netzwerk nicht verfügbar: {err}"))?;
        *slot = Some(client.clone());
        Ok(client)
    }

    /// Ein Abruf mit Größenlimit, höchstens `MAX_PARALLEL` gleichzeitig und kurzer Pause danach.
    async fn get_limited(&self, url: &str, limit: usize) -> Result<Fetched, String> {
        if lock(&self.offline_until).is_some_and(|until| Instant::now() < until) {
            return Err("Keine Verbindung zu thumbnails.libretro.com".into());
        }
        let client = self.client()?;
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| "Abruf abgebrochen".to_string())?;
        let result = self.get_inner(&client, url, limit).await;
        if let Err(err) = &result {
            if err.starts_with("Keine Verbindung") {
                *lock(&self.offline_until) = Some(Instant::now() + OFFLINE_BACKOFF);
            }
        }
        tokio::time::sleep(self.pause).await;
        result
    }

    async fn get_inner(
        &self,
        client: &reqwest::Client,
        url: &str,
        limit: usize,
    ) -> Result<Fetched, String> {
        let describe = |err: reqwest::Error| {
            if err.is_connect() || err.is_timeout() {
                "Keine Verbindung zu thumbnails.libretro.com".to_string()
            } else {
                format!("Abruf fehlgeschlagen: {}", err.without_url())
            }
        };
        let mut response = client.get(url).send().await.map_err(describe)?;
        let status = response.status();
        if status.is_redirection() || matches!(status.as_u16(), 400 | 403 | 404 | 410) {
            return Ok(Fetched::NotFound);
        }
        if !status.is_success() {
            return Err(format!(
                "Der Server antwortet mit Status {}",
                status.as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|len| len > limit as u64)
        {
            return Ok(Fetched::TooBig);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(describe)? {
            if body.len() + chunk.len() > limit {
                return Ok(Fetched::TooBig);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Fetched::Body(body))
    }

    /// Dateiliste eines libretro-Verzeichnisses: Speicher, dann Cache-Datei (30 Tage), dann Netz.
    /// `Ok(None)`: Der Server liefert keine brauchbare Liste.
    async fn listing(
        &self,
        root: &Path,
        platform: Platform,
        kind: &str,
    ) -> Result<Option<Arc<Listing>>, String> {
        let key = format!("{}/{kind}", platform.libretro_dir());
        let remembered = |now: u64| {
            lock(&self.listings)
                .get(&key)
                .filter(|slot| now < slot.at.saturating_add(LISTING_TTL_SECS))
                .map(|slot| slot.listing.clone())
        };
        if let Some(found) = remembered(now_secs()) {
            return Ok(found);
        }
        // Nur ein Abruf je Liste; wer wartet, findet sie danach im Speicher
        let gate = lock(&self.listing_gates)
            .entry(key.clone())
            .or_default()
            .clone();
        let _turn = gate.lock().await;
        let now = now_secs();
        if let Some(found) = remembered(now) {
            return Ok(found);
        }
        let remember = |listing: Option<Arc<Listing>>, at: u64| {
            lock(&self.listings).insert(
                key.clone(),
                ListingSlot {
                    listing: listing.clone(),
                    at,
                },
            );
            listing
        };

        let file = root.join("_listings").join(format!(
            "{}-{}.txt",
            cache_slug(platform.libretro_dir()),
            cache_slug(kind)
        ));
        let on_disk = read_listing_file(&file);
        if let Some((at, files)) = &on_disk {
            if now < at.saturating_add(LISTING_TTL_SECS) {
                return Ok(remember(
                    Some(Arc::new(Listing::from_files(files.clone()))),
                    *at,
                ));
            }
        }
        match self
            .get_limited(
                &listing_url(&self.base, platform.libretro_dir(), kind),
                MAX_LISTING_BYTES,
            )
            .await
        {
            Ok(Fetched::Body(bytes)) => {
                let files = parse_listing_html(&String::from_utf8_lossy(&bytes));
                if files.is_empty() {
                    return Ok(remember(None, now));
                }
                write_listing_file(&file, now, &files);
                Ok(remember(Some(Arc::new(Listing::from_files(files))), now))
            }
            Ok(Fetched::NotFound | Fetched::TooBig) => Ok(remember(None, now)),
            Err(err) => match on_disk {
                // Die alte Liste ist besser als keine; in zehn Minuten wird neu versucht
                Some((_, files)) => Ok(remember(
                    Some(Arc::new(Listing::from_files(files))),
                    now.saturating_sub(LISTING_TTL_SECS) + NET_ERROR_TTL_SECS,
                )),
                None => Err(err),
            },
        }
    }

    /// Holt ein Bild aus dem Verzeichnis. `Ok(None)`: gibt es nicht oder ist kein Bild.
    async fn fetch_image(
        &self,
        platform: Platform,
        kind: &str,
        file: &str,
    ) -> Result<Option<(Vec<u8>, ImageInfo)>, String> {
        let url = image_url(&self.base, platform.libretro_dir(), kind, file);
        match self.get_limited(&url, MAX_IMAGE_BYTES).await? {
            Fetched::Body(bytes) => Ok(sniff_image(&bytes).map(|info| (bytes, info))),
            Fetched::NotFound | Fetched::TooBig => Ok(None),
        }
    }

    /// Sucht das Cover zu den Namen: Boxart, sonst Snap, sonst Titelbild.
    async fn find_online(
        &self,
        root: &Path,
        platform: Platform,
        names: &[String],
    ) -> Result<Option<(Vec<u8>, ImageInfo)>, String> {
        let parsed: Vec<_> = names
            .iter()
            .map(|n| parse_name(n))
            .filter(|n| !n.tokens.is_empty())
            .collect();
        if parsed.is_empty() {
            return Ok(None);
        }
        for kind in IMAGE_KINDS {
            match self.listing(root, platform, kind).await? {
                Some(listing) => {
                    if let Some(hit) = listing.best_match(&parsed) {
                        if let Some(found) = self.fetch_image(platform, kind, &hit.file).await? {
                            return Ok(Some(found));
                        }
                    }
                }
                // Keine Liste: die Namen so versuchen, wie libretro sie anlegt
                None => {
                    let mut tried = Vec::new();
                    for name in names {
                        let file = libretro_file_name(name);
                        if name.trim().is_empty() || tried.contains(&file) {
                            continue;
                        }
                        if let Some(found) = self.fetch_image(platform, kind, &file).await? {
                            return Ok(Some(found));
                        }
                        tried.push(file);
                    }
                }
            }
        }
        Ok(None)
    }

    /// Findet das Cover zu einem Spiel (siehe Moduldokumentation). Fehler beim Netz stehen im Ergebnis.
    pub async fn resolve(&self, root: &Path, request: &CoverRequest) -> CoverResult {
        let name = request.game_name();
        let key = cache_key(&request.system, &name);
        let dir = root.join(cache_slug(&request.system));

        if let Some(path) = find_cached(&dir, &key) {
            return result_for_file(&path, "cache", None);
        }
        // Schon vergeblich gesucht (Spiel ohne Bild, kein Treffer im Netz): beim nächsten Start nicht erneut aufmachen
        let miss_file = dir.join(format!("{key}.miss"));
        if request.retry {
            *lock(&self.offline_until) = None;
        } else if read_miss(&miss_file).is_some_and(|miss| miss.active(now_secs())) {
            return CoverResult::default();
        }

        let game_path = PathBuf::from(&request.path);
        let embedded = tokio::task::spawn_blocking(move || embedded::extract(&game_path))
            .await
            .unwrap_or_default();
        let serial = embedded.serial.clone();

        if let Some(info) = embedded.icon.as_deref().and_then(sniff_image) {
            let path = dir.join(format!("{key}.{}", info.ext));
            let bytes = embedded.icon.as_deref().unwrap_or_default();
            if write_atomic(&path, bytes).is_ok() {
                return CoverResult {
                    width: Some(info.width),
                    height: Some(info.height),
                    ..result_for_file(&path, "embedded", serial)
                };
            }
        }

        let mut result = CoverResult {
            serial,
            ..CoverResult::default()
        };
        if !request.online {
            return result;
        }
        let Some(platform) = embedded
            .platform
            .or_else(|| Platform::from_folder(&request.system))
        else {
            return result;
        };

        let mut names = Vec::new();
        names.extend(embedded.title.clone().filter(|t| !t.trim().is_empty()));
        names.push(name);
        match self.find_online(root, platform, &names).await {
            Ok(Some((bytes, info))) => {
                let path = dir.join(format!("{key}.{}", info.ext));
                match write_atomic(&path, &bytes) {
                    Ok(()) => {
                        let _ = fs::remove_file(&miss_file);
                        return CoverResult {
                            width: Some(info.width),
                            height: Some(info.height),
                            ..result_for_file(&path, "online", result.serial.take())
                        };
                    }
                    Err(err) => result.error = Some(format!("Cover nicht gespeichert: {err}")),
                }
            }
            Ok(None) => {
                let _ = write_atomic(&miss_file, Miss::NotFound(now_secs()).text().as_bytes());
            }
            Err(err) => {
                let _ = write_atomic(&miss_file, Miss::NetError(now_secs()).text().as_bytes());
                result.error = Some(err);
            }
        }
        result
    }

    /// Vergisst die im Speicher gehaltenen Dateilisten (nach dem Leeren des Cache).
    pub fn forget_listings(&self) {
        lock(&self.listings).clear();
    }
}

fn result_for_file(path: &Path, source: &'static str, serial: Option<String>) -> CoverResult {
    let mut head = Vec::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(128 * 1024).read_to_end(&mut head);
    }
    let size = peek_image(&head);
    CoverResult {
        path: Some(path.to_string_lossy().into_owned()),
        source: Some(source),
        width: size.map(|i| i.width),
        height: size.map(|i| i.height),
        serial,
        error: None,
    }
}

/* ---------------------------------------------------------------------------------------- Befehle */

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("covers"))
        .map_err(|err| format!("Cache-Ordner nicht verfügbar: {err}"))
}

/// Findet das Cover zu einem Spiel: Cache, im Spiel eingebettet oder (nur mit `online`) aus dem Netz.
#[tauri::command]
pub async fn cover_resolve(
    app: AppHandle,
    covers: State<'_, Covers>,
    system: String,
    path: String,
    title: String,
    online: bool,
    retry: Option<bool>,
) -> Result<CoverResult, String> {
    let request = CoverRequest {
        system,
        path,
        title,
        online,
        retry: retry.unwrap_or(false),
    };
    request.validate()?;
    Ok(covers.resolve(&cache_root(&app)?, &request).await)
}

/// Anzahl und Größe der gespeicherten Cover.
#[tauri::command]
pub async fn cover_cache_stats(app: AppHandle) -> Result<CacheStats, String> {
    let root = cache_root(&app)?;
    tokio::task::spawn_blocking(move || cache_stats(&root))
        .await
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub removed: u32,
    pub bytes: u64,
}

/// Leert den Cover-Cache (Bilder, Dateilisten, Merker). Eigene Bilder neben den Spielen bleiben unberührt.
#[tauri::command]
pub async fn cover_cache_clear(
    app: AppHandle,
    covers: State<'_, Covers>,
) -> Result<ClearResult, String> {
    let root = cache_root(&app)?;
    let (removed, bytes) = tokio::task::spawn_blocking(move || cache_clear(&root))
        .await
        .map_err(|err| err.to_string())?;
    covers.forget_listings();
    Ok(ClearResult { removed, bytes })
}
