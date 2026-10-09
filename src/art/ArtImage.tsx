import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import type { XmbEntry } from "../data/types";
import { acquireArt, artKey } from "./artLoader";
import type { ArtHandle, RemoteArtSource } from "./artLoader";
import { PlaceholderCover } from "./PlaceholderCover";
import "./art.css";

export interface ArtImageProps {
  entry: XmbEntry;
  /**
   * true = Bild darf jetzt geladen werden (Eintrag liegt nahe am Fokus). Bei false wird
   * nur das generierte Platzhalter-Cover gezeigt, damit nicht hunderte Bilder auf einmal laden.
   */
  active: boolean;
  className?: string;
  /** Dringend laden (z. B. Detailkarte des fokussierten Eintrags): kommt in der Warteschlange vor die Kacheln. */
  priority?: boolean;
}

/** So lange dauert die Überblendung vom Platzhalter zum Bild (siehe .art-image__img in art.css). */
const FADE_MS = 560;

/** Aktuell angezeigtes Bild. Gehört immer zu genau einer Quelle (key), damit nie ein altes Bild stehen bleibt. */
interface Shown {
  key: string;
  url: string;
  /** true = lag schon im Cache: ohne Überblendung zeigen, kein Aufblitzen beim Zurückblättern. */
  instant: boolean;
  /** true = der Browser hat das Bild fertig dekodiert (onLoad). */
  loaded: boolean;
  /** true = Spiele-Cover im Hoch- oder Sonderformat: ganz zeigen und den Rest mit einer unscharfen Kopie füllen. */
  backdrop: boolean;
}

/** Querformat der Kacheln; Spiele-Cover, die davon abweichen, werden nicht beschnitten (siehe onLoad). */
const TILE_RATIO = 16 / 9;

const remoteSource = (entry: XmbEntry): RemoteArtSource | null =>
  entry.art && entry.art.kind !== "generated" ? entry.art : null;

/**
 * Zeigt das Cover eines Eintrags und füllt immer die Größe des Elternelements (object-fit: cover).
 *
 * - Ohne Bild-Quelle (oder solange es lädt / fehlschlägt) steht das generierte Platzhalter-Cover da.
 * - Echte Bilder (Datei, HTTP) werden nur geladen, solange `active` gilt, und blenden weich über den
 *   Platzhalter. Fehler, Zeitüberschreitungen und kaputte Bilder lassen den Platzhalter einfach stehen.
 * - Spiele-Cover im Hochformat (Boxart) werden nicht beschnitten oder verzerrt, sondern ganz gezeigt; die
 *   Ränder füllt eine unscharfe, abgedunkelte Kopie des Bildes.
 */
export function ArtImage({ entry, active, className, priority = false }: ArtImageProps) {
  const source = remoteSource(entry);
  const key = source ? artKey(source) : null;
  const [shown, setShown] = useState<Shown | null>(null);
  const [covered, setCovered] = useState(false);
  const handleRef = useRef<ArtHandle | null>(null);

  // Die Effekte hängen nur am Schlüssel der Quelle: ein neues entry-Objekt mit gleicher Quelle lädt nicht neu,
  // und ein Wechsel von `priority` bricht keinen laufenden Ladevorgang ab.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const priorityRef = useRef(priority);
  priorityRef.current = priority;

  useEffect(() => {
    const src = sourceRef.current;
    if (!active || !src || !key) return;
    let alive = true;
    const handle = acquireArt(src, priorityRef.current);
    handleRef.current = handle;
    const cached = handle.url;
    if (cached) {
      setShown({ key, url: cached, instant: true, loaded: false, backdrop: false });
    } else {
      handle.promise.then(
        (url) => {
          if (alive) setShown({ key, url, instant: false, loaded: false, backdrop: false });
        },
        () => {
          // Abbruch oder Fehler: der Platzhalter bleibt einfach stehen
        },
      );
    }
    return () => {
      alive = false;
      handleRef.current = null;
      handle.release();
      setShown((s) => (s && s.key === key ? null : s));
    };
  }, [active, key]);

  // Nur zeigen, was zur aktuellen Quelle gehört und aktiv angefordert ist.
  const visible = active && shown && shown.key === key ? shown : null;
  const loaded = visible?.loaded ?? false;
  const instant = visible?.instant ?? false;
  const url = visible?.url;

  // Liegt das Bild nach der Überblendung vollständig über dem Platzhalter, wird dieser nicht mehr gezeichnet.
  useEffect(() => {
    if (!loaded) {
      setCovered(false);
      return;
    }
    if (instant) {
      setCovered(true);
      return;
    }
    const id = window.setTimeout(() => setCovered(true), FADE_MS + 60);
    return () => window.clearTimeout(id);
  }, [loaded, instant, url]);

  const isGame = Boolean(entry.game);
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    // Boxart (Hochformat) in der 16:9-Kachel: nicht abschneiden, sondern ganz zeigen. Es zählt nur das Bild selbst,
    // nicht die Größe des Rahmens – die Detailkarte ändert ihre Form, wenn das Cover eintrifft.
    const ratio = naturalHeight > 0 ? naturalWidth / naturalHeight : TILE_RATIO;
    const backdrop = isGame && Math.abs(ratio - TILE_RATIO) > 0.12;
    setShown((s) => (s && s.url === url ? { ...s, loaded: true, backdrop } : s));
  };
  const onError = () => {
    // Die Datei lässt sich nicht als Bild lesen: Platzhalter behalten und nicht erneut versuchen.
    handleRef.current?.markBroken();
    setShown(null);
  };

  const cls = [
    "art-image",
    visible && covered ? "is-covered" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={cls}>
      <PlaceholderCover entry={entry} />
      {visible && isGame && (
        <img
          key={`backdrop-${visible.url}`}
          className={`art-image__img art-image__img--backdrop${instant ? " is-instant" : ""}${loaded && visible.backdrop ? " is-shown" : ""}`}
          src={visible.url}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      {visible && (
        <img
          key={visible.url}
          className={`art-image__img${instant ? " is-instant" : ""}${loaded ? " is-shown" : ""}${visible.backdrop ? " is-contain" : ""}`}
          src={visible.url}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={onLoad}
          onError={onError}
        />
      )}
    </span>
  );
}
