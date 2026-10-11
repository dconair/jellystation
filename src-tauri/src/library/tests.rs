use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::covers::testsupport::*;

fn write(root: &Path, rel: &str, data: &[u8]) -> PathBuf {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, data).unwrap();
    path
}

fn ps3_iso() -> Vec<u8> {
    build_iso(vec![dir(
        "PS3_GAME",
        vec![file(
            "PARAM.SFO",
            sfo(&[("TITLE", Sfo::Text("Gran Turismo 5")), ("TITLE_ID", Sfo::Text("BCES00569"))]),
        )],
    )])
}

fn psp_iso() -> Vec<u8> {
    build_iso(vec![dir(
        "PSP_GAME",
        vec![file(
            "PARAM.SFO",
            sfo(&[("TITLE", Sfo::Text("Crisis Core")), ("DISC_ID", Sfo::Text("ULES00821"))]),
        )],
    )])
}

fn ps2_iso() -> Vec<u8> {
    build_iso(vec![file("SYSTEM.CNF", b"BOOT2 = cdrom0:\\SLES_500.90;1\r\nVER = 1.00\r\n".to_vec())])
}

fn ps1_iso() -> Vec<u8> {
    build_iso(vec![file("SYSTEM.CNF", b"BOOT = cdrom:\\SCES_012.34;1\r\nTCB = 4\r\n".to_vec())])
}

fn pc_iso() -> Vec<u8> {
    build_iso(vec![file("SETUP.EXE", vec![0u8; 10])])
}

/// 0x60 Byte Disc-Kopf; `wii` wählt die Kennung.
fn disc_header(id: &str, name: &str, wii: bool) -> Vec<u8> {
    let mut head = vec![0u8; 0x60];
    head[..6].copy_from_slice(id.as_bytes());
    if wii {
        head[0x18..0x1c].copy_from_slice(&[0x5d, 0x1c, 0x9e, 0xa3]);
    } else {
        head[0x1c..0x20].copy_from_slice(&[0xc2, 0x33, 0x9f, 0x3d]);
    }
    head[0x20..0x20 + name.len()].copy_from_slice(name.as_bytes());
    head
}

fn chd(cd: bool, logical: u64) -> Vec<u8> {
    let mut head = vec![0u8; 0x80];
    head[..8].copy_from_slice(b"MComprHD");
    head[8..12].copy_from_slice(&124u32.to_be_bytes());
    head[12..16].copy_from_slice(&5u32.to_be_bytes());
    head[16..20].copy_from_slice(if cd { b"cdlz" } else { b"lzma" });
    head[32..40].copy_from_slice(&logical.to_be_bytes());
    head
}

fn pkg(kind: u16, content_id: &str) -> Vec<u8> {
    let mut head = vec![0u8; 0x80];
    head[..4].copy_from_slice(&[0x7f, b'P', b'K', b'G']);
    head[6..8].copy_from_slice(&kind.to_be_bytes());
    head[0x30..0x30 + content_id.len()].copy_from_slice(content_id.as_bytes());
    head
}

fn pkg_ps4(content_id: &str) -> Vec<u8> {
    let mut head = vec![0u8; 0x100];
    head[..4].copy_from_slice(&[0x7f, b'C', b'N', b'T']);
    head[0x40..0x40 + content_id.len()].copy_from_slice(content_id.as_bytes());
    head
}

fn elf(machine: u16, big_endian: bool) -> Vec<u8> {
    let mut head = vec![0u8; 0x40];
    head[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
    head[4] = 2;
    head[5] = if big_endian { 2 } else { 1 };
    let bytes = if big_endian { machine.to_be_bytes() } else { machine.to_le_bytes() };
    head[0x12..0x14].copy_from_slice(&bytes);
    head
}

fn find<'a>(out: &'a ScanOutput, rel: &str) -> &'a ScannedGame {
    out.games
        .iter()
        .find(|g| g.rel == rel)
        .unwrap_or_else(|| panic!("{rel} fehlt in {:?}", out.games.iter().map(|g| &g.rel).collect::<Vec<_>>()))
}

fn system_of(out: &ScanOutput, rel: &str) -> Option<String> {
    find(out, rel).system.clone()
}

#[test]
fn unsortierter_ordner_wird_nach_inhalt_zugeordnet() {
    let tmp = TempDir::new("lib-mix");
    let root = tmp.path();
    // alles bunt gemischt, ohne Systemordner und mit irreführenden Namen
    write(root, "Gran Turismo 5.iso", &ps3_iso());
    write(root, "irgendwas/Final Fantasy X.iso", &ps2_iso());
    write(root, "irgendwas/tief/drin/Crash Bandicoot.iso", &ps1_iso());
    write(root, "Crisis Core.iso", &psp_iso());
    write(root, "Setup CD.iso", &pc_iso());
    write(root, "Luigi's Mansion.iso", &disc_header("GLME01", "Luigi's Mansion", false));
    write(root, "wii/Mario Kart Wii.iso", &disc_header("RMCE01", "Mario Kart Wii", true));
    // falscher Ordner: der Inhalt gewinnt
    write(root, "PS2/Doch ein PS3-Spiel.iso", &ps3_iso());

    let out = scan(root, None).unwrap();
    assert_eq!(system_of(&out, "Gran Turismo 5.iso").as_deref(), Some("PS3"));
    assert_eq!(system_of(&out, "irgendwas/Final Fantasy X.iso").as_deref(), Some("PS2"));
    assert_eq!(system_of(&out, "irgendwas/tief/drin/Crash Bandicoot.iso").as_deref(), Some("PS1"));
    assert_eq!(system_of(&out, "Crisis Core.iso").as_deref(), Some("PSP"));
    assert_eq!(system_of(&out, "Luigi's Mansion.iso").as_deref(), Some("GameCube"));
    assert_eq!(system_of(&out, "wii/Mario Kart Wii.iso").as_deref(), Some("Wii"));
    assert_eq!(system_of(&out, "PS2/Doch ein PS3-Spiel.iso").as_deref(), Some("PS3"));
    assert_eq!(find(&out, "PS2/Doch ein PS3-Spiel.iso").how, "content");

    // ein ISO ohne Spielstruktur bleibt offen
    let pc = find(&out, "Setup CD.iso");
    assert_eq!(pc.system, None);
    assert_eq!(pc.how, "none");

    let gt = find(&out, "Gran Turismo 5.iso");
    assert_eq!(gt.title.as_deref(), Some("Gran Turismo 5"));
    assert_eq!(gt.serial.as_deref(), Some("BCES00569"));
    assert_eq!(find(&out, "Luigi's Mansion.iso").serial.as_deref(), Some("GLME01"));
}

#[test]
fn alte_ordnerstruktur_funktioniert_weiter() {
    let tmp = TempDir::new("lib-folder");
    let root = tmp.path();
    // Inhalt nicht lesbar (CHD ohne Kopf, .bin ohne Daten): der Ordnername entscheidet
    write(root, "PS1/Spiel A.chd", &[0u8; 64]);
    write(root, "PlayStation 2 Spiele/Spiel B.chd", &[0u8; 64]);
    write(root, "Sony - PlayStation 3/Spiel C.pkg", &[0u8; 64]);
    write(root, "GameCube/Spiel D.dol", &[0u8; 64]);
    write(root, "Meine Wii ISOs/Spiel E.wbfs", &[0u8; 64]);
    write(root, "Switch/Spiel F.chd", &[0u8; 64]);

    let out = scan(root, None).unwrap();
    assert_eq!(system_of(&out, "PS1/Spiel A.chd").as_deref(), Some("PS1"));
    assert_eq!(find(&out, "PS1/Spiel A.chd").how, "folder");
    assert_eq!(system_of(&out, "PlayStation 2 Spiele/Spiel B.chd").as_deref(), Some("PS2"));
    assert_eq!(system_of(&out, "Sony - PlayStation 3/Spiel C.pkg").as_deref(), Some("PS3"));
    assert_eq!(system_of(&out, "GameCube/Spiel D.dol").as_deref(), Some("GameCube"));
    assert_eq!(system_of(&out, "Meine Wii ISOs/Spiel E.wbfs").as_deref(), Some("Wii"));
    assert_eq!(system_of(&out, "Switch/Spiel F.chd"), None);
}

#[test]
fn cue_bin_ist_ein_spiel_und_m3u_fasst_discs_zusammen() {
    let tmp = TempDir::new("lib-cue");
    let root = tmp.path();
    write(root, "Crash/Crash (Track 1).bin", &raw_wrap(&ps1_iso(), true));
    write(root, "Crash/Crash (Track 2).bin", &[0u8; 100]);
    write(
        root,
        "Crash/Crash.cue",
        b"FILE \"Crash (Track 1).bin\" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\nFILE \"Crash (Track 2).bin\" BINARY\r\n  TRACK 02 AUDIO\r\n    INDEX 01 00:00:00\r\n",
    );
    write(root, "FF7/FF7 (Disc 1).bin", &raw_wrap(&ps1_iso(), true));
    write(root, "FF7/FF7 (Disc 1).cue", b"FILE \"FF7 (Disc 1).bin\" BINARY\r\n  TRACK 01 MODE2/2352\r\n");
    write(root, "FF7/FF7 (Disc 2).bin", &raw_wrap(&ps1_iso(), true));
    write(root, "FF7/FF7 (Disc 2).cue", b"FILE \"FF7 (Disc 2).bin\" BINARY\r\n  TRACK 01 MODE2/2352\r\n");
    write(root, "FF7/FF7.m3u", b"#EXTM3U\r\nFF7 (Disc 1).cue\r\nFF7 (Disc 2).cue\r\n");
    // ein einzelnes .bin ohne .cue zählt als Spiel
    write(root, "Solo.bin", &raw_wrap(&ps1_iso(), true));

    let out = scan(root, None).unwrap();
    let rels: Vec<&str> = out.games.iter().map(|g| g.rel.as_str()).collect();
    assert_eq!(rels, vec!["Crash/Crash.cue", "FF7/FF7.m3u", "Solo.bin"]);
    for rel in &rels {
        assert_eq!(system_of(&out, rel).as_deref(), Some("PS1"), "{rel}");
    }
}

#[test]
fn entpackte_spieleordner_und_programme() {
    let tmp = TempDir::new("lib-dirs");
    let root = tmp.path();
    let sfo_ps3 = sfo(&[("TITLE", Sfo::Text("Demon's Souls")), ("TITLE_ID", Sfo::Text("BLUS30443"))]);
    write(root, "Demon's Souls/PS3_GAME/PARAM.SFO", &sfo_ps3);
    write(root, "Demon's Souls/PS3_GAME/USRDIR/EBOOT.BIN", &[1u8; 10]);
    write(root, "Demon's Souls/PS3_GAME/USRDIR/Daten/tief.iso", &ps2_iso());
    // installiertes PS3-Spiel (Ordner mit PARAM.SFO + USRDIR/EBOOT.BIN)
    write(root, "dev_hdd0/game/BLES00001/PARAM.SFO", &sfo_ps3);
    write(root, "dev_hdd0/game/BLES00001/USRDIR/EBOOT.BIN", &[1u8; 10]);
    // PSP-Ordner
    write(
        root,
        "PSP Spiel/PSP_GAME/PARAM.SFO",
        &sfo(&[("TITLE", Sfo::Text("Patapon")), ("DISC_ID", Sfo::Text("UCES00995"))]),
    );
    // macOS-Paket
    write(root, "Programme/Super Tux.app/Contents/Info.plist", b"<plist/>");
    write(root, "Programme/Super Tux.app/Contents/MacOS/tux", &[0u8; 4]);
    // ein einfacher Ordner mit Dokumenten ist kein Spiel
    write(root, "Notizen/readme.txt", b"hallo");

    let out = scan(root, None).unwrap();
    let rels: Vec<&str> = out.games.iter().map(|g| g.rel.as_str()).collect();
    // nichts aus dem Inneren der Spieleordner taucht auf (tief.iso)
    assert_eq!(
        rels,
        vec!["Demon's Souls", "dev_hdd0/game/BLES00001", "Programme/Super Tux.app", "PSP Spiel"]
    );
    let ds = find(&out, "Demon's Souls");
    assert_eq!(ds.kind, "folder");
    assert_eq!(ds.system.as_deref(), Some("PS3"));
    assert_eq!(ds.title.as_deref(), Some("Demon's Souls"));
    assert_eq!(system_of(&out, "PSP Spiel").as_deref(), Some("PSP"));
    assert_eq!(system_of(&out, "dev_hdd0/game/BLES00001").as_deref(), Some("PS3"));
    let app = find(&out, "Programme/Super Tux.app");
    assert_eq!(app.kind, "bundle");
    assert_eq!(app.system, None);
}

#[test]
fn seriennummer_im_dateinamen_ordnet_psn_und_psp_zu() {
    let tmp = TempDir::new("lib-serial");
    let root = tmp.path();
    write(root, "Irgendein Spiel [BLUS30443].chd", &[0u8; 64]);
    write(root, "Anderes Spiel ULES-00821.chd", &[0u8; 64]);
    // PS1/PS2 teilen sich die Präfixe: nicht eindeutig
    write(root, "Final Fantasy X [SLES-50490].chd", &[0u8; 64]);

    let out = scan(root, None).unwrap();
    let a = find(&out, "Irgendein Spiel [BLUS30443].chd");
    assert_eq!((a.system.as_deref(), a.how), (Some("PS3"), "serial"));
    assert_eq!(system_of(&out, "Anderes Spiel ULES-00821.chd").as_deref(), Some("PSP"));
    assert_eq!(system_of(&out, "Final Fantasy X [SLES-50490].chd"), None);
    assert_eq!(find(&out, "Final Fantasy X [SLES-50490].chd").serial.as_deref(), Some("SLES-50490"));
}

#[test]
fn formate_cso_pkg_elf_und_dolphin_container() {
    let tmp = TempDir::new("lib-format");
    let root = tmp.path();
    write(root, "psp.cso", b"CISO\x18\x00\x00\x00");
    write(root, "psn.pkg", &pkg(1, "UP0001-NPUB30000_00-ABCDEFGHIJKLMNOP"));
    write(root, "vita.pkg", &pkg(2, "EP0001-PCSB00001_00-ABCDEFGHIJKLMNOP"));
    write(root, "ps3.elf", &elf(0x15, true));
    write(root, "wii.elf", &elf(0x14, true));
    write(root, "mips.elf", &elf(0x08, false));
    write(root, "kaputt.pkg", &[0u8; 32]);
    // Dolphin-CISO: Blockgröße statt Kopfgröße, Disc ab 0x8000
    let mut ciso = b"CISO".to_vec();
    ciso.extend_from_slice(&0x20_0000u32.to_le_bytes());
    ciso.resize(0x8000, 0);
    ciso.extend_from_slice(&disc_header("GM4E01", "Mario Party 4", false));
    write(root, "mp4.ciso", &ciso);
    // RVZ: Kopf 0x58 + Disc-Kopf
    let mut rvz = b"RVZ\x01".to_vec();
    rvz.resize(0x48, 0);
    rvz.extend_from_slice(&2u32.to_be_bytes());
    rvz.resize(0x58, 0);
    rvz.extend_from_slice(&disc_header("RSBE01", "Super Smash Bros. Brawl", true));
    rvz.resize(0xd8, 0);
    write(root, "brawl.rvz", &rvz);
    // WBFS: Disc-Kopf bei 0x200
    let mut wbfs = b"WBFS".to_vec();
    wbfs.resize(0x200, 0);
    wbfs.extend_from_slice(&disc_header("RZDE01", "Zelda TP", true));
    write(root, "tp.wbfs", &wbfs);
    write(root, "tool.dol", &[0u8; 16]);

    let out = scan(root, None).unwrap();
    assert_eq!(system_of(&out, "psp.cso").as_deref(), Some("PSP"));
    assert_eq!(system_of(&out, "psn.pkg").as_deref(), Some("PS3"));
    assert_eq!(find(&out, "psn.pkg").serial.as_deref(), Some("NPUB-30000"));
    assert_eq!(system_of(&out, "vita.pkg"), None);
    assert_eq!(system_of(&out, "kaputt.pkg"), None);
    assert_eq!(system_of(&out, "ps3.elf").as_deref(), Some("PS3"));
    let wii_elf = find(&out, "wii.elf");
    assert_eq!((wii_elf.system.clone(), wii_elf.guess.as_deref()), (None, Some("Wii")));
    assert_eq!(find(&out, "mips.elf").guess.as_deref(), Some("PS2"));
    let mp4 = find(&out, "mp4.ciso");
    assert_eq!((mp4.system.as_deref(), mp4.how), (Some("GameCube"), "content"));
    assert_eq!(mp4.title.as_deref(), Some("Mario Party 4"));
    assert_eq!(system_of(&out, "brawl.rvz").as_deref(), Some("Wii"));
    assert_eq!(find(&out, "brawl.rvz").serial.as_deref(), Some("RSBE01"));
    assert_eq!(system_of(&out, "tp.wbfs").as_deref(), Some("Wii"));
    assert_eq!(system_of(&out, "tool.dol").as_deref(), Some("GameCube"));
}

#[test]
fn chd_groesse_schliesst_systeme_aus() {
    let tmp = TempDir::new("lib-chd");
    let root = tmp.path();
    const MB: u64 = 1024 * 1024;
    write(root, "cd-gross.chd", &chd(true, 1500 * MB));
    write(root, "cd-klein.chd", &chd(true, 650 * MB));
    write(root, "dvd-gross.chd", &chd(false, 4000 * MB));
    write(root, "dvd-mittel.chd", &chd(false, 1200 * MB));
    // ein Ordner schlägt die Vermutung
    write(root, "PS2/cd-klein.chd", &chd(true, 650 * MB));

    let out = scan(root, None).unwrap();
    let big = find(&out, "cd-gross.chd");
    assert_eq!((big.system.as_deref(), big.how, big.uncertain), (Some("PS2"), "size", false));
    let small = find(&out, "cd-klein.chd");
    assert_eq!((small.system.as_deref(), small.how, small.uncertain), (Some("PS1"), "size", true));
    assert_eq!(system_of(&out, "dvd-gross.chd").as_deref(), Some("PS2"));
    let mid = find(&out, "dvd-mittel.chd");
    assert_eq!((mid.system.clone(), mid.guess.as_deref()), (None, Some("PSP")));
    let in_folder = find(&out, "PS2/cd-klein.chd");
    assert_eq!((in_folder.system.as_deref(), in_folder.how, in_folder.uncertain), (Some("PS2"), "folder", false));
}

#[test]
fn bilder_werden_aufgelistet_versteckte_und_papierkorb_nicht() {
    let tmp = TempDir::new("lib-img");
    let root = tmp.path();
    write(root, "Spiel.iso", &ps3_iso());
    write(root, "Spiel.png", b"x");
    write(root, "covers/Anderes.jpg", b"x");
    write(root, ".versteckt/Spiel2.iso", &ps3_iso());
    write(root, "._Spiel.iso", &ps3_iso());
    write(root, "$RECYCLE.BIN/Weg.iso", &ps3_iso());
    write(root, ".DS_Store", b"x");

    let out = scan(root, None).unwrap();
    assert_eq!(out.games.len(), 1);
    assert_eq!(out.images, vec!["Spiel.png".to_string(), "covers/Anderes.jpg".to_string()]);
}

#[test]
fn cache_wird_wiederverwendet_und_bei_aenderung_erneuert() {
    let tmp = TempDir::new("lib-cache");
    let root = tmp.path().join("spiele");
    fs::create_dir_all(&root).unwrap();
    let cache = tmp.join("cache/library-scan.json");
    write(&root, "A.iso", &ps3_iso());

    let first = scan(&root, Some(&cache)).unwrap();
    assert_eq!(system_of(&first, "A.iso").as_deref(), Some("PS3"));
    assert!(cache.exists());

    // Dieselbe Größe und Zeit, aber ein vergifteter Cache-Eintrag: der Cache zählt
    let text = fs::read_to_string(&cache).unwrap();
    let poisoned = text.replace("\"content\":\"PS3\"", "\"content\":\"Wii\"");
    assert_ne!(text, poisoned);
    fs::write(&cache, poisoned).unwrap();
    let second = scan(&root, Some(&cache)).unwrap();
    assert_eq!(system_of(&second, "A.iso").as_deref(), Some("Wii"));

    // Änderung an der Datei (andere Größe) entwertet den Eintrag
    std::thread::sleep(std::time::Duration::from_millis(30));
    write(&root, "A.iso", &psp_iso());
    let third = scan(&root, Some(&cache)).unwrap();
    assert_eq!(system_of(&third, "A.iso").as_deref(), Some("PSP"));

    // anderer Ordner → Cache wird ignoriert
    let other = tmp.join("andere");
    fs::create_dir_all(&other).unwrap();
    write(&other, "A.iso", &ps3_iso());
    let fourth = scan(&other, Some(&cache)).unwrap();
    assert_eq!(system_of(&fourth, "A.iso").as_deref(), Some("PS3"));
}

#[test]
fn fehlender_ordner_ist_ein_fehler() {
    let tmp = TempDir::new("lib-missing");
    let err = scan(&tmp.join("gibt-es-nicht"), None).unwrap_err();
    assert!(err.contains("nicht gefunden"), "{err}");
    write(tmp.path(), "datei.txt", b"x");
    assert!(scan(&tmp.join("datei.txt"), None).is_err());
}

#[test]
fn ordnernamen_mit_system_im_text() {
    for (name, expected) in [
        ("PS3", Some(Platform::Ps3)),
        ("PS2 Spiele", Some(Platform::Ps2)),
        ("Meine PlayStation 3 ISOs", Some(Platform::Ps3)),
        ("Sony - PlayStation Portable", Some(Platform::Psp)),
        ("Nintendo GameCube", Some(Platform::GameCube)),
        ("Wii-Spiele", Some(Platform::Wii)),
        ("Downloads", None),
        ("covers", None),
        ("Switch", None),
    ] {
        assert_eq!(platform_of_folder(name), expected, "{name}");
    }
}

#[test]
fn ps4_spieleordner_pakete_und_seriennummern() {
    let tmp = TempDir::new("lib-ps4");
    let root = tmp.path();
    let sfo_ps4 = sfo(&[("TITLE", Sfo::Text("Bloodborne")), ("TITLE_ID", Sfo::Text("CUSA03173"))]);
    // entpackter Spielordner (so legt ihn shadPS4 ab) – das Innere taucht nicht auf
    write(root, "Bloodborne/eboot.bin", &[0x7f, b'E', b'L', b'F']);
    write(root, "Bloodborne/sce_sys/param.sfo", &sfo_ps4);
    write(root, "Bloodborne/sce_module/libc.prx", &[0u8; 8]);
    write(root, "Bloodborne/Daten/tief.iso", &ps2_iso());
    // Update-Ordner neben dem Spiel ist kein eigenes Spiel
    write(root, "Bloodborne-UPDATE/eboot.bin", &[0x7f, b'E', b'L', b'F']);
    write(root, "Bloodborne-UPDATE/sce_sys/param.sfo", &sfo_ps4);
    // Vita-Ordner mit demselben Aufbau, aber Vita-Titelnummer: kein PS4-Spielordner (nur die lose eboot.bin bleibt, ohne System)
    write(root, "Vita Spiel/eboot.bin", &[0u8; 8]);
    write(
        root,
        "Vita Spiel/sce_sys/param.sfo",
        &sfo(&[("TITLE", Sfo::Text("Gravity Rush")), ("TITLE_ID", Sfo::Text("PCSF00021"))]),
    );
    // Installationspaket und Dateiname mit Titelnummer
    write(root, "paket.pkg", &pkg_ps4("UP9000-CUSA00419_00-ABCDEFGHIJKLMNOP"));
    write(root, "Spiel [CUSA12345].chd", &[0u8; 64]);

    let out = scan(root, None).unwrap();
    let rels: Vec<&str> = out.games.iter().map(|g| g.rel.as_str()).collect();
    assert_eq!(rels, vec!["Bloodborne", "paket.pkg", "Spiel [CUSA12345].chd", "Vita Spiel/eboot.bin"]);
    assert_eq!(system_of(&out, "Vita Spiel/eboot.bin"), None);
    let game = find(&out, "Bloodborne");
    assert_eq!((game.kind, game.system.as_deref(), game.how), ("folder", Some("PS4"), "content"));
    assert_eq!(game.title.as_deref(), Some("Bloodborne"));
    assert_eq!(game.serial.as_deref(), Some("CUSA03173"));
    let pkg = find(&out, "paket.pkg");
    assert_eq!((pkg.system.as_deref(), pkg.how), (Some("PS4"), "format"));
    assert_eq!(pkg.serial.as_deref(), Some("CUSA-00419"));
    let named = find(&out, "Spiel [CUSA12345].chd");
    assert_eq!((named.system.as_deref(), named.how), (Some("PS4"), "serial"));
}

#[test]
fn ordner_ps4_ordnet_unerkannte_dateien_zu() {
    let tmp = TempDir::new("lib-ps4-folder");
    let root = tmp.path();
    write(root, "PlayStation 4/Spiel.chd", &[0u8; 64]);
    let out = scan(root, None).unwrap();
    let game = find(&out, "PlayStation 4/Spiel.chd");
    assert_eq!((game.system.as_deref(), game.how), (Some("PS4"), "folder"));
}
