/**
 * PS3-Systemklänge (WAV-Dateien in public/sounds/ps3/). Sie ersetzen – solange `soundPack` auf "ps3" steht – die
 * synthetisierten Menü-Töne für Zurück, Bestätigen und Fehler und liefern Boot-, Spielstart-, Options- und Erfolgsklang.
 *
 * Herkunft: Klänge der PlayStation-3-Systemsoftware (Sony). Sie liegen auf ausdrücklichen Wunsch im Repo und sind
 * rechtlich Sonys Eigentum – siehe docs/ARCHITEKTUR.md. Fehlt eine Datei oder lässt sie sich nicht dekodieren,
 * greift der Aufrufer auf die synthetischen Töne zurück.
 */

export type PsSound = "coldboot" | "gameboot" | "cancel" | "ok" | "ng" | "option" | "trophy";

interface Def {
  file: string;
  /** Lautester Pegel der Originaldatei in dBFS (gemessen). Die Originale sind sehr leise; daraus ergibt sich die Verstärkung. */
  peakDb: number;
  /** Ziel-Spitzenpegel in dBFS bei Lautstärke 100 %. */
  targetDb: number;
}

export const PS_SOUNDS: Record<PsSound, Def> = {
  coldboot: { file: "coldboot_stereo.wav", peakDb: -16.9, targetDb: -6 },
  gameboot: { file: "gameboot_stereo.wav", peakDb: -17.8, targetDb: -8 },
  cancel: { file: "snd_cancel.wav", peakDb: -27.6, targetDb: -10 },
  ok: { file: "snd_system_ok.wav", peakDb: -31.3, targetDb: -10 },
  ng: { file: "snd_system_ng.wav", peakDb: -23, targetDb: -9 },
  option: { file: "snd_option.wav", peakDb: -20.6, targetDb: -10 },
  trophy: { file: "snd_trophy.wav", peakDb: -5.9, targetDb: -8 },
};

/** Lineare Verstärkung, die die Originaldatei auf ihren Ziel-Spitzenpegel bringt. */
export const psGain = (id: PsSound) => 10 ** ((PS_SOUNDS[id].targetDb - PS_SOUNDS[id].peakDb) / 20);

const base = () => (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
export const psSoundUrl = (id: PsSound) => `${base()}sounds/ps3/${PS_SOUNDS[id].file}`;

const buffers = new Map<PsSound, AudioBuffer>();
const pending = new Map<PsSound, Promise<AudioBuffer | null>>();

/** Schon dekodierter Klang (null, solange er noch lädt oder fehlt). */
export const peekPsSound = (id: PsSound): AudioBuffer | null => buffers.get(id) ?? null;

/** Lädt und dekodiert einen Klang einmalig; bei Fehlern null (wird beim nächsten Aufruf erneut versucht). */
export function loadPsSound(ctx: BaseAudioContext, id: PsSound): Promise<AudioBuffer | null> {
  const have = buffers.get(id);
  if (have) return Promise.resolve(have);
  let job = pending.get(id);
  if (!job) {
    job = fetch(psSoundUrl(id))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      // Die Callback-Form läuft auch in älteren WebKit-Versionen, die noch kein Promise liefern.
      .then((data) => new Promise<AudioBuffer>((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
      .then((buf) => {
        buffers.set(id, buf);
        return buf;
      })
      .catch((err) => {
        console.warn(`PS3-Klang ${id} nicht verfügbar`, err);
        return null;
      })
      .finally(() => pending.delete(id));
    pending.set(id, job);
  }
  return job;
}

/** Kurze Klänge werden nach dem Anlegen des Audio-Kontexts im Voraus geladen (der lange Boot-Klang erst auf Anfrage). */
export const PRELOAD: readonly PsSound[] = ["cancel", "ok", "ng", "option", "trophy", "gameboot"];
