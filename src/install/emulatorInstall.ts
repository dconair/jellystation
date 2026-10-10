/**
 * Emulator aus den offiziellen GitHub-Releases laden und einspielen:
 *   Quelle bestimmen → Archiv laden (mit SHA-256-Prüfung, wo GitHub eine liefert) → entpacken/ablegen → Pfad.
 * Der Aufrufer trägt den Pfad danach in settings.emulators ein.
 */
import { downloadCancel, downloadStart, errorText, installArchive, onDownloadProgress } from "./backend";
import type { DownloadResult, PlatformInfo } from "./backend";
import { findAssetInRepo, GithubError } from "./github";
import type { PickedAsset } from "./github";
import { ARCH_HINTS, EXTENSION_ORDER, hwArchOf, installSpec } from "./sources";
import type { InstallSpec } from "./sources";

/** Ordner für heruntergeladene Archive (werden nach dem Einspielen gelöscht). */
export const ARCHIVE_DIR = "~/JellyStation/Downloads/Emulatoren";

export interface InstallHooks {
  /** Aktuelle Tätigkeit, eine Zeile. */
  status: (text: string) => void;
  /** 0..1 oder null (läuft, Fortschritt unbekannt). */
  progress: (value: number | null) => void;
}

export interface InstallOutcome {
  /** `.app` (macOS) bzw. Programmdatei (Windows). */
  path: string;
  version: string;
  notes: string[];
}

export class InstallCancelled extends Error {
  constructor() {
    super("Die Installation wurde abgebrochen");
    this.name = "InstallCancelled";
  }
}

export const formatMB = (n: number) => `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1).replace(".", ",")} MB`;

/** true, wenn für diesen Emulator auf diesem System ein automatischer Download möglich ist. */
export function canInstallFromGithub(emulatorId: string, platform: PlatformInfo): boolean {
  return installSpec(emulatorId, platform.os, hwArchOf(platform.arch)) !== null;
}

async function resolveAsset(spec: InstallSpec, platform: PlatformInfo, signal: AbortSignal): Promise<PickedAsset> {
  const hw = hwArchOf(platform.arch);
  const why: string[] = [];
  for (const src of spec.sources) {
    try {
      const found = await findAssetInRepo(src.repo, src.releasesPath, spec.rules, src.arch, hw, ARCH_HINTS, EXTENSION_ORDER, signal);
      if (found.asset) return found.asset;
      why.push(found.why);
    } catch (err) {
      if (signal.aborted) throw new InstallCancelled();
      if (err instanceof GithubError && err.fatal) throw err;
      why.push(errorText(err));
    }
  }
  throw new GithubError(why.length ? why.join("; ") : "Für dieses System ist keine Quelle angegeben");
}

/**
 * Lädt und installiert einen Emulator. Wirft `InstallCancelled`, wenn `signal` abbricht, sonst einen Fehler mit
 * deutschem Text (`Error.message`), der direkt angezeigt werden darf.
 */
export async function installEmulator(
  emulatorId: string,
  displayName: string,
  platform: PlatformInfo,
  hooks: InstallHooks,
  signal: AbortSignal,
): Promise<InstallOutcome> {
  const spec = installSpec(emulatorId, platform.os, hwArchOf(platform.arch));
  if (!spec) throw new Error(`Für ${displayName} gibt es auf diesem System keinen automatischen Download.`);
  const downloadId = `emu-${emulatorId}`;
  const notes: string[] = [];

  const cancel = () => void downloadCancel(downloadId).catch(() => undefined);
  signal.addEventListener("abort", cancel);
  const offProgress = await onDownloadProgress((p) => {
    if (p.id !== downloadId) return;
    if (p.state === "verifying") hooks.status(`Prüfe ${displayName} …`);
    if (p.state === "running" && p.total) hooks.progress(Math.min(1, p.received / p.total));
  });

  const download = (url: string, fileName: string | undefined, sha256: string | undefined, size: number | null) => {
    hooks.status(size ? `Lade ${fileName ?? displayName} (${formatMB(size)}) …` : `Lade ${fileName ?? displayName} …`);
    hooks.progress(0);
    return downloadStart({ id: downloadId, url, destDir: ARCHIVE_DIR, fileName, sha256, allowedHosts: spec.allowedHosts });
  };

  try {
    let downloaded: DownloadResult | null = null;
    let version = "";
    let checked = false;

    if (spec.directUrl) {
      try {
        downloaded = await download(spec.directUrl, undefined, undefined, null);
      } catch (err) {
        if (signal.aborted) throw new InstallCancelled();
        notes.push(`Die feste Download-Adresse hat nicht geklappt (${errorText(err)}) – ich suche in den GitHub-Releases.`);
      }
    }
    if (!downloaded) {
      if (!spec.sources.length) throw new Error("Der Download ist fehlgeschlagen und es gibt keine weitere Quelle.");
      hooks.status(`Suche die neueste Version von ${displayName} bei GitHub …`);
      hooks.progress(null);
      const asset = await resolveAsset(spec, platform, signal);
      if (asset.emulated) notes.push("Es gibt keinen eigenen Build für diesen Prozessor – ich nehme die Intel-/x64-Version (sie läuft über die Emulation des Systems).");
      version = asset.tag || asset.name;
      checked = asset.sha256 !== null;
      downloaded = await download(asset.url, asset.name, asset.sha256 ?? undefined, asset.size);
    }
    notes.push(checked ? "Die Prüfsumme (SHA-256) stimmt." : "GitHub nennt für diese Datei keine Prüfsumme – geprüft wurde nur, ob der Download vollständig ist.");

    hooks.status(`Installiere ${displayName} …`);
    hooks.progress(null);
    const installed = await installArchive({
      archive: downloaded.path,
      id: emulatorId,
      destRoot: platform.emulatorsDir,
      exePattern: spec.exePattern,
      removeArchive: true,
    });
    return { path: installed.path, version, notes };
  } catch (err) {
    if (signal.aborted) throw new InstallCancelled();
    throw err instanceof Error ? err : new Error(errorText(err));
  } finally {
    signal.removeEventListener("abort", cancel);
    offProgress();
  }
}
