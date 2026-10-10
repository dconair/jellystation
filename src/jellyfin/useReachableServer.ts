import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../settings/settings";
import { isValidServerUrl, normalizeServerUrl } from "./url";
import { pingServer } from "./testConnection";

type JellyfinSettings = Settings["jellyfin"];

/**
 * Wählt zwischen Hauptadresse und zweiter Adresse (z. B. Tailscale) die, die gerade antwortet.
 * Geprüft wird beim Start, wenn das Netz wechselt (online), beim Zurückkehren ins Fenster und – solange
 * nichts antwortet – alle 20 s. Ohne zweite Adresse bleibt alles beim Alten (keine Netzwerkanfrage).
 */
export function useReachableServer(config: JellyfinSettings | null): JellyfinSettings | null {
  const url = config?.url ?? "";
  const alt = config?.altUrl ?? "";
  const hasAlt = !!alt.trim() && isValidServerUrl(alt) && normalizeServerUrl(alt) !== normalizeServerUrl(url);
  const [active, setActive] = useState<{ primary: string; url: string } | null>(null);

  useEffect(() => {
    if (!hasAlt || !url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      let chosen: string | null = null;
      // Beide gleichzeitig prüfen; die Hauptadresse hat Vorrang, wenn beide antworten.
      const [a, b] = await Promise.all([pingServer(url), pingServer(alt)]);
      if (a) chosen = url;
      else if (b) chosen = alt;
      if (cancelled) return;
      if (chosen) setActive({ primary: url, url: chosen });
      else timer = setTimeout(() => void check(), 20_000);
    };
    const recheck = () => {
      if (timer) clearTimeout(timer);
      void check();
    };
    void check();
    window.addEventListener("online", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [url, alt, hasAlt]);

  return useMemo(() => {
    if (!config) return null;
    if (!hasAlt || !active || active.primary !== url) return config;
    return active.url === config.url ? config : { ...config, url: active.url };
  }, [config, hasAlt, active, url]);
}
