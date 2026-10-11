import { useCallback, useEffect, useRef, useState } from "react";
import type { EmulatorStatus } from "../emulators/status";
import { openExternal } from "../emulators/actions";
import { GameDialog } from "../launcher/GameDialog";
import { MessageDialog, PopupList } from "../ui/popup";
import type { PopupItem, PopupStatus } from "../ui/popup";
import { applyFix, reportText, runDiagnosis } from "./run";
import type { DiagnoseContext, DiagnoseGame, DiagnoseReport, Fix, Level } from "./types";

export interface DiagnoseDialogProps {
  emulators: readonly EmulatorStatus[];
  /** Sucht die Emulatoren neu und liefert das frische Ergebnis (vor jeder Prüfung). */
  refreshEmulators: () => Promise<EmulatorStatus[]>;
  biosDir: string;
  gamesDir: string;
  /** Echte Spiele der Bibliothek (ohne Demo-Einträge). */
  games: readonly DiagnoseGame[];
  /** Gesetzt, wenn ein Spiel nicht gestartet ist: Dann steht dessen Befund oben und der Fokus liegt darauf. */
  context?: DiagnoseContext;
  onOpenEmulators: (emulatorId: string) => void;
  onOpenFiles: (emulatorId: string) => void;
  onOpenGamesDir: () => void;
  /** Etwas wurde geändert (BIOS kopiert, Quarantäne aufgehoben): Anzeigen im Menü neu prüfen. */
  onChanged: () => void;
  onClose: () => void;
}

type Layer =
  | { kind: "finding"; id: string }
  | { kind: "text"; id: string }
  | { kind: "logs" }
  | { kind: "log"; index: number }
  | { kind: "message"; title: string; lines: string[]; tone: "info" | "error" | "success"; detail?: string[] };

const STATUS: Record<Level, PopupStatus | undefined> = { error: "error", warn: "warn", ok: "ok", info: undefined };
const TONE = { error: "error", warn: "info", info: "info", ok: "success" } as const;
const SECTION: Record<Level, string> = { error: "Probleme", warn: "Hinweise", info: "Zur Information", ok: "In Ordnung" };

/** Erster Satz (für die Zeile in der Liste). */
const firstSentence = (text: string) => {
  const m = /^.{20,}?[.!?](\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
};

const fixKey = (fix: Fix) =>
  fix.kind === "copy-bios" ? `copy:${fix.status.req.id}` : fix.kind === "clear-quarantine" ? `quarantine:${fix.path}` : fix.kind;

const summarize = (report: DiagnoseReport): string => {
  const n = (l: Level) => report.findings.filter((f) => f.level === l).length;
  const errors = n("error");
  const warns = n("warn");
  const parts: string[] = [];
  if (errors) parts.push(errors === 1 ? "1 Problem" : `${errors} Probleme`);
  if (warns) parts.push(warns === 1 ? "1 Hinweis" : `${warns} Hinweise`);
  return parts.length ? parts.join(", ") : "Nichts Auffälliges gefunden";
};

/**
 * Diagnose: prüft Emulatoren, BIOS/Firmware, Spieldateien und (nach einem Fehlstart) die Ausgabe des Emulators,
 * erklärt jeden Befund in einem Satz mit dem nächsten Schritt und bietet, wo es geht, die Behebung mit einem Klick an.
 * Die Prüfung liest nur; Änderungen (BIOS kopieren, Quarantäne aufheben) gibt es nur nach einem Klick.
 */
export function DiagnoseDialog(props: DiagnoseDialogProps) {
  const { context, onClose } = props;
  const latest = useRef(props);
  latest.current = props;
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [running, setRunning] = useState(true);
  const [layer, setLayer] = useState<Layer | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const alive = useRef(true);

  const check = useCallback(async () => {
    const mine = ++run.current;
    setRunning(true);
    const p = latest.current;
    let emulators = p.emulators;
    try {
      emulators = await p.refreshEmulators();
    } catch {
      // Die Suche darf die Diagnose nicht verhindern: dann gilt der letzte bekannte Stand.
    }
    const next = await runDiagnosis({ emulators, biosDir: p.biosDir, gamesDir: p.gamesDir, games: p.games, context: p.context });
    if (alive.current && mine === run.current) {
      setReport(next);
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
    };
  }, [check]);

  const findings = report?.findings ?? [];
  const byId = (id: string) => findings.find((f) => f.id === id);
  const autoFixes = findings.filter((f) => f.fix?.auto);

  /** Führt einen ändernden Fix aus und prüft danach neu. */
  const doFix = async (fix: Fix) => {
    setBusy(true);
    try {
      const text = await applyFix(fix);
      latest.current.onChanged();
      setLayer({ kind: "message", tone: "success", title: "Erledigt", lines: [text] });
    } catch (err) {
      setLayer({ kind: "message", tone: "error", title: "Das hat nicht geklappt", lines: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setBusy(false);
    }
    await check();
  };

  const runFix = (fix: Fix) => {
    const p = latest.current;
    if (fix.kind === "open-emulators") p.onOpenEmulators(fix.emulatorId);
    else if (fix.kind === "open-files") p.onOpenFiles(fix.emulatorId);
    else if (fix.kind === "open-games-dir") p.onOpenGamesDir();
    else void doFix(fix);
  };

  const fixAll = async () => {
    setBusy(true);
    const seen = new Set<string>();
    const lines: string[] = [];
    let failed = false;
    for (const f of autoFixes) {
      const fix = f.fix?.fix;
      if (!fix || seen.has(fixKey(fix))) continue;
      seen.add(fixKey(fix));
      try {
        lines.push(`✓ ${await applyFix(fix)}`);
      } catch (err) {
        failed = true;
        lines.push(`✗ ${f.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    latest.current.onChanged();
    setBusy(false);
    setLayer({ kind: "message", tone: failed ? "error" : "success", title: failed ? "Nicht alles ging" : "Erledigt", lines });
    await check();
  };

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(reportText(report));
      setLayer({ kind: "message", tone: "success", title: "Bericht kopiert", lines: ["Der Bericht liegt in der Zwischenablage. Du kannst ihn z. B. in eine Fehlermeldung beim Emulator einfügen."] });
    } catch {
      setLayer({ kind: "message", tone: "error", title: "Kopieren nicht möglich", lines: ["Der Bericht konnte nicht in die Zwischenablage gelegt werden."] });
    }
  };

  /* ---------------------------------------------------------------- Ebenen */

  if (layer?.kind === "finding" || layer?.kind === "text") {
    const f = byId(layer.id);
    if (f && layer.kind === "finding" && (f.links?.length ?? 0) > 0) {
      const items: PopupItem[] = [];
      if (f.fix) items.push({ id: "fix", label: f.fix.label, detail: f.fix.auto ? "Ändert etwas auf diesem Rechner – nur nach deinem Klick" : undefined });
      for (const l of f.links ?? []) items.push({ id: `link:${l.url}`, label: l.label, detail: "Öffnet den Browser" });
      items.push({ id: "text", label: "Beschreibung lesen" });
      return (
        <PopupList
          key={`finding:${f.id}`}
          title={f.title}
          subtitle={firstSentence(f.detail)}
          width="wide"
          items={items}
          busy={busy}
          footer={{ text: firstSentence(f.detail), kind: f.level === "error" ? "error" : f.level === "warn" ? "warn" : f.level === "ok" ? "ok" : "info" }}
          onSelect={(id) => {
            if (id === "fix" && f.fix) {
              setLayer(null);
              runFix(f.fix.fix);
            } else if (id === "text") setLayer({ kind: "text", id: f.id });
            else if (id.startsWith("link:")) void openExternal(id.slice(5));
          }}
          onBack={() => setLayer(null)}
        />
      );
    } else if (f) {
      const back = layer.kind === "text" && (f.links?.length ?? 0) > 0 ? () => setLayer({ kind: "finding", id: f.id }) : () => setLayer(null);
      return (
        <GameDialog
          key={`${layer.kind}:${f.id}`}
          tone={TONE[f.level]}
          title={f.title}
          lines={[f.detail]}
          detail={f.extra}
          action={
            f.fix && layer.kind === "finding"
              ? {
                  label: f.fix.label,
                  run: () => {
                    if (f.fix) runFix(f.fix.fix);
                  },
                }
              : undefined
          }
          closeLabel="Zurück"
          onClose={back}
        />
      );
    }
  }

  if (layer?.kind === "logs" && report) {
    return (
      <PopupList
        key="logs"
        title="Protokolle"
        subtitle="Zum Nachlesen"
        width="wide"
        items={report.logs.map((l, i) => ({ id: `log:${i}`, label: l.title, detail: `${l.lines.length} Zeilen` }))}
        onSelect={(id) => setLayer({ kind: "log", index: Number(id.slice(4)) })}
        onBack={() => setLayer(null)}
      />
    );
  }
  if (layer?.kind === "log" && report) {
    const log = report.logs[layer.index];
    if (log) {
      return <MessageDialog key={`log:${layer.index}`} title="Protokoll" lines={[log.title]} detail={log.lines} detailStart="bottom" kind="info" okLabel="Zurück" onClose={() => setLayer({ kind: "logs" })} />;
    }
  }

  /* ---------------------------------------------------------------- Hauptliste */

  // Eine Ebene, deren Befund inzwischen verschwunden ist (nach dem Neuprüfen), blockiert die Liste nicht.
  const layerOpen = !!layer && !((layer.kind === "finding" || layer.kind === "text") && !byId(layer.id)) && !(layer.kind === "log" && !report?.logs[layer.index]);
  const items: PopupItem[] = [];
  if (report) {
    if (autoFixes.length > 0) {
      const labels = [...new Set(autoFixes.map((f) => f.fix?.label ?? ""))].join(", ");
      items.push({ id: "fix-all", label: `Behebbares beheben (${autoFixes.length})`, detail: labels, status: "warn" });
    }
    items.push({ id: "recheck", label: "Neu prüfen" });
    let section: Level | null = null;
    for (const f of findings) {
      if (f.level !== section) {
        section = f.level;
        items.push({ id: `h:${f.level}`, label: SECTION[f.level], header: true });
      }
      items.push({ id: `f:${f.id}`, label: f.title, detail: firstSentence(f.detail), status: STATUS[f.level] });
    }
    if (report.logs.length > 0) items.push({ id: "logs", label: "Protokolle ansehen", detail: `${report.logs.length} verfügbar` });
    items.push({ id: "copy", label: "Bericht kopieren", detail: "Für eine Fehlermeldung oder zum Nachlesen" });
  } else {
    items.push({ id: "wait", label: "Wird geprüft …", status: "busy", disabled: true });
  }

  const firstFocus = context && findings.some((f) => f.id === "exit" || f.id === "exit-launch") ? `f:${findings.find((f) => f.id === "exit" || f.id === "exit-launch")?.id}` : undefined;
  const subtitle = running ? "Wird geprüft …" : report ? summarize(report) : "";
  const footerText = context
    ? `Anlass: „${context.title}“ ließ sich nicht starten. Die Prüfung liest nur; geändert wird erst nach deinem Klick.`
    : report && report.totalGames > 0
      ? `${report.checkedGames} von ${report.totalGames} Spielen geprüft. Die Prüfung liest nur; geändert wird erst nach deinem Klick.`
      : "Die Prüfung liest nur; geändert wird erst nach deinem Klick.";

  return (
    <>
      <PopupList
        key="main"
        title="Diagnose"
        subtitle={subtitle}
        width="wide"
        items={items}
        busy={running || busy}
        focusId={firstFocus}
        active={!layerOpen}
        footer={{ text: footerText, kind: report?.findings.some((f) => f.level === "error") ? "warn" : "info" }}
        onSelect={(id) => {
          if (id === "fix-all") void fixAll();
          else if (id === "recheck") void check();
          else if (id === "logs") setLayer({ kind: "logs" });
          else if (id === "copy") void copyReport();
          else if (id.startsWith("f:")) setLayer({ kind: "finding", id: id.slice(2) });
        }}
        onBack={onClose}
      />
      {layer?.kind === "message" && (
        <MessageDialog title={layer.title} lines={layer.lines} detail={layer.detail} kind={layer.tone} onClose={() => setLayer(null)} />
      )}
    </>
  );
}

