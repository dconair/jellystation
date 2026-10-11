import { useMemo, useRef } from "react";
import { PopupList } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { ACCENTS, getUiPrefs, setUiPrefs } from "./uiPrefs";

export interface AccentPickerProps {
  /** Schließt die Auswahl (nach ✕ bleibt die Farbe, nach ○ ist wieder die alte gesetzt). */
  onClose: () => void;
  active?: boolean;
}

/**
 * Schnelle Farbwahl für Untermenüs (Serien, Filme): Beim Bewegen im Menü färbt sich die Oberfläche sofort um,
 * ✕ behält die Farbe, ○ stellt die vorherige wieder her. Wirkt auf `accentId` – dieselbe Einstellung wie
 * Einstellungen → Anzeige & Farben → Akzentfarbe.
 */
export function AccentPicker({ onClose, active = true }: AccentPickerProps) {
  const start = useRef(getUiPrefs().accentId);
  const items = useMemo<PopupItem[]>(
    () =>
      ACCENTS.map((a) => ({
        id: a.id,
        label: a.id === "custom" ? "Eigener Farbton (aus den Einstellungen)" : a.label,
        checked: a.id === start.current,
      })),
    [],
  );
  return (
    <PopupList
      title="Farbe"
      subtitle="Wirkt sofort"
      width="narrow"
      align="right"
      dim={0.45}
      items={items}
      hints={[
        { symbol: "cross", label: "Übernehmen" },
        { symbol: "circle", label: "Verwerfen" },
      ]}
      focusId={start.current}
      active={active}
      onFocusChange={(id) => {
        if (id && id !== getUiPrefs().accentId) setUiPrefs({ accentId: id });
      }}
      onSelect={(id) => {
        setUiPrefs({ accentId: id });
        onClose();
      }}
      onBack={() => {
        setUiPrefs({ accentId: start.current });
        onClose();
      }}
    />
  );
}
