import type { XmbEntry } from "../data/types";
import { hueFromTitle, shortenOverview } from "../jellyfin/library";
import { isAbortError } from "../jellyfin/errors";
import { fetchCatalog, firstCatalog } from "./api";
import { getManifest } from "./manifests";
import type { Meta, StremioAddonCfg, StremioType } from "./types";

/** So viele Titel pro Addon und Typ werden gezeigt (die XMB bleibt flüssig, ein Katalog liefert ohnehin eine Seite). */
export const STREMIO_ITEM_LIMIT = 100;

export interface StremioLibrary {
  movies: XmbEntry[];
  series: XmbEntry[];
  /** Addons, die nicht antworten oder keinen passenden Katalog haben: "Name: Grund". */
  problems: string[];
}

export function entryOfMeta(meta: Meta, addonId: string, type: StremioType): XmbEntry {
  const subtitle = [meta.year, meta.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  return {
    id: `st/${addonId}/${type}/${meta.id}`,
    title: meta.name,
    ...(subtitle ? { subtitle } : {}),
    ...(meta.description ? { description: shortenOverview(meta.description) } : {}),
    hue: hueFromTitle(meta.name),
    art: meta.poster ? { kind: "http", url: meta.poster } : { kind: "generated" },
    artShape: "poster",
    stremio: { addonId, type, id: meta.id },
  };
}

/** Lädt die erste Katalogseite für Filme und Serien aus allen Addons (Reihenfolge der Einstellungen, doppelte IDs nur einmal). */
export async function loadStremioLibrary(addons: readonly StremioAddonCfg[], signal: AbortSignal): Promise<StremioLibrary> {
  const parts = await Promise.all(
    addons.map(async (addon) => {
      const out = { movies: [] as XmbEntry[], series: [] as XmbEntry[], problem: "" };
      try {
        const manifest = await getManifest(addon, signal);
        const wanted: StremioType[] = ["movie", "series"];
        let found = false;
        for (const type of wanted) {
          const catalog = firstCatalog(manifest, type);
          if (!catalog) continue;
          found = true;
          const metas = await fetchCatalog(addon.url, type, catalog.id, signal);
          const entries = metas.slice(0, STREMIO_ITEM_LIMIT).map((m) => entryOfMeta(m, addon.id, type));
          (type === "movie" ? out.movies : out.series).push(...entries);
        }
        if (!found) out.problem = `${manifest.name}: keine Kataloge für Filme oder Serien`;
      } catch (err) {
        if (isAbortError(err)) throw err;
        out.problem = `${addon.name}: ${err instanceof Error ? err.message : "Fehler"}`;
      }
      return out;
    }),
  );
  const dedupe = (lists: XmbEntry[][]) => {
    const seen = new Set<string>();
    return lists.flat().filter((e) => {
      const key = `${e.stremio?.type}/${e.stremio?.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    movies: dedupe(parts.map((p) => p.movies)),
    series: dedupe(parts.map((p) => p.series)),
    problems: parts.map((p) => p.problem).filter(Boolean),
  };
}
