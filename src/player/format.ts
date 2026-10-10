import type { XmbEntry } from "../data/types";
import type { PlaybackPlan, PlayMethod } from "../jellyfin/playback";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** h:mm:ss – auch bei Laufzeiten unter einer Stunde ("0:04:07"), wie die Zeitanzeige der PS3. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

/** Uhrzeit für die Ecke oben rechts ("14:32"). */
export function formatDayTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Bitrate als "8,4 Mbit/s". */
export function formatBitrate(bps: number | undefined): string {
  if (!bps || bps <= 0) return "";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1).replace(".", ",")} Mbit/s`;
  return `${Math.round(bps / 1000)} kbit/s`;
}

export const METHOD_LABEL: Record<PlayMethod, string> = {
  DirectPlay: "Direkt abgespielt",
  DirectStream: "Umgepackt",
  Transcode: "Transkodiert",
};

/** Kurzform für die Anzeige unten rechts im Bedienfeld. */
export const METHOD_SHORT: Record<PlayMethod, string> = {
  DirectPlay: "Direkt",
  DirectStream: "Umgepackt",
  Transcode: "Transkodiert",
};

export interface Headline {
  /** Große Zeile: Filmtitel bzw. Serienname. */
  title: string;
  /** Kleine Zeile: "S01 E03 · Folgentitel" bzw. Jahr. */
  subtitle?: string;
}

/** "S01 E03" aus dem Verweis; fehlen Nummern, entfällt der jeweilige Teil. */
export function episodeCode(ref: { seasonNumber?: number; episodeNumber?: number } | undefined): string {
  if (!ref) return "";
  return [
    ref.seasonNumber !== undefined ? `S${pad2(ref.seasonNumber)}` : "",
    ref.episodeNumber !== undefined ? `E${pad2(ref.episodeNumber)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Titelzeilen des OSD: Folgen zeigen den Serienamen groß, darunter Nummer und Folgentitel. */
export function headlineOf(entry: XmbEntry, plan: PlaybackPlan | null): Headline {
  const ref = plan?.ref ?? entry.jellyfin;
  const own = plan?.title || entry.title;
  if (ref?.type === "Episode") {
    const code = episodeCode(ref);
    const series = ref.seriesName || entry.jellyfin?.seriesName;
    if (series) return { title: series, subtitle: [code, own].filter(Boolean).join(" · ") || undefined };
    return { title: own, subtitle: code || undefined };
  }
  return { title: own, subtitle: plan?.subtitle || entry.subtitle || undefined };
}
