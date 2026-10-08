/**
 * Reine Hilfen für den Spielstart: Texte und Entscheidungen, die ohne React auskommen.
 */
import type { GameExit } from "../emulators/backend";

/** Läuft ein Prozess kürzer als das und endet dann, gilt der Start als gescheitert (typisch: Emulator kann die Datei nicht öffnen). */
export const QUICK_EXIT_MS = 4000;

/** Mindestdauer des Start-Overlays, damit der Übergang nicht aufblitzt (≈ 2,5 s). */
export const MIN_OVERLAY_MS = 2500;

/** "3,2 s", "42 s", "5 min 3 s", "1 h 5 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Argument so setzen, dass man die Zeile im Terminal einfügen kann (Leerzeichen/Anführungszeichen). */
export const quoteArg = (arg: string) => (/[\s"'\\$`]/.test(arg) || arg === "" ? `"${arg.replace(/(["\\$`])/g, "\\$1")}"` : arg);

/** Befehlszeile zum Anzeigen (nur Fallback – die Rust-Seite liefert die tatsächliche Zeile mit). */
export const commandLineOf = (program: string, args: readonly string[]) => [program, ...args].map(quoteArg).join(" ");

/** Wie ein Prozess endete: gescheitert (Code ≠ 0 oder Signal) und/oder auffällig kurz. */
export function judgeExit(exit: Pick<GameExit, "code" | "signal" | "durationMs">) {
  const failed = exit.code !== 0 || exit.signal !== null;
  const quick = exit.durationMs < QUICK_EXIT_MS;
  return { failed, quick, clean: !failed && !quick };
}

/** "mit Code 1" / "durch das Signal SIGSEGV". */
export function exitHow(exit: Pick<GameExit, "code" | "signal">): string {
  if (exit.signal !== null) return `durch das Signal ${exit.signal}`;
  return exit.code === null ? "ohne Exit-Code" : `mit Code ${exit.code}`;
}

/** Kurzform für Klammern: "Code 1" / "Signal SIGSEGV". */
export function exitShort(exit: Pick<GameExit, "code" | "signal">): string {
  if (exit.signal !== null) return `Signal ${exit.signal}`;
  return exit.code === null ? "ohne Exit-Code" : `Code ${exit.code}`;
}

/**
 * Inhalt des Detailblocks: Befehl, dann Ausgabe und zuletzt die Fehlerausgabe (leere Abschnitte entfallen).
 * Der Dialog zeigt bei Fehlern das Ende des Blocks zuerst – dort steht dann die Fehlerausgabe mit der Ursache.
 */
export function exitDetail(commandLine: string, exit: Pick<GameExit, "stderrTail" | "stdoutTail">): string[] {
  const out: string[] = ["Befehl:", commandLine];
  if (exit.stdoutTail.length > 0) out.push("", "Ausgabe:", ...exit.stdoutTail);
  if (exit.stderrTail.length > 0) out.push("", "Fehlerausgabe:", ...exit.stderrTail);
  if (exit.stderrTail.length === 0 && exit.stdoutTail.length === 0) out.push("", "(Der Emulator hat nichts ausgegeben.)");
  return out;
}

/**
 * Ordnet einen Fehlertext von game_launch ein. Rust liefert deutschen Text, z. B. „Programm nicht gefunden: …“,
 * „Keine ausführbare Datei (Ausführungsrecht fehlt): …“, „Start nicht möglich: … Ausführung nicht erlaubt …“,
 * „„Titel“ läuft bereits“.
 */
export function classifyLaunchError(text: string): "already-running" | "not-found" | "not-executable" | "other" {
  if (/läuft bereits|schon gestartet|already running/i.test(text)) return "already-running";
  if (/nicht gefunden|existiert nicht|no such file|not found/i.test(text)) return "not-found";
  if (/nicht ausführbar|keine ausführbare|ausführungsrecht|ausführung nicht erlaubt|keine berechtigung|permission denied|not executable/i.test(text)) {
    return "not-executable";
  }
  return "other";
}
