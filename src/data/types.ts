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
}

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
