import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { DotSpinner } from "../ui/popup";
import { PsSymbol } from "../ui/PsSymbol";
import type { PsSymbolName } from "../ui/PsSymbol";
import { formatClock, formatDayTime } from "./format";
import type { Headline } from "./format";

/*
 * Reine Anzeige des Players: Titelzeile, Bedienfeld, Lautstärke, Untertitel, Ladeanzeige. Keine Logik –
 * Zustand und Eingabe kommen von Player.tsx.
 */

export type HintKey = "confirm" | "back" | "triangle" | "square";

/* ------------------------------------------------------------------ Symbole */

export function PlayGlyph({ paused, size = "100%" }: { paused: boolean; size?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className="player-glyph">
      {paused ? (
        <path d="M7.4 4.6v14.8a.6.6 0 0 0 .9.5l11.6-7.4a.6.6 0 0 0 0-1L8.3 4.1a.6.6 0 0 0-.9.5Z" fill="currentColor" />
      ) : (
        <>
          <rect x="6" y="4.6" width="4.2" height="14.8" rx="1" fill="currentColor" />
          <rect x="13.8" y="4.6" width="4.2" height="14.8" rx="1" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** Steuerkreuz mit hervorgehobenen Pfeilen links/rechts (Spulen). */
function DpadGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1.9rem" height="1.9rem" aria-hidden="true" focusable="false" className="player-dpad">
      <path
        d="M9.2 3.6h5.6v5.6h5.6v5.6h-5.6v5.6H9.2v-5.6H3.6V9.2h5.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity="0.8"
      />
      <path d="M8.1 12 5.6 10.4v3.2Z M15.9 12l2.5-1.6v3.2Z" fill="currentColor" />
    </svg>
  );
}

function SpeakerGlyph({ level, muted }: { level: number; muted: boolean }) {
  const waves = muted || level <= 0 ? 0 : level < 0.34 ? 1 : level < 0.67 ? 2 : 3;
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">
      <path d="M4 9.4h3.6L12 5.6v12.8l-4.4-3.8H4Z" fill="currentColor" />
      {muted || level <= 0 ? (
        <path d="M15.4 9.6l5 5M20.4 9.6l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          {waves >= 1 && <path d="M15 9.6a3.6 3.6 0 0 1 0 4.8" />}
          {waves >= 2 && <path d="M17.2 7.6a6.4 6.4 0 0 1 0 8.8" />}
          {waves >= 3 && <path d="M19.4 5.6a9.2 9.2 0 0 1 0 12.8" />}
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------- Teile */

const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

function Hint({ symbol, label, onClick, children }: { symbol?: PsSymbolName; label: string; onClick?: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="player-hint"
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {symbol ? <PsSymbol symbol={symbol} size="1.9rem" /> : children}
      <span>{label}</span>
    </button>
  );
}

export interface OsdProps {
  visible: boolean;
  headline: Headline;
  paused: boolean;
  time: number;
  duration: number;
  buffered: number;
  /** Zielzeit beim Spulen; null = kein Spulen. */
  scrub: number | null;
  /** Kurzbeschreibung der Methode ("Direkt", "Transkodiert") für die Ecke rechts unten. */
  methodLabel?: string;
  onToggle(): void;
  onHint(key: HintKey): void;
  /** Zeiger auf der Leiste: ratio 0..1; `commit` = losgelassen. */
  onScrub(ratio: number, commit: boolean): void;
}

export function Osd(p: OsdProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const shown = p.scrub ?? p.time;
  const dur = p.duration;
  const ratio = dur > 0 ? Math.min(1, Math.max(0, shown / dur)) : 0;
  const bufRatio = dur > 0 ? Math.min(1, Math.max(ratio, p.buffered / dur)) : 0;
  const remaining = dur > 0 ? Math.max(0, dur - shown) : 0;

  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const ratioAt = (e: ReactPointerEvent) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  return (
    <div className={`player-osd${p.visible ? " is-on" : ""}`} aria-hidden={!p.visible}>
      <div className="player-osd__top">
        <div className="player-headline">
          <h1 className="player-headline__title">{p.headline.title}</h1>
          {p.headline.subtitle && <p className="player-headline__sub">{p.headline.subtitle}</p>}
        </div>
        <time className="player-clock" dateTime={now.toISOString()}>
          {formatDayTime(now)}
        </time>
      </div>

      <div className="player-osd__bottom">
        <div className="player-barrow">
          <button
            type="button"
            tabIndex={-1}
            className="player-playbtn"
            aria-label={p.paused ? "Wiedergabe" : "Pause"}
            onMouseDown={keepFocus}
            onClick={(e) => {
              e.stopPropagation();
              p.onToggle();
            }}
          >
            <PlayGlyph paused={p.paused} />
          </button>
          <span className="player-time" data-testid="time-elapsed">
            {formatClock(shown)}
          </span>
          <div
            className="player-track-hit"
            ref={trackRef}
            onPointerDown={(e) => {
              if (e.button !== 0 || dur <= 0) return;
              e.stopPropagation();
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              p.onScrub(ratioAt(e), false);
            }}
            onPointerMove={(e) => {
              if (dragging.current) p.onScrub(ratioAt(e), false);
            }}
            onPointerUp={(e) => {
              if (!dragging.current) return;
              dragging.current = false;
              p.onScrub(ratioAt(e), true);
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <div
              className="player-track"
              role="slider"
              aria-label="Wiedergabeposition"
              aria-valuemin={0}
              aria-valuemax={Math.round(dur)}
              aria-valuenow={Math.round(shown)}
              aria-valuetext={`${formatClock(shown)} von ${formatClock(dur)}`}
              tabIndex={-1}
              style={{ "--played": ratio, "--buffered": bufRatio } as CSSProperties}
            >
              <i className="player-track__buffer" />
              <i className="player-track__played" />
              <i className="player-track__knob" />
              {p.scrub !== null && (
                <span className="player-bubble" style={{ left: `${ratio * 100}%` }} role="status">
                  {formatClock(p.scrub)}
                </span>
              )}
            </div>
          </div>
          <span className="player-time player-time--rest" data-testid="time-remaining">
            {dur > 0 ? `-${formatClock(remaining)}` : ""}
          </span>
        </div>

        <div className="player-hints" data-testid="hints">
          <Hint symbol="cross" label={p.paused ? "Wiedergabe" : "Pause"} onClick={() => p.onHint("confirm")} />
          <Hint symbol="circle" label="Beenden" onClick={() => p.onHint("back")} />
          <Hint symbol="triangle" label="Optionen" onClick={() => p.onHint("triangle")} />
          <Hint symbol="square" label="Anzeige" onClick={() => p.onHint("square")} />
          <span className="player-hint player-hint--static">
            <DpadGlyph />
            <span>Spulen</span>
          </span>
          {p.methodLabel && <span className="player-method">{p.methodLabel}</span>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Lautstärke */

export function VolumeHud({ shown, volume, muted }: { shown: boolean; volume: number; muted: boolean }) {
  const level = muted ? 0 : volume;
  return (
    <div className={`player-volume${shown ? " is-on" : ""}`} role="status" aria-hidden={!shown} aria-label={`Lautstärke ${Math.round(level * 100)} Prozent`}>
      <span className="player-volume__icon">
        <SpeakerGlyph level={volume} muted={muted} />
      </span>
      <div className="player-volume__track">
        <i style={{ height: `${level * 100}%` }} />
      </div>
      <span className="player-volume__value">{muted ? "Aus" : Math.round(volume * 100)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ Untertitel */

const TAG = /<\/?(?:i|b|u)>|<[^>]*>/g;

/** VTT-Text → React-Knoten: nur <i>, <b>, <u> bleiben; alle anderen Tags (Sprecher, Zeitmarken …) entfallen. */
function cueNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const decode = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const stack: Array<"i" | "b" | "u"> = [];
  let last = 0;
  let key = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    let node: ReactNode = decode(chunk);
    for (const tag of [...stack].reverse()) {
      node = tag === "i" ? <i key={key++}>{node}</i> : tag === "b" ? <b key={key++}>{node}</b> : <u key={key++}>{node}</u>;
    }
    out.push(<span key={key++}>{node}</span>);
  };
  for (const m of text.matchAll(TAG)) {
    push(text.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const tag = /^<(\/?)(i|b|u)>$/.exec(m[0]);
    if (tag) {
      if (tag[1]) {
        const at = stack.lastIndexOf(tag[2] as "i" | "b" | "u");
        if (at >= 0) stack.splice(at, 1);
      } else stack.push(tag[2] as "i" | "b" | "u");
    }
  }
  push(text.slice(last));
  return out;
}

export function Cues({ lines, raised }: { lines: string[]; raised: boolean }) {
  if (lines.length === 0) return null;
  return (
    <div className={`player-cues${raised ? " is-raised" : ""}`} aria-live="off" data-testid="cues">
      {lines.map((cue, i) => (
        <p key={i} className="player-cue">
          {cue.split("\n").map((line, j) => (
            <span key={j} className="player-cue__line">
              {cueNodes(line)}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Ladeanzeige */

export function Busy({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="player-busy" role="status" aria-live="polite">
      <DotSpinner size="6.4rem" dots={12} />
      <p className="player-busy__text">{text}</p>
      {sub && <p className="player-busy__sub">{sub}</p>}
    </div>
  );
}

export function CenterFlash({ kind, id }: { kind: "play" | "pause"; id: number }) {
  return (
    <div key={id} className="player-flash" aria-hidden="true">
      <PlayGlyph paused={kind === "play"} />
    </div>
  );
}
