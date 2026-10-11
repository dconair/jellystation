import type { StremioAddonCfg, StremioSettings } from "./types";

/** Offizieller Katalog-Dienst von Stremio: liefert Kataloge und Infos, aber keine Streams. */
export const CINEMETA_URL = "https://v3-cinemeta.strem.io/manifest.json";

/** Kennung des von der App ergänzten Cinemeta (nicht in den Einstellungen gespeichert). */
export const IMPLICIT_ADDON_ID = "cinemeta";

export const newAddonId = () => Math.random().toString(36).slice(2, 10);

/**
 * Die Addons, mit denen die App arbeitet: die eingetragenen plus – falls keines davon Cinemeta ist – Cinemeta selbst.
 * Stream-Addons (Torrentio & Co.) haben keinen Katalog; die Titellisten kommen in Stremio von Cinemeta, das dort immer
 * mit installiert ist. Ohne Addons und ohne Konto bleibt die Liste leer (dann gibt es keine Stremio-Spalten).
 */
export function effectiveAddons(stremio: StremioSettings | undefined): StremioAddonCfg[] {
  if (!stremio || (stremio.addons.length === 0 && !stremio.account)) return [];
  if (stremio.addons.some((a) => a.url === CINEMETA_URL)) return stremio.addons;
  return [...stremio.addons, { id: IMPLICIT_ADDON_ID, url: CINEMETA_URL, name: "Cinemeta" }];
}

/**
 * Ersetzt die Konto-Addons der Liste durch die frisch geladenen (gleiche Adresse = gleiche Kennung, Reihenfolge wie in
 * Stremio) und lässt die von Hand eingetragenen stehen. Ein von Hand eingetragenes Addon verdrängt sein Konto-Gegenstück.
 */
export function mergeAccountAddons(current: readonly StremioAddonCfg[], fetched: readonly { url: string; name: string }[]): StremioAddonCfg[] {
  const manual = current.filter((a) => !a.fromAccount);
  const manualUrls = new Set(manual.map((a) => a.url));
  const known = new Map(current.filter((a) => a.fromAccount).map((a) => [a.url, a.id] as const));
  const seen = new Set<string>();
  const account: StremioAddonCfg[] = [];
  for (const f of fetched) {
    if (manualUrls.has(f.url) || seen.has(f.url)) continue;
    seen.add(f.url);
    account.push({ id: known.get(f.url) ?? newAddonId(), url: f.url, name: f.name, fromAccount: true });
  }
  return [...account, ...manual];
}

export function sameAddons(a: readonly StremioAddonCfg[], b: readonly StremioAddonCfg[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.url === b[i].url && x.name === b[i].name && !!x.fromAccount === !!b[i].fromAccount);
}
