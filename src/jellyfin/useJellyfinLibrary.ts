import { useEffect, useMemo, useState } from "react";
import type { XmbEntry } from "../data/types";
import { fetchJellyfinLibrary, JellyfinError } from "./library";

export interface JellyfinLibraryState {
  /** "idle" = nicht konfiguriert, es wird nichts geladen. */
  status: "idle" | "loading" | "ok" | "error";
  movies: XmbEntry[];
  series: XmbEntry[];
  /** Kurze deutsche Fehlermeldung bei status "error". */
  error?: string;
  /** Hinweis, wenn der Server mehr Titel hat als geladen wurden (siehe fetchJellyfinLibrary). */
  truncated?: string;
}

const NONE: XmbEntry[] = [];

/** Ergebnis einer abgeschlossenen Anfrage, samt der Zugangsdaten, zu denen es gehört. */
type Settled = { id: string } & (
  | { ok: true; movies: XmbEntry[]; series: XmbEntry[]; truncated?: string }
  | { ok: false; error: string }
);

/**
 * Lädt Filme und Serien einmal pro Zugangsdaten-Paar (Adresse + API-Key). Ohne beides passiert nichts.
 * Ändern sich die Daten oder wird die Komponente entfernt, bricht die laufende Anfrage ab.
 */
export function useJellyfinLibrary(jellyfin: { url: string; apiKey: string } | undefined): JellyfinLibraryState {
  const url = jellyfin?.url.trim() ?? "";
  const apiKey = jellyfin?.apiKey.trim() ?? "";
  const configured = url !== "" && apiKey !== "";
  // Das Ergebnis trägt die Zugangsdaten, zu denen es gehört – ein veraltetes zählt als "loading".
  const id = `${url}\n${apiKey}`;
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!configured) return;
    const ctl = new AbortController();
    fetchJellyfinLibrary(url, apiKey, ctl.signal).then(
      (lib) => {
        if (ctl.signal.aborted) return;
        setSettled({ id, ok: true, movies: lib.movies, series: lib.series, truncated: lib.truncated });
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        console.info("Jellyfin: Bibliothek nicht geladen –", err instanceof Error ? err.message : err);
        setSettled({
          id,
          ok: false,
          error: err instanceof JellyfinError ? err.message : "Unerwarteter Fehler",
        });
      },
    );
    return () => ctl.abort();
  }, [configured, url, apiKey, id]);

  return useMemo<JellyfinLibraryState>(() => {
    if (!configured) return { status: "idle", movies: NONE, series: NONE };
    if (!settled || settled.id !== id) return { status: "loading", movies: NONE, series: NONE };
    if (!settled.ok) return { status: "error", movies: NONE, series: NONE, error: settled.error };
    return { status: "ok", movies: settled.movies, series: settled.series, truncated: settled.truncated };
  }, [configured, id, settled]);
}
