import { ArtImage } from "../art/ArtImage";
import type { XmbEntry } from "../data/types";
import { PsSymbol } from "../ui/PsSymbol";
import { episodeCode } from "./format";

/** Der Countdown am Ende einer Folge: Cover und Titel der nächsten, ✕ jetzt starten, ○ abbrechen. */
export function NextEpisode({
  entry,
  seconds,
  total,
  onNow,
  onCancel,
}: {
  entry: XmbEntry;
  seconds: number;
  total: number;
  onNow(): void;
  onCancel(): void;
}) {
  const code = episodeCode(entry.jellyfin);
  const left = Math.max(0, seconds);
  return (
    <aside className="player-next" role="alertdialog" aria-label="Nächste Folge" aria-live="polite">
      <div className="player-next__cover">
        <ArtImage entry={entry} active priority />
        <i className="player-next__shade" />
        <i className="player-next__count" style={{ width: `${(1 - left / total) * 100}%` }} />
      </div>
      <div className="player-next__body">
        <p className="player-next__eyebrow">
          Nächste Folge in <b data-testid="next-seconds">{left}</b> s
        </p>
        <h2 className="player-next__title">{entry.title}</h2>
        {code && <p className="player-next__code">{code}</p>}
        <div className="player-next__hints">
          <button type="button" tabIndex={-1} className="player-hint" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onNow(); }}>
            <PsSymbol symbol="cross" size="1.9rem" />
            <span>Jetzt starten</span>
          </button>
          <button type="button" tabIndex={-1} className="player-hint" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onCancel(); }}>
            <PsSymbol symbol="circle" size="1.9rem" />
            <span>Abbrechen</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
