import { useCallback, useEffect, useRef, useState } from "react";
import { REQUIREMENTS, checkRequirements } from "./requirements";
import type { RequirementStatus } from "./requirements";

export interface RequirementsState {
  statuses: RequirementStatus[];
  loading: boolean;
  /** Prüft neu (nach Ordnerwahl, Kopieren, Einspielen) und liefert das frische Ergebnis. */
  refresh: () => Promise<RequirementStatus[]>;
}

/** Prüft BIOS-/Firmware-Dateien für den gegebenen BIOS-Ordner; ändert sich der Ordner, wird neu geprüft. */
export function useRequirements(biosDir: string): RequirementsState {
  const [statuses, setStatuses] = useState<RequirementStatus[]>(() => REQUIREMENTS.map((req) => ({ req, state: "unknown" as const })));
  const [loading, setLoading] = useState(true);
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++run.current;
    setLoading(true);
    const next = await checkRequirements(biosDir);
    if (alive.current && mine === run.current) {
      setStatuses(next);
      setLoading(false);
    }
    return next;
  }, [biosDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { statuses, loading, refresh };
}
