import { useEffect, useState } from "react";
import type { XmbEntry } from "../data/types";
import { getJfContext, mediaUrl } from "../jellyfin/context";
import type { JfConfig } from "../jellyfin/context";
import { getItem } from "../jellyfin/items";
import type { Headline } from "./format";

/** So lange muss die Pause dauern, bis das Bild einblendet (das Bedienfeld verschwindet vorher). */
const SHOW_AFTER_MS = 5000;
/** Bilder werden schon etwas früher geladen. */
const PRELOAD_AFTER_MS = 1500;

interface Art {
  backdrop: string;
  logo: string;
  overview: string;
}

export interface PauseScreenProps {
  entry: XmbEntry;
  headline: Headline;
  jellyfin: JfConfig | null;
  /** true = der Film steht (und kein Dialog, keine Ladeanzeige). */
  paused: boolean;
}

/**
 * Pause-Bild wie bei Streaming-Diensten: Nach ein paar Sekunden Pause blendet das Hintergrundbild des Titels (bei Folgen das
 * der Serie) samt Logo und Beschreibung ein; sobald es weitergeht, verschwindet es. Fehlende Bilder (404) lassen einfach nur
 * Titel und Text stehen.
 */
export function PauseScreen({ entry, headline, jellyfin, paused }: PauseScreenProps) {
  const [shown, setShown] = useState(false);
  const [art, setArt] = useState<Art | null>(null);
  const [backdropOk, setBackdropOk] = useState(true);
  const [logoOk, setLogoOk] = useState(true);

  const ref = entry.jellyfin;
  const itemId = ref?.id ?? null;
  const artId = ref?.seriesId ?? ref?.id ?? null;

  useEffect(() => {
    if (!paused) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [paused]);

  // Bilder und volle Beschreibung vorab laden (nur mit Server).
  useEffect(() => {
    if (!paused || !jellyfin || !itemId || !artId || art) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const ctx = await getJfContext(jellyfin, { signal: ctl.signal });
          const q = encodeURIComponent(artId);
          const next: Art = {
            backdrop: mediaUrl(ctx, `/Items/${q}/Images/Backdrop?maxWidth=1920&quality=80`),
            logo: mediaUrl(ctx, `/Items/${q}/Images/Logo?maxWidth=700&quality=90`),
            overview: "",
          };
          setBackdropOk(true);
          setLogoOk(true);
          setArt(next);
          const item = await getItem(ctx, itemId, { signal: ctl.signal }).catch(() => null);
          if (item?.overview && !ctl.signal.aborted) setArt({ ...next, overview: item.overview });
        } catch {
          // ohne Bilder bleibt es beim Text
        }
      })();
    }, PRELOAD_AFTER_MS);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [paused, jellyfin, itemId, artId, art]);

  const text = art?.overview || entry.description || "";
  return (
    <div className={`player-pause${shown ? " is-on" : ""}`} aria-hidden={!shown}>
      {art && backdropOk && <img className="player-pause__backdrop" src={art.backdrop} alt="" onError={() => setBackdropOk(false)} />}
      <div className="player-pause__shade" />
      <div className="player-pause__text">
        <span className="player-pause__label">Pausiert</span>
        {art && logoOk ? (
          <img className="player-pause__logo" src={art.logo} alt={headline.title} onError={() => setLogoOk(false)} />
        ) : (
          <h2 className="player-pause__title">{headline.title}</h2>
        )}
        {headline.subtitle && <p className="player-pause__sub">{headline.subtitle}</p>}
        {text && <p className="player-pause__desc">{text}</p>}
      </div>
    </div>
  );
}
