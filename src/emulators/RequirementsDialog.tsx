import { useState } from "react";
import { MessageDialog, PopupList } from "../ui/popup";
import type { PopupItem, PopupStatus } from "../ui/popup";
import { openExternal } from "./actions";
import { getEmulator } from "./catalog";
import { DEFAULT_BIOS_DIR, describeRequirement, installRequirement, missingLabels } from "./requirements";
import type { RequirementStatus } from "./requirements";

export interface RequirementsDialogProps {
  statuses: readonly RequirementStatus[];
  loading?: boolean;
  /** Aktueller BIOS-Ordner (leer = Standard). */
  biosDir: string;
  /** Der Nutzer wählt einen anderen BIOS-Ordner (leer = zurück zum Standard). */
  onSetBiosDir: (dir: string) => void;
  /** Prüft neu (nach Ordnerwahl oder Kopieren). */
  onRefresh: () => Promise<unknown> | void;
  onClose: () => void;
  /** Hinweis oben, z. B. „PS2-BIOS fehlt für das gewählte Spiel“. */
  message?: string;
  /** Anforderung, auf der der Fokus startet (z. B. die zum Emulator des Spiels). */
  focusEmulatorId?: string | null;
}

const TONE_TO_STATUS: Record<string, PopupStatus | undefined> = { ok: "ok", warn: "warn", error: "error" };

type Layer =
  | { kind: "actions"; id: string }
  | { kind: "message"; title: string; lines: string[]; tone: "info" | "error" | "success" };

/** Dialog „BIOS & Firmware“: was fehlt, wo man es herbekommt, Ordner wählen, in den Emulator übernehmen. */
export function RequirementsDialog(props: RequirementsDialogProps) {
  const { statuses, loading, biosDir, onSetBiosDir, onRefresh, onClose, message, focusEmulatorId } = props;
  const [layer, setLayer] = useState<Layer | null>(null);
  const [busy, setBusy] = useState(false);

  const missing = missingLabels(statuses);
  const items: PopupItem[] = [
    { id: "dir", label: "BIOS-Ordner", detail: biosDir.trim() || `${DEFAULT_BIOS_DIR} (Standard)` },
    ...statuses.map((s) => {
      const d = describeRequirement(s);
      return {
        id: `req:${s.req.id}`,
        label: `${s.req.label} · ${getEmulator(s.req.emulatorId)?.name ?? s.req.emulatorId}`,
        detail: d.text,
        status: TONE_TO_STATUS[d.tone ?? ""] ?? undefined,
      } satisfies PopupItem;
    }),
    { id: "recheck", label: "Neu prüfen" },
  ];
  const focusId = focusEmulatorId ? statuses.find((s) => s.req.emulatorId === focusEmulatorId && s.state !== "ready")?.req.id : undefined;

  const chooseDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "Ordner mit BIOS- und Firmware-Dateien wählen" });
      if (typeof picked === "string") onSetBiosDir(picked);
    } catch (err) {
      setLayer({ kind: "message", tone: "error", title: "Ordner wählen", lines: [`Der Dialog konnte nicht geöffnet werden: ${err instanceof Error ? err.message : String(err)}`] });
    }
  };

  const copy = async (s: RequirementStatus) => {
    setBusy(true);
    try {
      const dest = await installRequirement(s);
      await onRefresh();
      setLayer({ kind: "message", tone: "success", title: `${s.req.label} übernommen`, lines: [`Die Datei liegt jetzt hier: ${dest}`, "Starte den Emulator bzw. das Spiel neu, falls er schon läuft."] });
    } catch (err) {
      setLayer({ kind: "message", tone: "error", title: `${s.req.label} nicht übernommen`, lines: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setBusy(false);
    }
  };

  if (layer?.kind === "actions") {
    const s = statuses.find((x) => x.req.id === layer.id);
    if (s) {
      const actions: PopupItem[] = [];
      if (s.state === "in-folder" && s.req.copyTo) actions.push({ id: "copy", label: "In den Emulator übernehmen", detail: s.folderPath });
      for (const l of s.req.links) actions.push({ id: `link:${l.url}`, label: l.label, detail: "Öffnet den Browser" });
      actions.push({ id: "dir", label: "BIOS-Ordner ändern …", detail: "Dort wird nach der Datei gesucht" });
      return (
        <PopupList
          key={`actions:${s.req.id}`}
          title={s.req.label}
          subtitle={describeRequirement(s).text}
          width="wide"
          items={actions}
          busy={busy}
          footer={{ text: s.state === "ready" ? (s.path ?? "") : s.req.description, kind: "info" }}
          onSelect={(id) => {
            if (id === "copy") void copy(s);
            else if (id === "dir") void chooseDir();
            else if (id.startsWith("link:")) void openExternal(id.slice(5));
          }}
          onBack={() => setLayer(null)}
        />
      );
    }
  }

  return (
    <>
      <PopupList
        key="main"
        title="BIOS & Firmware"
        subtitle={missing.length ? `Fehlt noch: ${missing.join(", ")}` : "Alles vorhanden"}
        width="wide"
        items={items}
        busy={loading || busy}
        focusId={focusId ? `req:${focusId}` : undefined}
        active={!layer}
        footer={message ? { text: message, kind: "warn" } : { text: "Diese Dateien werden nie mitgeliefert oder heruntergeladen – sie stammen von deiner eigenen Konsole bzw. von Sony.", kind: "info" }}
        onSelect={(id) => {
          if (id === "dir") void chooseDir();
          else if (id === "recheck") void onRefresh();
          else if (id.startsWith("req:")) setLayer({ kind: "actions", id: id.slice(4) });
        }}
        onBack={onClose}
      />
      {layer?.kind === "message" && (
        <MessageDialog title={layer.title} lines={layer.lines} kind={layer.tone} onClose={() => setLayer(null)} />
      )}
    </>
  );
}
