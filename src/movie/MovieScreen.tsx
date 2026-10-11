import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { acquireArt } from "../art/artLoader";
import type { RemoteArtSource } from "../art/artLoader";
import { ArtImage } from "../art/ArtImage";
import type { XmbEntry } from "../data/types";
import type { JfConfig } from "../jellyfin/context";
import type { PadAction } from "../input/useGamepad";
import { AccentPicker } from "../prefs/AccentPicker";
import { ACCENTS, setUiPrefs, useUiPrefs } from "../prefs/uiPrefs";
import { KEYS, Keys } from "../series/keys";
import { joinMeta, runtimeText } from "../series/seasons";
import { OverlayFrame, PopupList, useOverlayInput } from "../ui/popup";
import { DotSpinner, HintBar } from "../ui/popup/parts";
import type { HintAction, PopupItem } from "../ui/popup/types";
import { formatClock, formatRemaining, watchState } from "../xmb/progress";
import { playSfx } from "../xmb/sound";
import { useMovieData } from "./useMovieData";
import "../series/series.css";
import "./movie.css";

/** Wahl für den Player: Fassung, Tonspur, Untertitel (`undefined` = der Server entscheidet, `null` = Untertitel aus). */
export interface MovieChoice {
  mediaSourceId?: string;
  audioIndex?: number;
  subtitleIndex?: number | null;
}

export interface MovieScreenProps {
  /** Der gewählte Film (Menü-Eintrag). Ohne `movie.jellyfin` handelt es sich um einen Demo-Film. */
  movie: XmbEntry;
  /** Zugangsdaten; null bei Demo-Filmen. */
  jellyfin: JfConfig | null;
  onPlay: (movie: XmbEntry, startSec: number, choice: MovieChoice) => void;
  /** Der Wiedergabestand hat sich beim Server geändert (Haken/Balken in der Bibliothek neu laden). */
  onChanged?: () => void;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe (z. B. weil darüber ein weiteres Overlay liegt). Standard: true. */
  active?: boolean;
}

type RowId = "play" | "restart" | "version" | "audio" | "subtitle" | "mark" | "color";

interface Row {
  id: RowId;
  label: string;
  /** Gesetzt bei Zeilen zum Durchschalten (◀ ▶). */
  value?: string;
  detail?: string;
  primary?: boolean;
}

const AUTO = "auto";
const OFF = "off";

/** Eine Auswahlliste (✕ auf einer Zeile mit ◀ ▶). */
interface Choice {
  title: string;
  items: PopupItem[];
  onPick: (id: string) => void;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Das Titellogo des Servers (transparent); fehlt es oder lädt nicht, bleibt der Titel als Text stehen. */
function Logo({ source, title }: { source?: RemoteArtSource; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = source ? JSON.stringify(source) : "";
  useEffect(() => {
    setUrl(null);
    if (!source) return;
    let alive = true;
    const handle = acquireArt(source, true);
    if (handle.url) setUrl(handle.url);
    else
      handle.promise.then(
        (u) => alive && setUrl(u),
        () => undefined,
      );
    return () => {
      alive = false;
      handle.release();
    };
    // Nur die Quelle zählt, nicht die Identität des Objekts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!url) return <h1 className="movie-title">{title}</h1>;
  return (
    <h1 className="movie-logo">
      <img src={url} alt={title} draggable={false} onError={() => setUrl(null)} />
    </h1>
  );
}

/** Pfeil für die Zeilen zum Durchschalten. */
function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg className={`movie-arrow is-${dir}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={dir === "left" ? "M15 5.6v12.8L6 12Z" : "M9 5.6v12.8L18 12Z"} fill="currentColor" />
    </svg>
  );
}

/**
 * Detailseite eines Films, bevor der Player startet: Logo, Eckdaten, Beschreibung und die Optionen im PS3-Stil –
 * Abspielen/Fortsetzen, Fassung, Tonspur und Untertitel wählen, gesehen markieren, Farbe ändern.
 * ↑↓ wählen eine Zeile, ←→ schalten Auswahlzeilen durch, ✕ öffnet bei ihnen eine Liste, △ die Farbwahl, ○ schließt.
 */
export function MovieScreen({ movie, jellyfin, onPlay, onChanged, onClose, active = true }: MovieScreenProps) {
  const data = useMovieData(movie, jellyfin);
  const info = data.info;
  const prefs = useUiPrefs();

  /* ---------------------------------------------------------------- Zustand */

  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const setIndex = (i: number) => {
    indexRef.current = i;
    setIndexState(i);
  };

  const [versionId, setVersionId] = useState<string | undefined>();
  const [audio, setAudio] = useState<string>(AUTO);
  const [subtitle, setSubtitle] = useState<string>(AUTO);
  const [playedNow, setPlayedNow] = useState<boolean | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [picker, setPicker] = useState(false);

  const version = info?.versions.find((v) => v.id === versionId) ?? info?.versions[0];

  // Die Spuren gehören zur gewählten Fassung: bei einem Wechsel zurück auf „Automatisch“.
  useEffect(() => {
    setAudio(AUTO);
    setSubtitle(AUTO);
  }, [version?.id]);

  const watch = watchState(movie);
  const played = playedNow ?? watch?.played ?? false;
  const resumeSec = playedNow === undefined ? (watch?.resumeSec ?? 0) : 0;
  const runtimeSec = (info?.runTimeTicks ?? movie.jellyfin?.runTimeTicks ?? 0) / 10_000_000;

  const audioLabel = (id: string) =>
    id === AUTO ? "Automatisch" : (version?.audio.find((t) => String(t.index) === id)?.label ?? "Automatisch");
  const subtitleLabel = (id: string) =>
    id === AUTO ? "Automatisch" : id === OFF ? "Aus" : (version?.subtitles.find((t) => String(t.index) === id)?.label ?? "Automatisch");
  const accentLabel = ACCENTS.find((a) => a.id === prefs.accentId)?.label ?? "";

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [
      {
        id: "play",
        label: resumeSec > 0 ? `Fortsetzen bei ${formatClock(resumeSec)}` : "Abspielen",
        detail: resumeSec > 0 && runtimeSec > 0 ? `noch ${formatRemaining(Math.max(0, runtimeSec - resumeSec))}` : undefined,
        primary: true,
      },
    ];
    if (resumeSec > 0) out.push({ id: "restart", label: "Von vorn beginnen" });
    if (info && info.versions.length > 1 && version) out.push({ id: "version", label: "Fassung", value: version.name });
    if (version && version.audio.length > 1) out.push({ id: "audio", label: "Tonspur", value: audioLabel(audio) });
    if (version && version.subtitles.length > 0) out.push({ id: "subtitle", label: "Untertitel", value: subtitleLabel(subtitle) });
    if (!data.demo && data.status === "ready")
      out.push({ id: "mark", label: played ? "Als ungesehen markieren" : "Als gesehen markieren" });
    out.push({ id: "color", label: "Farbe", value: accentLabel });
    return out;
    // audioLabel/subtitleLabel hängen nur an version, audio und subtitle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSec, runtimeSec, info, version, audio, subtitle, data.demo, data.status, played, accentLabel]);

  const at = clamp(index, 0, rows.length - 1);
  const row = rows[at];

  /* ---------------------------------------------------------------- Aktionen */

  const start = useCallback(
    (startSec: number) => {
      const wish: MovieChoice = {};
      if (info && info.versions.length > 1 && version) wish.mediaSourceId = version.id;
      if (audio !== AUTO) wish.audioIndex = Number(audio);
      if (subtitle === OFF) wish.subtitleIndex = null;
      else if (subtitle !== AUTO) wish.subtitleIndex = Number(subtitle);
      if ((wish.audioIndex !== undefined || wish.subtitleIndex !== undefined) && version && !wish.mediaSourceId)
        wish.mediaSourceId = version.id;
      onPlay(movie, startSec, wish);
    },
    [info, version, audio, subtitle, onPlay, movie],
  );

  const toggleMark = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await data.setPlayed(!played);
      setPlayedNow(!played);
      onChanged?.();
    } catch (err) {
      playSfx("error");
      setProblem(err instanceof Error && err.message ? err.message : "Konnte nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  };

  /** Eine Auswahlzeile um einen Schritt weiterschalten (Schleife durch die Liste). */
  const cycle = (id: RowId, dir: 1 | -1) => {
    const step = <T,>(list: readonly T[], cur: number) => list[(cur + dir + list.length) % list.length];
    if (id === "version" && info && version) {
      const ids = info.versions.map((v) => v.id);
      setVersionId(step(ids, ids.indexOf(version.id)));
    } else if (id === "audio" && version) {
      const ids = [AUTO, ...version.audio.map((t) => String(t.index))];
      setAudio(step(ids, Math.max(0, ids.indexOf(audio))));
    } else if (id === "subtitle" && version) {
      const ids = [AUTO, OFF, ...version.subtitles.map((t) => String(t.index))];
      setSubtitle(step(ids, Math.max(0, ids.indexOf(subtitle))));
    } else if (id === "color") {
      const at = Math.max(
        0,
        ACCENTS.findIndex((a) => a.id === prefs.accentId),
      );
      setUiPrefs({ accentId: step(ACCENTS, at).id });
    } else return false;
    return true;
  };

  /** ✕ auf einer Auswahlzeile: Liste öffnen. */
  const openChoice = (id: RowId) => {
    if (id === "version" && info && version) {
      setChoice({
        title: "Fassung",
        items: info.versions.map((v) => ({ id: v.id, label: v.name, checked: v.id === version.id })),
        onPick: (pick) => setVersionId(pick),
      });
    } else if (id === "audio" && version) {
      setChoice({
        title: "Tonspur",
        items: [
          { id: AUTO, label: "Automatisch", detail: "Wie es der Server vorschlägt", checked: audio === AUTO },
          ...version.audio.map((t) => ({ id: String(t.index), label: t.label, checked: audio === String(t.index) })),
        ],
        onPick: setAudio,
      });
    } else if (id === "subtitle" && version) {
      setChoice({
        title: "Untertitel",
        items: [
          { id: AUTO, label: "Automatisch", detail: "Nach deiner gemerkten Sprache", checked: subtitle === AUTO },
          { id: OFF, label: "Aus", checked: subtitle === OFF },
          ...version.subtitles.map((t) => ({ id: String(t.index), label: t.label, checked: subtitle === String(t.index) })),
        ],
        onPick: setSubtitle,
      });
    } else if (id === "color") setPicker(true);
  };

  const run = (id: RowId) => {
    playSfx("confirm");
    if (id === "play") start(resumeSec);
    else if (id === "restart") start(0);
    else if (id === "mark") void toggleMark();
    else openChoice(id);
  };

  const confirm = () => {
    if (!row) return;
    if (zone === "text") {
      setZone("rows");
      return;
    }
    run(row.id);
  };

  const back = () => {
    playSfx("back");
    onClose();
  };

  /* ---- Beschreibung: scrollbar, wenn sie nicht passt (↑ von der obersten Zeile) ---- */

  const [zone, setZoneState] = useState<"rows" | "text">("rows");
  const zoneRef = useRef(zone);
  const setZone = (z: "rows" | "text") => {
    zoneRef.current = z;
    setZoneState(z);
  };
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
  const overview = info?.overview || movie.description || "";
  useLayoutEffect(() => {
    measureText();
    const el = textRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureText);
    ro.observe(el);
    return () => ro.disconnect();
  }, [overview]);
  const scrollText = (dir: 1 | -1) => {
    const el = textRef.current;
    if (!el) return;
    const reduced = document.documentElement.dataset.anim === "off";
    el.scrollBy({ top: dir * el.clientHeight * 0.7, behavior: reduced ? "auto" : "smooth" });
  };

  const onAction = (action: PadAction) => {
    if (action === "back") return back();
    if (action === "confirm") return confirm();
    if (action === "triangle") {
      playSfx("confirm");
      setPicker(true);
      return;
    }
    if (zoneRef.current === "text") {
      if (action === "up") {
        if (scrollInfo.atStart) return;
        scrollText(-1);
      } else if (action === "down") {
        if (scrollInfo.atEnd) {
          playSfx("move");
          setZone("rows");
        } else scrollText(1);
      }
      return;
    }
    if (action === "up") {
      if (indexRef.current > 0) {
        playSfx("move");
        setIndex(indexRef.current - 1);
      } else if (scrollInfo.scrollable) {
        playSfx("move");
        setZone("text");
      }
    } else if (action === "down") {
      if (indexRef.current < rows.length - 1) {
        playSfx("move");
        setIndex(indexRef.current + 1);
      }
    } else if (action === "left" || action === "right") {
      if (row?.value !== undefined && cycle(row.id, action === "left" ? -1 : 1)) playSfx("move");
    }
  };

  const inputActive = active && !choice && !picker;
  useOverlayInput({ active: inputActive, onAction, keyMap: KEYS });

  const onHint = (a: HintAction) => {
    if (!inputActive) return;
    if (a === "confirm") confirm();
    else if (a === "back") back();
    else if (a === "triangle") {
      playSfx("confirm");
      setPicker(true);
    }
  };

  /* ------------------------------------------------------------------- Maus */

  const pointer = useRef<{ x: number; y: number } | null>(null);
  const moved = (e: MouseEvent) => {
    const last = pointer.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return false;
    pointer.current = { x: e.clientX, y: e.clientY };
    return true;
  };

  /* ------------------------------------------------------------- Darstellung */

  const backdropEntry = useMemo<XmbEntry>(
    () => (info?.backdrop ? { ...movie, art: info.backdrop, artShape: "landscape" } : movie),
    [movie, info?.backdrop],
  );

  const meta = joinMeta([
    info?.year ? String(info.year) : (movie.subtitle ?? "").split(" · ")[0],
    runtimeText(runtimeSec),
    info?.officialRating,
    info?.communityRating ? `★ ${info.communityRating.toFixed(1)}` : undefined,
  ]);
  const genres = info?.genres.slice(0, 3).join(", ") || (movie.subtitle ?? "").split(" · ").slice(1).join(", ");
  const credits = [
    info?.directors.length ? `Regie: ${info.directors.slice(0, 2).join(", ")}` : "",
    info?.cast.length ? `Mit: ${info.cast.slice(0, 4).join(", ")}` : "",
  ].filter(Boolean);

  const hintLabel = !row
    ? "Auswählen"
    : row.id === "play"
      ? resumeSec > 0
        ? "Fortsetzen"
        : "Abspielen"
      : row.value !== undefined
        ? "Liste öffnen"
        : "Auswählen";
  const style = { "--m-row": "4.6" } as CSSProperties;
  const accentTitle = `Farbe: ${accentLabel}`;

  return (
    <>
      <OverlayFrame className="series-frame movie-frame" dim={0.3} onBack={onClose} active={active} keyboard={false}>
        <div className="series-screen movie-screen" style={style}>
          <div className="movie-art" aria-hidden="true">
            <ArtImage entry={backdropEntry} active priority />
          </div>
          <div className="movie-shade" aria-hidden="true" />

          <div className="movie-layout">
            <section className="movie-panel" aria-label={movie.title}>
              <div className="movie-head">
                <Logo source={info?.logo} title={movie.title} />
                {(meta || genres) && <p className="movie-meta">{joinMeta([meta, genres])}</p>}
                {info?.tagline && <p className="movie-tagline">{info.tagline}</p>}
              </div>

              <div
                className={`movie-textwrap${zone === "text" ? " is-focused" : ""}${scrollInfo.scrollable ? " is-scrollable" : ""}${scrollInfo.atStart ? " at-start" : ""}${scrollInfo.atEnd ? " at-end" : ""}`}
              >
                <div ref={textRef} className="movie-text" onScroll={measureText}>
                  {overview ? (
                    overview.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)
                  ) : (
                    <p className="movie-none">Keine Beschreibung vorhanden.</p>
                  )}
                  {credits.map((c) => (
                    <p key={c} className="movie-credit">
                      {c}
                    </p>
                  ))}
                </div>
              </div>

              {data.status === "loading" && (
                <p className="series-status movie-status" role="status">
                  <DotSpinner size="2rem" />
                  <span>Lade Details …</span>
                </p>
              )}
              {data.status === "error" && (
                <p className="movie-note" role="alert">
                  Details nicht geladen – Abspielen geht trotzdem. {data.error}
                </p>
              )}
              {problem && (
                <p className="movie-note" role="alert">
                  {problem}
                </p>
              )}
            </section>

            <section className="movie-options" aria-label="Optionen">
              <div className="movie-rows" role="menu" style={{ height: `calc(${rows.length} * var(--m-row) * 1rem)` }}>
                <div
                  className="movie-bar"
                  aria-hidden="true"
                  style={{ transform: `translate3d(0, calc(${at} * var(--m-row) * 1rem), 0)`, opacity: zone === "rows" ? 1 : 0 }}
                >
                  <span className="movie-bar__halo" />
                </div>
                {rows.map((r, i) => {
                  const focused = zone === "rows" && i === at;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={r.id === "mark" && busy}
                      className={`movie-row${focused ? " is-focused" : ""}${r.primary ? " is-primary" : ""}`}
                      title={r.id === "color" ? accentTitle : undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={(e) => {
                        if (!inputActive || !moved(e)) return;
                        if (zoneRef.current !== "rows") setZone("rows");
                        if (indexRef.current !== i) setIndex(i);
                      }}
                      onClick={() => {
                        if (!inputActive) return;
                        setZone("rows");
                        setIndex(i);
                        run(r.id);
                      }}
                    >
                      {r.id === "play" && (
                        <svg className="movie-row__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M8 5.6v12.8L18.6 12Z" fill="currentColor" />
                        </svg>
                      )}
                      <span className="movie-row__text">
                        <span className="movie-row__label">{r.label}</span>
                        {r.detail && <span className="movie-row__detail">{r.detail}</span>}
                      </span>
                      {r.value !== undefined && (
                        <span className="movie-row__value">
                          {focused && <Arrow dir="left" />}
                          <span>{r.value}</span>
                          {focused && <Arrow dir="right" />}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <div className="series-hints">
            <HintBar
              hints={[
                { symbol: "cross", label: zone === "text" ? "Zu den Knöpfen" : hintLabel },
                { symbol: "circle", label: "Zurück" },
                { symbol: "triangle", label: "Farbe" },
              ]}
              onHint={onHint}
              end={
                zone === "text" ? (
                  <Keys keys={["↑", "↓"]} label="Lesen" />
                ) : row?.value !== undefined ? (
                  <Keys keys={["←", "→"]} label="Ändern" />
                ) : undefined
              }
            />
          </div>
        </div>
      </OverlayFrame>

      {choice && (
        <PopupList
          title={choice.title}
          width="normal"
          align="right"
          dim={0.25}
          items={choice.items}
          onSelect={(id) => {
            choice.onPick(id);
            setChoice(null);
          }}
          onBack={() => setChoice(null)}
        />
      )}
      {picker && <AccentPicker active={active} onClose={() => setPicker(false)} />}
    </>
  );
}
