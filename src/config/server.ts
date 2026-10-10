import { normalizeServerUrl } from "../jellyfin/url";

/**
 * Vorgaben für den Heimserver: Adresse im Heimnetz und Tailscale-Adresse für unterwegs (beide Jellyfin-Port 8096).
 * Sie füllen den Setup-Assistenten vor, solange nichts gespeichert ist. Gespeicherte Adressen haben immer Vorrang.
 */
export const DEFAULT_SERVER_URL = "http://192.168.178.169:8096";
export const DEFAULT_ALT_URL = "http://100.78.48.119:8096";

/**
 * Zweite Adresse, die zur Hauptadresse passt: nur für den Standard-Server vorgegeben, damit sie nie zu einem
 * anderen Server gehört, den jemand eingetragen hat.
 */
export const defaultAltFor = (url: string): string =>
  normalizeServerUrl(url) === DEFAULT_SERVER_URL ? DEFAULT_ALT_URL : "";
