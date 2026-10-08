import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../platform";
import { EMULATORS } from "./catalog";
import { NO_BREW, cachedDetection, detectEmulators } from "./detect";
import type { BrewInfo } from "./detect";
import { pendingStatus } from "./status";
import type { EmulatorStatus } from "./status";

export interface EmulatorsState {
  /** Ein Eintrag je Katalog-Emulator (Reihenfolge wie im Katalog). */
  statuses: EmulatorStatus[];
  /** true, solange gesucht wird (erste Suche und jede explizite Suche). */
  loading: boolean;
  /** Sucht neu (z. B. nach einer Installation) und liefert das frische Ergebnis. */
  refresh: () => Promise<EmulatorStatus[]>;
  /** Homebrew vorhanden? `command` ist der Programmname für den Shell-Scope. */
  brew: BrewInfo;
}

/**
 * Erkennt die Emulatoren des Katalogs.
 *
 * - `overrides` sind die gewählten Pfade (settings.emulators, Emulator-ID → Pfad). Ändern sie sich, wird neu geprüft.
 * - Das Ergebnis wird zwischengespeichert: Ein weiterer Aufruf mit denselben Einstellungen (anderer Bildschirm,
 *   neu eingehängte Komponente) zeigt es sofort. Beim Fokuswechsel des Fensters wird NICHT neu gesucht –
 *   dafür gibt es `refresh()`.
 * - Im Browser (ohne Tauri) sind alle Emulatoren „nicht prüfbar“ (`checkable: false`), ohne Fehler.
 */
export function useEmulators(overrides?: Record<string, string>): EmulatorsState {
  // Der Schlüssel hängt am Inhalt, nicht an der Objektidentität: Ein neu erzeugtes, gleiches Objekt löst keine Suche aus.
  const key = useMemo(
    () => JSON.stringify(Object.entries(overrides ?? {}).filter(([, v]) => v).sort(([a], [b]) => (a < b ? -1 : 1))),
    [overrides],
  );
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  const [state, setState] = useState(() => {
    const cached = cachedDetection(overrides);
    return cached
      ? { statuses: cached.statuses, brew: cached.brew, loading: false }
      : { statuses: EMULATORS.map(pendingStatus), brew: NO_BREW, loading: isTauri() };
  });

  // Nummer des jüngsten Laufs: Antworten überholter Läufe werden verworfen.
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const search = useCallback((force: boolean) => {
    const mine = ++run.current;
    // Im Browser gibt es nichts zu suchen – kein kurzes Aufblitzen der Ladeanzeige.
    if (isTauri()) setState((s) => (s.loading ? s : { ...s, loading: true }));
    return detectEmulators(overridesRef.current, { force }).then((res) => {
      if (alive.current && mine === run.current) setState({ statuses: res.statuses, brew: res.brew, loading: false });
      return res.statuses;
    });
  }, []);

  useEffect(() => {
    void search(false);
  }, [key, search]);

  const refresh = useCallback(() => search(true), [search]);

  return { statuses: state.statuses, loading: state.loading, refresh, brew: state.brew };
}
