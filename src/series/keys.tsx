import type { KeyMap } from "../ui/popup";

/** Zusätzliche Tasten des Serien-Screens: Bild auf/ab wechseln Staffel bzw. Folge (wie L1/R1). */
export const KEYS: KeyMap = {
  PageUp: "l1",
  PageDown: "r1",
};

/** Tastenhinweis für die rechte Seite der Hinweisleiste: kleine Tasten-Plaketten plus Beschriftung. */
export function Keys({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <span className="series-keys">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}
