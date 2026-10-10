import { isAbortError } from "../jellyfin/errors";
import { fetchMeta, fetchStreams, supports } from "./api";
import { getManifest } from "./manifests";
import type { Meta, StreamResult, StremioAddonCfg, StremioStream, StremioType } from "./types";

/** Vollständige Angaben zu einem Titel (bei Serien mit allen Folgen): erst das Addon des Katalogs, dann die übrigen. */
export async function loadMeta(
  addons: readonly StremioAddonCfg[],
  originId: string,
  type: StremioType,
  id: string,
  signal: AbortSignal,
): Promise<Meta> {
  const ordered = [...addons].sort((a, b) => Number(b.id === originId) - Number(a.id === originId));
  let lastError: unknown = null;
  for (const addon of ordered) {
    try {
      const manifest = await getManifest(addon, signal);
      if (!supports(manifest, "meta", type, id)) continue;
      return await fetchMeta(addon.url, type, id, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error("Kein Addon liefert Angaben zu diesem Titel");
}

/**
 * Fragt alle Addons, die für Typ und ID Streams anbieten, gleichzeitig ab. Ein Addon, das nicht antwortet,
 * hält die anderen nicht auf (es landet in `failedAddons`).
 */
export async function findStreams(
  addons: readonly StremioAddonCfg[],
  type: StremioType,
  id: string,
  signal: AbortSignal,
): Promise<StreamResult> {
  const result: StreamResult = { playable: [], skipped: 0, failedAddons: [], asked: 0 };
  const parts = await Promise.all(
    addons.map(async (addon) => {
      try {
        const manifest = await getManifest(addon, signal);
        if (!supports(manifest, "stream", type, id)) return null;
        return await fetchStreams(addon.url, addon.id, manifest.name, type, id, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        return addon.name;
      }
    }),
  );
  for (const part of parts) {
    if (part === null) continue;
    result.asked += 1;
    if (typeof part === "string") {
      result.failedAddons.push(part);
      continue;
    }
    result.playable.push(...part.playable);
    result.skipped += part.skipped;
  }
  return result;
}

export const streamLabel = (s: StremioStream) => s.name || "Stream";
