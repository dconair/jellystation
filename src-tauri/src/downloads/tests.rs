//! Tests der Download- und Installationsbefehle gegen einen kleinen lokalen HTTP-Server (kein Netz nötig).

use super::*;
use std::sync::atomic::AtomicU64;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/* ---------------------------------------------------------------- Aufbau */

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("dl-{tag}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDir(fs::canonicalize(path).unwrap())
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn payload() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 251) as u8).collect()
}

#[derive(Default)]
struct Server {
    /// Beim nächsten Abruf von /file.bin wird nach dieser Anzahl Bytes die Verbindung gekappt.
    cut_after: Mutex<Option<usize>>,
    requests: Mutex<Vec<String>>,
}

async fn serve(state: Arc<Server>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let state = state.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                lock(&state.requests).push(head.clone());
                let range = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").map(|r| r.trim_end_matches('-').to_string()))
                    .and_then(|r| r.parse::<usize>().ok());
                let data = payload();
                let (status, extra, body): (&str, String, Vec<u8>) = match path.as_str() {
                    "/file.bin" | "/sub/Spiel%20Eins.iso" => match range {
                        Some(start) if start < data.len() => (
                            "206 Partial Content",
                            format!("Content-Range: bytes {start}-{}/{}\r\nETag: \"v1\"\r\n", data.len() - 1, data.len()),
                            data[start..].to_vec(),
                        ),
                        _ => ("200 OK", "ETag: \"v1\"\r\n".into(), data),
                    },
                    "/named" => (
                        "200 OK",
                        "Content-Disposition: attachment; filename=\"../../Echter Name.bin\"\r\n".into(),
                        b"abc".to_vec(),
                    ),
                    "/page" => ("200 OK", "Content-Type: text/html\r\n".into(), b"<html>Anmelden</html>".to_vec()),
                    "/missing" => ("404 Not Found", String::new(), b"nein".to_vec()),
                    "/jump" => {
                        let port = sock.local_addr().unwrap().port();
                        (
                            "302 Found",
                            format!("Location: http://localhost:{port}/file.bin\r\n"),
                            Vec::new(),
                        )
                    }
                    _ => ("404 Not Found", String::new(), Vec::new()),
                };
                let cut = if path == "/file.bin" { lock(&state.cut_after).take() } else { None };
                let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
                let _ = sock.write_all(header.as_bytes()).await;
                match cut {
                    Some(n) => {
                        let _ = sock.write_all(&body[..n.min(body.len())]).await;
                        let _ = sock.flush().await;
                        // Verbindung hart schließen, bevor alles gesendet ist
                    }
                    None => {
                        let _ = sock.write_all(&body).await;
                    }
                }
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

fn request(port: u16, path: &str, dir: &Path) -> DownloadRequest {
    DownloadRequest {
        id: "t".into(),
        url: format!("http://127.0.0.1:{port}{path}"),
        dest_dir: dir.to_string_lossy().into_owned(),
        file_name: None,
        sha256: None,
        allowed_hosts: vec![],
        allow_http: true,
        block_executables: false,
    }
}

async fn run(req: DownloadRequest) -> (Result<DownloadResult, String>, Vec<Progress>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let result = run_download(req, Arc::new(AtomicBool::new(false)), &move |p| lock(&sink).push(p)).await;
    let list = lock(&events).clone();
    (result, list)
}

fn sha_of(bytes: &[u8]) -> String {
    let mut h = hashing::Sha256::new();
    h.update(bytes);
    hashing::hex(&h.finish())
}

/* ---------------------------------------------------------------- reine Funktionen */

#[test]
fn file_names_are_made_safe() {
    assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
    assert_eq!(sanitize_file_name("C:\\Windows\\evil.exe"), "evil.exe");
    assert_eq!(sanitize_file_name("a<b>c:d|e?.iso"), "a_b_c_d_e_.iso");
    assert_eq!(sanitize_file_name("..."), "download");
    assert_eq!(sanitize_file_name(".bashrc"), "_bashrc");
    assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
    assert_eq!(sanitize_file_name("Spiel. "), "Spiel");
    let long = format!("{}.iso", "x".repeat(400));
    let out = sanitize_file_name(&long);
    assert!(out.chars().count() <= 150 && out.ends_with(".iso"));
}

#[test]
fn hosts_are_matched_strictly() {
    let list = vec!["github.com".to_string(), "*.githubusercontent.com".to_string()];
    assert!(host_allowed("GitHub.com", &list));
    assert!(host_allowed("objects.githubusercontent.com", &list));
    assert!(!host_allowed("githubusercontent.com", &list));
    assert!(!host_allowed("evilgithub.com", &list));
    assert!(!host_allowed("github.com.evil.de", &list));
    assert!(!host_allowed("github.com", &[]));
}

#[test]
fn disposition_and_range_headers_are_parsed() {
    assert_eq!(name_from_disposition("attachment; filename=\"a b.iso\"").as_deref(), Some("a b.iso"));
    assert_eq!(name_from_disposition("attachment; filename=plain.bin; size=3").as_deref(), Some("plain.bin"));
    assert_eq!(
        name_from_disposition("attachment; filename=\"x.bin\"; filename*=UTF-8''Sp%C3%A4ter.bin").as_deref(),
        Some("Später.bin")
    );
    assert_eq!(name_from_disposition("inline"), None);
    assert_eq!(parse_content_range("bytes 100-199/200"), Some((100, Some(200))));
    assert_eq!(parse_content_range("bytes 100-199/*"), Some((100, None)));
    assert_eq!(parse_content_range("items 1-2/3"), None);
    assert_eq!(percent_decode("a%20b%zz%4"), "a b%zz%4");
}

#[test]
fn unique_path_never_overwrites() {
    let d = TempDir::new("unique");
    fs::write(d.0.join("a.iso"), b"1").unwrap();
    fs::write(d.0.join("a (2).iso"), b"1").unwrap();
    assert_eq!(unique_path(&d.0, "a.iso"), d.0.join("a (3).iso"));
    assert_eq!(unique_path(&d.0, "neu.iso"), d.0.join("neu.iso"));
}

/* ---------------------------------------------------------------- Download */

#[tokio::test]
async fn downloads_a_file_with_name_from_url_and_checks_sha256() {
    let port = serve(Arc::new(Server::default())).await;
    let d = TempDir::new("full");
    let mut req = request(port, "/sub/Spiel%20Eins.iso", &d.0);
    req.sha256 = Some(sha_of(&payload()).to_uppercase());
    let (res, events) = run(req).await;
    let res = res.unwrap();
    assert_eq!(res.file_name, "Spiel Eins.iso");
    assert_eq!(res.size, 300_000);
    assert!(!res.resumed && !res.already_present);
    assert_eq!(fs::read(&res.path).unwrap(), payload());
    assert!(!d.0.join("Spiel Eins.iso.part").exists());
    assert!(!d.0.join("Spiel Eins.iso.part.json").exists());
    assert_eq!(events.last().unwrap().state, "done");
    assert!(events.iter().any(|e| e.state == "verifying"));
}

#[tokio::test]
async fn wrong_checksum_discards_the_file() {
    let port = serve(Arc::new(Server::default())).await;
    let d = TempDir::new("badsha");
    let mut req = request(port, "/file.bin", &d.0);
    req.sha256 = Some("0".repeat(64));
    let (res, events) = run(req).await;
    assert!(res.unwrap_err().contains("Prüfsumme"));
    assert!(!d.0.join("file.bin").exists());
    assert!(!d.0.join("file.bin.part").exists());
    assert_eq!(events.last().unwrap().state, "failed");
}

#[tokio::test]
async fn an_interrupted_download_is_resumed() {
    let state = Arc::new(Server::default());
    *lock(&state.cut_after) = Some(100_000);
    let port = serve(state.clone()).await;
    let d = TempDir::new("resume");
    let (first, events) = run(request(port, "/file.bin", &d.0)).await;
    assert!(first.is_err(), "gekappte Verbindung muss als Fehler enden");
    let part = d.0.join("file.bin.part");
    assert!(part.exists());
    assert_eq!(events.last().unwrap().state, "failed");
    assert!(events.last().unwrap().part_path.is_some());
    let have = fs::metadata(&part).unwrap().len();
    assert!(have > 0 && have < 300_000);

    let mut req = request(port, "/file.bin", &d.0);
    req.sha256 = Some(sha_of(&payload()));
    let (second, _) = run(req).await;
    let second = second.unwrap();
    assert!(second.resumed);
    assert_eq!(fs::read(&second.path).unwrap(), payload());
    assert!(lock(&state.requests).iter().any(|r| r.to_ascii_lowercase().contains(&format!("range: bytes={have}-"))));
}

#[tokio::test]
async fn existing_files_are_not_overwritten_or_reloaded() {
    let port = serve(Arc::new(Server::default())).await;
    let d = TempDir::new("exists");
    fs::write(d.0.join("file.bin"), b"anders").unwrap();
    let (res, _) = run(request(port, "/file.bin", &d.0)).await;
    let res = res.unwrap();
    assert_eq!(res.file_name, "file (2).bin");
    assert_eq!(fs::read(d.0.join("file.bin")).unwrap(), b"anders");

    // Ist die vorhandene Datei gleich groß, wird nichts geladen.
    let (again, _) = run(request(port, "/file.bin", &d.0)).await;
    let _ = again.unwrap();
    fs::write(d.0.join("file.bin"), payload()).unwrap();
    let (res, _) = run(request(port, "/file.bin", &d.0)).await;
    assert!(res.unwrap().already_present);
}

#[tokio::test]
async fn uses_the_name_from_content_disposition_without_path_parts() {
    let port = serve(Arc::new(Server::default())).await;
    let d = TempDir::new("named");
    let (res, _) = run(request(port, "/named", &d.0)).await;
    assert_eq!(res.unwrap().file_name, "Echter Name.bin");
    assert!(d.0.join("Echter Name.bin").exists());
}

#[tokio::test]
async fn rejects_pages_errors_other_hosts_and_programs() {
    let port = serve(Arc::new(Server::default())).await;
    let d = TempDir::new("rejects");
    let (page, _) = run(request(port, "/page", &d.0)).await;
    assert!(page.unwrap_err().contains("Webseite"));
    let (missing, _) = run(request(port, "/missing", &d.0)).await;
    assert!(missing.unwrap_err().contains("nicht gefunden"));
    // Weiterleitung auf einen anderen Servernamen (localhost statt 127.0.0.1) ist nicht erlaubt.
    let (jump, _) = run(request(port, "/jump", &d.0)).await;
    assert!(jump.is_err());
    // ... aber erlaubt, wenn der Nutzer beide Server nennt.
    let mut allowed = request(port, "/jump", &d.0);
    allowed.allowed_hosts = vec!["127.0.0.1".into(), "localhost".into()];
    assert!(run(allowed).await.0.is_ok());

    let mut exe = request(port, "/file.bin", &d.0);
    exe.file_name = Some("setup.exe".into());
    exe.block_executables = true;
    assert!(run(exe).await.0.unwrap_err().contains(".exe"));

    let mut https_only = request(port, "/file.bin", &d.0);
    https_only.allow_http = false;
    assert!(run(https_only).await.0.unwrap_err().contains("https"));
    let mut wrong = request(port, "/file.bin", &d.0);
    wrong.url = "ftp://127.0.0.1/x".into();
    assert!(run(wrong).await.0.is_err());
}

#[tokio::test]
async fn cancelling_keeps_the_part_for_later() {
    let port = serve(Arc::new(Server::default())).await;
    let d = TempDir::new("cancel");
    let cancel = Arc::new(AtomicBool::new(true));
    let res = run_download(request(port, "/file.bin", &d.0), cancel, &|_| {}).await;
    assert_eq!(res.unwrap_err(), CANCELLED);
    assert!(!d.0.join("file.bin").exists());
}

#[test]
fn discard_only_touches_part_files() {
    let d = TempDir::new("discard");
    let part = d.0.join("x.iso.part");
    fs::write(&part, b"1").unwrap();
    fs::write(d.0.join("x.iso.part.json"), b"{}").unwrap();
    fs::write(d.0.join("x.iso"), b"fertig").unwrap();
    assert!(download_discard(d.0.join("x.iso").to_string_lossy().into_owned()).is_err());
    download_discard(part.to_string_lossy().into_owned()).unwrap();
    assert!(!part.exists() && !d.0.join("x.iso.part.json").exists());
    assert!(d.0.join("x.iso").exists());
}

/* ---------------------------------------------------------------- Installation */

#[cfg(target_os = "linux")]
#[test]
fn installs_a_tar_archive_and_finds_the_program_without_losing_user_data() {
    let d = TempDir::new("install");
    let src = d.0.join("src/Emu-1.0");
    fs::create_dir_all(src.join("bin")).unwrap();
    fs::write(src.join("bin/emu.exe"), b"programm").unwrap();
    fs::write(src.join("readme.txt"), b"neu").unwrap();
    let archive = d.0.join("emu.tar.gz");
    run_tool("tar", &["-czf", &archive.to_string_lossy(), "-C", &d.0.join("src").to_string_lossy(), "Emu-1.0"]).unwrap();

    let root = d.0.join("Emulators");
    // Bereits vorhandene Benutzerdaten bleiben beim Update erhalten.
    fs::create_dir_all(root.join("emu")).unwrap();
    fs::write(root.join("emu/config.yml"), b"meine einstellungen").unwrap();

    let req = InstallRequest {
        archive: archive.to_string_lossy().into_owned(),
        id: "emu".into(),
        dest_root: root.to_string_lossy().into_owned(),
        exe_pattern: Some("^EMU\\.exe$".into()),
        remove_archive: false,
    };
    let res = install_sync(&req).unwrap();
    assert!(res.path.ends_with("emu.exe"), "{}", res.path);
    assert_eq!(fs::read(root.join("emu/config.yml")).unwrap(), b"meine einstellungen");
    assert_eq!(fs::read(root.join("emu/readme.txt")).unwrap(), b"neu");
    // Temporärer Ordner ist weg.
    assert!(fs::read_dir(&root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".jellystation-install")));

    let mut missing = req.clone();
    missing.exe_pattern = Some("^gibtesnicht\\.exe$".into());
    assert!(install_sync(&missing).unwrap_err().contains("Programmdatei"));
    missing.exe_pattern = Some("(".into());
    assert!(install_sync(&missing).is_err());
    let mut bad = req.clone();
    bad.archive = d.0.join("nix.zip").to_string_lossy().into_owned();
    assert!(install_sync(&bad).unwrap_err().contains("nicht gefunden"));

    let mut remove = req.clone();
    remove.remove_archive = true;
    install_sync(&remove).unwrap();
    assert!(!archive.exists(), "das Archiv wird nach dem Einspielen gelöscht");
}
