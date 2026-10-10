import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { ArtImage } from "../art/ArtImage";
import type { CategoryIconName, XmbEntry } from "../data/types";
import { CategoryIcon } from "./CategoryIcon";
import type { MotionEngine } from "./MotionEngine";
import { formatClock, formatRemaining, watchState } from "./progress";

export interface DetailData {
  /** Eindeutig je Eintrag und Kategorie: damit erkennt die Maschine, ob der Inhalt getauscht werden muss. */
  key: string;
  entry: XmbEntry;
  icon: CategoryIconName;
}

/**
 * Rechte Detailkarte: großes Cover (oder Icon-Kachel) mit Titel, Untertitel und Beschreibung.
 *
 * Es gibt genau EINE Karte im DOM. Deckkraft und Versatz setzt die Bewegungsmaschine pro Bild: Bei einem
 * Fokuswechsel blendet die Karte schnell aus, die Maschine lässt den Inhalt erst tauschen, wenn sie fast
 * unsichtbar ist, und blendet dann den NEUEREN Eintrag ein – beim schnellen Durchblättern wird nur einmal
 * getauscht, nie gestapelt.
 */
export function DetailCard({ data, motion }: { data: DetailData | null; motion: MotionEngine }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? motion.attachDetail(el) : undefined;
  }, [motion]);

  const entry = data?.entry;
  const hasArt = Boolean(entry?.art);
  const poster = hasArt && entry?.artShape === "poster";
  const cls = "xmb-detail" + (poster ? " is-poster" : hasArt ? " is-landscape" : " is-icon");
  return (
    <aside ref={ref} className={cls} style={{ "--hue": entry?.hue ?? 0 } as CSSProperties}>
      {data && <DetailBody key={data.key} entry={data.entry} icon={data.icon} />}
    </aside>
  );
}

function DetailBody({ entry, icon }: Pick<DetailData, "entry" | "icon">) {
  const hasArt = Boolean(entry.art);
  const watch = watchState(entry);
  return (
    <>
      <div className="xmb-detail__art">
        {watch && watch.ratio > 0 && (
          <span className="xmb-progress xmb-progress--detail" aria-hidden="true">
            <span className="xmb-progress__fill" style={{ transform: `scaleX(${watch.ratio})` }} />
          </span>
        )}
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
      {watch && watch.resumeSec > 0 && (
        <p className="xmb-detail__resume">
          Weiterschauen ab {formatClock(watch.resumeSec)}
          {watch.remainingSec ? ` · noch ${formatRemaining(watch.remainingSec)}` : ""}
        </p>
      )}
      {watch && watch.played && <p className="xmb-detail__resume">Gesehen</p>}
      {entry.description && <p className="xmb-detail__text">{entry.description}</p>}
    </>
  );
}
