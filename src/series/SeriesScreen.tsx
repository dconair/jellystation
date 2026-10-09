import { useEffect, useMemo, useState } from "react";
import type { XmbEntry } from "../data/types";
import { getJfContext } from "../jellyfin/context";
import type { JfConfig } from "../jellyfin/context";
import { getEpisodes, getNextUp } from "../jellyfin/items";
import { PopupList } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { formatRemaining, watchState } from "../xmb/progress";

export interface SeriesScreenProps {
  /** Die gewählte Serie (Menü-Eintrag). Ohne `series.jellyfin` handelt es sich um eine Demo-Serie. */
  series: XmbEntry;
  /** Zugangsdaten; null bei Demo-Serien. */
  jellyfin: JfConfig | null;
  /** Spielt eine Folge ab. `playlist` = alle Folgen der Serie in Reihenfolge, `startSec` = Startposition. */
  onPlay: (episode: XmbEntry, playlist: XmbEntry[], startSec: number) => void;
  /** ○ / Esc auf der obersten Ebene. */
  onClose: () => void;
}

/** VORLÄUFIG: einfache Folgenliste (wird durch den Serien-Screen mit Staffel-Auswahl und Folgen-Details ersetzt). */
export function SeriesScreen({ series, jellyfin, onPlay, onClose }: SeriesScreenProps) {
  const [state, setState] = useState<{ episodes: XmbEntry[] | null; focusId?: string; error?: string }>({ episodes: null });

  useEffect(() => {
    if (!series.jellyfin || !jellyfin) {
      // Demo-Serie: eine einzelne Demo-Folge.
      setState({ episodes: [series], focusId: series.id });
      return;
    }
    const ctl = new AbortController();
    void (async () => {
      try {
        const ctx = await getJfContext(jellyfin);
        const [episodes, next] = await Promise.all([
          getEpisodes(ctx, series.jellyfin!.id, { signal: ctl.signal }),
          getNextUp(ctx, series.jellyfin!.id, { signal: ctl.signal }).catch(() => null),
        ]);
        if (!ctl.signal.aborted) setState({ episodes, focusId: next?.id ?? episodes[0]?.id });
      } catch (err) {
        if (!ctl.signal.aborted) setState({ episodes: [], error: err instanceof Error ? err.message : "Unerwarteter Fehler" });
      }
    })();
    return () => ctl.abort();
  }, [series, jellyfin]);

  const { episodes, error, focusId } = state;
  const items = useMemo<PopupItem[]>(() => {
    const out: PopupItem[] = [];
    let season: number | undefined | null = null;
    for (const ep of episodes ?? []) {
      const n = ep.jellyfin?.seasonNumber;
      if (n !== season) {
        season = n;
        out.push({ id: `season/${n ?? "x"}`, label: n === 0 ? "Specials" : n ? `Staffel ${n}` : "Folgen", header: true });
      }
      const w = watchState(ep);
      out.push({
        id: ep.id,
        label: ep.title,
        detail: ep.subtitle,
        art: ep,
        progress: w && !w.played && w.ratio > 0 ? w.ratio : undefined,
        status: w?.played ? "ok" : undefined,
        trailing: w?.played ? "Gesehen" : w?.remainingSec ? formatRemaining(w.remainingSec) : undefined,
      });
    }
    return out;
  }, [episodes]);

  return (
    <PopupList
      title={series.title}
      subtitle="Folgen"
      width="wide"
      items={items}
      busy={episodes === null}
      focusId={focusId}
      emptyText={episodes === null ? "Lade Folgen …" : "Keine Folgen gefunden"}
      footer={error ? { text: error, kind: "error" } : undefined}
      onSelect={(id) => {
        const ep = episodes?.find((e) => e.id === id);
        if (ep && episodes) onPlay(ep, episodes, watchState(ep)?.resumeSec ?? 0);
      }}
      onBack={onClose}
    />
  );
}
