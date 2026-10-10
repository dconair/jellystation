import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../platform";
import type { Settings } from "../settings/settings";
import { ConfirmDialog, MessageDialog, PopupList, ProgressDialog } from "../ui/popup";
import type { PopupItem, PopupStatus } from "../ui/popup";
import { baseName, openExternal } from "../emulators/actions";
import { biosCopy } from "../emulators/backend";
import { describeStatus, tildePath } from "../emulators/status";
import type { EmulatorStatus } from "../emulators/status";
import type { EmulatorsState } from "../emulators/useEmulators";
import { biosDirOf, describeRequirement, installRequirement, missingLabels } from "../emulators/requirements";
import type { RequirementStatus } from "../emulators/requirements";
import type { RequirementsState } from "../emulators/useRequirements";
import { analyzeBios, describeSize, isSonyHost, SONY_FIRMWARE_HOSTS } from "./biosCheck";
import { downloadCancel, downloadStart, errorText, fileFingerprint, installPlatform, onDownloadProgress } from "./backend";
import type { PlatformInfo } from "./backend";
import { canInstallFromGithub, formatMB, InstallCancelled, installEmulator } from "./emulatorInstall";
import { FormDialog } from "./FormDialog";
import { GameSourcesDialog } from "./GameSourcesDialog";
import { hasActiveDownloads, useDownloadQueue } from "./downloadQueue";

export interface InstallDialogProps {
  settings: Settings | null;
  onChangeSettings: (next: Settings) => void;
  emulators: EmulatorsState;
  requirements: RequirementsState;
  /** Trägt den Pfad eines Emulators in die Einstellungen ein (null = wieder automatisch suchen). */
  onSetOverride: (id: string, path: string | null) => void;
  /** Öffnet den bisherigen Dialog „Emulatoren“ (Homebrew, App wählen, Startprotokoll). */
  onOpenEmulators: (focusId?: string) => void;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe. */
  active?: boolean;
}

type MessageTone = "info" | "error" | "success";

type Layer =
  | { kind: "emulator"; id: string }
  | { kind: "requirement"; id: string }
  | { kind: "sources" }
  | { kind: "sony"; id: string }
  | { kind: "message"; tone: MessageTone; title: string; lines: string[]; detail?: string[] }
  | { kind: "confirm"; title: string; message: string[]; confirmLabel: string; onConfirm: () => void };

interface Job {
  title: string;
  status: string;
  progress: number | null;
  cancel?: () => void;
}

const TONE_TO_STATUS: Record<string, PopupStatus | undefined> = { ok: "ok", warn: "warn", error: "error" };

const FILE_FILTERS: Record<string, string[]> = {
  "ps1-bios": ["bin"],
  "ps2-bios": ["bin", "rom0", "rom1", "erom"],
  "ps3-firmware": ["pup"],
};

/**
 * „Einrichtung & Downloads“: Alles, was auf einem leeren System fehlt, an einer Stelle – Emulatoren aus den offiziellen
 * GitHub-Releases laden, BIOS/Firmware ablegen und prüfen, Spiele von den eigenen Adressen laden.
 * Die App bringt keine Quellen für Spiele oder BIOS-Dateien mit; sie führt nur durch die Schritte.
 */
export function InstallDialog(props: InstallDialogProps) {
  const { settings, onChangeSettings, emulators, requirements, onOpenEmulators, onClose, active = true } = props;
  const tauri = isTauri();
  const live = useRef(props);
  live.current = props;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const queue = useDownloadQueue();
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!tauri) return;
    installPlatform()
      .then((p) => mounted.current && setPlatform(p))
      .catch(() => undefined);
  }, [tauri]);

  const top = layers[layers.length - 1];
  const push = (l: Layer) => setLayers((ls) => [...ls, l]);
  const pop = () => setLayers((ls) => ls.slice(0, -1));
  const message = (tone: MessageTone, title: string, lines: string[], detail?: string[]) => push({ kind: "message", tone, title, lines, detail });

  const biosDir = biosDirOf(settings?.biosDir);

  /* ---------------------------------------------------------------- Emulatoren */

  const installOne = useCallback(
    async (st: EmulatorStatus, hooksOverride?: Pick<Job, "status" | "progress">): Promise<"ok" | "failed" | "cancelled"> => {
      const p = platform;
      if (!p) return "failed";
      const name = st.def.name;
      const ctl = new AbortController();
      abort.current = ctl;
      const setState = (patch: Partial<Job>) => {
        if (mounted.current) setJob((cur) => ({ title: `${name} installieren`, status: "", progress: null, ...(cur ?? {}), ...hooksOverride, ...patch, cancel: () => ctl.abort() }));
      };
      setState({ status: "Wird vorbereitet …", progress: null });
      try {
        const out = await installEmulator(
          st.def.id,
          name,
          p,
          { status: (status) => setState({ status }), progress: (progress) => setState({ progress }) },
          ctl.signal,
        );
        live.current.onSetOverride(st.def.id, out.path);
        await live.current.emulators.refresh();
        if (mounted.current) {
          setJob(null);
          message(
            "success",
            `${name} installiert`,
            [`Programm: ${tildePath(out.path)}${out.version ? ` (${out.version})` : ""}`, ...out.notes, ...(st.def.setupNote ? ["", st.def.setupNote] : [])],
          );
        }
        return "ok";
      } catch (err) {
        if (!mounted.current) return "failed";
        setJob(null);
        if (err instanceof InstallCancelled) return "cancelled";
        message("error", `${name} nicht installiert`, [errorText(err), `Alternativ: Lade ${name} von der Seite des Projekts (${st.def.downloadUrl}) und wähle das Programm unter „Emulatoren“ aus.`]);
        return "failed";
      } finally {
        abort.current = null;
      }
    },
    [platform],
  );

  const installAllMissing = async () => {
    const p = platform;
    if (!p) return;
    const todo = emulators.statuses.filter((s) => !s.valid && canInstallFromGithub(s.def.id, p));
    const skipped = emulators.statuses.filter((s) => !s.valid && !canInstallFromGithub(s.def.id, p));
    const results: string[] = [];
    let cancelled = false;
    for (let i = 0; i < todo.length; i++) {
      const st = todo[i];
      // Einzelmeldungen unterdrücken: am Ende gibt es eine Zusammenfassung.
      const before = layers.length;
      const r = await installOne(st, { status: `(${i + 1}/${todo.length}) ${st.def.name}`, progress: null });
      if (mounted.current) setLayers((ls) => ls.slice(0, before));
      if (r === "cancelled") {
        cancelled = true;
        break;
      }
      results.push(`${r === "ok" ? "✓" : "✕"} ${st.def.name}`);
    }
    if (!mounted.current) return;
    const lines = [
      ...(results.length ? results : ["Alle Emulatoren sind schon da."]),
      ...(cancelled ? ["", "Abgebrochen."] : []),
      ...(skipped.length ? ["", `Nicht automatisch ladbar: ${skipped.map((s) => s.def.name).join(", ")}. Dafür gibt es unter „Emulatoren“ Homebrew bzw. die Download-Seite.`] : []),
    ];
    message(results.some((r) => r.startsWith("✕")) ? "error" : "success", "Emulatoren", lines);
  };

  /* ---------------------------------------------------------------- BIOS & Firmware */

  const pickFile = async (s: RequirementStatus): Promise<string | null> => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const exts = FILE_FILTERS[s.req.id];
    const picked = await open({
      multiple: false,
      directory: false,
      title: `${s.req.label}: Datei wählen`,
      filters: exts ? [{ name: s.req.label, extensions: exts }, { name: "Alle Dateien", extensions: ["*"] }] : undefined,
    });
    return typeof picked === "string" && picked ? picked : null;
  };

  /** Prüft eine Datei, legt sie im BIOS-Ordner ab und übernimmt sie (falls möglich) in den Emulator. */
  const takeFile = async (s: RequirementStatus, path: string) => {
    setJob({ title: s.req.label, status: `Prüfe ${baseName(path)} …`, progress: null });
    try {
      const fp = await fileFingerprint(path);
      const analysis = analyzeBios(s.req.id, fp);
      if (analysis.verdict === "invalid") {
        setJob(null);
        message("error", `${s.req.label}: Datei ungeeignet`, [analysis.text, "Die Datei wurde nicht übernommen."]);
        return;
      }
      setJob({ title: s.req.label, status: "Lege die Datei im BIOS-Ordner ab …", progress: null });
      let stored = path;
      try {
        stored = await biosCopy(path, biosDir);
      } catch (err) {
        if (!/liegt dort schon/.test(errorText(err))) throw err;
      }
      const lines = [analysis.text, `MD5: ${fp.md5}`, `Im BIOS-Ordner: ${tildePath(stored)}`];
      const fresh = await live.current.requirements.refresh();
      const now = fresh.find((x) => x.req.id === s.req.id);
      if (now && now.state === "in-folder" && s.req.copyTo) {
        try {
          const dest = await installRequirement(now);
          await live.current.requirements.refresh();
          lines.push(`In den Emulator übernommen: ${tildePath(dest)}`);
        } catch (err) {
          lines.push(`In den Emulator übernommen: nein (${errorText(err)})`);
        }
      } else if (!s.req.copyTo) {
        lines.push("", s.req.installHint);
      }
      setJob(null);
      message("success", `${s.req.label} bereit`, lines);
    } catch (err) {
      setJob(null);
      message("error", `${s.req.label} nicht übernommen`, [errorText(err)]);
    }
  };

  const chooseFileFor = async (s: RequirementStatus) => {
    try {
      const picked = await pickFile(s);
      if (picked) await takeFile(s, picked);
    } catch (err) {
      message("error", "Dateidialog fehlgeschlagen", [errorText(err)]);
    }
  };

  const checkFound = async (s: RequirementStatus) => {
    const path = s.folderPath ?? s.path;
    if (!path) return;
    setJob({ title: s.req.label, status: `Prüfe ${baseName(path)} …`, progress: null });
    try {
      const fp = await fileFingerprint(path);
      const a = analyzeBios(s.req.id, fp);
      setJob(null);
      message(a.verdict === "invalid" ? "error" : "success", `${s.req.label}: Prüfung`, [a.text, `Datei: ${tildePath(path)}`, `Größe: ${describeSize(fp.size)}`, `MD5: ${fp.md5}`, `SHA-256: ${fp.sha256}`]);
    } catch (err) {
      setJob(null);
      message("error", "Prüfung fehlgeschlagen", [errorText(err)]);
    }
  };

  const downloadFirmware = async (s: RequirementStatus, rawUrl: string) => {
    const url = rawUrl.trim();
    const id = `fw-${s.req.id}`;
    const ctl = new AbortController();
    const cancel = () => {
      ctl.abort();
      void downloadCancel(id).catch(() => undefined);
    };
    setJob({ title: "PS3-Firmware laden", status: "Verbinde mit Sony …", progress: null, cancel });
    const off = await onDownloadProgress((p) => {
      if (p.id !== id || !mounted.current) return;
      if (p.state === "running") {
        setJob((cur) => (cur ? { ...cur, status: p.total ? `Lade ${formatMB(p.received)} von ${formatMB(p.total)} …` : `Lade ${formatMB(p.received)} …`, progress: p.total ? p.received / p.total : null } : cur));
      }
    });
    try {
      const res = await downloadStart({
        id,
        url,
        destDir: biosDir,
        fileName: "PS3UPDAT.PUP",
        allowedHosts: SONY_FIRMWARE_HOSTS,
        allowHttp: new URL(url).protocol === "http:",
        blockExecutables: true,
      });
      const fp = await fileFingerprint(res.path);
      const a = analyzeBios(s.req.id, fp);
      await live.current.requirements.refresh();
      setJob(null);
      if (a.verdict === "invalid") {
        message("error", "Firmware ungeeignet", [a.text, `Die Datei liegt unter ${tildePath(res.path)} – lösche sie und versuche es mit dem Link von der Sony-Seite erneut.`]);
        return;
      }
      message("success", "PS3-Firmware geladen", [a.text, `Gespeichert: ${tildePath(res.path)}`, "", s.req.installHint]);
    } catch (err) {
      setJob(null);
      if (!ctl.signal.aborted) message("error", "Firmware nicht geladen", [errorText(err), "Du kannst die Datei auch im Browser von der Sony-Seite laden und unter „Datei von meinem Computer wählen“ übernehmen."]);
    } finally {
      off();
    }
  };

  /* ---------------------------------------------------------------- Hauptliste */

  const downloading = queue.filter((q) => q.state === "running" || q.state === "verifying");
  const waiting = queue.filter((q) => q.state === "queued").length;
  const emuMissing = emulators.statuses.filter((s) => !s.valid && !s.pending).length;
  const reqMissing = missingLabels(requirements.statuses);
  const sources = settings?.gameSources ?? [];

  const items: PopupItem[] = useMemo(() => {
    const list: PopupItem[] = [{ id: "h-emu", label: "Schritt 1 · Emulatoren", header: true }];
    for (const s of emulators.statuses) {
      const d = describeStatus(s);
      const canAuto = platform ? canInstallFromGithub(s.def.id, platform) : false;
      list.push({
        id: `emu:${s.def.id}`,
        label: `${s.def.name} · ${s.def.consoles}`,
        detail: s.valid ? d.text : canAuto ? "Nicht installiert – ✕ lädt die neueste Version von GitHub" : d.text,
        status: d.tone,
      });
    }
    list.push({ id: "h-bios", label: "Schritt 2 · BIOS & Firmware", header: true });
    for (const s of requirements.statuses) {
      const d = describeRequirement(s);
      list.push({ id: `req:${s.req.id}`, label: s.req.label, detail: d.text, status: TONE_TO_STATUS[d.tone ?? ""] });
    }
    list.push({ id: "bios-dir", label: "BIOS-Ordner", detail: tildePath(biosDir) });
    list.push({ id: "h-games", label: "Schritt 3 · Spiele", header: true });
    list.push({
      id: "sources",
      label: "Meine Spiele-Quellen und Downloads",
      detail: sources.length
        ? `${sources.length} Quelle${sources.length === 1 ? "" : "n"}${downloading.length ? ` · lädt: ${downloading[0].name}` : waiting ? ` · ${waiting} wartend` : ""}`
        : "Noch keine Quelle – eigene Webseite oder Adressliste eintragen",
    });
    list.push({ id: "h-more", label: "Weiteres", header: true });
    if (platform && emulators.statuses.some((s) => !s.valid && canInstallFromGithub(s.def.id, platform))) {
      list.push({ id: "all", label: "Alle fehlenden Emulatoren laden", detail: "Nacheinander, mit Prüfsumme soweit GitHub sie liefert" });
    }
    list.push({ id: "open-emulators", label: "Emulatoren verwalten …", detail: "Homebrew, Programm von Hand wählen, Startprotokoll" });
    return list;
  }, [emulators.statuses, requirements.statuses, platform, biosDir, sources.length, downloading, waiting]);

  const subtitle = !tauri
    ? "Nur in der Desktop-App"
    : `Emulatoren: ${emulators.statuses.length - emuMissing} von ${emulators.statuses.length} · ${reqMissing.length ? `fehlt: ${reqMissing.join(", ")}` : "BIOS/Firmware vollständig"}`;

  const chooseBiosDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "Ordner für BIOS- und Firmware-Dateien wählen" });
      if (typeof picked === "string" && settings) onChangeSettings({ ...settings, biosDir: picked });
    } catch (err) {
      message("error", "Ordner wählen", [errorText(err)]);
    }
  };

  const closeMain = () => {
    if (hasActiveDownloads()) {
      push({
        kind: "confirm",
        title: "Downloads laufen noch",
        message: ["Die Spiele-Downloads laufen auch bei geschlossenem Fenster weiter.", "Du findest sie später wieder unter „Meine Spiele-Quellen und Downloads“."],
        confirmLabel: "Schließen",
        onConfirm: onClose,
      });
      return;
    }
    onClose();
  };

  /* ---------------------------------------------------------------- Ebenen */

  const reqOf = (id: string) => requirements.statuses.find((r) => r.req.id === id);
  const emuOf = (id: string) => emulators.statuses.find((e) => e.def.id === id);

  let overlay: React.ReactNode = null;
  const listActive = active && !top && !job;

  if (top?.kind === "emulator") {
    const st = emuOf(top.id);
    if (st) {
      const canAuto = platform ? canInstallFromGithub(st.def.id, platform) : false;
      const actions: PopupItem[] = [];
      if (canAuto) {
        actions.push({ id: "install", label: st.valid ? "Auf die neueste Version aktualisieren" : "Herunterladen und installieren", detail: "Offizielle GitHub-Veröffentlichung des Projekts" });
      } else if (st.def.brewCask) {
        actions.push({ id: "manage", label: "Mit Homebrew installieren …", detail: "Öffnet den Emulator-Dialog" });
      }
      actions.push({ id: "page", label: "Download-Seite des Projekts öffnen", detail: st.def.downloadUrl });
      if (!canAuto || st.valid) actions.push({ id: "manage", label: "Programm wählen oder neu suchen …", detail: "Öffnet den Emulator-Dialog" });
      const seen = new Set<string>();
      const unique = actions.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
      overlay = (
        <PopupList
          key={`emu:${st.def.id}`}
          title={st.def.name}
          subtitle={describeStatus(st).text}
          width="wide"
          items={unique}
          active={active && !job && layers[layers.length - 1] === top}
          footer={{ text: st.def.setupNote ?? `${st.def.name} für ${st.def.consoles}`, kind: "info" }}
          onSelect={(id) => {
            if (id === "install") void installOne(st);
            else if (id === "manage") onOpenEmulators(st.def.id);
            else if (id === "page") void openExternal(st.def.downloadUrl).catch((e) => message("error", "Seite nicht geöffnet", [errorText(e), st.def.downloadUrl]));
          }}
          onBack={pop}
        />
      );
    }
  } else if (top?.kind === "requirement") {
    const s = reqOf(top.id);
    if (s) {
      const acts: PopupItem[] = [{ id: "file", label: "Datei von meinem Computer wählen …", detail: "Wird geprüft und im BIOS-Ordner abgelegt" }];
      if (s.state !== "missing" && s.state !== "unknown") acts.push({ id: "check", label: "Gefundene Datei prüfen", detail: tildePath(s.folderPath ?? s.path ?? "") });
      if (s.state === "in-folder" && s.req.copyTo) acts.push({ id: "copy", label: "In den Emulator übernehmen", detail: tildePath(s.folderPath ?? "") });
      if (s.req.id === "ps3-firmware") acts.push({ id: "sony", label: "Von Sony laden (Link einfügen) …", detail: "Nur offizielle Sony-Server werden akzeptiert" });
      for (const l of s.req.links) acts.push({ id: `link:${l.url}`, label: l.label, detail: "Öffnet den Browser" });
      overlay = (
        <PopupList
          key={`req:${s.req.id}`}
          title={s.req.label}
          subtitle={describeRequirement(s).text}
          width="wide"
          items={acts}
          active={active && !job && layers[layers.length - 1] === top}
          footer={{ text: s.req.description, kind: "info" }}
          onSelect={(id) => {
            if (id === "file") void chooseFileFor(s);
            else if (id === "check") void checkFound(s);
            else if (id === "copy") {
              setJob({ title: s.req.label, status: "Kopiere …", progress: null });
              installRequirement(s)
                .then(async (dest) => {
                  await requirements.refresh();
                  setJob(null);
                  message("success", `${s.req.label} übernommen`, [`Die Datei liegt jetzt hier: ${tildePath(dest)}`]);
                })
                .catch((e) => {
                  setJob(null);
                  message("error", `${s.req.label} nicht übernommen`, [errorText(e)]);
                });
            } else if (id === "sony") push({ kind: "sony", id: s.req.id });
            else if (id.startsWith("link:")) void openExternal(id.slice(5)).catch((e) => message("error", "Seite nicht geöffnet", [errorText(e), id.slice(5)]));
          }}
          onBack={pop}
        />
      );
    }
  } else if (top?.kind === "sources") {
    overlay = <GameSourcesDialog settings={settings} onChangeSettings={onChangeSettings} onClose={pop} active={active && !job} />;
  }

  return (
    <>
      <PopupList
        key="install-main"
        title="Einrichtung & Downloads"
        subtitle={subtitle}
        width="wide"
        items={items}
        busy={emulators.loading || requirements.loading}
        active={listActive}
        footer={{
          text: tauri
            ? "Emulatoren kommen von den offiziellen GitHub-Seiten der Projekte. BIOS-Dateien bringst du selbst mit, Spiele lädst du von deinen eigenen Adressen."
            : "Downloads und Installation funktionieren nur in der Desktop-App.",
          kind: "info",
        }}
        onSelect={(id) => {
          if (!tauri) return;
          if (id.startsWith("emu:")) push({ kind: "emulator", id: id.slice(4) });
          else if (id.startsWith("req:")) push({ kind: "requirement", id: id.slice(4) });
          else if (id === "bios-dir") void chooseBiosDir();
          else if (id === "sources") push({ kind: "sources" });
          else if (id === "all") void installAllMissing();
          else if (id === "open-emulators") onOpenEmulators();
        }}
        onBack={closeMain}
      />
      {overlay}
      {top?.kind === "sony" && (
        <FormDialog
          title="PS3-Firmware von Sony"
          subtitle="Adresse der Datei PS3UPDAT.PUP"
          fields={[{ key: "url", label: "Adresse", placeholder: "https://…/PS3UPDAT.PUP" }]}
          note="Öffne die Sony-Seite (siehe Liste), kopiere dort die Adresse des Download-Links und füge sie hier ein. Es werden nur Adressen von playstation.com, playstation.net und sony.com angenommen."
          submitLabel="Laden"
          active={active && !job}
          validate={(v) => (isSonyHost(v.url.trim()) ? null : "Das ist keine Adresse eines offiziellen Sony-Servers (playstation.com, playstation.net, sony.com).")}
          onSubmit={(v) => {
            const s = reqOf(top.id);
            pop();
            if (s) void downloadFirmware(s, v.url);
          }}
          onClose={pop}
        />
      )}
      {top?.kind === "message" && <MessageDialog title={top.title} lines={top.lines} detail={top.detail} kind={top.tone} active={active && !job} onClose={pop} />}
      {top?.kind === "confirm" && (
        <ConfirmDialog title={top.title} message={top.message} confirmLabel={top.confirmLabel} active={active && !job} onConfirm={() => { pop(); top.onConfirm(); }} onCancel={pop} />
      )}
      {job && <ProgressDialog title={job.title} status={job.status} progress={job.progress} onCancel={job.cancel} active={active} />}
    </>
  );
}
