import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { PsSymbol } from "../PsSymbol";
import type { PsSymbolName } from "../PsSymbol";
import type { HintAction, PopupHint } from "./types";
import "./popup.css";

const ACTION_OF: Record<PsSymbolName, HintAction> = {
  cross: "confirm",
  circle: "back",
  triangle: "triangle",
  square: "square",
};

/** Ein Klick auf einen Hinweis soll den Fokus nicht von dort wegnehmen, wo er gerade liegt. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * Tastenhinweise am unteren Rand des Panels: PlayStation-Symbol in Originalfarbe + Beschriftung.
 * Auch klickbar – ein Klick löst dieselbe Aktion aus wie die Taste.
 */
export function HintBar({
  hints,
  onHint,
  end,
}: {
  hints: readonly PopupHint[];
  onHint?: (action: HintAction) => void;
  /** Rechts außen, z. B. „3 / 24“. */
  end?: ReactNode;
}) {
  if (hints.length === 0 && end === undefined) return null;
  return (
    <footer className="pop-hints">
      {hints.map((hint, i) => (
        <button
          key={`${hint.symbol}-${i}`}
          type="button"
          tabIndex={-1}
          className="pop-hint"
          data-symbol={hint.symbol}
          onMouseDown={keepFocus}
          onClick={() => onHint?.(hint.action ?? ACTION_OF[hint.symbol])}
        >
          <PsSymbol symbol={hint.symbol} size="1.7rem" />
          <span>{hint.label}</span>
        </button>
      ))}
      {end !== undefined && <span className="pop-hints__end">{end}</span>}
    </footer>
  );
}

/**
 * Ladeanzeige wie bei der PS3: ein Kreis aus Punkten, bei dem ein Lichtpunkt umläuft. Die Animation
 * ist reine Deckkraft (läuft auf der GPU und kostet nichts); bei „Bewegung reduzieren“ bleibt ein Standbild.
 */
export function DotSpinner({ size = "2.4rem", dots = 12, className }: { size?: string; dots?: number; className?: string }) {
  const orbit = 8.6;
  return (
    <svg
      className={`pop-spinner${className ? ` ${className}` : ""}`}
      viewBox="-12 -12 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: dots }, (_, i) => {
        const angle = (i / dots) * Math.PI * 2;
        return (
          <circle
            key={i}
            cx={(Math.sin(angle) * orbit).toFixed(2)}
            cy={(-Math.cos(angle) * orbit).toFixed(2)}
            r={1.7}
            style={{ "--i": i / dots } as CSSProperties}
          />
        );
      })}
    </svg>
  );
}

/** Häkchen für „gewählt“. */
export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12.6 9.8 17.4 19.2 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Rundes Symbol vor dem Titel einer Meldung: i, ! oder Häkchen in der Farbe der Art. */
export function KindIcon({ kind }: { kind: "info" | "error" | "success" }) {
  return (
    <span className={`pop-kind is-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {kind === "info" && <path d="M12 10.6v6M12 7.2v.1" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />}
        {kind === "error" && <path d="M12 6.6v6.2M12 16.6v.1" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />}
        {kind === "success" && (
          <path d="M7.2 12.6 10.6 16 16.8 8.6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}
