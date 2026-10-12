//! Lokales Umwandeln von Stream-Adressen mit ffmpeg (Befehle `transcode_start` und `transcode_stop`).
//!
//! Wofür: Stremio-Addons liefern direkte Links (meist MKV mit HEVC, DTS …), und ein Jellyfin-Server, der umwandeln
//! könnte, gehört nicht dazu. Das WebView kann solche Dateien oft nicht abspielen. Dieses Modul baut daraus lokal einen
//! HLS-Strom: ein kleiner HTTP-Server nur auf 127.0.0.1 (mit zufälligem Token im Pfad) liefert eine VOD-Wiedergabeliste mit
//! festen Segmenten, und jedes Segment wird erst beim Abruf von einem eigenen ffmpeg-Aufruf erzeugt (H.264/AAC in
//! MPEG-TS). So klappen Springen, Dauer und Fortsetzen wie bei einem Server, ohne die ganze Datei vorab umzuwandeln.
//!
//! ffmpeg bringt JellyStation nicht mit: es wird im PATH und an den üblichen Installationsorten gesucht
//! (`JELLYSTATION_FFMPEG` überschreibt das). Fehlt es, meldet `transcode_start` den Fehler `ffmpeg_missing`.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OnceCell, Semaphore};
use tokio::task::JoinSet;

/// Länge eines Segments in Sekunden (der letzte ist kürzer).
const SEGMENT_SECS: f64 = 6.0;
/// Wie viele Segmente gleichzeitig umgewandelt werden (Springen lässt sonst viele ffmpeg-Aufrufe auflaufen).
const MAX_PARALLEL: usize = 2;
/// Wie viele fertige Segmente im Speicher bleiben.
const CACHE_SEGMENTS: usize = 16;
/// Höchste Größe der Anfrage-Kopfzeilen.
const MAX_REQUEST: usize = 16 * 1024;
/// Protokolle, die ffmpeg für die Quelle öffnen darf (nie `file:`).
const NET_PROTOCOLS: &str = "http,https,tcp,tls,crypto";
/// Fehlertext, wenn kein ffmpeg gefunden wurde (die Oberfläche erkennt ihn daran).
pub const FFMPEG_MISSING: &str = "ffmpeg_missing";

/// Was die Oberfläche über den umgewandelten Strom erfährt.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeInfo {
    /// Adresse der Wiedergabeliste (`http://127.0.0.1:PORT/t/TOKEN/index.m3u8`).
    pub url: String,
    pub duration_sec: f64,
    /// Bild- und Tonformat der Quelle, wie ffmpeg sie nennt (z. B. „hevc“, „dts“).
    pub video: Option<String>,
    pub audio: Option<String>,
}

/* ---------------------------------------------------------------- ffmpeg */

fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Kein Konsolenfenster aufblitzen lassen.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(Stdio::null());
    cmd
}

fn candidates() -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    if let Some(custom) = std::env::var_os("JELLYSTATION_FFMPEG") {
        list.push(PathBuf::from(custom));
    }
    list.push(PathBuf::from("ffmpeg"));
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            list.push(PathBuf::from(local).join("Microsoft/WinGet/Links/ffmpeg.exe"));
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            list.push(PathBuf::from(home).join("scoop/shims/ffmpeg.exe"));
        }
        for dir in ["ProgramFiles", "ProgramData"] {
            if let Some(base) = std::env::var_os(dir) {
                list.push(PathBuf::from(&base).join("ffmpeg/bin/ffmpeg.exe"));
                list.push(PathBuf::from(&base).join("chocolatey/bin/ffmpeg.exe"));
            }
        }
        list.push(PathBuf::from("C:/ffmpeg/bin/ffmpeg.exe"));
    }
    #[cfg(not(windows))]
    {
        // Programme aus dem Finder starten ohne den PATH der Shell: die üblichen Orte einzeln prüfen.
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"] {
            list.push(PathBuf::from(dir).join("ffmpeg"));
        }
    }
    list
}

/// Das erste ffmpeg, das sich starten lässt.
pub fn find_ffmpeg() -> Option<PathBuf> {
    candidates().into_iter().find(|path| {
        command(path)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

/// Kennzahlen der Quelle, gelesen aus der Textausgabe von `ffmpeg -i`.
#[derive(Debug, Clone, PartialEq)]
struct Probe {
    duration: f64,
    video: Option<String>,
    audio: Option<String>,
}

fn parse_clock(text: &str) -> Option<f64> {
    let mut parts = text.trim().split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn parse_probe(stderr: &str) -> Option<Probe> {
    let mut duration = None;
    let mut video = None;
    let mut audio = None;
    for line in stderr.lines() {
        let line = line.trim();
        if duration.is_none() {
            if let Some(rest) = line.strip_prefix("Duration:") {
                duration = rest.split(',').next().and_then(parse_clock);
            }
        }
        if line.starts_with("Stream #") {
            let codec_after = |marker: &str| {
                line.split(marker)
                    .nth(1)
                    .and_then(|rest| rest.split(|c: char| c == ' ' || c == ',').next())
                    .map(str::to_owned)
            };
            if video.is_none() && line.contains(": Video:") {
                video = codec_after(": Video: ");
            } else if audio.is_none() && line.contains(": Audio:") {
                audio = codec_after(": Audio: ");
            }
        }
    }
    Some(Probe { duration: duration.filter(|d| *d > 0.0)?, video, audio })
}

/// Optionen, die jede Verbindung zur Quelle bekommt: nur Netzprotokolle, Wiederverbinden, Zeitlimit.
/// (Wiederverbinden und Zeitlimit kennen nur die Netzprotokolle; für Dateien im Test entfallen sie.)
fn input_args(protocols: &str) -> Vec<String> {
    let mut args = vec!["-protocol_whitelist".to_string(), protocols.to_string()];
    if !protocols.contains("file") {
        args.extend(
            ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "20000000"]
                .iter()
                .map(|s| s.to_string()),
        );
    }
    args
}

fn probe_source(ffmpeg: &Path, url: &str, protocols: &str) -> Result<Probe, String> {
    // Ohne Ausgabe endet ffmpeg mit einem Fehlercode, die Angaben zur Quelle stehen trotzdem auf stderr.
    let output = command(ffmpeg)
        .args(["-hide_banner", "-nostdin"])
        .args(input_args(protocols))
        .args(["-i", url])
        .output()
        .map_err(|err| format!("ffmpeg ließ sich nicht starten: {err}"))?;
    let text = String::from_utf8_lossy(&output.stderr);
    parse_probe(&text).ok_or_else(|| {
        let last = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("keine Ausgabe");
        format!("ffmpeg kann die Quelle nicht lesen oder kennt ihre Dauer nicht ({})", last.trim())
    })
}

/// Wandelt ein Segment der Quelle in H.264/AAC (MPEG-TS) um. Die Zeitstempel behalten die Lage in der Quelle,
/// damit die Segmente nahtlos aneinanderpassen.
fn make_segment(ffmpeg: &Path, url: &str, protocols: &str, start: f64, len: f64) -> Result<Vec<u8>, String> {
    let output = command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(input_args(protocols))
        .args(["-ss", &format!("{start:.3}"), "-i", url, "-t", &format!("{len:.3}")])
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"])
        // Bild: höchstens Full HD, ohne B-Bilder, damit jedes Segment bei seiner Zeit beginnt.
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-bf", "0", "-pix_fmt", "yuv420p"])
        .args(["-vf", "scale=w='min(1920,iw)':h=-2"])
        // Ton: Stereo-AAC, das jedes WebView dekodiert.
        .args(["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-af", "aresample=async=1:first_pts=0"])
        .args(["-output_ts_offset", &format!("{start:.3}"), "-muxdelay", "0", "-muxpreload", "0"])
        .args(["-f", "mpegts", "pipe:1"])
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .output()
        .map_err(|err| format!("ffmpeg ließ sich nicht starten: {err}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        let text = String::from_utf8_lossy(&output.stderr);
        let last = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("keine Ausgabe");
        return Err(format!("Umwandeln fehlgeschlagen: {}", last.trim()));
    }
    Ok(output.stdout)
}

/* ------------------------------------------------------------ Wiedergabeliste */

fn segment_count(duration: f64) -> usize {
    (duration / SEGMENT_SECS).ceil().max(1.0) as usize
}

/// Beginn und Länge des Segments `index`.
fn segment_span(duration: f64, index: usize) -> (f64, f64) {
    let start = index as f64 * SEGMENT_SECS;
    (start, (duration - start).min(SEGMENT_SECS).max(0.0))
}

fn playlist(duration: f64) -> String {
    let mut text = String::from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n");
    text.push_str(&format!("#EXT-X-TARGETDURATION:{}\n#EXT-X-MEDIA-SEQUENCE:0\n", SEGMENT_SECS.ceil() as u32));
    for index in 0..segment_count(duration) {
        let (_, len) = segment_span(duration, index);
        text.push_str(&format!("#EXTINF:{len:.3},\nseg{index}.ts\n"));
    }
    text.push_str("#EXT-X-ENDLIST\n");
    text
}

/* -------------------------------------------------------------------- Server */

type Segment = Arc<OnceCell<Option<Arc<Vec<u8>>>>>;

struct Shared {
    token: String,
    ffmpeg: PathBuf,
    url: String,
    protocols: String,
    duration: f64,
    cache: Mutex<HashMap<usize, Segment>>,
    slots: Semaphore,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    /// Das Segment `index` (aus dem Speicher oder frisch umgewandelt). Gleichzeitige Abrufe teilen sich eine Arbeit.
    async fn segment(self: &Arc<Self>, index: usize) -> Result<Arc<Vec<u8>>, String> {
        let cell = {
            let mut cache = lock(&self.cache);
            if cache.len() >= CACHE_SEGMENTS && !cache.contains_key(&index) {
                // Das am weitesten entfernte Segment verwerfen.
                if let Some(far) = cache.keys().copied().max_by_key(|k| k.abs_diff(index)) {
                    cache.remove(&far);
                }
            }
            Arc::clone(cache.entry(index).or_default())
        };
        let me = Arc::clone(self);
        let made = cell
            .get_or_init(|| async move {
                let _slot = me.slots.acquire().await.ok()?;
                let (start, len) = segment_span(me.duration, index);
                let inner = Arc::clone(&me);
                let result = tokio::task::spawn_blocking(move || {
                    make_segment(&inner.ffmpeg, &inner.url, &inner.protocols, start, len)
                })
                .await;
                match result {
                    Ok(Ok(bytes)) => Some(Arc::new(bytes)),
                    Ok(Err(_)) | Err(_) => None,
                }
            })
            .await;
        match made {
            Some(bytes) => Ok(Arc::clone(bytes)),
            None => {
                // Fehlgeschlagene Arbeit nicht merken, damit ein neuer Abruf es noch einmal versucht.
                lock(&self.cache).remove(&index);
                Err("Das Segment ließ sich nicht umwandeln".to_string())
            }
        }
    }
}

struct Reply {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
}

impl Reply {
    fn text(status: &'static str, text: &str) -> Self {
        Reply { status, content_type: "text/plain; charset=utf-8", body: text.as_bytes().to_vec() }
    }
}

async fn route(shared: &Arc<Shared>, method: &str, path: &str) -> Reply {
    if method == "OPTIONS" {
        return Reply { status: "204 No Content", content_type: "text/plain", body: Vec::new() };
    }
    if method != "GET" && method != "HEAD" {
        return Reply::text("405 Method Not Allowed", "nur GET");
    }
    let path = path.split('?').next().unwrap_or("");
    let Some(rest) = path.strip_prefix("/t/") else {
        return Reply::text("404 Not Found", "unbekannt");
    };
    let (token, name) = rest.split_once('/').unwrap_or((rest, ""));
    if !bool::from(token.as_bytes().ct_eq(shared.token.as_bytes())) {
        return Reply::text("403 Forbidden", "falscher Token");
    }
    if name == "index.m3u8" {
        return Reply {
            status: "200 OK",
            content_type: "application/vnd.apple.mpegurl",
            body: playlist(shared.duration).into_bytes(),
        };
    }
    let index = name
        .strip_prefix("seg")
        .and_then(|n| n.strip_suffix(".ts"))
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|i| *i < segment_count(shared.duration));
    let Some(index) = index else {
        return Reply::text("404 Not Found", "unbekannt");
    };
    match shared.segment(index).await {
        Ok(bytes) => Reply { status: "200 OK", content_type: "video/mp2t", body: bytes.as_ref().clone() },
        Err(message) => Reply::text("502 Bad Gateway", &message),
    }
}

async fn handle(shared: Arc<Shared>, mut stream: TcpStream) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let head = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                return Some(());
            }
            if buffer.len() > MAX_REQUEST {
                return None;
            }
        }
    })
    .await;
    if !matches!(head, Ok(Some(()))) {
        return;
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut first = text.lines().next().unwrap_or("").split_whitespace();
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let reply = route(&shared, method, path).await;
    let head_only = method == "HEAD";
    let header = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n",
        reply.status,
        reply.content_type,
        reply.body.len()
    );
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }
    if !head_only {
        let _ = stream.write_all(&reply.body).await;
    }
    let _ = stream.shutdown().await;
}

async fn serve(listener: StdTcpListener, shared: Arc<Shared>) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    // Das JoinSet bricht beim Beenden alle Verbindungs-Tasks ab.
    let mut connections = JoinSet::new();
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        while connections.try_join_next().is_some() {}
        connections.spawn(handle(Arc::clone(&shared), stream));
    }
}

/// Der Umwandler als Tauri-State: höchstens ein Strom (ein neuer ersetzt den alten).
#[derive(Default)]
pub struct Transcode {
    running: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// Prüft die Adresse, findet ffmpeg und liest die Quelle (blockiert, bis ffmpeg antwortet).
fn prepare(url: &str, protocols: &str, ffmpeg: Option<PathBuf>) -> Result<(PathBuf, Probe), String> {
    let ffmpeg = ffmpeg.or_else(find_ffmpeg).ok_or_else(|| FFMPEG_MISSING.to_string())?;
    let probe = probe_source(&ffmpeg, url, protocols)?;
    Ok((ffmpeg, probe))
}

fn valid_source(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url)
    } else {
        Err("Nur http(s)-Adressen lassen sich umwandeln".to_string())
    }
}

impl Transcode {
    /// Startet den Server für eine geprüfte Quelle. Läuft schon einer, wird er beendet.
    fn launch(&self, ffmpeg: &Path, url: &str, protocols: &str, probe: Probe) -> Result<TranscodeInfo, String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|err| format!("Zufallszahlen sind nicht verfügbar: {err}"))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();

        let listener = StdTcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|err| format!("Umwandler konnte nicht gestartet werden: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("Umwandler konnte nicht gestartet werden: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("Umwandler konnte nicht gestartet werden: {err}"))?
            .port();

        let shared = Arc::new(Shared {
            token: token.clone(),
            ffmpeg: ffmpeg.to_path_buf(),
            url: url.to_string(),
            protocols: protocols.to_string(),
            duration: probe.duration,
            cache: Mutex::new(HashMap::new()),
            slots: Semaphore::new(MAX_PARALLEL),
        });
        let task = tauri::async_runtime::spawn(serve(listener, shared));
        if let Some(old) = lock(&self.running).replace(task) {
            old.abort();
        }
        Ok(TranscodeInfo {
            url: format!("http://127.0.0.1:{port}/t/{token}/index.m3u8"),
            duration_sec: probe.duration,
            video: probe.video,
            audio: probe.audio,
        })
    }

    pub fn stop(&self) {
        if let Some(task) = lock(&self.running).take() {
            task.abort();
        }
    }
}

impl Drop for Transcode {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Startet das lokale Umwandeln einer Stream-Adresse. Fehler `ffmpeg_missing`: ffmpeg ist nicht installiert.
#[tauri::command]
pub async fn transcode_start(state: tauri::State<'_, Transcode>, url: String) -> Result<TranscodeInfo, String> {
    let url = valid_source(&url)?.to_string();
    // Das Prüfen der Quelle startet ffmpeg und wartet aufs Netz: nicht auf einem Runtime-Thread.
    let source = url.clone();
    let (ffmpeg, probe) =
        tauri::async_runtime::spawn_blocking(move || prepare(&source, NET_PROTOCOLS, None))
            .await
            .map_err(|err| format!("Umwandler abgebrochen: {err}"))??;
    state.launch(&ffmpeg, &url, NET_PROTOCOLS, probe)
}

/// Beendet das lokale Umwandeln.
#[tauri::command]
pub async fn transcode_stop(state: tauri::State<'_, Transcode>) -> Result<(), String> {
    state.stop();
    Ok(())
}

#[cfg(test)]
mod tests;
