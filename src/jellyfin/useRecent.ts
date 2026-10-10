import { useCallback, useEffect, useState } from "react";
import type { XmbEntry } from "../data/types";
import { getJfContext } from "./context";
import type { JfConfig } from "./context";
import { fetchRecent } from "./recent";

const NONE: XmbEntry[] = [];

/** Lädt „Zuletzt gesehen“ von Jellyfin (neu mit `reload()`, z. B. nachdem der Player geschlossen wurde). Fehler → leere Liste. */
export function useRecentJellyfin(config: JfConfig | null): { entries: XmbEntry[]; reload: () => void } {
  const [entries, setEntries] = useState<XmbEntry[]>(NONE);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const url = config?.url ?? "";
  const apiKey = config?.apiKey ?? "";
  const userId = config?.userId ?? "";

  useEffect(() => {
    if (!url || !apiKey) {
      setEntries(NONE);
      return;
    }
    const ctl = new AbortController();
    void (async () => {
      try {
        const ctx = await getJfContext({ url, apiKey, userId: userId || undefined }, { signal: ctl.signal });
        const list = await fetchRecent(ctx, ctl.signal);
        if (!ctl.signal.aborted) setEntries(list);
      } catch (err) {
        if (!ctl.signal.aborted) console.info("Jellyfin: „Zuletzt gesehen“ nicht geladen –", err instanceof Error ? err.message : err);
      }
    })();
    return () => ctl.abort();
  }, [url, apiKey, userId, nonce]);

  return { entries, reload };
}
