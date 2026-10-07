import { memo } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { XmbEntry } from "../data/types";
import { PsSymbol } from "../ui/PsSymbol";
import type { PsSymbolName } from "../ui/PsSymbol";
import "./art.css";

/**
 * Prozedurales Platzhalter-Cover ohne Netz und ohne Zufall: dasselbe Entry ergibt immer dasselbe Bild.
 * Alles skaliert über Container-Einheiten (cqmin, siehe art.css) – dieselbe Komponente sieht in der
 * kleinen Listen-Kachel genauso sauber aus wie in der großen Detailkarte.
 */

type Variant = "game" | "poster" | "tile";

export function coverVariant(entry: Pick<XmbEntry, "game" | "artShape">): Variant {
  if (entry.game) return "game";
  if (entry.artShape === "poster") return "poster";
  return "tile";
}

/** FNV-1a (32 Bit) – stabil und schnell; reicht für optische Variation. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Kleiner deterministischer Zufallsgenerator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS: PsSymbolName[] = ["triangle", "circle", "cross", "square"];

/** Umriss eines PlayStation-Symbols im 100er-Raster um (x, y) mit "Radius" r. */
function symbolShape(symbol: PsSymbolName, x: number, y: number, r: number, rot: number, key: string): ReactNode {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
    transform: `rotate(${rot} ${x} ${y})`,
  };
  switch (symbol) {
    case "circle":
      return <circle key={key} {...common} cx={x} cy={y} r={r} />;
    case "square":
      return <rect key={key} {...common} x={x - r * 0.86} y={y - r * 0.86} width={r * 1.72} height={r * 1.72} rx={r * 0.08} />;
    case "cross":
      return (
        <path
          key={key}
          {...common}
          d={`M${x - r * 0.8} ${y - r * 0.8}L${x + r * 0.8} ${y + r * 0.8}M${x + r * 0.8} ${y - r * 0.8}L${x - r * 0.8} ${y + r * 0.8}`}
        />
      );
    default:
      return (
        <path
          key={key}
          {...common}
          d={`M${x} ${y - r}L${x + r * 0.95} ${y + r * 0.72}L${x - r * 0.95} ${y + r * 0.72}Z`}
        />
      );
  }
}

/* --------------------------------------------------------------- Geometrie */

/**
 * Dekor als SVG im 100×100-Raster, "slice" beschnitten: in 16:9 bleibt die mittlere Bahn sichtbar, im
 * Hochformat der mittlere Streifen – die Hauptmotive liegen deshalb um die Mitte (x 20–80, y 25–75).
 */
function gameGeometry(seed: number): ReactNode {
  const r = rng(seed);
  const sym = SYMBOLS[seed % 4];
  const cx = 36 + r() * 28;
  const cy = 42 + r() * 18;
  const big = 34 + r() * 14;
  const rings = [0.5, 0.8, 1.15, 1.55].map((k, i) => (
    <circle key={`r${i}`} cx={cx} cy={cy} r={big * k} strokeOpacity={0.34 - i * 0.06} />
  ));
  // Raster aus feinen Punkten in einer Ecke – wirkt wie Druckraster der Spielehülle
  const dots: ReactNode[] = [];
  const dx = r() > 0.5 ? 66 : 14;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      dots.push(<circle key={`d${i}${j}`} cx={dx + i * 6} cy={34 + j * 6} r={0.5} fill="currentColor" stroke="none" fillOpacity={0.5} />);
    }
  }
  const hair = [0, 1, 2].map((i) => {
    const o = 14 + i * 9 + r() * 5;
    return <path key={`h${i}`} d={`M${o - 30} 100L${o + 70} 0`} strokeOpacity={0.1} />;
  });
  return (
    <>
      <g stroke="currentColor" strokeWidth="1" fill="none" vectorEffect="non-scaling-stroke">
        {rings}
        {hair}
      </g>
      <g style={{ color: "#fff", opacity: 0.38 }}>{symbolShape(sym, cx, cy, big * 0.62, (r() - 0.5) * 30, "main")}</g>
      <g>{dots}</g>
    </>
  );
}

function posterGeometry(seed: number): ReactNode {
  const r = rng(seed);
  const kind = seed % 4;
  if (kind === 0) {
    // Sonne mit Querschlitzen
    const cx = 50;
    const cy = 42;
    const R = 24 + r() * 6;
    return (
      <>
        <circle cx={cx} cy={cy} r={R} fill="#fff" fillOpacity={0.16} />
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} x={cx - R - 1} y={cy + 2 + i * 4.4} width={R * 2 + 2} height={1.5 + i * 0.5} fill="#050816" fillOpacity={0.4} />
        ))}
        <circle cx={cx} cy={cy} r={R + 5} fill="none" stroke="#fff" strokeOpacity={0.3} strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </>
    );
  }
  if (kind === 1) {
    // Lichtstrahlen von oben
    const ox = 28 + r() * 44;
    return (
      <>
        {[-34, -20, -8, 6, 20, 34].map((a, i) => (
          <path key={i} d={`M${ox} -6L${ox + a * 2.4} 110L${ox + a * 2.4 + 9} 110Z`} fill="#fff" fillOpacity={0.05 + (i % 3) * 0.035} />
        ))}
        <circle cx={ox} cy={-2} r={13} fill="#fff" fillOpacity={0.22} />
      </>
    );
  }
  if (kind === 2) {
    // Gebirgsschichten
    const layer = (base: number, amp: number, alpha: number, k: string) => {
      const pts: string[] = [`0 100`];
      let x = -4;
      let up = true;
      while (x <= 104) {
        pts.push(`${x} ${base - (up ? amp * (0.55 + r() * 0.6) : amp * 0.1 * r())}`);
        x += 10 + r() * 14;
        up = !up;
      }
      pts.push(`104 100`);
      return <polygon key={k} points={pts.join(" ")} fill="#000" fillOpacity={alpha} />;
    };
    return (
      <>
        <circle cx={26 + r() * 48} cy={30} r={11} fill="#fff" fillOpacity={0.24} />
        {layer(66, 22, 0.16, "a")}
        {layer(76, 18, 0.2, "b")}
        {layer(86, 14, 0.28, "c")}
      </>
    );
  }
  // Konzentrische Ringe (Filmrolle / Zielscheibe)
  const cx = 30 + r() * 40;
  return (
    <>
      {[10, 18, 27, 37, 48].map((rad, i) => (
        <circle key={i} cx={cx} cy={40} r={rad} fill="none" stroke="#fff" strokeOpacity={0.34 - i * 0.05} strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      <circle cx={cx} cy={40} r={4.5} fill="#fff" fillOpacity={0.35} />
    </>
  );
}

function tileGeometry(seed: number): ReactNode {
  const r = rng(seed);
  const blobs = [0, 1, 2].map((i) => (
    <circle key={i} cx={20 + r() * 60} cy={30 + r() * 40} r={14 + r() * 22} fill="#fff" fillOpacity={0.06 + r() * 0.07} />
  ));
  return (
    <>
      {blobs}
      <path d={`M-4 ${58 + r() * 12}C26 ${40 + r() * 10} 52 ${72 + r() * 10} 104 ${50 + r() * 14}`} fill="none" stroke="#fff" strokeOpacity={0.28} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </>
  );
}

/* ------------------------------------------------------------------ Texte */

/** "Name: Zusatz" / "Name – Zusatz" in Haupttitel und Untertitel trennen, wie auf Spielehüllen üblich. */
export function splitTitle(title: string): { main: string; sub: string } {
  const m = /^(.{3,}?)(?::\s+|\s+[–—-]\s+)(.{3,})$/.exec(title.trim());
  return m ? { main: m[1], sub: m[2] } : { main: title.trim(), sub: "" };
}

/** "2017 · Science-Fiction" → Jahr und Rest; ohne Jahr bleibt alles im Rest. */
export function splitMeta(subtitle?: string): { year: string; rest: string } {
  const text = (subtitle ?? "").trim();
  const m = /^(\d{4})(?:\s*[–-]\s*(?:\d{4})?)?\s*(?:·\s*(.*))?$/.exec(text);
  if (m) return { year: m[1], rest: (m[2] ?? "").trim() };
  return { year: "", rest: text };
}

/** Länge des längsten Worts: damit passt CSS die Schrift so an, dass auch ein langes Einzelwort nicht mitten im Wort bricht. */
const longestWord = (text: string) => Math.max(4, ...text.split(/[\s\-–—:/]+/).map((w) => w.length));

/** Farbton des zweiten Verlaufspunkts: leicht verschoben, damit der Verlauf lebendig statt flach wirkt. */
const hue2 = (hue: number, seed: number) => (hue + 24 + (seed % 5) * 8) % 360;

/* -------------------------------------------------------------- Komponente */

function Placeholder({ entry }: { entry: XmbEntry }) {
  const variant = coverVariant(entry);
  const seed = hash(`${entry.id}\u0000${entry.title}`);
  // Ungültiger Farbton (NaN, undefined aus fremden Daten) würde den ganzen Verlauf ungültig machen: neutrales Blau nehmen.
  const hue = Number.isFinite(entry.hue) ? ((Math.round(entry.hue) % 360) + 360) % 360 : 220;
  const style = { "--h": hue, "--h2": hue2(hue, seed), "--wl": longestWord(entry.title) } as CSSProperties;

  if (variant === "game") {
    const { main, sub } = splitTitle(entry.title);
    (style as Record<string, unknown>)["--wl"] = longestWord(main);
    const system = entry.game?.system ?? "";
    return (
      <span className="art-ph art-ph--game" style={style} aria-hidden="true">
        <svg className="art-ph__geo" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" focusable="false">
          {gameGeometry(seed)}
        </svg>
        <span className="art-ph__shine" />
        <span className="art-ph__bar">
          <span className="art-ph__sys">{system}</span>
          <span className="art-ph__marks">
            {SYMBOLS.map((s) => (
              <PsSymbol key={s} symbol={s} />
            ))}
          </span>
        </span>
        <span className="art-ph__name">
          <span className="art-ph__main">{main}</span>
          {sub && <span className="art-ph__sub">{sub}</span>}
        </span>
      </span>
    );
  }

  if (variant === "poster") {
    const { year, rest } = splitMeta(entry.subtitle);
    return (
      <span className="art-ph art-ph--poster" style={style} aria-hidden="true">
        <svg className="art-ph__geo" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" focusable="false">
          {posterGeometry(seed)}
        </svg>
        <span className="art-ph__shine" />
        <span className="art-ph__credits">
          <span className="art-ph__rule" />
          <span className="art-ph__ptitle">{entry.title}</span>
          {(year || rest) && (
            <span className="art-ph__pmeta">
              {year && <span className="art-ph__year">{year}</span>}
              {rest && <span className="art-ph__genre">{rest}</span>}
            </span>
          )}
        </span>
      </span>
    );
  }

  return (
    <span className="art-ph art-ph--tile" style={style} aria-hidden="true">
      <svg className="art-ph__geo" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" focusable="false">
        {tileGeometry(seed)}
      </svg>
      <span className="art-ph__shine" />
      <span className="art-ph__center">
        <span className="art-ph__ttitle">{entry.title}</span>
        {entry.subtitle && <span className="art-ph__tmeta">{entry.subtitle}</span>}
      </span>
    </span>
  );
}

/** Neu zeichnen nur, wenn sich etwas Sichtbares am Eintrag ändert (Listen mit hunderten Kacheln). */
export const PlaceholderCover = memo(Placeholder, (a, b) => {
  const x = a.entry;
  const y = b.entry;
  return (
    x === y ||
    (x.id === y.id &&
      x.title === y.title &&
      x.subtitle === y.subtitle &&
      x.hue === y.hue &&
      x.artShape === y.artShape &&
      x.game?.system === y.game?.system)
  );
});
