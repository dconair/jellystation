import { useCallback, useEffect, useMemo, useState } from "react";
import type { XmbEntry } from "../data/types";
import { JfError } from "./errors";
import { fetchJellyfinLibrary } from "./library";

export interface JellyfinLibraryState {
  /** "idle" = nicht konfiguriert, es wird nichts geladen. */
  status: "idle" | "loading" | "ok" | "error";
  movies: XmbEntry[];
  series: XmbEntry[];
  /** Kurze deutsche Fehlermeldung bei status "error". */
  error?: string;
  /** Hinweis, wenn der Server mehr Titel hat als geladen wurden (siehe fetchJellyfinLibrary). */
  truncated?: string;
  /** Benutzer, dessen Wiedergabestände in den Einträgen stecken (gespeicherter oder zuletzt aktiver). */
  userId?: string;
  userName?: string;
  /**
   * Lädt die Bibliothek neu – etwa nach dem Schauen, damit Weiterschauen-Balken und Gesehen-Haken stimmen.
   * Die bisherigen Einträge bleiben bis zur neuen Antwort sichtbar (kein Aufblitzen der Ladeanzeige).
   */
  reload: () => void;
}

const NONE: XmbEntry[] = [];

/** Ergebnis einer abgeschlossenen Anfrage, samt der Zugangsdaten, zu denen es gehört. */
type Settled = { id: string } & (
  | { ok: true; movies: XmbEntry[]; series: XmbEntry[]; truncated?: string; userId?: string; userName?: string }
  | { ok: false; error: string }
);

/**
 * Lädt Filme und Serien einmal pro Zugangsdaten-Paar (Adresse + API-Key + Benutzer). Ohne Adresse und Key passiert nichts.
 * Ändern sich die Daten oder wird die Komponente entfernt, bricht die laufende Anfrage ab.
 */
export function useJellyfinLibrary(
  jellyfin: { url: string; apiKey: string; userId?: string } | undefined,
): JellyfinLibraryState {
  const url = jellyfin?.url.trim() ?? "";
  const apiKey = jellyfin?.apiKey.trim() ?? "";
  const userId = jellyfin?.userId ?? "";
  const configured = url !== "" && apiKey !== "";
  // Das Ergebnis trägt die Zugangsdaten, zu denen es gehört – ein veraltetes zählt als "loading".
  const id = `${url}\n${apiKey}\n${userId}`;
  const [settled, setSettled] = useState<Settled | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!configured) return;
    const ctl = new AbortController();
    fetchJellyfinLibrary(url, apiKey, ctl.signal, userId || undefined).then(
      (lib) => {
        if (ctl.signal.aborted) return;
        setSettled({
          id,
          ok: true,
          movies: lib.movies,
          series: lib.series,
          truncated: lib.truncated,
          userId: lib.userId,
          userName: lib.userName,
        });
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        console.info("Jellyfin: Bibliothek nicht geladen –", err instanceof Error ? err.message : err);
        const failed: Settled = {
          id,
          ok: false,
          error: err instanceof JfError ? err.message : "Unerwarteter Fehler",
        };
        // Scheitert nur das Auffrischen, bleiben die zuletzt geladenen Einträge stehen.
        setSettled((prev) => (prev && prev.ok && prev.id === id ? prev : failed));
      },
    );
    return () => ctl.abort();
  }, [configured, url, apiKey, userId, id, nonce]);

  return useMemo<JellyfinLibraryState>(() => {
    if (!configured) return { status: "idle", movies: NONE, series: NONE, reload };
    if (!settled || settled.id !== id) return { status: "loading", movies: NONE, series: NONE, reload };
    if (!settled.ok) return { status: "error", movies: NONE, series: NONE, error: settled.error, reload };
    return {
      status: "ok",
      movies: settled.movies,
      series: settled.series,
      truncated: settled.truncated,
      userId: settled.userId,
      userName: settled.userName,
      reload,
    };
  }, [configured, id, settled, reload]);
}
