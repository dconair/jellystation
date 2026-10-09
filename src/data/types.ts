export interface XmbEntry {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  /** Farbton (0–360) für die Platzhalter-Kachel. */
  hue: number;
  /** Gesetzt bei Spielen: wird beim Bestätigen im Emulator gestartet. */
  game?: GameRef;
  /** Interne Aktion statt Inhalt (Einstellungen-Spalte). */
  action?: EntryAction;
  /** Gesetzt bei Jellyfin-Filmen, -Serien und -Folgen: Grundlage für Wiedergabe und Fortsetzen. */
  jellyfin?: JellyfinRef;
  /** Cover/Game-Art. Fehlt sie, zeigt die XMB ein einfaches Icon-Kachel (z. B. bei Einstellungen). */
  art?: ArtSource;
  /** Seitenverhältnis des Originalbilds: "landscape" ≈ 16:9 (Game-Art), "poster" ≈ 2:3 (Film-Cover). */
  artShape?: "landscape" | "poster";
}

/** Interne Aktionen, die ein Eintrag statt eines Inhalts auslöst. */
export type EntryAction = "run-setup" | "open-emulators" | "choose-jellyfin-user" | "toggle-transcode" | "open-requirements" | "open-display-settings" | "open-motion-settings" | "open-sound-settings" | "open-covers";

/** Verweis auf ein Jellyfin-Objekt (Film, Serie oder Folge). */
export interface JellyfinRef {
  /** Jellyfin-ID (ohne "jf/"-Präfix). */
  id: string;
  type: "Movie" | "Series" | "Episode";
  /** Gesamtlaufzeit in Jellyfin-Ticks (1 Tick = 100 ns; 10 000 000 = 1 s). */
  runTimeTicks?: number;
  /** Gespeicherte Wiedergabeposition (UserData.PlaybackPositionTicks); fehlt/0 = nicht begonnen. */
  resumeTicks?: number;
  /** Schon gesehen. */
  played?: boolean;
  /** Nur bei Folgen: zugehörige Serie, Staffel- und Folgennummer. */
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** Woher das Cover eines Eintrags kommt. */
export type ArtSource =
  /** Lokale Bilddatei (Tauri-FS, z. B. neben dem Spiel). */
  | { kind: "file"; path: string }
  /** Bild über HTTP (z. B. Jellyfin); Header z. B. für die Anmeldung. */
  | { kind: "http"; url: string; headers?: Record<string, string> }
  /** Prozedural erzeugtes Platzhalter-Cover (Demo-Daten, fehlende Bilder). */
  | { kind: "generated" };

export type CategoryIconName =
  | "search"
  | "movies"
  | "series"
  | "music"
  | "photos"
  | "livetv"
  | "games"
  | "settings";

export interface XmbCategory {
  id: string;
  label: string;
  icon: CategoryIconName;
  entries: XmbEntry[];
}

/** Verweis auf eine lokale Spieldatei. */
export interface GameRef {
  /** Name des System-Ordners, z. B. "PS3". */
  system: string;
  /** Absoluter Pfad zur Spieldatei. */
  path: string;
  /** true bei Demo-Daten – es wird nichts wirklich gestartet. */
  mock: boolean;
}
