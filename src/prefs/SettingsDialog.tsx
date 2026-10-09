import { MessageDialog } from "../ui/popup";

export type SettingsSection = "display" | "motion" | "sound";

export interface SettingsDialogProps {
  section: SettingsSection;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe. */
  active?: boolean;
}

/** VORLÄUFIG: wird durch die echten Einstellungs-Dialoge (Anzeige & Farben, Animationen, Ton & Musik) ersetzt. */
export function SettingsDialog({ section, onClose, active = true }: SettingsDialogProps) {
  return <MessageDialog title="Einstellungen" lines={[`Bereich „${section}“ folgt.`]} onClose={onClose} active={active} />;
}
