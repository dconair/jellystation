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
  /** Gesetzt bei Titeln aus einem Stremio-Addon: Grundlage für Stream-Suche und Wiedergabe. */
  stremio?: StremioRef;
  /** Cover/Game-Art. Fehlt sie, zeigt die XMB ein einfaches Icon-Kachel (z. B. bei Einstellungen). */
  art?: ArtSource;
  /** Seitenverhältnis des Originalbilds: "landscape" ≈ 16:9 (Game-Art), "poster" ≈ 2:3 (Film-Cover). */
  artShape?: "landscape" | "poster";
}

/** Interne Aktionen, die ein Eintrag statt eines Inhalts auslöst. */
export type EntryAction = "run-setup" | "open-emulators" | "choose-jellyfin-user" | "toggle-transcode" | "open-requirements" | "open-diagnose" | "open-display-settings" | "open-motion-settings" | "open-sound-settings" | "open-server-settings" | "open-games-dir" | "open-game-assignments" | "open-about" | "add-bookmark" | "open-covers" | "open-stremio" | "open-install" | "open-search" | "open-game-link" | "open-game-sources";

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

/** Verweis auf einen Titel eines Stremio-Addons (Film, Serie oder Folge). */
export interface StremioRef {
  /** Addon (`settings.stremio.addons[].id`), aus dessen Katalog der Titel stammt. */
  addonId: string;
  type: "movie" | "series";
  /** Stremio-ID: bei Filmen und Serien z. B. "tt0111161", bei einer Folge "tt0944947:1:2". */
  id: string;
  /** Nur zum Abspielen: die gewählte direkte Stream-Adresse (http/https). */
  streamUrl?: string;
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
  | "recent"
  | "web"
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
  /** Erkanntes System, z. B. "PS3"; bei nicht zugeordneten Spielen und macOS-Programmen leer. */
  system: string;
  /** Absoluter Pfad zur Spieldatei bzw. zum Spieleordner. */
  path: string;
  /** true bei Demo-Daten – es wird nichts wirklich gestartet. */
  mock: boolean;
  /** Pfad relativ zum Spiele-Ordner – Schlüssel für Zuordnungen von Hand (settings.gameSystems). */
  rel?: string;
  /** true = das System ließ sich nicht erkennen: Bestätigen öffnet die Zuordnung statt den Start. */
  unassigned?: boolean;
  /** Vorschlag für ein nicht zugeordnetes Spiel. */
  guess?: string;
  /** true = nur eine Vermutung (z. B. kleine CD-CHD → PS1). */
  uncertain?: boolean;
  /** true = vom Nutzer von Hand zugeordnet. */
  manual?: boolean;
}
