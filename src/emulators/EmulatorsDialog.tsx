import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../platform";
import { ConfirmDialog, MessageDialog, PopupList, ProgressDialog } from "../ui/popup";
import type { PopupFooter, PopupItem, PopupTone } from "../ui/popup";
import { baseName, looksLikeEmulator, openExternal, pickAppBundle } from "./actions";
import { emulatorInspect, errorText, gameLaunch, launchLogTail } from "./backend";
import type { InspectResult } from "./backend";
import { PROGRESS_PREFIX, brewFailureHint, percentOf, runBrewInstall } from "./brew";
import type { BrewRun } from "./brew";
import { LOCATION_ADVICE, detectOne } from "./detect";
import type { BrewInfo } from "./detect";
import { describeStatus, summarizeEmulators, tildePath } from "./status";
import type { EmulatorStatus } from "./status";

export interface EmulatorsDialogProps {
  statuses: readonly EmulatorStatus[];
  brew: BrewInfo;
  /**
   * Der Nutzer wählt einen Pfad (`path`) oder gibt die Wahl frei (`null` = wieder automatisch suchen).
   * Der Aufrufer speichert das in settings.emulators; `useEmulators(settings.emulators)` sucht danach selbst neu.
   */
  onSetOverride: (id: string, path: string | null) => void;
  /** Sucht neu; sollte die frischen Status liefern (so tut es `useEmulators().refresh`). */
  onRefresh: () => Promise<readonly EmulatorStatus[] | void> | void;
  onClose: () => void;
  /** Emulator-ID, auf der der Fokus startet (z. B. der, der beim Spielstart fehlte). */
  focusId?: string | null;
  /** Hinweis in der Statuszeile, z. B. „RPCS3 wurde nicht gefunden“. */
  message?: string;
  /** Tonart von `message`. Standard: warn. */
  messageKind?: PopupTone;
  /** true = es wird gerade gesucht (Ladeanzeige im Kopf). */
  loading?: boolean;
  /** false = sichtbar, aber ohne Eingabe (liegt ein anderes Overlay darüber). */
  active?: boolean;
}

type MessageTone = "info" | "error" | "success";

type Layer =
  | { key: number; kind: "actions"; id: string }
  | {
      key: number;
      kind: "message";
      tone: MessageTone;
      title: string;
      lines: string[];
      detail?: string[];
      detailStart?: "top" | "bottom";
      /** Beim Schließen auch die darunterliegende Aktionsliste schließen (Vorgang erledigt). */
      closeActions?: boolean;
    }
  | { key: number; kind: "confirm"; title: string; lines: string[]; confirmLabel: string; onConfirm: () => void };

type NewMessage = Omit<Extract<Layer, { kind: "message" }>, "key" | "kind">;

interface InstallState {
  title: string;
  status: string;
  lines: string[];
  /** 0..1 oder null (läuft, Fortschritt unbekannt). */
  progress: number | null;
}

/** Dialog „Emulatoren“: Liste mit Status, Aktionen je Emulator (installieren, finden, Pfad wählen) und Werkzeuge. */
export function EmulatorsDialog(props: EmulatorsDialogProps) {
  const { statuses, brew, onClose, focusId, message, messageKind = "warn", loading = false, active = true } = props;
  const tauri = isTauri();
  // Asynchrone Abläufe lesen immer den neuesten Stand der Eigenschaften.
  const live = useRef(props);
  live.current = props;

  const [layers, setLayers] = useState<Layer[]>([]);
  const [install, setInstall] = useState<InstallState | null>(null);
  const [busy, setBusy] = useState<{ title: string; status: string } | null>(null);
  const [notice, setNotice] = useState<PopupFooter | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const keySeq = useRef(0);
  const mounted = useRef(true);
  const run = useRef<BrewRun | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const statusOf = (id: string) => live.current.statuses.find((s) => s.def.id === id);

  /* ---- Ebenen ---- */

  const showMessage = useCallback((m: NewMessage) => {
    setLayers((ls) => [...ls, { ...m, key: ++keySeq.current, kind: "message" }]);
  }, []);
  const openActions = (id: string) => setLayers((ls) => [...ls, { key: ++keySeq.current, kind: "actions", id }]);
  const popLayer = () => setLayers((ls) => ls.slice(0, -1));
  const toMain = () => setLayers([]);

  /* ---- Aktionen ---- */

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const fresh = (await live.current.onRefresh()) ?? null;
      if (!mounted.current) return;
      const list = fresh ?? live.current.statuses;
      setNotice({ text: `Suche abgeschlossen – ${summarizeEmulators(list)}`, kind: "info" });
    } catch (err) {
      if (mounted.current) setNotice({ text: `Suche fehlgeschlagen: ${errorText(err)}`, kind: "error" });
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  const showLog = async () => {
    setBusy({ title: "Startprotokoll", status: "Wird geladen …" });
    try {
      const lines = await launchLogTail(40);
      if (!mounted.current) return;
      setBusy(null);
      showMessage({
        tone: "info",
        title: "Startprotokoll",
        lines: [lines.length ? `Die letzten ${lines.length} Einträge aus launch.log:` : "Noch keine Einträge – es wurde noch kein Spiel gestartet."],
        detail: lines.length ? lines : undefined,
        detailStart: "bottom",
      });
    } catch (err) {
      if (!mounted.current) return;
      setBusy(null);
      showMessage({ tone: "error", title: "Protokoll nicht lesbar", lines: [errorText(err)] });
    }
  };

  const installWithBrew = async (st: EmulatorStatus) => {
    const cask = st.def.brewCask;
    const brewInfo = live.current.brew;
    if (!cask || !brewInfo.available) return;
    const name = st.def.name;

    // Ausgabe puffern und höchstens ~11-mal pro Sekunde anzeigen – Homebrew kann sehr gesprächig sein.
    const lines: string[] = [];
    let status = "Homebrew wird gestartet …";
    let progress: number | null = null;
    let timer = 0;
    const flush = () => {
      timer = 0;
      if (mounted.current) setInstall((cur) => (cur ? { ...cur, status, progress, lines: [...lines] } : cur));
    };
    setInstall({ title: `${name} installieren`, status, lines: [], progress: null });

    const job = runBrewInstall(brewInfo, cask, (line) => {
      // Fortschrittsangaben überschreiben einander, statt das Protokoll zu fluten.
      if (line.startsWith(PROGRESS_PREFIX) && lines.length > 0 && lines[lines.length - 1].startsWith(PROGRESS_PREFIX)) {
        lines[lines.length - 1] = line;
      } else {
        lines.push(line);
      }
      if (lines.length > 200) lines.splice(0, lines.length - 200);
      if (line.startsWith("==>")) {
        status = line.replace(/^==>\s*/, "");
        progress = null;
      } else {
        const p = percentOf(line);
        if (p !== null) progress = p / 100;
      }
      if (!timer) timer = window.setTimeout(flush, 90);
    });
    run.current = job;
    const res = await job.done;
    window.clearTimeout(timer);
    run.current = null;

    // Dialog inzwischen geschlossen: Die Installation lief im Hintergrund zu Ende – nur noch die Erkennung auffrischen.
    if (!mounted.current) {
      void live.current.onRefresh();
      return;
    }
    setInstall(null);

    if (res.cancelled) {
      toMain();
      setNotice({ text: `${name}: Installation abgebrochen`, kind: "warn" });
      return;
    }
    const terminal = `brew install --cask ${cask}`;
    if (res.error) {
      showMessage({
        tone: "error",
        title: "Installation nicht möglich",
        lines: [
          `Homebrew konnte nicht ausgeführt werden: ${res.error}`,
          "Im Terminal klappt die Installation mit diesem Befehl:",
        ],
        detail: [terminal],
      });
      return;
    }
    if (res.code !== 0) {
      const hint = brewFailureHint(res.lines, cask);
      showMessage({
        tone: "error",
        title: "Installation fehlgeschlagen",
        lines: [
          `Homebrew konnte ${name} nicht installieren (${res.signal !== null ? `Signal ${res.signal}` : `Code ${res.code}`}).`,
          ...(hint ? [hint] : []),
        ],
        detail: res.lines.slice(-40),
      });
      return;
    }

    // Erfolg laut Homebrew: gegenprüfen, ob die App jetzt auch gefunden wird.
    setBusy({ title: `${name} installieren`, status: "Suche nach der installierten App …" });
    const before = statusOf(st.def.id);
    const fresh = await detectOne(st.def, before?.source === "custom" ? (before.path ?? undefined) : undefined);
    void live.current.onRefresh();
    if (!mounted.current) return;
    setBusy(null);
    if (fresh.valid && fresh.path) {
      showMessage({
        tone: "success",
        title: `${name} installiert`,
        lines: [
          `Gefunden: ${tildePath(fresh.path)}${fresh.version ? ` (Version ${fresh.version})` : ""}`,
          ...(st.def.setupNote ? ["", st.def.setupNote] : []),
        ],
        closeActions: true,
      });
    } else {
      showMessage({
        tone: "info",
        title: "App nicht gefunden",
        lines: [
          `Homebrew meldet Erfolg, die App von ${name} wurde aber an keinem der üblichen Orte gefunden.`,
          "Wähle sie mit „App auswählen …“ aus oder suche erneut.",
        ],
      });
    }
  };

  const cancelInstall = () => {
    void run.current?.cancel();
  };

  const openDownloadPage = async (st: EmulatorStatus) => {
    try {
      await openExternal(st.def.downloadUrl);
      toMain();
      setNotice({ text: `Download-Seite von ${st.def.name} geöffnet – danach „Erneut suchen“ wählen`, kind: "info" });
    } catch (err) {
      showMessage({
        tone: "error",
        title: "Seite nicht geöffnet",
        lines: [`${errorText(err)}`, "Öffne diese Adresse von Hand im Browser:"],
        detail: [st.def.downloadUrl],
      });
    }
  };

  const chooseApp = async (st: EmulatorStatus) => {
    const def = st.def;
    let picked: string | null;
    try {
      picked = await pickAppBundle();
    } catch (err) {
      showMessage({ tone: "error", title: "Dateidialog fehlgeschlagen", lines: [errorText(err)] });
      return;
    }
    if (!picked) return; // abgebrochen
    setBusy({ title: "App prüfen", status: tildePath(picked) });
    let info: InspectResult;
    try {
      info = await emulatorInspect(picked);
    } catch (err) {
      if (!mounted.current) return;
      setBusy(null);
      showMessage({ tone: "error", title: "Prüfung fehlgeschlagen", lines: [errorText(err)] });
      return;
    }
    if (!mounted.current) return;
    setBusy(null);

    if (!info.exists || info.kind === "other" || !info.executable) {
      showMessage({
        tone: "error",
        title: "Keine startbare App",
        lines: [
          info.error ?? `„${baseName(picked)}“ lässt sich nicht als Programm starten.`,
          `Wähle die App von ${def.name}, meist im Ordner „Programme“.`,
        ],
        detail: [picked],
      });
      return;
    }
    const chosen = picked;
    const commit = () => {
      live.current.onSetOverride(def.id, chosen);
      toMain();
      setNotice({
        text: `${def.name}: ${tildePath(chosen)}${info.version ? ` (Version ${info.version})` : ""} wird verwendet`,
        kind: "ok",
      });
    };
    if (looksLikeEmulator(def, chosen, info)) {
      commit();
    } else {
      setLayers((ls) => [
        ...ls,
        {
          key: ++keySeq.current,
          kind: "confirm",
          title: "Passt diese App?",
          lines: [`„${baseName(chosen)}“ sieht nicht nach ${def.name} aus.`, "Wenn du sie trotzdem verwendest, wird sie für alle Spiele dieses Emulators gestartet."],
          confirmLabel: "Verwenden",
          onConfirm: commit,
        },
      ]);
    }
  };

  const showTerminalHelp = () => {
    showMessage({
      tone: "info",
      title: "Im Terminal installieren",
      lines: [
        "Öffne das Programm „Terminal“ und gib den Befehl unten ein.",
        "Er sucht alle Emulatoren und installiert die fehlenden – auch RPCS3 und DuckStation, für die es kein Homebrew-Paket gibt. Danach hier „Erneut suchen“ wählen.",
      ],
      detail: ["jellystation --emulators"],
    });
  };

  const forgetChoice = (st: EmulatorStatus) => {
    live.current.onSetOverride(st.def.id, null);
    toMain();
    setNotice({ text: `${st.def.name}: wird wieder automatisch gesucht`, kind: "info" });
  };

  const openEmulator = async (st: EmulatorStatus) => {
    if (!st.path) return;
    try {
      // Eigene ID, damit der Start nicht mit einem Spiel verwechselt wird (der Starter ignoriert fremde Ereignisse).
      await gameLaunch({ id: `setup:${st.def.id}`, program: st.path, args: [], label: `${st.def.name} (Einrichtung)` });
      toMain();
      setNotice({ text: `${st.def.name} wird geöffnet – dort Firmware, BIOS und Einstellungen vornehmen`, kind: "info" });
    } catch (err) {
      showMessage({ tone: "error", title: "Öffnen fehlgeschlagen", lines: [`${st.def.name} lässt sich nicht öffnen.`, errorText(err)] });
    }
  };

  /* ---- Listen ---- */

  const mainItems = useMemo<PopupItem[]>(
    () => [
      ...statuses.map((s): PopupItem => {
        const d = describeStatus(s);
        return {
          id: s.def.id,
          label: `${s.def.name} · ${s.def.consoles}`,
          detail: d.text,
          status: d.tone,
          trailing: s.source === "custom" ? "Gewählt" : undefined,
        };
      }),
      { id: "act:refresh", label: "Erneut suchen", status: refreshing ? "busy" : undefined, disabled: !tauri },
      { id: "act:log", label: "Startprotokoll anzeigen", disabled: !tauri },
    ],
    [statuses, refreshing, tauri],
  );

  const actionItems = (st: EmulatorStatus): PopupItem[] => {
    const items: PopupItem[] = [];
    const cask = st.def.brewCask;
    if (cask) {
      items.push({
        id: "install",
        label: "Installieren mit Homebrew",
        detail: brew.available ? `brew install --cask ${cask}` : "Homebrew ist nicht installiert (brew.sh)",
        disabled: !brew.available || !tauri,
      });
    }
    const host = st.def.downloadUrl.replace(/^https?:\/\//, "");
    items.push({
      id: "download",
      label: "Download-Seite öffnen",
      detail: cask ? host : `${host} – für ${st.def.name} gibt es kein Homebrew-Paket`,
    });
    items.push({ id: "pick", label: "App auswählen …", detail: "Eine schon vorhandene App von Hand angeben", disabled: !tauri });
    if (!st.valid) {
      // Der Terminal-Befehl der Starthilfe (scripts/jellystation.sh) installiert auch RPCS3 und DuckStation, für die es kein Homebrew-Paket gibt.
      items.push({ id: "terminal", label: "Im Terminal installieren", detail: "jellystation --emulators" });
    }
    if (st.source === "custom") {
      items.push({ id: "auto", label: "Automatisch erkennen", detail: "Gewählten Pfad vergessen und wieder selbst suchen" });
    }
    if (st.valid && tauri) {
      items.push({ id: "open", label: `${st.def.name} öffnen`, detail: "Zum Einrichten: Firmware, BIOS, Einstellungen" });
    }
    return items;
  };

  /** Statuszeile der Aktionsliste: Hinweis zum Fundort (gelb) samt Einrichtungshinweis des Katalogs. */
  const actionFooter = (st: EmulatorStatus): PopupFooter | undefined => {
    const text = [st.valid && st.hint ? `${st.hint[0].toUpperCase()}${st.hint.slice(1)}. ${LOCATION_ADVICE}` : null, st.def.setupNote]
      .filter(Boolean)
      .join(" ");
    return text ? { text, kind: st.valid && st.hint ? "warn" : "info" } : undefined;
  };

  const onMainSelect = (id: string) => {
    if (id === "act:refresh") void refresh();
    else if (id === "act:log") void showLog();
    else if (id.startsWith("act:")) return;
    else openActions(id);
  };

  const onActionSelect = (st: EmulatorStatus, id: string) => {
    if (id === "install") void installWithBrew(st);
    else if (id === "download") void openDownloadPage(st);
    else if (id === "pick") void chooseApp(st);
    else if (id === "terminal") showTerminalHelp();
    else if (id === "auto") forgetChoice(st);
    else if (id === "open") void openEmulator(st);
  };

  const footer: PopupFooter | undefined = notice ?? (message ? { text: message, kind: messageKind } : undefined);
  const covered = layers.length > 0 || !!install || !!busy;

  return (
    <>
      <PopupList
        title="Emulatoren"
        subtitle={summarizeEmulators(statuses)}
        items={mainItems}
        focusId={focusId}
        width="wide"
        busy={loading || refreshing}
        footer={footer}
        active={active && !covered}
        onSelect={onMainSelect}
        onBack={onClose}
        onAlt={() => void refresh()}
        altLabel="Erneut suchen"
        onSquare={() => void showLog()}
        squareLabel="Protokoll"
      />

      {layers.map((layer, i) => {
        const top = active && !install && !busy && i === layers.length - 1;
        if (layer.kind === "actions") {
          const st = statusOf(layer.id);
          if (!st) return null;
          return (
            <PopupList
              key={layer.key}
              title={st.def.name}
              subtitle={describeStatus(st).text}
              items={actionItems(st)}
              footer={actionFooter(st)}
              width="normal"
              active={top}
              onSelect={(id) => onActionSelect(st, id)}
              onBack={popLayer}
            />
          );
        }
        if (layer.kind === "message") {
          return (
            <MessageDialog
              key={layer.key}
              title={layer.title}
              lines={layer.lines}
              detail={layer.detail}
              detailStart={layer.detailStart}
              kind={layer.tone}
              active={top}
              onClose={() => (layer.closeActions ? toMain() : popLayer())}
            />
          );
        }
        return (
          <ConfirmDialog
            key={layer.key}
            title={layer.title}
            message={layer.lines}
            confirmLabel={layer.confirmLabel}
            cancelLabel="Abbrechen"
            danger
            active={top}
            onConfirm={layer.onConfirm}
            onCancel={popLayer}
          />
        );
      })}

      {install && (
        <ProgressDialog
          title={install.title}
          status={install.status}
          lines={install.lines}
          progress={install.progress}
          active={active && !busy}
          onCancel={cancelInstall}
          cancelLabel="Abbrechen"
        />
      )}
      {busy && <ProgressDialog title={busy.title} status={busy.status} active={active} />}
    </>
  );
}
