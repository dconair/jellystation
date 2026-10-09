import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { XmbEntry } from "../data/types";
import { getJfContext } from "../jellyfin/context";
import type { JfConfig, JfContext } from "../jellyfin/context";
import { getEpisodeInfos, getItem, getNextUp, setItemPlayed } from "../jellyfin/items";
import { demoEpisodes } from "./demoSeries";
import { cleanOverview, episodeFromEntry, patchEpisode, pickContinue, playedPatch } from "./seasons";
import type { EpisodePatch, SeriesEpisode } from "./seasons";

export interface SeriesData {
  status: "loading" | "ready" | "error";
  error?: string;
  episodes: SeriesEpisode[];
  /** Alle Folgen der Serie in Reihenfolge – für „Nächste Folge“ im Player. */
  playlist: XmbEntry[];
  /** Beschreibung der Serie (die lange, sobald sie da ist). */
  overview: string;
  genres: string[];
  /** Die Folge, mit der es weitergeht (laut Server, sonst lokal ermittelt); null = alles gesehen. */
  next: SeriesEpisode | null;
  /** true = Demo-Serie ohne Server. */
  demo: boolean;
  /** Holt die lange Beschreibung (und das Datum) einer Folge nach; mehrfache Aufrufe laden nur einmal. */
  loadDetails: (key: string) => void;
  /** Markiert eine Folge als gesehen/ungesehen (beim Server; in der Demo nur lokal). Wirft bei einem Fehler. */
  setPlayed: (key: string, played: boolean) => Promise<void>;
  /** Lädt nach einem Fehler erneut. */
  retry: () => void;
}

interface Loaded {
  episodes: SeriesEpisode[];
  overview: string;
  genres: string[];
  /** Schlüssel der Folge laut Server; undefined = nicht ermittelt, null = alles gesehen. */
  serverNext: string | null | undefined;
}

type State = { status: "loading" } | { status: "error"; error: string } | ({ status: "ready" } & Loaded);

const errorMessage = (err: unknown) => (err instanceof Error && err.message ? err.message : "Unerwarteter Fehler");

/**
 * Lädt die Folgen einer Serie (und „Als Nächstes“, Genres, lange Beschreibung) mit Abbruch beim Schließen.
 * Ohne Jellyfin-Bezug entstehen lokal Demo-Folgen.
 */
export function useSeriesData(series: XmbEntry, jellyfin: JfConfig | null): SeriesData {
  const demo = !series.jellyfin || !jellyfin || !jellyfin.url || !jellyfin.apiKey;
  const seriesId = series.jellyfin?.id ?? "";
  const url = jellyfin?.url ?? "";
  const apiKey = jellyfin?.apiKey ?? "";
  const userId = jellyfin?.userId ?? "";

  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const ctxRef = useRef<JfContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    requested.current = new Set();
    ctxRef.current = null;
    if (demo) {
      setState({ status: "ready", episodes: demoEpisodes(series), overview: series.description ?? "", genres: [], serverNext: undefined });
      return;
    }
    setState({ status: "loading" });
    const ctl = new AbortController();
    abortRef.current = ctl;
    const { signal } = ctl;
    const cfg: JfConfig = { url, apiKey, ...(userId ? { userId } : {}) };
    void (async () => {
      try {
        const ctx = await getJfContext(cfg, { signal });
        ctxRef.current = ctx;
        const [infos, next] = await Promise.all([
          getEpisodeInfos(ctx, seriesId, { signal }),
          getNextUp(ctx, seriesId, { signal }).then(
            (e) => e?.id ?? null,
            (err) => {
              if (signal.aborted) throw err;
              return undefined;
            },
          ),
        ]);
        if (signal.aborted) return;
        const episodes = infos.map(({ entry, item }) =>
          episodeFromEntry(entry, {
            overview: item.overview ? cleanOverview(item.overview) : undefined,
            premiere: item.premiereDate,
          }),
        );
        setState({ status: "ready", episodes, overview: series.description ?? "", genres: [], serverNext: next });
        // Serien-Beschreibung und Genres kommen mit der Einzelabfrage; die Oberfläche steht schon.
        getItem(ctx, seriesId, { signal }).then(
          (item) => {
            if (signal.aborted) return;
            setState((s) =>
              s.status === "ready"
                ? { ...s, overview: item.overview ? cleanOverview(item.overview) : s.overview, genres: item.genres ?? s.genres }
                : s,
            );
          },
          () => undefined,
        );
      } catch (err) {
        if (!signal.aborted) setState({ status: "error", error: errorMessage(err) });
      }
    })();
    return () => ctl.abort();
    // `series` und `jellyfin` bewusst nur über ihre Werte: ein neues Objekt mit gleichem Inhalt lädt nicht neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, seriesId, url, apiKey, userId, series.id, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const patch = useCallback((key: string, p: EpisodePatch) => {
    setState((s) =>
      s.status === "ready" ? { ...s, episodes: s.episodes.map((e) => (e.key === key ? patchEpisode(e, p) : e)) } : s,
    );
  }, []);

  const loadDetails = useCallback(
    (key: string) => {
      const ctx = ctxRef.current;
      const signal = abortRef.current?.signal;
      if (!ctx || !signal || requested.current.has(key)) return;
      const jfId = key.replace(/^jf\//, "");
      requested.current.add(key);
      getItem(ctx, jfId, { signal }).then(
        (item) => {
          if (signal.aborted) return;
          patch(key, {
            ...(item.overview ? { overview: cleanOverview(item.overview) } : {}),
            ...(item.premiereDate ? { premiere: item.premiereDate } : {}),
          });
        },
        () => requested.current.delete(key),
      );
    },
    [patch],
  );

  const setPlayed = useCallback(
    async (key: string, played: boolean) => {
      const ctx = ctxRef.current;
      if (ctx && !demo) {
        await setItemPlayed(ctx, key.replace(/^jf\//, ""), played, { signal: abortRef.current?.signal });
      }
      patch(key, playedPatch(played));
    },
    [demo, patch],
  );

  return useMemo<SeriesData>(() => {
    if (state.status !== "ready") {
      return {
        status: state.status,
        error: state.status === "error" ? state.error : undefined,
        episodes: [],
        playlist: [],
        overview: series.description ?? "",
        genres: [],
        next: null,
        demo,
        loadDetails,
        setPlayed,
        retry,
      };
    }
    const { episodes } = state;
    // Laut Server, solange die Folge noch nicht gesehen ist; sonst (oder ohne Angabe) lokal. Alles gesehen = null.
    const byServer = state.serverNext ? episodes.find((e) => e.key === state.serverNext) : undefined;
    const open = episodes.some((e) => !e.played && e.season !== 0);
    const next = byServer && !byServer.played ? byServer : open ? pickContinue(episodes) : null;
    return {
      status: "ready",
      episodes,
      playlist: episodes.map((e) => e.entry),
      overview: state.overview,
      genres: state.genres,
      next,
      demo,
      loadDetails,
      setPlayed,
      retry,
    };
  }, [state, demo, series.description, loadDetails, setPlayed, retry]);
}
