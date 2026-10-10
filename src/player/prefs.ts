/**
 * Gemerkte Player-Einstellungen (localStorage "jellystation.player"). Alles ist ein Komfort: Fehlt der Speicher
 * (privates Fenster, gesperrt), läuft der Player mit den Standardwerten weiter.
 */

const KEY = "jellystation.player";

export interface PlayerPrefs {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** Sprache des zuletzt gewählten Untertitels (Server-Kürzel, z. B. "ger"); "off" = bewusst abgeschaltet; fehlt = nie gewählt. */
  subtitleLang?: string;
  /** Höchste Bitrate in Bit/s; fehlt = Original/Automatisch. */
  maxBitrate?: number;
  /** true = der Server wandelt immer um (HLS), statt die Datei direkt abzuspielen. */
  alwaysTranscode?: boolean;
}

export const DEFAULT_PREFS: PlayerPrefs = { volume: 1, muted: false };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function loadPrefs(): PlayerPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const j = JSON.parse(raw) as Partial<PlayerPrefs> | null;
    if (!j || typeof j !== "object") return { ...DEFAULT_PREFS };
    return {
      volume: typeof j.volume === "number" && Number.isFinite(j.volume) ? clamp01(j.volume) : DEFAULT_PREFS.volume,
      muted: j.muted === true,
      ...(typeof j.subtitleLang === "string" && j.subtitleLang ? { subtitleLang: j.subtitleLang } : {}),
      ...(typeof j.maxBitrate === "number" && j.maxBitrate > 0 ? { maxBitrate: j.maxBitrate } : {}),
      ...(j.alwaysTranscode === true ? { alwaysTranscode: true } : {}),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Ändert einzelne Werte; `undefined` entfernt einen Wert. */
export function savePrefs(patch: { [K in keyof PlayerPrefs]?: PlayerPrefs[K] | undefined }): PlayerPrefs {
  const next: PlayerPrefs = { ...loadPrefs() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
    else (next as unknown as Record<string, unknown>)[k] = v;
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // bewusst ignoriert
  }
  return next;
}

/* ------------------------------------------------------------ Sprachkürzel */

/** Jellyfin liefert meist dreibuchstabige Kürzel (ISO 639-2: "ger" oder "deu"), Dateien auch zweibuchstabige. */
const LANG_ALIAS: Record<string, string> = {
  de: "deu", ger: "deu", deu: "deu",
  en: "eng", eng: "eng",
  fr: "fra", fre: "fra", fra: "fra",
  es: "spa", spa: "spa",
  it: "ita", ita: "ita",
  nl: "nld", dut: "nld", nld: "nld",
  pt: "por", por: "por",
  ru: "rus", rus: "rus",
  ja: "jpn", jpn: "jpn",
  zh: "zho", chi: "zho", zho: "zho",
  ko: "kor", kor: "kor",
  pl: "pol", pol: "pol",
  tr: "tur", tur: "tur",
  sv: "swe", swe: "swe",
  da: "dan", dan: "dan",
  cs: "ces", cze: "ces", ces: "ces",
};

/** Vergleichsschlüssel einer Sprache ("ger" und "de" ergeben dasselbe). */
export function langKey(lang: string | undefined): string {
  const l = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return LANG_ALIAS[l] ?? l;
}
