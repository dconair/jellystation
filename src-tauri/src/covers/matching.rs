//! Namen vergleichen und das passende Cover in der libretro-Dateiliste finden.
//!
//! Die Dateinamen der Nutzer passen selten exakt auf das Schema der libretro-Thumbnails ("Titel (Region)", nach
//! No-Intro/Redump). Deshalb werden beide Seiten auf eine Vergleichsform gebracht (ohne Klammer-Tags, Akzente,
//! Satzzeichen, Artikel; römische Zahlen als Ziffern) und danach per Token-Überlappung und Editierabstand
//! verglichen. Ein Treffer braucht eine Mindestähnlichkeit, damit nie ein falsches Spiel angezeigt wird; bei
//! Gleichstand entscheiden Region, Sprache und Disc.

/// Bildarten im libretro-Verzeichnis, in der Reihenfolge, in der sie probiert werden.
pub const IMAGE_KINDS: [&str; 3] = ["Named_Boxarts", "Named_Snaps", "Named_Titles"];

/// Darunter ist ein Treffer zu unsicher und wird verworfen.
pub const MIN_SCORE: f64 = 0.75;

/// Endungen, die vom Dateinamen abgeschnitten werden (andere Punkte gehören zum Titel, z. B. "Dr. Mario").
const EXTENSIONS: &[&str] = &[
    "iso", "bin", "cue", "chd", "cso", "ciso", "pbp", "pkg", "gcm", "rvz", "wbfs", "wia", "gcz",
    "dol", "elf", "m3u", "img", "png", "jpg", "jpeg", "webp", "zip", "7z", "rar",
];

/// Regionen, die in den Klammern der No-Intro-/Redump-Namen vorkommen.
const REGIONS: &[&str] = &[
    "usa",
    "europe",
    "world",
    "germany",
    "japan",
    "uk",
    "france",
    "spain",
    "italy",
    "australia",
    "korea",
    "asia",
    "brazil",
    "canada",
    "netherlands",
    "sweden",
    "russia",
    "china",
    "taiwan",
    "hong kong",
    "denmark",
    "norway",
    "finland",
    "portugal",
    "poland",
    "austria",
    "switzerland",
    "greece",
    "scandinavia",
    "latin america",
];

/// Ein Name in Vergleichsform.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Name {
    /// Wörter, klein geschrieben, ohne Akzente und Satzzeichen.
    pub tokens: Vec<String>,
    /// `tokens` mit Leerzeichen verbunden.
    pub key: String,
    /// Nummer aus "(Disc 2)".
    pub disc: Option<u32>,
    /// Regionen aus den Klammern, klein geschrieben.
    pub regions: Vec<String>,
    /// Sprachkürzel aus Klammern wie "(En,Fr,De)".
    pub languages: Vec<String>,
    /// Beta, Demo, Prototyp, Muster …
    pub unwanted: bool,
}

/* ------------------------------------------------------------------------------ Normalisierung */

fn strip_extension(text: &str) -> &str {
    if let Some(dot) = text.rfind('.') {
        let ext = &text[dot + 1..];
        if (2..=5).contains(&ext.len()) && EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
            return &text[..dot];
        }
    }
    text
}

/// Trennt den Titel von seinen Klammer-Tags (`(…)`, `[…]`, `{…}`). Eine Klammer ohne Gegenstück bleibt Text.
fn split_tags(text: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = text.chars().collect();
    let mut title = String::new();
    let mut tags = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let open = chars[i];
        let close = match open {
            '(' => ')',
            '[' => ']',
            '{' => '}',
            _ => {
                title.push(open);
                i += 1;
                continue;
            }
        };
        let mut depth = 0;
        let mut end = None;
        for (j, c) in chars.iter().enumerate().skip(i) {
            if *c == open {
                depth += 1;
            } else if *c == close {
                depth -= 1;
                if depth == 0 {
                    end = Some(j);
                    break;
                }
            }
        }
        match end {
            Some(j) => {
                tags.push(chars[i + 1..j].iter().collect());
                title.push(' ');
                i = j + 1;
            }
            None => {
                title.push(open);
                i += 1;
            }
        }
    }
    (title, tags)
}

fn push_folded(out: &mut String, c: char) {
    match c {
        '\u{0300}'..='\u{036f}' => {} // kombinierende Akzente (macOS liefert Dateinamen zerlegt)
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
        'ç' | 'ć' | 'č' => out.push('c'),
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ě' | 'ę' => out.push('e'),
        'ì' | 'í' | 'î' | 'ï' | 'ī' => out.push('i'),
        'ñ' | 'ń' | 'ň' => out.push('n'),
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => out.push('o'),
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => out.push('u'),
        'ý' | 'ÿ' => out.push('y'),
        'š' | 'ś' => out.push('s'),
        'ž' | 'ź' | 'ż' => out.push('z'),
        'ř' => out.push('r'),
        'ł' => out.push('l'),
        'đ' | 'ď' => out.push('d'),
        'ť' => out.push('t'),
        'ß' => out.push_str("ss"),
        'æ' => out.push_str("ae"),
        'œ' => out.push_str("oe"),
        '&' => out.push_str(" and "),
        // Apostroph: Wort bleibt zusammen ("Tony Hawk's" → "tony hawks")
        '\'' | '’' | '‘' | '`' => {}
        c if c.is_alphanumeric() => out.push(c),
        _ => out.push(' '),
    }
}

fn roman_value(token: &str) -> Option<u32> {
    Some(match token {
        "ii" => 2,
        "iii" => 3,
        "iv" => 4,
        "v" => 5,
        "vi" => 6,
        "vii" => 7,
        "viii" => 8,
        "ix" => 9,
        "x" => 10,
        "xi" => 11,
        "xii" => 12,
        "xiii" => 13,
        "xiv" => 14,
        "xv" => 15,
        "xvi" => 16,
        "xvii" => 17,
        "xviii" => 18,
        "xix" => 19,
        "xx" => 20,
        _ => return None,
    })
}

/// Zerlegt einen Titel (ohne Tags) in Vergleichs-Wörter.
fn tokenize(title: &str) -> Vec<String> {
    let mut folded = String::new();
    for c in title.to_lowercase().chars() {
        push_folded(&mut folded, c);
    }
    let mut tokens: Vec<String> = folded
        .split_whitespace()
        // "The" steht je nach Schreibweise vorn oder als ", The" – es zählt nicht
        .filter(|t| *t != "the")
        .map(str::to_string)
        .collect();
    // Römische Zahlen als Ziffern ("God of War III" = "God of War 3"); das erste Wort bleibt (z. B. "X-Men")
    for token in tokens.iter_mut().skip(1) {
        if let Some(n) = roman_value(token) {
            *token = n.to_string();
        }
    }
    tokens
}

fn disc_number(tag: &str) -> Option<u32> {
    let rest = ["disc", "disk", "cd"]
        .iter()
        .find_map(|p| tag.strip_prefix(p))?
        .trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Bringt einen Datei- oder Spieltitel in Vergleichsform und liest Region, Sprache und Disc aus den Tags.
pub fn parse_name(raw: &str) -> Name {
    let (title, tags) = split_tags(strip_extension(raw.trim()));
    let mut name = Name::default();
    for tag in tags {
        let tag = tag.trim().to_lowercase();
        if let Some(n) = disc_number(&tag) {
            name.disc.get_or_insert(n);
            continue;
        }
        let parts: Vec<&str> = tag
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        if !parts.is_empty() && parts.iter().all(|p| REGIONS.contains(p)) {
            name.regions.extend(parts.iter().map(|p| p.to_string()));
        } else if !parts.is_empty()
            && parts.iter().all(|p| {
                (2..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
            })
        {
            name.languages.extend(parts.iter().map(|p| p.to_string()));
        } else if [
            "beta", "demo", "proto", "sample", "preview", "kiosk", "alpha", "promo", "unl",
            "pirate",
        ]
        .iter()
        .any(|w| tag.contains(w))
        {
            name.unwanted = true;
        }
    }
    name.tokens = tokenize(&title);
    name.key = name.tokens.join(" ");
    name
}

/* ------------------------------------------------------------------------------------ Ähnlichkeit */

fn levenshtein(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            current[j + 1] = (previous[j] + cost)
                .min(previous[j + 1] + 1)
                .min(current[j] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

fn dice(a: &[String], b: &[String]) -> f64 {
    let mut a: Vec<&String> = a.iter().collect();
    let mut b: Vec<&String> = b.iter().collect();
    a.sort();
    a.dedup();
    b.sort();
    b.dedup();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let shared = a.iter().filter(|t| b.binary_search(t).is_ok()).count();
    2.0 * shared as f64 / (a.len() + b.len()) as f64
}

fn numbers(tokens: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = tokens
        .iter()
        .filter(|t| t.bytes().all(|b| b.is_ascii_digit()))
        .map(String::as_str)
        .collect();
    out.sort_unstable();
    out
}

/// Ähnlichkeit zweier Namen von 0 bis 1 (1 = gleiche Vergleichsform).
///
/// Zahlen sind Fortsetzungen: Fehlt eine Zahl auf einer Seite, wird abgewertet; stehen auf beiden Seiten
/// verschiedene Zahlen ("Tekken 4" gegen "Tekken 5"), ist es mit großer Sicherheit ein anderes Spiel.
pub fn similarity(query: &Name, candidate: &Name) -> f64 {
    if query.tokens.is_empty() || candidate.tokens.is_empty() {
        return 0.0;
    }
    if query.key == candidate.key {
        return 1.0;
    }
    let a: Vec<char> = query.key.chars().filter(|c| *c != ' ').collect();
    let b: Vec<char> = candidate.key.chars().filter(|c| *c != ' ').collect();
    // "GranTurismo5" und "Gran Turismo 5"
    if a == b {
        return 0.97;
    }
    let longest = a.len().max(b.len());
    if a.len().abs_diff(b.len()) * 2 > longest {
        return 0.0;
    }
    let edit = 1.0 - levenshtein(&a, &b) as f64 / longest as f64;
    let mut score = (dice(&query.tokens, &candidate.tokens) + edit) / 2.0;

    let (nq, nc) = (numbers(&query.tokens), numbers(&candidate.tokens));
    if nq != nc {
        let subset = |small: &[&str], big: &[&str]| small.iter().all(|n| big.contains(n));
        score *= if nq.is_empty() && number_inside(&candidate.tokens)
            || nc.is_empty() && number_inside(&query.tokens)
        {
            // "Crash Bandicoot - Warped" gegen "Crash Bandicoot 3 - Warped": Der Untertitel macht das Spiel eindeutig
            0.9
        } else if nq.is_empty() || nc.is_empty() || subset(&nq, &nc) || subset(&nc, &nq) {
            0.75
        } else {
            0.55
        };
    }
    score
}

/// Alle Zahlen im Namen stehen vor weiteren Wörtern ("Crash Bandicoot 3 Warped", nicht "Gran Turismo 2").
fn number_inside(tokens: &[String]) -> bool {
    let mut any = false;
    for (i, token) in tokens.iter().enumerate() {
        if token.bytes().all(|b| b.is_ascii_digit()) {
            if i + 1 == tokens.len() {
                return false;
            }
            any = true;
        }
    }
    any
}

/// Rang einer Region für die Wahl bei Gleichstand: kleiner ist besser.
fn region_rank(name: &Name) -> u8 {
    name.regions
        .iter()
        .map(|r| match r.as_str() {
            "germany" | "austria" | "switzerland" => 0,
            "europe" => 1,
            "usa" => 2,
            "world" => 3,
            "uk" | "france" | "spain" | "italy" | "australia" | "netherlands" | "scandinavia" => 4,
            "japan" => 6,
            _ => 5,
        })
        .min()
        .unwrap_or(7)
}

/* ------------------------------------------------------------------------------------- Dateiliste */

/// Ein Treffer in der Dateiliste.
#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    /// Dateiname im Verzeichnis, z. B. `God of War III (USA).png`.
    pub file: String,
    pub score: f64,
}

struct Listed {
    file: String,
    name: Name,
}

/// Die Dateien eines libretro-Verzeichnisses in Vergleichsform.
#[derive(Default)]
pub struct Listing {
    files: Vec<Listed>,
}

impl Listing {
    pub fn from_files<I: IntoIterator<Item = String>>(files: I) -> Listing {
        Listing {
            files: files
                .into_iter()
                .map(|file| {
                    let name = parse_name(&file);
                    Listed { file, name }
                })
                .collect(),
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.files.len()
    }

    /// Bestes Cover für einen der Namen (alle gleichberechtigt). Region, Sprache und Disc der Anfrage steuern die
    /// Wahl zwischen gleich guten Treffern.
    pub fn best_match(&self, queries: &[Name]) -> Option<Match> {
        let wanted_regions: Vec<&String> = queries.iter().flat_map(|q| &q.regions).collect();
        let wanted_disc = queries.iter().find_map(|q| q.disc);

        // Viertel-Prozent-Stufen: Treffer in derselben Stufe gelten als gleich gut.
        type Rank = (std::cmp::Reverse<i64>, u8, u8, u8, u8, u8, usize, String);
        let mut best: Option<(Rank, f64)> = None;
        for query in queries {
            for listed in &self.files {
                let score = similarity(query, &listed.name);
                if score < MIN_SCORE {
                    continue;
                }
                let tier = (score * 400.0).round() as i64;
                let region_hit = listed
                    .name
                    .regions
                    .iter()
                    .any(|r| wanted_regions.contains(&r));
                let german = listed.name.languages.iter().any(|l| l == "de");
                let disc = match (wanted_disc, listed.name.disc) {
                    (Some(w), Some(d)) if w == d => 0,
                    (None, None) | (None, Some(1)) => 0,
                    (_, None) => 1,
                    _ => 2,
                };
                let rank: Rank = (
                    std::cmp::Reverse(tier),
                    u8::from(listed.name.unwanted),
                    u8::from(!region_hit),
                    region_rank(&listed.name),
                    u8::from(!german),
                    disc,
                    listed.file.len(),
                    listed.file.clone(),
                );
                if best.as_ref().is_none_or(|(b, _)| rank < *b) {
                    best = Some((rank, score));
                }
            }
        }
        best.map(|(rank, score)| Match {
            file: rank.7,
            score,
        })
    }
}

/* --------------------------------------------------------------------------- HTML-Verzeichnisliste */

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|e| *e <= 8) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "lt" => Some('<'),
            "gt" => Some('>'),
            _ => entity
                .strip_prefix('#')
                .and_then(|n| match n.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => n.parse().ok(),
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `%20` → Leerzeichen usw. Ungültige Folgen bleiben stehen.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Liest die Bilddateien aus einer HTML-Verzeichnisliste (alle `href`-Ziele, die auf ein Bild zeigen).
pub fn parse_listing_html(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("href=") {
        let start = from + found + 5;
        from = start;
        let rest = &html[start..];
        let value = match rest.chars().next() {
            Some(q @ ('"' | '\'')) => rest[1..].split(q).next().unwrap_or(""),
            Some(_) => rest
                .split(|c: char| c.is_whitespace() || c == '>')
                .next()
                .unwrap_or(""),
            None => break,
        };
        if value.is_empty()
            || value.starts_with(['?', '#', '/'])
            || value.contains("://")
            || value.ends_with('/')
        {
            continue;
        }
        let file = percent_decode(&decode_entities(value));
        let lower_file = file.to_ascii_lowercase();
        let is_image = [".png", ".jpg", ".jpeg"]
            .iter()
            .any(|e| lower_file.ends_with(e));
        if is_image && !file.contains(['/', '\\']) && seen.insert(file.clone()) {
            out.push(file);
        }
    }
    out
}

/* --------------------------------------------------------------------------------------- Adressen */

/// Prozentkodierung eines Pfadsegments (nur A–Z a–z 0–9 `-` `.` `_` `~` bleiben stehen).
pub fn encode_segment(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Adresse der Dateiliste, z. B. `https://thumbnails.libretro.com/Sony%20-%20PlayStation/Named_Boxarts/`.
pub fn listing_url(base: &str, system_dir: &str, kind: &str) -> String {
    format!(
        "{}/{}/{}/",
        base.trim_end_matches('/'),
        encode_segment(system_dir),
        kind
    )
}

/// Adresse eines Bildes im Verzeichnis.
pub fn image_url(base: &str, system_dir: &str, kind: &str, file: &str) -> String {
    format!(
        "{}{}",
        listing_url(base, system_dir, kind),
        encode_segment(file)
    )
}

/// Dateiname, wie libretro ihn für einen Titel anlegt: `& * / : < > ? \ |` werden zu `_`.
pub fn libretro_file_name(title: &str) -> String {
    let cleaned: String = title
        .trim()
        .chars()
        .map(|c| if "&*/:<>?\\|".contains(c) { '_' } else { c })
        .collect();
    format!("{cleaned}.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(files: &[&str]) -> Listing {
        Listing::from_files(files.iter().map(|f| f.to_string()))
    }

    fn best(files: &[&str], query: &str) -> Option<String> {
        names(files)
            .best_match(&[parse_name(query)])
            .map(|m| m.file)
    }

    /* ------------------------------------------------------------- Normalisierung */

    #[test]
    fn titel_ohne_klammern_endung_und_satzzeichen() {
        assert_eq!(parse_name("God of War III (USA)").key, "god of war 3");
        assert_eq!(parse_name("Tekken 5 (Disc 1).iso").key, "tekken 5");
        assert_eq!(
            parse_name("FINAL FANTASY X [SLES-50490]").key,
            "final fantasy 10"
        );
        assert_eq!(
            parse_name("Crash Bandicoot - Warped (Europe)").key,
            "crash bandicoot warped"
        );
        assert_eq!(parse_name("Gran Turismo 5").key, "gran turismo 5");
        assert_eq!(
            parse_name("Tony Hawk's Pro Skater 2").key,
            "tony hawks pro skater 2"
        );
        assert_eq!(parse_name("Ratchet & Clank").key, "ratchet and clank");
        assert_eq!(parse_name("Ratchet _ Clank").key, "ratchet clank");
    }

    #[test]
    fn artikel_und_endungen() {
        assert_eq!(
            parse_name("The Legend of Zelda - The Wind Waker (Europe).gcm").key,
            "legend of zelda wind waker"
        );
        assert_eq!(
            parse_name("Legend of Zelda, The - Wind Waker").key,
            "legend of zelda wind waker"
        );
        // Punkte im Titel bleiben, nur bekannte Endungen fallen weg
        assert_eq!(parse_name("Dr. Mario").key, "dr mario");
        assert_eq!(parse_name("Spiel.v1.02").key, "spiel v1 02");
        assert_eq!(parse_name("  Spiel.ISO ").key, "spiel");
    }

    #[test]
    fn roemische_zahlen() {
        assert_eq!(parse_name("Final Fantasy VII").key, "final fantasy 7");
        assert_eq!(parse_name("Final Fantasy XIII-2").key, "final fantasy 13 2");
        assert_eq!(parse_name("Grand Theft Auto IV").key, "grand theft auto 4");
        // das erste Wort bleibt (X-Men, V Rally)
        assert_eq!(parse_name("X-Men Legends").key, "x men legends");
        assert_eq!(parse_name("Metal Gear Solid V").key, "metal gear solid 5");
    }

    #[test]
    fn akzente_und_unicode() {
        assert_eq!(parse_name("Pokémon Colosseum").key, "pokemon colosseum");
        // macOS liefert zerlegte Zeichen (e + kombinierender Akzent)
        assert_eq!(
            parse_name("Pokemo\u{301}n Colosseum").key,
            "pokemon colosseum"
        );
        assert_eq!(parse_name("Ōkami").key, "okami");
        assert_eq!(parse_name("Gran Turismo® 5").key, "gran turismo 5");
        assert_eq!(
            parse_name("Prince of Persia: Die Sände der Zeit").key,
            "prince of persia die sande der zeit"
        );
    }

    #[test]
    fn tags_region_sprache_disc() {
        let n = parse_name("Final Fantasy VII (Europe) (Disc 2) (En,Fr,De,Es,It)");
        assert_eq!(n.regions, ["europe"]);
        assert_eq!(n.disc, Some(2));
        assert_eq!(n.languages, ["en", "fr", "de", "es", "it"]);
        assert!(!n.unwanted);
        let multi = parse_name("Spiel (USA, Europe)");
        assert_eq!(multi.regions, ["usa", "europe"]);
        assert!(parse_name("Spiel (Beta)").unwanted);
        assert!(parse_name("Spiel (Demo) (USA)").unwanted);
        assert_eq!(parse_name("Spiel (Disk 3)").disc, Some(3));
        assert_eq!(parse_name("Spiel [CD2]").disc, Some(2));
    }

    #[test]
    fn unausgeglichene_klammern_bleiben_text() {
        assert_eq!(parse_name("Spiel (Ohne Ende").key, "spiel ohne ende");
        assert_eq!(parse_name("Spiel ) komisch").key, "spiel komisch");
        assert_eq!(parse_name("").tokens.len(), 0);
        assert_eq!(parse_name("(Nur Tag)").tokens.len(), 0);
    }

    /* ------------------------------------------------------------------ Ähnlichkeit */

    fn sim(a: &str, b: &str) -> f64 {
        similarity(&parse_name(a), &parse_name(b))
    }

    #[test]
    fn gleiche_titel_sind_eins() {
        assert_eq!(
            sim("Gran Turismo 5", "Gran Turismo 5 (Europe) (En,Fr,De,Es,It)"),
            1.0
        );
        assert_eq!(sim("God of War III (USA)", "God of War 3"), 1.0);
        assert_eq!(sim("final fantasy x", "FINAL FANTASY X [SLES-50490]"), 1.0);
    }

    #[test]
    fn leerzeichen_unterschiede_sind_fast_gleich() {
        let s = sim("GranTurismo5", "Gran Turismo 5");
        assert!(s > 0.9 && s < 1.0, "{s}");
    }

    #[test]
    fn andere_nummer_ist_anderes_spiel() {
        for (a, b) in [
            ("Tekken 4", "Tekken 5"),
            ("Gran Turismo 4", "Gran Turismo 5"),
            ("Final Fantasy VII", "Final Fantasy VIII"),
            ("God of War II", "God of War III"),
        ] {
            assert!(sim(a, b) < MIN_SCORE, "{a} / {b}: {}", sim(a, b));
        }
    }

    #[test]
    fn fehlende_schlussnummer_ist_kein_treffer() {
        assert!(sim("Gran Turismo", "Gran Turismo 2") < MIN_SCORE);
        assert!(sim("Ridge Racer", "Ridge Racer 2") < MIN_SCORE);
        assert!(sim("Tekken", "Tekken 3") < MIN_SCORE);
    }

    #[test]
    fn fehlende_nummer_vor_untertitel_ist_ein_treffer() {
        // US-Titel ohne die 3, europäischer Titel mit
        assert!(
            sim(
                "Crash Bandicoot - Warped (Europe)",
                "Crash Bandicoot 3 - Warped (Europe)"
            ) >= MIN_SCORE
        );
        assert!(
            sim(
                "Ratchet & Clank - Going Commando",
                "Ratchet & Clank 2 - Going Commando"
            ) >= MIN_SCORE
        );
    }

    #[test]
    fn tippfehler_und_kleine_abweichungen() {
        assert!(sim("Gran Turismo 5", "Gran Turismo 5 Prologue") < MIN_SCORE);
        assert!(
            sim(
                "Resident Evil Code Veronica X",
                "Resident Evil - Code Veronica X"
            ) >= MIN_SCORE
        );
        assert!(sim("Metal Gear Solid", "Metal Gear Solid 2") < MIN_SCORE);
        assert!(sim("Gran Turismo 5", "Gran Tursimo 5") >= MIN_SCORE);
    }

    #[test]
    fn voellig_verschiedene_titel() {
        assert!(sim("Pixel Pilot", "God of War III") < 0.3);
        assert_eq!(sim("", "God of War"), 0.0);
        assert_eq!(sim("(Beta)", "(Beta)"), 0.0);
    }

    /* ---------------------------------------------------------------- Listensuche */

    const PS2: &[&str] = &[
        "Final Fantasy X (Europe) (En,Fr,De,Es,It).png",
        "Final Fantasy X (USA).png",
        "Final Fantasy X (Japan).png",
        "Final Fantasy X-2 (Europe) (En,Fr,De,Es,It).png",
        "Final Fantasy XII (Europe) (En,Fr,De,Es,It).png",
        "Tekken 4 (Europe).png",
        "Tekken 5 (Europe) (En,Fr,De,Es,It).png",
        "Tekken 5 (USA).png",
        "Tekken Tag Tournament (Europe).png",
        "Gran Turismo 4 (Europe) (En,Fr,De,Es,It,Pt,Nl,Sv,No,Da,Fi).png",
        "God of War (Europe) (En,Fr,De,Es,It).png",
        "God of War II (Europe) (En,Fr,De,Es,It).png",
    ];

    #[test]
    fn bester_treffer_in_der_liste() {
        assert_eq!(
            best(PS2, "FINAL FANTASY X [SLES-50490]").as_deref(),
            Some("Final Fantasy X (Europe) (En,Fr,De,Es,It).png")
        );
        assert_eq!(
            best(PS2, "Final Fantasy X-2").as_deref(),
            Some("Final Fantasy X-2 (Europe) (En,Fr,De,Es,It).png")
        );
        assert_eq!(
            best(PS2, "Final Fantasy XII").as_deref(),
            Some("Final Fantasy XII (Europe) (En,Fr,De,Es,It).png")
        );
        assert_eq!(
            best(PS2, "God of War II").as_deref(),
            Some("God of War II (Europe) (En,Fr,De,Es,It).png")
        );
        assert_eq!(
            best(PS2, "God of War").as_deref(),
            Some("God of War (Europe) (En,Fr,De,Es,It).png")
        );
    }

    #[test]
    fn kein_falscher_treffer() {
        assert_eq!(best(PS2, "Gran Turismo 5"), None);
        assert_eq!(best(PS2, "Pixel Pilot"), None);
        assert_eq!(best(PS2, "Tekken 6"), None);
        assert_eq!(best(PS2, ""), None);
        assert_eq!(best(&[], "Tekken 5"), None);
    }

    #[test]
    fn region_der_anfrage_gewinnt_bei_gleichstand() {
        assert_eq!(
            best(PS2, "Tekken 5 (USA).iso").as_deref(),
            Some("Tekken 5 (USA).png")
        );
        assert_eq!(
            best(PS2, "Tekken 5 (Europe).iso").as_deref(),
            Some("Tekken 5 (Europe) (En,Fr,De,Es,It).png")
        );
        assert_eq!(
            best(PS2, "Final Fantasy X (Japan)").as_deref(),
            Some("Final Fantasy X (Japan).png")
        );
    }

    #[test]
    fn ohne_region_zuerst_europa_dann_usa_dann_welt() {
        let usa_world = ["Spiel (World).png", "Spiel (USA).png", "Spiel (Japan).png"];
        assert_eq!(
            best(&usa_world, "Spiel").as_deref(),
            Some("Spiel (USA).png")
        );
        let eu = ["Spiel (USA).png", "Spiel (Europe).png", "Spiel (Japan).png"];
        assert_eq!(best(&eu, "Spiel").as_deref(), Some("Spiel (Europe).png"));
        let germany = [
            "Spiel (Europe).png",
            "Spiel (Germany).png",
            "Spiel (USA).png",
        ];
        assert_eq!(
            best(&germany, "Spiel").as_deref(),
            Some("Spiel (Germany).png")
        );
        let japan_only = ["Spiel (Japan).png"];
        assert_eq!(
            best(&japan_only, "Spiel").as_deref(),
            Some("Spiel (Japan).png")
        );
    }

    #[test]
    fn deutsche_sprache_vor_anderen_bei_gleicher_region() {
        let files = [
            "Spiel (Europe) (En,Fr).png",
            "Spiel (Europe) (En,Fr,De).png",
        ];
        assert_eq!(
            best(&files, "Spiel").as_deref(),
            Some("Spiel (Europe) (En,Fr,De).png")
        );
    }

    #[test]
    fn beta_und_demo_nur_zur_not() {
        let files = ["Spiel (USA) (Beta).png", "Spiel (USA).png"];
        assert_eq!(best(&files, "Spiel").as_deref(), Some("Spiel (USA).png"));
        let only_demo = ["Spiel (USA) (Demo).png"];
        assert_eq!(
            best(&only_demo, "Spiel").as_deref(),
            Some("Spiel (USA) (Demo).png")
        );
    }

    #[test]
    fn disc_wird_beruecksichtigt() {
        let files = [
            "Final Fantasy VII (Europe) (Disc 1).png",
            "Final Fantasy VII (Europe) (Disc 2).png",
            "Final Fantasy VII (Europe) (Disc 3).png",
        ];
        assert_eq!(
            best(&files, "Final Fantasy VII (Disc 2).chd").as_deref(),
            Some(files[1])
        );
        assert_eq!(best(&files, "Final Fantasy VII").as_deref(), Some(files[0]));
        // Es gibt nur ein Bild für alle Discs
        let single = ["Final Fantasy VII (Europe).png"];
        assert_eq!(
            best(&single, "Final Fantasy VII (Disc 3)").as_deref(),
            Some(single[0])
        );
    }

    #[test]
    fn mehrere_namen_der_beste_gewinnt() {
        let listing = names(PS2);
        let queries = [parse_name("Spielstand 7"), parse_name("Gran Turismo 4")];
        let hit = listing.best_match(&queries).unwrap();
        assert!(hit.file.starts_with("Gran Turismo 4"));
        assert!(hit.score >= MIN_SCORE);
    }

    #[test]
    fn grosse_liste_ist_schnell_genug() {
        let files: Vec<String> = (0..12_000)
            .map(|i| format!("Beispielspiel Nummer {i} - Die Rückkehr (Europe).png"))
            .collect();
        let listing = Listing::from_files(files);
        assert_eq!(listing.len(), 12_000);
        let started = std::time::Instant::now();
        let hit = listing
            .best_match(&[parse_name("Beispielspiel Nummer 4711 - Die Rückkehr")])
            .unwrap();
        assert_eq!(
            hit.file,
            "Beispielspiel Nummer 4711 - Die Rückkehr (Europe).png"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    /* ----------------------------------------------------- HTML-Liste und Adressen */

    #[test]
    fn html_liste_nginx() {
        let html = "<html><head><title>Index of /Sony - PlayStation 3/Named_Boxarts/</title></head><body>\r\n<h1>Index</h1><hr><pre><a href=\"../\">../</a>\r\n\
<a href=\"God%20of%20War%20III%20%28USA%29.png\">God of War III (USA).png</a>      01-Jan-2024 00:00   92341\r\n\
<a href=\"Ratchet%20%26%20Clank%20Future.png\">Ratchet &amp; Clank Future.png</a>      01-Jan-2024 00:00   92341\r\n\
<a href=\"Tony%20Hawk%27s%20Pro.png\">x</a>\r\n\
<a href=\"Gran Turismo 5 (Europe).png\">y</a>\r\n\
<a href='Einfach.jpg'>z</a><a href=Ohne.png>q</a>\r\n\
<a href=\"?C=N;O=D\">Name</a><a href=\"/\">Root</a><a href=\"https://evil.example/x.png\">x</a><a href=\"Unterordner/\">u</a>\r\n\
<a href=\"readme.txt\">r</a><a href=\"God%20of%20War%20III%20%28USA%29.png\">doppelt</a><a href=\"a/b.png\">pfad</a></pre></body></html>";
        let files = parse_listing_html(html);
        assert_eq!(
            files,
            [
                "God of War III (USA).png",
                "Ratchet & Clank Future.png",
                "Tony Hawk's Pro.png",
                "Gran Turismo 5 (Europe).png",
                "Einfach.jpg",
                "Ohne.png"
            ]
        );
    }

    #[test]
    fn html_liste_leer_oder_kaputt() {
        assert!(parse_listing_html("").is_empty());
        assert!(parse_listing_html("<html>404</html>").is_empty());
        assert!(parse_listing_html("<a href=").is_empty());
        assert!(parse_listing_html("<a href=\"offen.png").len() <= 1);
        assert!(parse_listing_html("href=href=href=").is_empty());
    }

    #[test]
    fn html_entitaeten_und_prozentkodierung() {
        assert_eq!(
            decode_entities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27;"),
            "a & b <c> \"d\" 'e'"
        );
        assert_eq!(decode_entities("&unbekannt; &amp"), "&unbekannt; &amp");
        assert_eq!(percent_decode("a%20b%28c%29%C3%A9"), "a b(c)é");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }

    #[test]
    fn adressen() {
        assert_eq!(
            listing_url(
                "https://thumbnails.libretro.com",
                "Sony - PlayStation 3",
                "Named_Boxarts"
            ),
            "https://thumbnails.libretro.com/Sony%20-%20PlayStation%203/Named_Boxarts/"
        );
        assert_eq!(
            image_url("https://thumbnails.libretro.com/", "Sony - PlayStation 2", "Named_Snaps", "Tekken 5 (USA).png"),
            "https://thumbnails.libretro.com/Sony%20-%20PlayStation%202/Named_Snaps/Tekken%205%20%28USA%29.png"
        );
        // Zeichen, die in Adressen etwas bedeuten, werden kodiert
        let url = image_url(
            "http://127.0.0.1:1",
            "Nintendo - Wii",
            "Named_Boxarts",
            "a/../b?c#d&e.png",
        );
        assert!(
            !url["http://127.0.0.1:1/Nintendo%20-%20Wii/Named_Boxarts/".len()..]
                .contains(['/', '?', '#', '&'])
        );
    }

    #[test]
    fn dateiname_wie_bei_libretro() {
        assert_eq!(
            libretro_file_name("God of War III (USA)"),
            "God of War III (USA).png"
        );
        assert_eq!(
            libretro_file_name("Ratchet & Clank: Size Matters"),
            "Ratchet _ Clank_ Size Matters.png"
        );
        assert_eq!(
            libretro_file_name("A/B\\C*D?E<F>G|H"),
            "A_B_C_D_E_F_G_H.png"
        );
        assert_eq!(libretro_file_name("  Spiel  "), "Spiel.png");
    }
}
