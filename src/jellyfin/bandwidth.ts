import { mediaUrl } from "./context";
import type { JfContext } from "./context";

/*
 * Bandbreitentest für „Automatisch“: Bevor ein Titel geplant wird, holt der Player einen kleinen Testblock vom
 * Server (`GET /Playback/BitrateTest`, wie jellyfin-web) und misst, wie schnell er ankommt. Daraus ergibt sich die
 * Bitrate-Grenze für die Planung: Reicht die Leitung für das Original nicht (WLAN, Tailscale, Mobilfunk), wandelt der
 * Server gleich passend um, statt dass der Player ständig nachpuffert. Das Ergebnis gilt kurz und wird je Server gemerkt.
 */

/** Größe des Testblocks. */
const TEST_BYTES = 4_000_000;
/** So lange darf der Test höchstens dauern; danach zählt, was bis dahin ankam. */
const TEST_MAX_MS = 2500;
/** Ein Ergebnis gilt so lange (Netz und Tageszeit ändern sich, ein Titelwechsel soll aber nicht jedes Mal messen). */
const CACHE_MS = 5 * 60_000;
/** Nur ein Teil der gemessenen Rate gilt als sicher nutzbar (Schwankungen, Server-Aufschläge, Ton, Untertitel). */
const SAFETY = 0.7;
/** Darunter ist Umwandeln sinnlos; auch bei schlechter Messung bleibt dem Player dieses Minimum. */
const FLOOR_BPS = 1_500_000;
/** Ab hier gilt die Leitung als schnell genug für alles, was der Player abspielt. */
const UNLIMITED_BPS = 120_000_000;

const cache = new Map<string, { at: number; bps: number | null }>();

/** Gemessene Rate in Bit/s aus Byteanzahl und Zeit; `null` = Messung unbrauchbar. */
export function rateFromSample(bytes: number, ms: number): number | null {
  if (!(bytes >= 250_000) || !(ms > 0)) return null;
  return (bytes * 8 * 1000) / ms;
}

/** Bitrate-Grenze für die Planung aus einer gemessenen Rate; `undefined` = keine Grenze nötig. */
export function limitFromRate(bps: number | null): number | undefined {
  if (bps === null) return undefined;
  const limit = Math.round(bps * SAFETY);
  if (limit >= UNLIMITED_BPS) return undefined;
  return Math.max(FLOOR_BPS, limit);
}

async function measure(ctx: JfContext, outer: AbortSignal | undefined): Promise<number | null> {
  const ctl = new AbortController();
  const onOuter = () => ctl.abort();
  outer?.addEventListener("abort", onOuter);
  if (outer?.aborted) ctl.abort();
  const stop = window.setTimeout(() => ctl.abort(), TEST_MAX_MS + 1500);
  try {
    const res = await fetch(mediaUrl(ctx, `/Playback/BitrateTest?Size=${TEST_BYTES}`), {
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    // Gemessen wird ab dem ersten Datenblock: Die Antwortzeit des Servers gehört nicht zur Leitung.
    let bytes = 0;
    let first = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      const now = performance.now();
      if (value) {
        if (!first) first = now;
        else bytes += value.byteLength;
        last = now;
      }
      if (done || (first && now - first >= TEST_MAX_MS)) break;
    }
    void reader.cancel().catch(() => undefined);
    return first ? rateFromSample(bytes, last - first) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(stop);
    outer?.removeEventListener("abort", onOuter);
  }
}

/**
 * Bitrate-Grenze für „Automatisch“ (Bit/s); `undefined` = keine Grenze (schnelle Leitung oder Messung nicht möglich –
 * dann bleibt alles wie ohne Test). Wirft nie; ein Abbruch von außen liefert `undefined`.
 */
export async function autoBitrateLimit(ctx: JfContext, signal?: AbortSignal): Promise<number | undefined> {
  const key = ctx.base;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return limitFromRate(hit.bps);
  const bps = await measure(ctx, signal);
  if (signal?.aborted) return undefined;
  cache.set(key, { at: Date.now(), bps });
  return limitFromRate(bps);
}

/** Vergisst gemessene Raten (nach einem Serverwechsel oder auf Wunsch). */
export function forgetBandwidth(): void {
  cache.clear();
}
