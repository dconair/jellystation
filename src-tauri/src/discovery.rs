//! Jellyfin-Server im lokalen Netz finden: Jellyfin antwortet auf UDP-Broadcasts an Port 7359
//! (Nachricht "who is JellyfinServer?") mit einem JSON-Objekt { Address, Id, Name }.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr};
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

/// Wertet eine Antwort aus. Nur http(s)-Adressen ohne Zeilenumbrüche und Leerzeichen werden übernommen.
pub fn parse_reply(data: &[u8]) -> Option<FoundServer> {
    let reply: Reply = serde_json::from_slice(data).ok()?;
    let address = reply.address?.trim().trim_end_matches('/').to_string();
    let lower = address.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://"))
        || address.len() > 300
        || address.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
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
    while let Ok(Ok((n, _))) = timeout_at(deadline, socket.recv_from(&mut buf)).await {
        if let Some(server) = parse_reply(&buf[..n]) {
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
        )
        .unwrap();
        assert_eq!(s.address, "http://192.168.1.20:8096");
        assert_eq!(s.name, "Wohnzimmer");
    }

    #[test]
    fn rejects_foreign_schemes_and_junk() {
        assert!(parse_reply(br#"{"Address":"javascript:alert(1)"}"#).is_none());
        assert!(parse_reply(br#"{"Address":"http://a b"}"#).is_none());
        assert!(parse_reply(b"nope").is_none());
        assert!(parse_reply(br#"{"Name":"x"}"#).is_none());
    }

    #[test]
    fn falls_back_to_address_as_name() {
        let s = parse_reply(br#"{"Address":"https://jf.example"}"#).unwrap();
        assert_eq!(s.name, "https://jf.example");
    }
}
