//! Nur lesender ISO-9660-Leser und die kleinen Formate, die in Spielabbildern stecken.
//!
//! Nichts wird gemountet und nichts komplett gelesen: Das Abbild wird nur an den Stellen angefasst, die für
//! das Verzeichnis und die gesuchten Dateien nötig sind (bei einer 30-GB-PS3-Datei wenige Sektoren). Unterstützt
//! sind die gewöhnlichen 2048-Byte-Sektoren (`.iso`) sowie rohe CD-Abbilder mit 2352-Byte-Sektoren
//! (`.bin` von PS1/PS2, Mode 1 und Mode 2 Form 1).

use std::io::{self, Read, Seek, SeekFrom};

/// Nutzdaten eines Sektors.
const SECTOR: u64 = 2048;
/// Sektor des Primary Volume Descriptors.
const PVD_SECTOR: u64 = 16;
/// Größere Verzeichnisse gelten als kaputt.
const MAX_DIR_BYTES: u32 = 8 * 1024 * 1024;

/// Aufbau der Sektoren in der Abbilddatei.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// 2048 Byte Nutzdaten je Sektor (`.iso`).
    Cooked,
    /// 2352 Byte mit Synchronisation und Kopf, Nutzdaten ab Byte 16 (Mode 1).
    RawMode1,
    /// 2352 Byte, Nutzdaten ab Byte 24 (Mode 2 Form 1, PS1/PS2-CDs).
    RawMode2,
}

impl Layout {
    fn stride(self) -> u64 {
        match self {
            Layout::Cooked => SECTOR,
            Layout::RawMode1 | Layout::RawMode2 => 2352,
        }
    }

    fn offset(self) -> u64 {
        match self {
            Layout::Cooked => 0,
            Layout::RawMode1 => 16,
            Layout::RawMode2 => 24,
        }
    }
}

/// Eintrag eines Verzeichnisses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirRecord {
    pub lba: u32,
    pub size: u32,
    pub is_dir: bool,
    /// Name ohne Versionsnummer (`;1`) und ohne Punkt am Ende.
    pub name: String,
}

fn io_text(err: io::Error) -> String {
    format!("Abbild nicht lesbar: {err}")
}

fn read_at<R: Read + Seek>(reader: &mut R, pos: u64, len: usize) -> io::Result<Vec<u8>> {
    reader.seek(SeekFrom::Start(pos))?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    Ok(buf)
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Ein geöffnetes ISO-9660-Abbild.
pub struct Image<R> {
    reader: R,
    layout: Layout,
    len: u64,
    root: DirRecord,
}

impl<R: Read + Seek> Image<R> {
    /// Erkennt den Sektoraufbau am Volume Descriptor in Sektor 16 und liest das Wurzelverzeichnis.
    pub fn open(mut reader: R) -> Result<Image<R>, String> {
        let len = reader.seek(SeekFrom::End(0)).map_err(io_text)?;
        for layout in [Layout::Cooked, Layout::RawMode1, Layout::RawMode2] {
            let pos = PVD_SECTOR * layout.stride() + layout.offset();
            if pos + SECTOR > len {
                continue;
            }
            let Ok(pvd) = read_at(&mut reader, pos, SECTOR as usize) else {
                continue;
            };
            if pvd[0] == 1 && &pvd[1..6] == b"CD001" && pvd[6] == 1 {
                let root = parse_records(&pvd[156..190], true)
                    .into_iter()
                    .next()
                    .filter(|r| r.is_dir);
                if let Some(root) = root {
                    return Ok(Image {
                        reader,
                        layout,
                        len,
                        root,
                    });
                }
            }
        }
        Err("Kein ISO-9660-Abbild".into())
    }

    #[cfg(test)]
    pub fn layout(&self) -> Layout {
        self.layout
    }

    /// Liest `len` Bytes Nutzdaten ab dem logischen Sektor `lba`.
    fn read_extent(&mut self, lba: u32, len: u64) -> Result<Vec<u8>, String> {
        let stride = self.layout.stride();
        let sectors = len.div_ceil(SECTOR);
        let first = u64::from(lba) * stride + self.layout.offset();
        let last_take = len - sectors.saturating_sub(1) * SECTOR;
        if first + sectors.saturating_sub(1) * stride + last_take > self.len {
            return Err("Abbild ist abgeschnitten".into());
        }
        if self.layout == Layout::Cooked {
            return read_at(&mut self.reader, first, len as usize).map_err(io_text);
        }
        let mut out = Vec::with_capacity(len as usize);
        for i in 0..sectors {
            let take = (len - i * SECTOR).min(SECTOR) as usize;
            let part = read_at(&mut self.reader, first + i * stride, take).map_err(io_text)?;
            out.extend_from_slice(&part);
        }
        Ok(out)
    }

    /// Einträge eines Verzeichnisses (ohne `.` und `..`).
    pub fn list(&mut self, dir: &DirRecord) -> Result<Vec<DirRecord>, String> {
        if !dir.is_dir || dir.size > MAX_DIR_BYTES {
            return Err("Ungültiges Verzeichnis im Abbild".into());
        }
        let buf = self.read_extent(dir.lba, u64::from(dir.size))?;
        Ok(parse_records(&buf, false))
    }

    /// Sucht einen Pfad wie `PS3_GAME/ICON0.PNG` (Groß-/Kleinschreibung egal).
    pub fn find(&mut self, path: &str) -> Result<Option<DirRecord>, String> {
        let mut current = self.root.clone();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            if !current.is_dir {
                return Ok(None);
            }
            let found = self
                .list(&current)?
                .into_iter()
                .find(|r| r.name.eq_ignore_ascii_case(part));
            match found {
                Some(rec) => current = rec,
                None => return Ok(None),
            }
        }
        Ok(Some(current))
    }

    /// Liest eine Datei des Abbilds, höchstens `max` Bytes groß. `Ok(None)`, wenn es sie nicht gibt.
    pub fn read_path(&mut self, path: &str, max: u32) -> Result<Option<Vec<u8>>, String> {
        let Some(rec) = self.find(path)? else {
            return Ok(None);
        };
        if rec.is_dir {
            return Ok(None);
        }
        if rec.size > max {
            return Err(format!("{path} ist zu groß ({} Bytes)", rec.size));
        }
        self.read_extent(rec.lba, u64::from(rec.size)).map(Some)
    }
}

/// Zerlegt Verzeichnisdaten in Einträge. Bei `keep_special` bleiben `.`/`..` erhalten (für den Wurzeleintrag).
fn parse_records(buf: &[u8], keep_special: bool) -> Vec<DirRecord> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let len = usize::from(buf[pos]);
        if len == 0 {
            // Einträge überspannen keine Sektorgrenze: Rest des Sektors überspringen
            pos = (pos / SECTOR as usize + 1) * SECTOR as usize;
            continue;
        }
        let Some(rec) = buf.get(pos..pos + len) else {
            break;
        };
        if len < 34 {
            break;
        }
        let name_len = usize::from(rec[32]);
        if 33 + name_len > len {
            break;
        }
        pos += len;
        let id = &rec[33..33 + name_len];
        let special = id == [0] || id == [1];
        if special && !keep_special {
            continue;
        }
        let mut name = String::from_utf8_lossy(id).into_owned();
        if let Some(cut) = name.rfind(';') {
            if name[cut + 1..].bytes().all(|b| b.is_ascii_digit()) {
                name.truncate(cut);
            }
        }
        if name.ends_with('.') {
            name.pop();
        }
        out.push(DirRecord {
            lba: le32(rec, 2),
            size: le32(rec, 10),
            is_dir: rec[25] & 0b10 != 0,
            name,
        });
    }
    out
}

/* --------------------------------------------------------------------------------- PARAM.SFO */

/// Liest einen Text- oder Zahlenwert aus einer `PARAM.SFO` (PSF-Format der PSP/PS3).
pub fn sfo_value(data: &[u8], key: &str) -> Option<String> {
    if data.len() < 20 || &data[..4] != b"\0PSF" {
        return None;
    }
    let key_table = le32(data, 8) as usize;
    let data_table = le32(data, 12) as usize;
    let count = le32(data, 16) as usize;
    if count > 512 {
        return None;
    }
    for i in 0..count {
        let at = 20 + i * 16;
        let entry = data.get(at..at + 16)?;
        let key_off = usize::from(u16::from_le_bytes([entry[0], entry[1]]));
        let format = u16::from_le_bytes([entry[2], entry[3]]);
        let used = le32(entry, 4) as usize;
        let value_off = le32(entry, 12) as usize;
        let key_bytes = data.get(key_table.checked_add(key_off)?..)?;
        let name_end = key_bytes.iter().position(|b| *b == 0)?;
        if &key_bytes[..name_end] != key.as_bytes() {
            continue;
        }
        let value = data.get(data_table.checked_add(value_off)?..)?;
        return match format {
            0x0004 | 0x0204 => {
                let raw = value.get(..used.min(value.len()))?;
                let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
                let text = String::from_utf8_lossy(&raw[..end]).trim().to_string();
                (!text.is_empty()).then_some(text)
            }
            0x0404 => value
                .get(..4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]).to_string()),
            _ => None,
        };
    }
    None
}

/* -------------------------------------------------------------------------------- SYSTEM.CNF */

/// Welche PlayStation die `SYSTEM.CNF` beschreibt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CnfKind {
    Ps1,
    Ps2,
}

/// Liest die Startdatei aus der `SYSTEM.CNF` einer PS1-/PS2-Disc und macht daraus die Seriennummer
/// (`cdrom0:\SLUS_203.12;1` → `SLUS-20312`). `BOOT2` kennzeichnet die PS2, `BOOT` die PS1.
pub fn parse_system_cnf(text: &str) -> Option<(CnfKind, String)> {
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let kind = match key.trim().to_ascii_uppercase().as_str() {
            "BOOT2" => CnfKind::Ps2,
            "BOOT" => CnfKind::Ps1,
            _ => continue,
        };
        let value = value.trim().trim_matches('"');
        let file = value.rsplit(['\\', '/', ':']).next().unwrap_or(value);
        let file = file.split(';').next().unwrap_or(file);
        if let Some(serial) = serial_from_boot_file(file) {
            return Some((kind, serial));
        }
    }
    None
}

/// `SLUS_203.12` → `SLUS-20312`; alles, was nicht wie eine Seriennummer aussieht, wird abgelehnt.
fn serial_from_boot_file(file: &str) -> Option<String> {
    let (prefix, rest) = file.split_once('_')?;
    let digits: String = rest.chars().filter(|c| *c != '.').collect();
    let good_prefix =
        (3..=4).contains(&prefix.len()) && prefix.bytes().all(|b| b.is_ascii_alphabetic());
    let good_digits = (4..=6).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit());
    (good_prefix && good_digits).then(|| format!("{}-{digits}", prefix.to_ascii_uppercase()))
}

/* ------------------------------------------------------------------------------------- PBP */

/// Die Bereiche einer `EBOOT.PBP` (PSP-Spiel oder PS1-Klassiker): `(PARAM.SFO, ICON0.PNG)` als Byte-Bereiche.
pub fn pbp_sections(head: &[u8], file_len: u64) -> Option<((u64, u64), (u64, u64))> {
    if head.len() < 40 || head[..4] != [0, b'P', b'B', b'P'] {
        return None;
    }
    let off = |i: usize| u64::from(le32(head, 8 + i * 4));
    let (sfo, icon, next) = (off(0), off(1), off(2));
    // Aufsteigend und innerhalb der Datei, sonst ist der Kopf kaputt
    if sfo < 40 || icon < sfo || next < icon || next > file_len {
        return None;
    }
    Some(((sfo, icon), (icon, next)))
}

/* -------------------------------------------------------------------- GameCube-/Wii-Kopf */

/// Spiel-ID und interner Name aus dem Kopf einer GameCube-/Wii-Disc (`.iso`/`.gcm`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscHeader {
    pub id: String,
    pub name: String,
    pub wii: bool,
}

pub fn parse_disc_header(head: &[u8]) -> Option<DiscHeader> {
    if head.len() < 0x60 {
        return None;
    }
    let wii = head[0x18..0x1c] == [0x5d, 0x1c, 0x9e, 0xa3];
    let gamecube = head[0x1c..0x20] == [0xc2, 0x33, 0x9f, 0x3d];
    if !wii && !gamecube {
        return None;
    }
    let id = &head[..6];
    if !id.iter().all(u8::is_ascii_alphanumeric) {
        return None;
    }
    let raw = &head[0x20..0x60];
    let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    let name = String::from_utf8_lossy(&raw[..end]).trim().to_string();
    Some(DiscHeader {
        id: String::from_utf8_lossy(id).into_owned(),
        name,
        wii,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::covers::testsupport::*;
    use std::io::Cursor;

    fn sample() -> Vec<u8> {
        build_iso(vec![
            dir(
                "PS3_GAME",
                vec![
                    file("ICON0.PNG", vec![7u8; 5000]),
                    file("PARAM.SFO", sfo(&[("TITLE", Sfo::Text("Test"))])),
                    dir("USRDIR", vec![file("EBOOT.BIN", vec![1u8; 10])]),
                ],
            ),
            file("SYSTEM.CNF", b"BOOT2 = cdrom0:\\SLUS_203.12;1\r\n".to_vec()),
        ])
    }

    #[test]
    fn cooked_abbild_wird_gelesen() {
        let mut image = Image::open(Cursor::new(sample())).unwrap();
        assert_eq!(image.layout(), Layout::Cooked);
        let root = image.find("").unwrap().unwrap();
        let names: Vec<String> = image
            .list(&root)
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, ["PS3_GAME", "SYSTEM.CNF"]);
        let icon = image
            .read_path("PS3_GAME/ICON0.PNG", 1 << 20)
            .unwrap()
            .unwrap();
        assert_eq!(icon, vec![7u8; 5000]);
        assert!(image
            .read_path("PS3_GAME/USRDIR/EBOOT.BIN", 100)
            .unwrap()
            .is_some());
    }

    #[test]
    fn pfade_ignorieren_gross_und_kleinschreibung() {
        let mut image = Image::open(Cursor::new(sample())).unwrap();
        assert!(image
            .read_path("ps3_game/icon0.png", 1 << 20)
            .unwrap()
            .is_some());
        assert!(image
            .read_path("/PS3_GAME//ICON0.PNG", 1 << 20)
            .unwrap()
            .is_some());
    }

    #[test]
    fn fehlendes_ergibt_none_und_ordner_sind_keine_dateien() {
        let mut image = Image::open(Cursor::new(sample())).unwrap();
        assert_eq!(image.read_path("PS3_GAME/NICHTS.PNG", 100).unwrap(), None);
        assert_eq!(image.read_path("NICHTS/ICON0.PNG", 100).unwrap(), None);
        assert_eq!(image.read_path("PS3_GAME", 100).unwrap(), None);
        // eine Datei hat keine Unterordner
        assert_eq!(image.read_path("SYSTEM.CNF/x", 100).unwrap(), None);
    }

    #[test]
    fn zu_grosse_datei_wird_abgelehnt() {
        let mut image = Image::open(Cursor::new(sample())).unwrap();
        let err = image.read_path("PS3_GAME/ICON0.PNG", 4999).unwrap_err();
        assert!(err.contains("zu groß"), "{err}");
    }

    #[test]
    fn rohe_sektoren_mode1_und_mode2() {
        for mode2 in [false, true] {
            let raw = raw_wrap(&sample(), mode2);
            let mut image = Image::open(Cursor::new(raw)).unwrap();
            assert_eq!(
                image.layout(),
                if mode2 {
                    Layout::RawMode2
                } else {
                    Layout::RawMode1
                }
            );
            // 5000 Byte laufen über drei Sektoren
            let icon = image
                .read_path("PS3_GAME/ICON0.PNG", 1 << 20)
                .unwrap()
                .unwrap();
            assert_eq!(icon, vec![7u8; 5000]);
            let cnf = image.read_path("SYSTEM.CNF", 4096).unwrap().unwrap();
            assert!(String::from_utf8_lossy(&cnf).starts_with("BOOT2"));
        }
    }

    #[test]
    fn grosses_verzeichnis_ueber_mehrere_sektoren() {
        let items: Vec<Item> = (0..120)
            .map(|i| {
                file(
                    &format!("EIN_SEHR_LANGER_DATEINAME_NUMMER_{i:04}.DAT"),
                    vec![i as u8; 3],
                )
            })
            .collect();
        let mut image = Image::open(Cursor::new(build_iso(items))).unwrap();
        let root = image.find("").unwrap().unwrap();
        assert!(
            root.size > 2048,
            "Verzeichnis sollte mehrere Sektoren haben"
        );
        assert_eq!(image.list(&root).unwrap().len(), 120);
        let last = image
            .read_path("EIN_SEHR_LANGER_DATEINAME_NUMMER_0119.DAT", 10)
            .unwrap()
            .unwrap();
        assert_eq!(last, vec![119u8; 3]);
    }

    #[test]
    fn kein_iso_wird_abgelehnt() {
        assert!(Image::open(Cursor::new(Vec::<u8>::new())).is_err());
        assert!(Image::open(Cursor::new(vec![0u8; 200_000])).is_err());
        assert!(Image::open(Cursor::new(noise(300_000, 1))).is_err());
    }

    #[test]
    fn abgeschnittenes_abbild_ergibt_fehler_statt_absturz() {
        let full = sample();
        // ICON0.PNG liegt hinter dem Verzeichnis; ohne die letzten Sektoren fehlen die Daten
        let cut = full[..full.len() - 4 * 2048].to_vec();
        let mut image = Image::open(Cursor::new(cut)).unwrap();
        let _ = image.read_path("PS3_GAME/ICON0.PNG", 1 << 20); // kein Panic
                                                                // Nur Kopf und Verzeichnis
        let mut image = Image::open(Cursor::new(full[..19 * 2048].to_vec())).unwrap();
        assert!(
            image.find("PS3_GAME/PARAM.SFO").is_err()
                || image.find("PS3_GAME/PARAM.SFO").unwrap().is_none()
        );
    }

    #[test]
    fn beschaedigte_verzeichnisse_loesen_keine_panik_aus() {
        let base = sample();
        for seed in 0..40u32 {
            let mut data = base.clone();
            let junk = noise(2048, seed);
            // Verzeichnissektoren (ab Sektor 18) zerstören
            let at = 18 * 2048;
            data[at..at + 2048].copy_from_slice(&junk);
            if let Ok(mut image) = Image::open(Cursor::new(data)) {
                let _ = image.read_path("PS3_GAME/ICON0.PNG", 1 << 20);
                let _ = image.read_path("SYSTEM.CNF", 4096);
            }
        }
    }

    #[test]
    fn sehr_grosses_abbild_wird_nur_punktuell_gelesen() {
        let thirty_gb = 30u64 * 1024 * 1024 * 1024;
        let (reader, counter) = Sparse::new(sample(), thirty_gb);
        let mut image = Image::open(reader).unwrap();
        let icon = image
            .read_path("PS3_GAME/ICON0.PNG", 1 << 20)
            .unwrap()
            .unwrap();
        assert_eq!(icon.len(), 5000);
        let read = counter.load(std::sync::atomic::Ordering::Relaxed);
        assert!(read < 64 * 1024, "{read} Byte gelesen");
    }

    #[test]
    fn eintragsnamen_ohne_version_und_endpunkt() {
        let mut rec = record_for_test("README.TXT.;1");
        let parsed = parse_records(&rec, false);
        assert_eq!(parsed[0].name, "README.TXT");
        rec = record_for_test("ICON0.PNG;12");
        assert_eq!(parse_records(&rec, false)[0].name, "ICON0.PNG");
        rec = record_for_test("A;B");
        assert_eq!(parse_records(&rec, false)[0].name, "A;B");
    }

    fn record_for_test(name: &str) -> Vec<u8> {
        let len = (33 + name.len() + 1) & !1;
        let mut r = vec![0u8; len];
        r[0] = len as u8;
        r[32] = name.len() as u8;
        r[33..33 + name.len()].copy_from_slice(name.as_bytes());
        r
    }

    /* ---------------------------------------------------------------- PARAM.SFO */

    #[test]
    fn sfo_text_und_zahlen() {
        let data = sfo(&[
            ("CATEGORY", Sfo::Text("DG")),
            ("TITLE", Sfo::Text("God of War® III")),
            ("TITLE_ID", Sfo::Text("BCES00510")),
            ("PARENTAL_LEVEL", Sfo::Int(5)),
        ]);
        assert_eq!(
            sfo_value(&data, "TITLE").as_deref(),
            Some("God of War® III")
        );
        assert_eq!(sfo_value(&data, "TITLE_ID").as_deref(), Some("BCES00510"));
        assert_eq!(sfo_value(&data, "PARENTAL_LEVEL").as_deref(), Some("5"));
        assert_eq!(sfo_value(&data, "DISC_ID"), None);
    }

    #[test]
    fn sfo_leerer_oder_kaputter_inhalt() {
        assert_eq!(sfo_value(b"", "TITLE"), None);
        assert_eq!(sfo_value(b"nicht sfo", "TITLE"), None);
        let good = sfo(&[("TITLE", Sfo::Text("Abc"))]);
        for cut in 0..good.len() {
            let _ = sfo_value(&good[..cut], "TITLE"); // nie ein Panic
        }
        for seed in 0..60 {
            let mut data = good.clone();
            let junk = noise(data.len(), seed);
            let from = 4 + (seed as usize % 8);
            data[from..].copy_from_slice(&junk[from..]);
            let _ = sfo_value(&data, "TITLE");
        }
        assert_eq!(sfo_value(&sfo(&[("TITLE", Sfo::Text(""))]), "TITLE"), None);
    }

    /* --------------------------------------------------------------- SYSTEM.CNF */

    #[test]
    fn system_cnf_ps2() {
        let text = "BOOT2 = cdrom0:\\SLUS_203.12;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n";
        assert_eq!(
            parse_system_cnf(text),
            Some((CnfKind::Ps2, "SLUS-20312".into()))
        );
    }

    #[test]
    fn system_cnf_ps1_und_schreibweisen() {
        assert_eq!(
            parse_system_cnf("BOOT = cdrom:\\SCES_012.34;1\nTCB = 4\nEVENT = 10\nSTACK = 801FFF00"),
            Some((CnfKind::Ps1, "SCES-01234".into()))
        );
        assert_eq!(
            parse_system_cnf("boot=cdrom:SLES_545.67;1"),
            Some((CnfKind::Ps1, "SLES-54567".into()))
        );
        assert_eq!(
            parse_system_cnf("BOOT2=\"cdrom0:\\SLES_500.90;1\""),
            Some((CnfKind::Ps2, "SLES-50090".into()))
        );
        assert_eq!(
            parse_system_cnf("BOOT2 = cdrom0:/SCPS_150.17;1"),
            Some((CnfKind::Ps2, "SCPS-15017".into()))
        );
    }

    #[test]
    fn system_cnf_ohne_seriennummer() {
        assert_eq!(parse_system_cnf(""), None);
        assert_eq!(parse_system_cnf("BOOT = cdrom:\\PSX.EXE;1"), None);
        assert_eq!(parse_system_cnf("VER = 1.00"), None);
        assert_eq!(
            parse_system_cnf("BOOT2 = cdrom0:\\SLUS_20312_zu_lang_und_wirr;1"),
            None
        );
        assert_eq!(parse_system_cnf("BOOT = ../../etc/passwd"), None);
    }

    /* --------------------------------------------------------------------- PBP */

    fn pbp(sfo: &[u8], icon: &[u8]) -> Vec<u8> {
        let mut head = vec![0u8, b'P', b'B', b'P', 0, 0, 1, 0];
        let first = 40u32;
        let offsets = [
            first,
            first + sfo.len() as u32,
            first + (sfo.len() + icon.len()) as u32,
        ];
        for o in offsets {
            head.extend_from_slice(&o.to_le_bytes());
        }
        for _ in 0..5 {
            head.extend_from_slice(&(offsets[2]).to_le_bytes());
        }
        head.extend_from_slice(sfo);
        head.extend_from_slice(icon);
        head
    }

    #[test]
    fn pbp_bereiche() {
        let data = pbp(&[1, 2, 3, 4], &[5; 10]);
        let ((s0, s1), (i0, i1)) = pbp_sections(&data[..40], data.len() as u64).unwrap();
        assert_eq!((s0, s1, i0, i1), (40, 44, 44, 54));
    }

    #[test]
    fn pbp_kaputter_kopf() {
        let data = pbp(&[1, 2, 3, 4], &[5; 10]);
        assert!(pbp_sections(&data[..39], 100).is_none());
        assert!(pbp_sections(&data[..40], 20).is_none()); // Bereiche hinter dem Dateiende
        let mut wrong = data.clone();
        wrong[1] = b'X';
        assert!(pbp_sections(&wrong[..40], data.len() as u64).is_none());
        let mut backwards = data.clone();
        backwards[12..16].copy_from_slice(&1u32.to_le_bytes());
        assert!(pbp_sections(&backwards[..40], data.len() as u64).is_none());
    }

    /* ------------------------------------------------------------ GameCube / Wii */

    fn disc_head(id: &str, name: &str, wii: bool) -> Vec<u8> {
        let mut head = vec![0u8; 0x60];
        head[..id.len()].copy_from_slice(id.as_bytes());
        if wii {
            head[0x18..0x1c].copy_from_slice(&[0x5d, 0x1c, 0x9e, 0xa3]);
        } else {
            head[0x1c..0x20].copy_from_slice(&[0xc2, 0x33, 0x9f, 0x3d]);
        }
        head[0x20..0x20 + name.len()].copy_from_slice(name.as_bytes());
        head
    }

    #[test]
    fn disc_kopf_gamecube_und_wii() {
        let gc = parse_disc_header(&disc_head("GALE01", "Super Smash Bros. Melee", false)).unwrap();
        assert_eq!(
            (gc.id.as_str(), gc.name.as_str(), gc.wii),
            ("GALE01", "Super Smash Bros. Melee", false)
        );
        let wii = parse_disc_header(&disc_head("RSBE01", "Super Smash Bros. Brawl", true)).unwrap();
        assert!(wii.wii);
    }

    #[test]
    fn disc_kopf_ungueltig() {
        assert!(parse_disc_header(&[0u8; 0x60]).is_none());
        assert!(parse_disc_header(&[0u8; 8]).is_none());
        let mut bad_id = disc_head("GALE01", "X", false);
        bad_id[2] = 0;
        assert!(parse_disc_header(&bad_id).is_none());
    }
}
