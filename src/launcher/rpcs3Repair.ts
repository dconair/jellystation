/**
 * Selbstreparatur für PS3-Spiele in RPCS3: Was vor dem Start geprüft, nach einem sofortigen Ende aus dem Protokoll
 * gelesen und ohne Zutun des Nutzers behoben wird. Die Ablaufsteuerung (Overlay, Dialoge, erneuter Start) liegt in
 * `useGameLauncher.ts`; hier stehen nur die Bausteine.
 *
 * Die App legt nur weiter, was der Nutzer selbst bereitgestellt hat (Disc-Schlüssel, `PS3UPDAT.PUP`). Die Firmware kann
 * sie auf ausdrücklichen Klick vom offiziellen Sony-Server laden, wie unter „Einrichtung & Downloads“.
 */
import { invoke } from "@tauri-apps/api/core";
import { diagLogTail } from "../diagnose/backend";
import { analyzeOutput, emulatorLogPaths } from "../diagnose/rules";
import { gameKill, gameLaunch, gameRunning } from "../emulators/backend";
import type { EmulatorDef } from "../emulators/catalog";
import { analyzeBios, SONY_FIRMWARE_HOSTS, SONY_PS3_FIRMWARE_URL } from "../install/biosCheck";
import { downloadCancel, downloadStart, fileFingerprint, onDownloadProgress } from "../install/backend";

/** Antwort von `rpcs3_prepare` (siehe src-tauri/src/rpcs3.rs). */
export interface Rpcs3Prep {
  configDir: string | null;
  firmwareInstalled: boolean;
  isIso: boolean;
  keyNextToGame: boolean;
  keysCopied: string[];
  keysError: string | null;
  pup: string | null;
}

export async function rpcs3Prepare(appPath: string, gamePath: string, extraDirs: string[]): Promise<Rpcs3Prep> {
  const raw = (await invoke<unknown>("rpcs3_prepare", { appPath, gamePath, extraDirs })) as Partial<Rpcs3Prep> | null;
  const o = raw ?? {};
  return {
    configDir: typeof o.configDir === "string" ? o.configDir : null,
    firmwareInstalled: o.firmwareInstalled === true,
    isIso: o.isIso === true,
    keyNextToGame: o.keyNextToGame === true,
    keysCopied: Array.isArray(o.keysCopied) ? o.keysCopied.filter((x): x is string => typeof x === "string") : [],
    keysError: typeof o.keysError === "string" ? o.keysError : null,
    pup: typeof o.pup === "string" ? o.pup : null,
  };
}

/* ------------------------------------------------------------------ Ursache aus dem Protokoll */

/** Dauer, die ein Protokoll älter sein darf als der Start und trotzdem „von diesem Start“ zählt (Uhren-Ungenauigkeit). */
const LOG_SLACK_MS = 5000;

/**
 * Zeilen, die RPCS3 zu diesem Start gemeldet hat: sein Protokoll (nur wenn es seit dem Start beschrieben wurde) und die
 * Ausgabe des Prozesses.
 */
export async function rpcs3LogLines(appPath: string, startedAt: number, output: readonly string[]): Promise<string[]> {
  let fresh: string[] = [];
  try {
    const tail = await diagLogTail(emulatorLogPaths("rpcs3", appPath), 250);
    if (tail && tail.modifiedMs >= startedAt - LOG_SLACK_MS) fresh = tail.lines;
  } catch {
    fresh = [];
  }
  return [...fresh, ...output];
}

/** Kennungen der gezielten RPCS3-Regeln aus `diagnose/rules.ts` (z. B. „disc-key“, „firmware“), die auf die Zeilen passen. */
export function rpcs3Causes(lines: readonly string[], def: EmulatorDef | null, appPath: string | null): Set<string> {
  const findings = analyzeOutput(lines, { def, appPath }, "auto", true);
  return new Set(findings.map((f) => f.id.replace(/^auto-/, "")));
}

/* ------------------------------------------------------------------ Firmware einspielen */

export type StepResult = { ok: true } | { ok: false; reason: string };

export interface FirmwareInstallOptions {
  appPath: string;
  pup: string;
  /** Zeile für das Start-Overlay. */
  status: (text: string) => void;
  wait: (ms: number) => Promise<void>;
  /** false = abbrechen (Nutzer hat ○ gedrückt, App wird beendet). */
  keepGoing: () => boolean;
}

const INSTALL_ID = "setup:rpcs3-firmware";
const POLL_MS = 2500;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Lässt RPCS3 die Firmware einspielen (`rpcs3 --installfw <PUP>`). RPCS3 öffnet sein Fenster, fragt einmal nach und zeigt
 * den Fortschritt; im Protokoll steht „Successfully installed PS3 firmware“ (main_window.cpp), sobald es fertig ist.
 * Dann beendet die App RPCS3 wieder. Im Modus ohne Fenster (`--no-gui`) geht das Einspielen nicht (rpcs3.cpp).
 */
export async function installFirmwareWithRpcs3(o: FirmwareInstallOptions): Promise<StepResult> {
  const startedAt = Date.now();
  try {
    await gameLaunch({ id: INSTALL_ID, program: o.appPath, args: ["--installfw", o.pup], label: "RPCS3 (Firmware einspielen)" });
  } catch (err) {
    return { ok: false, reason: `RPCS3 ließ sich nicht öffnen: ${err instanceof Error ? err.message : String(err)}` };
  }
  o.status("RPCS3 fragt, ob die Firmware installiert werden soll – bestätige dort mit „Ja“ …");

  const stop = async () => {
    try {
      await gameKill(INSTALL_ID);
    } catch {
      /* war schon beendet */
    }
  };
  const stillRunning = async () => {
    try {
      return (await gameRunning()).includes(INSTALL_ID);
    } catch {
      return true;
    }
  };

  while (Date.now() - startedAt < INSTALL_TIMEOUT_MS) {
    await o.wait(POLL_MS);
    if (!o.keepGoing()) {
      await stop();
      return { ok: false, reason: "Abgebrochen." };
    }
    const lines = await rpcs3LogLines(o.appPath, startedAt, []);
    const done = lines.some((l) => /Successfully installed PS3 firmware/i.test(l));
    if (done) {
      o.status("Firmware ist eingespielt – RPCS3 wird beendet …");
      await o.wait(1500);
      await stop();
      for (let i = 0; i < 8 && (await stillRunning()); i++) await o.wait(1000);
      return { ok: true };
    }
    const failed = lines.find((l) => /Error while (installing|extracting) firmware|Firmware Installation Failed/i.test(l));
    if (failed) {
      await stop();
      return { ok: false, reason: `RPCS3 meldet: ${failed.replace(/^.*?(Error while)/i, "$1").trim()}` };
    }
    if (!(await stillRunning())) {
      // Das Fenster wurde geschlossen (oder „Nein“ gewählt), bevor die Meldung im Protokoll stand: Marker prüfen.
      const prep = await rpcs3Prepare(o.appPath, o.pup, []).catch(() => null);
      return prep?.firmwareInstalled ? { ok: true } : { ok: false, reason: "RPCS3 wurde beendet, bevor die Firmware eingespielt war." };
    }
  }
  await stop();
  return { ok: false, reason: "Das Einspielen dauert ungewöhnlich lange und wurde abgebrochen." };
}

/* ------------------------------------------------------------------ Firmware von Sony laden */

const DOWNLOAD_ID = "fw-rpcs3-auto";

const formatMB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Bricht ein laufendes Laden der Firmware ab. */
export const cancelFirmwareDownload = () => void downloadCancel(DOWNLOAD_ID).catch(() => undefined);

/**
 * Lädt die PS3-Firmware vom offiziellen Sony-Server in den BIOS-Ordner (dieselbe Adresse und Prüfung wie unter
 * „Einrichtung & Downloads“) und gibt den Pfad der Datei zurück. Wirft bei Fehlern (deutscher Text).
 */
export async function downloadSonyFirmware(biosDir: string, status: (text: string) => void): Promise<string> {
  const off = await onDownloadProgress((p) => {
    if (p.id !== DOWNLOAD_ID || p.state !== "running") return;
    status(p.total ? `PS3-Firmware wird geladen: ${formatMB(p.received)} von ${formatMB(p.total)} …` : `PS3-Firmware wird geladen: ${formatMB(p.received)} …`);
  });
  try {
    status("PS3-Firmware wird vom Sony-Server geladen …");
    const res = await downloadStart({
      id: DOWNLOAD_ID,
      url: SONY_PS3_FIRMWARE_URL,
      destDir: biosDir,
      fileName: "PS3UPDAT.PUP",
      allowedHosts: SONY_FIRMWARE_HOSTS,
      allowHttp: new URL(SONY_PS3_FIRMWARE_URL).protocol === "http:",
      blockExecutables: true,
    });
    const verdict = analyzeBios("ps3-firmware", await fileFingerprint(res.path));
    if (verdict.verdict === "invalid") throw new Error(`${verdict.text} Die Datei liegt unter ${res.path} – lösche sie und lade die Firmware von der Sony-Seite.`);
    return res.path;
  } finally {
    off();
  }
}
