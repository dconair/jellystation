import type { XmbEntry } from "../data/types";
import { isAbortError } from "../jellyfin/errors";
import { fetchCatalogSearch, findSearchCatalog } from "./api";
import { entryOfMeta } from "./library";
import { getManifest } from "./manifests";
import type { StremioAddonCfg, StremioType } from "./types";

/** So viele Treffer pro Typ zeigt die Suche höchstens. */
const SEARCH_LIMIT = 30;

export interface StremioSearchResult {
  movies: XmbEntry[];
  series: XmbEntry[];
  /** Anzahl der Addons, die eine Suche anbieten und gefragt wurden. */
  asked: number;
  /** Addons, die nicht geantwortet haben. */
  failedAddons: string[];
}

/** Sucht in allen Addons, deren Katalog eine Suche versteht (Cinemeta tut das), gleichzeitig. Gleiche Titel erscheinen einmal. */
export async function searchStremio(addons: readonly StremioAddonCfg[], query: string, signal: AbortSignal): Promise<StremioSearchResult> {
  const types: StremioType[] = ["movie", "series"];
  const parts = await Promise.all(
    addons.map(async (addon) => {
      try {
        const manifest = await getManifest(addon, signal);
        const jobs = types.flatMap((type) => {
          const catalog = findSearchCatalog(manifest, type);
          return catalog ? [{ type, catalog }] : [];
        });
        if (jobs.length === 0) return null;
        const lists = await Promise.all(
          jobs.map(async ({ type, catalog }) => {
            const metas = await fetchCatalogSearch(addon.url, type, catalog.id, query, signal);
            return metas.map((m) => ({ type, entry: entryOfMeta(m, addon.id, type) }));
          }),
        );
        return lists.flat();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return addon.name;
      }
    }),
  );
  const result: StremioSearchResult = { movies: [], series: [], asked: 0, failedAddons: [] };
  const seen = new Set<string>();
  for (const part of parts) {
    if (part === null) continue;
    result.asked += 1;
    if (typeof part === "string") {
      result.failedAddons.push(part);
      continue;
    }
    for (const { type, entry } of part) {
      const key = `${type}/${entry.stremio?.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = type === "movie" ? result.movies : result.series;
      if (list.length < SEARCH_LIMIT) list.push(entry);
    }
  }
  return result;
}
