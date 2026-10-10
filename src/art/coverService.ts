import type { ArtSource, XmbEntry } from "../data/types";
import { isTauri } from "../platform";

/**
 * Hülle um die Rust-Befehle für automatische Spiele-Cover (src-tauri/src/covers.rs).
 *
 * Nur in der Tauri-App; im Browser und bei Demo-Spielen passiert nichts. Die Bilder liegen im App-Cache
 * (`$APPCACHE/covers/…`) und werden wie jede lokale Datei über den ArtLoader gelesen
 * (Rechte: src-tauri/capabilities/library.json).
 */

export type CoverOrigin = "embedded" | "online" | "cache";

export interface CoverResult {
  /** Bilddatei im Cache; null = kein Cover gefunden. */
  path: string | null;
  source: CoverOrigin | null;
  width: number | null;
  height: number | null;
  /** Seriennummer bzw. Spiel-ID, falls im Spiel gefunden. */
  serial: string | null;
  /** Netzproblem, das die Suche verhindert hat (kein „nicht gefunden“). */
  error: string | null;
}

export interface CoverRequest {
  /** Eintrags-ID des Spiels (nur für den Aufrufer). */
  id: string;
  system: string;
  path: string;
  title: string;
}

export interface CacheStats {
  count: number;
  bytes: number;
}

export const coversSupported = () => isTauri();

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Sucht das Cover zu einem Spiel. `online: false` holt nichts aus dem Netz; `retry` ignoriert Merker „nicht gefunden“. */
export function resolveCover(request: CoverRequest, options: { online: boolean; retry?: boolean }): Promise<CoverResult> {
  return call<CoverResult>("cover_resolve", {
    system: request.system,
    path: request.path,
    title: request.title,
    online: options.online,
    retry: options.retry ?? false,
  });
}

export const coverCacheStats = () => call<CacheStats>("cover_cache_stats");
export const clearCoverCache = () => call<{ removed: number; bytes: number }>("cover_cache_clear");

/**
 * Hochformat (Boxart) oder Querformat (Spielsymbol, Screenshot)? Fast quadratische Cover zählen als Hochformat:
 * Sie werden nie beschnitten, sondern ganz gezeigt (siehe ArtImage).
 */
export function coverShape(result: Pick<CoverResult, "width" | "height" | "source">): "poster" | "landscape" {
  const { width, height } = result;
  if (width && height) return width / height >= 1.3 ? "landscape" : "poster";
  return result.source === "embedded" ? "landscape" : "poster";
}

/** Eintrag mit neuem Cover (alles andere, vor allem die ID, bleibt gleich). */
export function withCover(entry: XmbEntry, result: CoverResult): XmbEntry {
  if (!result.path) return entry;
  return { ...entry, art: { kind: "file", path: result.path }, artShape: coverShape(result) };
}

/** Eintrag zurück auf das generierte Cover. */
export function withoutCover(entry: XmbEntry): XmbEntry {
  const art: ArtSource = { kind: "generated" };
  return { ...entry, art, artShape: "landscape" };
}

/** Kürzel für Größen im Menü: „4,2 MB“. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("de-DE", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/* ------------------------------------------------------------------ Warteschlange */

/** So viele Suchen laufen höchstens gleichzeitig (der Rust-Teil begrenzt zusätzlich die Netzabrufe). */
export const COVER_PARALLEL = 2;

export interface CoverJobSummary {
  /** Spiele, für die ein Ergebnis vorliegt (mit oder ohne Cover). */
  done: number;
  total: number;
  /** Davon mit Cover. */
  found: number;
  /** Anfragen, die mit einem Fehler endeten (kein Netz, Befehl abgelehnt). */
  failed: number;
  /** Erste Fehlermeldung, falls es welche gab. */
  error: string | null;
  cancelled: boolean;
}

export interface CoverJobOptions {
  online: boolean;
  retry?: boolean;
  parallel?: number;
  /** Wird für jedes gefundene Cover aufgerufen (nicht für Spiele ohne Cover). */
  onFound: (request: CoverRequest, result: CoverResult) => void;
  onProgress?: (summary: CoverJobSummary) => void;
}

export interface CoverJob {
  /** Hört auf, neue Spiele zu beginnen; schon laufende Anfragen werden noch abgewartet, ihre Ergebnisse aber verworfen. */
  cancel(): void;
  readonly done: Promise<CoverJobSummary>;
}

/**
 * Arbeitet die Spiele der Reihe nach ab, höchstens `parallel` gleichzeitig. Ein Fehler bei einem Spiel
 * bricht die übrigen nicht ab. `resolve` ist austauschbar (Tests).
 */
export function startCoverJob(
  requests: readonly CoverRequest[],
  options: CoverJobOptions,
  resolve: typeof resolveCover = resolveCover,
): CoverJob {
  const summary: CoverJobSummary = { done: 0, total: requests.length, found: 0, failed: 0, error: null, cancelled: false };
  let next = 0;
  let cancelled = false;

  const worker = async () => {
    while (!cancelled && next < requests.length) {
      const request = requests[next++];
      try {
        const result = await resolve(request, { online: options.online, retry: options.retry });
        if (cancelled) return;
        if (result.path) {
          summary.found++;
          options.onFound(request, result);
        } else if (result.error) {
          summary.failed++;
          summary.error ??= result.error;
        }
      } catch (err) {
        if (cancelled) return;
        summary.failed++;
        summary.error ??= typeof err === "string" ? err : err instanceof Error ? err.message : "Unerwarteter Fehler";
      }
      summary.done++;
      options.onProgress?.({ ...summary });
    }
  };

  const parallel = Math.max(1, options.parallel ?? COVER_PARALLEL);
  const done = Promise.all(Array.from({ length: Math.min(parallel, requests.length) }, worker)).then(() => ({
    ...summary,
    cancelled,
  }));

  return {
    cancel() {
      cancelled = true;
      summary.cancelled = true;
    },
    done,
  };
}
