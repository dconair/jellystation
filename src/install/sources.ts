/**
 * Woher ein Emulator geladen wird: GitHub-Releases der Projekte (offizielle Quellen), je Betriebssystem.
 *
 * macOS liest die Angaben aus src/emulators/emulators.json – derselben Datei wie scripts/install-emulators.sh –,
 * damit beide Wege nicht auseinanderlaufen. Windows steht hier, weil die Datei auf macOS zugeschnitten ist.
 *
 * UNGEPRÜFT gegen echte Releases (aus der Entwicklungsumgebung ist nur das eigene Repository erreichbar): die Windows-
 * Dateinamen-Muster und Programmnamen. Die App rät keine Dateinamen, sondern liest sie zur Laufzeit aus der GitHub-
 * Antwort; passt nichts, erscheint eine klare Meldung mit der Download-Seite des Projekts. Muster hier anpassen, falls
 * ein Projekt seine Dateinamen ändert.
 */
import data from "../emulators/emulators.json";
import type { ArchHints, AssetRules, HwArch, RepoArch } from "./github";

export interface RepoSource {
  repo: string;
  arch: RepoArch;
  /** `latest` oder `tags/<Tag>` */
  releasesPath: string;
}

export interface InstallSpec {
  /** Quellen in der Reihenfolge, in der sie probiert werden. */
  sources: RepoSource[];
  rules: AssetRules;
  /** Server, von denen geladen werden darf (auch nach Weiterleitungen). */
  allowedHosts: string[];
  /** Feste Download-Adresse, die zuerst versucht wird (z. B. DuckStation auf dem Mac). */
  directUrl?: string;
  /** Windows/Linux: Name der Programmdatei im Archiv (Regex). */
  exePattern?: string;
}

interface JsonInstall {
  kind?: string;
  github?: Partial<Record<RepoArch, string>> & { releasesPath?: string };
  directUrl?: Partial<Record<RepoArch, string>>;
  assetMatch?: { include?: string[]; exclude?: string[] };
  allowedHosts?: string[];
  fallback?: string[];
}

interface JsonEmulator {
  id: string;
  install?: JsonInstall;
}

const json = data as unknown as {
  download: { archHints: ArchHints; extensionOrder: string[] };
  emulators: JsonEmulator[];
};

export const ARCH_HINTS: ArchHints = json.download.archHints;
/** Bevorzugte Archivarten, die erste hat Vorrang (dmg vor zip vor tar vor 7z). */
export const EXTENSION_ORDER: readonly string[] = json.download.extensionOrder;

const GITHUB_HOSTS = ["github.com", "api.github.com", "objects.githubusercontent.com", "*.githubusercontent.com"];
const NOT_AN_ARCHIVE = ["debug", "symbols?", "dsym", "\\.sha(1|256|512)?$", "sha(1|256|512)sums?", "\\.(sig|asc)$", "\\.txt$", "blockmap"];

function macSpec(id: string, hw: HwArch): InstallSpec | null {
  const ins = json.emulators.find((e) => e.id === id)?.install;
  if (!ins) return null;
  const kinds = [ins.kind, ...(ins.fallback ?? [])];
  const useGithub = kinds.includes("github-release");
  const useDirect = kinds.includes("direct-url");
  if (!useGithub && !useDirect) return null; // brew-cask / manual: der Mac nutzt dafür Homebrew
  const gh = ins.github ?? {};
  const releasesPath = gh.releasesPath || "latest";
  const sources: RepoSource[] = [];
  if (useGithub) {
    // Wie resolve_github im Skript: erst die passende Bauart, zuletzt der Intel-Build (läuft über Rosetta 2).
    const order: RepoArch[] = hw === "arm64" ? ["arm64", "any", "x86_64"] : ["x86_64", "any"];
    for (const a of order) {
      const repo = gh[a];
      if (repo && !sources.some((s) => s.repo === repo)) sources.push({ repo, arch: a, releasesPath });
    }
  }
  const direct = ins.directUrl?.[hw] ?? ins.directUrl?.any;
  return {
    sources,
    rules: { include: ins.assetMatch?.include ?? [], exclude: ins.assetMatch?.exclude ?? [] },
    allowedHosts: ins.allowedHosts ?? GITHUB_HOSTS,
    ...(useDirect && direct ? { directUrl: direct } : {}),
  };
}

const WINDOWS: Record<string, InstallSpec> = {
  rpcs3: {
    sources: [{ repo: "RPCS3/rpcs3-binaries-win", arch: "any", releasesPath: "latest" }],
    rules: { include: ["win", "\\.(7z|zip)$"], exclude: NOT_AN_ARCHIVE },
    allowedHosts: GITHUB_HOSTS,
    exePattern: "^rpcs3\\.exe$",
  },
  // shadPS4 bietet je Version eine Qt- und eine SDL-Ausgabe; die SDL-Ausgabe wird ausgeschlossen, damit immer dieselbe gewählt wird.
  shadps4: {
    sources: [{ repo: "shadps4-emu/shadPS4", arch: "any", releasesPath: "latest" }],
    rules: { include: ["win", "\\.zip$"], exclude: ["sdl", ...NOT_AN_ARCHIVE] },
    allowedHosts: GITHUB_HOSTS,
    exePattern: "^shadps4\\.exe$",
  },
  duckstation: {
    sources: [{ repo: "stenzek/duckstation", arch: "any", releasesPath: "tags/latest" }],
    rules: { include: ["windows", "\\.zip$"], exclude: NOT_AN_ARCHIVE },
    allowedHosts: GITHUB_HOSTS,
    exePattern: "^duckstation-qt.*\\.exe$",
  },
  pcsx2: {
    sources: [{ repo: "PCSX2/pcsx2", arch: "any", releasesPath: "latest" }],
    rules: { include: ["windows", "\\.7z$"], exclude: [...NOT_AN_ARCHIVE, "installer", "\\.exe$"] },
    allowedHosts: GITHUB_HOSTS,
    exePattern: "^pcsx2-qt.*\\.exe$",
  },
  // PPSSPP und Dolphin veröffentlichen ihre Windows-Builds nicht als GitHub-Release mit fester Adresse:
  // kein Eintrag = die App zeigt die Download-Seite des Projekts.
};

/** Quelle für den Emulator auf diesem System; null = es gibt keinen automatischen Weg (Homebrew bzw. Download-Seite). */
export function installSpec(emulatorId: string, os: string, hw: HwArch): InstallSpec | null {
  if (os === "macos") return macSpec(emulatorId, hw);
  if (os === "windows") return WINDOWS[emulatorId] ?? null;
  return null;
}

export const hwArchOf = (arch: string): HwArch => (arch === "aarch64" || arch === "arm64" ? "arm64" : "x86_64");
