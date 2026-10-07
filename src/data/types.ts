export interface XmbEntry {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  /** Farbton (0–360) für die Platzhalter-Kachel. */
  hue: number;
  /** Gesetzt bei Spielen: wird beim Bestätigen im Emulator gestartet. */
  game?: GameRef;
  /** Interne Aktion statt Inhalt, z. B. "run-setup". */
  action?: "run-setup";
  /** Cover/Game-Art. Fehlt sie, zeigt die XMB ein einfaches Icon-Kachel (z. B. bei Einstellungen). */
  art?: ArtSource;
  /** Seitenverhältnis des Originalbilds: "landscape" ≈ 16:9 (Game-Art), "poster" ≈ 2:3 (Film-Cover). */
  artShape?: "landscape" | "poster";
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
