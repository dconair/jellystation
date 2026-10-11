import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { XmbEntry } from "../data/types";
import { getJfContext } from "../jellyfin/context";
import type { JfConfig, JfContext } from "../jellyfin/context";
import { setItemPlayed } from "../jellyfin/items";
import { getMovieInfo } from "../jellyfin/movie";
import type { MovieInfo } from "../jellyfin/movie";

export interface MovieData {
  status: "loading" | "ready" | "error";
  error?: string;
  /** Logo, Spuren, Besetzung … – fehlt, solange es lädt, bei einem Fehler und bei Demo-Filmen. */
  info: MovieInfo | null;
  /** true = Demo-Film ohne Server. */
  demo: boolean;
  /** Markiert den Film als gesehen/ungesehen (beim Server; in der Demo gibt es das nicht). Wirft bei einem Fehler. */
  setPlayed: (played: boolean) => Promise<void>;
  retry: () => void;
}

const errorMessage = (err: unknown) => (err instanceof Error && err.message ? err.message : "Unerwarteter Fehler");

/** Lädt die Details eines Jellyfin-Films (mit Abbruch beim Schließen). Ohne Jellyfin-Bezug bleibt alles leer. */
export function useMovieData(movie: XmbEntry, jellyfin: JfConfig | null): MovieData {
  const movieId = movie.jellyfin?.id ?? "";
  const url = jellyfin?.url ?? "";
  const apiKey = jellyfin?.apiKey ?? "";
  const userId = jellyfin?.userId ?? "";
  const demo = !movieId || !url || !apiKey;

  const [state, setState] = useState<{ status: MovieData["status"]; info: MovieInfo | null; error?: string }>({
    status: demo ? "ready" : "loading",
    info: null,
  });
  const [attempt, setAttempt] = useState(0);
  const ctxRef = useRef<JfContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    ctxRef.current = null;
    if (demo) {
      setState({ status: "ready", info: null });
      return;
    }
    setState({ status: "loading", info: null });
    const ctl = new AbortController();
    abortRef.current = ctl;
    const { signal } = ctl;
    void (async () => {
      try {
        const ctx = await getJfContext({ url, apiKey, ...(userId ? { userId } : {}) }, { signal });
        ctxRef.current = ctx;
        const info = await getMovieInfo(ctx, movieId, { signal });
        if (!signal.aborted) setState({ status: "ready", info });
      } catch (err) {
        if (!signal.aborted) setState({ status: "error", info: null, error: errorMessage(err) });
      }
    })();
    return () => ctl.abort();
  }, [demo, movieId, url, apiKey, userId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const setPlayed = useCallback(
    async (played: boolean) => {
      const ctx = ctxRef.current;
      if (!ctx) throw new Error("Keine Verbindung zum Server");
      await setItemPlayed(ctx, movieId, played, { signal: abortRef.current?.signal });
    },
    [movieId],
  );

  return useMemo(
    () => ({ status: state.status, error: state.error, info: state.info, demo, setPlayed, retry }),
    [state, demo, setPlayed, retry],
  );
}
