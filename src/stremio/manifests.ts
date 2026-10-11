import { abortError } from "../jellyfin/errors";
import { fetchManifest } from "./api";
import type { Manifest, StremioAddonCfg } from "./types";

/**
 * Manifeste ändern sich selten – pro Adresse einmal laden. Fehlgeschlagene Abrufe bleiben nicht im Speicher.
 * Der Abruf gehört allen Aufrufern gemeinsam und läuft deshalb ohne deren Abbruch-Signal weiter (sonst würde ein
 * geschlossener Dialog das Manifest für alle anderen mit abbrechen); der Aufrufer wartet nur nicht länger darauf.
 */
const cache = new Map<string, Promise<Manifest>>();

export function getManifest(addon: Pick<StremioAddonCfg, "url">, signal?: AbortSignal): Promise<Manifest> {
  let hit = cache.get(addon.url);
  if (!hit) {
    hit = fetchManifest(addon.url);
    cache.set(addon.url, hit);
    hit.catch(() => cache.delete(addon.url));
  }
  if (!signal) return hit;
  const shared = hit;
  return new Promise<Manifest>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function forgetManifest(url: string) {
  cache.delete(url);
}

/** Legt ein schon bekanntes Manifest (etwa aus dem Stremio-Konto) in den Speicher, damit es nicht noch einmal geladen wird. */
export function primeManifest(url: string, manifest: Manifest) {
  if (!cache.has(url)) cache.set(url, Promise.resolve(manifest));
}
