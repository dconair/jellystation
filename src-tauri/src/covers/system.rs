//! Spielsysteme: Zuordnung von Ordnernamen zu Plattformen, Namen im libretro-Verzeichnis und Cache-Ordnern.

/// Die Systeme, für die es Cover gibt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    Ps1,
    Ps2,
    Ps3,
    Ps4,
    Psp,
    GameCube,
    Wii,
}

impl Platform {
    /// Verzeichnisname bei thumbnails.libretro.com.
    pub fn libretro_dir(self) -> &'static str {
        match self {
            Platform::Ps1 => "Sony - PlayStation",
            Platform::Ps2 => "Sony - PlayStation 2",
            Platform::Ps3 => "Sony - PlayStation 3",
            Platform::Ps4 => "Sony - PlayStation 4",
            Platform::Psp => "Sony - PlayStation Portable",
            Platform::GameCube => "Nintendo - GameCube",
            Platform::Wii => "Nintendo - Wii",
        }
    }

    /// Ordnername, unter dem das System in der Spielebibliothek erscheint (gleichzeitig der Name, den der
    /// Emulator-Katalog im Frontend kennt).
    pub fn folder_name(self) -> &'static str {
        match self {
            Platform::Ps1 => "PS1",
            Platform::Ps2 => "PS2",
            Platform::Ps3 => "PS3",
            Platform::Ps4 => "PS4",
            Platform::Psp => "PSP",
            Platform::GameCube => "GameCube",
            Platform::Wii => "Wii",
        }
    }

    /// Erkennt das System am Namen des Systemordners (`PS3`, `PlayStation 2`, `GameCube` …).
    pub fn from_folder(name: &str) -> Option<Platform> {
        let key: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        match key.as_str() {
            "ps1" | "psx" | "psone" | "playstation" | "playstation1" | "sonyplaystation" => {
                Some(Platform::Ps1)
            }
            "ps2" | "playstation2" | "sonyplaystation2" => Some(Platform::Ps2),
            "ps3" | "playstation3" | "sonyplaystation3" => Some(Platform::Ps3),
            "ps4" | "playstation4" | "sonyplaystation4" => Some(Platform::Ps4),
            "psp" | "playstationportable" | "sonyplaystationportable" => Some(Platform::Psp),
            "gc" | "ngc" | "gamecube" | "nintendogamecube" => Some(Platform::GameCube),
            "wii" | "nintendowii" => Some(Platform::Wii),
            _ => None,
        }
    }
}

/// Titelnummern (vier Buchstaben) der PS4-Spiele: `CUSA` überall, die übrigen in Asien. Die Vita (`PCSA`, `PCSE` …)
/// und die PS3 teilen sich keines davon.
const PS4_PREFIXES: &[&str] = &["CUSA", "PCAS", "PCJS", "PCKS", "PLAS", "PLJS", "PLJM", "PLKS"];

/// Ist das die Titelnummer eines PS4-Spiels (`CUSA00419`)? Groß-/Kleinschreibung egal, mit oder ohne Bindestrich.
pub fn is_ps4_title_id(id: &str) -> bool {
    let id = id.trim();
    id.get(..4).is_some_and(|prefix| {
        PS4_PREFIXES.iter().any(|p| p.eq_ignore_ascii_case(prefix))
    }) && id[4..].trim_start_matches(['-', '_']).chars().take(5).filter(char::is_ascii_digit).count() == 5
}

/// Ordnername im Cache: nur Kleinbuchstaben, Ziffern und `-`, nie leer – damit sich aus einem Systemnamen
/// kein Pfad (`..`, `/`) bauen lässt.
pub fn cache_slug(system: &str) -> String {
    let mut slug = String::new();
    for c in system.chars() {
        if slug.len() >= 40 {
            break;
        }
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "system".into()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordnernamen_werden_erkannt() {
        for (name, expected) in [
            ("PS1", Platform::Ps1),
            ("psx", Platform::Ps1),
            ("PlayStation", Platform::Ps1),
            ("PS2", Platform::Ps2),
            ("PlayStation 2", Platform::Ps2),
            ("Sony - PlayStation 2", Platform::Ps2),
            ("PS3", Platform::Ps3),
            ("playstation3", Platform::Ps3),
            ("PS4", Platform::Ps4),
            ("PlayStation 4", Platform::Ps4),
            ("Sony - PlayStation 4", Platform::Ps4),
            ("PSP", Platform::Psp),
            ("PlayStation Portable", Platform::Psp),
            ("GameCube", Platform::GameCube),
            ("Nintendo GameCube", Platform::GameCube),
            ("NGC", Platform::GameCube),
            ("Wii", Platform::Wii),
        ] {
            assert_eq!(Platform::from_folder(name), Some(expected), "{name}");
        }
        for name in ["", "Switch", "Xbox", "PS5", "Pixel Pilot"] {
            assert_eq!(Platform::from_folder(name), None, "{name}");
        }
    }

    #[test]
    fn ordnernamen_der_bibliothek_werden_wieder_erkannt() {
        for p in [
            Platform::Ps1,
            Platform::Ps2,
            Platform::Ps3,
            Platform::Ps4,
            Platform::Psp,
            Platform::GameCube,
            Platform::Wii,
        ] {
            assert_eq!(Platform::from_folder(p.folder_name()), Some(p));
        }
    }

    #[test]
    fn verzeichnisnamen_bei_libretro() {
        assert_eq!(Platform::Ps1.libretro_dir(), "Sony - PlayStation");
        assert_eq!(Platform::Ps2.libretro_dir(), "Sony - PlayStation 2");
        assert_eq!(Platform::Ps3.libretro_dir(), "Sony - PlayStation 3");
        assert_eq!(Platform::Ps4.libretro_dir(), "Sony - PlayStation 4");
        assert_eq!(Platform::Psp.libretro_dir(), "Sony - PlayStation Portable");
        assert_eq!(Platform::GameCube.libretro_dir(), "Nintendo - GameCube");
        assert_eq!(Platform::Wii.libretro_dir(), "Nintendo - Wii");
    }

    #[test]
    fn titelnummern_der_ps4() {
        for id in ["CUSA00419", "cusa00419", "CUSA-00419", "PCAS00012", "CUSA00419_00"] {
            assert!(is_ps4_title_id(id), "{id}");
        }
        // PS3, PSP, Vita, zu kurz, zu wenige Ziffern
        for id in ["BLUS30443", "ULES00821", "PCSE00120", "CUSA", "CUSA123", "", "ÄÖÜÄ12345"] {
            assert!(!is_ps4_title_id(id), "{id}");
        }
    }

    #[test]
    fn cache_ordner_ist_nie_ein_pfad() {
        assert_eq!(cache_slug("PS3"), "ps3");
        assert_eq!(cache_slug("Sony - PlayStation 2"), "sony-playstation-2");
        for evil in [
            "../..",
            "../../etc",
            "/etc/passwd",
            "a/../b",
            "..",
            ".",
            "",
            "\\..\\x",
            "ß/ü",
        ] {
            let slug = cache_slug(evil);
            assert!(!slug.contains(['/', '\\', '.']), "{evil} → {slug}");
            assert!(!slug.is_empty());
            assert!(slug.len() <= 41);
        }
        assert_eq!(cache_slug("../.."), "system");
        assert!(cache_slug(&"x".repeat(500)).len() <= 40);
    }
}
