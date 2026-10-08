import type { CSSProperties } from "react";
import { ArtImage } from "../art/ArtImage";
import type { XmbEntry } from "../data/types";
import { DotSpinner, OverlayFrame, useOverlayInput } from "../ui/popup";
import "./launcher.css";

export interface LaunchOverlayProps {
  entry: XmbEntry;
  /** Zeile unter dem Titel, z. B. „RPCS3 wird gestartet …“. */
  status: string;
  /** false = Ausblenden starten; nach der Animation folgt `onExited`. */
  open?: boolean;
  /** false = liegt unter einem Dialog (keine Eingabe). */
  active?: boolean;
  onExited?: () => void;
}

/**
 * Vollbild-Übergang beim Spielstart (wie der Ladebildschirm der PS3): dunkler Verlauf, das Cover mit Glanz und
 * Spiegelung, Titel, darunter „<Emulator> wird gestartet …“ mit der Punkte-Ladeanzeige.
 *
 * Reine Anzeige: Das Overlay nimmt die Tasten nur an, um sie vom Hauptmenü fernzuhalten. Geschlossen wird es vom
 * Aufrufer (`open={false}`), der Ablauf steuert die Dauer (≈ 2,5 s) oder ersetzt es durch einen Fehlerdialog.
 */
export function LaunchOverlay({ entry, status, open = true, active = true, onExited }: LaunchOverlayProps) {
  // Tasten schlucken, damit während des Starts nichts im Hauptmenü passiert (z. B. ein zweiter Start per ✕).
  useOverlayInput({ active: active && open, onAction: () => undefined });

  const poster = entry.artShape === "poster";
  return (
    <OverlayFrame className="launch-frame" dim={1} open={open} onExited={onExited} active={active} keyboard={false}>
      {/* Neben (nicht in) .launch: dessen Einblend-Animation soll die fest verankerten Lichtlinien nicht mitbewegen. */}
      <div className="launch__waves" aria-hidden="true">
        <i />
        <i />
      </div>
      <div
        className={`launch${poster ? " launch--poster" : ""}`}
        role="status"
        aria-live="polite"
        style={{ "--hue": entry.hue } as CSSProperties}
      >
        <div className="launch__cover">
          <ArtImage entry={entry} active priority />
          <span className="launch__gloss" aria-hidden="true" />
        </div>
        <h2 className="launch__title">{entry.title}</h2>
        {entry.subtitle && <p className="launch__subtitle">{entry.subtitle}</p>}
        <div className="launch__status">
          <DotSpinner size="2.2rem" />
          <span>{status}</span>
        </div>
      </div>
    </OverlayFrame>
  );
}
