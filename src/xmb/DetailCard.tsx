import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArtImage } from "../art/ArtImage";
import type { CategoryIconName, XmbEntry } from "../data/types";
import { CategoryIcon } from "./CategoryIcon";

export interface DetailData {
  entry: XmbEntry;
  icon: CategoryIconName;
}

export interface DetailLayer extends DetailData {
  /** Eigener Schlüssel pro Einblendung, damit React die Karte beim Wechsel neu aufbaut. */
  key: number;
  leaving: boolean;
}

/** Zeit, nach der eine ausgeblendete Karte aus dem DOM entfernt wird (länger als die CSS-Animation). */
const LEAVE_MS = 400;

/**
 * Hält die aktuelle Detailkarte und – kurz – die vorherige, damit der Wechsel weich
 * überblendet (alt blendet aus, neu blendet leicht verzögert ein) statt hart zu springen.
 */
export function useDetailLayers(current: DetailData | null): DetailLayer[] {
  const seq = useRef(1);
  const [layers, setLayers] = useState<DetailLayer[]>(() =>
    current ? [{ ...current, key: 0, leaving: false }] : [],
  );

  const entry = current?.entry;
  const icon = current?.icon;
  useEffect(() => {
    setLayers((prev) => {
      const live = prev.find((l) => !l.leaving);
      if (live && entry && live.entry.id === entry.id) {
        // Gleicher Eintrag (z. B. geänderter Untertitel): Daten tauschen, nicht neu einblenden.
        if (live.entry === entry && live.icon === icon) return prev;
        return prev.map((l) => (l === live ? { ...l, entry, icon: icon! } : l));
      }
      // Höchstens zwei ausblendende Karten übereinander, auch bei schnellem Durchblättern.
      const fading = prev.map((l) => (l.leaving ? l : { ...l, leaving: true })).slice(-2);
      return entry ? [...fading, { entry, icon: icon!, key: seq.current++, leaving: false }] : fading;
    });
  }, [entry, icon]);

  const hasLeaving = layers.some((l) => l.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const id = window.setTimeout(() => setLayers((prev) => prev.filter((l) => !l.leaving)), LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [hasLeaving, layers]);

  return layers;
}

/** Rechte Detailkarte: großes Cover (oder Icon-Kachel) mit Titel, Untertitel und Beschreibung. */
export function DetailCard({ entry, icon, leaving }: DetailData & { leaving: boolean }) {
  const hasArt = Boolean(entry.art);
  const poster = hasArt && entry.artShape === "poster";
  const cls =
    "xmb-detail" + (poster ? " is-poster" : hasArt ? " is-landscape" : " is-icon") + (leaving ? " is-leaving" : "");
  return (
    <aside className={cls} style={{ "--hue": entry.hue } as CSSProperties} aria-hidden={leaving || undefined}>
      <div className="xmb-detail__art">
        {hasArt ? (
          // priority: Das große Cover des fokussierten Eintrags kommt in der Ladewarteschlange vor die Listen-Kacheln.
          <ArtImage entry={entry} active priority className="xmb-art" />
        ) : (
          <span className="xmb-detail__glyph">
            <CategoryIcon name={icon} />
          </span>
        )}
      </div>
      <h2 className="xmb-detail__title">{entry.title}</h2>
      {entry.subtitle && <p className="xmb-detail__meta">{entry.subtitle}</p>}
      {entry.description && <p className="xmb-detail__text">{entry.description}</p>}
    </aside>
  );
}
