import { useId, type ReactNode } from "react";
import type { CategoryIconName } from "../data/types";

/*
 * Kategorie-Icons nach dem Vorbild der PS3-XMB (Home-Menü, 1280×720-Referenzbild aus Sonys Kurzanleitung):
 * flache, ruhige Silhouetten mit feinen Details (Globus und Filmstreifen als Linien, Kamera mit Objektivring).
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
  // Lupe: Ring mit leicht getöntem Glas und rundem Griff.
  search: {
    fill: (p) => (
      <>
        <circle cx="9.8" cy="9.8" r="6" fill="none" stroke={p} strokeWidth="2.4" />
        <circle cx="9.8" cy="9.8" r="4.8" fill={p} opacity="0.16" />
        <path d="M14.4 14.4 20 20" fill="none" stroke={p} strokeWidth="3.2" strokeLinecap="round" />
      </>
    ),
  },

  // Web (XMB „Netzwerk“): Globus aus feinen Linien: Ring, Meridian-Ellipse, Mittelachse, drei Breitenkreise.
  web: {
    fill: (p) => (
      <g fill="none" stroke={p} strokeLinecap="round">
        <circle cx="12" cy="12" r="9.2" strokeWidth="1.5" />
        <ellipse cx="12" cy="12" rx="4.2" ry="9.2" strokeWidth="1.1" />
        <path d="M12 2.8v18.4M2.8 12h18.4M4.2 7.6h15.6M4.2 16.4h15.6" strokeWidth="1.1" />
      </g>
    ),
  },

  // Zuletzt: Scheibe mit Zeigern wie das Datum-und-Uhrzeit-Symbol der XMB.
  recent: {
    fill: (p) => <circle cx="12" cy="12" r="9.2" fill={p} />,
    cut: <path d="M12 6.4V12.2l3.7 2.3" fill="none" stroke={K} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  },

  // Video: Filmstreifen wie in der XMB: zwei Schienen mit Lochreihe, oben und unten verbunden, offenes Bildfenster.
  movies: {
    fill: (p) => (
      <>
        <rect x="2.4" y="4.2" width="4.8" height="15.6" rx="0.9" fill={p} />
        <rect x="16.8" y="4.2" width="4.8" height="15.6" rx="0.9" fill={p} />
        <rect x="6.8" y="7.3" width="10.4" height="1.6" fill={p} />
        <rect x="6.8" y="15.1" width="10.4" height="1.6" fill={p} />
      </>
    ),
    cut: (
      <>
        <path
          d="M3.8 5.8h2v1.9h-2zM3.8 9.2h2v1.9h-2zM3.8 12.6h2v1.9h-2zM3.8 16h2v1.9h-2zM18.2 5.8h2v1.9h-2zM18.2 9.2h2v1.9h-2zM18.2 12.6h2v1.9h-2zM18.2 16h2v1.9h-2z"
          fill={K}
        />
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

  // Musik: Doppelnote ♫: zwei Hälse unter einem leicht geschwungenen Balken, Köpfe links an den Hälsen.
  music: {
    fill: (p) => (
      <>
        <ellipse cx="6.3" cy="18.2" rx="3" ry="2.3" transform="rotate(-24 6.3 18.2)" fill={p} />
        <ellipse cx="16.7" cy="16.4" rx="3" ry="2.3" transform="rotate(-24 16.7 16.4)" fill={p} />
        <rect x="8.2" y="5" width="1.7" height="13.2" fill={p} />
        <rect x="18.5" y="3.4" width="1.7" height="12.8" fill={p} />
        <path d="M8.2 4.8C12 4.2 15.6 4.8 20.2 3.4v3.4c-4.6 1.4-8.2.8-12 1.4z" fill={p} />
      </>
    ),
  },

  // Fotos: kleine Kamera, Sucherhöcker oben, großer Objektivring mit hellem Punkt in der Mitte, kein Blitz.
  photos: {
    fill: (p) => (
      <>
        <rect x="8.6" y="4.4" width="6.8" height="4.4" rx="1.2" fill={p} />
        <rect x="2.2" y="7" width="19.6" height="13.2" rx="2.4" fill={p} />
      </>
    ),
    cut: (
      <>
        <circle cx="12" cy="13.7" r="4.4" fill={K} />
        <circle cx="12" cy="13.7" r="1.7" fill="#fff" />
      </>
    ),
  },

  // Live-TV: flacher Bildschirm als Rahmen mit Standfuß und zwei Funkeln oben rechts (das TV-Symbol der XMB).
  livetv: {
    fill: (p) => (
      <>
        <rect x="2.7" y="7.4" width="17.4" height="12" rx="2.4" fill="none" stroke={p} strokeWidth="1.9" />
        <rect x="5.4" y="10" width="12" height="6.8" rx="1" fill={p} opacity="0.16" />
        <path d="M8.6 21.4h6" stroke={p} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M20.2 1.8Q20.2 4.2 22.6 4.2Q20.2 4.2 20.2 6.6Q20.2 4.2 17.8 4.2Q20.2 4.2 20.2 1.8Z" fill={p} stroke={p} strokeWidth="0.9" strokeLinejoin="round" />
        <path d="M15.2 2.4Q15.2 3.6 16.4 3.6Q15.2 3.6 15.2 4.8Q15.2 3.6 14 3.6Q15.2 3.6 15.2 2.4Z" fill={p} stroke={p} strokeWidth="0.7" strokeLinejoin="round" />
      </>
    ),
  },

  // Spiele: Controller-Silhouette von vorn: breiter Körper, zwei lange Griffe nach unten, Einkerbung unten und oben in der Mitte.
  games: {
    fill: (p) => (
      <path
        d="M4.6 5.6C6 4.5 7.8 4.6 9 5.5c1.6 1.1 4.4 1.1 6 0 1.2-.9 3-1 4.4.1 1.5 1.2 2.4 4.6 2.7 8.6.2 3-.7 5.2-2.7 5.2-1.7 0-2.6-1.7-3.4-3.8-.5-1.3-1.4-1.9-3.4-1.9h-.2c-2 0-2.9.6-3.4 1.9-.8 2.1-1.7 3.8-3.4 3.8-2 0-2.9-2.2-2.7-5.2.3-4 .5-7.4 1.7-8.6z"
        fill={p}
      />
    ),
    cut: (
      <>
        <path d="M6.9 9.6v4.4M4.7 11.8h4.4" stroke={K} strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="17.2" cy="9.3" r="0.95" fill={K} />
        <circle cx="17.2" cy="13.3" r="0.95" fill={K} />
        <circle cx="15.2" cy="11.3" r="0.95" fill={K} />
        <circle cx="19.2" cy="11.3" r="0.95" fill={K} />
      </>
    ),
  },

  // Einstellungen: Werkzeugkasten wie in der XMB: Henkel als Ring, dunkles Band quer über den Deckel, zwei Verschlüsse.
  settings: {
    fill: (p) => (
      <>
        <rect x="7.6" y="3.6" width="8.8" height="6.4" rx="2" fill="none" stroke={p} strokeWidth="1.9" />
        <rect x="2.2" y="8" width="19.6" height="12.4" rx="2.6" fill={p} />
      </>
    ),
    cut: (
      <>
        <rect x="1.6" y="12.1" width="20.8" height="2.4" fill={K} />
        <rect x="5.2" y="10.8" width="3" height="5.2" rx="0.7" fill="#fff" />
        <rect x="15.8" y="10.8" width="3" height="5.2" rx="0.7" fill="#fff" />
        <path d="M6.7 11.6v3.6M17.3 11.6v3.6" stroke={K} strokeWidth="0.7" />
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
        {/* Oben reines currentColor, unten zur Akzentfarbe hin abgedunkelt: der typische Glanz-Verlauf. */}
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="22">
          <stop offset="0" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" style={{ stopColor: "color-mix(in srgb, currentColor 80%, rgb(var(--ui-l76)))" }} />
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
