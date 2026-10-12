/**
 * Dateien, die ein Emulator zusätzlich zum Programm braucht (BIOS, Firmware), und die Prüfung, ob sie da sind.
 *
 * JellyStation liefert BIOS-Dateien NIE und lädt sie nicht herunter: Sie stammen von der eigenen Konsole (PS1/PS2).
 * Die PS3-Firmware lädt die App nur von einer Adresse auf offiziellen Sony-Servern, die der Nutzer selbst einfügt
 * (src/install/). Hier wird geprüft, ob die Dateien im BIOS-Ordner des Nutzers oder schon beim Emulator liegen;
 * auf Wunsch werden sie dorthin übernommen.
 */
import { isTauri } from "../platform";
import { biosCopy, errorText, requirementsScan } from "./backend";
import type { RequirementScanSpec } from "./backend";

/** Standard-Ablageort für BIOS und Firmware (legt scripts/install-emulators.sh an). */
export const DEFAULT_BIOS_DIR = "~/JellyStation/BIOS";

export interface RequirementLink {
  label: string;
  url: string;
}

export interface Requirement {
  id: string;
  /** Emulator, der die Datei braucht (EmulatorDef.id). */
  emulatorId: string;
  /** Kurzname, z. B. "PS2-BIOS". */
  label: string;
  /** Pflicht = ohne sie startet kein Spiel dieses Systems. */
  required: boolean;
  /** Was das ist und woher man es bekommt (kurz). */
  description: string;
  /** Schritte, falls die Datei im BIOS-Ordner liegt, aber noch nicht im Emulator ist. */
  installHint: string;
  /** Hilfeseiten (keine Downloads von BIOS-Dateien). */
  links: RequirementLink[];
  /** Dateimuster im BIOS-Ordner und im Emulator-Ordner. */
  nameRegex?: string;
  minSize?: number;
  maxSize?: number;
  /** Pfade relativ zu den Emulator-Ordnern, an denen man eine fertig eingerichtete Datei erkennt. */
  markers?: string[];
  /**
   * Datenordner des Emulators (Dateien liegen dort schon richtig). "{appdir}" steht für den Ordner der Emulator-Programmdatei
   * (nur Windows: dort legen z. B. RPCS3 und shadPS4 ihre Daten neben die .exe); ist der Emulator unbekannt, entfällt der Eintrag.
   */
  emulatorDirs: string[];
  /**
   * true = der Ablageort ist nicht sicher bekannt (z. B. bei RPCS3 auf dem Mac): „nicht gefunden“ ist dann nur ein
   * Hinweis und blockiert weder den Spielstart noch die Einrichtungsprüfung. Sicher wird er (`RequirementStatus.sure`),
   * sobald ein „{appdir}“-Ort geprüft werden konnte.
   */
  uncertain?: boolean;
  /** Ordner im Emulator, in den `bios_copy` die Datei legt; null = nicht kopierbar (Einspielen im Emulator). */
  copyTo: string | null;
}

const MiB = 1024 * 1024;

export const REQUIREMENTS: Requirement[] = [
  {
    id: "ps1-bios",
    emulatorId: "duckstation",
    label: "PS1-BIOS",
    required: true,
    description:
      "Ein BIOS deiner PlayStation 1 (z. B. scph1001.bin, scph5501.bin oder scph7001.bin – je nach Region der Spiele, 512 KB). Es wird nicht mitgeliefert und nicht heruntergeladen: Sichere es von deiner eigenen Konsole.",
    installHint: "Wird in den BIOS-Ordner von DuckStation kopiert.",
    links: [
      { label: "DuckStation (Download und Hilfe)", url: "https://www.duckstation.org/" },
    ],
    nameRegex: "\\.bin$",
    minSize: 512 * 1024,
    maxSize: 512 * 1024,
    emulatorDirs: ["~/Library/Application Support/DuckStation/bios"],
    copyTo: "~/Library/Application Support/DuckStation/bios",
  },
  {
    id: "ps2-bios",
    emulatorId: "pcsx2",
    label: "PS2-BIOS",
    required: true,
    description:
      "Ein BIOS deiner PlayStation 2 (Dateien wie scph*.bin oder .rom0, rund 4 MB, passend zur Region). Es wird nicht mitgeliefert und nicht heruntergeladen: Sichere es von deiner eigenen Konsole (Anleitung bei PCSX2).",
    installHint: "Wird in den BIOS-Ordner von PCSX2 kopiert.",
    links: [
      { label: "PCSX2 (Download)", url: "https://pcsx2.net/downloads" },
      { label: "PCSX2: BIOS sichern (Anleitung)", url: "https://pcsx2.net/docs/setup/bios/" },
    ],
    nameRegex: "\\.(bin|rom0)$",
    minSize: 1 * MiB,
    maxSize: 8 * MiB,
    emulatorDirs: ["~/Library/Application Support/PCSX2/bios"],
    copyTo: "~/Library/Application Support/PCSX2/bios",
  },
  {
    id: "ps3-firmware",
    emulatorId: "rpcs3",
    label: "PS3-Firmware",
    required: true,
    description:
      "Die offizielle PS3-Systemsoftware (Datei PS3UPDAT.PUP, rund 200 MB). Sony stellt sie kostenlos auf der PlayStation-Support-Seite bereit; RPCS3 braucht sie einmalig.",
    installHint: "Einspielen in RPCS3: Datei → Firmware installieren → PS3UPDAT.PUP wählen. Liegt die Datei schon im BIOS-Ordner, geht es auch mit einem Klick unter „Einrichtung & Downloads“ → PS3-Firmware → „Jetzt mit RPCS3 einspielen“.",
    links: [
      { label: "Sony: PS3-Systemsoftware laden", url: "https://www.playstation.com/en-us/support/hardware/ps3/system-software/" },
      { label: "RPCS3: Schnellstart-Anleitung", url: "https://rpcs3.net/quickstart" },
    ],
    // Im BIOS-Ordner erkennt man die .PUP-Datei, im Emulator die fertig eingespielte Firmware.
    nameRegex: "\\.pup$",
    minSize: 50 * MiB,
    markers: ["sys/external/liblv2.sprx"],
    // Windows: RPCS3 legt dev_flash neben die rpcs3.exe (bei einem Ordner „portable“ dort hinein; fs::get_config_dir).
    emulatorDirs: [
      "{appdir}/portable/dev_flash",
      "{appdir}/dev_flash",
      "~/Library/Application Support/rpcs3/dev_flash",
      "~/.config/rpcs3/dev_flash",
    ],
    uncertain: true,
    copyTo: null,
  },
];

export const requirementsFor = (emulatorId: string): Requirement[] =>
  REQUIREMENTS.filter((r) => r.emulatorId === emulatorId);

/* ------------------------------------------------------------------ Bekannte Emulator-Programme */

/** Programmpfade der gefundenen Emulatoren (Emulator-ID → Pfad); die Erkennung (detect.ts) trägt sie ein. */
const knownApps = new Map<string, string>();
const appListeners = new Set<() => void>();

/** Merkt sich (oder vergisst) den Programmpfad eines Emulators; Hörer erfahren von jeder Änderung. */
export function rememberEmulatorApp(emulatorId: string, path: string | null): void {
  if ((knownApps.get(emulatorId) ?? null) === path) return;
  if (path) knownApps.set(emulatorId, path);
  else knownApps.delete(emulatorId);
  for (const fn of appListeners) fn();
}

/** Meldet sich für Änderungen an den bekannten Emulator-Programmen an; die Rückgabe meldet wieder ab. */
export function subscribeEmulatorApps(fn: () => void): () => void {
  appListeners.add(fn);
  return () => {
    appListeners.delete(fn);
  };
}

/** Ordner einer Windows-Programmdatei ("D:\\Emu\\rpcs3.exe" → "D:/Emu"), sonst null (macOS-.app und Linux legen Daten anderswo ab). */
export function windowsAppDir(path: string | null | undefined): string | null {
  if (!path || !/\.exe$/i.test(path)) return null;
  const dir = path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  return dir && dir !== path ? dir : null;
}

/** Ersetzt "{appdir}" in einem Ort; ohne bekanntes Windows-Programm gibt es keinen Ort (null). */
function expandAppDir(dir: string, emulatorId: string): string | null {
  if (!dir.includes("{appdir}")) return dir;
  const app = windowsAppDir(knownApps.get(emulatorId));
  return app ? dir.replace("{appdir}", app) : null;
}

export type RequirementState =
  /** Beim Emulator vorhanden – bereit. */
  | "ready"
  /** Nur im BIOS-Ordner gefunden – noch in den Emulator übernehmen bzw. einspielen. */
  | "in-folder"
  /** Nirgends gefunden. */
  | "missing"
  /** Nicht prüfbar (Browser, Fehler). */
  | "unknown";

export interface RequirementStatus {
  req: Requirement;
  state: RequirementState;
  /** Gefundene Datei (Emulator-Ordner bevorzugt). */
  path?: string;
  /** Datei im BIOS-Ordner (für „In den Emulator übernehmen“). */
  folderPath?: string;
  error?: string;
  /** true = der Ablageort wurde sicher geprüft (ein „{appdir}“-Ort war bekannt), „fehlt“ ist dann verlässlich. */
  sure?: boolean;
}

/** Gilt „fehlt“ nur als Vermutung? */
export const isUncertain = (s: Pick<RequirementStatus, "req" | "sure">): boolean => !!s.req.uncertain && !s.sure;

export const biosDirOf = (settingsBiosDir?: string) => (settingsBiosDir && settingsBiosDir.trim()) || DEFAULT_BIOS_DIR;

const specOf = (r: Requirement, biosDir: string): RequirementScanSpec => ({
  id: r.id,
  locations: [
    ...r.emulatorDirs.flatMap((dir) => {
      const real = expandAppDir(dir, r.emulatorId);
      return real ? [{ kind: "emulator" as const, dir: real }] : [];
    }),
    { kind: "folder" as const, dir: biosDir },
  ],
  nameRegex: r.nameRegex,
  minSize: r.minSize ?? 0,
  maxSize: r.maxSize ?? 0,
  markers: r.markers ?? [],
});

/**
 * Prüft alle Anforderungen. Nichts davon wirft: Im Browser (oder bei einem Fehler) ist der Zustand "unknown".
 * Beim PS3 zählt im Emulator-Ordner nur die fertig eingespielte Firmware (Marker), im BIOS-Ordner nur die .PUP.
 */
export async function checkRequirements(biosDir: string, reqs: readonly Requirement[] = REQUIREMENTS): Promise<RequirementStatus[]> {
  if (!isTauri()) return reqs.map((req) => ({ req, state: "unknown" as const }));
  try {
    const results = await requirementsScan(reqs.map((r) => specOf(r, biosDir)));
    return reqs.map((req) => {
      const found = results.find((x) => x.id === req.id)?.found ?? [];
      // Ein Marker-Treffer im Emulator-Ordner = fertig eingerichtet; Dateimuster dort ebenfalls (BIOS-Dateien).
      const inEmu = found.find((f) => f.kind === "emulator" && (req.markers?.length ? req.markers.some((m) => f.path.replace(/\\/g, "/").endsWith(m)) : true));
      const inFolder = found.find((f) => f.kind === "folder");
      // Sicher, wenn der Ort neben der Windows-Programmdatei bekannt ist (dort liegen die Daten verlässlich).
      const sure = req.emulatorDirs.some((dir) => dir.includes("{appdir}") && expandAppDir(dir, req.emulatorId) !== null);
      if (inEmu) return { req, state: "ready" as const, path: inEmu.path, folderPath: inFolder?.path, sure };
      if (inFolder) return { req, state: "in-folder" as const, path: inFolder.path, folderPath: inFolder.path, sure };
      return { req, state: "missing" as const, sure };
    });
  } catch (err) {
    return reqs.map((req) => ({ req, state: "unknown" as const, error: errorText(err) }));
  }
}

/** Kopiert die gefundene Datei aus dem BIOS-Ordner in den Datenordner des Emulators. */
export async function installRequirement(status: RequirementStatus): Promise<string> {
  const to = status.req.copyTo;
  if (!to || !status.folderPath) throw new Error("Diese Datei wird direkt im Emulator eingespielt");
  return biosCopy(status.folderPath, to);
}

export function describeRequirement(s: RequirementStatus): { text: string; tone: "ok" | "warn" | "error" | undefined } {
  switch (s.state) {
    case "ready":
      return { text: "Bereit", tone: "ok" };
    case "in-folder":
      return s.req.copyTo
        ? { text: "Im BIOS-Ordner gefunden – noch in den Emulator übernehmen", tone: "warn" }
        : { text: "Datei gefunden – noch im Emulator einspielen", tone: "warn" };
    case "missing":
      if (isUncertain(s)) return { text: "Nicht gefunden – falls du sie schon in den Emulator eingespielt hast, ist alles in Ordnung", tone: "warn" };
      return { text: s.req.required ? "Fehlt" : "Fehlt (optional)", tone: s.req.required ? "error" : "warn" };
    default:
      return { text: s.error ?? "Nur in der Desktop-App prüfbar", tone: undefined };
  }
}

/** Dateien, die sicher fehlen (ohne die mit unsicherem Ablageort) – sie blockieren den Start und die Einrichtungsprüfung. */
export function blockingMissing(statuses: readonly RequirementStatus[], emulatorIds?: ReadonlySet<string>): RequirementStatus[] {
  return statuses.filter(
    (s) => s.req.required && !isUncertain(s) && (s.state === "missing" || s.state === "in-folder") && (!emulatorIds || emulatorIds.has(s.req.emulatorId)),
  );
}

/** "PS2-BIOS, PS3-Firmware" – was noch fehlt (Pflichtdateien, die nicht bereit sind). */
export function missingLabels(statuses: readonly RequirementStatus[], emulatorIds?: ReadonlySet<string>): string[] {
  return statuses
    .filter((s) => s.req.required && s.state !== "ready" && s.state !== "unknown" && (!emulatorIds || emulatorIds.has(s.req.emulatorId)))
    .map((s) => s.req.label);
}
