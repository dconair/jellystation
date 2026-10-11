/** Ein vom Nutzer eingetragenes Addon (`settings.stremio.addons`). */
export interface StremioAddonCfg {
  /** Zufällige Kennung, damit Einträge ihre Herkunft behalten, auch wenn sich die Adresse ändert. */
  id: string;
  /** Adresse der `manifest.json` (https, auch aus `stremio://` übernommen). */
  url: string;
  /** Anzeigename aus dem Manifest. */
  name: string;
  /** true = stammt aus dem Stremio-Konto und wird beim Aktualisieren des Kontos ersetzt; sonst von Hand eingetragen. */
  fromAccount?: boolean;
}

/** Angemeldetes Stremio-Konto. Das Passwort wird nie gespeichert, nur der Schlüssel, den Stremio dafür ausgibt. */
export interface StremioAccount {
  email: string;
  authKey: string;
}

export interface StremioSettings {
  addons: StremioAddonCfg[];
  account?: StremioAccount;
}

export type StremioType = "movie" | "series";

/** Eine Ressource des Manifests: entweder nur der Name oder mit eigener Typ-/ID-Einschränkung. */
export interface ManifestResource {
  name: string;
  types?: string[];
  idPrefixes?: string[];
}

export interface ManifestCatalog {
  type: string;
  id: string;
  name: string;
  /** Der Katalog braucht zwingend eine Zusatzangabe (Suchbegriff, Genre …) und taugt dann nicht als Startliste. */
  needsExtra: boolean;
  /** Das Addon versteht für diesen Katalog eine Suche (`search`). */
  searchable: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  types: string[];
  idPrefixes?: string[];
  resources: ManifestResource[];
  catalogs: ManifestCatalog[];
}

/** Vorschau-Eintrag eines Katalogs (Meta Preview). */
export interface Meta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  /** "2010" oder "2010–2014" – je nach Addon aus `releaseInfo` oder `year`. */
  year?: string;
  genres: string[];
  runtime?: string;
  videos: MetaVideo[];
}

/** Eine Folge einer Serie (Teil der vollständigen Meta). */
export interface MetaVideo {
  id: string;
  title: string;
  season: number;
  episode: number;
  released?: string;
  thumbnail?: string;
  overview?: string;
}

/** Eine Stream-Angabe eines Addons, soweit die App sie abspielen kann. */
export interface StremioStream {
  addonId: string;
  addonName: string;
  /** Direkte http(s)-Adresse. */
  url: string;
  /** Qualitätsangabe des Addons (z. B. „1080p“). */
  name: string;
  /** Beschreibung des Addons (z. B. Dateiname, Größe). */
  description: string;
  /** Das Addon warnt, dass der Stream im Web-Player evtl. nicht läuft (`notWebReady`). */
  risky: boolean;
}

export interface StreamResult {
  playable: StremioStream[];
  /** Streams, die die App nicht abspielen kann (Torrent, YouTube, externe Seite, Spezial-Header). */
  skipped: number;
  /** Addons, die nicht geantwortet haben. */
  failedAddons: string[];
  /** Anzahl der befragten Addons. */
  asked: number;
}
