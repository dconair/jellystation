import { normalizeAddonUrl, parseManifest, postStremioApi, StremioError } from "./api";
import { primeManifest } from "./manifests";
import type { Manifest, StremioAccount } from "./types";

/*
 * Stremio-Konto (api.strem.io): `login` gibt einen `authKey` zurück, `addonCollectionGet` die Addons des Kontos samt
 * Manifest. Das Passwort wird nur für den Login gesendet und nicht gespeichert.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Ein Addon aus dem Konto: Adresse der manifest.json und das mitgelieferte Manifest. */
export interface AccountAddon {
  url: string;
  name: string;
  manifest: Manifest;
}

function apiError(json: unknown): StremioError | null {
  const e = obj(obj(json)?.error);
  if (!e) return null;
  const message = str(e.message);
  if (/passphrase|password|not found|user/i.test(message)) return new StremioError("E-Mail oder Passwort stimmt nicht");
  if (/session|auth/i.test(message)) return new StremioError("Die Anmeldung bei Stremio ist abgelaufen – bitte neu anmelden");
  return new StremioError(message ? `Stremio: ${message}` : "Stremio hat die Anfrage abgelehnt");
}

export async function stremioLogin(email: string, password: string, signal?: AbortSignal): Promise<StremioAccount> {
  const json = await postStremioApi("login", { type: "Login", email, password, facebook: false }, signal);
  const err = apiError(json);
  if (err) throw err;
  const result = obj(obj(json)?.result);
  const authKey = str(result?.authKey);
  if (!authKey) throw new StremioError("Stremio hat keinen Anmeldeschlüssel geliefert");
  return { email: str(obj(result?.user)?.email) || email, authKey };
}

/** Meldet den Schlüssel bei Stremio ab; Fehler sind egal (der Schlüssel wird lokal ohnehin gelöscht). */
export async function stremioLogout(authKey: string): Promise<void> {
  try {
    await postStremioApi("logout", { type: "Logout", authKey });
  } catch {
    /* offline o. Ä. */
  }
}

/** Stremios „Lokale Dateien“-Addon (`http://127.0.0.1:11470/local-addon/…`) läuft nur in der Stremio-App – in dieser App nicht erreichbar. Selbst gehostete Addons auf localhost bleiben. */
const isLocalFilesAddon = (url: string) => {
  try {
    const u = new URL(url);
    return /\/local-addon\//i.test(u.pathname);
  } catch {
    return true;
  }
};

/** Die Addons des Kontos, die Kataloge, Infos oder Streams liefern (reine Untertitel-Addons u. Ä. fallen weg). */
export async function fetchAccountAddons(authKey: string, signal?: AbortSignal): Promise<AccountAddon[]> {
  const json = await postStremioApi("addonCollectionGet", { type: "AddonCollectionGet", authKey, update: true }, signal);
  const err = apiError(json);
  if (err) throw err;
  const list = obj(obj(json)?.result)?.addons;
  if (!Array.isArray(list)) throw new StremioError("Stremio hat keine Addon-Liste geliefert");
  const out: AccountAddon[] = [];
  for (const raw of list) {
    const o = obj(raw);
    const url = normalizeAddonUrl(str(o?.transportUrl));
    if (!o || !url || isLocalFilesAddon(url)) continue;
    let manifest: Manifest;
    try {
      manifest = parseManifest(o.manifest);
    } catch {
      continue;
    }
    if (!manifest.resources.some((r) => r.name === "catalog" || r.name === "meta" || r.name === "stream")) continue;
    primeManifest(url, manifest);
    out.push({ url, name: manifest.name.slice(0, 80), manifest });
  }
  return out;
}
