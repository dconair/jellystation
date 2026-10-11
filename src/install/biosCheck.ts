/**
 * Prüfung von BIOS- und Firmware-Dateien, die der Nutzer selbst ablegt: Größe, Dateikopf, bekannte Prüfsumme.
 *
 * Die App liefert und lädt keine BIOS-Dateien. Sie sagt nur, ob eine Datei plausibel aussieht, damit „der Emulator
 * startet nicht“ nicht erst nach dem Kopieren auffällt. Eine unbekannte Prüfsumme ist KEIN Fehler (es gibt viele
 * Regionen und Revisionen) – nur eine falsche Größe oder ein falscher Dateikopf gilt als ungeeignet.
 */
import type { Fingerprint } from "./backend";

export type BiosVerdict =
  /** Bekannte Datei (Prüfsumme in der Tabelle). */
  | "known"
  /** Sieht richtig aus, ist aber nicht in der Tabelle. */
  | "plausible"
  /** Falsche Größe oder falscher Dateikopf. */
  | "invalid";

export interface BiosAnalysis {
  verdict: BiosVerdict;
  /** Eine Zeile für die Oberfläche. */
  text: string;
  /** Erkannter Name, z. B. „SCPH-5501 (USA)“. */
  name?: string;
}

/**
 * Bekannte PS1-BIOS-Abbilder (MD5, wie sie die Emulator-Projekte angeben).
 * UNGEPRÜFT gegen eine Quelle (kein Netz zu den Listen in der Entwicklungsumgebung): ein Treffer sagt „bekannt“,
 * ein Nichttreffer nur „unbekannte Revision“ – nie „kaputt“.
 */
export const PS1_BIOS: Record<string, string> = {
  "924e392ed05558ffdb115408c263dccf": "SCPH-1001 (USA)",
  "8dd7d5296a650fac7319bce665a6a53c": "SCPH-5500 (Japan)",
  "490f666e1afb15b7362b406ed1cea246": "SCPH-5501 (USA)",
  "32736f17079d0b2b7024407c39bd3050": "SCPH-5502 (Europa)",
  "1e68c231d0896b7eadcad1d7d8e76129": "SCPH-7001 (USA)",
};

const MiB = 1024 * 1024;
/** Dateikopf der PS3-Firmware (PS3UPDAT.PUP): ASCII „SCEUF“. */
const PUP_MAGIC = "5343455546";

export function analyzeBios(requirementId: string, fp: Fingerprint): BiosAnalysis {
  switch (requirementId) {
    case "ps1-bios": {
      if (fp.size !== 512 * 1024) return { verdict: "invalid", text: `Ein PS1-BIOS ist genau 512 KB groß, diese Datei hat ${describeSize(fp.size)}.` };
      const name = PS1_BIOS[fp.md5];
      return name
        ? { verdict: "known", name, text: `Bekanntes PS1-BIOS: ${name}` }
        : { verdict: "plausible", text: "Größe passt (512 KB). Die Revision ist mir nicht bekannt – DuckStation entscheidet beim Start." };
    }
    case "ps2-bios": {
      if (fp.size < 1 * MiB || fp.size > 8 * MiB) return { verdict: "invalid", text: `Ein PS2-BIOS ist etwa 4 MB groß, diese Datei hat ${describeSize(fp.size)}.` };
      return { verdict: "plausible", text: `Größe passt (${describeSize(fp.size)}). PCSX2 prüft das BIOS beim ersten Start selbst.` };
    }
    case "ps3-firmware": {
      if (!fp.head.toLowerCase().startsWith(PUP_MAGIC)) return { verdict: "invalid", text: "Das ist keine PS3-Firmware (PS3UPDAT.PUP): Der Dateikopf „SCEUF“ fehlt. Vielleicht wurde eine Webseite statt der Datei geladen." };
      if (fp.size < 50 * MiB) return { verdict: "invalid", text: `Die Firmware ist unvollständig: ${describeSize(fp.size)} (erwartet etwa 200 MB).` };
      return { verdict: "plausible", text: `Sieht aus wie eine PS3-Firmware (${describeSize(fp.size)}, Dateikopf passt).` };
    }
    default:
      return { verdict: "plausible", text: `${describeSize(fp.size)}` };
  }
}

export function describeSize(bytes: number): string {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(bytes >= 100 * MiB ? 0 : 1).replace(".", ",")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} Byte`;
}

/** Offizielle Server, von denen die App PS3-Firmware lädt, wenn der Nutzer einen Link von Sony einfügt. */
export const SONY_FIRMWARE_HOSTS = ["*.playstation.net", "*.playstation.com", "playstation.com", "*.sony.com", "*.sonyentertainmentnetwork.com"];

/** true, wenn der Server der Adresse ein offizieller Sony-Server ist. */
export function isSonyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SONY_FIRMWARE_HOSTS.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p));
  } catch {
    return false;
  }
}
