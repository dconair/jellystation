import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { playSfx } from "../../xmb/sound";
import { useOverlayInput } from "./useOverlayInput";
import "./popup.css";

export type OverlayAlign = "center" | "left" | "right" | "bottom";

export interface OverlayFrameProps {
  children: ReactNode;
  /**
   * Zurück: Klick auf den abgedunkelten Hintergrund sowie ○ / Esc / Backspace – Letzteres nur, solange der Inhalt
   * die Eingabe nicht selbst übernimmt (PopupList und die Dialoge tun das; für eigenen Inhalt gilt dann dieser Rückfall).
   */
  onBack?: () => void;
  /** Abdunklung: true = Standard (0,7), false = keine, Zahl = Stärke 0..1. */
  dim?: boolean | number;
  /** Wo das Panel steht. Standard: mittig. */
  align?: OverlayAlign;
  /** false = Ausblenden starten; nach der Animation wird nichts mehr gezeichnet und `onExited` aufgerufen. */
  open?: boolean;
  onExited?: () => void;
  /** false = Klick und Rückfall-Eingabe sind aus (Overlay liegt unter einem anderen). */
  active?: boolean;
  className?: string;
}

/** Dauer der Ausblend-Animation (ms), muss zu popup.css passen. */
const EXIT_MS = 220;
const DEFAULT_DIM = 0.7;

interface FrameApi {
  /** Meldet, dass der Inhalt die Eingabe selbst behandelt; gibt die Abmeldung zurück. */
  claim: () => () => void;
}

const FrameContext = createContext<FrameApi | null>(null);

/** true, wenn der Aufrufer schon in einem OverlayFrame steckt (dann ist kein zweiter nötig). */
export const useInFrame = () => useContext(FrameContext) !== null;

/** Der Inhalt behandelt ○/Esc selbst: der Rückfall des umgebenden Rahmens wird abgeschaltet. */
export function useFrameClaim() {
  const frame = useContext(FrameContext);
  useEffect(() => frame?.claim(), [frame]);
}

/**
 * Vollbild-Overlay über allem (position: fixed, z-index 40): dunkle Fläche mit sanftem Verlauf – bewusst ohne
 * backdrop-filter, das ruckelt ohne GPU –, darin das Panel, das weich einblendet und hochgleitet.
 *
 * Nicht in einem Element mit transform/filter platzieren: Dort bezöge sich `fixed` nicht mehr aufs Fenster.
 */
export function OverlayFrame({
  children,
  onBack,
  dim = true,
  align = "center",
  open = true,
  onExited,
  active = true,
  className,
}: OverlayFrameProps) {
  const [claims, setClaims] = useState(0);
  const api = useMemo<FrameApi>(
    () => ({
      claim: () => {
        setClaims((n) => n + 1);
        return () => setClaims((n) => n - 1);
      },
    }),
    [],
  );

  // Ausblenden: erst nach der Animation entfernen. Ein direktes Entfernen durch den Aufrufer blendet nicht aus.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const id = window.setTimeout(() => {
      setMounted(false);
      onExited?.();
    }, EXIT_MS);
    return () => window.clearTimeout(id);
    // onExited bewusst nicht als Abhängigkeit: ein neuer Rückruf soll den Ablauf nicht neu starten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Rückfall für eigenen Inhalt ohne eigene Eingabe
  useOverlayInput({
    active: active && open && !!onBack && claims === 0,
    onAction: (action) => {
      if (action !== "back") return;
      playSfx("back");
      onBack?.();
    },
  });

  // Liegt schon ein anderer Rahmen offen (Dialog über einer Liste), dunkelt der neue nur noch halb ab –
  // sonst wäre der Hintergrund dahinter fast schwarz.
  const [stacked] = useState(() => typeof document !== "undefined" && document.querySelector(".pop-overlay") !== null);

  if (!mounted) return null;

  const dimBase = dim === true ? DEFAULT_DIM : dim === false ? 0 : Math.min(1, Math.max(0, dim));
  const dimValue = stacked ? dimBase * 0.5 : dimBase;
  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !onBack || !active || !open) return;
    playSfx("back");
    onBack();
  };

  return (
    <FrameContext.Provider value={api}>
      <div
        className={`pop-overlay pop-overlay--${align}${open ? "" : " is-leaving"}${className ? ` ${className}` : ""}`}
        style={{ "--pop-dim": dimValue } as CSSProperties}
        onClick={onBackdrop}
      >
        <div className="pop-stage">{children}</div>
      </div>
    </FrameContext.Provider>
  );
}

/**
 * Hüllt ein Panel in einen OverlayFrame, falls es noch in keinem steckt (und `frame` nicht false ist).
 * So funktionieren PopupList und die Dialoge allein genauso wie innerhalb eines eigenen OverlayFrame.
 */
export function MaybeFrame({
  frame = true,
  align,
  dim,
  onBack,
  active,
  children,
}: {
  frame?: boolean;
  align?: OverlayAlign;
  dim?: boolean | number;
  onBack?: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  const inFrame = useInFrame();
  if (!frame || inFrame) return <>{children}</>;
  return (
    <OverlayFrame align={align} dim={dim} onBack={onBack} active={active}>
      {children}
    </OverlayFrame>
  );
}
