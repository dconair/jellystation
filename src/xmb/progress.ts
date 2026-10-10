import type { XmbEntry } from "../data/types";

const TICKS_PER_SECOND = 10_000_000;

export interface WatchState {
  /** 0..1 – wie weit der Titel schon gesehen ist (nur bei begonnenen, nicht abgeschlossenen Titeln). */
  ratio: number;
  /** true = ganz gesehen (Haken anzeigen). */
  played: boolean;
  /** Gespeicherte Position in Sekunden (0 = nicht begonnen). */
  resumeSec: number;
  /** Rest der Laufzeit in Sekunden, falls bekannt. */
  remainingSec?: number;
}

/** Ab diesem Anteil gilt ein Titel als gesehen (wie in Jellyfin: Rest unter ~5 %). */
export const PLAYED_RATIO = 0.95;
/** Positionen unter dieser Zahl (Sekunden) zählen nicht als "begonnen" (versehentlich angetippt). */
export const MIN_RESUME_SEC = 10;

/** Fortschritt eines Jellyfin-Eintrags für Balken, Haken und "Fortsetzen"; null bei Einträgen ohne Jellyfin-Bezug. */
export function watchState(entry: XmbEntry): WatchState | null {
  const j = entry.jellyfin;
  if (!j || j.type === "Series") return null;
  const total = (j.runTimeTicks ?? 0) / TICKS_PER_SECOND;
  const pos = (j.resumeTicks ?? 0) / TICKS_PER_SECOND;
  const ratio = total > 0 ? Math.min(1, pos / total) : 0;
  if (pos >= MIN_RESUME_SEC && ratio < PLAYED_RATIO) {
    return { ratio, played: false, resumeSec: pos, remainingSec: total > 0 ? total - pos : undefined };
  }
  return { ratio: 0, played: Boolean(j.played) || ratio >= PLAYED_RATIO, resumeSec: 0 };
}

/** h:mm:ss bzw. m:ss. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** "1 Std. 05 Min." / "42 Min." */
export function formatRemaining(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${String(m).padStart(2, "0")} Min.` : `${m} Min.`;
}
