import { useCallback, useEffect, useMemo, useState } from "react";
import type { XmbEntry } from "../data/types";
import { loadStremioLibrary } from "./library";
import type { StremioAddonCfg } from "./types";

export interface StremioLibraryState {
  /** "idle" = keine Addons eingetragen, es wird nichts geladen. */
  status: "idle" | "loading" | "ok" | "error";
  movies: XmbEntry[];
  series: XmbEntry[];
  problems: string[];
  reload: () => void;
}

const NONE: XmbEntry[] = [];

/** Lädt die Kataloge, sobald sich die Addon-Liste ändert (Adressen als Schlüssel), und auf Wunsch neu. */
export function useStremioLibrary(addons: readonly StremioAddonCfg[] | undefined): StremioLibraryState {
  const key = (addons ?? []).map((a) => `${a.id}|${a.url}`).join("\n");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const [settled, setSettled] = useState<{ key: string; movies: XmbEntry[]; series: XmbEntry[]; problems: string[] } | null>(null);

  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    const list = key.split("\n").map((line) => {
      const [id, url] = line.split("|");
      return addons?.find((a) => a.id === id && a.url === url);
    });
    loadStremioLibrary(list.filter((a): a is StremioAddonCfg => !!a), ctl.signal).then(
      (lib) => !ctl.signal.aborted && setSettled({ key, ...lib }),
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        setSettled({ key, movies: NONE, series: NONE, problems: [err instanceof Error ? err.message : "Unerwarteter Fehler"] });
      },
    );
    return () => ctl.abort();
    // `addons` selbst ändert sich bei jedem Speichern – maßgeblich ist der Schlüssel.
  }, [key, nonce]);

  return useMemo<StremioLibraryState>(() => {
    if (!key) return { status: "idle", movies: NONE, series: NONE, problems: [], reload };
    if (!settled || settled.key !== key) return { status: "loading", movies: NONE, series: NONE, problems: [], reload };
    const empty = settled.movies.length + settled.series.length === 0;
    return { status: empty && settled.problems.length > 0 ? "error" : "ok", movies: settled.movies, series: settled.series, problems: settled.problems, reload };
  }, [key, settled, reload]);
}
