import type { XmbEntry } from "../data/types";
import { DEMO_DURATION_SEC } from "../player/demoPlan";
import type { SeriesEpisode } from "./seasons";

/*
 * Demo-Folgen für Serien ohne Server: zwei Staffeln mit gemischtem Stand (eine gesehen, eine angefangen).
 * Die Folgen haben kein `jellyfin` – der Player spielt dann den kurzen Demo-Clip aus public/demo.
 */

interface Row {
  season: number;
  number: number;
  title: string;
  minutes: number;
  premiere: string;
  /** Fortschritt 0..1, 1 = gesehen. */
  progress?: number;
  overview: string;
}

const ROWS: readonly Row[] = [
  {
    season: 1,
    number: 1,
    title: "Der Anfang",
    minutes: 42,
    premiere: "2024-03-08",
    progress: 1,
    overview:
      "Ein ruhiger Morgen, ein unerwarteter Anruf: Als ein alter Bekannter plötzlich vor der Tür steht, gerät der Alltag der Hauptfigur aus den Fugen. Was zunächst wie ein Missverständnis aussieht, ist der erste Hinweis auf etwas Größeres.",
  },
  {
    season: 1,
    number: 2,
    title: "Spuren im Nebel",
    minutes: 45,
    premiere: "2024-03-15",
    progress: 0.45,
    overview:
      "Die Suche führt in die Berge. Zwischen verlassenen Hütten und zugewachsenen Pfaden entdeckt das Team Spuren, die nicht zur offiziellen Geschichte passen. Als der Nebel aufzieht, wird klar, dass sie nicht allein sind.",
  },
  {
    season: 1,
    number: 3,
    title: "Das Gewicht der Wahrheit",
    minutes: 51,
    premiere: "2024-03-22",
    overview:
      "Nach dem Fund im Archiv steht alles auf dem Spiel. Während draußen ein Sturm aufzieht, muss sich die Gruppe entscheiden, wem sie noch vertrauen kann. Alte Freundschaften werden auf die Probe gestellt, und eine lang gehütete Lüge kommt ans Licht.\n\nIn Rückblenden zeigt die Folge, wie alles begann: eine Entscheidung in einer verregneten Nacht, die niemand mehr rückgängig machen konnte. Am Ende bleibt nur die Frage, ob die Wahrheit den Preis wert ist, den sie kostet – und wer ihn am Ende bezahlen muss.\n\nEine ruhige, dichte Folge, die ihre Spannung aus Blicken und Pausen zieht.",
  },
  {
    season: 1,
    number: 4,
    title: "Ein Fenster zur Nacht",
    minutes: 38,
    premiere: "2024-03-29",
    overview:
      "Das Staffelfinale: Eine einzige Nacht, ein Haus am Meer und die Frage, was von einem Neuanfang bleibt, wenn man alles hinter sich lassen muss.",
  },
  {
    season: 2,
    number: 1,
    title: "Neue Ufer",
    minutes: 47,
    premiere: "2025-02-07",
    overview:
      "Ein Jahr später: Die Gruppe hat sich in alle Winde zerstreut. Erst ein Brief ohne Absender bringt sie wieder zusammen – und mit ihm die Erinnerung an das, was sie damals zurückgelassen haben.",
  },
  {
    season: 2,
    number: 2,
    title: "Wenn der Wind sich dreht und alle Pläne in Frage stehen",
    minutes: 44,
    premiere: "2025-02-14",
    overview:
      "Ein Plan, der auf dem Papier perfekt aussah, zerfällt an der Wirklichkeit. Zwischen Improvisation und Misstrauen versucht das Team, die Kontrolle zurückzugewinnen, bevor die Zeit abläuft.",
  },
  {
    season: 2,
    number: 3,
    title: "Der letzte Zug",
    minutes: 56,
    premiere: "2025-02-21",
    overview:
      "Alles läuft auf eine Entscheidung am Bahnhof hinaus. Wer steigt ein, wer bleibt zurück – und was hat das alles gekostet? Ein leiser, großer Abschluss.",
  },
];

/** Demo-Folgen einer Serie (immer dieselben, die Farbe richtet sich nach der Serie). */
export function demoEpisodes(series: Pick<XmbEntry, "id" | "hue">): SeriesEpisode[] {
  return ROWS.map((row, i) => {
    const runtimeSec = row.minutes * 60;
    const played = row.progress === 1;
    const ratio = row.progress !== undefined && !played ? row.progress : 0;
    const resumeSec = Math.round(runtimeSec * ratio);
    const code = `S${String(row.season).padStart(2, "0")} E${String(row.number).padStart(2, "0")}`;
    const entry: XmbEntry = {
      id: `demo/${series.id}/s${row.season}e${row.number}`,
      title: row.title,
      subtitle: `${code} · ${row.minutes} Min`,
      description: row.overview,
      hue: (series.hue + i * 23) % 360,
      art: { kind: "generated" },
      artShape: "landscape",
    };
    return {
      key: entry.id,
      entry,
      season: row.season,
      number: row.number,
      title: row.title,
      overview: row.overview,
      runtimeSec,
      resumeSec,
      // Der Demo-Clip dauert nur wenige Sekunden: die Position wird entsprechend umgerechnet.
      startSec: Math.round(ratio * DEMO_DURATION_SEC),
      ratio,
      played,
      premiere: row.premiere,
      demo: true,
    };
  });
}
