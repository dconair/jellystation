//! Spielebibliothek aus einem einzigen Ordner.
//!
//! Der Nutzer legt ISOs, Spieleordner und andere Spieldateien unsortiert in EINEN Ordner (auch in beliebige
//! Unterordner). `games_scan` durchsucht ihn rekursiv und erkennt für jedes Spiel das System – ohne etwas zu
//! verschieben, umzubenennen oder zu entpacken. Die Einsortierung geschieht nur virtuell im Menü.
//!
//! Reihenfolge der Erkennung (von sicher nach vage):
//! 1. **Inhalt**: `PS3_GAME/PARAM.SFO` bzw. `PS3_DISC.SFB` (PS3), `PSP_GAME/PARAM.SFO` und `EBOOT.PBP` (PSP),
//!    `SYSTEM.CNF` mit `BOOT2` (PS2) oder `BOOT` (PS1), Disc-Kopf mit GameCube-/Wii-Kennung – in ISO-Abbildern,
//!    CUE/BIN, `.rvz`/`.wia`/`.wbfs`/`.ciso` und entpackten Spieleordnern (Lesen nur der ersten Sektoren).
//! 2. **Seriennummer im Dateinamen** (`[BLUS30443]`, `ULES-00821`), soweit sie nur zu einem System passt.
//! 3. **Dateiformat**: `.cso` (PSP), `.pkg` (Kopf), ELF-Maschine (PowerPC64 = PS3), `.dol`, `.gcz` …
//! 4. **Ordnername** irgendwo über der Datei (`PS3/`, `PlayStation 2 Spiele/` …) – die alte Ordnerstruktur
//!    funktioniert also weiter.
//! 5. **Größe** bei CHD-Abbildern (eine CD-CHD über 800 MB ist keine PS1, eine DVD-CHD über 2 GB keine PSP).
//!
//! Was danach offen bleibt, meldet der Scan ohne System (`system: null`), ggf. mit einem Vorschlag (`guess`).
//! Die Oberfläche zeigt es unter „Nicht zugeordnet“ und lässt es von Hand zuordnen.
//!
//! Dazu: `.bin`/`.cue`-Gruppen und `.m3u`-Listen ergeben EIN Spiel (die Datenspuren werden ausgeblendet),
//! macOS-`.app`-Pakete sind eigene Programme, entpackte Spieleordner werden nicht weiter durchsucht.
//! Bilder (Cover) werden nur aufgelistet; welches zu welchem Spiel gehört, entscheidet die Oberfläche.
//!
//! Gelesen wird nur. Ergebnisse der Inhaltsprüfung merkt sich ein kleiner Cache (`library-scan.json` im
//! App-Cache-Ordner, je Datei nach Größe und Änderungszeit), damit ein zweiter Start auch bei Hunderten Spielen
//! auf einem Netzlaufwerk sofort fertig ist.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::covers::embedded::{self, Embedded};
use crate::covers::iso;
use crate::covers::system::Platform;
use crate::requirements::expand;

/// Dateiendungen (klein geschrieben), die als Spiel gelten. `app` gilt nur für Ordner (macOS-Pakete).
const GAME_EXTENSIONS: &[&str] = &[
    "iso", "pkg", "cue", "chd", "bin", "elf", "cso", "pbp", "m3u", "rvz", "wbfs", "gcm", "ciso", "dol", "gcz",
    "wia",
];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
/// Ordner, die nie Spiele enthalten (Papierkörbe, Systemordner von Windows, NAS).
const SKIP_DIRS: &[&str] = &["$recycle.bin", "system volume information", "lost+found", "@eadir", "#recycle"];

const MAX_DEPTH: usize = 12;
const MAX_GAMES: usize = 20_000;
const MAX_IMAGES: usize = 60_000;
const THREADS: usize = 4;
/// Eine PS1-CD fasst höchstens ca. 700–800 MB.
const PS1_MAX_BYTES: u64 = 800 * 1024 * 1024;
/// Eine UMD (PSP) fasst höchstens 1,8 GB.
const PSP_MAX_BYTES: u64 = 1_900_000_000;
const CACHE_FILE: &str = "library-scan.json";
const CACHE_VERSION: u32 = 1;

/* ------------------------------------------------------------------------------------- Ergebnis */

/// Ein gefundenes Spiel.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedGame {
    /// Absoluter Pfad (mit `/`).
    pub path: String,
    /// Pfad relativ zum Spiele-Ordner (mit `/`) – stabil, taugt als Schlüssel für Zuordnungen von Hand.
    pub rel: String,
    /// Datei- bzw. Ordnername.
    pub name: String,
    /// `file` | `folder` (entpacktes Spiel) | `bundle` (macOS-`.app`)
    pub kind: &'static str,
    /// Endung in Kleinbuchstaben ohne Punkt (leer bei Ordnern).
    pub ext: String,
    pub size: u64,
    /// Erkanntes System (`PS1` `PS2` `PS3` `PSP` `GameCube` `Wii`); `None` = nicht zuordenbar. Bei `bundle` leer.
    pub system: Option<String>,
    /// Woran das System erkannt wurde: `content` | `serial` | `format` | `folder` | `size` | `none`.
    pub how: &'static str,
    /// Nur eine Vermutung (z. B. PS1 bei einer kleinen CD-CHD): Die Oberfläche kennzeichnet den Eintrag.
    pub uncertain: bool,
    /// Vorschlag für ein nicht zuordenbares Spiel.
    pub guess: Option<String>,
    pub serial: Option<String>,
    /// Titel aus dem Spiel selbst (`PARAM.SFO`, Disc-Kopf), falls vorhanden.
    pub title: Option<String>,
    /// Begründung in einem Satz (für Beschreibung und Fehlersuche).
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutput {
    /// Aufgelöster Spiele-Ordner (mit `/`).
    pub root: String,
    pub games: Vec<ScannedGame>,
    /// Alle Bilder darin (relative Pfade) – mögliche Cover.
    pub images: Vec<String>,
    /// Es gab mehr als erlaubt; der Rest wurde ausgelassen.
    pub truncated: bool,
    /// Ordner, die sich nicht lesen ließen.
    pub unreadable: u32,
}

/* ------------------------------------------------------------------------------------ Erkennung */

/// Was sich aus der Datei selbst ergibt (unabhängig von Name und Ordner) – das ist auch das, was gemerkt wird.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Sniff {
    /// System aus dem Inhalt (sicher).
    content: Option<String>,
    /// System aus dem Dateiformat (eindeutig, z. B. `.cso`).
    format: Option<String>,
    /// System aus der Größe (schließt die anderen aus, ist aber kein Beleg).
    size: Option<String>,
    /// Kleine CD-CHD: vermutlich PS1; zählt als Treffer, wird aber als unsicher gekennzeichnet.
    weak: Option<String>,
    /// Vorschlag, wenn nichts sicher ist.
    guess: Option<String>,
    serial: Option<String>,
    title: Option<String>,
    /// Was gefunden wurde, z. B. „PS3_GAME/PARAM.SFO im Abbild“.
    note: String,
}

fn platform_name(p: Platform) -> String {
    p.folder_name().to_string()
}

fn platform_of(name: &Option<String>) -> Option<Platform> {
    name.as_deref().and_then(Platform::from_folder)
}

/// Liest `len` Bytes ab `offset`; weniger ist ein Fehler.
fn read_at(path: &Path, offset: u64, len: usize) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn from_embedded(found: Embedded) -> Sniff {
    let note = match found.platform {
        Some(Platform::Ps3) => "PS3-Spielstruktur (PS3_GAME / PARAM.SFO)",
        Some(Platform::Psp) => "PSP-Spielstruktur (PSP_GAME / PARAM.SFO)",
        Some(Platform::Ps2) => "SYSTEM.CNF mit BOOT2 (PlayStation 2)",
        Some(Platform::Ps1) => "SYSTEM.CNF mit BOOT (PlayStation 1)",
        Some(Platform::GameCube) => "Disc-Kopf eines GameCube-Spiels",
        Some(Platform::Wii) => "Disc-Kopf eines Wii-Spiels",
        None => "",
    };
    Sniff {
        content: found.platform.map(platform_name),
        serial: found.serial,
        title: found.title,
        note: note.to_string(),
        ..Sniff::default()
    }
}

fn by_format(platform: Platform, note: &str) -> Sniff {
    Sniff {
        format: Some(platform_name(platform)),
        note: note.to_string(),
        ..Sniff::default()
    }
}

fn from_disc_header(head: &[u8], note: &str) -> Option<Sniff> {
    let header = iso::parse_disc_header(head)?;
    Some(Sniff {
        content: Some(platform_name(if header.wii { Platform::Wii } else { Platform::GameCube })),
        serial: Some(header.id),
        title: (!header.name.is_empty()).then_some(header.name),
        note: note.to_string(),
        ..Sniff::default()
    })
}

/// PS3-Installationspaket: Kopf `\x7fPKG`, Typ 1 = PS3; die Content-ID enthält die Titelnummer.
fn sniff_pkg(path: &Path) -> Sniff {
    let Some(head) = read_at(path, 0, 0x60) else {
        return Sniff::default();
    };
    if head[..4] != [0x7f, b'P', b'K', b'G'] {
        return Sniff::default();
    }
    let kind = u16::from_be_bytes([head[6], head[7]]);
    let id_raw = &head[0x30..0x54];
    let end = id_raw.iter().position(|b| *b == 0).unwrap_or(id_raw.len());
    let content_id = String::from_utf8_lossy(&id_raw[..end]).into_owned();
    let serial = serial_in(&content_id);
    let by_serial = serial.as_ref().and_then(|s| platform_of_serial(s));
    let mut sniff = match (kind, by_serial) {
        (1, _) => by_format(Platform::Ps3, "PS3-Installationspaket (.pkg)"),
        (_, Some(p)) => by_format(p, "Installationspaket mit passender Titelnummer"),
        _ => Sniff {
            note: "Installationspaket für ein nicht unterstütztes System (PSP/Vita)".into(),
            ..Sniff::default()
        },
    };
    sniff.serial = serial;
    sniff
}

/// ELF: PowerPC64 = PS3 (RPCS3 startet `.elf`), PowerPC = Dolphin (GameCube oder Wii), MIPS = meist PS2.
fn sniff_elf(path: &Path) -> Sniff {
    let Some(head) = read_at(path, 0, 0x14) else {
        return Sniff::default();
    };
    if head[..4] != [0x7f, b'E', b'L', b'F'] {
        return Sniff::default();
    }
    let machine = if head[5] == 2 {
        u16::from_be_bytes([head[0x12], head[0x13]])
    } else {
        u16::from_le_bytes([head[0x12], head[0x13]])
    };
    match machine {
        0x15 => by_format(Platform::Ps3, "ELF für PowerPC64 (PS3)"),
        0x14 => Sniff {
            guess: Some(platform_name(Platform::Wii)),
            note: "ELF für PowerPC (Dolphin) – GameCube oder Wii nicht unterscheidbar".into(),
            ..Sniff::default()
        },
        0x08 => Sniff {
            guess: Some(platform_name(Platform::Ps2)),
            note: "ELF für MIPS (PS2, PS1 oder PSP) – nicht eindeutig".into(),
            ..Sniff::default()
        },
        _ => Sniff::default(),
    }
}

/// CHD (MAME): Version 5 verrät, ob eine CD oder eine DVD/Festplatte gepackt ist, und die ungepackte Größe.
fn sniff_chd(path: &Path) -> Sniff {
    let head = read_at(path, 0, 0x48).filter(|h| h.starts_with(b"MComprHD"));
    let Some(head) = head else {
        return Sniff::default();
    };
    if be32(&head, 12) != 5 {
        return Sniff {
            note: "CHD in einer alten Version – System nicht erkennbar".into(),
            ..Sniff::default()
        };
    }
    let cd = head[16..20].starts_with(b"cd");
    let logical = u64::from_be_bytes(head[32..40].try_into().unwrap_or([0; 8]));
    let mb = logical / (1024 * 1024);
    let mut sniff = Sniff::default();
    if cd {
        if logical > PS1_MAX_BYTES {
            sniff.size = Some(platform_name(Platform::Ps2));
            sniff.note = format!("CD-CHD mit {mb} MB passt nicht auf eine PS1-CD");
        } else {
            sniff.weak = Some(platform_name(Platform::Ps1));
            sniff.guess = sniff.weak.clone();
            sniff.note = format!("CD-CHD mit {mb} MB – vermutlich PS1 (PS2-CD-Spiele sind selten)");
        }
    } else if logical > PSP_MAX_BYTES {
        sniff.size = Some(platform_name(Platform::Ps2));
        sniff.note = format!("DVD-CHD mit {mb} MB ist größer als jede PSP-UMD");
    } else {
        sniff.guess = Some(platform_name(if mb > 1800 { Platform::Ps2 } else { Platform::Psp }));
        sniff.note = format!("DVD-CHD mit {mb} MB – PS2 oder PSP");
    }
    sniff
}

/// `.cso` (PSP), `.ciso` (Dolphin oder PSP), `.rvz`/`.wia`/`.wbfs`/`.gcz`/`.dol` (Dolphin).
fn sniff_container(path: &Path, ext: &str) -> Sniff {
    match ext {
        "cso" => by_format(Platform::Psp, "komprimiertes PSP-Abbild (.cso)"),
        "dol" => by_format(Platform::GameCube, "Dolphin-Programmdatei (.dol)"),
        "gcz" => by_format(Platform::GameCube, "komprimiertes GameCube-Abbild (.gcz)"),
        "gcm" => by_format(Platform::GameCube, "GameCube-Abbild (.gcm)"),
        "wbfs" => {
            let head = read_at(path, 0x200, 0x60).and_then(|h| from_disc_header(&h, "Disc-Kopf im WBFS-Abbild"));
            let mut sniff = head.unwrap_or_else(|| by_format(Platform::Wii, "WBFS-Abbild (Wii)"));
            sniff.content.get_or_insert_with(|| platform_name(Platform::Wii));
            sniff
        }
        "rvz" | "wia" => {
            let Some(head) = read_at(path, 0, 0xd8) else {
                return Sniff::default();
            };
            if !(head.starts_with(b"RVZ\x01") || head.starts_with(b"WIA\x01")) {
                return Sniff::default();
            }
            if let Some(sniff) = from_disc_header(&head[0x58..0xd8], "Disc-Kopf im komprimierten Abbild") {
                return sniff;
            }
            match be32(&head, 0x48) {
                1 => by_format(Platform::GameCube, "komprimiertes GameCube-Abbild"),
                2 => by_format(Platform::Wii, "komprimiertes Wii-Abbild"),
                _ => Sniff::default(),
            }
        }
        "ciso" => {
            let Some(head) = read_at(path, 0, 8) else {
                return Sniff::default();
            };
            if !head.starts_with(b"CISO") {
                return Sniff::default();
            }
            // PSP-CSO: Kopfgröße 0x18; Dolphin-CISO: Blockgröße (z. B. 2 MB) an derselben Stelle
            if le32(&head, 4) == 0x18 {
                return by_format(Platform::Psp, "komprimiertes PSP-Abbild (CSO)");
            }
            read_at(path, 0x8000, 0x60)
                .and_then(|h| from_disc_header(&h, "Disc-Kopf im CISO-Abbild"))
                .unwrap_or_default()
        }
        _ => Sniff::default(),
    }
}

/// Prüft den Inhalt einer Datei oder eines Ordners. Wirft nie: Unlesbares ergibt ein leeres Ergebnis.
fn sniff_path(path: &Path, ext: &str, is_dir: bool, depth: u8) -> Sniff {
    if is_dir {
        return from_embedded(embedded::extract(path));
    }
    match ext {
        "iso" | "bin" | "cue" | "pbp" => {
            let mut sniff = from_embedded(embedded::extract(path));
            if sniff.content.is_none() && ext == "pbp" {
                sniff = by_format(Platform::Psp, "EBOOT.PBP (PSP)");
            }
            sniff
        }
        "pkg" => sniff_pkg(path),
        "elf" => sniff_elf(path),
        "chd" => sniff_chd(path),
        "m3u" if depth == 0 => m3u_entries(path)
            .first()
            .map(|first| {
                let target = first.clone();
                let target_ext = extension(&target);
                sniff_path(&target, &target_ext, false, depth + 1)
            })
            .unwrap_or_default(),
        "cso" | "ciso" | "gcz" | "gcm" | "wbfs" | "rvz" | "wia" | "dol" => sniff_container(path, ext),
        _ => Sniff::default(),
    }
}

/// Serien- bzw. Titelnummer im Text: vier Buchstaben, fünf Ziffern (`BLUS30443`, `SLUS-00594`, `ULES_00821`).
fn serial_in(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[^A-Za-z0-9])([A-Z]{4})[-_ ]?([0-9]{5})(?:[^0-9]|$)").expect("gültiger Ausdruck")
    });
    let caps = re.captures(text)?;
    Some(format!("{}-{}", caps[1].to_ascii_uppercase(), &caps[2]))
}

const PS3_PREFIXES: &[&str] = &[
    "BLUS", "BLES", "BLJM", "BLJS", "BLAS", "BLKS", "BCUS", "BCES", "BCJS", "BCAS", "BCKS", "BCJB", "NPUA", "NPUB",
    "NPEA", "NPEB", "NPJA", "NPJB", "NPHA", "NPHB", "NPIA", "NPKA", "NPKB", "NPAA", "NPAB",
];
const PSP_PREFIXES: &[&str] = &[
    "ULUS", "ULES", "ULJM", "ULJS", "ULAS", "ULKS", "UCUS", "UCES", "UCJS", "UCAS", "UCKS", "UCJB", "NPUZ", "NPEZ",
    "NPJZ", "NPHZ", "NPUG", "NPEG", "NPJG", "NPHG", "NPUH", "NPEH", "NPJH", "NPHH", "NPUF", "NPEF", "NPJF", "NPHF",
    "NPUI", "NPJI",
];

/// System zu einer Seriennummer – nur dort, wo das Präfix eindeutig ist. PS1 und PS2 teilen sich ihre Präfixe
/// (`SLUS`, `SCES` …), deshalb gibt es dafür hier bewusst keine Antwort.
fn platform_of_serial(serial: &str) -> Option<Platform> {
    let prefix = serial.get(..4)?.to_ascii_uppercase();
    if PS3_PREFIXES.contains(&prefix.as_str()) {
        Some(Platform::Ps3)
    } else if PSP_PREFIXES.contains(&prefix.as_str()) {
        Some(Platform::Psp)
    } else {
        None
    }
}

/// Erkennt ein System im Namen eines Ordners: ganz (`PS3`, `Sony - PlayStation 2`), oder an einem Wort bzw.
/// zwei aufeinanderfolgenden Wörtern (`PS2 Spiele`, `Meine PlayStation 3 ISOs`).
pub fn platform_of_folder(name: &str) -> Option<Platform> {
    if let Some(p) = Platform::from_folder(name) {
        return Some(p);
    }
    let words: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    for pair in words.windows(2) {
        if let Some(p) = Platform::from_folder(&format!("{}{}", pair[0], pair[1])) {
            return Some(p);
        }
    }
    words.iter().find_map(|w| Platform::from_folder(w))
}

/// Das Endergebnis für ein Spiel.
#[derive(Debug, Clone, PartialEq)]
struct Verdict {
    system: Option<Platform>,
    how: &'static str,
    uncertain: bool,
    guess: Option<Platform>,
    reason: String,
}

/// Wertet Inhalt, Dateiname und Ordner in der Reihenfolge von sicher nach vage aus.
fn decide(sniff: &Sniff, name: &str, folder: Option<&(Platform, String)>) -> Verdict {
    let found = |system: Platform, how: &'static str, reason: String| Verdict {
        system: Some(system),
        how,
        uncertain: false,
        guess: None,
        reason,
    };
    if let Some(p) = platform_of(&sniff.content) {
        return found(p, "content", format!("Inhalt: {}", sniff.note));
    }
    let named = serial_in(name);
    if let Some((serial, p)) = named
        .as_ref()
        .and_then(|s| platform_of_serial(s).map(|p| (s.clone(), p)))
    {
        return found(p, "serial", format!("Seriennummer {serial} im Dateinamen"));
    }
    if let Some(p) = platform_of(&sniff.format) {
        return found(p, "format", format!("Dateiformat: {}", sniff.note));
    }
    if let Some((p, folder_name)) = folder {
        return found(*p, "folder", format!("Ordner „{folder_name}“"));
    }
    if let Some(p) = platform_of(&sniff.size) {
        return found(p, "size", sniff.note.clone());
    }
    if let Some(p) = platform_of(&sniff.weak) {
        return Verdict {
            system: Some(p),
            how: "size",
            uncertain: true,
            guess: None,
            reason: sniff.note.clone(),
        };
    }
    let reason = if sniff.note.is_empty() {
        "Weder Inhalt noch Name oder Ordner verraten das System".to_string()
    } else {
        sniff.note.clone()
    };
    Verdict {
        system: None,
        how: "none",
        uncertain: false,
        guess: platform_of(&sniff.guess),
        reason,
    }
}

/* -------------------------------------------------------------------------------------- Suchlauf */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Folder,
    Bundle,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::File => "file",
            Kind::Folder => "folder",
            Kind::Bundle => "bundle",
        }
    }
}

struct Unit {
    path: PathBuf,
    kind: Kind,
    ext: String,
    size: u64,
    /// Nächster Ordner über der Datei, dessen Name ein System nennt.
    folder: Option<(Platform, String)>,
}

#[derive(Default)]
struct Walk {
    units: Vec<Unit>,
    images: Vec<PathBuf>,
    truncated: bool,
    unreadable: u32,
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn slashed(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Ist `dir` ein entpacktes Spiel (PS3-Disc-Ordner, installiertes PS3-Spiel, PSP-Ordner)?
/// `names` sind die kleingeschriebenen Namen der Einträge in `dir`.
fn is_game_folder(dir: &Path, names: &HashSet<String>) -> bool {
    let child = |name: &str, path: &str| -> bool {
        let Ok(entries) = fs::read_dir(dir.join(name)) else {
            return false;
        };
        entries
            .flatten()
            .any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(path))
    };
    // dir.join(name) mit dem echten Namen der Groß-/Kleinschreibung auf der Platte
    let real = |lower: &str| -> Option<String> {
        fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| n.to_ascii_lowercase() == lower)
    };
    for sub in ["ps3_game", "psp_game"] {
        if names.contains(sub) && real(sub).is_some_and(|n| child(&n, "param.sfo")) {
            return true;
        }
    }
    names.contains("param.sfo")
        && (names.contains("ps3_disc.sfb")
            || real("usrdir").is_some_and(|n| child(&n, "eboot.bin")))
}

impl Walk {
    fn visit(&mut self, dir: &Path, depth: usize, folder: Option<(Platform, String)>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => {
                self.unreadable += 1;
                return;
            }
        };
        let mut files: Vec<(String, PathBuf)> = Vec::new();
        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        let mut names = HashSet::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            names.insert(name.to_ascii_lowercase());
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.to_ascii_lowercase().as_str()) {
                    dirs.push((name, path));
                }
            } else if kind.is_file() || (kind.is_symlink() && fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false)) {
                files.push((name, path));
            }
            // Verknüpfungen auf Ordner werden nicht verfolgt (Schleifen)
        }
        if depth > 0 && is_game_folder(dir, &names) {
            self.push(Unit {
                path: dir.to_path_buf(),
                kind: Kind::Folder,
                ext: String::new(),
                size: 0,
                folder,
            });
            return;
        }
        for (_, path) in files {
            let ext = extension(&path);
            if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                if self.images.len() < MAX_IMAGES {
                    self.images.push(path);
                }
            } else if GAME_EXTENSIONS.contains(&ext.as_str()) {
                let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                self.push(Unit { path, kind: Kind::File, ext, size, folder: folder.clone() });
            }
        }
        for (name, path) in dirs {
            if name.to_ascii_lowercase().ends_with(".app") {
                self.push(Unit { path, kind: Kind::Bundle, ext: "app".into(), size: 0, folder: folder.clone() });
            } else if depth < MAX_DEPTH {
                let next = platform_of_folder(&name).map(|p| (p, name.clone())).or_else(|| folder.clone());
                self.visit(&path, depth + 1, next);
            }
        }
    }

    fn push(&mut self, unit: Unit) {
        if self.units.len() >= MAX_GAMES {
            self.truncated = true;
        } else {
            self.units.push(unit);
        }
    }
}

/// Alle `FILE`-Zeilen einer `.cue` (Datenspuren, evtl. mehrere `.bin`).
fn cue_files(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.len() < 5 || !line[..4].eq_ignore_ascii_case("FILE") {
            continue;
        }
        let rest = line[4..].trim_start();
        let name = if let Some(quoted) = rest.strip_prefix('"') {
            quoted.split('"').next().map(str::to_string)
        } else {
            rest.split_whitespace().next().map(str::to_string)
        };
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            out.push(name);
        }
    }
    out
}

/// Ein Name aus einer `.cue`/`.m3u`, der nur auf eine Datei im selben Ordner oder darunter zeigt.
fn local_target(base: &Path, name: &str) -> Option<PathBuf> {
    let name = name.trim().replace('\\', "/");
    let rel = Path::new(&name);
    if name.is_empty()
        || rel.is_absolute()
        || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(base.join(rel))
}

/// Die Dateien, die eine `.m3u` aufzählt (Kommentarzeilen ausgelassen), als Pfade neben der Liste.
fn m3u_entries(path: &Path) -> Vec<PathBuf> {
    let Some(base) = path.parent() else { return Vec::new() };
    if fs::metadata(path).map(|m| m.len() > 256 * 1024).unwrap_or(true) {
        return Vec::new();
    }
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .map(|l| l.trim_start_matches('\u{feff}').trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| local_target(base, l))
        .collect()
}

fn lower_key(path: &Path) -> String {
    slashed(path).to_lowercase()
}

/// Dateien, die zu einem anderen Spiel gehören: Spuren einer `.cue`, Discs einer `.m3u`, ein `.bin` neben
/// gleichnamiger `.cue`.
fn parts_of_other_games(units: &[Unit]) -> HashSet<String> {
    let mut hidden = HashSet::new();
    let cue_stems: HashSet<String> = units
        .iter()
        .filter(|u| u.ext == "cue")
        .map(|u| lower_key(&u.path.with_extension("")))
        .collect();
    for unit in units {
        match unit.ext.as_str() {
            "cue" => {
                if let (Some(base), Ok(text)) = (unit.path.parent(), fs::read_to_string(&unit.path)) {
                    if text.len() <= 256 * 1024 {
                        hidden.extend(cue_files(&text).iter().filter_map(|n| local_target(base, n)).map(|p| lower_key(&p)));
                    }
                }
            }
            "m3u" => hidden.extend(m3u_entries(&unit.path).iter().map(|p| lower_key(p))),
            "bin" if cue_stems.contains(&lower_key(&unit.path.with_extension(""))) => {
                hidden.insert(lower_key(&unit.path));
            }
            _ => {}
        }
    }
    hidden
}

/* ---------------------------------------------------------------------------------------- Cache */

#[derive(Debug, Serialize, Deserialize)]
struct CacheItem {
    size: u64,
    mtime: u64,
    sniff: Sniff,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    version: u32,
    root: String,
    items: HashMap<String, CacheItem>,
}

/// Endungen, deren Prüfergebnis nur von der Datei selbst abhängt (nicht von `.cue`/`.m3u`-Nachbarn).
fn cacheable(unit: &Unit) -> bool {
    unit.kind == Kind::File && !matches!(unit.ext.as_str(), "cue" | "m3u")
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

fn load_cache(file: Option<&Path>, root: &str) -> HashMap<String, CacheItem> {
    let Some(file) = file else { return HashMap::new() };
    let Ok(text) = fs::read_to_string(file) else { return HashMap::new() };
    match serde_json::from_str::<Cache>(&text) {
        Ok(cache) if cache.version == CACHE_VERSION && cache.root == root => cache.items,
        _ => HashMap::new(),
    }
}

fn save_cache(file: Option<&Path>, root: &str, items: HashMap<String, CacheItem>) {
    let Some(file) = file else { return };
    let cache = Cache { version: CACHE_VERSION, root: root.to_string(), items };
    let Ok(text) = serde_json::to_string(&cache) else { return };
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = file.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() && fs::rename(&tmp, file).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/* -------------------------------------------------------------------------------------- Scannen */

/// Durchsucht `root` und erkennt die Spiele darin. `cache_file` darf fehlen (dann wird nichts gemerkt).
pub fn scan(root: &Path, cache_file: Option<&Path>) -> Result<ScanOutput, String> {
    let meta = fs::metadata(root).map_err(|_| format!("Basisordner nicht gefunden: {}", slashed(root)))?;
    if !meta.is_dir() {
        return Err(format!("Das ist kein Ordner: {}", slashed(root)));
    }
    // Bewusst kein canonicalize: Unter Windows ergäbe das Pfade mit `\\?\`-Vorsatz, die weder die Emulatoren noch die
    // Dateizugriffe der Oberfläche mögen.
    let root = root.to_path_buf();
    let root_text = slashed(&root).trim_end_matches('/').to_string();
    let rel_of = |path: &Path| -> String {
        let rel = path.strip_prefix(&root).map(slashed).unwrap_or_else(|_| slashed(path));
        rel.trim_start_matches('/').to_string()
    };

    let mut walk = Walk::default();
    walk.visit(&root, 0, None);

    let hidden = parts_of_other_games(&walk.units);
    let units: Vec<Unit> = walk
        .units
        .into_iter()
        .filter(|u| !(u.kind == Kind::File && hidden.contains(&lower_key(&u.path)) && !matches!(u.ext.as_str(), "m3u")))
        .collect();

    // Inhalt prüfen – mehrere Dateien gleichzeitig, weil Netzlaufwerke vor allem warten
    let old = load_cache(cache_file, &root_text);
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<Sniff>>> = units.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..THREADS.min(units.len().max(1)) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(unit) = units.get(i) else { break };
                let key = rel_of(&unit.path);
                let mtime = if cacheable(unit) { mtime_of(&unit.path) } else { 0 };
                let sniff = match old.get(&key) {
                    Some(item) if cacheable(unit) && item.size == unit.size && item.mtime == mtime => item.sniff.clone(),
                    _ => sniff_path(&unit.path, &unit.ext, unit.kind == Kind::Folder, 0),
                };
                if let Ok(mut slot) = results[i].lock() {
                    *slot = Some(sniff);
                }
            });
        }
    });

    let mut games = Vec::with_capacity(units.len());
    let mut new_cache = HashMap::new();
    for (unit, slot) in units.iter().zip(results) {
        let sniff = slot.into_inner().ok().flatten().unwrap_or_default();
        let name = file_name(&unit.path);
        let rel = rel_of(&unit.path);
        if cacheable(unit) {
            new_cache.insert(rel.clone(), CacheItem { size: unit.size, mtime: mtime_of(&unit.path), sniff: sniff.clone() });
        }
        let (system, how, uncertain, guess, reason) = if unit.kind == Kind::Bundle {
            (None, "none", false, None, "macOS-Programm (startet direkt, ohne Emulator)".to_string())
        } else {
            let v = decide(&sniff, &name, unit.folder.as_ref());
            (v.system, v.how, v.uncertain, v.guess, v.reason)
        };
        games.push(ScannedGame {
            path: slashed(&unit.path),
            rel,
            name,
            kind: unit.kind.as_str(),
            ext: unit.ext.clone(),
            size: unit.size,
            system: system.map(platform_name),
            how,
            uncertain,
            guess: guess.map(platform_name),
            serial: sniff.serial.clone().or_else(|| serial_in(&file_name(&unit.path))),
            title: sniff.title.clone(),
            reason,
        });
    }
    games.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    save_cache(cache_file, &root_text, new_cache);

    let mut images: Vec<String> = walk.images.iter().map(|p| rel_of(p)).collect();
    images.sort();
    Ok(ScanOutput {
        root: root_text,
        games,
        images,
        truncated: walk.truncated,
        unreadable: walk.unreadable,
    })
}

/// `games_scan({ dir }) -> { root, games, images, truncated, unreadable }` – siehe Kopf dieser Datei.
#[tauri::command]
pub async fn games_scan(app: AppHandle, dir: String) -> Result<ScanOutput, String> {
    let root = expand(dir.trim());
    let cache_file = app.path().app_cache_dir().ok().map(|d| d.join(CACHE_FILE));
    tauri::async_runtime::spawn_blocking(move || scan(&root, cache_file.as_deref()))
        .await
        .map_err(|e| format!("Der Scan ist abgebrochen worden ({e})"))?
}

#[cfg(test)]
mod tests;
