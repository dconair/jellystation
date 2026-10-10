import { useEffect } from "react";
import { useUiPrefs } from "./uiPrefs";

/**
 * Wirkung der Darstellungs-Einstellungen, die keinem einzelnen Bauteil gehört: Helligkeit (ein durchsichtiger Vollbild-Filter
 * über allem – kein `filter` an Vorfahren, sonst würde `position: fixed` der Overlays falsch bezogen) und das Attribut
 * data-anim am <html> für die CSS-Regeln zu „Animationen: reduziert/aus“.
 */
export function UiEffects() {
  const { brightness, animations } = useUiPrefs();

  useEffect(() => {
    document.documentElement.dataset.anim = animations;
    return () => {
      delete document.documentElement.dataset.anim;
    };
  }, [animations]);

  if (Math.abs(brightness - 1) < 0.005) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        pointerEvents: "none",
        backdropFilter: `brightness(${brightness})`,
        WebkitBackdropFilter: `brightness(${brightness})`,
      }}
    />
  );
}
