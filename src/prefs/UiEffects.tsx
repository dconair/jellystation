import { useEffect } from "react";
import { applyAccent } from "./accent";
import { useUiPrefs } from "./uiPrefs";
import "./glass.css";

/**
 * Wirkung der Darstellungs-Einstellungen, die keinem einzelnen Bauteil gehört: Helligkeit (ein durchsichtiger Vollbild-Filter
 * über allem – kein `filter` an Vorfahren, sonst würde `position: fixed` der Overlays falsch bezogen) und das Attribut
 * data-anim am <html> für die CSS-Regeln zu „Animationen: reduziert/aus“ sowie data-look für den Oberflächen-Stil (glass.css).
 */
export function UiEffects() {
  const { brightness, animations, themeId, customHue, accentId, accentHue, interfaceStyle } = useUiPrefs();

  useEffect(() => {
    document.documentElement.dataset.anim = animations;
    return () => {
      delete document.documentElement.dataset.anim;
    };
  }, [animations]);

  useEffect(() => {
    document.documentElement.dataset.look = interfaceStyle;
    return () => {
      delete document.documentElement.dataset.look;
    };
  }, [interfaceStyle]);

  // Akzentfarbe (Listen, Dialoge, Untermenüs); „Automatisch“ folgt der Monatsfarbe und wird deshalb ab und zu neu gerechnet.
  useEffect(() => {
    const apply = () => applyAccent({ themeId, customHue, accentId, accentHue });
    apply();
    const timer = window.setInterval(apply, 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [themeId, customHue, accentId, accentHue]);

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
