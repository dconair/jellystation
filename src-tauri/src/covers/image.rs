//! Bilder erkennen und prüfen, ohne sie zu dekodieren.
//!
//! Cover werden unverändert gespeichert. Hier wird nur geprüft, ob die Bytes wirklich ein Bild sind (PNG, JPEG,
//! WebP) und wie groß es ist – damit weder eine HTML-Fehlerseite noch verschlüsselter Datenmüll aus einem
//! PS3-Abbild im Cache landet.

/// Größte Seitenlänge, die als Cover durchgeht (Schutz vor Dekompressionsbomben und Zufallstreffern).
pub const MAX_DIMENSION: u32 = 8192;

/// Format und Größe eines geprüften Bildes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    /// Dateiendung ohne Punkt: `png`, `jpg` oder `webp`.
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
}

/// Erkennt das Format an den ersten Bytes und liest die Größe aus dem Kopf. `None`, wenn es kein
/// plausibles PNG/JPEG/WebP ist. PNG wird streng geprüft (alle Prüfsummen, `IEND`), JPEG/WebP nur im Kopf.
pub fn sniff_image(data: &[u8]) -> Option<ImageInfo> {
    validate_png(data)
        .or_else(|| jpeg_info(data))
        .or_else(|| webp_info(data))
}

/// Größe eines Bildes aus den ersten Bytes der Datei (nur Kopf, keine Prüfsummen) – für Bilder, die wir selbst
/// gespeichert haben.
pub fn peek_image(head: &[u8]) -> Option<ImageInfo> {
    if head.len() >= 24 && head[..8] == PNG_SIGNATURE && &head[12..16] == b"IHDR" {
        let (width, height) = (be32(head, 16)?, be32(head, 20)?);
        return plausible(width, height).then_some(ImageInfo {
            ext: "png",
            width,
            height,
        });
    }
    jpeg_info(head).or_else(|| webp_info(head))
}

fn plausible(width: u32, height: u32) -> bool {
    (1..=MAX_DIMENSION).contains(&width) && (1..=MAX_DIMENSION).contains(&height)
}

/* ---------------------------------------------------------------------------------------- PNG */

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32 (IEEE) wie in PNG.
fn crc32(parts: &[&[u8]]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for part in parts {
        for byte in *part {
            crc = CRC_TABLE[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    crc ^ 0xffff_ffff
}

fn be32(data: &[u8], at: usize) -> Option<u32> {
    let bytes = data.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

/// Strenge PNG-Prüfung: Signatur, `IHDR` zuerst, mindestens ein `IDAT`, jede Prüfsumme stimmt, `IEND` am Ende.
/// Verschlüsselte oder abgeschnittene Daten (z. B. aus einem verschlüsselten PS3-Abbild) fallen hier durch.
pub fn validate_png(data: &[u8]) -> Option<ImageInfo> {
    if data.len() < 8 + 25 + 12 || data[..8] != PNG_SIGNATURE {
        return None;
    }
    let mut pos = 8usize;
    let mut size = None;
    let mut seen_data = false;
    let mut first = true;
    loop {
        let length = be32(data, pos)? as usize;
        let kind = data.get(pos + 4..pos + 8)?;
        let body = data.get(pos + 8..pos.checked_add(8)?.checked_add(length)?)?;
        let stored = be32(data, pos + 8 + length)?;
        if crc32(&[kind, body]) != stored {
            return None;
        }
        if first {
            if kind != b"IHDR" || length != 13 {
                return None;
            }
            size = Some((be32(body, 0)?, be32(body, 4)?));
            first = false;
        } else if kind == b"IDAT" {
            seen_data = true;
        } else if kind == b"IEND" {
            let (width, height) = size?;
            return (seen_data && plausible(width, height)).then_some(ImageInfo {
                ext: "png",
                width,
                height,
            });
        }
        pos += 12 + length;
    }
}

/* --------------------------------------------------------------------------------------- JPEG */

fn jpeg_info(data: &[u8]) -> Option<ImageInfo> {
    if data.len() < 4 || data[..3] != [0xff, 0xd8, 0xff] {
        return None;
    }
    let mut pos = 2usize;
    loop {
        // Füllbytes 0xFF überspringen, dann steht die Markierung
        while *data.get(pos)? == 0xff && *data.get(pos + 1)? == 0xff {
            pos += 1;
        }
        if *data.get(pos)? != 0xff {
            return None;
        }
        let marker = *data.get(pos + 1)?;
        pos += 2;
        match marker {
            // Markierungen ohne Länge
            0x01 | 0xd0..=0xd7 => continue,
            // Ende des Bildes oder Beginn der Bilddaten vor einem Größenfeld: kein brauchbares JPEG
            0xd8..=0xda => return None,
            _ => {}
        }
        let length = usize::from(u16::from_be_bytes([*data.get(pos)?, *data.get(pos + 1)?]));
        if length < 2 {
            return None;
        }
        let is_frame = matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if is_frame {
            let height = u32::from(u16::from_be_bytes([
                *data.get(pos + 3)?,
                *data.get(pos + 4)?,
            ]));
            let width = u32::from(u16::from_be_bytes([
                *data.get(pos + 5)?,
                *data.get(pos + 6)?,
            ]));
            return plausible(width, height).then_some(ImageInfo {
                ext: "jpg",
                width,
                height,
            });
        }
        pos = pos.checked_add(length)?;
    }
}

/* --------------------------------------------------------------------------------------- WebP */

fn webp_info(data: &[u8]) -> Option<ImageInfo> {
    if data.len() < 30 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return None;
    }
    let (width, height) = match &data[12..16] {
        b"VP8 " => {
            // Bildrahmen-Kopf: 3 Byte Rahmenmarke, Startcode 9D 01 2A, dann 14 Bit Breite und 14 Bit Höhe
            if data[23..26] != [0x9d, 0x01, 0x2a] {
                return None;
            }
            (
                u32::from(u16::from_le_bytes([data[26], data[27]]) & 0x3fff),
                u32::from(u16::from_le_bytes([data[28], data[29]]) & 0x3fff),
            )
        }
        b"VP8L" => {
            if data[20] != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        b"VP8X" => {
            let at = |i: usize| {
                u32::from(data[i]) | u32::from(data[i + 1]) << 8 | u32::from(data[i + 2]) << 16
            };
            (at(24) + 1, at(27) + 1)
        }
        _ => return None,
    };
    plausible(width, height).then_some(ImageInfo {
        ext: "webp",
        width,
        height,
    })
}

#[cfg(test)]
pub(crate) mod testdata {
    //! Kleine, echte Bilder für Tests (ohne Bild-Bibliothek erzeugt).
    use super::crc32;

    fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out.extend_from_slice(&crc32(&[kind, body]).to_be_bytes());
        out
    }

    /// Gültiges PNG (8 Bit Graustufen, unkomprimierter Deflate-Block) mit einem Farbverlauf.
    pub fn png(width: u32, height: u32, seed: u8) -> Vec<u8> {
        let mut raw = Vec::new();
        for y in 0..height {
            raw.push(0); // Filter "keiner"
            for x in 0..width {
                raw.push(
                    (x as u8)
                        .wrapping_mul(3)
                        .wrapping_add(y as u8)
                        .wrapping_add(seed),
                );
            }
        }
        // zlib: Kopf, gespeicherte Blöcke (je ≤ 65535 Byte), Adler-32
        let mut z = vec![0x78, 0x01];
        let blocks: Vec<&[u8]> = raw.chunks(60_000).collect();
        for (i, block) in blocks.iter().enumerate() {
            z.push(u8::from(i + 1 == blocks.len()));
            z.extend_from_slice(&(block.len() as u16).to_le_bytes());
            z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            z.extend_from_slice(block);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for byte in &raw {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        z.extend_from_slice(&(b << 16 | a).to_be_bytes());

        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        out.extend(chunk(b"IHDR", &ihdr));
        out.extend(chunk(b"IDAT", &z));
        out.extend(chunk(b"IEND", &[]));
        out
    }

    /// Minimales JPEG-Gerüst (SOI, APP0, SOF0 mit Größe, SOS, EOI) – genug für die Kopfprüfung.
    pub fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut out = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        out.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        out.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        out.extend_from_slice(&[0xff, 0xda, 0x00, 0x02, 1, 2, 3, 4, 5, 6, 7, 8]);
        out.extend_from_slice(&[0xff, 0xd9]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testdata::{jpeg, png};
    use super::*;

    fn webp_vp8x(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"RIFF\x1a\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        out.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        out
    }

    fn webp_lossless(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"RIFF\x1a\0\0\0WEBPVP8L\x0a\0\0\0\x2f".to_vec();
        out.extend_from_slice(&((width - 1) | (height - 1) << 14).to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out
    }

    fn webp_lossy(width: u16, height: u16) -> Vec<u8> {
        let mut out = b"RIFF\x1a\0\0\0WEBPVP8 \x0a\0\0\0".to_vec();
        out.extend_from_slice(&[0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]);
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out
    }

    #[test]
    fn png_wird_streng_geprueft() {
        let data = png(320, 176, 1);
        let info = sniff_image(&data).unwrap();
        assert_eq!((info.ext, info.width, info.height), ("png", 320, 176));
    }

    #[test]
    fn png_mit_falscher_pruefsumme_faellt_durch() {
        let mut data = png(40, 30, 0);
        let mid = data.len() / 2;
        data[mid] ^= 0x55;
        assert!(validate_png(&data).is_none());
    }

    #[test]
    fn abgeschnittenes_png_faellt_durch() {
        let data = png(40, 30, 0);
        for cut in [0, 7, 8, 20, 33, data.len() - 13, data.len() - 1] {
            assert!(validate_png(&data[..cut]).is_none(), "Länge {cut}");
        }
    }

    #[test]
    fn verschluesselter_datenmuell_ist_kein_bild() {
        for seed in 0..20 {
            assert!(sniff_image(&crate::covers::testsupport::noise(4096, seed)).is_none());
        }
        // Gültige Signatur, aber verschlüsselter Rest – genau der Fall eines verschlüsselten PS3-Abbilds
        let mut data = png(320, 176, 3);
        let noise = crate::covers::testsupport::noise(data.len() - 8, 9);
        data[8..].copy_from_slice(&noise);
        assert!(sniff_image(&data).is_none());
    }

    #[test]
    fn html_fehlerseite_ist_kein_bild() {
        assert!(sniff_image(b"<html><body>404 Not Found</body></html>").is_none());
        assert!(sniff_image(b"").is_none());
        assert!(sniff_image(b"\x89PNG").is_none());
    }

    #[test]
    fn jpeg_groesse_aus_dem_kopf() {
        let info = sniff_image(&jpeg(600, 900)).unwrap();
        assert_eq!((info.ext, info.width, info.height), ("jpg", 600, 900));
    }

    #[test]
    fn kaputtes_jpeg_wird_abgelehnt() {
        let mut data = jpeg(600, 900);
        data.truncate(12);
        assert!(sniff_image(&data).is_none());
        assert!(sniff_image(&[0xff, 0xd8, 0xff]).is_none());
        assert!(sniff_image(&[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]).is_none());
    }

    #[test]
    fn webp_alle_drei_arten() {
        let a = sniff_image(&webp_vp8x(500, 700)).unwrap();
        assert_eq!((a.ext, a.width, a.height), ("webp", 500, 700));
        let b = sniff_image(&webp_lossless(321, 123)).unwrap();
        assert_eq!((b.width, b.height), (321, 123));
        let c = sniff_image(&webp_lossy(64, 48)).unwrap();
        assert_eq!((c.width, c.height), (64, 48));
    }

    #[test]
    fn riesige_oder_leere_abmessungen_werden_abgelehnt() {
        assert!(sniff_image(&jpeg(0, 10)).is_none());
        assert!(sniff_image(&jpeg(10, 0)).is_none());
        assert!(sniff_image(&jpeg(60_000, 10)).is_none());
        assert!(sniff_image(&webp_vp8x(20_000, 20)).is_none());
    }

    #[test]
    fn peek_liest_nur_den_kopf() {
        let data = png(144, 80, 2);
        let info = peek_image(&data[..40]).unwrap();
        assert_eq!((info.width, info.height), (144, 80));
        assert!(peek_image(b"nichts").is_none());
        assert_eq!(peek_image(&jpeg(10, 20)).unwrap().ext, "jpg");
    }
}
