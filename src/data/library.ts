import type { XmbCategory, XmbEntry } from "./types";

const entry = (
  id: string,
  title: string,
  subtitle: string,
  hue: number,
  description = "",
): XmbEntry => ({ id, title, subtitle, hue, description });

// Platzhalter-Daten – später durch echte Bibliotheksdaten (z. B. Jellyfin) ersetzen.
export const categories: XmbCategory[] = [
  {
    id: "search",
    label: "Suche",
    icon: "search",
    entries: [
      entry("search-all", "Gesamte Bibliothek durchsuchen", "Titel, Personen, Genres", 210),
      entry("search-recent", "Zuletzt gesucht", "Verlauf", 190),
      entry("search-genre", "Nach Genre stöbern", "Action, Drama, Komödie …", 230),
    ],
  },
  {
    id: "movies",
    label: "Filme",
    icon: "movies",
    entries: [
      entry("m1", "Blade Runner 2049", "2017 · Science-Fiction", 28, "Ein junger Blade Runner stößt auf ein lange verborgenes Geheimnis."),
      entry("m2", "Das Fünfte Element", "1997 · Science-Fiction", 350, "Im 23. Jahrhundert hängt das Schicksal der Erde an einem Taxifahrer."),
      entry("m3", "Der Pate", "1972 · Drama", 8, "Der Aufstieg einer Mafia-Familie in New York."),
      entry("m4", "Das Boot", "1981 · Kriegsfilm", 195, "Ein deutsches U-Boot im Atlantik, 1941."),
      entry("m5", "Interstellar", "2014 · Science-Fiction", 220, "Eine Reise durch ein Wurmloch auf der Suche nach einer neuen Heimat."),
      entry("m6", "Pulp Fiction", "1994 · Krimi", 45, "Verschlungene Geschichten aus der Unterwelt von Los Angeles."),
      entry("m7", "Die Verurteilten", "1994 · Drama", 160, "Zwei Häftlinge finden über Jahre Trost und Hoffnung."),
      entry("m8", "Matrix", "1999 · Science-Fiction", 125, "Ein Hacker entdeckt die wahre Natur seiner Realität."),
      entry("m9", "Alien", "1979 · Horror", 150, "Im Weltall hört dich niemand schreien."),
    ],
  },
  {
    id: "series",
    label: "Serien",
    icon: "series",
    entries: [
      entry("s1", "Breaking Bad", "5 Staffeln · Drama", 120, "Ein Chemielehrer steigt in die Drogenproduktion ein."),
      entry("s2", "Dark", "3 Staffeln · Mystery", 215, "Das Verschwinden eines Kindes erschüttert eine Kleinstadt."),
      entry("s3", "The Expanse", "6 Staffeln · Science-Fiction", 265, "Ein Komplott im Sonnensystem steht kurz vor dem Krieg."),
      entry("s4", "Stranger Things", "4 Staffeln · Fantasy", 345, "Seltsame Dinge geschehen in Hawkins, Indiana."),
      entry("s5", "Better Call Saul", "6 Staffeln · Drama", 38, "Die Geschichte eines kleinen Anwalts mit großen Plänen."),
      entry("s6", "Star Trek: Strange New Worlds", "3 Staffeln · Science-Fiction", 200, "Captain Pike und die Crew der Enterprise."),
    ],
  },
  {
    id: "music",
    label: "Musik",
    icon: "music",
    entries: [
      entry("mu1", "Zuletzt gespielt", "Wiedergabeliste", 300),
      entry("mu2", "Alben", "148 Alben", 280),
      entry("mu3", "Interpreten", "92 Interpreten", 320),
      entry("mu4", "Wiedergabelisten", "12 Listen", 250),
      entry("mu5", "Zufallswiedergabe", "Alle Titel mischen", 335),
    ],
  },
  {
    id: "photos",
    label: "Fotos",
    icon: "photos",
    entries: [
      entry("p1", "Urlaub 2025", "312 Fotos", 175),
      entry("p2", "Familie", "1 204 Fotos", 20),
      entry("p3", "Bildschirmfotos", "86 Fotos", 240),
      entry("p4", "Diashow starten", "Alle Fotos", 55),
    ],
  },
  {
    id: "livetv",
    label: "Live-TV",
    icon: "livetv",
    entries: [
      entry("tv1", "Programmführer", "Heute und morgen", 205),
      entry("tv2", "Senderliste", "64 Sender", 185),
      entry("tv3", "Aufnahmen", "7 Aufnahmen", 5),
      entry("tv4", "Geplante Aufnahmen", "3 Timer", 35),
    ],
  },
  {
    id: "settings",
    label: "Einstellungen",
    icon: "settings",
    entries: [
      entry("st1", "Server", "Verbindung verwalten", 225),
      entry("st2", "Benutzer", "Profil wechseln", 255),
      entry("st3", "Anzeige", "Vollbild, Skalierung", 195),
      entry("st4", "Ton", "Ausgabegerät und Lautstärke", 170),
      entry("st5", "Über JellyStation", "Version 0.1.0", 280),
    ],
  },
];
