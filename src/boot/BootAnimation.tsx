import { useEffect, useRef, useState } from "react";
import { useOverlayInput } from "../ui/popup";
import { Background } from "../xmb/Background";
import { startBootSound } from "../xmb/sound";
import "./boot.css";

/** Gesamtdauer in ms – passt zum Startklang (coldboot, 10 s): Anschwellen bis ca. 4,5 s, Höhepunkt, langes Ausklingen. */
export const BOOT_MS = 10_000;
/** Das Überblenden ins Menü steckt in den letzten 1,2 s (der Klang klingt dabei aus). */
const FADE_MS = 1200;
/** So früh darf übersprungen werden (verhindert, dass ein Tastendruck beim Start den Vorspann sofort beendet). */
const SKIP_AFTER_MS = 600;

const base = () => (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";

/**
 * Start-Animation nach dem Vorbild des „Cold Boot“ der PS3: Schwarz, ein erstes Funkeln, dann blendet das seidige Band
 * des Hintergrunds auf, während der Klang anschwillt; auf dem Höhepunkt erstrahlt ein Lichtblitz und die JellyStation-Qualle
 * (nur Qualle mit den vier Symbolen, kein Text) taucht daraus auf. Danach klingt alles aus und blendet ins Menü über.
 * Der Hintergrund ist derselbe wie im Menü (Design und Farbthema der Einstellungen), der Übergang daher nahtlos.
 * Beliebige Taste, Mausklick oder Controller-Taste überspringt, sobald {@link SKIP_AFTER_MS} vorbei ist.
 */
export function BootAnimation({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState<number | null>(null);
  const startedAt = useRef(performance.now());
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const sound = useRef<{ stop: (fadeS?: number) => void } | null>(null);
  const finished = useRef(false);

  const finish = (fadeMs: number) => {
    if (finished.current) return;
    finished.current = true;
    setLeaving(fadeMs);
    sound.current?.stop(fadeMs / 1000);
    window.setTimeout(() => doneRef.current(), fadeMs);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    let cancelled = false;
    void startBootSound().then((s) => {
      if (cancelled || finished.current) s?.stop(0.05);
      else sound.current = s;
    });
    const timer = window.setTimeout(() => finishRef.current(FADE_MS), BOOT_MS - FADE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      sound.current?.stop(0.2);
    };
  }, []);

  const skip = () => {
    if (performance.now() - startedAt.current >= SKIP_AFTER_MS) finish(400);
  };
  // Tastatur und Controller; schluckt die Tasten, damit das Menü darunter nichts davon mitbekommt.
  useOverlayInput({
    active: true,
    onAction: skip,
    onKey: () => {
      skip();
      return true;
    },
  });

  return (
    <div
      className={`boot-anim${leaving !== null ? " is-leaving" : ""}`}
      style={leaving !== null ? { ["--boot-fade" as string]: `${leaving}ms` } : undefined}
      role="presentation"
      onPointerDown={skip}
      aria-hidden="true"
    >
      <div className="boot-anim__waves">
        <Background />
      </div>
      <div className="boot-anim__bloom" />
      <div className="boot-anim__streak" />
      <div className="boot-anim__logo">
        <img src={`${base()}branding/jellyfish.svg`} alt="" draggable={false} />
      </div>
    </div>
  );
}
