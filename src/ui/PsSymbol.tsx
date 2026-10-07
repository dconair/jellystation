import type { CSSProperties } from "react";

export type PsSymbolName = "cross" | "circle" | "triangle" | "square";

interface PsSymbolProps {
  symbol: PsSymbolName;
  /** true = Originalfarbe der Taste (Standard); false = erbt die Textfarbe. */
  colored?: boolean;
  /** CSS-Größe, Standard "1em". */
  size?: string;
  className?: string;
  style?: CSSProperties;
}

// Farben der PlayStation-Tasten (siehe --ps-* in index.css).
const COLOR: Record<PsSymbolName, string> = {
  cross: "var(--ps-cross)",
  circle: "var(--ps-circle)",
  triangle: "var(--ps-triangle)",
  square: "var(--ps-square)",
};

export const PS_SYMBOL_LABEL: Record<PsSymbolName, string> = {
  cross: "Kreuz",
  circle: "Kreis",
  triangle: "Dreieck",
  square: "Quadrat",
};

/**
 * Die vier PlayStation-Symbole als SVG: exakt im 24×24-Raster zentriert, damit sie
 * neben Text sauber auf einer Linie sitzen (anders als die Unicode-Zeichen ✕ ○ △ □).
 */
export function PsSymbol({ symbol, colored = true, size = "1em", className, style }: PsSymbolProps) {
  return (
    <svg
      className={`ps-symbol${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={colored ? COLOR[symbol] : "currentColor"}
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {symbol === "cross" && <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />}
      {symbol === "circle" && <circle cx="12" cy="12" r="6.6" />}
      {symbol === "triangle" && <path d="M12 5.2 19 17.8H5Z" />}
      {symbol === "square" && <rect x="5.8" y="5.8" width="12.4" height="12.4" rx="1" />}
    </svg>
  );
}
