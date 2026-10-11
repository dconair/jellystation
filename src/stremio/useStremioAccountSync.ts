import { useEffect, useRef } from "react";
import { fetchAccountAddons } from "./account";
import { mergeAccountAddons, sameAddons } from "./addons";
import type { StremioSettings } from "./types";

/**
 * Hält die Addons eines angemeldeten Stremio-Kontos aktuell: einmal pro App-Start (und Anmeldung) wird die Liste neu
 * geladen und in die Einstellungen übernommen, wenn sich etwas geändert hat. Schlägt das fehl (offline, Anmeldung
 * abgelaufen), bleibt die zuletzt gespeicherte Liste unverändert; der Dialog „Stremio-Addons“ zeigt den Fehler dann beim Neuladen.
 */
export function useStremioAccountSync(stremio: StremioSettings | undefined, onChange: (next: StremioSettings) => void) {
  const authKey = stremio?.account?.authKey;
  const latest = useRef({ stremio, onChange });
  latest.current = { stremio, onChange };

  useEffect(() => {
    if (!authKey) return;
    const ctl = new AbortController();
    fetchAccountAddons(authKey, ctl.signal).then(
      (list) => {
        const cur = latest.current.stremio;
        if (ctl.signal.aborted || cur?.account?.authKey !== authKey) return;
        const merged = mergeAccountAddons(cur.addons, list);
        if (!sameAddons(cur.addons, merged)) latest.current.onChange({ ...cur, addons: merged });
      },
      () => undefined,
    );
    return () => ctl.abort();
  }, [authKey]);
}
