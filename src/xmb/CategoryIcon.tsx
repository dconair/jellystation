import { useId, type ReactNode } from "react";
import type { CategoryIconName } from "../data/types";

/*
 * Kategorie-Icons im Stil der PS3-XMB: kräftige, gefüllte Piktogramme statt dünner Linien.
 * Alles liegt im 24×24-Raster mit ~2 Einheiten Rand (das Leuchten braucht Platz).
 *
 * Aufbau je Icon:
 *   fill(p)  die weißen Formen; `p` ist die Füllung (Verlauf), auch für dicke Striche.
 *   cut      Aussparungen (schwarz in der Maske): echte Löcher, durch die der Hintergrund scheint –
 *            so bleiben die Formen auch in kleinen Kacheln sauber trennbar.
 *
 * Die Farbe kommt von `currentColor` (Deckkraft erbt das Eltern-Element), die CSS-Filter des
 * Menüs (drop-shadow) wirken weiter auf dem fertigen Icon.
 */

interface Glyph {
  fill: (p: string) => ReactNode;
  cut?: ReactNode;
}

const K = "#000"; // Maskenfarbe für Aussparungen

const glyphs: Record<CategoryIconName, Glyph> = {
  // Lupe: dicker Ring mit leicht getöntem "Glas" und kräftigem Griff.
  search: {
    fill: (p) => (
      <>
        <circle cx="9.6" cy="9.6" r="5.9" fill="none" stroke={p} strokeWidth="3.2" />
        <circle cx="9.6" cy="9.6" r="4.3" fill={p} opacity="0.2" />
        <path d="M14.3 14.3 20.2 20.2" fill="none" stroke={p} strokeWidth="3.6" strokeLinecap="round" />
      </>
    ),
  },

  // Zuletzt: Uhr mit Zeigern (Verlauf).
  recent: {
    fill: (p) => <circle cx="12" cy="12" r="9.2" fill={p} />,
    cut: <path d="M12 6.6V12l3.9 2.4" fill="none" stroke={K} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
  },

  // Filmklappe: aufgeklappter Streifenarm über dem Körper, durch einen Spalt getrennt.
  movies: {
    fill: (p) => (
      <>
        <rect x="3" y="11.6" width="18" height="9.6" rx="2.2" fill={p} />
        <g transform="rotate(-9 3.4 10.6)">
          <rect x="3" y="6.2" width="18" height="4.6" rx="1.5" fill={p} />
        </g>
      </>
    ),
    cut: (
      <>
        {/* Spalt rund um den Arm */}
        <g transform="rotate(-9 3.4 10.6)">
          <rect x="3" y="6.2" width="18" height="4.6" rx="1.5" fill={K} stroke={K} strokeWidth="2.6" strokeLinejoin="round" />
          <rect x="3" y="6.2" width="18" height="4.6" rx="1.5" fill="#fff" />
          {/* Schrägstreifen im Arm */}
          <path d="M7.4 11.4 9.8 5.6" stroke={K} strokeWidth="1.5" />
          <path d="M12.4 11.4 14.8 5.6" stroke={K} strokeWidth="1.5" />
          <path d="M17.4 11.4 19.8 5.6" stroke={K} strokeWidth="1.5" />
        </g>
      </>
    ),
  },

  // Serien: Bildschirm mit Play-Zeichen, darüber gestapelte Folgen.
  series: {
    fill: (p) => (
      <>
        <rect x="7.4" y="2.4" width="9.2" height="1.6" rx="0.8" fill={p} />
        <rect x="5" y="5" width="14" height="1.7" rx="0.85" fill={p} />
        <rect x="2.5" y="8.2" width="19" height="12" rx="2.6" fill={p} />
      </>
    ),
    cut: (
      <path d="M10.2 11.4 15 14.2 10.2 17z" fill={K} stroke={K} strokeWidth="1.3" strokeLinejoin="round" />
    ),
  },

  // Musik: Doppelnote mit kräftigem Balken.
  music: {
    fill: (p) => (
      <>
        <ellipse cx="7" cy="17.8" rx="3.2" ry="2.5" transform="rotate(-20 7 17.8)" fill={p} />
        <ellipse cx="16.8" cy="15.4" rx="3.2" ry="2.5" transform="rotate(-20 16.8 15.4)" fill={p} />
        <rect x="8.2" y="6" width="1.9" height="12" fill={p} />
        <rect x="18" y="3.6" width="1.9" height="11.8" fill={p} />
        <path d="M8.2 6.2 19.9 3.6V7.6L8.2 10.2z" fill={p} stroke={p} strokeWidth="0.8" strokeLinejoin="round" />
      </>
    ),
  },

  // Fotos: Bilderrahmen mit Sonne und Bergen.
  photos: {
    fill: (p) => (
      <>
        <rect x="2.5" y="4" width="19" height="16" rx="2.6" fill={p} />
      </>
    ),
    cut: (
      <>
        <rect x="4.5" y="6" width="15" height="12" rx="1.3" fill={K} />
        <circle cx="9" cy="10" r="1.7" fill="#fff" />
        <path d="M4.5 18 9.6 12.6 12.6 15.6 15.6 11.6 19.5 16.4V18z" fill="#fff" stroke="#fff" strokeWidth="0.8" strokeLinejoin="round" />
      </>
    ),
  },

  // Live-TV: Röhrenfernseher mit Hasenohr-Antenne.
  livetv: {
    fill: (p) => (
      <>
        <path d="M12 8.4 7 3.4M12 8.4 17 3.4" fill="none" stroke={p} strokeWidth="1.8" strokeLinecap="round" />
        <rect x="2.5" y="8.2" width="19" height="12.8" rx="2.6" fill={p} />
        <rect x="5" y="10.7" width="10.4" height="7.8" rx="1.4" fill={p} opacity="0.22" />
      </>
    ),
    cut: (
      <>
        <rect x="5" y="10.7" width="10.4" height="7.8" rx="1.4" fill={K} />
        <circle cx="18.4" cy="12.6" r="1.1" fill={K} />
        <circle cx="18.4" cy="16.6" r="1.1" fill={K} />
      </>
    ),
  },

  // Spiele: Gamepad im DualShock-Stil mit D-Pad, vier Tasten und zwei Sticks.
  games: {
    fill: (p) => (
      <>
        <path
          d="M7.6 6.6h8.8c2.6 0 4 1.1 4.8 3.6l1.5 6c.5 2.3-.5 3.9-2.6 3.9-1.5 0-2.4-.8-3.2-2.2-.5-.9-1.1-1.4-2.1-1.4H9.2c-1 0-1.6.5-2.1 1.4-.8 1.4-1.7 2.2-3.2 2.2-2.1 0-3.1-1.6-2.6-3.9l1.5-6c.8-2.5 2.2-3.6 4.8-3.6z"
          fill={p}
        />
        <rect x="4.6" y="3.8" width="4.6" height="1.7" rx="0.85" fill={p} />
        <rect x="14.8" y="3.8" width="4.6" height="1.7" rx="0.85" fill={p} />
      </>
    ),
    cut: (
      <>
        <path d="M6.6 8.7v5M4.1 11.2h5" stroke={K} strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="17.4" cy="9" r="1" fill={K} />
        <circle cx="17.4" cy="13.2" r="1" fill={K} />
        <circle cx="15.3" cy="11.1" r="1" fill={K} />
        <circle cx="19.5" cy="11.1" r="1" fill={K} />
        <circle cx="9.7" cy="14.7" r="1.35" fill={K} />
        <circle cx="14.3" cy="14.7" r="1.35" fill={K} />
      </>
    ),
  },

  // Einstellungen: Werkzeugkasten wie in der XMB.
  settings: {
    fill: (p) => (
      <>
        <path d="M8 9V6.4c0-.9.7-1.6 1.6-1.6h4.8c.9 0 1.6.7 1.6 1.6V9" fill="none" stroke={p} strokeWidth="2.2" />
        <rect x="2.5" y="8.6" width="19" height="12.2" rx="2.4" fill={p} />
      </>
    ),
    cut: (
      <>
        <path d="M2 13.6h20" stroke={K} strokeWidth="1.1" />
        <rect x="10" y="11.4" width="4" height="4.4" rx="1" fill={K} stroke={K} strokeWidth="1.6" />
        <rect x="10" y="11.4" width="4" height="4.4" rx="1" fill="#fff" />
      </>
    ),
  },
};

export interface CategoryIconProps {
  name: CategoryIconName;
  /** "category": großes Menü-Icon mit eigenem Leuchten; "tile": kleine Kachel (das Leuchten liefert das CSS). */
  variant?: "category" | "tile";
  /** Kantenlänge (Zahl = px, sonst CSS-Länge). Ohne Angabe bestimmt das CSS die Größe (Standard: 1em). */
  size?: number | string;
  className?: string;
}

export function CategoryIcon({ name, variant = "category", size, className }: CategoryIconProps) {
  // useId liefert Sonderzeichen (":" bzw. "«»"), die in url(#…) Ärger machen können.
  const uid = "ci" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const grad = `${uid}-g`;
  const mask = `${uid}-m`;
  const glow = `${uid}-f`;
  // Unbekannter Name (z. B. aus fremden Daten) soll nicht das ganze Menü zum Absturz bringen.
  const glyph = glyphs[name] ?? glyphs.settings;
  const paint = `url(#${grad})`;
  const dim = size === undefined ? undefined : typeof size === "number" ? `${size}px` : size;

  return (
    <svg
      className={className ? `xmb-icon-svg ${className}` : "xmb-icon-svg"}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      style={{ overflow: "visible", ...(dim ? { width: dim, height: dim } : null) }}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Oben reines currentColor, unten zum hellen Blaugrau abgedunkelt: der typische Glanz-Verlauf. */}
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="22">
          <stop offset="0" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" style={{ stopColor: "color-mix(in srgb, currentColor 70%, #86a9e6)" }} />
        </linearGradient>
        <mask id={mask} maskUnits="userSpaceOnUse" x="-3" y="-3" width="30" height="30">
          <rect x="-3" y="-3" width="30" height="30" fill="#fff" />
          {glyph.cut}
        </mask>
        {variant === "category" && (
          <filter id={glow} filterUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="blur" />
            <feFlood floodColor="currentColor" floodOpacity="0.5" />
            <feComposite in2="blur" operator="in" result="halo" />
            <feMerge>
              <feMergeNode in="halo" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      <g filter={variant === "category" ? `url(#${glow})` : undefined}>
        <g mask={glyph.cut ? `url(#${mask})` : undefined}>{glyph.fill(paint)}</g>
      </g>
    </svg>
  );
}
