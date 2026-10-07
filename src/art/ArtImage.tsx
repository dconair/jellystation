import type { XmbEntry } from "../data/types";

export interface ArtImageProps {
  entry: XmbEntry;
  /**
   * true = Bild darf jetzt geladen werden (Eintrag liegt nahe am Fokus). Bei false wird
   * nur das generierte Platzhalter-Cover gezeigt, damit nicht hunderte Bilder auf einmal laden.
   */
  active: boolean;
  className?: string;
}

/**
 * Zeigt das Cover eines Eintrags und füllt immer die Größe des Elternelements (object-fit: cover).
 * VORLÄUFIGER PLATZHALTER – wird vom Cover-Art-Modul (src/art) durch die echte Implementierung ersetzt.
 */
export function ArtImage({ entry, className }: ArtImageProps) {
  return (
    <div
      className={`art-image${className ? ` ${className}` : ""}`}
      style={{
        width: "100%",
        height: "100%",
        background: `linear-gradient(145deg, hsl(${entry.hue} 70% 55%), hsl(${entry.hue} 70% 22%))`,
      }}
    />
  );
}
