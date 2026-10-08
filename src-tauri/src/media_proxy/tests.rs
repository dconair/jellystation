//! Tests des Medien-Proxys.
//!
//! Aufbau: Ein Mock-Jellyfin (hyper auf 127.0.0.1:0) läuft im Test-Prozess, davor der echte Proxy, davor ein Client
//! (reqwest oder – für Pfad-Tricks und exakte Bytes – ein roher TCP-Client).

use super::*;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering::SeqCst};
use std::time::Instant;

use futures_util::stream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEY: &str = "KEY123abc";
const DATA_SIZE: u64 = 1_000_000;
const BIG_SIZE: u64 = 50 * 1024 * 1024;
/// Wird nie ganz übertragen: macht sichtbar, ob der Proxy irgendwo unbegrenzt puffert.
const HUGE_SIZE: u64 = 512 * 1024 * 1024;

fn pattern(index: u64) -> u8 {
    (index % 251) as u8
}

fn pattern_bytes(start: u64, len: u64) -> Vec<u8> {
    (0..len).map(|i| pattern(start + i)).collect()
}

fn matches_pattern(start: u64, data: &[u8]) -> bool {
    data.iter()
        .enumerate()
        .all(|(i, byte)| *byte == pattern(start + i as u64))
}

/* ------------------------------------------------------------------------------------ Mock-Jellyfin */

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Default)]
struct UpState {
    port: AtomicU16,
    foreign_port: AtomicU16,
    requests: Mutex<Vec<Recorded>>,
    hang_started: AtomicBool,
    hang_dropped: AtomicBool,
    stall_dropped: AtomicBool,
    big_sent: AtomicU64,
    big_dropped: AtomicBool,
}

struct Upstream {
    port: u16,
    state: Arc<UpState>,
}

impl Upstream {
    async fn start() -> Upstream {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(UpState::default());
        state.port.store(port, SeqCst);
        let shared = Arc::clone(&state);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let shared = Arc::clone(&shared);
                tokio::spawn(async move {
                    let service = service_fn(move |request| upstream(Arc::clone(&shared), request));
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Upstream { port, state }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn requests(&self) -> Vec<Recorded> {
        self.state.requests.lock().unwrap().clone()
    }
}

fn text_response(status: u16, content_type: &str, body: impl Into<Bytes>) -> Response<ProxyBody> {
    let body: Bytes = body.into();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, body.len())
        .body(full_body(body))
        .unwrap()
}

/// Wertet `Range: bytes=…` für eine Datei der Größe `total` aus: `None` = keine Angabe, `Some(Err)` = nicht erfüllbar.
fn parse_range(header: Option<&str>, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header?.strip_prefix("bytes=")?;
    let (from, to) = spec.split_once('-')?;
    let range = match (from.parse::<u64>().ok(), to.parse::<u64>().ok()) {
        (Some(from), Some(to)) => (from, to.min(total - 1)),
        (Some(from), None) => (from, total - 1),
        (None, Some(suffix)) if suffix > 0 => (total.saturating_sub(suffix), total - 1),
        _ => return Some(Err(())),
    };
    Some(if range.0 >= total || range.0 > range.1 {
        Err(())
    } else {
        Ok(range)
    })
}

struct DropFlag(Arc<UpState>, fn(&UpState) -> &AtomicBool);

impl Drop for DropFlag {
    fn drop(&mut self) {
        (self.1)(&self.0).store(true, SeqCst);
    }
}

fn big_body(state: Arc<UpState>, start: u64, end: u64) -> ProxyBody {
    let guard = DropFlag(state, |s| &s.big_dropped);
    let chunks = stream::unfold((start, guard), move |(position, guard)| async move {
        if position > end {
            return None;
        }
        let len = (end - position + 1).min(64 * 1024);
        guard.0.big_sent.fetch_add(len, SeqCst);
        let chunk = Bytes::from(pattern_bytes(position, len));
        Some((
            Ok::<_, io::Error>(Frame::data(chunk)),
            (position + len, guard),
        ))
    });
    StreamBody::new(chunks).boxed_unsync()
}

fn file_response(
    request: &Request<Incoming>,
    total: u64,
    content_type: &str,
    body: impl Fn(u64, u64) -> ProxyBody,
) -> Response<ProxyBody> {
    let range = parse_range(
        request.headers().get(RANGE).and_then(|v| v.to_str().ok()),
        total,
    );
    let head = request.method() == Method::HEAD;
    if request
        .headers()
        .get(IF_NONE_MATCH)
        .is_some_and(|v| v == "\"v1\"")
    {
        return Response::builder()
            .status(304)
            .header(ETAG, "\"v1\"")
            .header(CACHE_CONTROL, "public, max-age=60")
            .body(empty_body())
            .unwrap();
    }
    let mut builder = Response::builder()
        .header(CONTENT_TYPE, content_type)
        .header(ACCEPT_RANGES, "bytes")
        .header(ETAG, "\"v1\"")
        .header(LAST_MODIFIED, "Wed, 21 Oct 2015 07:28:00 GMT")
        .header(CACHE_CONTROL, "public, max-age=60");
    let (start, end) = match range {
        None => {
            builder = builder.status(200);
            (0, total - 1)
        }
        Some(Ok((start, end))) => {
            builder = builder
                .status(206)
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
            (start, end)
        }
        Some(Err(())) => {
            return Response::builder()
                .status(416)
                .header(CONTENT_RANGE, format!("bytes */{total}"))
                .header(CONTENT_LENGTH, 0)
                .body(empty_body())
                .unwrap();
        }
    };
    builder = builder.header(CONTENT_LENGTH, end - start + 1);
    builder
        .body(if head { empty_body() } else { body(start, end) })
        .unwrap()
}

fn media_playlist(port: u16) -> String {
    format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n\
         #EXT-X-MAP:URI=\"/videos/ID/hls1/main/-1.mp4?DeviceId=abc\"\n\
         #EXTINF:6.000000,\nhttp://127.0.0.1:{port}/videos/ID/hls1/main/0.mp4?DeviceId=abc\n\
         #EXTINF:6.000000,\nhls1/main/1.mp4?DeviceId=abc\n\
         #EXTINF:6.000000,\n/videos/ID/hls1/main/2.mp4?DeviceId=abc\n\
         #EXT-X-KEY:METHOD=AES-128,URI=\"skd://key-id\"\n#EXT-X-ENDLIST\n"
    )
}

const MASTER_PLAYLIST: &str = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=735674,AVERAGE-BANDWIDTH=700000,CODECS=\"vp09.00.10.08,opus\",RESOLUTION=640x360,FRAME-RATE=25.000\n\
main.m3u8?DeviceId=abc&MediaSourceId=def&PlaySessionId=ps&api_key=KEY123abc\n";

async fn upstream(
    state: Arc<UpState>,
    request: Request<Incoming>,
) -> Result<Response<ProxyBody>, Infallible> {
    let recorded = Recorded {
        method: request.method().to_string(),
        target: request
            .uri()
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_default(),
        headers: request
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect(),
    };
    let echo: String = std::iter::once(format!("{} {}", recorded.method, recorded.target))
        .chain(
            recorded
                .headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}")),
        )
        .collect::<Vec<_>>()
        .join("\n");
    state.requests.lock().unwrap().push(recorded);

    let port = state.port.load(SeqCst);
    let path = request.uri().path().to_string();
    let response = match path.as_str() {
        "/echo" => text_response(200, "text/plain", echo),
        "/data" => file_response(&request, DATA_SIZE, "video/mp4", |start, end| {
            full_body(Bytes::from(pattern_bytes(start, end - start + 1)))
        }),
        "/big" => {
            let shared = Arc::clone(&state);
            file_response(&request, BIG_SIZE, "video/mp4", move |start, end| {
                big_body(Arc::clone(&shared), start, end)
            })
        }
        "/huge" => {
            let shared = Arc::clone(&state);
            file_response(&request, HUGE_SIZE, "video/mp4", move |start, end| {
                big_body(Arc::clone(&shared), start, end)
            })
        }
        "/zeros" => {
            let chunk = Bytes::from(vec![0u8; 64 * 1024]);
            let chunks = stream::iter(
                (0..8192).map(move |_| Ok::<_, io::Error>(Frame::data(chunk.clone()))),
            );
            Response::builder()
                .status(200)
                .header(CONTENT_TYPE, "video/mp4")
                .header(CONTENT_LENGTH, 8192u64 * 64 * 1024)
                .body(StreamBody::new(chunks).boxed_unsync())
                .unwrap()
        }
        "/s404" => text_response(404, "text/plain", "nope"),
        "/s204" => Response::builder().status(204).body(empty_body()).unwrap(),
        "/redir-same" => Response::builder()
            .status(302)
            .header(LOCATION, "/data")
            .body(empty_body())
            .unwrap(),
        "/redir-abs" => Response::builder()
            .status(301)
            .header(LOCATION, format!("http://127.0.0.1:{port}/data"))
            .body(empty_body())
            .unwrap(),
        "/redir-loop" => Response::builder()
            .status(302)
            .header(LOCATION, "/redir-loop")
            .body(empty_body())
            .unwrap(),
        "/redir-foreign" => Response::builder()
            .status(302)
            .header(
                LOCATION,
                format!(
                    "http://127.0.0.1:{}/secret",
                    state.foreign_port.load(SeqCst)
                ),
            )
            .body(empty_body())
            .unwrap(),
        "/redir-scheme" => Response::builder()
            .status(302)
            .header(LOCATION, format!("https://127.0.0.1:{port}/data"))
            .body(empty_body())
            .unwrap(),
        "/redir-proto-relative" => Response::builder()
            .status(302)
            .header(LOCATION, "//evil.invalid/x")
            .body(empty_body())
            .unwrap(),
        "/hls/master.m3u8" => text_response(200, "application/vnd.apple.mpegurl", MASTER_PLAYLIST),
        "/videos/ID/main.m3u8" => text_response(200, "application/x-mpegURL", media_playlist(port)),
        // Wiedergabeliste ohne .m3u8 im Pfad: nur am Content-Type erkennbar
        "/Videos/ID/playlist" => text_response(
            200,
            "application/vnd.apple.mpegurl; charset=utf-8",
            media_playlist(port),
        ),
        "/hls/huge.m3u8" => {
            let line = Bytes::from_static(b"#EXT-X-COMMENT:0123456789012345678901234567890123456789012345678901234567890123\n");
            let chunks = stream::iter(
                (0..80_000).map(move |_| Ok::<_, io::Error>(Frame::data(line.clone()))),
            );
            Response::builder()
                .status(200)
                .header(CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .body(StreamBody::new(chunks).boxed_unsync())
                .unwrap()
        }
        "/hang" => {
            state.hang_started.store(true, SeqCst);
            let _guard = DropFlag(Arc::clone(&state), |s| &s.hang_dropped);
            std::future::pending::<()>().await;
            unreachable!()
        }
        "/slow-headers" => {
            tokio::time::sleep(Duration::from_secs(5)).await;
            text_response(200, "text/plain", "spät")
        }
        "/stall" => {
            let guard = DropFlag(Arc::clone(&state), |s| &s.stall_dropped);
            let chunks = stream::unfold((0u8, guard), |(step, guard)| async move {
                if step == 0 {
                    Some((
                        Ok::<_, io::Error>(Frame::data(Bytes::from_static(b"0123456789"))),
                        (1, guard),
                    ))
                } else {
                    std::future::pending::<()>().await;
                    None
                }
            });
            Response::builder()
                .status(200)
                .header(CONTENT_TYPE, "video/mp4")
                .header(CONTENT_LENGTH, 1000)
                .body(StreamBody::new(chunks).boxed_unsync())
                .unwrap()
        }
        other if other.starts_with("/videos/ID/hls1/main/") => {
            text_response(200, "video/mp4", pattern_bytes(0, 1000))
        }
        _ => text_response(404, "text/plain", "unbekannt"),
    };
    Ok(response)
}

/* ------------------------------------------------------------------------------ Roher TCP-Client */

#[derive(Debug)]
struct Raw {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Raw {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[..line_end]).trim(), 16)
            .unwrap_or(0);
        data = &data[line_end + 2..];
        if size == 0 || data.len() < size {
            out.extend_from_slice(&data[..data.len().min(size)]);
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or_default();
    }
    out
}

fn parse_raw(bytes: &[u8]) -> Option<Raw> {
    let split = bytes.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&bytes[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();
    let mut body = bytes[split + 4..].to_vec();
    if headers.iter().any(|(n, v)| {
        n.eq_ignore_ascii_case("transfer-encoding") && v.eq_ignore_ascii_case("chunked")
    }) {
        body = dechunk(&body);
    }
    Some(Raw {
        status,
        headers,
        body,
    })
}

/// Sendet die Anfrage unverändert und liest bis zum Ende der Verbindung (die Anfrage braucht `Connection: close`).
async fn raw_send(port: u16, request: &[u8]) -> Option<Raw> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    stream.write_all(request).await.ok()?;
    let mut data = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut data)).await;
    parse_raw(&data)
}

fn request_text(method: &str, target: &str, headers: &[(&str, &str)]) -> Vec<u8> {
    let mut text =
        format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    for (name, value) in headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    text.push_str("\r\n");
    text.into_bytes()
}

/* ----------------------------------------------------------------------------------------- Aufbau */

struct Fixture {
    up: Upstream,
    proxy: MediaProxy,
    prefix: String,
    port: u16,
    token: String,
    http: reqwest::Client,
}

impl Fixture {
    async fn new() -> Fixture {
        Fixture::with_timeouts(Timeouts::default()).await
    }

    async fn with_timeouts(timeouts: Timeouts) -> Fixture {
        let up = Upstream::start().await;
        let proxy = MediaProxy::default();
        let prefix = proxy.start_with(&up.url(), KEY, timeouts).unwrap();
        let (port, token) = parse_prefix(&prefix);
        Fixture {
            up,
            proxy,
            prefix,
            port,
            token,
            http: client(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.prefix)
    }

    /// Pfad für rohe Anfragen: `/p/<Token><rest>`
    fn path(&self, rest: &str) -> String {
        format!("/p/{}{rest}", self.token)
    }
}

fn parse_prefix(prefix: &str) -> (u16, String) {
    let rest = prefix
        .strip_prefix("http://127.0.0.1:")
        .expect("Präfix beginnt mit http://127.0.0.1:");
    let (port, token) = rest.split_once("/p/").expect("Präfix enthält /p/");
    (port.parse().unwrap(), token.to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "Zeitüberschreitung: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/* ---------------------------------------------------------------------- Einheiten: Ziel und Pfade */

#[test]
fn target_accepts_and_normalizes_addresses() {
    let base = |input: &str| Target::new(input, "key").unwrap().base().to_string();
    assert_eq!(base("http://192.168.1.5:8096"), "http://192.168.1.5:8096");
    assert_eq!(base("http://192.168.1.5:8096/"), "http://192.168.1.5:8096");
    assert_eq!(
        base("  http://192.168.1.5:8096///  "),
        "http://192.168.1.5:8096"
    );
    assert_eq!(
        base("https://media.example.org/jellyfin//"),
        "https://media.example.org/jellyfin"
    );
    assert_eq!(base("HTTP://Server:80/"), "http://server");
    assert_eq!(base("https://nas.local:443"), "https://nas.local");
    assert_eq!(base("http://[::1]:8096/"), "http://[::1]:8096");
}

#[test]
fn target_rejects_unsafe_or_broken_addresses() {
    for bad in [
        "",
        "   ",
        "not a url",
        "ftp://server/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "http://",
        "http://user:secret@host:8096",
        "http://user@host:8096",
        "http://host:8096/?a=1",
        "http://host:8096/#x",
        "//host:8096",
        "host:8096",
    ] {
        let err = Target::new(bad, "key").expect_err(bad);
        assert!(
            !err.contains("secret"),
            "Fehlertext darf keine Zugangsdaten wiedergeben: {err}"
        );
    }
}

#[test]
fn api_key_is_trimmed_validated_and_never_printed() {
    let target = Target::new("http://h:8096", "  abc123  ").unwrap();
    assert_eq!(target.token.as_ref().unwrap(), "abc123");
    assert_eq!(
        target.authorization.as_ref().unwrap(),
        "MediaBrowser Client=\"JellyStation\", Token=\"abc123\""
    );
    assert!(
        !format!("{target:?}").contains("abc123"),
        "Debug-Ausgabe darf den Schlüssel nicht enthalten"
    );
    for bad in [
        "ab cd", "ab\"cd", "ab,cd", "ab\\cd", "äbc", "ab\ncd", "ab\tcd",
    ] {
        assert!(
            Target::new("http://h:8096", bad).is_err(),
            "{bad:?} muss abgelehnt werden"
        );
    }
    let none = Target::new("http://h:8096", "").unwrap();
    assert!(none.token.is_none() && none.authorization.is_none());
}

#[test]
fn token_is_compared_exactly() {
    let token = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        strip_prefix(token, &format!("/p/{token}/Videos/x")),
        Some("/Videos/x")
    );
    assert_eq!(strip_prefix(token, &format!("/p/{token}")), Some(""));
    assert_eq!(strip_prefix(token, &format!("/p/{token}/")), Some("/"));
    for wrong in [
        "/Videos/x".to_string(),
        "/p/".to_string(),
        "/p".to_string(),
        "/p//Videos".to_string(),
        format!("/p/{}/Videos", &token[..31]),
        format!("/p/{token}x/Videos"),
        format!("/p/{}0/Videos", &token[..31]),
        format!("/P/{token}/Videos"),
        format!("/q/{token}/Videos"),
        format!("/{token}/Videos"),
    ] {
        assert_eq!(strip_prefix(token, &wrong), None, "{wrong}");
    }
}

#[test]
fn upstream_paths_are_checked() {
    for good in [
        "/Videos/0a1b2c/stream.mkv",
        "/Items/1/Images/Primary",
        "/videos/x/hls1/main/0.mp4",
        "/Videos/x/abc/Subtitles/3/0/Stream.vtt",
        "/Users/1/Items",
        "/a%20b/c",
        "/100%25/x",
        "/a.b/c.d/..e/f..",
        "/x/.hidden",
        "/a:b/c",
        "/Artists/AC%2FDC",
        "/Artists/Foo%40Bar",
    ] {
        assert_eq!(check_upstream_path(good), Ok(()), "{good}");
    }
    let long = format!("/{}", "a".repeat(MAX_PATH_BYTES));
    for bad in [
        "",
        "Videos/x",
        "/../x",
        "/a/../b",
        "/a/..",
        "/..",
        "/a/./b",
        "/.",
        "//evil.com/x",
        "/a//b",
        "/http://evil.com/x",
        "/%2e%2e/x",
        "/%2E%2E/x",
        "/.%2e/x",
        "/%2e./x",
        "/a/%2e%2e%2fb",
        "/%2e%2e%2f",
        "/a%2f..%2fb",
        "/a%2F%2e%2E%2Fb",
        "/a%2f.",
        "/a%5cb",
        "/a%5Cb",
        "/%252e%252e/x",
        "/%25252e%25252e/x",
        "/%2525252e%2525252e/x",
        "/..;/x",
        "/a/..;x=1/b",
        "/a/%2e%2e;x/b",
        "/a\\b",
        "\\evil",
        "/a\u{1}b",
        "/a\u{7f}b",
        "/a\nb",
        "/a\rb",
        "/a b/ü",
        "/a/.. ",
        "/a b",
        "/ ",
        "/a/%2e%2e ",
        "/a%00b",
        "/a%0d%0ab",
        "/a%0Ab",
        "/x@evil.com/y",
        "/@evil.com",
        "/a/b@",
        long.as_str(),
    ] {
        assert!(
            check_upstream_path(bad).is_err(),
            "{bad:?} muss abgelehnt werden"
        );
    }
}

#[test]
fn upstream_url_keeps_the_raw_path_and_query() {
    let target = Target::new("https://media.example.org/jellyfin/", "k").unwrap();
    let url = target
        .upstream_url(
            "/Videos/ab%20c/stream.mkv",
            Some("static=true&tag=a%2Bb&x=%20"),
        )
        .unwrap();
    assert_eq!(
        url.as_str(),
        "https://media.example.org/jellyfin/Videos/ab%20c/stream.mkv?static=true&tag=a%2Bb&x=%20"
    );
    let plain = Target::new("http://192.168.1.5:8096", "k").unwrap();
    assert_eq!(
        plain
            .upstream_url("/System/Info/Public", None)
            .unwrap()
            .as_str(),
        "http://192.168.1.5:8096/System/Info/Public"
    );
    assert_eq!(
        plain.upstream_url("/x", Some("")).unwrap().as_str(),
        "http://192.168.1.5:8096/x?"
    );
}

#[test]
fn client_can_be_built_with_the_rustls_stack() {
    assert!(build_client(Timeouts::default()).is_ok());
}

/* -------------------------------------------------------------------- Einheiten: Wiedergabelisten */

fn lan() -> Target {
    Target::new("http://192.168.1.5:8096", "k").unwrap()
}

const P: &str = "http://127.0.0.1:5555/p/TOKEN";

#[test]
fn master_playlist_with_relative_uris_stays_unchanged() {
    assert_eq!(
        rewrite_playlist(MASTER_PLAYLIST, P, &lan()),
        MASTER_PLAYLIST
    );
}

#[test]
fn media_playlist_is_rewritten_jellyfin_style() {
    let source = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n\
        #EXT-X-MAP:URI=\"/videos/ID/hls1/main/-1.mp4?DeviceId=abc\"\n\
        #EXTINF:6.000000,\nhttp://192.168.1.5:8096/videos/ID/hls1/main/0.mp4?DeviceId=abc&api_key=k\n\
        #EXTINF:6.000000,\nhls1/main/1.mp4?DeviceId=abc\n\
        #EXTINF:6.000000,\n/videos/ID/hls1/main/2.mp4?DeviceId=abc\n\
        #EXT-X-KEY:METHOD=AES-128,URI=\"skd://key-id\"\n#EXT-X-ENDLIST\n";
    let expected = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n\
        #EXT-X-MAP:URI=\"http://127.0.0.1:5555/p/TOKEN/videos/ID/hls1/main/-1.mp4?DeviceId=abc\"\n\
        #EXTINF:6.000000,\nhttp://127.0.0.1:5555/p/TOKEN/videos/ID/hls1/main/0.mp4?DeviceId=abc&api_key=k\n\
        #EXTINF:6.000000,\nhls1/main/1.mp4?DeviceId=abc\n\
        #EXTINF:6.000000,\nhttp://127.0.0.1:5555/p/TOKEN/videos/ID/hls1/main/2.mp4?DeviceId=abc\n\
        #EXT-X-KEY:METHOD=AES-128,URI=\"skd://key-id\"\n#EXT-X-ENDLIST\n";
    assert_eq!(rewrite_playlist(source, P, &lan()), expected);
}

#[test]
fn playlist_attributes_other_hosts_and_schemes() {
    let target = lan();
    let source = "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Deutsch\",DEFAULT=YES,URI=\"/videos/ID/audio.m3u8?x=1\"\n\
        #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"HTTP://192.168.1.5:8096/videos/ID/iframe.m3u8\"\n\
        #EXT-X-KEY:METHOD=AES-128,URI=\"https://other.example/key.bin\"\n\
        #EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"\n\
        #EXT-X-DATERANGE:ID=\"ad\",X-ASSET-URI=\"http://192.168.1.5:8096/ad.mp4\"\n\
        #EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"/key\",KEYFORMAT=\"identity\"\n\
        //192.168.1.5:8096/videos/ID/0.ts\n\
        //other.example/videos/ID/0.ts\n\
        http://192.168.1.5:9999/videos/ID/0.ts\n\
        https://192.168.1.5:8096/videos/ID/0.ts\n";
    let expected = "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Deutsch\",DEFAULT=YES,URI=\"http://127.0.0.1:5555/p/TOKEN/videos/ID/audio.m3u8?x=1\"\n\
        #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"http://127.0.0.1:5555/p/TOKEN/videos/ID/iframe.m3u8\"\n\
        #EXT-X-KEY:METHOD=AES-128,URI=\"https://other.example/key.bin\"\n\
        #EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"\n\
        #EXT-X-DATERANGE:ID=\"ad\",X-ASSET-URI=\"http://192.168.1.5:8096/ad.mp4\"\n\
        #EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1:5555/p/TOKEN/key\",KEYFORMAT=\"identity\"\n\
        http://127.0.0.1:5555/p/TOKEN/videos/ID/0.ts\n\
        //other.example/videos/ID/0.ts\n\
        http://192.168.1.5:9999/videos/ID/0.ts\n\
        https://192.168.1.5:8096/videos/ID/0.ts\n";
    assert_eq!(rewrite_playlist(source, P, &target), expected);
}

#[test]
fn playlist_keeps_line_endings_blank_lines_and_missing_final_newline() {
    let target = lan();
    let source =
        "#EXTM3U\r\n\r\n#EXTINF:6,\r\n/videos/a/0.ts\r\n#EXTINF:6,\r\nseg1.ts\r\n/videos/a/2.ts";
    let expected = "#EXTM3U\r\n\r\n#EXTINF:6,\r\nhttp://127.0.0.1:5555/p/TOKEN/videos/a/0.ts\r\n#EXTINF:6,\r\nseg1.ts\r\nhttp://127.0.0.1:5555/p/TOKEN/videos/a/2.ts";
    assert_eq!(rewrite_playlist(source, P, &target), expected);
    assert_eq!(rewrite_playlist("", P, &target), "");
    assert_eq!(rewrite_playlist("\n\n", P, &target), "\n\n");
    // kaputte Zeilen dürfen nichts zerstören: nicht geschlossenes Anführungszeichen, leeres URI
    assert_eq!(
        rewrite_playlist("#EXT-X-KEY:URI=\"/abc\n", P, &target),
        "#EXT-X-KEY:URI=\"/abc\n"
    );
    assert_eq!(
        rewrite_playlist("#EXT-X-KEY:URI=\"\"\n", P, &target),
        "#EXT-X-KEY:URI=\"\"\n"
    );
}

#[test]
fn playlist_rewriting_respects_a_base_path() {
    let target = Target::new("https://media.example.org/jellyfin", "k").unwrap();
    let source = "https://media.example.org/jellyfin/videos/a/0.ts?x=1\n\
        /jellyfin/videos/a/1.ts\n\
        /videos/a/2.ts\n\
        https://media.example.org/videos/a/3.ts\n\
        /jellyfin\n\
        /jellyfinx/4.ts\n";
    let expected = "http://127.0.0.1:5555/p/TOKEN/videos/a/0.ts?x=1\n\
        http://127.0.0.1:5555/p/TOKEN/videos/a/1.ts\n\
        http://127.0.0.1:5555/p/TOKEN/videos/a/2.ts\n\
        http://127.0.0.1:5555/p/TOKEN/videos/a/3.ts\n\
        http://127.0.0.1:5555/p/TOKEN/\n\
        http://127.0.0.1:5555/p/TOKEN/jellyfinx/4.ts\n";
    assert_eq!(rewrite_playlist(source, P, &target), expected);
}

/* ------------------------------------------------------------------ Proxy gegen den Mock-Server */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn get_is_forwarded_with_login_headers_and_raw_query() {
    let f = Fixture::new().await;
    let response = f
        .http
        .get(f.url("/echo?static=true&tag=a%2Bb&y=%20z"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(
        text.starts_with("GET /echo?static=true&tag=a%2Bb&y=%20z\n"),
        "{text}"
    );
    let seen = &f.up.requests()[0];
    assert_eq!(seen.header("x-emby-token"), Some(KEY));
    assert_eq!(
        seen.header("authorization"),
        Some("MediaBrowser Client=\"JellyStation\", Token=\"KEY123abc\"")
    );
    assert_eq!(seen.header("accept-encoding"), Some("identity"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_whitelisted_request_headers_reach_the_server() {
    let f = Fixture::new().await;
    let raw = raw_send(
        f.port,
        &request_text(
            "GET",
            &f.path("/echo"),
            &[
                ("Range", "bytes=0-9"),
                ("If-Range", "\"v1\""),
                ("If-None-Match", "\"zzz\""),
                ("If-Modified-Since", "Wed, 21 Oct 2015 07:28:00 GMT"),
                ("Accept", "text/plain"),
                ("Cookie", "session=geheim"),
                ("Authorization", "Bearer evil"),
                ("X-Emby-Token", "evil"),
                ("X-Emby-Authorization", "MediaBrowser Token=\"evil\""),
                ("Origin", "http://evil.example"),
                ("Referer", "http://evil.example/seite"),
                ("X-Forwarded-For", "1.2.3.4"),
                ("User-Agent", "curl/8"),
                ("Accept-Encoding", "gzip, br"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(raw.status, 200);
    let seen = &f.up.requests()[0];
    let allowed = [
        "host",
        "user-agent",
        "accept",
        "accept-encoding",
        "range",
        "if-range",
        "if-none-match",
        "if-modified-since",
        "x-emby-token",
        "authorization",
    ];
    for (name, value) in &seen.headers {
        assert!(
            allowed.contains(&name.as_str()),
            "unerwarteter Header am Server: {name}: {value}"
        );
    }
    assert_eq!(seen.header("range"), Some("bytes=0-9"));
    assert_eq!(seen.header("if-range"), Some("\"v1\""));
    assert_eq!(seen.header("if-none-match"), Some("\"zzz\""));
    assert_eq!(
        seen.header("if-modified-since"),
        Some("Wed, 21 Oct 2015 07:28:00 GMT")
    );
    assert_eq!(seen.header("accept"), Some("text/plain"));
    // Anmeldung und Kompression bestimmt allein der Proxy
    assert_eq!(seen.header("x-emby-token"), Some(KEY));
    assert_eq!(
        seen.header("authorization"),
        Some("MediaBrowser Client=\"JellyStation\", Token=\"KEY123abc\"")
    );
    assert_eq!(seen.header("accept-encoding"), Some("identity"));
    assert!(
        seen.header("user-agent")
            .is_some_and(|ua| ua.starts_with("JellyStation/")),
        "{:?}",
        seen.header("user-agent")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn range_requests_return_206_and_416() {
    let f = Fixture::new().await;
    let get = |range: Option<&str>| {
        let mut request = f.http.get(f.url("/data"));
        if let Some(range) = range {
            request = request.header("Range", range);
        }
        request.send()
    };

    let full = get(None).await.unwrap();
    assert_eq!(full.status(), 200);
    for (name, value) in [
        ("content-type", "video/mp4"),
        ("accept-ranges", "bytes"),
        ("etag", "\"v1\""),
        ("last-modified", "Wed, 21 Oct 2015 07:28:00 GMT"),
        ("cache-control", "public, max-age=60"),
        ("content-length", "1000000"),
    ] {
        assert_eq!(
            full.headers().get(name).and_then(|v| v.to_str().ok()),
            Some(value),
            "{name}"
        );
    }
    let body = full.bytes().await.unwrap();
    assert_eq!(body.len() as u64, DATA_SIZE);
    assert!(matches_pattern(0, &body));

    for (range, start, len) in [
        ("bytes=100-199", 100u64, 100u64),
        ("bytes=999990-", 999_990, 10),
        ("bytes=-5", 999_995, 5),
        ("bytes=0-0", 0, 1),
    ] {
        let part = get(Some(range)).await.unwrap();
        assert_eq!(part.status(), 206, "{range}");
        let expected = format!("bytes {start}-{}/{DATA_SIZE}", start + len - 1);
        assert_eq!(
            part.headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok()),
            Some(expected.as_str()),
            "{range}"
        );
        let bytes = part.bytes().await.unwrap();
        assert_eq!(bytes.len() as u64, len, "{range}");
        assert!(matches_pattern(start, &bytes), "{range}");
    }

    let outside = get(Some("bytes=2000000-")).await.unwrap();
    assert_eq!(outside.status(), 416);
    assert_eq!(
        outside
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok()),
        Some("bytes */1000000")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn conditional_requests_pass_through_as_304() {
    let f = Fixture::new().await;
    let response = f
        .http
        .get(f.url("/data"))
        .header("If-None-Match", "\"v1\"")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 304);
    assert_eq!(
        response.headers().get("etag").and_then(|v| v.to_str().ok()),
        Some("\"v1\"")
    );
    assert!(response.bytes().await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_codes_and_empty_bodies_pass_through() {
    let f = Fixture::new().await;
    let missing = f.http.get(f.url("/s404")).send().await.unwrap();
    assert_eq!(missing.status(), 404);
    assert_eq!(missing.text().await.unwrap(), "nope");
    let none = f.http.get(f.url("/s204")).send().await.unwrap();
    assert_eq!(none.status(), 204);
    assert!(none.bytes().await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn head_returns_headers_without_body() {
    let f = Fixture::new().await;
    let raw = raw_send(f.port, &request_text("HEAD", &f.path("/data"), &[]))
        .await
        .unwrap();
    assert_eq!(raw.status, 200);
    assert_eq!(raw.header("content-length"), Some("1000000"));
    assert_eq!(raw.header("accept-ranges"), Some("bytes"));
    assert_eq!(raw.header("etag"), Some("\"v1\""));
    assert!(raw.body.is_empty());
    assert_eq!(f.up.requests()[0].method, "HEAD");

    let ranged = raw_send(
        f.port,
        &request_text("HEAD", &f.path("/data"), &[("Range", "bytes=10-19")]),
    )
    .await
    .unwrap();
    assert_eq!(ranged.status, 206);
    assert_eq!(ranged.header("content-length"), Some("10"));
    assert_eq!(ranged.header("content-range"), Some("bytes 10-19/1000000"));
    assert!(ranged.body.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_or_missing_token_is_404_and_never_reaches_the_server() {
    let f = Fixture::new().await;
    let wrong = "0".repeat(32);
    for path in [
        format!("/p/{wrong}/echo"),
        format!("/p/{}/echo", &f.token[..31]),
        format!("/p/{}x/echo", f.token),
        "/p/echo".to_string(),
        "/echo".to_string(),
        "/p/".to_string(),
        "/p".to_string(),
        "/".to_string(),
        "/favicon.ico".to_string(),
        f.path(""),
        f.path("/"),
    ] {
        let raw = raw_send(f.port, &request_text("GET", &path, &[]))
            .await
            .unwrap_or_else(|| panic!("keine Antwort für {path}"));
        assert_eq!(raw.status, 404, "{path}");
    }
    // falscher Token bei anderen Methoden bleibt 404 (verrät nichts)
    let post = raw_send(
        f.port,
        &request_text(
            "POST",
            &format!("/p/{wrong}/echo"),
            &[("Content-Length", "0")],
        ),
    )
    .await
    .unwrap();
    assert_eq!(post.status, 404);
    assert!(f.up.requests().is_empty(), "{:?}", f.up.requests());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn path_tricks_are_rejected_before_reaching_the_server() {
    let f = Fixture::new().await;
    let t = &f.token;
    let attempts: Vec<(String, &str)> = vec![
        (format!("/p/{t}/../x"), "Punkt-Segmente"),
        (format!("/p/{t}/a/../../x"), "Punkt-Segmente"),
        (format!("/p/{t}/.."), "Punkt-Segmente"),
        (format!("/p/{t}//evil.com/x"), "Doppelter Schrägstrich"),
        (format!("/p/{t}///x"), "Doppelter Schrägstrich"),
        (
            format!("/p/{t}/http://evil.com/x"),
            "Doppelter Schrägstrich",
        ),
        (format!("/p/{t}/%2e%2e/x"), "Punkt-Segmente"),
        (format!("/p/{t}/%2E%2E/x"), "Punkt-Segmente"),
        (format!("/p/{t}/.%2e/x"), "Punkt-Segmente"),
        (format!("/p/{t}/%2e./x"), "Punkt-Segmente"),
        (format!("/p/{t}/%252e%252e/x"), "Punkt-Segmente"),
        (format!("/p/{t}/a%2f..%2fb"), "Punkt-Segmente"),
        (format!("/p/{t}/%2e%2e%2f"), "Punkt-Segmente"),
        (format!("/p/{t}/a%5cb"), "Kodierte"),
        (format!("/p/{t}/a%00b"), "Kodierte"),
        (format!("/p/{t}/a%0d%0aX-Evil:%201"), "Kodierte"),
        (format!("/p/{t}/x@evil.com/y"), "@"),
        (format!("/p/{t}/@evil.com"), "@"),
    ];
    for (path, hint) in &attempts {
        let raw = raw_send(f.port, &request_text("GET", path, &[]))
            .await
            .unwrap_or_else(|| panic!("keine Antwort für {path}"));
        assert_eq!(raw.status, 400, "{path}");
        assert!(raw.text().contains(hint), "{path}: {}", raw.text());
    }

    // Auf Protokollebene kaputte Anfragen: Rückwärts-Schrägstrich, Steuerzeichen, Leerzeichen im Pfad
    for target in [
        format!("/p/{t}/a\\b"),
        format!("/p/{t}/a\u{1}b"),
        format!("/p/{t}/a\u{7f}b"),
    ] {
        let status = raw_send(f.port, &request_text("GET", &target, &[]))
            .await
            .map(|raw| raw.status);
        assert!(matches!(status, None | Some(400)), "{target:?}: {status:?}");
    }
    // Absolute Adresse in der Anfragezeile (Proxy-Stil) führt nicht zu fremden Hosts
    for (method, target) in [
        ("GET", "http://evil.example/x".to_string()),
        ("GET", format!("http://evil.example/p/{t}/echo")),
        ("GET", format!("http://127.0.0.1:{}/p/{t}/echo", f.port)),
        ("OPTIONS", "*".to_string()),
        ("CONNECT", "evil.example:443".to_string()),
    ] {
        let status = raw_send(f.port, &request_text(method, &target, &[]))
            .await
            .map(|raw| raw.status);
        assert!(
            matches!(status, None | Some(400 | 404 | 405)),
            "{method} {target}: {status:?}"
        );
    }

    // Nichts davon darf den Jellyfin-Server erreicht haben
    assert!(f.up.requests().is_empty(), "{:?}", f.up.requests());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn methods_other_than_get_head_options_are_405() {
    let f = Fixture::new().await;
    for method in ["POST", "PUT", "DELETE", "PATCH", "TRACE"] {
        let raw = raw_send(
            f.port,
            &request_text(method, &f.path("/echo"), &[("Content-Length", "0")]),
        )
        .await
        .unwrap();
        assert_eq!(raw.status, 405, "{method}");
        assert_eq!(raw.header("allow"), Some("GET, HEAD, OPTIONS"), "{method}");
    }
    assert!(f.up.requests().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn options_preflight_answers_204_with_open_cors() {
    let f = Fixture::new().await;
    let raw = raw_send(
        f.port,
        &request_text(
            "OPTIONS",
            &f.path("/Videos/x/stream"),
            &[
                ("Origin", "tauri://localhost"),
                ("Access-Control-Request-Method", "GET"),
                ("Access-Control-Request-Headers", "range, x-custom"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(raw.status, 204);
    assert!(raw.body.is_empty());
    assert_eq!(raw.header("access-control-allow-origin"), Some("*"));
    assert_eq!(
        raw.header("access-control-allow-headers"),
        Some("range, x-custom")
    );
    assert_eq!(
        raw.header("access-control-allow-methods"),
        Some("GET, HEAD, OPTIONS")
    );
    assert_eq!(
        raw.header("access-control-allow-private-network"),
        Some("true")
    );
    for exposed in ["Content-Length", "Content-Range", "Accept-Ranges"] {
        assert!(
            raw.header("access-control-expose-headers")
                .unwrap_or_default()
                .contains(exposed),
            "{exposed}"
        );
    }

    let plain = raw_send(
        f.port,
        &request_text("OPTIONS", &f.path("/Videos/x/stream"), &[]),
    )
    .await
    .unwrap();
    assert_eq!(plain.status, 204);
    assert_eq!(plain.header("access-control-allow-headers"), Some("*"));

    // ohne gültigen Token gibt es auch für OPTIONS nichts
    let wrong = raw_send(
        f.port,
        &request_text("OPTIONS", &format!("/p/{}/x", "0".repeat(32)), &[]),
    )
    .await
    .unwrap();
    assert_eq!(wrong.status, 404);
    assert!(f.up.requests().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cors_headers_are_on_every_answer() {
    let f = Fixture::new().await;
    let ok = f
        .http
        .get(f.url("/data"))
        .header("Range", "bytes=0-9")
        .send()
        .await
        .unwrap();
    assert_eq!(
        ok.headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("*")
    );
    assert!(ok.headers().get("access-control-expose-headers").is_some());
    for (path, status) in [
        (f.path("/s404"), 404u16),
        (format!("/p/{}/x", "1".repeat(32)), 404),
        (f.path("/../x"), 400),
    ] {
        let raw = raw_send(f.port, &request_text("GET", &path, &[]))
            .await
            .unwrap();
        assert_eq!(raw.status, status, "{path}");
        assert_eq!(
            raw.header("access-control-allow-origin"),
            Some("*"),
            "{path}"
        );
    }
    let post = raw_send(
        f.port,
        &request_text("POST", &f.path("/x"), &[("Content-Length", "0")]),
    )
    .await
    .unwrap();
    assert_eq!(post.header("access-control-allow-origin"), Some("*"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hls_playlists_are_rewritten_end_to_end() {
    let f = Fixture::new().await;
    let up_port = f.up.port;

    let master = f.http.get(f.url("/hls/master.m3u8")).send().await.unwrap();
    assert_eq!(master.status(), 200);
    assert_eq!(
        master
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(master.text().await.unwrap(), MASTER_PLAYLIST);

    let media = f
        .http
        .get(f.url("/videos/ID/main.m3u8"))
        .send()
        .await
        .unwrap();
    assert_eq!(media.status(), 200);
    assert_eq!(
        media
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let content_type = media
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.to_lowercase().contains("mpegurl"),
        "{content_type}"
    );
    let declared: usize = media
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .parse()
        .unwrap();
    let text = media.text().await.unwrap();
    assert_eq!(
        text.len(),
        declared,
        "Content-Length muss zur umgeschriebenen Liste passen"
    );
    assert!(
        text.contains(&format!(
            "#EXT-X-MAP:URI=\"{}/videos/ID/hls1/main/-1.mp4?DeviceId=abc\"",
            f.prefix
        )),
        "{text}"
    );
    assert!(
        text.contains(&format!(
            "\n{}/videos/ID/hls1/main/0.mp4?DeviceId=abc\n",
            f.prefix
        )),
        "{text}"
    );
    assert!(
        text.contains("\nhls1/main/1.mp4?DeviceId=abc\n"),
        "relative Adressen bleiben: {text}"
    );
    assert!(
        text.contains(&format!(
            "\n{}/videos/ID/hls1/main/2.mp4?DeviceId=abc\n",
            f.prefix
        )),
        "{text}"
    );
    assert!(text.contains("URI=\"skd://key-id\""), "{text}");
    assert!(
        !text.contains(&format!("127.0.0.1:{up_port}")),
        "die Adresse des Servers darf nicht mehr vorkommen: {text}"
    );

    // HEAD auf die Liste: gleiche Länge wie das umgeschriebene GET, kein Körper
    let head = raw_send(
        f.port,
        &request_text("HEAD", &f.path("/videos/ID/main.m3u8"), &[]),
    )
    .await
    .unwrap();
    assert_eq!(head.status, 200);
    assert_eq!(
        head.header("content-length"),
        Some(declared.to_string().as_str())
    );
    assert!(head.body.is_empty());

    // Eine umgeschriebene Adresse führt wieder durch den Proxy zum Segment
    let segment_url = text
        .lines()
        .find(|l| l.ends_with("/2.mp4?DeviceId=abc"))
        .unwrap()
        .to_string();
    let segment = f.http.get(&segment_url).send().await.unwrap();
    assert_eq!(segment.status(), 200);
    assert_eq!(segment.bytes().await.unwrap().len(), 1000);

    // Auch ohne ".m3u8" im Pfad erkennt der Proxy Listen am Content-Type
    let by_type = f
        .http
        .get(f.url("/Videos/ID/playlist"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        by_type.contains(&format!("{}/videos/ID/hls1/main/0.mp4", f.prefix)),
        "{by_type}"
    );
    // ... auch bei HEAD: Länge der umgeschriebenen Liste, kein Körper
    let head_by_type = raw_send(
        f.port,
        &request_text("HEAD", &f.path("/Videos/ID/playlist"), &[]),
    )
    .await
    .unwrap();
    assert_eq!(head_by_type.status, 200);
    assert_eq!(
        head_by_type.header("content-length"),
        Some(by_type.len().to_string().as_str())
    );
    assert!(head_by_type.body.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_playlists_are_refused_with_502() {
    let f = Fixture::new().await;
    let response = f.http.get(f.url("/hls/huge.m3u8")).send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert!(response.text().await.unwrap().contains("zu groß"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn redirects_inside_the_same_origin_are_followed_with_login() {
    let f = Fixture::new().await;
    for path in ["/redir-same", "/redir-abs"] {
        let response = f.http.get(f.url(path)).send().await.unwrap();
        assert_eq!(response.status(), 200, "{path}");
        assert_eq!(
            response.bytes().await.unwrap().len() as u64,
            DATA_SIZE,
            "{path}"
        );
    }
    let log = f.up.requests();
    assert_eq!(log.len(), 4);
    for entry in &log {
        assert_eq!(entry.header("x-emby-token"), Some(KEY), "{}", entry.target);
        assert!(entry.header("authorization").is_some(), "{}", entry.target);
    }
    let looping = f.http.get(f.url("/redir-loop")).send().await.unwrap();
    assert_eq!(looping.status(), 502);
    assert!(looping.text().await.unwrap().contains("zu oft"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn redirects_to_other_origins_are_not_followed() {
    let f = Fixture::new().await;
    let foreign = Upstream::start().await;
    f.up.state.foreign_port.store(foreign.port, SeqCst);

    for path in ["/redir-foreign", "/redir-scheme", "/redir-proto-relative"] {
        let response = f.http.get(f.url(path)).send().await.unwrap();
        assert_eq!(response.status(), 502, "{path}");
        let text = response.text().await.unwrap();
        assert!(text.contains("leitet auf"), "{path}: {text}");
        assert!(
            !text.contains(KEY),
            "der Schlüssel darf nie in Meldungen stehen: {text}"
        );
    }
    let named = f
        .http
        .get(f.url("/redir-foreign"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        named.contains(&format!("127.0.0.1:{}", foreign.port)),
        "die Meldung nennt das Ziel: {named}"
    );
    // Der fremde Server hat nie etwas gesehen, schon gar nicht den Schlüssel
    assert!(foreign.requests().is_empty(), "{:?}", foreign.requests());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dead_server_gives_502_with_a_short_text() {
    let free_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let proxy = MediaProxy::default();
    let prefix = proxy
        .start(&format!("http://127.0.0.1:{free_port}"), KEY)
        .unwrap();
    let response = client()
        .get(format!("{prefix}/api_key=geheim/Videos/x?api_key={KEY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    let text = response.text().await.unwrap();
    assert!(text.contains("nicht erreichbar"), "{text}");
    assert!(
        !text.contains(KEY) && !text.contains("geheim") && !text.contains(&free_port.to_string()),
        "keine Adresse/Schlüssel in der Meldung: {text}"
    );
    assert!(text.len() < 200, "{text}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn https_target_that_does_not_speak_tls_gives_502() {
    // Prüft nebenbei, dass der TLS-Stack (rustls) zur Laufzeit initialisiert werden kann.
    let up = Upstream::start().await;
    let proxy = MediaProxy::default();
    let prefix = proxy
        .start(&format!("https://127.0.0.1:{}", up.port), KEY)
        .unwrap();
    let response = client().get(format!("{prefix}/data")).send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert!(!response.text().await.unwrap().contains(KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_timeout_applies_to_missing_headers_and_stalled_bodies() {
    let f = Fixture::with_timeouts(Timeouts {
        connect: Duration::from_secs(2),
        read: Duration::from_millis(400),
    })
    .await;

    let started = Instant::now();
    let slow = f.http.get(f.url("/slow-headers")).send().await.unwrap();
    assert_eq!(slow.status(), 502);
    assert!(slow.text().await.unwrap().contains("Zeitüberschreitung"));
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );

    let started = Instant::now();
    let raw = raw_send(f.port, &request_text("GET", &f.path("/stall"), &[])).await;
    let received = raw.map_or(0, |raw| raw.body.len());
    assert!(
        received < 1000,
        "der Körper muss abgebrochen werden, nicht vollständig sein ({received} Bytes)"
    );
    assert!(
        started.elapsed() >= Duration::from_millis(350)
            && started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    eventually("Abruf des hängenden Körpers beim Server beendet", || {
        f.up.state.stall_dropped.load(SeqCst)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn many_parallel_range_requests_all_succeed() {
    let f = Fixture::new().await;
    let started = Instant::now();
    let requests = (0..32u64).map(|index| {
        let http = f.http.clone();
        let url = f.url("/big");
        async move {
            let start = index * 1_000_000;
            let end = start + 1_048_575;
            let response = http
                .get(url)
                .header("Range", format!("bytes={start}-{end}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 206);
            let body = response.bytes().await.unwrap();
            assert_eq!(body.len() as u64, end - start + 1);
            assert!(
                matches_pattern(start, &body),
                "Inhalt von Bereich {index} falsch"
            );
        }
    });
    futures_util::future::join_all(requests).await;
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(f.up.requests().len(), 32);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keep_alive_connections_serve_several_requests() {
    let f = Fixture::new().await;
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    for _ in 0..3 {
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: x\r\nRange: bytes=0-9\r\n\r\n",
            f.path("/data")
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut got = Vec::new();
        let mut buffer = [0u8; 4096];
        // Antwort vollständig = Kopf + 10 Bytes Körper
        while got
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .is_none_or(|end| got.len() < end + 4 + 10)
        {
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
                .await
                .unwrap()
                .unwrap();
            assert!(n > 0, "Verbindung wurde geschlossen");
            got.extend_from_slice(&buffer[..n]);
        }
        let response = parse_raw(&got).unwrap();
        assert_eq!(response.status, 206);
        assert!(matches_pattern(0, &response.body));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn target_can_be_switched_without_restart() {
    let a = Upstream::start().await;
    let b = Upstream::start().await;
    let proxy = MediaProxy::default();
    let prefix = proxy.start(&a.url(), "keyA").unwrap();
    let http = client();

    assert_eq!(
        http.get(format!("{prefix}/echo"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(a.requests().len(), 1);
    assert_eq!(a.requests()[0].header("x-emby-token"), Some("keyA"));

    // Ziel umstellen: gleiches Präfix, ab jetzt Server B mit anderem Schlüssel
    assert_eq!(proxy.start(&b.url(), "keyB").unwrap(), prefix);
    assert_eq!(
        http.get(format!("{prefix}/echo"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(a.requests().len(), 1, "Server A darf nichts mehr sehen");
    assert_eq!(b.requests().len(), 1);
    assert_eq!(b.requests()[0].header("x-emby-token"), Some("keyB"));

    // Eine ungültige Umstellung ändert nichts
    assert!(proxy.start("ftp://x", "keyC").is_err());
    assert!(proxy.start(&a.url(), "kaputt\"").is_err());
    assert_eq!(proxy.prefix().as_deref(), Some(prefix.as_str()));
    assert_eq!(
        http.get(format!("{prefix}/echo"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(b.requests().len(), 2);
    assert_eq!(b.requests()[1].header("x-emby-token"), Some("keyB"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_is_idempotent_and_stop_ends_the_server() {
    let up = Upstream::start().await;
    let proxy = MediaProxy::default();
    assert_eq!(proxy.prefix(), None);
    assert!(proxy.start("", "k").is_err());
    assert_eq!(
        proxy.prefix(),
        None,
        "ein fehlgeschlagener Start startet nichts"
    );

    let first = proxy.start(&up.url(), KEY).unwrap();
    let again = proxy.start(&format!("{}/", up.url()), KEY).unwrap();
    assert_eq!(first, again, "idempotent: gleiches Präfix");
    let (port, token) = parse_prefix(&first);
    assert_eq!(token.len(), 32);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(first.starts_with("http://127.0.0.1:") && !first.ends_with('/'));

    // Der Server hört nur auf 127.0.0.1
    let listener_addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    assert!(std::net::TcpStream::connect_timeout(&listener_addr, Duration::from_secs(2)).is_ok());

    proxy.stop();
    assert_eq!(proxy.prefix(), None);
    eventually("Port nach stop() geschlossen", || {
        std::net::TcpStream::connect_timeout(&listener_addr, Duration::from_millis(300)).is_err()
    })
    .await;
    proxy.stop(); // doppeltes stop ist harmlos

    let restarted = proxy.start(&up.url(), KEY).unwrap();
    assert_ne!(
        restarted, first,
        "nach stop() gibt es einen neuen Port/Token"
    );
    let (new_port, new_token) = parse_prefix(&restarted);
    assert_ne!(new_token, token);
    let old_token_on_new_server = raw_send(
        new_port,
        &request_text("GET", &format!("/p/{token}/echo"), &[]),
    )
    .await
    .unwrap();
    assert_eq!(old_token_on_new_server.status, 404);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tokens_are_random() {
    let up = Upstream::start().await;
    let tokens: std::collections::HashSet<String> = (0..20)
        .map(|_| {
            let proxy = MediaProxy::default();
            let prefix = proxy.start(&up.url(), KEY).unwrap();
            parse_prefix(&prefix).1
        })
        .collect();
    assert_eq!(tokens.len(), 20);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn client_abort_cancels_the_request_to_the_server() {
    let f = Fixture::new().await;

    // 1. Der Server antwortet nie: Browser bricht ab → Abruf beim Server wird beendet
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    stream
        .write_all(&request_text("GET", &f.path("/hang"), &[]))
        .await
        .unwrap();
    eventually("Anfrage beim Server angekommen", || {
        f.up.state.hang_started.load(SeqCst)
    })
    .await;
    assert!(!f.up.state.hang_dropped.load(SeqCst));
    drop(stream);
    eventually(
        "Abruf beim Server nach Abbruch des Browsers beendet",
        || f.up.state.hang_dropped.load(SeqCst),
    )
    .await;

    // 2. Mitten im Download abbrechen
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    stream
        .write_all(&request_text("GET", &f.path("/big"), &[]))
        .await
        .unwrap();
    let mut first = vec![0u8; 4096];
    stream.read_exact(&mut first).await.unwrap();
    drop(stream);
    eventually("Download beim Server nach Abbruch beendet", || {
        f.up.state.big_dropped.load(SeqCst)
    })
    .await;
    assert!(
        f.up.state.big_sent.load(SeqCst) < BIG_SIZE / 2,
        "es darf nicht weiter geladen werden"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_aborts_running_downloads() {
    let f = Fixture::new().await;
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    stream
        .write_all(&request_text("GET", &f.path("/big"), &[]))
        .await
        .unwrap();
    let mut first = vec![0u8; 4096];
    stream.read_exact(&mut first).await.unwrap();

    f.proxy.stop();
    eventually("Download beim Server nach stop() beendet", || {
        f.up.state.big_dropped.load(SeqCst)
    })
    .await;
    // Der Browser sieht ein abgebrochenes Ende (EOF/Reset), keinen vollständigen Download
    let mut total = first.len() as u64;
    let mut buffer = vec![0u8; 256 * 1024];
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n as u64,
            }
        }
    })
    .await;
    assert!(outcome.is_ok(), "die Verbindung muss enden");
    assert!(total < BIG_SIZE, "{total}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn large_downloads_are_streamed_with_backpressure() {
    let f = Fixture::new().await;

    // Langsamer Leser: nach dem ersten Stück nicht weiterlesen. Der Proxy darf nicht vorladen, sondern nur so viel,
    // wie in die Puffer der Verbindungen passt (Betriebssystem-Puffer sind hier bis zu 32 MB groß). Deshalb eine
    // Datei, die nie ganz fließen kann (512 MB), und die Prüfung, dass der Fluss zum Stillstand kommt.
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    stream
        .write_all(&request_text("GET", &f.path("/huge"), &[]))
        .await
        .unwrap();
    let mut first = vec![0u8; 64 * 1024];
    stream.read_exact(&mut first).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let first_sample = f.up.state.big_sent.load(SeqCst);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let second_sample = f.up.state.big_sent.load(SeqCst);
    eprintln!(
        "Leser steht still: Server hat nach 1,0 s {} MiB, nach 2,5 s {} MiB geliefert (Datei: {} MiB)",
        first_sample / (1024 * 1024),
        second_sample / (1024 * 1024),
        HUGE_SIZE / (1024 * 1024)
    );
    assert!(
        second_sample - first_sample < 1024 * 1024,
        "der Fluss muss zum Stillstand kommen ({first_sample} → {second_sample})"
    );
    assert!(
        second_sample < HUGE_SIZE / 4,
        "ohne Gegendruck würde die ganze Datei fließen, gesehen: {} MiB",
        second_sample / (1024 * 1024)
    );
    drop(stream);
    eventually("Download nach Abbruch beendet", || {
        f.up.state.big_dropped.load(SeqCst)
    })
    .await;
    let after_abort = f.up.state.big_sent.load(SeqCst);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        f.up.state.big_sent.load(SeqCst),
        after_abort,
        "nach dem Abbruch darf nichts mehr geladen werden"
    );

    // Vollständiger Abruf: alle 50 MB kommen unverfälscht an
    let started = Instant::now();
    let mut response = f.http.get(f.url("/big")).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some("52428800")
    );
    let mut position = 0u64;
    while let Some(chunk) = response.chunk().await.unwrap() {
        assert!(
            matches_pattern(position, &chunk),
            "Inhalt ab Byte {position} falsch"
        );
        position += chunk.len() as u64;
    }
    assert_eq!(position, BIG_SIZE);
    eprintln!("50 MB in {:?}", started.elapsed());
}

/// Messung des Speicherverbrauchs (nur Linux, einzeln ausführen:
/// `cargo test rss_stays_small -- --ignored --nocapture --test-threads=1`).
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Messung: braucht einen Lauf ohne parallele Tests"]
async fn rss_stays_small_while_streaming_50_mb() {
    fn rss_kib() -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|l| l.starts_with("VmRSS:"))
                    .map(str::to_string)
            })
            .and_then(|line| line.split_whitespace().nth(1).and_then(|n| n.parse().ok()))
            .unwrap_or(0)
    }
    let f = Fixture::new().await;
    // Aufwärmen, damit Pools/Puffer angelegt sind und nicht in die Messung fallen
    let warm = f
        .http
        .get(f.url("/data"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(warm.len() as u64, DATA_SIZE);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let before = rss_kib();
    let peak = Arc::new(AtomicU64::new(before));
    let running = Arc::new(AtomicBool::new(true));
    let sampler = {
        let (peak, running) = (Arc::clone(&peak), Arc::clone(&running));
        std::thread::spawn(move || {
            while running.load(SeqCst) {
                peak.fetch_max(rss_kib(), SeqCst);
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    // eine Range-Anfrage ab 1 MiB bis zum Ende der 50-MiB-Datei
    let offset = 1024 * 1024u64;
    let mut response = f
        .http
        .get(f.url("/big"))
        .header("Range", format!("bytes={offset}-"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await.unwrap() {
        total += chunk.len() as u64;
        // gemächlicher Leser: der Proxy muss warten, statt zu puffern
        if total % (8 * 1024 * 1024) < chunk.len() as u64 {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    running.store(false, SeqCst);
    sampler.join().unwrap();
    assert_eq!(total, BIG_SIZE - offset);
    let growth_mib = (peak.load(SeqCst).saturating_sub(before)) as f64 / 1024.0;
    eprintln!("RSS vorher {:.1} MiB, Spitze {:.1} MiB, Zuwachs {growth_mib:.1} MiB bei {} MiB Übertragung", before as f64 / 1024.0, peak.load(SeqCst) as f64 / 1024.0, BIG_SIZE / 1024 / 1024);
    assert!(
        growth_mib < 15.0,
        "Speicherzuwachs {growth_mib:.1} MiB deutet auf Vollpuffern hin"
    );
}

#[cfg(target_os = "linux")]
fn open_fds() -> usize {
    std::fs::read_dir("/proc/self/fd").map_or(0, |entries| entries.count())
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn aborted_and_finished_requests_leave_no_connections_behind() {
    let f = Fixture::new().await;
    // Aufwärmen: Pools, Listener und eine wiederverwendbare Verbindung stehen danach
    assert_eq!(
        f.http.get(f.url("/data")).send().await.unwrap().status(),
        200
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = open_fds();

    for _ in 0..60 {
        // Browser bricht mitten im Download ab
        let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
        stream
            .write_all(&request_text("GET", &f.path("/big"), &[]))
            .await
            .unwrap();
        let mut first = [0u8; 1024];
        stream.read_exact(&mut first).await.unwrap();
        drop(stream);
        // Browser geht, während der Server noch nicht antwortet
        let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
        stream
            .write_all(&request_text("GET", &f.path("/hang"), &[]))
            .await
            .unwrap();
        drop(stream);
        // und eine ganz normale Anfrage
        assert_eq!(
            f.http
                .get(f.url("/data"))
                .header("Range", "bytes=0-9")
                .send()
                .await
                .unwrap()
                .status(),
            206
        );
    }
    eventually("alle Verbindungen sind wieder geschlossen", || {
        open_fds() <= before + 8
    })
    .await;
    eprintln!("offene Dateien: vorher {before}, nachher {}", open_fds());
}

/// Messung (nur Debug-Übersetzung, also ein vorsichtiger Wert):
/// `cargo test throughput -- --ignored --nocapture --test-threads=1`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Messung"]
async fn throughput_of_the_proxy() {
    let f = Fixture::new().await;
    let started = Instant::now();
    let mut response = f.http.get(f.url("/zeros")).send().await.unwrap();
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await.unwrap() {
        total += chunk.len() as u64;
    }
    let seconds = started.elapsed().as_secs_f64();
    eprintln!(
        "{} MiB in {seconds:.2} s = {:.0} MiB/s über den Proxy (Debug-Build)",
        total / (1024 * 1024),
        total as f64 / (1024.0 * 1024.0) / seconds
    );
    assert_eq!(total, 8192 * 64 * 1024);
}

/* ---------------------------------------------------------------- zufällige Eingaben (deterministisch) */

/// Kleiner Zufallsgenerator (xorshift), damit die Läufe wiederholbar sind.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() % items.len() as u64) as usize]
    }
}

fn random_path(rng: &mut Rng) -> String {
    const PIECES: &[&str] = &[
        "/",
        "/",
        "/",
        "a",
        "b",
        "Videos",
        "x",
        ".",
        "..",
        "...",
        "%",
        "%2e",
        "%2E",
        "%2f",
        "%2F",
        "%5c",
        "%5C",
        "%25",
        "%252e",
        "%00",
        "%0d",
        "%0a",
        "%40",
        "%20",
        "2",
        "e",
        "E",
        "5",
        "c",
        "0",
        "f",
        "\\",
        "@",
        ";",
        ":",
        " ",
        "\t",
        "\u{1}",
        "ü",
        "-",
        "_",
        "~",
        "http:",
        "evil.com",
        "stream.mkv",
    ];
    let mut path = String::from(*rng.pick(&["/", "/", "/Videos", ""]));
    for _ in 0..(rng.next() % 12) {
        path.push_str(rng.pick(PIECES));
    }
    path
}

#[test]
fn random_paths_never_panic_and_never_change_the_address() {
    let plain = Target::new("http://192.168.1.5:8096", "k").unwrap();
    let nested = Target::new("https://media.example.org/jellyfin", "k").unwrap();
    // Standard: 300 000 Pfade. Für einen gründlicheren Lauf: JELLYSTATION_FUZZ=5000000 und optional JELLYSTATION_SEED.
    let iterations: usize = std::env::var("JELLYSTATION_FUZZ")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(300_000);
    let seed: u64 = std::env::var("JELLYSTATION_SEED")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0x9E37_79B9_7F4A_7C15);
    let mut rng = Rng(seed | 1);
    let (mut accepted, mut rejected) = (0, 0);
    for _ in 0..iterations {
        let rest = random_path(&mut rng);
        let query = rng
            .next()
            .is_multiple_of(3)
            .then(|| random_path(&mut rng).replace(['?', '#'], "_"));
        if check_upstream_path(&rest).is_err() {
            rejected += 1;
            continue;
        }
        accepted += 1;
        for target in [&plain, &nested] {
            let Ok(url) = target.upstream_url(&rest, query.as_deref()) else {
                continue;
            };
            assert!(
                target.same_origin(&url),
                "Ursprung geändert bei {rest:?} / {query:?} → {url}"
            );
            let base_segments = target.base_path.matches('/').count();
            // Die Adresse wurde nicht umgebaut: genau die Segmente des Basispfads plus die des Pfads, keines verschwunden.
            let segments = url.path_segments().map_or(0, |s| s.count());
            assert_eq!(
                segments,
                base_segments + rest.matches('/').count(),
                "Segmente verschwunden bei {rest:?} → {url}"
            );
            assert!(
                url.path_segments().unwrap().all(|s| s != ".." && s != "."),
                "{rest:?} → {url}"
            );
            assert!(
                url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
            );
            if !target.base_path.is_empty() {
                assert!(
                    url.path().starts_with(&format!("{}/", target.base_path)),
                    "{rest:?} → {url}"
                );
            }
        }
    }
    eprintln!("zufällige Pfade: {accepted} angenommen, {rejected} abgelehnt");
    assert!(
        accepted > 1000 && rejected > 1000,
        "die Mischung soll beides enthalten"
    );
}

#[test]
fn random_playlists_never_panic_and_rewriting_is_stable() {
    let target = lan();
    let mut rng = Rng(0xDEAD_BEEF_CAFE_F00D);
    const TOKENS: &[&str] = &[
        "#EXT-X-MAP:URI=\"",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"",
        ",URI=\"",
        ":URI=\"",
        "URI=\"",
        "\"",
        "\"\"",
        "http://192.168.1.5:8096/",
        "https://192.168.1.5:8096/",
        "//192.168.1.5:8096/",
        "/videos/a/0.ts",
        "seg1.ts",
        "?x=1&y=%20",
        "#frag",
        "\n",
        "\r\n",
        "\r",
        "\n\n",
        " ",
        "\t",
        "ü",
        "€",
        "🎬",
        "#EXTINF:6,",
        "#EXTM3U",
        "skd://k",
        "data:text/plain,a",
        "HTTP://192.168.1.5:8096/",
        "http://other.example/",
        "[::1]",
        "%",
        "\u{0}",
    ];
    for _ in 0..30_000 {
        let text: String = (0..(rng.next() % 25)).map(|_| *rng.pick(TOKENS)).collect();
        let once = rewrite_playlist(&text, P, &target);
        // nichts von der eigenen Adresse bleibt stehen, und ein zweiter Durchlauf ändert nichts mehr
        assert_eq!(
            rewrite_playlist(&once, P, &target),
            once,
            "nicht stabil für {text:?}"
        );
        assert_eq!(
            once.matches('\n').count(),
            text.matches('\n').count(),
            "Zeilenzahl verändert für {text:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn random_raw_requests_do_not_hurt_the_server() {
    let f = Fixture::new().await;
    let mut rng = Rng(0xA5A5_5A5A_1234_5678);
    let mut statuses = std::collections::BTreeMap::<String, usize>::new();
    for _ in 0..600 {
        let mut path = random_path(&mut rng);
        // ab und zu mit Anfrage-Parametern, rohen Sonderbytes oder fremdem Ziel in der Anfragezeile
        match rng.next() % 6 {
            0 => path.push_str("?api_key=x&a=%20"),
            1 => path.push_str("\r\nX-Evil: 1"),
            _ => {}
        }
        let target = if rng.next().is_multiple_of(9) {
            format!("http://evil.example{path}")
        } else {
            format!("/p/{}{path}", f.token)
        };
        let request = format!("GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        let answer = raw_send(f.port, request.as_bytes()).await;
        *statuses
            .entry(answer.map_or("keine Antwort".to_string(), |raw| raw.status.to_string()))
            .or_default() += 1;
    }
    eprintln!("Antworten auf zufällige Anfragen: {statuses:?}");

    // Der Server lebt weiter und antwortet normal ...
    assert_eq!(
        f.http
            .get(f.url("/data"))
            .header("Range", "bytes=0-9")
            .send()
            .await
            .unwrap()
            .status(),
        206
    );
    // ... und was den Jellyfin-Server erreichte, ist ein sauberer Pfad mit Anmeldung
    for seen in f.up.requests() {
        let path = seen.target.split('?').next().unwrap();
        assert_eq!(
            check_upstream_path(path),
            Ok(()),
            "unsauberer Pfad am Server: {:?}",
            seen.target
        );
        assert_eq!(seen.header("x-emby-token"), Some(KEY));
        assert!(
            seen.headers
                .iter()
                .all(|(name, _)| name != "x-evil" && name != "cookie"),
            "{:?}",
            seen.headers
        );
    }
}
