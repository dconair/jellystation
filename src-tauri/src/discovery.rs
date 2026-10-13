//! Jellyfin-Server im lokalen Netz finden: Jellyfin antwortet auf UDP-Broadcasts an Port 7359
//! (Nachricht "who is JellyfinServer?") mit einem JSON-Objekt { Address, Id, Name }.

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;
use tokio::time::{timeout_at, Instant};

const DISCOVERY_PORT: u16 = 7359;
const QUESTION: &[u8] = b"who is JellyfinServer?";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FoundServer {
    pub address: String,
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Reply {
    address: Option<String>,
    id: Option<String>,
    name: Option<String>,
}

/// Ersetzt eine Adresse, die nur auf dem Server selbst gilt (127.0.0.1, localhost, 0.0.0.0), durch die Absenderadresse
/// der Antwort. Jellyfin meldet seine `LocalAddress` unverändert; steht dort Loopback, ist sie von anderen Geräten aus nutzlos.
fn reachable_address(address: &str, from: Option<IpAddr>) -> String {
    let Some(from) = from else { return address.to_string() };
    let Some((scheme, rest)) = address.split_once("://") else { return address.to_string() };
    let (host_port, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    // Port abtrennen (IPv6 in eckigen Klammern wird nicht umgeschrieben).
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') && p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
        _ => (host_port, None),
    };
    let host_lower = host.to_ascii_lowercase();
    let is_local_only = host_lower == "localhost" || host_lower == "0.0.0.0" || host_lower.starts_with("127.");
    if !is_local_only || from.is_loopback() {
        return address.to_string();
    }
    let ip = match from {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    };
    match port {
        Some(p) => format!("{scheme}://{ip}:{p}{path}"),
        None => format!("{scheme}://{ip}{path}"),
    }
}

/// Wertet eine Antwort aus. Nur http(s)-Adressen ohne Zeilenumbrüche und Leerzeichen werden übernommen.
/// `from` ist der Absender der Antwort; er ersetzt eine Loopback-Adresse (siehe `reachable_address`).
pub fn parse_reply(data: &[u8], from: Option<IpAddr>) -> Option<FoundServer> {
    let reply: Reply = serde_json::from_slice(data).ok()?;
    let address = reply.address?.trim().trim_end_matches('/').to_string();
    let lower = address.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://"))
        || address.len() > 300
        || address.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let address = reachable_address(&address, from);
    let id = reply.id.unwrap_or_default();
    let name = reply.name.unwrap_or_default();
    Some(FoundServer {
        name: if name.trim().is_empty() {
            address.clone()
        } else {
            name.chars().take(80).collect()
        },
        id: id.chars().take(64).collect(),
        address,
    })
}

/// Sucht `wait_ms` Millisekunden (300–5000) nach Servern; liefert jeden Server nur einmal.
#[tauri::command]
pub async fn jellyfin_discover(wait_ms: Option<u64>) -> Result<Vec<FoundServer>, String> {
    let wait = Duration::from_millis(wait_ms.unwrap_or(1500).clamp(300, 5000));
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|e| format!("Die Suche im Netzwerk ließ sich nicht starten ({e})"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("Die Suche im Netzwerk ließ sich nicht starten ({e})"))?;
    let target = SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT));
    socket
        .send_to(QUESTION, target)
        .await
        .map_err(|e| format!("Die Suche im Netzwerk wurde blockiert ({e})"))?;

    let deadline = Instant::now() + wait;
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    let mut buf = [0u8; 2048];
    while let Ok(Ok((n, peer))) = timeout_at(deadline, socket.recv_from(&mut buf)).await {
        if let Some(server) = parse_reply(&buf[..n], Some(peer.ip())) {
            if seen.insert(server.address.clone()) {
                found.push(server);
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_normal_reply() {
        let s = parse_reply(
            br#"{"Address":"http://192.168.1.20:8096/","Id":"abc","Name":"Wohnzimmer"}"#,
            None,
        )
        .unwrap();
        assert_eq!(s.address, "http://192.168.1.20:8096");
        assert_eq!(s.name, "Wohnzimmer");
    }

    #[test]
    fn rejects_foreign_schemes_and_junk() {
        assert!(parse_reply(br#"{"Address":"javascript:alert(1)"}"#, None).is_none());
        assert!(parse_reply(br#"{"Address":"http://a b"}"#, None).is_none());
        assert!(parse_reply(b"nope", None).is_none());
        assert!(parse_reply(br#"{"Name":"x"}"#, None).is_none());
    }

    #[test]
    fn falls_back_to_address_as_name() {
        let s = parse_reply(br#"{"Address":"https://jf.example"}"#, None).unwrap();
        assert_eq!(s.name, "https://jf.example");
    }

    #[test]
    fn replaces_loopback_with_the_sender() {
        let from = Some("192.168.178.169".parse().unwrap());
        let s = parse_reply(br#"{"Address":"http://127.0.0.1:8096","Name":"JELLOFIN"}"#, from).unwrap();
        assert_eq!(s.address, "http://192.168.178.169:8096");
        let s = parse_reply(br#"{"Address":"http://localhost:8096/jf"}"#, from).unwrap();
        assert_eq!(s.address, "http://192.168.178.169:8096/jf");
        // Normale Adressen bleiben, wie der Server sie meldet.
        let s = parse_reply(br#"{"Address":"http://192.168.1.20:8096"}"#, from).unwrap();
        assert_eq!(s.address, "http://192.168.1.20:8096");
    }
}
