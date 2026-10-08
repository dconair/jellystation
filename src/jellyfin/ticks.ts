/** Jellyfin zählt Zeiten in Ticks zu 100 ns: 10 000 000 Ticks = 1 Sekunde. */
export const TICKS_PER_SECOND = 10_000_000;

export const secToTicks = (sec: number): number =>
  Number.isFinite(sec) && sec > 0 ? Math.round(sec * TICKS_PER_SECOND) : 0;

export const ticksToSec = (ticks: number | undefined | null): number =>
  typeof ticks === "number" && Number.isFinite(ticks) && ticks > 0 ? ticks / TICKS_PER_SECOND : 0;
