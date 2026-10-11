/**
 * Führt die Diagnose aus: Einstellungen, Emulatoren, BIOS/Firmware, Spieldateien und – nach einem fehlgeschlagenen
 * Start – Exit-Code und Ausgabe des Emulators. Alles lesend; geändert wird nur auf ausdrücklichen Klick (siehe `applyFix`).
 *
 * Nichts davon wirft: Scheitert eine Stufe, erscheint sie als Hinweis im Bericht und die übrigen laufen weiter.
 */
import { errorText, launchLogTail } from "../emulators/backend";
import { EMULATORS, emulatorForSystem, getEmulator } from "../emulators/catalog";
import type { EmulatorDef } from "../emulators/catalog";
import { checkRequirements, describeRequirement, installRequirement, requirementsFor } from "../emulators/requirements";
import type { RequirementStatus } from "../emulators/requirements";
import { tildePath } from "../emulators/status";
import type { EmulatorStatus } from "../emulators/status";
import { isTauri } from "../platform";
import { diagClearQuarantine, diagLogTail, diagProbe } from "./backend";
import type { FileProbe } from "./backend";
import { analyzeOutput, baseOf, biosHeadProblem, emulatorLogPaths, explainExit, findingForGame, findingForGames, gameIssues } from "./rules";
import type { GameIssue, GameIssueCode } from "./rules";
import type { DiagnoseGame, DiagnoseInput, DiagnoseReport, Finding, Fix, Level, ReportLog } from "./types";

/** Mehr Spiele werden nicht auf einmal geprüft (die Bibliothek fasst bis zu 20 000). */
export const MAX_GAMES = 1500;
const PROBE_CHUNK = 250;
/** Ein Emulator-Protokoll zählt als „von diesem Start“, wenn es höchstens so alt ist. */
const FRESH_LOG_MS = 15 * 60 * 1000;

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, ok: 3 };

async function probeAll(paths: string[]): Promise<Map<string, FileProbe>> {
  const map = new Map<string, FileProbe>();
  for (let i = 0; i < paths.length; i += PROBE_CHUNK) {
    const chunk = paths.slice(i, i + PROBE_CHUNK);
    const res = await diagProbe(chunk);
    chunk.forEach((p, n) => map.set(p, res[n]));
  }
  return map;
}

const safe = async <T>(label: string, work: () => Promise<T>, onError: (f: Finding) => void): Promise<T | undefined> => {
  try {
    return await work();
  } catch (err) {
    onError({ id: `fail-${label}`, level: "info", title: `Prüfung übersprungen: ${label}`, detail: `Diese Prüfung ist fehlgeschlagen: ${errorText(err)}` });
    return undefined;
  }
};

/* ------------------------------------------------------------------ Teilprüfungen */

function settingsFindings(input: DiagnoseInput, probes: Map<string, FileProbe>): Finding[] {
  const dir = input.gamesDir.trim();
  if (!dir) {
    return [
      {
        id: "games-dir",
        level: "warn",
        title: "Kein Spiele-Ordner gewählt",
        detail: "Ohne Spiele-Ordner zeigt die App nur Demo-Spiele. Wähle den Ordner, in den du deine Spiele legst.",
        fix: { fix: { kind: "open-games-dir" }, label: "Ordner wählen", auto: false },
      },
    ];
  }
  const p = probes.get(dir);
  if (!p || !p.exists) {
    return [
      {
        id: "games-dir",
        level: "error",
        title: "Spiele-Ordner nicht gefunden",
        detail: `Der Ordner ${tildePath(dir)} existiert nicht (mehr). Ist die externe Festplatte angeschlossen? Sonst wähle den Ordner neu.`,
        fix: { fix: { kind: "open-games-dir" }, label: "Ordner wählen", auto: false },
      },
    ];
  }
  if (!p.readable) {
    return [
      {
        id: "games-dir",
        level: "error",
        title: "Spiele-Ordner nicht lesbar",
        detail: `Der Ordner ${tildePath(dir)} lässt sich nicht auflisten${p.error ? ` (${p.error})` : ""}. Erlaube JellyStation den Zugriff unter Systemeinstellungen → Datenschutz & Sicherheit → Dateien und Ordner.`,
        fix: { fix: { kind: "open-games-dir" }, label: "Ordner wählen", auto: false },
      },
    ];
  }
  return [{ id: "games-dir", level: "ok", title: "Spiele-Ordner in Ordnung", detail: `${tildePath(dir)} ist lesbar.` }];
}

function emulatorFindings(
  status: EmulatorStatus,
  relevant: boolean,
  gameCount: number,
  probes: Map<string, FileProbe>,
  focus: boolean,
): Finding[] {
  const def = status.def;
  const id = `emu-${def.id}`;
  const fix = (label: string): Finding["fix"] => ({ fix: { kind: "open-emulators", emulatorId: def.id }, label, auto: false });
  if (!status.checkable) return [{ id, level: "info", title: `${def.name}: nicht prüfbar`, detail: "Das lässt sich nur in der Desktop-App prüfen.", emulatorId: def.id }];
  if (status.pending) return [{ id, level: "info", title: `${def.name}: wird noch gesucht`, detail: "Die Suche läuft noch – prüfe in einem Moment erneut.", emulatorId: def.id }];

  const games = gameCount > 0 ? ` Für ${def.consoles} liegen ${gameCount} Spiele in der Bibliothek.` : "";
  if (!status.valid || !status.path) {
    if (status.source === "custom") {
      return [
        {
          id,
          level: relevant ? "error" : "warn",
          title: `${def.name}: gewählter Pfad nicht nutzbar`,
          detail: `${status.error ?? "Der Pfad lässt sich nicht starten."} Wähle die App neu aus oder lass sie automatisch suchen.${games}`,
          emulatorId: def.id,
          fix: fix("Emulator wählen"),
        },
      ];
    }
    return [
      {
        id,
        level: relevant ? "error" : "info",
        title: relevant ? `${def.name} ist nicht installiert` : `${def.name}: nicht installiert`,
        detail: relevant
          ? `Ohne ${def.name} lassen sich keine ${def.consoles}-Spiele starten.${games} Installiere ihn (wo möglich mit einem Klick per Homebrew) oder wähle die App aus, falls sie schon da ist.`
          : `Nicht nötig, solange du keine ${def.consoles}-Spiele hast.`,
        emulatorId: def.id,
        fix: relevant ? fix("Emulator einrichten") : undefined,
      },
    ];
  }

  const out: Finding[] = [];
  const probe = probes.get(status.path);
  const version = status.version ? `, Version ${status.version}` : "";
  if (probe?.quarantined) {
    out.push({
      id,
      level: focus || relevant ? "warn" : "info",
      title: `${def.name}: von macOS in Quarantäne gesetzt`,
      detail: `${tildePath(status.path)} trägt die Quarantäne-Markierung aus dem Internet-Download. macOS bricht den Start dann oft sofort ab (ohne Fehlermeldung). Mit einem Klick hebt JellyStation die Markierung auf.`,
      emulatorId: def.id,
      fix: { fix: { kind: "clear-quarantine", path: status.path }, label: "Quarantäne aufheben", auto: true },
    });
  } else if (status.hint) {
    out.push({ id, level: "warn", title: `${def.name}: ${status.hint}`, detail: `${tildePath(status.path)}${version}. Verschiebe die App nach „Programme“, damit sie dauerhaft gefunden wird.`, emulatorId: def.id });
  } else {
    out.push({ id, level: "ok", title: `${def.name} gefunden`, detail: `${tildePath(status.path)}${version}`, emulatorId: def.id });
  }
  return out;
}

async function requirementFindings(input: DiagnoseInput, relevantIds: ReadonlySet<string>): Promise<{ findings: Finding[]; statuses: RequirementStatus[] }> {
  const defs = EMULATORS.filter((d) => relevantIds.has(d.id));
  const reqs = defs.flatMap((d) => requirementsFor(d.id));
  if (reqs.length === 0) return { findings: [], statuses: [] };
  const statuses = await checkRequirements(input.biosDir, reqs);
  const heads = await probeAll(statuses.flatMap((s) => (s.state === "ready" || s.state === "in-folder") && s.path ? [s.path] : []));
  const findings: Finding[] = [];
  for (const s of statuses) {
    const id = `req-${s.req.id}`;
    const emulatorId = s.req.emulatorId;
    const named = `${s.req.label} (${getEmulator(emulatorId)?.name ?? emulatorId})`;
    const d = describeRequirement(s);
    if (s.state === "unknown") {
      findings.push({ id, level: "info", title: `${named}: nicht prüfbar`, detail: d.text, emulatorId });
      continue;
    }
    if (s.state === "missing") {
      const level: Level = s.req.uncertain ? "info" : s.req.required ? "error" : "warn";
      findings.push({
        id,
        level,
        title: `${s.req.label} fehlt`,
        detail: `${s.req.description} ${s.req.uncertain ? "Ob sie eingespielt ist, kann die App hier nicht sicher feststellen." : "Lege die Datei in den BIOS-Ordner der App und übernimm sie danach in den Emulator."}`,
        emulatorId,
        fix: { fix: { kind: "open-files", emulatorId }, label: "BIOS & Firmware", auto: false },
        links: s.req.links,
      });
      continue;
    }
    // Datei gefunden (bereit oder nur im BIOS-Ordner): sieht sie brauchbar aus?
    const file = s.state === "in-folder" ? s.folderPath : s.path;
    const head = file ? heads.get(file) : undefined;
    const bad = file && head && head.isFile ? biosHeadProblem(baseOf(file), head.headHex, head.size) : null;
    if (bad) {
      findings.push({
        id,
        level: "error",
        title: `${s.req.label}: Datei unbrauchbar`,
        detail: `${bad} Sichere die Datei von deiner eigenen Konsole bzw. lade die offizielle Version erneut.`,
        emulatorId,
        extra: ["Datei:", file ?? ""],
        links: s.req.links,
      });
    } else if (s.state === "ready") {
      findings.push({ id, level: "ok", title: `${s.req.label} vorhanden`, detail: s.path ? tildePath(s.path) : "Bereit.", emulatorId });
    } else if (s.req.copyTo) {
      findings.push({
        id,
        level: "warn",
        title: `${s.req.label} liegt noch im BIOS-Ordner`,
        detail: `Die Datei ist gefunden, aber noch nicht im Emulator. ${s.req.installHint} Mit einem Klick kopiert JellyStation sie dorthin (die Originaldatei bleibt liegen).`,
        emulatorId,
        fix: { fix: { kind: "copy-bios", status: s }, label: "BIOS übernehmen", auto: true },
      });
    } else {
      findings.push({
        id,
        level: "warn",
        title: `${s.req.label} gefunden, aber noch nicht eingespielt`,
        detail: s.req.installHint,
        emulatorId,
        fix: { fix: { kind: "open-files", emulatorId }, label: "BIOS & Firmware", auto: false },
        links: s.req.links,
      });
    }
  }
  return { findings, statuses };
}

interface GameCheck {
  findings: Finding[];
  checked: number;
}

function gameFindings(games: readonly DiagnoseGame[], probes: Map<string, FileProbe>, focusPath: string | undefined): GameCheck {
  const groups = new Map<GameIssueCode, { game: DiagnoseGame; def: EmulatorDef | null; note?: string }[]>();
  let checked = 0;
  for (const game of games) {
    if (game.path === focusPath) continue; // wird einzeln geprüft
    const p = probes.get(game.path);
    if (!p) continue;
    checked++;
    const def = emulatorForSystem(game.system) ?? null;
    for (const issue of gameIssues(game.path, def, p)) {
      const list = groups.get(issue.code) ?? [];
      list.push({ game, def, note: issue.note });
      groups.set(issue.code, list);
    }
  }
  const findings = [...groups.entries()].map(([code, items]) => findingForGames(code, items));
  if (checked > 0 && findings.length === 0) {
    findings.push({ id: "games-ok", level: "ok", title: `${checked} Spieldateien in Ordnung`, detail: "Alle Dateien sind lesbar, nicht leer und haben eine passende Endung." });
  }
  return { findings, checked };
}

function focusGameFindings(ctx: NonNullable<DiagnoseInput["context"]>, def: EmulatorDef | null, p: FileProbe | undefined): Finding[] {
  if (!p) return [];
  const game: DiagnoseGame = { title: ctx.title, path: ctx.path, system: ctx.system };
  const issues: GameIssue[] = gameIssues(ctx.path, def, p);
  if (issues.length === 0) {
    return [{ id: "game-ok", level: "ok", title: `Spieldatei in Ordnung: ${ctx.title}`, detail: "Die Datei ist lesbar, nicht leer und hat eine passende Endung.", extra: ["Pfad:", ctx.path] }];
  }
  return issues.map((i) => findingForGame(game, def, i));
}

/* ------------------------------------------------------------------ Gesamtlauf */

/** Prüft alles und liefert den Bericht (Befunde nach Schwere sortiert, innerhalb gleicher Schwere in Prüfreihenfolge). */
export async function runDiagnosis(input: DiagnoseInput): Promise<DiagnoseReport> {
  const at = Date.now();
  if (!isTauri()) {
    return {
      findings: [
        {
          id: "browser",
          level: "info",
          title: "Nur in der Desktop-App prüfbar",
          detail: "Die Diagnose liest Dateien, Emulatoren und Protokolle auf diesem Rechner. Im Browser (Demo-Modus) gibt es nichts davon.",
        },
      ],
      logs: [],
      checkedGames: 0,
      totalGames: input.games.length,
      at,
    };
  }

  const findings: Finding[] = [];
  const logs: ReportLog[] = [];
  const add = (f: Finding) => findings.push(f);
  const ctx = input.context;
  const ctxDef = ctx?.emulatorId ? (getEmulator(ctx.emulatorId) ?? null) : ctx ? (emulatorForSystem(ctx.system) ?? null) : null;

  // Welche Emulatoren zählen? Die, für die es Spiele gibt, und der des fehlgeschlagenen Starts.
  const counts = new Map<string, number>();
  for (const g of input.games) {
    const d = emulatorForSystem(g.system);
    if (d) counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
  }
  const relevant = new Set<string>(counts.keys());
  if (ctxDef) relevant.add(ctxDef.id);

  const games = input.games.slice(0, MAX_GAMES);
  const paths = new Set<string>();
  if (input.gamesDir.trim()) paths.add(input.gamesDir.trim());
  for (const s of input.emulators) if (s.valid && s.path) paths.add(s.path);
  for (const g of games) paths.add(g.path);
  if (ctx?.path) paths.add(ctx.path);

  const probes =
    (await safe("Dateien", () => probeAll([...paths]), add)) ?? new Map<string, FileProbe>();

  // 1. Der Anlass: was beim Start passiert ist, und was die Ausgabe verrät.
  if (ctx) {
    for (const f of explainExit(ctx, ctxDef)) add(f);
    const status = input.emulators.find((s) => s.def.id === ctxDef?.id);
    const rc = { def: ctxDef, appPath: status?.valid ? status.path : null };
    const lines = [...(ctx.exit?.stderrTail ?? []), ...(ctx.exit?.stdoutTail ?? [])];
    for (const f of analyzeOutput(lines, rc, "out")) add(f);

    // Das eigene Protokoll des Emulators, falls es von diesem Start stammt.
    const logPaths = ctxDef ? emulatorLogPaths(ctxDef.id, rc.appPath) : [];
    if (ctxDef && logPaths.length > 0) {
      const tail = await safe("Protokoll des Emulators", () => diagLogTail(logPaths, 150), add);
      if (tail && tail.lines.length > 0) {
        logs.push({ title: `Protokoll von ${ctxDef.name} (${tildePath(tail.path)})`, lines: tail.lines });
        const fresh = tail.modifiedMs > 0 && at - tail.modifiedMs < FRESH_LOG_MS;
        if (fresh) {
          const seen = new Set(findings.map((f) => f.id.replace(/^[a-z]+-/, "")));
          for (const f of analyzeOutput(tail.lines, rc, "log")) {
            if (seen.has(f.id.replace(/^[a-z]+-/, ""))) continue; // schon aus der Ausgabe bekannt
            add({ ...f, level: "warn", title: `${f.title} (laut Protokoll)` });
          }
        }
      }
    }
    for (const f of focusGameFindings(ctx, ctxDef, probes.get(ctx.path))) add(f);
  }

  // 2. Einstellungen und Emulatoren.
  for (const f of settingsFindings(input, probes)) add(f);
  for (const status of input.emulators) {
    const isRelevant = relevant.has(status.def.id);
    for (const f of emulatorFindings(status, isRelevant, counts.get(status.def.id) ?? 0, probes, ctxDef?.id === status.def.id)) add(f);
  }

  // 3. BIOS und Firmware der Emulatoren, die gebraucht werden.
  const req = await safe("BIOS und Firmware", () => requirementFindings(input, relevant), add);
  if (req) for (const f of req.findings) add(f);

  // 4. Alle Spieldateien der Bibliothek.
  const g = gameFindings(games, probes, ctx?.path);
  for (const f of g.findings) add(f);

  // 5. Das Startprotokoll der App selbst (nur zum Nachlesen).
  const launchLog = await safe("Startprotokoll", () => launchLogTail(60), add);
  if (launchLog && launchLog.length > 0) logs.push({ title: "Startprotokoll von JellyStation", lines: launchLog });

  findings.sort((a, b) => RANK[a.level] - RANK[b.level]);
  return { findings, logs, checkedGames: g.checked + (ctx ? 1 : 0), totalGames: input.games.length, at };
}

/* ------------------------------------------------------------------ Beheben */

/**
 * Führt einen Fix aus, der etwas ändert. Die Fixes, die nur einen Dialog öffnen, behandelt der Aufrufer.
 * Rückgabe: ein Satz, was getan wurde. Fehler werden geworfen (deutscher Text).
 */
export async function applyFix(fix: Fix): Promise<string> {
  switch (fix.kind) {
    case "copy-bios": {
      const dest = await installRequirement(fix.status);
      return `${fix.status.req.label} wurde kopiert nach ${tildePath(dest)}. Starte den Emulator bzw. das Spiel neu, falls er schon läuft.`;
    }
    case "clear-quarantine":
      await diagClearQuarantine(fix.path);
      return `Die Quarantäne von ${baseOf(fix.path)} ist aufgehoben. Beim nächsten Start prüft macOS die App nicht mehr.`;
    default:
      throw new Error("Dieser Schritt öffnet nur einen Dialog");
  }
}

/** Bericht als Text zum Kopieren (z. B. für eine Fehlermeldung beim Emulator-Projekt). */
export function reportText(report: DiagnoseReport): string {
  const mark: Record<Level, string> = { error: "[FEHLER]", warn: "[HINWEIS]", info: "[INFO]", ok: "[OK]" };
  const out: string[] = [`JellyStation – Diagnose (${new Date(report.at).toLocaleString("de-DE")})`, ""];
  for (const f of report.findings) {
    out.push(`${mark[f.level]} ${f.title}`, `  ${f.detail}`);
    if (f.extra?.length) out.push(...f.extra.map((l) => `    ${l}`));
  }
  for (const log of report.logs) out.push("", `--- ${log.title} ---`, ...log.lines);
  return out.join("\n");
}
