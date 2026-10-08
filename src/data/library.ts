import { APP_COMMIT_SUBJECT, APP_VERSION_LABEL } from "../version";
import type { XmbCategory, XmbEntry } from "./types";

const entry = (
  id: string,
  title: string,
  subtitle: string,
  hue: number,
  description = "",
): XmbEntry => ({ id, title, subtitle, hue, description });

/** Demo-Cover: Filme/Serien als Poster (2:3), Musik/Fotos/Live-TV quer (16:9); das Cover entsteht prozedural. */
const withArt = (e: XmbEntry, artShape: "poster" | "landscape"): XmbEntry => ({
  ...e,
  art: { kind: "generated" },
  artShape,
});
const poster = (e: XmbEntry) => withArt(e, "poster");
const landscape = (e: XmbEntry) => withArt(e, "landscape");

/** Aktueller Commit-Betreff + Update-Hinweis für die Detailkarte von "Über JellyStation". */
const aboutDescription = [
  APP_COMMIT_SUBJECT && (/[.!?]$/.test(APP_COMMIT_SUBJECT) ? APP_COMMIT_SUBJECT : `${APP_COMMIT_SUBJECT}.`),
  "Aktualisieren: im Terminal  jellystation  eingeben.",
]
  .filter(Boolean)
  .join(" ");

// Demo-Daten: erscheinen, solange kein Jellyfin-Server erreichbar ist (Filme/Serien werden dann durch echte ersetzt).
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
      poster(entry("m1", "Blade Runner 2049", "2017 · Science-Fiction", 28, "Ein junger Blade Runner stößt auf ein lange verborgenes Geheimnis.")),
      poster(entry("m2", "Das Fünfte Element", "1997 · Science-Fiction", 350, "Im 23. Jahrhundert hängt das Schicksal der Erde an einem Taxifahrer.")),
      poster(entry("m3", "Der Pate", "1972 · Drama", 8, "Der Aufstieg einer Mafia-Familie in New York.")),
      poster(entry("m4", "Das Boot", "1981 · Kriegsfilm", 195, "Ein deutsches U-Boot im Atlantik, 1941.")),
      poster(entry("m5", "Interstellar", "2014 · Science-Fiction", 220, "Eine Reise durch ein Wurmloch auf der Suche nach einer neuen Heimat.")),
      poster(entry("m6", "Pulp Fiction", "1994 · Krimi", 45, "Verschlungene Geschichten aus der Unterwelt von Los Angeles.")),
      poster(entry("m7", "Die Verurteilten", "1994 · Drama", 160, "Zwei Häftlinge finden über Jahre Trost und Hoffnung.")),
      poster(entry("m8", "Matrix", "1999 · Science-Fiction", 125, "Ein Hacker entdeckt die wahre Natur seiner Realität.")),
      poster(entry("m9", "Alien", "1979 · Horror", 150, "Im Weltall hört dich niemand schreien.")),
    ],
  },
  {
    id: "series",
    label: "Serien",
    icon: "series",
    entries: [
      poster(entry("s1", "Breaking Bad", "5 Staffeln · Drama", 120, "Ein Chemielehrer steigt in die Drogenproduktion ein.")),
      poster(entry("s2", "Dark", "3 Staffeln · Mystery", 215, "Das Verschwinden eines Kindes erschüttert eine Kleinstadt.")),
      poster(entry("s3", "The Expanse", "6 Staffeln · Science-Fiction", 265, "Ein Komplott im Sonnensystem steht kurz vor dem Krieg.")),
      poster(entry("s4", "Stranger Things", "4 Staffeln · Fantasy", 345, "Seltsame Dinge geschehen in Hawkins, Indiana.")),
      poster(entry("s5", "Better Call Saul", "6 Staffeln · Drama", 38, "Die Geschichte eines kleinen Anwalts mit großen Plänen.")),
      poster(entry("s6", "Star Trek: Strange New Worlds", "3 Staffeln · Science-Fiction", 200, "Captain Pike und die Crew der Enterprise.")),
    ],
  },
  {
    id: "music",
    label: "Musik",
    icon: "music",
    entries: [
      landscape(entry("mu1", "Zuletzt gespielt", "Wiedergabeliste", 300)),
      landscape(entry("mu2", "Alben", "148 Alben", 280)),
      landscape(entry("mu3", "Interpreten", "92 Interpreten", 320)),
      landscape(entry("mu4", "Wiedergabelisten", "12 Listen", 250)),
      landscape(entry("mu5", "Zufallswiedergabe", "Alle Titel mischen", 335)),
    ],
  },
  {
    id: "photos",
    label: "Fotos",
    icon: "photos",
    entries: [
      landscape(entry("p1", "Urlaub 2025", "312 Fotos", 175)),
      landscape(entry("p2", "Familie", "1 204 Fotos", 20)),
      landscape(entry("p3", "Bildschirmfotos", "86 Fotos", 240)),
      landscape(entry("p4", "Diashow starten", "Alle Fotos", 55)),
    ],
  },
  {
    id: "livetv",
    label: "Live-TV",
    icon: "livetv",
    entries: [
      landscape(entry("tv1", "Programmführer", "Heute und morgen", 205)),
      landscape(entry("tv2", "Senderliste", "64 Sender", 185)),
      landscape(entry("tv3", "Aufnahmen", "7 Aufnahmen", 5)),
      landscape(entry("tv4", "Geplante Aufnahmen", "3 Timer", 35)),
    ],
  },
  {
    id: "settings",
    label: "Einstellungen",
    icon: "settings",
    entries: [
      entry("st1", "Server", "Verbindung verwalten", 225),
      entry("st-games", "Spiele-Ordner", "Nicht gewählt", 90),
      {
        ...entry("st-emu", "Emulatoren", "Installieren, finden, Pfad wählen", 20, "Zeigt, welche Emulatoren gefunden wurden, und hilft beim Installieren."),
        action: "open-emulators",
      },
      {
        ...entry("st2", "Jellyfin-Benutzer", "Wer schaut?", 255, "Wählt den Jellyfin-Benutzer für Wiedergabestatus und „Weiterschauen“."),
        action: "choose-jellyfin-user",
      },
      {
        ...entry("st-transcode", "Wiedergabe", "Direkt, wenn möglich", 175, "Wählt, ob der Player Dateien direkt abspielt oder der Jellyfin-Server alles umwandelt (HLS). „Immer umwandeln“ hilft bei Formaten, die dein Mac nicht abspielen kann."),
        action: "toggle-transcode",
      },
      entry("st3", "Anzeige", "Vollbild, Skalierung", 195),
      entry("st4", "Ton", "Ausgabegerät und Lautstärke", 170),
      { ...entry("st-setup", "Einrichtung erneut ausführen", "Jellyfin, Ordner, Controller", 150, "Startet den Setup-Assistenten mit deinen aktuellen Werten."), action: "run-setup" },
      entry("st5", "Über JellyStation", `Version ${APP_VERSION_LABEL}`, 280, aboutDescription),
    ],
  },
];
