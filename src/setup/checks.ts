import { biosDirOf, blockingMissing, checkRequirements, missingLabels } from "../emulators/requirements";
import { detectEmulators } from "../emulators/detect";
import { emulatorForSystem, supportedFolderNames } from "../emulators/catalog";
import type { EmulatorDef } from "../emulators/catalog";
import { testJellyfinAddresses } from "../jellyfin/testConnection";
import { countBySystem, scanGamesDir } from "../library/scanGames";
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
  /** Zweite Adresse für unterwegs (z. B. Tailscale); wird mitgeprüft. */
  jellyfinAltUrl?: string;
  apiKey: string;
  gamesDir: string;
  /** Zuordnungen von Hand (settings.gameSystems), damit die Zählung mit dem Menü übereinstimmt. */
  gameSystems?: Record<string, string>;
  /** BIOS-/Firmware-Ordner; leer = Standard. */
  biosDir?: string;
  controller: string | null;
  /** Gewählte Emulator-Pfade aus den Einstellungen (Emulator-ID → Pfad); ohne Angabe wird nur automatisch gesucht. */
  emulatorOverrides?: Record<string, string>;
}

interface CheckDef {
  id: string;
  label: string;
  run: (input: CheckInput, shared: Shared) => Promise<Pick<CheckResult, "status" | "detail">>;
}

/** Ergebnisse früherer Checks, die spätere wiederverwenden. */
interface Shared {
  /** System → Anzahl erkannter Spiele. */
  systems?: Record<string, number>;
  /** Systeme, die ohne Emulator starten (früher Ordner mit nur .app-Spielen; heute sammelt die Bibliothek sie unter „Programme“). */
  nativeOnly?: Set<string>;
}

const BROWSER_NOTE = "Nur in der Desktop-App prüfbar";

export const CHECKS: CheckDef[] = [
  {
    id: "jellyfin",
    label: "Jellyfin-Server",
    run: async ({ jellyfinUrl, jellyfinAltUrl, apiKey }) => {
      if (!jellyfinUrl.trim()) return { status: "warn", detail: "Übersprungen – keine Adresse angegeben" };
      const res = await testJellyfinAddresses(jellyfinUrl, jellyfinAltUrl ?? "", apiKey);
      return { status: res.status, detail: res.message };
    },
  },
  {
    id: "games-dir",
    label: "Spiele-Ordner & Struktur",
    run: async ({ gamesDir, gameSystems }, shared) => {
      if (!isTauri()) return { status: "warn", detail: BROWSER_NOTE };
      try {
        const scan = await scanGamesDir(gamesDir || undefined);
        const { systems, unassigned, programs } = countBySystem(scan, gameSystems);
        shared.systems = systems;
        shared.nativeOnly = new Set<string>();
        const names = Object.entries(systems).map(([s, n]) => `${s} (${n})`);
        const total = Object.values(systems).reduce((a, b) => a + b, 0) + unassigned + programs;
        if (total === 0) {
          return {
            status: "warn",
            detail: `${scan.baseDir} ist leer – lege deine Spiele einfach hinein (ISO, CHD, Spieleordner …), das System wird erkannt`,
          };
        }
        const parts = [...names];
        if (programs > 0) parts.push(`Programme (${programs})`);
        if (unassigned > 0) {
          return {
            status: "warn",
            detail: `${parts.length ? `${parts.join(", ")} · ` : ""}${unassigned} nicht zugeordnet – im Menü unter „Nicht zugeordnet“ von Hand einem System zuweisen`,
          };
        }
        return { status: "ok", detail: `${total} Spiel(e) erkannt: ${parts.join(", ")}` };
      } catch (err) {
        return { status: "fail", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    id: "emulators",
    label: "Emulatoren",
    run: async ({ emulatorOverrides }, shared) => {
      if (!isTauri()) return { status: "warn", detail: BROWSER_NOTE };
      const { statuses } = await detectEmulators(emulatorOverrides, { force: true });
      const found = statuses.filter((s) => s.valid);
      const missing = statuses.filter((s) => !s.valid);

      // Nötig sind die Emulatoren der Systeme, zu denen wirklich Spiele gehören.
      const needed = new Map<string, { def: EmulatorDef; folders: string[] }>();
      for (const folder of Object.keys(shared.systems ?? {})) {
        if (shared.nativeOnly?.has(folder)) continue;
        const def = emulatorForSystem(folder);
        if (!def) continue;
        const entry = needed.get(def.id) ?? { def, folders: [] };
        entry.folders.push(folder);
        needed.set(def.id, entry);
      }
      const label = (def: EmulatorDef, folders: string[]) => `${def.name} (${folders.join(", ")})`;
      const lacking = [...needed.values()].filter((n) => !found.some((s) => s.def.id === n.def.id));

      if (lacking.length > 0) {
        return {
          status: "fail",
          detail: `Für deine Spiele fehlt: ${lacking.map((n) => label(n.def, n.folders)).join(", ")} – unter Einstellungen → Emulatoren installieren oder auswählen`,
        };
      }
      if (needed.size > 0) {
        const rest = missing.length > 0 ? `; nicht installiert: ${missing.map((s) => s.def.name).join(", ")}` : "";
        return { status: "ok", detail: `${[...needed.values()].map((n) => label(n.def, n.folders)).join(", ")} gefunden${rest}` };
      }
      // Noch keine Spiele: nur ein Hinweis, falls Emulatoren fehlen.
      if (missing.length === 0) return { status: "ok", detail: `${found.map((s) => s.def.name).join(", ")} gefunden` };
      return {
        status: "warn",
        detail: `${found.length} von ${statuses.length} gefunden${found.length ? ` (${found.map((s) => s.def.name).join(", ")})` : ""} – später unter Einstellungen → Emulatoren installieren`,
      };
    },
  },
  {
    id: "bios",
    label: "BIOS & Firmware",
    run: async ({ biosDir }, shared) => {
      if (!isTauri()) return { status: "warn", detail: BROWSER_NOTE };
      const statuses = await checkRequirements(biosDirOf(biosDir));
      // Nötig sind die Dateien der Emulatoren der Systeme, zu denen Spiele gehören; ohne Spiele gilt alles als Hinweis.
      const needed = new Set<string>();
      for (const folder of Object.keys(shared.systems ?? {})) {
        if (shared.nativeOnly?.has(folder)) continue;
        const def = emulatorForSystem(folder);
        if (def) needed.add(def.id);
      }
      const lackingNeeded = blockingMissing(statuses, needed).map((s) => s.req.label);
      if (lackingNeeded.length > 0) {
        return { status: "fail", detail: `Für deine Spiele fehlt: ${lackingNeeded.join(", ")} – unter Einstellungen → BIOS & Firmware nachholen` };
      }
      const lackingAny = missingLabels(statuses);
      if (lackingAny.length > 0) {
        return { status: "warn", detail: `Noch nicht vorhanden: ${lackingAny.join(", ")} (nur nötig, wenn du dieses System spielst)` };
      }
      return { status: "ok", detail: "BIOS- und Firmware-Dateien sind vorhanden" };
    },
  },
  {
    id: "mapping",
    label: "Systeme ↔ Emulatoren",
    run: async (_input, shared) => {
      if (!shared.systems) return { status: "warn", detail: "Keine Systeme zum Abgleichen" };
      const unmapped = Object.keys(shared.systems).filter((s) => !emulatorForSystem(s) && !shared.nativeOnly?.has(s));
      return unmapped.length === 0
        ? { status: "ok", detail: "Alle Systeme haben einen Emulator" }
        : {
            status: "warn",
            detail: `Kein Emulator hinterlegt für: ${unmapped.join(", ")} (unterstützt: ${supportedFolderNames().join(", ")})`,
          };
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
