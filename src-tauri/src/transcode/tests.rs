use super::*;

#[test]
fn parst_ffmpeg_ausgabe() {
    let text = "Input #0, matroska,webm, from 'x':\n  Duration: 01:42:03.50, start: 0.000000, bitrate: 9000 kb/s\n  Stream #0:0: Video: hevc (Main 10), yuv420p10le, 3840x2160\n  Stream #0:1(eng): Audio: dts (DTS-HD MA), 48000 Hz, 5.1\n  Stream #0:2: Audio: aac, 48000 Hz\n";
    let probe = parse_probe(text).expect("Probe");
    assert!((probe.duration - 6123.5).abs() < 0.001);
    assert_eq!(probe.video.as_deref(), Some("hevc"));
    assert_eq!(probe.audio.as_deref(), Some("dts"));
    assert!(parse_probe("Duration: N/A, start: 0\n").is_none());
}

#[test]
fn liste_und_segmente_passen_zusammen() {
    assert_eq!(segment_count(13.0), 3);
    assert_eq!(segment_span(13.0, 2), (12.0, 1.0));
    let list = playlist(13.0);
    assert!(list.contains("#EXTINF:1.000,\nseg2.ts"));
    assert!(list.ends_with("#EXT-X-ENDLIST\n"));
    assert_eq!(list.matches("seg").count(), 3);
}

#[test]
fn nur_netzadressen() {
    assert!(valid_source("file:///etc/passwd").is_err());
    assert!(valid_source("  https://example.com/a.mkv ").is_ok());
}

/// Mit echtem ffmpeg: Testvideo (HEVC + DTS-ähnlicher Ton in MKV) erzeugen, über den Server als HLS abrufen
/// und prüfen, dass Segmente gültiges H.264/AAC ergeben. Wird übersprungen, wenn kein ffmpeg da ist.
#[tokio::test(flavor = "multi_thread")]
async fn segmente_aus_einer_datei() {
    let Some(ffmpeg) = find_ffmpeg(&[]) else {
        eprintln!("ffmpeg fehlt – Test übersprungen");
        return;
    };
    let dir = std::env::temp_dir().join(format!("jellystation-transcode-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("quelle.mkv");
    let made = command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "lavfi", "-i", "testsrc=d=14:s=640x360:r=24", "-f", "lavfi", "-i", "sine=d=14"])
        .args(["-c:v", "libx265", "-c:a", "ac3", "-f", "matroska"])
        .arg(&src)
        .status()
        .unwrap();
    if !made.success() {
        eprintln!("ffmpeg kann kein HEVC/AC-3 – Test übersprungen");
        return;
    }
    let url = src.to_string_lossy().to_string();
    let (ffmpeg, probe) = prepare(&url, "file,pipe", &[], Some(ffmpeg)).expect("prepare");
    assert_eq!(probe.video.as_deref(), Some("hevc"));
    assert!((probe.duration - 14.0).abs() < 0.5, "Dauer {}", probe.duration);

    let t = Transcode::default();
    let info = t.launch(&ffmpeg, &url, "file,pipe", probe).expect("launch");
    let base = info.url.trim_end_matches("index.m3u8").to_string();

    async fn get(url: &str) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut stream = TcpStream::connect(host).await.unwrap();
        stream
            .write_all(format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&raw[..split]).to_string(), raw[split + 4..].to_vec())
    }

    let (head, body) = get(&info.url).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(String::from_utf8_lossy(&body).contains("seg2.ts"));
    let (bad_head, _) = get(&format!("http://{}/t/falsch/seg0.ts", base.strip_prefix("http://").unwrap().split('/').next().unwrap())).await;
    assert!(bad_head.starts_with("HTTP/1.1 403"), "{bad_head}");

    for i in 0..3 {
        let (head, body) = get(&format!("{base}seg{i}.ts")).await;
        assert!(head.starts_with("HTTP/1.1 200"), "Segment {i}: {head}");
        assert!(body.len() > 1000, "Segment {i} leer");
        let out = dir.join(format!("seg{i}.ts"));
        std::fs::write(&out, &body).unwrap();
        let probe = command(&ffmpeg).args(["-hide_banner", "-i"]).arg(&out).output().unwrap();
        let text = String::from_utf8_lossy(&probe.stderr).to_string();
        assert!(text.contains("Video: h264"), "Segment {i}: {text}");
        assert!(text.contains("Audio: aac"), "Segment {i}: {text}");
        // Zeitstempel behalten die Lage in der Quelle: Segment i beginnt bei i * 6 s.
        let start = text.lines().find_map(|l| l.trim().strip_prefix("Duration:").and_then(|r| r.split("start:").nth(1)).and_then(|r| r.split(',').next()).and_then(|r| r.trim().parse::<f64>().ok())).unwrap_or(-1.0);
        assert!((start - i as f64 * 6.0).abs() < 0.3, "Segment {i} beginnt bei {start}");
    }
    t.stop();
    let _ = std::fs::remove_dir_all(&dir);
}
