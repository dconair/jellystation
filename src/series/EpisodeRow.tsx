import { memo } from "react";
import { ArtImage } from "../art/ArtImage";
import { CheckIcon } from "../ui/popup/parts";
import { remainingText, runtimeText } from "./seasons";
import type { SeriesEpisode } from "./seasons";
import "./series.css";

export interface EpisodeRowProps {
  episode: SeriesEpisode;
  /** Position in der Staffel (für die Nummer, falls die Folge keine hat). */
  index: number;
  /** Oberkante in rem. */
  top: number;
  focused: boolean;
  /** Bild darf laden (Zeile liegt nahe am sichtbaren Bereich). */
  artActive: boolean;
}

/** Eine Folge der Liste: Nummer, Kachel mit Fortschritt, Titel, Laufzeit, Anfang der Beschreibung. Die Klicks behandelt die Liste. */
export const EpisodeRow = memo(function EpisodeRow({ episode: ep, index, top, focused, artActive }: EpisodeRowProps) {
  const left = remainingText(ep);
  const runtime = runtimeText(ep.runtimeSec);
  const started = !ep.played && ep.ratio > 0;
  return (
    <div
      role="option"
      aria-selected={focused}
      data-row={index}
      className={`series-row${focused ? " is-focused" : ""}${ep.played ? " is-played" : ""}`}
      style={{ top: `${top}rem` }}
    >
      <span className="series-row__num" aria-hidden="true">
        {ep.number ?? index + 1}
      </span>
      <span className="series-row__thumb">
        <ArtImage entry={ep.entry} active={artActive} />
        {ep.played && (
          <span className="series-row__badge" aria-hidden="true">
            <CheckIcon />
          </span>
        )}
        {started && (
          <span className="series-row__progress" aria-hidden="true">
            <i style={{ width: `${Math.round(ep.ratio * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="series-row__text">
        <span className="series-row__head">
          <span className="series-row__title">{ep.title}</span>
          {(runtime || left || ep.played) && (
            <span className="series-row__time">
              {runtime && <span>{runtime}</span>}
              {left && <span>{left}</span>}
              {ep.played && (
                <span className="series-row__seen">
                  <CheckIcon />
                  Gesehen
                </span>
              )}
            </span>
          )}
        </span>
        {ep.overview && <span className="series-row__desc">{ep.overview}</span>}
      </span>
    </div>
  );
});

/** Nummer der Zeile, auf die ein Mausereignis fiel (aus data-row); null, wenn daneben. */
export function rowOf(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[data-row]");
  if (!el) return null;
  const n = Number(el.dataset.row);
  return Number.isInteger(n) ? n : null;
}
