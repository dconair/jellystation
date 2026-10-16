/**
 * Datentypen der Diagnose: ein Befund (Finding) beschreibt, was geprüft wurde, wie es ausging und – falls möglich –
 * was die App dagegen tun kann (Fix).
 */
import type { GameExit } from "../emulators/backend";
import type { RequirementStatus } from "../emulators/requirements";
import type { EmulatorStatus } from "../emulators/status";

export type Level = "error" | "warn" | "info" | "ok";

/** Was ein Klick behebt. Die ersten beiden ändern etwas, die anderen führen zum passenden Dialog. */
export type Fix =
  | { kind: "copy-bios"; status: RequirementStatus }
  | { kind: "clear-quarantine"; path: string }
  | { kind: "open-emulators"; emulatorId: string }
  | { kind: "open-files"; emulatorId: string }
  | { kind: "open-games-dir" };

export interface FixAction {
  fix: Fix;
  label: string;
  /** true = harmlos; „Alles Behebbare beheben“ führt es ohne weitere Rückfrage aus. */
  auto: boolean;
}

export interface Finding {
  /** Eindeutig innerhalb eines Berichts. */
  id: string;
  level: Level;
  title: string;
  /** Erklärung und der konkrete nächste Schritt, in ganzen Sätzen. */
  detail: string;
  emulatorId?: string;
  fix?: FixAction;
  links?: { label: string; url: string }[];
  /** Auszug zum Nachlesen (Protokollzeilen, Dateinamen). */
  extra?: string[];
}

/** Anlass der Diagnose: Ein Spiel ließ sich nicht starten oder wurde sofort beendet. */
export interface DiagnoseContext {
  emulatorId: string | null;
  title: string;
  path: string;
  system: string;
  commandLine?: string;
  /** Der Prozess lief und endete (Exit-Code, Signal, Ausgabe). */
  exit?: Pick<GameExit, "code" | "signal" | "durationMs" | "stderrTail" | "stdoutTail" | "hint">;
  /** `game_launch` selbst hat den Start abgelehnt (Text auf Deutsch). */
  launchError?: string;
  /** Was die App vor dem Anzeigen der Diagnose selbst schon behoben oder versucht hat (nur RPCS3). */
  repairNotes?: string[];
}

export interface DiagnoseGame {
  title: string;
  path: string;
  system: string;
}

export interface DiagnoseInput {
  emulators: readonly EmulatorStatus[];
  biosDir: string;
  gamesDir: string;
  /** Echte Spiele der Bibliothek (keine Demo-Einträge). */
  games: readonly DiagnoseGame[];
  context?: DiagnoseContext;
}

export interface ReportLog {
  title: string;
  lines: string[];
}

export interface DiagnoseReport {
  findings: Finding[];
  logs: ReportLog[];
  /** Wie viele Spiele geprüft wurden (und wie viele die Bibliothek hat). */
  checkedGames: number;
  totalGames: number;
  at: number;
}
