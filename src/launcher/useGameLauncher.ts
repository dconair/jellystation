import { createElement, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { XmbEntry } from "../data/types";
import { errorText, gameKill, gameLaunch, gameRunning, onGameExit } from "../emulators/backend";
import type { GameExit } from "../emulators/backend";
import { emulatorForSystem, isAppBundle, supportedFolderNames } from "../emulators/catalog";
import type { EmulatorDef } from "../emulators/catalog";
import { detectOne } from "../emulators/detect";
import { tildePath } from "../emulators/status";
import type { EmulatorStatus } from "../emulators/status";
import type { EmulatorsState } from "../emulators/useEmulators";
import { isTauri } from "../platform";
import { playSfx } from "../xmb/sound";
import { classifyLaunchError, commandLineOf, exitDetail, exitHow, exitShort, formatDuration, judgeExit, MIN_OVERLAY_MS } from "./format";
import { LauncherLayer } from "./LauncherLayer";
import type { DialogSpec, LaunchView } from "./LauncherLayer";

export type Notify = (text: string) => void;

/** Erkannte Emulatoren: das Ergebnis von `useEmulators()` oder nur dessen `statuses`. */
export type EmulatorsInput = readonly EmulatorStatus[] | (Pick<EmulatorsState, "statuses"> & Partial<Pick<EmulatorsState, "refresh">>);

export interface GameLauncherOptions {
  /**
   * Ergebnis von `useEmulators(settings.emulators)`. Ohne Angabe sucht der Starter den Emulator beim Start selbst
   * (ohne die gewählten Pfade der Einstellungen zu kennen).
   */
  emulators?: EmulatorsInput;
  /**
   * Der Emulator fehlt, ist unbrauchbar oder ein Start schlug fehl: Der Aufrufer öffnet den Dialog „Emulatoren“
   * (`<EmulatorsDialog focusId={emulatorId} message={message} …>`). Ohne diese Funktion zeigt der Starter stattdessen
   * einen eigenen Hinweisdialog.
   */
  onNeedEmulator?: (emulatorId: string, message: string) => void;
}

export interface GameLauncher {
  /** IDs der Einträge, deren Spiel gerade startet oder läuft. */
  running: ReadonlySet<string>;
  /** Startet das Spiel eines XMB-Eintrags (Demo-Spiele durchlaufen denselben Ablauf ohne Prozess). */
  launch: (entry: XmbEntry, notify: Notify) => Promise<void>;
  /** Beendet ein laufendes Spiel (SIGKILL über `game_kill`). */
  stop: (entryId: string) => Promise<void>;
  /**
   * Start-Overlay und Dialoge. `null`, wenn nichts offen ist. Solange es nicht `null` ist, muss das Hauptmenü
   * gesperrt sein (`<Xmb inputEnabled={!overlay}>`); der Knoten gehört in App.tsx an die Wurzel (nicht in ein Element
   * mit transform/filter, weil die Overlays `position: fixed` nutzen).
   */
  overlay: ReactNode;
}

interface Ui {
  setRunning: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setLaunching: Dispatch<SetStateAction<LaunchView | null>>;
  setDialogs: Dispatch<SetStateAction<DialogSpec[]>>;
  /** Anzahl Dialoge, die gleich erscheinen (hält `overlay` nicht-null, damit das Hauptmenü gesperrt bleibt). */
  setPending: Dispatch<SetStateAction<number>>;
}

/** Ein gestartetes Spiel, solange sein Prozess läuft (oder startet). */
interface Session {
  entry: XmbEntry;
  def: EmulatorDef | null;
  /** Name für Meldungen: Emulator oder (bei nativen .app-Spielen) null. */
  emulatorName: string | null;
  program: string;
  args: string[];
  /** Befehlszeile zum Anzeigen; wird durch die tatsächliche aus `game_launch` ersetzt. */
  commandLine: string;
  note?: string;
  notify: Notify;
  startedAt: number;
  overlayKey: number;
  stopping: boolean;
  exited: boolean;
}

/** So lange darf das Overlay höchstens stehen bleiben, falls ein Aufruf hängt. */
const OVERLAY_FAILSAFE_MS = 15_000;
/** Verzögerung, bevor ein Dialog erscheint (siehe showDialog). */
const DIALOG_DELAY_MS = 60;

/**
 * Die Ablauflogik des Spielstarts. Eine Klasse (statt vieler useCallback), weil Start, Prozessende und Dialoge
 * einander ständig brauchen und nur über Refs/Setter mit React verbunden sind. Der Konstruktor hat keine
 * Nebenwirkungen (React ruft Initialisierer im Entwicklungsmodus doppelt auf); angemeldet wird in `attach()`.
 */
class LaunchController {
  private busy = new Set<string>();
  private running = new Set<string>();
  private sessions = new Map<string, Session>();
  private timers = new Set<number>();
  private seq = 0;
  private alive = true;

  constructor(
    private ui: Ui,
    private options: () => GameLauncherOptions,
  ) {}

  /** Meldet sich bei `game-exit` an und übernimmt schon laufende Spiele (z. B. nach einem Neuladen der Oberfläche). */
  attach(): () => void {
    this.alive = true;
    let off: (() => void) | null = null;
    if (isTauri()) {
      off = onGameExit((exit) => this.handleExit(exit));
      gameRunning().then(
        (ids) => {
          // "setup:…" sind vom Emulator-Dialog geöffnete Emulatoren, keine Spiele.
          if (this.alive) for (const id of ids) if (!id.startsWith("setup:")) this.markRunning(id, true);
        },
        () => undefined, // ältere App ohne den Befehl: kein Drama
      );
    }
    return () => {
      this.alive = false;
      off?.();
      for (const t of this.timers) window.clearTimeout(t);
      this.timers.clear();
    };
  }

  /* ------------------------------------------------------------------ kleine Helfer */

  private statuses(): readonly EmulatorStatus[] | undefined {
    const e = this.options().emulators;
    if (!e) return undefined;
    return "statuses" in e ? e.statuses : e;
  }

  private refreshHook() {
    const e = this.options().emulators;
    if (e && "refresh" in e && e.refresh) void e.refresh();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = window.setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
    });
  }

  private markRunning(id: string, on: boolean) {
    if (on) {
      this.running.add(id);
      this.busy.add(id);
    } else {
      this.running.delete(id);
      this.busy.delete(id);
    }
    this.ui.setRunning(new Set(this.running));
  }

  private showDialog(spec: Omit<DialogSpec, "key">) {
    if (!this.alive) return;
    if (spec.tone === "error") playSfx("error");
    // Kurz warten: Wird gleichzeitig das Start-Overlay entfernt, soll der Dialog nicht schon „über einem Overlay“
    // erscheinen – OverlayFrame dunkelt dann nur halb ab, und der Hintergrund wirkte heller als bei anderen Dialogen.
    this.ui.setPending((n) => n + 1);
    void this.wait(DIALOG_DELAY_MS).then(() => {
      this.ui.setPending((n) => n - 1);
      this.ui.setDialogs((ds) => [...ds, { ...spec, key: ++this.seq }]);
    });
  }

  /** Blendet das Overlay aus (oder entfernt es sofort); ein anderes Overlay bleibt unberührt. */
  private closeLaunch(key: number, immediate = false) {
    this.ui.setLaunching((cur) => (!cur || cur.key !== key ? cur : immediate ? null : cur.open ? { ...cur, open: false } : cur));
  }

  private openLaunch(entry: XmbEntry, status: string): number {
    const key = ++this.seq;
    this.ui.setLaunching({ key, entry, status, open: true });
    // Notbremse: Das Overlay darf nie dauerhaft stehen bleiben.
    void this.wait(OVERLAY_FAILSAFE_MS).then(() => this.closeLaunch(key));
    return key;
  }

  closeDialog = () => this.ui.setDialogs((ds) => ds.slice(1));
  launchExited = (key: number) => this.ui.setLaunching((cur) => (cur?.key === key ? null : cur));

  /* ------------------------------------------------------------------ Emulator finden */

  /**
   * Status des Emulators für den Start. Gilt er laut Hook als „fehlt“ (oder ist die erste Suche noch nicht fertig),
   * wird jetzt direkt nachgesehen – der Nutzer könnte ihn gerade erst installiert haben.
   */
  private async resolveEmulator(def: EmulatorDef): Promise<EmulatorStatus> {
    const current = this.statuses()?.find((s) => s.def.id === def.id);
    if (current?.valid && current.path) return current;
    const custom = current?.source === "custom" && current.path ? current.path : undefined;
    const fresh = await detectOne(def, custom);
    if (fresh.valid) this.refreshHook();
    return fresh;
  }

  private needEmulator(entry: XmbEntry, def: EmulatorDef, st: EmulatorStatus) {
    let message: string;
    if (st.source === "custom") {
      message = `Der gewählte Pfad für ${def.name} ist nicht nutzbar${st.error ? ` (${st.error})` : ""}. Wähle die App neu oder lass sie automatisch suchen.`;
    } else if (st.error) {
      message = `${def.name}: ${st.error}`;
    } else {
      message = `${def.name} wurde nicht gefunden. Installiere ihn oder wähle die App aus, um „${entry.title}“ zu starten.`;
    }
    const open = this.options().onNeedEmulator;
    if (open) {
      open(def.id, message);
      return;
    }
    this.showDialog({
      tone: "error",
      title: `${def.name} fehlt`,
      lines: [message, "Unter Einstellungen → Emulatoren lässt sich der Emulator installieren oder auswählen."],
    });
  }

  private unknownSystem(system: string) {
    this.showDialog({
      tone: "info",
      title: `Kein Emulator für „${system}“`,
      lines: [
        `Für „${system}“ ist noch kein Emulator hinterlegt (unterstützt: ${supportedFolderNames().join(", ")}).`,
        "Der Ordnername im Spiele-Ordner bestimmt den Emulator (z. B. „PS3“ für RPCS3). Gehört das Spiel zu einem unterstützten System, benenne den Ordner entsprechend um.",
      ],
    });
  }

  /* ------------------------------------------------------------------ Start */

  launch = async (entry: XmbEntry, notify: Notify): Promise<void> => {
    const game = entry.game;
    if (!game) {
      notify(`„${entry.title}“ wird geöffnet …`);
      return;
    }
    if (this.busy.has(entry.id)) {
      // „läuft“ erst, wenn der Prozess da ist; davor wird noch geprüft bzw. gestartet.
      notify(this.running.has(entry.id) ? `„${entry.title}“ läuft bereits` : `„${entry.title}“ wird bereits gestartet`);
      return;
    }
    // Ein .app-Spiel startet direkt; alles andere läuft über den Emulator des Systems.
    const native = !game.mock && isAppBundle(game.path);
    const def = native ? null : (emulatorForSystem(game.system) ?? null);
    if (!native && !def) {
      this.unknownSystem(game.system);
      return;
    }

    this.busy.add(entry.id); // Schutz vor Doppelstart, bis alles entschieden ist
    try {
      if (game.mock && def) {
        await this.runDemo(entry, def);
        return;
      }
      let program = game.path;
      let args: string[] = [];
      let note: string | undefined;
      if (def) {
        const st = await this.resolveEmulator(def);
        if (!st.valid || !st.path) {
          this.needEmulator(entry, def, st);
          return;
        }
        const built = def.buildArgs(game.path);
        program = st.path;
        args = built.args;
        note = built.note;
      }
      if (!isTauri()) {
        notify("Spiele lassen sich nur in der Desktop-App starten");
        return;
      }
      await this.startProcess({
        entry,
        def,
        emulatorName: def?.name ?? null,
        program,
        args,
        commandLine: commandLineOf(program, args),
        note,
        notify,
        startedAt: Date.now(),
        overlayKey: 0,
        stopping: false,
        exited: false,
      });
    } catch (err) {
      // Unerwartet – aber nie still scheitern.
      this.showDialog({ tone: "error", title: "Start fehlgeschlagen", lines: [`„${entry.title}“ lässt sich nicht starten.`, errorText(err)] });
    } finally {
      if (!this.running.has(entry.id)) this.busy.delete(entry.id);
    }
  };

  /** Demo-Eintrag: derselbe Ablauf wie bei einem echten Spiel, aber ohne Prozess. */
  private async runDemo(entry: XmbEntry, def: EmulatorDef) {
    const startedAt = Date.now();
    const key = this.openLaunch(entry, `${def.name} wird gestartet …`);
    // Zustand des Emulators für den Hinweis: aus dem Hook, sonst direkt nachsehen.
    let st: EmulatorStatus | undefined = this.statuses()?.find((s) => s.def.id === def.id);
    if (!st || st.pending) st = await detectOne(def, st?.source === "custom" ? (st.path ?? undefined) : undefined);
    await this.wait(Math.max(0, MIN_OVERLAY_MS - (Date.now() - startedAt)));
    this.closeLaunch(key);

    let emulatorLine: string;
    if (!st.checkable) emulatorLine = `${def.name} (${def.consoles}): Ob er installiert ist, lässt sich nur in der Desktop-App prüfen.`;
    else if (st.valid && st.path) {
      emulatorLine = `${def.name} (${def.consoles}): gefunden – ${tildePath(st.path)}${st.version ? `, Version ${st.version}` : ""}.`;
    } else {
      emulatorLine = `${def.name} (${def.consoles}): nicht gefunden – installiere ihn unter Einstellungen → Emulatoren.`;
    }
    const open = this.options().onNeedEmulator;
    this.showDialog({
      tone: "info",
      title: "Demo-Modus",
      lines: [
        "Es wurde kein echtes Spiel gestartet.",
        `„${entry.title}“ ist ein Demo-Eintrag. Wähle unter Einstellungen → Einrichtung deinen Spiele-Ordner, damit deine echten Spiele hier erscheinen.`,
        "",
        emulatorLine,
      ],
      action:
        open && st.checkable && !st.valid
          ? { label: "Emulatoren prüfen", run: () => open(def.id, `${def.name} wurde nicht gefunden – installiere ihn oder wähle die App aus.`) }
          : undefined,
    });
  }

  private async startProcess(s: Session) {
    const id = s.entry.id;
    this.sessions.set(id, s);
    this.markRunning(id, true);
    s.overlayKey = this.openLaunch(s.entry, s.emulatorName ? `${s.emulatorName} wird gestartet …` : `„${s.entry.title}“ wird gestartet …`);

    try {
      const res = await gameLaunch({ id, program: s.program, args: s.args, label: s.entry.title });
      if (res.commandLine) s.commandLine = res.commandLine;
    } catch (err) {
      // Das Ende kann schon über `game-exit` gemeldet worden sein.
      if (this.sessions.get(id) !== s) return;
      this.sessions.delete(id);
      this.markRunning(id, false);
      this.closeLaunch(s.overlayKey, true);
      this.launchFailed(s, errorText(err));
      return;
    }
    if (s.exited) return; // schon beendet und gemeldet

    // Das Overlay bleibt mindestens ≈ 2,5 s stehen.
    await this.wait(Math.max(0, MIN_OVERLAY_MS - (Date.now() - s.startedAt)));
    if (s.exited) return;
    this.closeLaunch(s.overlayKey);
    if (s.note) this.showDialog({ tone: "info", title: "Hinweis", lines: [s.note] });
  }

  /** `game_launch` selbst hat abgelehnt (Programm fehlt, nicht ausführbar, schon gestartet …). */
  private launchFailed(s: Session, text: string) {
    const title = s.entry.title;
    const kind = classifyLaunchError(text);
    if (kind === "already-running") {
      this.markRunning(s.entry.id, true);
      s.notify(`„${title}“ läuft bereits`);
      return;
    }
    const open = this.options().onNeedEmulator;
    const def = s.def;
    const hint =
      kind === "not-found"
        ? `${s.emulatorName ?? "Das Programm"} wurde nicht (mehr) gefunden – vielleicht verschoben oder gelöscht.`
        : kind === "not-executable"
          ? "Das Programm lässt sich nicht ausführen – prüfe Berechtigungen oder wähle die App neu aus."
          : "Prüfe den Emulator unter Einstellungen → Emulatoren; dort steht auch das Startprotokoll.";
    this.showDialog({
      tone: "error",
      title: "Start fehlgeschlagen",
      lines: [`„${title}“ konnte nicht gestartet werden.`, text, hint],
      detail: ["Befehl:", s.commandLine],
      action:
        def && open
          ? {
              label: "Emulatoren prüfen",
              run: () => open(def.id, `${def.name} ließ sich nicht starten: ${text}`),
            }
          : undefined,
    });
  }

  /* ------------------------------------------------------------------ Ende */

  private handleExit(exit: GameExit) {
    const s = this.sessions.get(exit.id);
    this.markRunning(exit.id, false);
    if (!s) return; // fremder Prozess (z. B. „Emulator öffnen“) oder Start vor einem Neuladen der Oberfläche
    this.sessions.delete(exit.id);
    s.exited = true;
    const title = s.entry.title;
    const verdict = judgeExit(exit);

    if (s.stopping || verdict.clean) {
      this.closeLaunch(s.overlayKey, true);
      s.notify(`„${title}“ beendet`);
      return;
    }

    this.closeLaunch(s.overlayKey, true);
    const how = exitHow(exit);
    const dur = formatDuration(exit.durationMs);
    // Kurze, feste Titel (lange Spielnamen würden abgeschnitten); der Name steht im Text.
    const lines: string[] = [
      verdict.quick
        ? `„${title}“ wurde ${s.emulatorName ? `von ${s.emulatorName} ` : ""}schon nach ${dur} ${how} beendet.`
        : `„${title}“ lief ${dur}${s.emulatorName ? ` in ${s.emulatorName}` : ""} und wurde dann ${how} beendet.`,
    ];
    if (exit.hint) {
      // Ursache laut Rust-Seite (z. B. macOS hat das Programm wegen der Sicherheitsprüfung beendet).
      lines.push(exit.hint);
    } else if (exit.code === 0 && exit.signal === null) {
      lines.push("Das ist ungewöhnlich schnell – meist konnte die Spieldatei nicht geöffnet werden. Läuft das Spiel trotzdem, kannst du diese Meldung ignorieren.");
    } else if (exit.stderrTail.length === 0 && exit.stdoutTail.length === 0) {
      lines.push("Der Emulator hat nichts ausgegeben. Unter Einstellungen → Emulatoren stehen Pfad und Startprotokoll.");
    }
    const open = this.options().onNeedEmulator;
    const def = s.def;
    this.showDialog({
      tone: "error",
      title: verdict.quick ? "Spiel sofort beendet" : "Spiel unerwartet beendet",
      lines,
      detail: exitDetail(s.commandLine, exit),
      action:
        def && open
          ? {
              label: "Emulatoren prüfen",
              run: () =>
                open(def.id, `${def.name} hat „${title}“ ${verdict.quick ? "sofort" : "unerwartet"} beendet (${exitShort(exit)}). Prüfe den Emulator und das Startprotokoll.`),
            }
          : undefined,
    });
  }

  /* ------------------------------------------------------------------ Stopp */

  stop = async (id: string): Promise<void> => {
    const s = this.sessions.get(id);
    if (s) s.stopping = true;
    if (!isTauri()) return;
    try {
      const killed = await gameKill(id);
      if (!killed) {
        // Der Prozess lief gar nicht mehr: Zustand bereinigen.
        this.sessions.delete(id);
        this.markRunning(id, false);
      }
    } catch (err) {
      if (s) {
        s.stopping = false;
        s.notify(`„${s.entry.title}“ lässt sich nicht beenden: ${errorText(err)}`);
      }
    }
  };
}

/**
 * Startet Spiele als eigenständige Prozesse (Rust-Befehl `game_launch`). Das Hauptmenü bleibt währenddessen offen;
 * welche Titel laufen, steht in `running`. Ablauf: Emulator zum System wählen → Pfad prüfen (fehlt er, öffnet
 * `onNeedEmulator` den Dialog) → Start-Overlay → Prozessende auswerten (sofortiges Ende zeigt einen Fehlerdialog
 * mit Befehlszeile und Ausgabe).
 */
export function useGameLauncher(options: GameLauncherOptions = {}): GameLauncher {
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [launching, setLaunching] = useState<LaunchView | null>(null);
  const [dialogs, setDialogs] = useState<DialogSpec[]>([]);
  const [pending, setPending] = useState(0);

  const [latest] = useState(() => ({ options }));
  latest.options = options;
  const [controller] = useState(() => new LaunchController({ setRunning, setLaunching, setDialogs, setPending }, () => latest.options));
  useEffect(() => controller.attach(), [controller]);

  const dialog = dialogs[0] ?? null;
  const overlay: ReactNode =
    launching || dialog || pending > 0
      ? createElement(LauncherLayer, {
          launching,
          dialog,
          onLaunchExited: controller.launchExited,
          onCloseDialog: controller.closeDialog,
        })
      : null;

  return { running, launch: controller.launch, stop: controller.stop, overlay };
}
