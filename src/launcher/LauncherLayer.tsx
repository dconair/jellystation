import type { XmbEntry } from "../data/types";
import { MessageDialog } from "../ui/popup";
import { GameDialog } from "./GameDialog";
import { LaunchOverlay } from "./LaunchOverlay";

/** Was das Start-Overlay gerade zeigt. */
export interface LaunchView {
  key: number;
  entry: XmbEntry;
  status: string;
  /** false = blendet gerade aus. */
  open: boolean;
}

/** Ein Hinweis- oder Fehlerdialog der Warteschlange. */
export interface DialogSpec {
  key: number;
  tone: "error" | "info" | "success";
  title: string;
  lines: string[];
  detail?: string[];
  /** Zweite Option neben „Schließen“ (z. B. „Emulatoren prüfen“); sie läuft, nachdem sich der Dialog geschlossen hat. */
  action?: { label: string; run: () => void };
}

interface LauncherLayerProps {
  launching: LaunchView | null;
  /** Der vorderste Dialog der Warteschlange (es ist immer nur einer sichtbar). */
  dialog: DialogSpec | null;
  onLaunchExited: (key: number) => void;
  onCloseDialog: () => void;
}

/** Zeichnet das Start-Overlay und darüber den ersten Dialog der Warteschlange. */
export function LauncherLayer({ launching, dialog, onLaunchExited, onCloseDialog }: LauncherLayerProps) {
  return (
    <>
      {launching && (
        <LaunchOverlay
          key={launching.key}
          entry={launching.entry}
          status={launching.status}
          open={launching.open}
          active={!dialog}
          onExited={() => onLaunchExited(launching.key)}
        />
      )}
      {dialog &&
        (dialog.action ? (
          <GameDialog
            key={dialog.key}
            tone={dialog.tone}
            title={dialog.title}
            lines={dialog.lines}
            detail={dialog.detail}
            action={dialog.action}
            onClose={onCloseDialog}
          />
        ) : (
          <MessageDialog
            key={dialog.key}
            title={dialog.title}
            lines={dialog.lines}
            detail={dialog.detail}
            kind={dialog.tone}
            onClose={onCloseDialog}
          />
        ))}
    </>
  );
}
