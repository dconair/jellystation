import { EMULATORS } from "../config/games";
import { testJellyfin } from "../jellyfin/testConnection";
import { pickGameFiles, scanGamesDir } from "../library/scanGames";
import { isTauri } from "../platform";

export type CheckStatus = "pending" | "running" | "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CheckInput {
  jellyfinUrl: string;
  apiKey: string;
  gamesDir: string;
  controller: string | null;
}

interface CheckDef {
  id: string;
  label: string;
  run: (input: CheckInput, shared: Shared) => Promise<Pick<CheckResult, "status" | "detail">>;
}

/** Ergebnisse früherer Checks, die spätere wiederverwenden. */
interface Shared {
  /** Systemordner → Anzahl Spieldateien. */
  systems?: Record<string, number>;
}

const BROWSER_NOTE = "Nur in der Desktop-App prüfbar";

export const CHECKS: CheckDef[] = [
  {
    id: "jellyfin",
    label: "Jellyfin-Server",
    run: async ({ jellyfinUrl, apiKey }) => {
      if (!jellyfinUrl.trim()) return { status: "warn", detail: "Übersprungen – keine Adresse angegeben" };
      const res = await testJellyfin(jellyfinUrl, apiKey);
      return { status: res.status, detail: res.message };
    },
  },
  {
    id: "games-dir",
    label: "Spiele-Ordner & Struktur",
    run: async ({ gamesDir }, shared) => {
      if (!isTauri()) return { status: "warn", detail: BROWSER_NOTE };
      try {
        const { baseDir, listing } = await scanGamesDir(gamesDir || undefined);
        const systems: Record<string, number> = {};
        for (const [sys, files] of Object.entries(listing)) {
          const n = pickGameFiles(files).length;
          if (n > 0) systems[sys] = n;
        }
        shared.systems = systems;
        const names = Object.entries(systems).map(([s, n]) => `${s} (${n})`);
        if (names.length === 0) {
          return {
            status: "warn",
            detail: `${baseDir} ist leer – lege Spiele in Unterordnern wie PS3/ ab`,
          };
        }
        return { status: "ok", detail: `${names.length} System(e): ${names.join(", ")}` };
      } catch (err) {
        return { status: "fail", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    id: "emulators",
    label: "Emulatoren (Standardpfade)",
    run: async (_input, shared) => {
      if (!isTauri()) return { status: "warn", detail: BROWSER_NOTE };
      const { exists } = await import("@tauri-apps/plugin-fs");
      const missing: string[] = [];
      const found: string[] = [];
      let neededButMissing = false;
      for (const [system, emu] of Object.entries(EMULATORS)) {
        let present = false;
        try {
          present = await exists(emu.binary);
        } catch {
          present = false;
        }
        if (present) found.push(emu.name);
        else {
          missing.push(`${emu.name} (${emu.binary})`);
          const used = Object.keys(shared.systems ?? {}).some((s) => s.toLowerCase() === system);
          neededButMissing ||= used;
        }
      }
      if (missing.length === 0) return { status: "ok", detail: `${found.join(", ")} gefunden` };
      return {
        status: neededButMissing ? "fail" : "warn",
        detail: `Nicht gefunden: ${missing.join("; ")}`,
      };
    },
  },
  {
    id: "mapping",
    label: "Systeme ↔ Emulatoren",
    run: async (_input, shared) => {
      if (!shared.systems) return { status: "warn", detail: "Keine Systeme zum Abgleichen" };
      const unmapped = Object.keys(shared.systems).filter((s) => !EMULATORS[s.toLowerCase()]);
      return unmapped.length === 0
        ? { status: "ok", detail: "Alle Systeme haben einen Emulator" }
        : { status: "warn", detail: `Kein Emulator hinterlegt für: ${unmapped.join(", ")}` };
    },
  },
  {
    id: "controller",
    label: "Controller",
    run: async ({ controller }) =>
      controller
        ? { status: "ok", detail: `${controller} verbunden` }
        : { status: "warn", detail: "Kein Controller erkannt – Tastatur und Maus funktionieren weiterhin" },
  },
];

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Führt alle Prüfungen nacheinander aus und meldet jeden Zwischenstand. */
export async function runChecks(
  input: CheckInput,
  onUpdate: (result: CheckResult) => void,
  isCancelled: () => boolean,
) {
  const shared: Shared = {};
  for (const def of CHECKS) {
    if (isCancelled()) return;
    onUpdate({ id: def.id, label: def.label, status: "running", detail: "Wird geprüft …" });
    await pause(350); // damit der Fortschritt sichtbar bleibt
    let outcome: Pick<CheckResult, "status" | "detail">;
    try {
      outcome = await def.run(input, shared);
    } catch (err) {
      outcome = { status: "fail", detail: err instanceof Error ? err.message : String(err) };
    }
    if (isCancelled()) return;
    onUpdate({ id: def.id, label: def.label, ...outcome });
  }
}
