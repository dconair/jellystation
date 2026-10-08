//! Lokaler Medien-Proxy für Jellyfin (Befehle `media_proxy_start` und `media_proxy_stop`).
//!
//! Warum es ihn gibt: Ein `<video>` im WebView kann keine Anmelde-Header senden, und `http://`-Server im LAN
//! blockiert das WebView je nach Plattform (Mixed Content / App Transport Security). Der Proxy ist ein kleiner
//! HTTP-Server nur auf 127.0.0.1. Er verlangt einen zufälligen Token im Pfad (`/p/<Token>/…`), damit weder fremde
//! Webseiten noch andere Prozesse ihn mit unserem API-Schlüssel benutzen können, und reicht GET/HEAD mit Anmeldung
//! an den Jellyfin-Server weiter. Medien werden gestreamt (nie vollständig gepuffert); nur HLS-Wiedergabelisten
//! (`.m3u8`, höchstens 4 MB) werden gelesen und umgeschrieben, damit ihre Adressen wieder auf den Proxy zeigen.
//!
//! Der Server hängt nicht an Tauri: [`MediaProxy`] lässt sich in Tests direkt starten, die Befehle unten sind nur
//! dünne Hüllen. Verbindungen laufen in einem `JoinSet`, das beim Beenden alle Verbindungs-Tasks abbricht –
//! so endet mit `media_proxy_stop` auch jeder laufende Abruf beim Jellyfin-Server.

use std::borrow::Cow;
use std::convert::Infallible;
use std::error::Error as StdError;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener as StdTcpListener};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, ACCEPT_ENCODING, ACCEPT_RANGES, ALLOW,
    AUTHORIZATION, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, IF_RANGE, LAST_MODIFIED, LOCATION, RANGE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use reqwest::Url;
use subtle::ConstantTimeEq;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

/// Größer als 4 MB darf eine Wiedergabeliste nicht sein (echte Listen haben wenige KB).
const MAX_PLAYLIST_BYTES: usize = 4 * 1024 * 1024;
/// Weiterleitungen innerhalb desselben Servers, danach Abbruch (Schleifenschutz).
const MAX_REDIRECTS: usize = 5;
/// Längster akzeptierter Pfad hinter dem Token.
const MAX_PATH_BYTES: usize = 8 * 1024;
/// So lange darf ein Browser für den Anfragekopf brauchen (verhindert hängende Leerverbindungen).
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Zeitlimits für den Abruf beim Jellyfin-Server.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// Aufbau der Verbindung.
    pub connect: Duration,
    /// Leerlauf beim Lesen (auch beim Warten auf die Antwort-Köpfe, z. B. wenn Jellyfin erst transkodiert).
    pub read: Duration,
}

impl Default for Timeouts {
    fn default() -> Timeouts {
        Timeouts {
            connect: Duration::from_secs(10),
            read: Duration::from_secs(60),
        }
    }
}

/// Körper der Antworten: gestreamt, Fehler als `io::Error` (bricht die Verbindung zum Browser ab).
pub type ProxyBody = UnsyncBoxBody<Bytes, io::Error>;

/// Nur diese Anfrage-Header gehen an den Jellyfin-Server; alles andere (Cookies, Origin, Authorization …) bleibt draußen.
fn forwarded_request_headers() -> [HeaderName; 5] {
    [RANGE, IF_RANGE, IF_NONE_MATCH, IF_MODIFIED_SINCE, ACCEPT]
}

/// Diese Antwort-Header kommen zum Browser zurück.
fn forwarded_response_headers() -> [HeaderName; 8] {
    [
        CONTENT_TYPE,
        CONTENT_LENGTH,
        CONTENT_RANGE,
        ACCEPT_RANGES,
        ETAG,
        LAST_MODIFIED,
        CACHE_CONTROL,
        CONTENT_ENCODING,
    ]
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Eine vergiftete Sperre heißt nur, dass ein anderer Thread abgestürzt ist; die Daten bleiben nutzbar.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ------------------------------------------------------------------------------------------ Ziel */

/// Der Jellyfin-Server, an den weitergereicht wird, samt vorbereiteten Anmelde-Headern.
#[derive(Debug, Clone)]
pub struct Target {
    /// Ursprung plus Pfad ohne `/` am Ende, z. B. `http://192.168.1.5:8096` oder `https://host/jellyfin`.
    base: String,
    /// `scheme://host[:port]` – Vergleichswert für Weiterleitungen und Wiedergabelisten.
    origin: String,
    /// Pfadanteil der Basis (`""` oder `/jellyfin`).
    base_path: String,
    scheme: String,
    token: Option<HeaderValue>,
    authorization: Option<HeaderValue>,
}

impl Target {
    /// Prüft die Server-Adresse (nur http/https, Host nötig, keine Zugangsdaten, kein `?`/`#`) und den API-Schlüssel.
    pub fn new(base_url: &str, api_key: &str) -> Result<Target, String> {
        let raw = base_url.trim();
        if raw.is_empty() {
            return Err("Keine Server-Adresse angegeben".into());
        }
        // Die Eingabe wird nicht zitiert: sie könnte (falsch eingegebene) Zugangsdaten enthalten.
        let url = Url::parse(raw).map_err(|_| {
            "Ungültige Server-Adresse (erwartet z. B. http://192.168.1.5:8096)".to_string()
        })?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(format!(
                "Nur http:// und https:// sind erlaubt (nicht {}://)",
                url.scheme()
            ));
        }
        if url.host_str().is_none_or(str::is_empty) {
            return Err("Die Server-Adresse enthält keinen Rechnernamen".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(
                "Die Server-Adresse darf keinen Benutzernamen und kein Passwort enthalten".into(),
            );
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err("Die Server-Adresse darf kein ? und kein # enthalten".into());
        }
        let origin = url.origin().ascii_serialization();
        let base_path = url.path().trim_end_matches('/').to_string();
        let base = format!("{origin}{base_path}");

        let key = api_key.trim();
        let (token, authorization) = if key.is_empty() {
            (None, None)
        } else {
            // Der Schlüssel landet in Header-Werten: sichtbare ASCII-Zeichen, ohne Anführungszeichen/Komma/Backslash,
            // die den "MediaBrowser"-Header von Jellyfin durcheinanderbrächten.
            if !key
                .bytes()
                .all(|b| (0x21..=0x7e).contains(&b) && !matches!(b, b'"' | b',' | b'\\'))
            {
                return Err("Der API-Schlüssel enthält ungültige Zeichen".into());
            }
            let invalid = |_| "Der API-Schlüssel enthält ungültige Zeichen".to_string();
            let mut token = HeaderValue::from_str(key).map_err(invalid)?;
            let mut authorization = HeaderValue::from_str(&format!(
                "MediaBrowser Client=\"JellyStation\", Token=\"{key}\""
            ))
            .map_err(invalid)?;
            // Schützt vor Ausgabe in Debug-/Fehlertexten.
            token.set_sensitive(true);
            authorization.set_sensitive(true);
            (Some(token), Some(authorization))
        };

        Ok(Target {
            base,
            origin,
            base_path,
            scheme: url.scheme().to_string(),
            token,
            authorization,
        })
    }

    /// Ursprung plus Pfad der Basis (für Tests und Meldungen; enthält nie den Schlüssel).
    pub fn base(&self) -> &str {
        &self.base
    }

    fn same_origin(&self, url: &Url) -> bool {
        url.username().is_empty()
            && url.password().is_none()
            && url.origin().ascii_serialization() == self.origin
    }

    /// Setzt die Adresse für den Jellyfin-Server zusammen: `<Basis><Pfad>?<Query>` mit dem Pfad exakt wie empfangen.
    fn upstream_url(&self, rest: &str, query: Option<&str>) -> Result<Url, Failure> {
        let mut text =
            String::with_capacity(self.base.len() + rest.len() + query.map_or(0, |q| q.len() + 1));
        text.push_str(&self.base);
        text.push_str(rest);
        if let Some(query) = query {
            text.push('?');
            text.push_str(query);
        }
        let url = Url::parse(&text).map_err(|_| Failure::bad_request("Ungültiger Pfad"))?;
        // Zweite Absicherung zusätzlich zu check_upstream_path: Ursprung und Basispfad dürfen sich nicht verändert haben.
        let inside_base = self.base_path.is_empty()
            || url.path() == self.base_path
            || url
                .path()
                .strip_prefix(&self.base_path)
                .is_some_and(|tail| tail.starts_with('/'));
        if !self.same_origin(&url) || !inside_base {
            return Err(Failure::bad_request(
                "Der Pfad führt aus dem Jellyfin-Server hinaus",
            ));
        }
        Ok(url)
    }

    /// Entfernt einen Basispfad (`/jellyfin`) vom Anfang eines Pfades, damit `Proxy + Rest` wieder auf `Basis + Rest` führt.
    fn strip_base_path<'a>(&self, path_and_rest: &'a str) -> Cow<'a, str> {
        if self.base_path.is_empty() {
            return Cow::Borrowed(path_and_rest);
        }
        match path_and_rest.strip_prefix(&self.base_path) {
            Some("") => Cow::Borrowed("/"),
            Some(tail) if tail.starts_with('/') => Cow::Borrowed(tail),
            Some(tail) if tail.starts_with(['?', '#']) => Cow::Owned(format!("/{tail}")),
            _ => Cow::Borrowed(path_and_rest),
        }
    }
}

/* ------------------------------------------------------------------------------ Pfad-Prüfungen */

/// Teilt den Pfad der Anfrage in den Rest hinter `/p/<Token>` (beginnt mit `/` oder ist leer).
/// `None`, wenn das Präfix fehlt oder der Token nicht stimmt (konstantzeitiger Vergleich).
fn strip_prefix<'a>(token: &str, path: &'a str) -> Option<&'a str> {
    let after = path.strip_prefix("/p/")?;
    let (given, rest) = match after.find('/') {
        Some(index) => after.split_at(index),
        None => (after, ""),
    };
    bool::from(given.as_bytes().ct_eq(token.as_bytes())).then_some(rest)
}

fn percent_decode(input: &[u8]) -> Vec<u8> {
    fn hex(byte: u8) -> Option<u8> {
        char::from(byte)
            .to_digit(16)
            .and_then(|d| u8::try_from(d).ok())
    }
    let mut out = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' && index + 2 < input.len() {
            if let (Some(high), Some(low)) = (hex(input[index + 1]), hex(input[index + 2])) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(input[index]);
        index += 1;
    }
    out
}

/// Ist `piece` (ohne Pfadparameter hinter `;`) ein Punkt-Segment?
fn is_dot_segment(piece: &[u8]) -> bool {
    let head = piece.split(|byte| *byte == b';').next().unwrap_or_default();
    head == b"." || head == b".."
}

/// Prüft ein einzelnes Pfadsegment auch in kodierter Form (`%2e%2e`, `%252e%252e`, `%2e%2e%2f`, `..;x` …).
/// Ein kodiertes `/` (z. B. in "AC%2FDC") ist erlaubt, solange dadurch kein Punkt-Segment entsteht.
fn check_segment(segment: &str) -> Result<(), &'static str> {
    let mut current = segment.as_bytes().to_vec();
    for round in 0..4 {
        if current.split(|byte| *byte == b'/').any(is_dot_segment) {
            return Err("Punkt-Segmente (. und ..) sind nicht erlaubt");
        }
        if round > 0 && current.iter().any(|&b| b < 0x20 || b == 0x7f || b == b'\\') {
            return Err("Kodierte Steuerzeichen oder Rückwärts-Schrägstriche im Pfad");
        }
        let decoded = percent_decode(&current);
        if decoded == current {
            return Ok(());
        }
        current = decoded;
    }
    Err("Mehrfach kodierter Pfad")
}

/// Prüft den Pfad, der an den Jellyfin-Server weitergereicht wird. Alles, was den Ursprung oder den Pfad
/// verändern könnte, wird abgelehnt: `..`, Rückwärts-Schrägstrich, `//`, `@`, Steuerzeichen, kodierte Varianten.
fn check_upstream_path(rest: &str) -> Result<(), &'static str> {
    if rest.len() > MAX_PATH_BYTES {
        return Err("Pfad zu lang");
    }
    if !rest.starts_with('/') {
        return Err("Pfad muss mit / beginnen");
    }
    for byte in rest.bytes() {
        // Auch das Leerzeichen: Ein Leerzeichen am Ende würde die URL-Bibliothek stillschweigend abschneiden
        // ("/a/.. " würde zu "/a/.."), und in einer echten Anfragezeile kann es ohnehin nur als %20 vorkommen.
        if byte <= 0x20 || byte == 0x7f || byte >= 0x80 {
            return Err("Steuer-, Leer- oder Sonderzeichen im Pfad");
        }
        if byte == b'\\' {
            return Err("Rückwärts-Schrägstrich im Pfad");
        }
        if byte == b'@' {
            return Err("@ ist im Pfad nicht erlaubt");
        }
    }
    if rest.contains("//") {
        return Err("Doppelter Schrägstrich im Pfad");
    }
    rest.split('/').try_for_each(check_segment)
}

/* ----------------------------------------------------------------------------------- Fehlerantworten */

/// Ein Fehler, der als kurze Textantwort zum Browser geht.
#[derive(Debug)]
struct Failure {
    status: StatusCode,
    message: String,
}

impl Failure {
    fn new(status: StatusCode, message: impl Into<String>) -> Failure {
        Failure {
            status,
            message: message.into(),
        }
    }
    fn not_found() -> Failure {
        Failure::new(StatusCode::NOT_FOUND, "Nicht gefunden")
    }
    fn bad_request(reason: &str) -> Failure {
        Failure::new(
            StatusCode::BAD_REQUEST,
            format!("Ungültige Anfrage: {reason}"),
        )
    }
    fn bad_gateway(message: impl Into<String>) -> Failure {
        Failure::new(StatusCode::BAD_GATEWAY, message)
    }

    fn into_response(self) -> Response<ProxyBody> {
        let mut response = Response::new(full_body(Bytes::from(self.message)));
        *response.status_mut() = self.status;
        let headers = response.headers_mut();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if self.status == StatusCode::METHOD_NOT_ALLOWED {
            headers.insert(ALLOW, HeaderValue::from_static("GET, HEAD, OPTIONS"));
        }
        response
    }
}

fn full_body(bytes: Bytes) -> ProxyBody {
    Full::new(bytes)
        .map_err(|never: Infallible| match never {})
        .boxed_unsync()
}

fn empty_body() -> ProxyBody {
    Empty::<Bytes>::new()
        .map_err(|never: Infallible| match never {})
        .boxed_unsync()
}

/// Kurzer deutscher Text zu einem Fehler des Upstream-Clients. Die Fehlermeldung von reqwest selbst wird bewusst
/// nicht verwendet: sie enthält die angefragte Adresse, und die kann den API-Schlüssel (`api_key=…`) tragen.
fn upstream_error_text(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "Zeitüberschreitung beim Jellyfin-Server".into();
    }
    let mut reason: Option<&str> = None;
    let mut source = err.source();
    while let Some(inner) = source {
        let text = inner.to_string().to_lowercase();
        if let Some(io_err) = inner.downcast_ref::<io::Error>() {
            match io_err.kind() {
                io::ErrorKind::ConnectionRefused => {
                    reason = Some("Verbindung abgelehnt – läuft der Jellyfin-Server?")
                }
                io::ErrorKind::HostUnreachable | io::ErrorKind::NetworkUnreachable => {
                    reason = Some("Server nicht erreichbar")
                }
                io::ErrorKind::TimedOut => reason = Some("Zeitüberschreitung beim Verbinden"),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted => {
                    reason = Some("Verbindung vom Server zurückgesetzt");
                }
                _ => {}
            }
        }
        if reason.is_none() {
            if text.contains("dns error")
                || text.contains("failed to lookup")
                || text.contains("name or service not known")
            {
                reason = Some("Servername nicht auflösbar");
            } else if text.contains("certificate")
                || text.contains("unknownissuer")
                || text.contains("invalid peer")
            {
                reason = Some("Zertifikat des Servers nicht vertrauenswürdig");
            }
        }
        source = inner.source();
    }
    if err.is_connect() {
        format!(
            "Jellyfin-Server nicht erreichbar: {}",
            reason.unwrap_or("Verbindung fehlgeschlagen")
        )
    } else if err.is_body() || err.is_decode() {
        format!(
            "Verbindung zum Jellyfin-Server abgebrochen{}",
            reason.map_or(String::new(), |r| format!(": {r}"))
        )
    } else {
        format!(
            "Anfrage an den Jellyfin-Server fehlgeschlagen{}",
            reason.map_or(String::new(), |r| format!(": {r}"))
        )
    }
}

/* ------------------------------------------------------------------------------- HLS-Wiedergabelisten */

/// Ersetzt in einer Tag-Zeile jeden Wert von `URI="…"`. Nur echte Attribute (direkt nach ":" oder ","),
/// damit z. B. `X-ASSET-URI="…"` unangetastet bleibt. Ein nicht geschlossenes Anführungszeichen bleibt, wie es ist.
fn map_uri_attributes(line: &str, map: &dyn Fn(&str) -> String) -> String {
    const KEY: &str = "URI=\"";
    let mut out = String::with_capacity(line.len() + 64);
    let mut done = 0; // Bis hierher ist `line` bereits nach `out` übernommen.
    let mut search = 0;
    while let Some(found) = line[search..].find(KEY) {
        let key_at = search + found;
        let value_at = key_at + KEY.len();
        let is_attribute = key_at > 0 && matches!(line.as_bytes()[key_at - 1], b':' | b',');
        match line[value_at..].find('"') {
            Some(length) if is_attribute => {
                out.push_str(&line[done..value_at]);
                out.push_str(&map(&line[value_at..value_at + length]));
                done = value_at + length;
                search = done;
            }
            _ => search = value_at,
        }
    }
    out.push_str(&line[done..]);
    out
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn ends_with_ignore_case(text: &str, suffix: &str) -> bool {
    text.len() >= suffix.len()
        && text.as_bytes()[text.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
}

fn join_prefix(prefix: &str, path: &str) -> String {
    if path.starts_with('/') {
        format!("{prefix}{path}")
    } else {
        format!("{prefix}/{path}")
    }
}

/// Schreibt eine Adresse aus einer Wiedergabeliste um: absolute Adressen des Zielservers und root-relative Pfade
/// zeigen danach auf den Proxy; relative Adressen und fremde Hosts bleiben unverändert.
fn map_playlist_uri(uri: &str, prefix: &str, target: &Target) -> String {
    let absolute: Option<Cow<'_, str>> =
        if starts_with_ignore_case(uri, "http://") || starts_with_ignore_case(uri, "https://") {
            Some(Cow::Borrowed(uri))
        } else if uri.starts_with("//") {
            Some(Cow::Owned(format!("{}:{uri}", target.scheme)))
        } else {
            None
        };
    if let Some(absolute) = absolute {
        return match Url::parse(&absolute) {
            Ok(url) if target.same_origin(&url) => {
                let mut tail = url.path().to_string();
                if let Some(query) = url.query() {
                    tail.push('?');
                    tail.push_str(query);
                }
                if let Some(fragment) = url.fragment() {
                    tail.push('#');
                    tail.push_str(fragment);
                }
                join_prefix(prefix, &target.strip_base_path(&tail))
            }
            _ => uri.to_string(),
        };
    }
    if uri.starts_with('/') {
        return join_prefix(prefix, &target.strip_base_path(uri));
    }
    uri.to_string()
}

/// Schreibt eine HLS-Wiedergabeliste so um, dass alle Adressen des Jellyfin-Servers über den Proxy laufen.
/// Betroffen sind URI-Zeilen (Varianten, Segmente) und `URI="…"`-Attribute (EXT-X-MAP, EXT-X-KEY, EXT-X-MEDIA …).
/// Zeilenenden (`\n` oder `\r\n`) bleiben erhalten.
pub fn rewrite_playlist(text: &str, prefix: &str, target: &Target) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    for raw in text.split_inclusive('\n') {
        let body = raw.strip_suffix('\n').unwrap_or(raw);
        let (line, line_end) = match body.strip_suffix('\r') {
            Some(line) => (line, &raw[line.len()..]),
            None => (body, &raw[body.len()..]),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push_str(line);
        } else if trimmed.starts_with('#') {
            out.push_str(&map_uri_attributes(line, &|uri| {
                map_playlist_uri(uri, prefix, target)
            }));
        } else {
            out.push_str(&map_playlist_uri(trimmed, prefix, target));
        }
        out.push_str(line_end);
    }
    out
}

fn is_playlist_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("mpegurl"))
}

/* --------------------------------------------------------------------------------------- Anfragen */

struct Shared {
    token: String,
    prefix: String,
    target: RwLock<Arc<Target>>,
    client: reqwest::Client,
}

impl Shared {
    fn target(&self) -> Arc<Target> {
        let guard = self
            .target
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(&guard)
    }

    fn set_target(&self, target: Target) {
        let mut guard = self
            .target
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Arc::new(target);
    }
}

fn build_client(timeouts: Timeouts) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Ein LAN-Server soll direkt erreicht werden, nie über einen System-Proxy.
        .no_proxy()
        // Weiterleitungen prüfen wir selbst (nur derselbe Ursprung, sonst ginge der Schlüssel zu fremden Hosts).
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeouts.connect)
        .read_timeout(timeouts.read)
        .tcp_keepalive(Duration::from_secs(30))
        .user_agent(concat!("JellyStation/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| format!("HTTP-Client konnte nicht erstellt werden: {err}"))
}

/// Header, die zum Jellyfin-Server gehen: Weißliste aus der Anfrage plus Anmeldung.
fn upstream_headers(request: &HeaderMap, target: &Target) -> HeaderMap {
    let mut out = HeaderMap::new();
    for name in forwarded_request_headers() {
        if let Some(value) = request.get(&name) {
            out.insert(name, value.clone());
        }
    }
    // Medien nie komprimiert abrufen (Range-Angaben beziehen sich auf die Bytes der Datei).
    out.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    if let Some(token) = &target.token {
        out.insert(HeaderName::from_static("x-emby-token"), token.clone());
    }
    if let Some(authorization) = &target.authorization {
        out.insert(AUTHORIZATION, authorization.clone());
    }
    out
}

/// Ruft den Jellyfin-Server ab. Weiterleitungen werden nur innerhalb desselben Ursprungs verfolgt; die Anmeldung
/// geht nie an einen anderen Host.
async fn fetch(
    client: &reqwest::Client,
    method: Method,
    first: Url,
    headers: &HeaderMap,
    target: &Target,
) -> Result<reqwest::Response, Failure> {
    let mut url = first;
    for _ in 0..=MAX_REDIRECTS {
        let response = client
            .request(method.clone(), url.clone())
            .headers(headers.clone())
            .send()
            .await
            .map_err(|err| Failure::bad_gateway(upstream_error_text(&err)))?;
        if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let Some(location) = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
        else {
            return Ok(response);
        };
        let next = url.join(location).map_err(|_| {
            Failure::bad_gateway("Der Jellyfin-Server hat eine ungültige Weiterleitung geschickt")
        })?;
        if !target.same_origin(&next) {
            return Err(Failure::bad_gateway(format!(
                "Der Jellyfin-Server leitet auf {} um. Dieser Weiterleitung folgt der Proxy nicht (die Anmeldung ginge an einen anderen Server); bitte die endgültige Adresse in den Einstellungen eintragen.",
                next.origin().ascii_serialization()
            )));
        }
        url = next;
    }
    Err(Failure::bad_gateway(
        "Der Jellyfin-Server leitet zu oft weiter",
    ))
}

fn copy_response_headers(from: &HeaderMap, to: &mut HeaderMap) {
    for name in forwarded_response_headers() {
        if let Some(value) = from.get(&name) {
            to.insert(name, value.clone());
        }
    }
}

fn stream_body(response: reqwest::Response) -> ProxyBody {
    let stream = response
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(|err| io::Error::other(upstream_error_text(&err)));
    StreamBody::new(stream).boxed_unsync()
}

/// Liest eine Wiedergabeliste vollständig (höchstens 4 MB), schreibt sie um und antwortet mit neuer Länge.
async fn playlist_response(
    mut response: reqwest::Response,
    head: bool,
    prefix: &str,
    target: &Target,
) -> Result<Response<ProxyBody>, Failure> {
    let too_large = || Failure::bad_gateway("Die Wiedergabeliste des Jellyfin-Servers ist zu groß");
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PLAYLIST_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut data: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| Failure::bad_gateway(upstream_error_text(&err)))?
    {
        if data.len() + chunk.len() > MAX_PLAYLIST_BYTES {
            return Err(too_large());
        }
        data.extend_from_slice(&chunk);
    }
    let rewritten = rewrite_playlist(&String::from_utf8_lossy(&data), prefix, target);
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/vnd.apple.mpegurl"));
    let length = rewritten.len();
    let body = if head {
        empty_body()
    } else {
        full_body(Bytes::from(rewritten))
    };
    Response::builder()
        // Ein Teilinhalt (206) wäre nach dem Umschreiben falsch: immer die ganze Liste mit 200.
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, length)
        .header(CACHE_CONTROL, "no-store")
        .body(body)
        .map_err(|_| Failure::bad_gateway("Antwort konnte nicht aufgebaut werden"))
}

async fn route(
    shared: &Shared,
    request: Request<Incoming>,
) -> Result<Response<ProxyBody>, Failure> {
    let uri = request.uri();
    // Nur "origin-form" (/pfad?query); eine absolute Adresse im Anfragekopf ist ein Umgehungsversuch.
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err(Failure::bad_request("Absolute Adressen sind nicht erlaubt"));
    }
    let Some(rest) = strip_prefix(&shared.token, uri.path()) else {
        return Err(Failure::not_found());
    };
    let head = match *request.method() {
        Method::GET => false,
        Method::HEAD => true,
        Method::OPTIONS => return Ok(preflight(request.headers())),
        _ => {
            return Err(Failure::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "Nur GET, HEAD und OPTIONS sind erlaubt",
            ))
        }
    };
    if rest.len() <= 1 {
        return Err(Failure::not_found());
    }
    check_upstream_path(rest).map_err(Failure::bad_request)?;

    let target = shared.target();
    let url = target.upstream_url(rest, uri.query())?;
    let headers = upstream_headers(request.headers(), &target);

    let looks_like_playlist = ends_with_ignore_case(rest, ".m3u8");
    // Die Länge einer umgeschriebenen Liste kennt nur ein GET; HEAD auf Listen wird deshalb als GET abgerufen.
    let upstream_method = if head && looks_like_playlist {
        Method::GET
    } else {
        request.method().clone()
    };
    let mut response = fetch(
        &shared.client,
        upstream_method,
        url.clone(),
        &headers,
        &target,
    )
    .await?;
    // HEAD auf eine Liste, die nur am Content-Type erkennbar ist: ihre umgeschriebene Länge kennt erst ein GET.
    if head
        && !looks_like_playlist
        && response.status().is_success()
        && is_playlist_content_type(response.headers())
    {
        response = fetch(&shared.client, Method::GET, url, &headers, &target).await?;
    }

    let status = response.status();
    if status.is_success() && (looks_like_playlist || is_playlist_content_type(response.headers()))
    {
        return playlist_response(response, head, &shared.prefix, &target).await;
    }
    let mut builder = Response::builder().status(status);
    if let Some(out) = builder.headers_mut() {
        copy_response_headers(response.headers(), out);
    }
    let body = if head || status == StatusCode::NO_CONTENT || status == StatusCode::NOT_MODIFIED {
        empty_body()
    } else {
        stream_body(response)
    };
    builder
        .body(body)
        .map_err(|_| Failure::bad_gateway("Antwort konnte nicht aufgebaut werden"))
}

/// Antwort auf eine CORS-Voranfrage. Die Header, nach denen der Browser fragt, werden gespiegelt: nicht jede
/// WebView-Version kennt `Access-Control-Allow-Headers: *`.
fn preflight(request: &HeaderMap) -> Response<ProxyBody> {
    let mut response = Response::new(empty_body());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    headers.insert(ALLOW, HeaderValue::from_static("GET, HEAD, OPTIONS"));
    if let Some(requested) = request.get("access-control-request-headers") {
        headers.insert("access-control-allow-headers", requested.clone());
    }
    response
}

/// CORS ist offen: Der Zugriff ist durch den Token im Pfad geschützt, und `<track>`/hls.js brauchen CORS-Header.
fn add_cors(headers: &mut HeaderMap) {
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    if !headers.contains_key("access-control-allow-headers") {
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("*"),
        );
    }
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
    headers.insert("access-control-max-age", HeaderValue::from_static("86400"));
    // Chromium fragt bei Zugriffen von https-Seiten auf 127.0.0.1 danach.
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
}

async fn handle(
    shared: Arc<Shared>,
    request: Request<Incoming>,
) -> Result<Response<ProxyBody>, Infallible> {
    let mut response = route(&shared, request)
        .await
        .unwrap_or_else(Failure::into_response);
    add_cors(response.headers_mut());
    Ok(response)
}

async fn serve_connection(stream: TcpStream, shared: Arc<Shared>) {
    // Fehler einer einzelnen Verbindung (Browser bricht ab usw.) sind normal und ohne Folgen für den Server.
    let _ = stream.set_nodelay(true);
    let service = service_fn(move |request| handle(Arc::clone(&shared), request));
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .serve_connection(TokioIo::new(stream), service);
    let _ = connection.await;
}

/// Nimmt Verbindungen an. Wird die Aufgabe abgebrochen, fallen `connections` und mit ihnen alle laufenden
/// Verbindungen (und deren Abrufe beim Jellyfin-Server) weg.
async fn serve(listener: StdTcpListener, shared: Arc<Shared>) {
    let listener = match TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("Medien-Proxy: Listener nicht nutzbar: {err}");
            return;
        }
    };
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    connections.spawn(serve_connection(stream, Arc::clone(&shared)));
                }
                // Meist "zu viele offene Dateien": kurz warten statt im Kreis zu laufen.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/* ------------------------------------------------------------------------------------ Verwaltung */

struct Running {
    shared: Arc<Shared>,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Der Proxy als Tauri-State: höchstens ein Server, das Ziel ist jederzeit umstellbar.
#[derive(Default)]
pub struct MediaProxy {
    running: Mutex<Option<Running>>,
}

impl MediaProxy {
    /// Startet den Server (falls er noch nicht läuft) und stellt das Ziel ein. Gibt das Präfix zurück:
    /// `http://127.0.0.1:PORT/p/TOKEN` (ohne `/` am Ende). Bei laufendem Server bleibt das Präfix gleich.
    pub fn start(&self, base_url: &str, api_key: &str) -> Result<String, String> {
        self.start_with(base_url, api_key, Timeouts::default())
    }

    /// Wie [`MediaProxy::start`] mit eigenen Zeitlimits (gelten nur, wenn dabei ein neuer Server entsteht).
    pub fn start_with(
        &self,
        base_url: &str,
        api_key: &str,
        timeouts: Timeouts,
    ) -> Result<String, String> {
        let target = Target::new(base_url, api_key)?;
        let mut running = lock(&self.running);
        if let Some(current) = running.as_ref() {
            if !current.task.inner().is_finished() {
                current.shared.set_target(target);
                return Ok(current.shared.prefix.clone());
            }
        }

        let client = build_client(timeouts)?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|err| format!("Zufallszahlen sind nicht verfügbar: {err}"))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();

        let listener = StdTcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|err| format!("Medien-Proxy konnte nicht gestartet werden: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("Medien-Proxy konnte nicht gestartet werden: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("Medien-Proxy konnte nicht gestartet werden: {err}"))?
            .port();

        let prefix = format!("http://127.0.0.1:{port}/p/{token}");
        let shared = Arc::new(Shared {
            token,
            prefix: prefix.clone(),
            target: RwLock::new(Arc::new(target)),
            client,
        });
        let task = tauri::async_runtime::spawn(serve(listener, Arc::clone(&shared)));
        *running = Some(Running { shared, task });
        Ok(prefix)
    }

    /// Beendet den Server samt aller laufenden Verbindungen.
    pub fn stop(&self) {
        if let Some(current) = lock(&self.running).take() {
            current.task.abort();
        }
    }

    /// Das Präfix des laufenden Servers.
    pub fn prefix(&self) -> Option<String> {
        lock(&self.running)
            .as_ref()
            .filter(|current| !current.task.inner().is_finished())
            .map(|current| current.shared.prefix.clone())
    }
}

impl Drop for MediaProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Startet den Medien-Proxy (idempotent) und stellt Server und API-Schlüssel ein. Rückgabe: Präfix
/// `http://127.0.0.1:PORT/p/TOKEN`; `GET|HEAD <Präfix>/<Pfad>?<Query>` geht als `<baseUrl>/<Pfad>?<Query>` an Jellyfin.
#[tauri::command]
pub async fn media_proxy_start(
    state: tauri::State<'_, MediaProxy>,
    base_url: String,
    api_key: String,
) -> Result<String, String> {
    state.start(&base_url, &api_key)
}

/// Beendet den Medien-Proxy.
#[tauri::command]
pub async fn media_proxy_stop(state: tauri::State<'_, MediaProxy>) -> Result<(), String> {
    state.stop();
    Ok(())
}

#[cfg(test)]
mod tests;
