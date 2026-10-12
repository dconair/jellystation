import type { XmbEntry } from "../data/types";
import { hueFromTitle, shortenOverview } from "../jellyfin/library";
import { isAbortError } from "../jellyfin/errors";
import { fetchCatalog, listCatalogs } from "./api";
import { IMPLICIT_ADDON_ID } from "./addons";
import { getManifest } from "./manifests";
import type { Meta, StremioAddonCfg, StremioType } from "./types";

/** So viele Titel pro Addon und Typ werden gezeigt (die XMB bleibt flüssig, ein Katalog liefert ohnehin eine Seite). */
export const STREMIO_ITEM_LIMIT = 100;

/** So viele Katalog-Spalten (je Addon und Typ höchstens {@link CATALOGS_PER_TYPE}) zeigt das Menü insgesamt. */
export const STREMIO_COLUMN_LIMIT = 8;
const CATALOGS_PER_TYPE = 2;

/** Eine Spalte der XMB: ein Katalog eines Addons (z. B. „Beliebt – Filme“). */
export interface StremioColumn {
  id: string;
  label: string;
  type: StremioType;
  entries: XmbEntry[];
}

export interface StremioLibrary {
  columns: StremioColumn[];
  /** Addons, die nicht antworten oder keinen passenden Katalog haben: "Name: Grund". */
  problems: string[];
}

const CATALOG_NAMES: Record<string, string> = { popular: "Beliebt", new: "Neu", featured: "Empfohlen", trending: "Im Trend", top: "Top", "top rated": "Bestbewertet", discover: "Entdecken" };
const TYPE_LABEL: Record<StremioType, string> = { movie: "Filme", series: "Serien" };

/** „Popular“ → „Beliebt – Filme“; fremde Katalognamen bleiben, wie das Addon sie nennt. */
function columnLabel(catalogName: string, type: StremioType): string {
  const name = CATALOG_NAMES[catalogName.trim().toLowerCase()] ?? catalogName.trim();
  const label = TYPE_LABEL[type];
  return new RegExp(`\\b${label}\\b`, "i").test(name) ? name : `${name} – ${label}`;
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

/**
 * Lädt für jedes Addon die Startseiten-Kataloge (Filme und Serien) und macht je Katalog eine Spalte, in der Reihenfolge
 * der Addons. Stream-Addons ohne Katalog fallen leise weg; ein Problem wird nur gemeldet, wenn ein Addon antwortet,
 * aber nichts liefert, oder gar nicht erreichbar ist – und kein anderer Katalog den Ausfall deckt.
 */
export async function loadStremioLibrary(addons: readonly StremioAddonCfg[], signal: AbortSignal): Promise<StremioLibrary> {
  const parts = await Promise.all(
    addons.map(async (addon) => {
      const out = { columns: [] as StremioColumn[], problem: "", hasCatalogs: false, implicit: addon.id === IMPLICIT_ADDON_ID };
      try {
        const manifest = await getManifest(addon, signal);
        const wanted: StremioType[] = ["movie", "series"];
        const jobs = wanted.flatMap((type) =>
          listCatalogs(manifest, type)
            .slice(0, CATALOGS_PER_TYPE)
            .map((catalog) => ({ type, catalog })),
        );
        out.hasCatalogs = jobs.length > 0;
        const loaded = await Promise.all(
          jobs.map(async ({ type, catalog }) => {
            try {
              const metas = await fetchCatalog(addon.url, type, catalog.id, signal);
              const entries = metas.slice(0, STREMIO_ITEM_LIMIT).map((m) => entryOfMeta(m, addon.id, type));
              return { column: { id: `stremio/${addon.id}/${type}/${catalog.id}`, label: columnLabel(catalog.name, type), type, entries }, error: "" };
            } catch (err) {
              if (isAbortError(err)) throw err;
              return { column: null, error: err instanceof Error ? err.message : "Fehler" };
            }
          }),
        );
        out.columns = loaded.flatMap((l) => (l.column && l.column.entries.length > 0 ? [l.column] : []));
        const failed = loaded.find((l) => l.error);
        if (failed && out.columns.length === 0) out.problem = `${manifest.name}: ${failed.error}`;
      } catch (err) {
        if (isAbortError(err)) throw err;
        out.problem = `${addon.name}: ${err instanceof Error ? err.message : "Fehler"}`;
      }
      return out;
    }),
  );
  // Das stillschweigend ergänzte Cinemeta meldet einen Ausfall nur, wenn sonst gar nichts da ist.
  const columns = parts.flatMap((p) => p.columns).slice(0, STREMIO_COLUMN_LIMIT);
  const problems = parts.filter((p) => !p.implicit || columns.length === 0).map((p) => p.problem).filter(Boolean);
  // Gleiche Titel in mehreren Spalten sind in Ordnung (anderer Katalog); nur leere Spalten und Überlänge fallen weg.
  if (columns.length === 0 && problems.length === 0) {
    problems.push(
      parts.some((p) => p.hasCatalogs)
        ? "Die Kataloge sind leer"
        : "Keine Kataloge erreichbar – Internetverbindung prüfen oder unter Einstellungen → Verbindungen anmelden",
    );
  }
  return { columns, problems };
}
