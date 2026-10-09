import { isTauri } from "../platform";
import { sanitizeUiPrefs } from "../prefs/uiPrefs";
import type { UiPrefs } from "../prefs/uiPrefs";

export interface Settings {
  /** Schema-Version für spätere Migrationen. */
  version: 1;
  jellyfin: {
    /** z. B. "http://192.168.1.20:8096" (ohne abschließenden Slash) */
    url: string;
    apiKey: string;
    /** Benutzer, für den Wiedergabestatus gilt; fehlt er, nimmt die App den zuletzt aktiven Benutzer. */
    userId?: string;
    userName?: string;
  };
  /**
   * Vom Nutzer gewählte Emulator-Programme: Emulator-ID (siehe src/emulators/catalog.ts) → Pfad
   * einer .app oder eines Programms. Fehlt ein Eintrag, wird der Emulator automatisch gesucht.
   */
  emulators?: Record<string, string>;
  /** Ordner mit BIOS- und Firmware-Dateien (vom Nutzer bereitgestellt); fehlt er, gilt ~/JellyStation/BIOS. */
  biosDir?: string;
  /** Darstellung und Klang (siehe src/prefs/uiPrefs.ts); fehlt es, gelten die Standardwerte. */
  ui?: Partial<UiPrefs>;
  /** Spiele-Cover (siehe src/art/coverService.ts); fehlt es, gilt auto = true. */
  covers?: CoverSettings;
  /** Absoluter Pfad des Spiele-Basisordners; leer = Standardordner/Demo-Modus. */
  gamesDir: string;
  /** Zeitpunkt des Setup-Abschlusses (ISO). */
  completedAt: string;
}

/** Einstellungen für automatische Spiele-Cover. */
export interface CoverSettings {
  /** true = fehlende Cover bei thumbnails.libretro.com suchen (dabei gehen Spiel- und Systemname ins Netz). */
  auto: boolean;
}

export const coversAuto = (settings: Pick<Settings, "covers"> | null | undefined): boolean => settings?.covers?.auto !== false;

export const emptySettings = (): Omit<Settings, "completedAt"> => ({
  version: 1,
  jellyfin: { url: "", apiKey: "" },
  gamesDir: "",
});

const FILE = "settings.json";
const KEY = "settings";
const BROWSER_KEY = "jellystation.settings";

/**
 * Persistenz: in Tauri der Plugin-Store (settings.json im App-Datenordner,
 * unter macOS ~/Library/Application Support/dev.jellystation.app/), im reinen
 * Browser (`npm run dev`) localStorage.
 */
export async function loadSettings(): Promise<Settings | null> {
  try {
    let raw: unknown;
    if (isTauri()) {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(FILE, { defaults: {}, autoSave: false });
      raw = await store.get(KEY);
    } else {
      const text = localStorage.getItem(BROWSER_KEY);
      raw = text ? JSON.parse(text) : undefined;
    }
    return validate(raw);
  } catch (err) {
    console.warn("Einstellungen konnten nicht geladen werden", err);
    return null;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (isTauri()) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load(FILE, { defaults: {}, autoSave: false });
    await store.set(KEY, settings);
    await store.save();
  } else {
    localStorage.setItem(BROWSER_KEY, JSON.stringify(settings));
  }
}

/** Akzeptiert nur vollständig abgeschlossene, wohlgeformte Konfigurationen. */
function validate(raw: unknown): Settings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Settings>;
  if (r.version !== 1 || typeof r.completedAt !== "string") return null;
  return {
    version: 1,
    jellyfin: {
      url: typeof r.jellyfin?.url === "string" ? r.jellyfin.url : "",
      apiKey: typeof r.jellyfin?.apiKey === "string" ? r.jellyfin.apiKey : "",
      ...(typeof r.jellyfin?.userId === "string" && r.jellyfin.userId ? { userId: r.jellyfin.userId } : {}),
      ...(typeof r.jellyfin?.userName === "string" && r.jellyfin.userName ? { userName: r.jellyfin.userName } : {}),
    },
    ...(isStringRecord(r.emulators) ? { emulators: r.emulators } : {}),
    ...(typeof r.biosDir === "string" && r.biosDir.trim() ? { biosDir: r.biosDir } : {}),
    ...(r.ui && typeof r.ui === "object" ? { ui: sanitizeUiPrefs(r.ui) } : {}),
    ...(r.covers && typeof r.covers === "object" ? { covers: { auto: r.covers.auto !== false } } : {}),
    gamesDir: typeof r.gamesDir === "string" ? r.gamesDir : "",
    completedAt: r.completedAt,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
