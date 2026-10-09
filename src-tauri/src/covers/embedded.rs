//! Grafiken und Namen, die im Spiel selbst stecken.
//!
//! - PS3: `PS3_GAME/ICON0.PNG` (320×176) und `PARAM.SFO` (TITLE, TITLE_ID)
//! - PSP: `PSP_GAME/ICON0.PNG` (144×80) und `PARAM.SFO` (TITLE, DISC_ID); auch in `EBOOT.PBP`
//! - PS1/PS2: `SYSTEM.CNF` ergibt die Seriennummer (kein Bild auf der Disc)
//! - GameCube/Wii: Spiel-ID und interner Name aus dem Disc-Kopf (kein Bild)
//!
//! Gelesen wird aus ISO-Abbildern, CUE/BIN-Paaren, PBP-Dateien und entpackten Spielordnern. Alles ist
//! "best effort": Was sich nicht lesen lässt (komprimierte CHD/CSO, verschlüsselte PS3-Abbilder), liefert
//! einfach nichts, und der Aufrufer weicht auf das Netz aus.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::image::validate_png;
use super::iso::{self, CnfKind, Image};
use super::system::Platform;

/// Größte akzeptierte Grafik im Spiel (echte `ICON0.PNG` sind unter 200 KB).
const MAX_ICON: u32 = 4 * 1024 * 1024;
const MAX_TEXT: u32 = 256 * 1024;

/// Was im Spiel gefunden wurde.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Embedded {
    /// Gültiges PNG, unverändert.
    pub icon: Option<Vec<u8>>,
    /// Spieltitel aus `PARAM.SFO` bzw. dem Disc-Kopf.
    pub title: Option<String>,
    /// Seriennummer / Spiel-ID.
    pub serial: Option<String>,
    /// Das System, das sich aus dem Inhalt ergibt (unabhängig vom Ordnernamen).
    pub platform: Option<Platform>,
}

/// Dateien eines Spielmediums (Abbild oder Ordner), gelesen über Pfade wie `PS3_GAME/ICON0.PNG`.
trait Volume {
    fn read(&mut self, path: &str, max: u32) -> Option<Vec<u8>>;
}

struct IsoVolume<R>(Image<R>);

impl<R: Read + Seek> Volume for IsoVolume<R> {
    fn read(&mut self, path: &str, max: u32) -> Option<Vec<u8>> {
        self.0.read_path(path, max).ok().flatten()
    }
}

/// Entpackter Spielordner. Namen werden ohne Rücksicht auf Groß-/Kleinschreibung gesucht.
struct DirVolume(PathBuf);

impl Volume for DirVolume {
    fn read(&mut self, path: &str, max: u32) -> Option<Vec<u8>> {
        let mut current = self.0.clone();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            current = fs::read_dir(&current)
                .ok()?
                .flatten()
                .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(part))?
                .path();
        }
        let meta = fs::metadata(&current).ok()?;
        if !meta.is_file() || meta.len() > u64::from(max) {
            return None;
        }
        fs::read(current).ok()
    }
}

/// Liest, was im Spiel selbst steckt. Wirft nie: Unlesbares ergibt ein leeres Ergebnis.
pub fn extract(path: &Path) -> Embedded {
    let Ok(meta) = fs::metadata(path) else {
        return Embedded::default();
    };
    if meta.is_dir() {
        return from_volume(&mut DirVolume(path.to_path_buf()));
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "iso" | "bin" | "img" => from_image_file(path),
        "cue" => cue_target(path)
            .map(|bin| from_image_file(&bin))
            .unwrap_or_default(),
        "pbp" => from_pbp(path, meta.len()),
        "gcm" => from_disc_header(path),
        _ => Embedded::default(),
    }
}

fn from_image_file(path: &Path) -> Embedded {
    let Ok(file) = File::open(path) else {
        return Embedded::default();
    };
    match Image::open(file) {
        Ok(image) => from_volume(&mut IsoVolume(image)),
        // Kein ISO 9660: vielleicht eine GameCube-/Wii-Disc
        Err(_) => from_disc_header(path),
    }
}

fn from_volume(volume: &mut dyn Volume) -> Embedded {
    let sfo_of = |volume: &mut dyn Volume, prefix: &str| {
        volume.read(&format!("{prefix}PARAM.SFO"), MAX_TEXT)
    };

    // PS3: Ordner PS3_GAME im Abbild; bei einem Ordner darf es auch PS3_GAME selbst sein
    for (prefix, platform, id_key) in [
        ("PS3_GAME/", Platform::Ps3, "TITLE_ID"),
        ("PSP_GAME/", Platform::Psp, "DISC_ID"),
    ] {
        if let Some(sfo) = sfo_of(volume, prefix) {
            return Embedded {
                icon: volume
                    .read(&format!("{prefix}ICON0.PNG"), MAX_ICON)
                    .filter(|png| validate_png(png).is_some()),
                title: iso::sfo_value(&sfo, "TITLE"),
                serial: iso::sfo_value(&sfo, id_key),
                platform: Some(platform),
            };
        }
    }
    if let Some(sfo) = sfo_of(volume, "") {
        let ps3 = iso::sfo_value(&sfo, "TITLE_ID").is_some();
        return Embedded {
            icon: volume
                .read("ICON0.PNG", MAX_ICON)
                .filter(|png| validate_png(png).is_some()),
            title: iso::sfo_value(&sfo, "TITLE"),
            serial: iso::sfo_value(&sfo, if ps3 { "TITLE_ID" } else { "DISC_ID" }),
            platform: Some(if ps3 { Platform::Ps3 } else { Platform::Psp }),
        };
    }

    if let Some(cnf) = volume.read("SYSTEM.CNF", 4096) {
        if let Some((kind, serial)) = iso::parse_system_cnf(&String::from_utf8_lossy(&cnf)) {
            return Embedded {
                serial: Some(serial),
                platform: Some(match kind {
                    CnfKind::Ps1 => Platform::Ps1,
                    CnfKind::Ps2 => Platform::Ps2,
                }),
                ..Embedded::default()
            };
        }
    }
    Embedded::default()
}

/* ------------------------------------------------------------------------------------ CUE/BIN */

/// Die Datei, die in einer `.cue` als Erstes genannt wird (die Datenspur) – nur als Name neben der `.cue`.
fn cue_target(cue: &Path) -> Option<PathBuf> {
    let len = fs::metadata(cue).ok()?.len();
    if len > 256 * 1024 {
        return None;
    }
    let text = fs::read_to_string(cue).ok()?;
    let name = parse_cue_file(&text)?;
    // Nur ein Dateiname neben der .cue, kein Pfad nach draußen
    if name.contains(['/', '\\']) || name == ".." || name == "." || name.is_empty() {
        return None;
    }
    Some(cue.parent()?.join(name))
}

/// Dateiname der ersten `FILE`-Zeile (`FILE "Spiel (Track 1).bin" BINARY`).
pub fn parse_cue_file(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.len() < 5 || !line[..4].eq_ignore_ascii_case("FILE") {
            continue;
        }
        let rest = line[4..].trim_start();
        if let Some(quoted) = rest.strip_prefix('"') {
            return quoted.split('"').next().map(str::to_string);
        }
        return rest.split_whitespace().next().map(str::to_string);
    }
    None
}

/* ---------------------------------------------------------------------------------------- PBP */

fn from_pbp(path: &Path, len: u64) -> Embedded {
    let read = || -> Option<Embedded> {
        let mut file = File::open(path).ok()?;
        let mut head = [0u8; 40];
        file.read_exact(&mut head).ok()?;
        let ((sfo_start, sfo_end), (icon_start, icon_end)) = iso::pbp_sections(&head, len)?;
        let mut section = |start: u64, end: u64, max: u32| -> Option<Vec<u8>> {
            if end - start > u64::from(max) {
                return None;
            }
            file.seek(SeekFrom::Start(start)).ok()?;
            let mut buf = vec![0u8; (end - start) as usize];
            file.read_exact(&mut buf).ok()?;
            Some(buf)
        };
        let sfo = section(sfo_start, sfo_end, MAX_TEXT)?;
        Some(Embedded {
            icon: section(icon_start, icon_end, MAX_ICON).filter(|png| validate_png(png).is_some()),
            title: iso::sfo_value(&sfo, "TITLE"),
            serial: iso::sfo_value(&sfo, "DISC_ID"),
            platform: Some(Platform::Psp),
        })
    };
    read().unwrap_or_default()
}

/* --------------------------------------------------------------------------- GameCube / Wii */

fn from_disc_header(path: &Path) -> Embedded {
    let read = || -> Option<Embedded> {
        let mut head = [0u8; 0x60];
        File::open(path).ok()?.read_exact(&mut head).ok()?;
        let header = iso::parse_disc_header(&head)?;
        Some(Embedded {
            title: (!header.name.is_empty()).then_some(header.name),
            serial: Some(header.id),
            platform: Some(if header.wii {
                Platform::Wii
            } else {
                Platform::GameCube
            }),
            ..Embedded::default()
        })
    };
    read().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::image::testdata::png;
    use super::super::testsupport::*;
    use super::*;

    fn ps3_iso(icon: Vec<u8>) -> Vec<u8> {
        build_iso(vec![dir(
            "PS3_GAME",
            vec![
                file("ICON0.PNG", icon),
                file(
                    "PARAM.SFO",
                    sfo(&[
                        ("TITLE", Sfo::Text("Gran Turismo® 5")),
                        ("TITLE_ID", Sfo::Text("BCES00569")),
                    ]),
                ),
            ],
        )])
    }

    fn psp_iso(icon: Vec<u8>) -> Vec<u8> {
        build_iso(vec![dir(
            "PSP_GAME",
            vec![
                file("ICON0.PNG", icon),
                file(
                    "PARAM.SFO",
                    sfo(&[
                        ("TITLE", Sfo::Text("Crisis Core")),
                        ("DISC_ID", Sfo::Text("ULES00821")),
                    ]),
                ),
            ],
        )])
    }

    fn write(dir: &TempDir, name: &str, data: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn ps3_abbild_liefert_icon_titel_und_id() {
        let tmp = TempDir::new("ps3");
        let icon = png(320, 176, 4);
        let path = write(&tmp, "Gran Turismo 5.iso", &ps3_iso(icon.clone()));
        let found = extract(&path);
        assert_eq!(found.icon.as_deref(), Some(icon.as_slice()));
        assert_eq!(found.title.as_deref(), Some("Gran Turismo® 5"));
        assert_eq!(found.serial.as_deref(), Some("BCES00569"));
        assert_eq!(found.platform, Some(Platform::Ps3));
    }

    #[test]
    fn verschluesseltes_ps3_abbild_ohne_brauchbares_icon() {
        let tmp = TempDir::new("ps3enc");
        // Verzeichnisse lesbar, Dateiinhalt verschlüsselt: weder PNG noch SFO sind gültig
        let iso = build_iso(vec![dir(
            "PS3_GAME",
            vec![
                file("ICON0.PNG", noise(9000, 1)),
                file("PARAM.SFO", noise(1200, 2)),
            ],
        )]);
        let path = write(&tmp, "Verschluesselt.iso", &iso);
        let found = extract(&path);
        // Das System ist trotzdem erkennbar (Ordner PS3_GAME); Bild und Namen fehlen
        assert_eq!(
            found,
            Embedded {
                platform: Some(Platform::Ps3),
                ..Embedded::default()
            }
        );
    }

    #[test]
    fn ps3_icon_verschluesselt_titel_bleibt() {
        let tmp = TempDir::new("ps3enc2");
        let path = write(&tmp, "x.iso", &ps3_iso(noise(7000, 3)));
        let found = extract(&path);
        assert!(found.icon.is_none());
        assert_eq!(found.title.as_deref(), Some("Gran Turismo® 5"));
        assert_eq!(found.platform, Some(Platform::Ps3));
    }

    #[test]
    fn png_mit_kaputter_pruefsumme_wird_nicht_uebernommen() {
        let tmp = TempDir::new("ps3crc");
        let mut icon = png(320, 176, 4);
        let at = icon.len() / 2;
        icon[at] ^= 0xff;
        let path = write(&tmp, "x.iso", &ps3_iso(icon));
        assert!(extract(&path).icon.is_none());
    }

    #[test]
    fn psp_abbild() {
        let tmp = TempDir::new("psp");
        let icon = png(144, 80, 1);
        let path = write(&tmp, "Crisis Core.iso", &psp_iso(icon.clone()));
        let found = extract(&path);
        assert_eq!(found.icon.as_deref(), Some(icon.as_slice()));
        assert_eq!(found.serial.as_deref(), Some("ULES00821"));
        assert_eq!(found.platform, Some(Platform::Psp));
    }

    #[test]
    fn ps2_seriennummer_aus_system_cnf() {
        let tmp = TempDir::new("ps2");
        let iso = build_iso(vec![
            file(
                "SYSTEM.CNF",
                b"BOOT2 = cdrom0:\\SLES_500.90;1\r\nVER = 1.00\r\nVMODE = PAL\r\n".to_vec(),
            ),
            file("SLES_500.90", vec![0u8; 100]),
        ]);
        let path = write(&tmp, "FINAL FANTASY X [SLES-50490].iso", &iso);
        let found = extract(&path);
        assert_eq!(found.serial.as_deref(), Some("SLES-50090"));
        assert_eq!(found.platform, Some(Platform::Ps2));
        assert!(found.icon.is_none());
    }

    #[test]
    fn ps1_bin_mit_cue_und_rohen_sektoren() {
        let tmp = TempDir::new("ps1");
        let iso = build_iso(vec![file(
            "SYSTEM.CNF",
            b"BOOT = cdrom:\\SCES_012.34;1\r\nTCB = 4\r\n".to_vec(),
        )]);
        write(
            &tmp,
            "Crash Bandicoot - Warped (Europe).bin",
            &raw_wrap(&iso, true),
        );
        let cue = write(
            &tmp,
            "Crash Bandicoot - Warped (Europe).cue",
            b"FILE \"Crash Bandicoot - Warped (Europe).bin\" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n",
        );
        let found = extract(&cue);
        assert_eq!(found.serial.as_deref(), Some("SCES-01234"));
        assert_eq!(found.platform, Some(Platform::Ps1));
        // das .bin selbst geht auch
        let bin = tmp.join("Crash Bandicoot - Warped (Europe).bin");
        assert_eq!(extract(&bin).serial.as_deref(), Some("SCES-01234"));
    }

    #[test]
    fn cue_darf_nicht_aus_dem_ordner_hinaus() {
        let tmp = TempDir::new("cue");
        let outside = write(
            &tmp,
            "draussen/geheim.bin",
            &raw_wrap(&ps3_iso(png(10, 10, 0)), false),
        );
        assert!(outside.exists());
        for name in [
            "../draussen/geheim.bin",
            "..\\draussen\\geheim.bin",
            "/etc/passwd",
            "..",
            "",
        ] {
            let cue = write(
                &tmp,
                "spiel/spiel.cue",
                format!("FILE \"{name}\" BINARY\n").as_bytes(),
            );
            assert_eq!(extract(&cue), Embedded::default(), "{name}");
        }
    }

    #[test]
    fn cue_zeilen() {
        assert_eq!(
            parse_cue_file("FILE \"a b.bin\" BINARY\n").as_deref(),
            Some("a b.bin")
        );
        assert_eq!(
            parse_cue_file("\u{feff}REM x\r\nfile spiel.bin BINARY").as_deref(),
            Some("spiel.bin")
        );
        assert_eq!(parse_cue_file("TRACK 01 MODE1/2352"), None);
        assert_eq!(parse_cue_file(""), None);
    }

    #[test]
    fn entpackter_ps3_ordner() {
        let tmp = TempDir::new("folder");
        let icon = png(320, 176, 2);
        write(&tmp, "Spiel/PS3_GAME/ICON0.PNG", &icon);
        write(
            &tmp,
            "Spiel/PS3_GAME/PARAM.SFO",
            &sfo(&[
                ("TITLE", Sfo::Text("Ordner")),
                ("TITLE_ID", Sfo::Text("NPUA80001")),
            ]),
        );
        let found = extract(&tmp.join("Spiel"));
        assert_eq!(found.icon.as_deref(), Some(icon.as_slice()));
        assert_eq!(found.serial.as_deref(), Some("NPUA80001"));
        assert_eq!(found.platform, Some(Platform::Ps3));
    }

    #[test]
    fn entpackter_ordner_mit_kleinschreibung_und_psp() {
        let tmp = TempDir::new("folder2");
        let icon = png(144, 80, 2);
        write(&tmp, "Spiel/psp_game/icon0.png", &icon);
        write(
            &tmp,
            "Spiel/psp_game/param.sfo",
            &sfo(&[
                ("TITLE", Sfo::Text("Klein")),
                ("DISC_ID", Sfo::Text("ULUS10001")),
            ]),
        );
        let found = extract(&tmp.join("Spiel"));
        assert_eq!(found.icon.as_deref(), Some(icon.as_slice()));
        assert_eq!(found.platform, Some(Platform::Psp));
    }

    #[test]
    fn spielordner_ist_selbst_ps3_game() {
        let tmp = TempDir::new("folder3");
        let icon = png(320, 176, 2);
        write(&tmp, "PS3_GAME/ICON0.PNG", &icon);
        write(
            &tmp,
            "PS3_GAME/PARAM.SFO",
            &sfo(&[
                ("TITLE", Sfo::Text("Direkt")),
                ("TITLE_ID", Sfo::Text("BLES00001")),
            ]),
        );
        let found = extract(&tmp.join("PS3_GAME"));
        assert_eq!(found.icon.as_deref(), Some(icon.as_slice()));
        assert_eq!(found.platform, Some(Platform::Ps3));
    }

    #[test]
    fn ordner_ohne_spieldaten() {
        let tmp = TempDir::new("folder4");
        write(&tmp, "Leer/readme.txt", b"hallo");
        assert_eq!(extract(&tmp.join("Leer")), Embedded::default());
    }

    #[test]
    fn zu_grosses_icon_im_ordner_wird_ignoriert() {
        let tmp = TempDir::new("folder5");
        write(
            &tmp,
            "S/PS3_GAME/ICON0.PNG",
            &vec![0u8; (MAX_ICON + 1) as usize],
        );
        write(
            &tmp,
            "S/PS3_GAME/PARAM.SFO",
            &sfo(&[
                ("TITLE", Sfo::Text("Gross")),
                ("TITLE_ID", Sfo::Text("BLES00002")),
            ]),
        );
        let found = extract(&tmp.join("S"));
        assert!(found.icon.is_none());
        assert_eq!(found.title.as_deref(), Some("Gross"));
    }

    #[test]
    fn pbp_mit_icon_und_titel() {
        let tmp = TempDir::new("pbp");
        let icon = png(144, 80, 7);
        let sfo_bytes = sfo(&[
            ("TITLE", Sfo::Text("Minis Spiel")),
            ("DISC_ID", Sfo::Text("NPUZ00012")),
        ]);
        let mut data = vec![0u8, b'P', b'B', b'P', 0, 0, 1, 0];
        let first = 40u32;
        let icon_at = first + sfo_bytes.len() as u32;
        let next = icon_at + icon.len() as u32;
        for off in [first, icon_at, next, next, next, next, next, next] {
            data.extend_from_slice(&off.to_le_bytes());
        }
        data.extend_from_slice(&sfo_bytes);
        data.extend_from_slice(&icon);
        let path = write(&tmp, "EBOOT.PBP", &data);
        let found = extract(&path);
        assert_eq!(found.icon.as_deref(), Some(icon.as_slice()));
        assert_eq!(found.title.as_deref(), Some("Minis Spiel"));
        assert_eq!(found.platform, Some(Platform::Psp));
    }

    #[test]
    fn gamecube_und_wii_kopf() {
        let tmp = TempDir::new("gc");
        let mut head = vec![0u8; 0x100];
        head[..6].copy_from_slice(b"GM4E01");
        head[0x1c..0x20].copy_from_slice(&[0xc2, 0x33, 0x9f, 0x3d]);
        head[0x20..0x2a].copy_from_slice(b"Mario Kart");
        let path = write(&tmp, "Mario Kart.iso", &head);
        let found = extract(&path);
        assert_eq!(found.serial.as_deref(), Some("GM4E01"));
        assert_eq!(found.title.as_deref(), Some("Mario Kart"));
        assert_eq!(found.platform, Some(Platform::GameCube));
        let gcm = write(&tmp, "Mario Kart.gcm", &head);
        assert_eq!(extract(&gcm).platform, Some(Platform::GameCube));
        head[0x18..0x1c].copy_from_slice(&[0x5d, 0x1c, 0x9e, 0xa3]);
        head[0x1c..0x20].fill(0);
        let wii = write(&tmp, "Wii Sports.iso", &head);
        assert_eq!(extract(&wii).platform, Some(Platform::Wii));
    }

    #[test]
    fn unlesbares_ergibt_leeres_ergebnis() {
        let tmp = TempDir::new("junk");
        assert_eq!(extract(&tmp.join("gibt-es-nicht.iso")), Embedded::default());
        assert_eq!(extract(&write(&tmp, "leer.iso", b"")), Embedded::default());
        assert_eq!(
            extract(&write(&tmp, "muell.iso", &noise(100_000, 5))),
            Embedded::default()
        );
        assert_eq!(
            extract(&write(&tmp, "spiel.chd", b"MComprHD")),
            Embedded::default()
        );
        assert_eq!(
            extract(&write(&tmp, "kaputt.pbp", b"\0PBP")),
            Embedded::default()
        );
        assert_eq!(extract(&write(&tmp, "ohne.cue", b"")), Embedded::default());
        write(&tmp, "Spiel.app/Contents/Info.plist", b"x");
        assert_eq!(extract(&tmp.join("Spiel.app")), Embedded::default());
    }
}
