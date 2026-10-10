import { accentColor } from "./uiPrefs";
import type { UiPrefs } from "./uiPrefs";

/**
 * Akzentfarbe als CSS-Variablen am <html>: eine Leiter `--ui-l92 … --ui-l5` aus RGB-Tripeln („r, g, b“) in festen
 * HSL-Helligkeitsstufen (92 % = fast weiß … 5 % = fast schwarz), alle im Farbton der Akzentfarbe. Die Stylesheets
 * benutzen sie als `rgba(var(--ui-l76), 0.4)`; damit tönen Listen, Dialoge, Serien-Screen, Setup und Player gemeinsam.
 */
export const ACCENT_TIERS = [92, 84, 76, 68, 58, 48, 38, 28, 20, 14, 9, 5] as const;

/** Sättigung je Stufe: helle Töne bleiben kräftig, dunkle Flächen etwas gedämpft (wie die Panels der PS3). */
const satFor = (l: number) => (l >= 68 ? 1 : l >= 48 ? 0.85 : 0.65);

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function accentVars(prefs: Pick<UiPrefs, "themeId" | "customHue" | "accentId" | "accentHue">, date: Date = new Date()): Record<string, string> {
  const { hue, sat } = accentColor(prefs, date);
  const vars: Record<string, string> = { "--ui-hue": String(hue) };
  for (const l of ACCENT_TIERS) vars[`--ui-l${l}`] = hslToRgb(hue, satFor(l) * sat, l / 100).join(", ");
  return vars;
}

export function applyAccent(prefs: Pick<UiPrefs, "themeId" | "customHue" | "accentId" | "accentHue">, root: HTMLElement = document.documentElement) {
  for (const [k, v] of Object.entries(accentVars(prefs))) root.style.setProperty(k, v);
}
