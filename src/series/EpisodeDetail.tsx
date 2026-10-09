import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { ArtImage } from "../art/ArtImage";
import type { XmbEntry } from "../data/types";
import type { PadAction } from "../input/useGamepad";
import { useOverlayInput } from "../ui/popup";
import { CheckIcon, HintBar } from "../ui/popup/parts";
import type { HintAction } from "../ui/popup/types";
import { playSfx } from "../xmb/sound";
import { formatClock } from "../xmb/progress";
import { episodeCode, formatDate, joinMeta, remainingText, runtimeText } from "./seasons";
import type { SeriesEpisode } from "./seasons";
import { KEYS, Keys } from "./keys";
import "./series.css";

/** So viele nachfolgende Folgen zeigt die Reihe „Weitere Folgen“. */
export const MORE_COUNT = 4;

type Zone = "text" | "buttons" | "more";

interface ButtonDef {
  id: "play" | "restart" | "mark";
  label: string;
}

export interface EpisodeDetailProps {
  seriesTitle: string;
  episode: SeriesEpisode;
  /** Die nächsten Folgen nach dieser (höchstens {@link MORE_COUNT}). */
  following: readonly SeriesEpisode[];
  /** Vorige/nächste Folge in der Serie (L1/R1); null am Anfang bzw. Ende. */
  prev: SeriesEpisode | null;
  next: SeriesEpisode | null;
  /** false = sichtbar, aber ohne Eingabe (Ausblenden läuft oder ein anderes Overlay liegt darüber). */
  active: boolean;
  /** true = blendet gerade aus. */
  leaving: boolean;
  onBack: () => void;
  onPlay: (episode: SeriesEpisode, startSec: number) => void;
  /** Zur Detailseite einer anderen Folge wechseln. */
  onShow: (key: string) => void;
  /** Gesehen/ungesehen umschalten; wirft bei einem Fehler. */
  onTogglePlayed: (episode: SeriesEpisode) => Promise<void>;
  /** Die lange Beschreibung nachladen (nicht blockierend). */
  loadDetails: (key: string) => void;
}

/** Für die Detailseite ein größeres Bild anfordern (die Listen-Kachel ist nur 400 px hoch). */
function bigEntry(entry: XmbEntry): XmbEntry {
  const art = entry.art;
  if (art?.kind !== "http" || !/fillHeight=\d+/.test(art.url)) return entry;
  return { ...entry, art: { ...art, url: art.url.replace(/fillHeight=\d+/, "fillHeight=800") } };
}

/** Detailseite einer Folge: großes Bild, volle Beschreibung, Abspielen/Fortsetzen und die nächsten Folgen. */
export function EpisodeDetail({
  seriesTitle,
  episode: ep,
  following,
  prev,
  next,
  active,
  leaving,
  onBack,
  onPlay,
  onShow,
  onTogglePlayed,
  loadDetails,
}: EpisodeDetailProps) {
  const [zone, setZone] = useState<Zone>("buttons");
  const [btn, setBtn] = useState(0);
  const [more, setMore] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Die gekürzte Beschreibung steht schon da; die lange kommt nach.
  useEffect(() => {
    loadDetails(ep.key);
  }, [ep.key, loadDetails]);

  const buttons = useMemo<ButtonDef[]>(() => {
    const out: ButtonDef[] = [{ id: "play", label: ep.resumeSec > 0 ? `Fortsetzen bei ${formatClock(ep.resumeSec)}` : "Abspielen" }];
    if (ep.resumeSec > 0) out.push({ id: "restart", label: "Von vorn beginnen" });
    out.push({ id: "mark", label: ep.played ? "Als ungesehen markieren" : "Als gesehen markieren" });
    return out;
  }, [ep.resumeSec, ep.played]);

  // Zwischen den Folgen bleibt der Fokus in seiner Zone; Knopfindex und Reihe an die neue Lage anpassen.
  const btnIndex = Math.min(btn, buttons.length - 1);
  const moreIndex = Math.min(more, Math.max(0, following.length - 1));
  const zoneNow: Zone = zone === "more" && following.length === 0 ? "buttons" : zone;

  useEffect(() => {
    setProblem(null);
  }, [ep.key]);

  /* ---- Beschreibung: scrollbar, wenn sie nicht passt ---- */

  const textRef = useRef<HTMLDivElement>(null);
  const [scrollInfo, setScrollInfo] = useState({ scrollable: false, atStart: true, atEnd: true });
  const measureText = () => {
    const el = textRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight > el.clientHeight + 2;
    const atStart = el.scrollTop <= 1;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    setScrollInfo((s) => (s.scrollable === scrollable && s.atStart === atStart && s.atEnd === atEnd ? s : { scrollable, atStart, atEnd }));
  };
  useLayoutEffect(() => {
    measureText();
    const el = textRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureText);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ep.key, ep.overview]);

  const scrollText = (dir: 1 | -1) => {
    const el = textRef.current;
    if (!el) return;
    const reduced = document.documentElement.dataset.anim === "off";
    el.scrollBy({ top: dir * el.clientHeight * 0.7, behavior: reduced ? "auto" : "smooth" });
  };

  /* ---- Aktionen ---- */

  const runButton = async (id: ButtonDef["id"]) => {
    if (id === "play") onPlay(ep, ep.startSec);
    else if (id === "restart") onPlay(ep, 0);
    else {
      if (busy) return;
      setBusy(true);
      setProblem(null);
      try {
        await onTogglePlayed(ep);
      } catch (err) {
        playSfx("error");
        setProblem(err instanceof Error && err.message ? err.message : "Konnte nicht gespeichert werden");
      } finally {
        setBusy(false);
      }
    }
  };

  const confirm = () => {
    if (zoneNow === "buttons") {
      playSfx("confirm");
      void runButton(buttons[btnIndex].id);
    } else if (zoneNow === "more") {
      const target = following[moreIndex];
      if (!target) return;
      playSfx("confirm");
      setMore(0);
      onShow(target.key);
    } else {
      setZone("buttons");
    }
  };

  const back = () => {
    playSfx("back");
    onBack();
  };

  const step = (target: SeriesEpisode | null) => {
    if (!target) return;
    playSfx("category");
    onShow(target.key);
  };

  const onAction = (action: PadAction) => {
    switch (action) {
      case "up":
        if (zoneNow === "more") {
          playSfx("move");
          setZone("buttons");
        } else if (zoneNow === "buttons" && scrollInfo.scrollable) {
          playSfx("move");
          setZone("text");
        } else if (zoneNow === "text" && !scrollInfo.atStart) {
          scrollText(-1);
        }
        return;
      case "down":
        if (zoneNow === "text") {
          if (scrollInfo.atEnd) {
            playSfx("move");
            setZone("buttons");
          } else scrollText(1);
        } else if (zoneNow === "buttons" && following.length > 0) {
          playSfx("move");
          setZone("more");
        }
        return;
      case "left":
        if (zoneNow === "buttons" && btnIndex > 0) {
          playSfx("move");
          setBtn(btnIndex - 1);
        } else if (zoneNow === "more" && moreIndex > 0) {
          playSfx("move");
          setMore(moreIndex - 1);
        }
        return;
      case "right":
        if (zoneNow === "buttons" && btnIndex < buttons.length - 1) {
          playSfx("move");
          setBtn(btnIndex + 1);
        } else if (zoneNow === "more" && moreIndex < following.length - 1) {
          playSfx("move");
          setMore(moreIndex + 1);
        }
        return;
      case "l1":
        return step(prev);
      case "r1":
        return step(next);
      case "confirm":
        return confirm();
      case "back":
        return back();
      default:
        return;
    }
  };

  useOverlayInput({ active: active && !leaving, onAction, keyMap: KEYS });

  const onHint = (a: HintAction) => {
    if (!active || leaving) return;
    if (a === "confirm") confirm();
    else if (a === "back") back();
  };

  /* ---- Maus ---- */

  const pointer = useRef<{ x: number; y: number } | null>(null);
  const moved = (e: MouseEvent) => {
    const last = pointer.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return false;
    pointer.current = { x: e.clientX, y: e.clientY };
    return true;
  };

  /* ---- Darstellung ---- */

  const meta = joinMeta([episodeCode(ep), runtimeText(ep.runtimeSec), formatDate(ep.premiere)]);
  const left = remainingText(ep);
  const big = useMemo(() => bigEntry(ep.entry), [ep.entry]);
  const paragraphs = useMemo(() => (ep.overview ? ep.overview.split(/\n\n+/) : []), [ep.overview]);
  const focusLabel = zoneNow === "buttons" ? "Auswählen" : zoneNow === "more" ? "Details" : "Zu den Knöpfen";

  return (
    <div className={`series-detail${leaving ? " is-leaving" : ""}${active ? "" : " is-inactive"}`} role="dialog" aria-label={ep.title}>
      <div className="series-detail__art" key={`art-${ep.key}`}>
        <div className="series-detail__art-fade">
          <ArtImage entry={big} active priority />
        </div>
      </div>
      <div className="series-detail__shade" aria-hidden="true" />

      <div className="series-detail__body" key={`body-${ep.key}`}>
        <p className="series-detail__kicker">{seriesTitle}</p>
        <h2 className="series-detail__title">{ep.title}</h2>
        {meta && <p className="series-detail__meta">{meta}</p>}

        <div
          className={`series-detail__textwrap${zoneNow === "text" ? " is-focused" : ""}${scrollInfo.scrollable ? " is-scrollable" : ""}${
            scrollInfo.atStart ? " at-start" : ""
          }${scrollInfo.atEnd ? " at-end" : ""}`}
        >
          <div ref={textRef} className="series-detail__text" onScroll={measureText} tabIndex={-1}>
            {paragraphs.length > 0 ? (
              paragraphs.map((p, i) => <p key={i}>{p}</p>)
            ) : (
              <p className="series-detail__none">Keine Beschreibung vorhanden.</p>
            )}
          </div>
        </div>

        {(ep.played || left) && (
          <div className="series-detail__state">
            {ep.played ? (
              <span className="series-detail__seen">
                <CheckIcon />
                Gesehen
              </span>
            ) : (
              <>
                <span className="series-detail__progress" aria-hidden="true">
                  <i style={{ width: `${Math.round(ep.ratio * 100)}%` }} />
                </span>
                <span>{left}</span>
              </>
            )}
          </div>
        )}

        <div className="series-detail__buttons">
          {buttons.map((b, i) => (
            <button
              key={b.id}
              type="button"
              tabIndex={-1}
              disabled={b.id === "mark" && busy}
              className={`series-btn${b.id === "play" ? " is-primary" : ""}${zoneNow === "buttons" && i === btnIndex ? " is-focused" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={(e) => {
                if (!active || !moved(e)) return;
                if (zone !== "buttons") setZone("buttons");
                if (btn !== i) setBtn(i);
              }}
              onClick={() => {
                if (!active || leaving) return;
                setZone("buttons");
                setBtn(i);
                playSfx("confirm");
                void runButton(b.id);
              }}
            >
              {b.id === "play" && <PlayGlyph />}
              <span>{b.label}</span>
            </button>
          ))}
        </div>
        {problem && (
          <p className="series-detail__problem" role="alert">
            {problem}
          </p>
        )}
      </div>

      {following.length > 0 && (
        <section className="series-more" aria-label="Weitere Folgen">
          <h3 className="series-more__head">Weitere Folgen</h3>
          <div className="series-more__row">
            {following.map((f, i) => (
              <button
                key={f.key}
                type="button"
                tabIndex={-1}
                className={`series-tile${zoneNow === "more" && i === moreIndex ? " is-focused" : ""}${f.played ? " is-played" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={(e) => {
                  if (!active || !moved(e)) return;
                  if (zone !== "more") setZone("more");
                  if (more !== i) setMore(i);
                }}
                onClick={() => {
                  if (!active || leaving) return;
                  playSfx("confirm");
                  setMore(0);
                  onShow(f.key);
                }}
              >
                <span className="series-tile__art">
                  <ArtImage entry={f.entry} active />
                  {f.played && (
                    <span className="series-row__badge" aria-hidden="true">
                      <CheckIcon />
                    </span>
                  )}
                  {!f.played && f.ratio > 0 && (
                    <span className="series-row__progress" aria-hidden="true">
                      <i style={{ width: `${Math.round(f.ratio * 100)}%` }} />
                    </span>
                  )}
                </span>
                <span className="series-tile__code">{episodeCode(f)}</span>
                <span className="series-tile__title">{f.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="series-hints">
        <HintBar
          hints={[
            { symbol: "cross", label: focusLabel },
            { symbol: "circle", label: "Zurück" },
          ]}
          onHint={onHint}
          end={
            zoneNow === "text" ? (
              <Keys keys={["↑", "↓"]} label="Lesen" />
            ) : prev || next ? (
              <Keys keys={["L1", "R1"]} label="Folge wechseln" />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg className="series-btn__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5.6v12.8L18.6 12Z" fill="currentColor" />
    </svg>
  );
}

