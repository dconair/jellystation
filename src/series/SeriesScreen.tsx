import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { ArtImage } from "../art/ArtImage";
import type { XmbEntry } from "../data/types";
import type { JfConfig } from "../jellyfin/context";
import type { PadAction } from "../input/useGamepad";
import { OverlayFrame, useOverlayInput } from "../ui/popup";
import { DotSpinner, HintBar } from "../ui/popup/parts";
import type { HintAction } from "../ui/popup/types";
import { playSfx } from "../xmb/sound";
import { EpisodeDetail, MORE_COUNT } from "./EpisodeDetail";
import { EpisodeList, ROW_H } from "./EpisodeList";
import { SeasonButton, SeasonMenu } from "./SeasonPicker";
import { KEYS, Keys } from "./keys";
import {
  episodeCode,
  groupSeasons,
  joinMeta,
  locateEpisode,
  mainAction,
  regularSeasonCount,
  remainingText,
  seasonStatus,
} from "./seasons";
import type { SeriesEpisode } from "./seasons";
import { useSeriesData } from "./useSeriesData";
import "./series.css";

export interface SeriesScreenProps {
  /** Die gewählte Serie (Menü-Eintrag). Ohne `series.jellyfin` handelt es sich um eine Demo-Serie. */
  series: XmbEntry;
  /** Zugangsdaten; null bei Demo-Serien. */
  jellyfin: JfConfig | null;
  /** Spielt eine Folge ab. `playlist` = alle Folgen der Serie in Reihenfolge, `startSec` = Startposition. */
  onPlay: (episode: XmbEntry, playlist: XmbEntry[], startSec: number) => void;
  /** ○ / Esc auf der obersten Ebene. */
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe (z. B. weil darüber ein weiteres Overlay liegt). Standard: true. */
  active?: boolean;
}

type Zone = "play" | "season" | "episodes";

interface Nav {
  zone: Zone;
  /** Index in den Staffeln. */
  season: number;
  /** Zeile in der Staffel. */
  row: number;
}

/** Wie lange die ausblendende Staffelliste bzw. die ausblendende Detailseite noch stehen (ms), muss zu series.css passen. */
const SWAP_MS = 340;
const DETAIL_EXIT_MS = 220;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Serien-Screen im Stil von Netflix/PS4, aber in der PS3-Optik.
 *
 * Ebene 1 (Übersicht): Serieninfo, großer Knopf „Weiterschauen · S2 E3“, Staffel-Auswahl („Staffel 2 ▾“) und die
 * Folgen der gewählten Staffel. Fokus (↑↓): Hauptknopf → Staffel-Auswahl → Folgenliste. L1/R1 wechseln überall die Staffel.
 * Ebene 2 (Details): ✕ auf einer Folge öffnet ihre Detailseite (Bild, volle Beschreibung, Abspielen/Fortsetzen, weitere Folgen).
 */
export function SeriesScreen({ series, jellyfin, onPlay, onClose, active = true }: SeriesScreenProps) {
  const data = useSeriesData(series, jellyfin);
  const ready = data.status === "ready";
  const seasons = useMemo(() => groupSeasons(data.episodes), [data.episodes]);
  const main = useMemo(() => (ready ? mainAction(data.episodes, data.next) : null), [ready, data.episodes, data.next]);
  const hasList = ready && seasons.length > 0;

  /* ---------------------------------------------------------------- Zustand */

  const [nav, setNavState] = useState<Nav>({ zone: "play", season: 0, row: 0 });
  const navRef = useRef(nav);
  const setNav = useCallback((n: Nav) => {
    navRef.current = n;
    setNavState(n);
  }, []);

  const [menu, setMenuState] = useState<number | null>(null);
  const menuRef = useRef<number | null>(null);
  const setMenu = useCallback((i: number | null) => {
    menuRef.current = i;
    setMenuState(i);
  }, []);

  const [detail, setDetail] = useState<{ key: string; leaving: boolean } | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const detailTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(detailTimer.current), []);

  const [swap, setSwap] = useState<{ n: number; from: number; row: number; dir: 1 | -1 } | null>(null);
  const swapCount = useRef(0);
  useEffect(() => {
    if (!swap) return;
    const id = window.setTimeout(() => setSwap(null), SWAP_MS);
    return () => window.clearTimeout(id);
  }, [swap]);

  // Beim ersten Laden: die Staffel der Weiterschauen-Folge ist vorgewählt, der Fokus liegt auf dem Hauptknopf.
  const initialised = useRef(false);
  useEffect(() => {
    if (data.status === "loading") initialised.current = false;
    if (data.status !== "ready" || initialised.current) return;
    initialised.current = true;
    const at = data.next ? locateEpisode(seasons, data.next.key) : null;
    setNav({ zone: "play", season: at ? at[0] : 0, row: at ? at[1] : 0 });
  }, [data.status, data.next, seasons, setNav]);

  const seasonIndex = clamp(nav.season, 0, Math.max(0, seasons.length - 1));
  const season = seasons[seasonIndex];
  const row = season ? clamp(nav.row, 0, season.episodes.length - 1) : 0;
  const collapsed = hasList && nav.zone !== "play";

  /* ---------------------------------------------------------------- Aktionen */

  const play = useCallback(
    (ep: SeriesEpisode, startSec: number) => onPlay(ep.entry, data.playlist, startSec),
    [onPlay, data.playlist],
  );

  const goSeason = (to: number) => {
    const cur = navRef.current;
    const target = clamp(to, 0, seasons.length - 1);
    if (target === cur.season) return false;
    playSfx("category");
    setNav({ ...cur, season: target, row: 0 });
    setSwap({ n: ++swapCount.current, from: cur.season, row: cur.row, dir: target > cur.season ? 1 : -1 });
    return true;
  };

  const openDetail = (key: string) => {
    window.clearTimeout(detailTimer.current);
    setDetail({ key, leaving: false });
  };

  const showEpisode = (key: string) => {
    const at = locateEpisode(seasons, key);
    if (at) setNav({ zone: "episodes", season: at[0], row: at[1] });
    openDetail(key);
  };

  const closeDetail = () => {
    const cur = detailRef.current;
    if (!cur || cur.leaving) return;
    const at = locateEpisode(seasons, cur.key);
    if (at) setNav({ zone: "episodes", season: at[0], row: at[1] });
    setDetail({ ...cur, leaving: true });
    detailTimer.current = window.setTimeout(() => setDetail(null), DETAIL_EXIT_MS);
  };

  const confirm = () => {
    const cur = navRef.current;
    if (menuRef.current !== null) {
      playSfx("confirm");
      goSeason(menuRef.current);
      setMenu(null);
      return;
    }
    if (!ready) {
      if (data.status === "error") {
        playSfx("confirm");
        data.retry();
      }
      return;
    }
    if (cur.zone === "play" && main) {
      playSfx("confirm");
      play(main.episode, main.startSec);
    } else if (cur.zone === "season" && seasons.length > 1) {
      playSfx("confirm");
      setMenu(seasonIndex);
    } else if (cur.zone === "episodes" && season) {
      const ep = season.episodes[clamp(cur.row, 0, season.episodes.length - 1)];
      if (ep) {
        playSfx("confirm");
        openDetail(ep.key);
      }
    }
  };

  const back = () => {
    playSfx("back");
    if (menuRef.current !== null) setMenu(null);
    else onClose();
  };

  const onAction = (action: PadAction) => {
    if (action === "back") return back();
    if (action === "confirm") return confirm();
    if (!hasList || !season) return;
    const cur = navRef.current;

    if (menuRef.current !== null) {
      const at = menuRef.current;
      if (action === "up" || action === "down") {
        const to = clamp(at + (action === "up" ? -1 : 1), 0, seasons.length - 1);
        if (to !== at) {
          playSfx("move");
          setMenu(to);
        }
      }
      return;
    }

    switch (action) {
      case "up":
        if (cur.zone === "episodes") {
          if (cur.row > 0) {
            playSfx("move");
            setNav({ ...cur, row: cur.row - 1 });
          } else {
            playSfx("move");
            setNav({ ...cur, zone: "season" });
          }
        } else if (cur.zone === "season") {
          playSfx("move");
          setNav({ ...cur, zone: "play" });
        }
        return;
      case "down":
        if (cur.zone === "play") {
          playSfx("move");
          setNav({ ...cur, zone: "season" });
        } else if (cur.zone === "season") {
          playSfx("move");
          setNav({ ...cur, zone: "episodes", row: clamp(cur.row, 0, season.episodes.length - 1) });
        } else if (cur.row + 1 < season.episodes.length) {
          playSfx("move");
          setNav({ ...cur, row: cur.row + 1 });
        }
        return;
      case "left":
        if (cur.zone === "season") goSeason(cur.season - 1);
        return;
      case "right":
        if (cur.zone === "season") goSeason(cur.season + 1);
        return;
      case "l1":
        goSeason(cur.season - 1);
        return;
      case "r1":
        goSeason(cur.season + 1);
        return;
      default:
        return;
    }
  };

  const overviewActive = active && !(detail && !detail.leaving);
  useOverlayInput({ active: overviewActive, onAction, keyMap: KEYS });

  const onHint = (a: HintAction) => {
    if (!overviewActive) return;
    if (a === "confirm") confirm();
    else if (a === "back") back();
  };

  /* ------------------------------------------------------------------- Maus */

  const pointer = useRef<{ x: number; y: number } | null>(null);
  const moved = (e: MouseEvent) => {
    const last = pointer.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return false;
    pointer.current = { x: e.clientX, y: e.clientY };
    return true;
  };

  /** Ein Klick außerhalb der geöffneten Staffelliste schließt sie. */
  const onScreenMouseDown = (e: MouseEvent) => {
    if (menuRef.current === null || !(e.target instanceof Element)) return;
    if (!e.target.closest(".series-menu, .series-select")) setMenu(null);
  };

  /* ------------------------------------------------------------- Darstellung */

  const seasonCount = regularSeasonCount(seasons);
  const metaText = useMemo(() => {
    if (!ready) return series.subtitle ?? "";
    // Zahl und Jahr aus dem Menü-Eintrag, aber die Staffelzahl aus den echten Folgen (nur die Staffeln, die es gibt).
    const parts = (series.subtitle ?? "").split(" · ").filter((p) => p && !/staffel/i.test(p));
    const genres = data.genres.slice(0, 2).join(", ");
    const text = seasonCount > 0 ? `${seasonCount} ${seasonCount === 1 ? "Staffel" : "Staffeln"}` : "";
    return joinMeta([...parts.filter((p) => p !== genres), genres, text]);
  }, [ready, series.subtitle, data.genres, seasonCount]);

  const synopsis = data.overview || series.description || "";
  const mainLeft = main ? remainingText(main.episode) : "";

  const hintLabel =
    menu !== null ? "Wählen" : !ready ? (data.status === "error" ? "Erneut versuchen" : "Auswählen") : nav.zone === "play" ? "Abspielen" : nav.zone === "season" ? "Staffel wählen" : "Details";

  const position = hasList && nav.zone === "episodes" && season ? `${row + 1} / ${season.episodes.length}` : undefined;

  const followIndex = detail ? data.episodes.findIndex((e) => e.key === detail.key) : -1;
  const detailEp = followIndex >= 0 ? data.episodes[followIndex] : undefined;

  const style = { "--s-row": `${ROW_H}rem` } as CSSProperties;
  const leavingSeason = swap ? seasons[swap.from] : undefined;

  return (
    <OverlayFrame className="series-frame" dim={1} onBack={onClose} active={active} keyboard={false}>
      <div className={`series-screen${collapsed ? " is-collapsed" : ""}`} style={style} onMouseDown={onScreenMouseDown}>
        <div className="series-art" aria-hidden="true">
          <ArtImage entry={series} active priority />
        </div>
        <div className="series-shade" aria-hidden="true" />

        <p className="series-mini" aria-hidden={!collapsed}>
          <span>{series.title}</span>
          {season && <span className="series-mini__sep">{season.label}</span>}
        </p>

        <div className="series-intro" aria-hidden={collapsed || undefined}>
          <h1 className="series-title">{series.title}</h1>
          {metaText && <p className="series-meta">{metaText}</p>}
          {synopsis && <p className="series-synopsis">{synopsis}</p>}

          {data.status === "loading" && (
            <p className="series-status" role="status">
              <DotSpinner size="2.2rem" />
              <span>Lade Folgen …</span>
            </p>
          )}
          {data.status === "error" && (
            <p className="series-status is-error" role="alert">
              {data.error}
            </p>
          )}
          {ready && !main && (
            <p className="series-status" role="status">
              Keine Folgen gefunden
            </p>
          )}
          {main && (
            <button
              type="button"
              tabIndex={-1}
              className={`series-play${nav.zone === "play" ? " is-focused" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={(e) => {
                if (overviewActive && moved(e) && navRef.current.zone !== "play") setNav({ ...navRef.current, zone: "play" });
              }}
              onClick={() => {
                if (!overviewActive) return;
                setNav({ ...navRef.current, zone: "play" });
                confirm();
              }}
            >
              <span className="series-play__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M8.4 5.4v13.2L19 12Z" fill="currentColor" />
                </svg>
              </span>
              <span className="series-play__text">
                <span className="series-play__label">{joinMeta([main.verb, episodeCode(main.episode)])}</span>
                <span className="series-play__sub">{joinMeta([main.episode.title, mainLeft])}</span>
              </span>
            </button>
          )}
        </div>

        {hasList && season && (
          <div className={`series-lower${menu !== null ? " has-menu" : ""}`}>
            <div className="series-bar-row">
              <SeasonButton
                season={season}
                count={seasons.length}
                focused={nav.zone === "season"}
                open={menu !== null}
                onClick={() => {
                  if (!overviewActive) return;
                  setNav({ ...navRef.current, zone: "season" });
                  confirm();
                }}
                onHover={() => {
                  if (overviewActive && menuRef.current === null && navRef.current.zone !== "season") {
                    setNav({ ...navRef.current, zone: "season" });
                  }
                }}
              />
              <span className="series-bar-row__stats">{seasonStatus(season)}</span>
              {menu !== null && (
                <SeasonMenu
                  seasons={seasons}
                  current={seasonIndex}
                  index={menu}
                  onHover={(i) => setMenu(i)}
                  onPick={(i) => {
                    playSfx("confirm");
                    goSeason(i);
                    setMenu(null);
                  }}
                />
              )}
            </div>

            <div className="series-lists">
              {swap && leavingSeason && (
                <EpisodeList
                  key={`out-${swap.n}`}
                  season={leavingSeason}
                  row={swap.row}
                  focused={false}
                  leaving
                  dir={swap.dir}
                  onFocusRow={() => undefined}
                  onOpenRow={() => undefined}
                  onStep={() => undefined}
                />
              )}
              <EpisodeList
                key={season.id}
                season={season}
                row={row}
                focused={nav.zone === "episodes"}
                dir={swap?.dir ?? 1}
                animate={swap !== null}
                onFocusRow={(r) => {
                  if (!overviewActive || menuRef.current !== null) return;
                  const cur = navRef.current;
                  if (cur.zone !== "episodes" || cur.row !== r) setNav({ ...cur, zone: "episodes", row: r });
                }}
                onOpenRow={(r) => {
                  if (!overviewActive || menuRef.current !== null) return;
                  const ep = season.episodes[r];
                  if (!ep) return;
                  setNav({ ...navRef.current, zone: "episodes", row: r });
                  playSfx("confirm");
                  openDetail(ep.key);
                }}
                onStep={(delta) => {
                  if (!overviewActive || menuRef.current !== null) return;
                  const cur = navRef.current;
                  const to = clamp(cur.zone === "episodes" ? cur.row + delta : cur.row, 0, season.episodes.length - 1);
                  if (cur.zone !== "episodes" || to !== cur.row) {
                    playSfx("move");
                    setNav({ ...cur, zone: "episodes", row: to });
                  }
                }}
              />
            </div>
          </div>
        )}

        <div className="series-hints">
          <HintBar
            hints={[
              { symbol: "cross", label: hintLabel },
              { symbol: "circle", label: menu !== null ? "Schließen" : "Zurück" },
            ]}
            onHint={onHint}
            end={
              menu !== null ? undefined : hasList && seasons.length > 1 ? (
                <>
                  {position && <span className="series-hints__pos">{position}</span>}
                  <Keys keys={["L1", "R1"]} label="Staffel" />
                </>
              ) : (
                position
              )
            }
          />
        </div>

        {detail && detailEp && (
          <EpisodeDetail
            seriesTitle={series.title}
            episode={detailEp}
            following={data.episodes.slice(followIndex + 1, followIndex + 1 + MORE_COUNT)}
            prev={followIndex > 0 ? data.episodes[followIndex - 1] : null}
            next={followIndex + 1 < data.episodes.length ? data.episodes[followIndex + 1] : null}
            active={active && !detail.leaving}
            leaving={detail.leaving}
            onBack={closeDetail}
            onPlay={play}
            onShow={showEpisode}
            onTogglePlayed={(ep) => data.setPlayed(ep.key, !ep.played)}
            loadDetails={data.loadDetails}
          />
        )}
      </div>
    </OverlayFrame>
  );
}
