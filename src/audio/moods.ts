/** Stimmungen der atmosphärischen Hintergrundmusik (wie die Themes der PS4-Startseite). Die Klänge erzeugt src/audio/ambient.ts. */
export type MoodId = "sanft" | "tiefsee" | "nacht" | "morgen";

export interface Mood {
  id: MoodId;
  label: string;
  description: string;
}

export const MOODS: readonly Mood[] = [
  { id: "sanft", label: "Sanft", description: "Warme, weiche Flächen – wie die ruhige PS4-Startseite" },
  { id: "tiefsee", label: "Tiefsee", description: "Tiefe Klänge, langsame Wellen, ferne Glocken" },
  { id: "nacht", label: "Nachtlicht", description: "Dunkel und schwebend, mit leisen Funken" },
  { id: "morgen", label: "Morgenlicht", description: "Hell, offen, leicht und hoffnungsvoll" },
];

export const DEFAULT_MOOD: MoodId = "sanft";
export const isMoodId = (v: unknown): v is MoodId => MOODS.some((m) => m.id === v);
