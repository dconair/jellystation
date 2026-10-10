import { useMemo, useRef } from "react";
import { PopupList } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { MOODS } from "../audio/moods";
import { playSfx } from "../xmb/sound";
import { DEFAULT_UI_PREFS, LIMITS, THEMES, resetUiPrefs, setUiPrefs, useUiPrefs } from "./uiPrefs";
import type { AnimationMode, UiPrefs } from "./uiPrefs";

export type SettingsSection = "display" | "motion" | "sound";

export interface SettingsDialogProps {
  section: SettingsSection;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe. */
  active?: boolean;
}

type NumKey = "brightness" | "customHue" | "waveSpeed" | "motionSpeed" | "sfxVolume" | "musicVolume";
type BoolKey = "dayNight" | "waves" | "shapes" | "dust" | "musicEnabled";

type Row =
  | { id: string; kind: "number"; key: NumKey; label: string; detail: string; format: (v: number) => string }
  | { id: string; kind: "bool"; key: BoolKey; label: string; detail: string }
  | { id: string; kind: "theme"; label: string; detail: string }
  | { id: string; kind: "animations"; label: string; detail: string }
  | { id: string; kind: "mood"; label: string; detail: string }
  | { id: string; kind: "reset"; label: string; detail: string };

const percent = (v: number) => `${Math.round(v * 100)} %`;
const speed = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "").replace(".", ",")}×`;

const TITLES: Record<SettingsSection, { title: string; subtitle: string }> = {
  display: { title: "Anzeige & Farben", subtitle: "Wirkt sofort – ←/→ ändert den Wert" },
  motion: { title: "Animationen", subtitle: "Bewegung im Menü und im Hintergrund" },
  sound: { title: "Ton & Musik", subtitle: "Menü-Töne und Hintergrundmusik (Taste M schaltet alles stumm)" },
};

const ROWS: Record<SettingsSection, Row[]> = {
  display: [
    { id: "brightness", kind: "number", key: "brightness", label: "Helligkeit", detail: "Gilt für die ganze App, auch für Filme", format: percent },
    { id: "theme", kind: "theme", label: "Farbthema", detail: "Hintergrundfarbe – „Automatisch“ wechselt wie die PS3 mit dem Monat" },
    { id: "customHue", kind: "number", key: "customHue", label: "Eigener Farbton", detail: "Nur bei „Eigener Farbton“", format: (v) => `${Math.round(v)}°` },
    { id: "dayNight", kind: "bool", key: "dayNight", label: "Tag/Nacht-Verlauf", detail: "Abends wird der Hintergrund dunkler" },
    { id: "waves", kind: "bool", key: "waves", label: "Wellen", detail: "Seidige Bänder im Hintergrund" },
    { id: "shapes", kind: "bool", key: "shapes", label: "PlayStation-Symbole", detail: "Langsam fliegende Formen" },
    { id: "dust", kind: "bool", key: "dust", label: "Lichtpartikel", detail: "Feiner Glanzstaub" },
    { id: "waveSpeed", kind: "number", key: "waveSpeed", label: "Wellen-Tempo", detail: "Wie schnell sich die Wellen bewegen", format: speed },
    { id: "reset", kind: "reset", label: "Alles zurücksetzen", detail: "Setzt Anzeige, Animationen und Ton auf die Standardwerte" },
  ],
  motion: [
    { id: "animations", kind: "animations", label: "Animationen", detail: "Voll: wie gewohnt · Reduziert: kürzer, ruhiger Hintergrund · Aus: alles springt direkt" },
    { id: "motionSpeed", kind: "number", key: "motionSpeed", label: "Tempo der Menü-Bewegung", detail: "Schneller wirkt direkter, langsamer weicher", format: speed },
    { id: "waveSpeed", kind: "number", key: "waveSpeed", label: "Wellen-Tempo", detail: "Wie schnell sich die Wellen im Hintergrund bewegen", format: speed },
  ],
  sound: [
    { id: "sfxVolume", kind: "number", key: "sfxVolume", label: "Lautstärke der Menü-Töne", detail: "Klicken, Wechseln, Bestätigen", format: percent },
    { id: "musicEnabled", kind: "bool", key: "musicEnabled", label: "Hintergrundmusik", detail: "Leise, atmosphärische Klänge im Menü – pausiert bei Filmen und Spielen" },
    { id: "musicMood", kind: "mood", label: "Stimmung", detail: "Sanft, Tiefsee, Nachtlicht oder Morgenlicht" },
    { id: "musicVolume", kind: "number", key: "musicVolume", label: "Lautstärke der Musik", detail: "Die Musik bleibt immer leise im Hintergrund", format: percent },
  ],
};

const ANIM_ORDER: AnimationMode[] = ["full", "reduced", "off"];
const ANIM_LABEL: Record<AnimationMode, string> = { full: "Voll", reduced: "Reduziert", off: "Aus" };

const round = (n: number, step: number) => Math.round(n / step) * step;

/** Einstellungen mit Reglern, Schaltern und Auswahl; jede Änderung wirkt sofort und wird gespeichert (uiPrefs). */
export function SettingsDialog({ section, onClose, active = true }: SettingsDialogProps) {
  const prefs = useUiPrefs();
  const previewTimer = useRef<number | null>(null);

  const rows = useMemo(
    () => ROWS[section].filter((r) => !(r.id === "customHue" && prefs.themeId !== "custom")),
    [section, prefs.themeId],
  );

  const items = useMemo<PopupItem[]>(
    () =>
      rows.map((r) => {
        let trailing = "";
        if (r.kind === "number") trailing = `◀  ${r.format(prefs[r.key])}  ▶`;
        else if (r.kind === "bool") trailing = prefs[r.key] ? "An" : "Aus";
        else if (r.kind === "theme") trailing = `◀  ${THEMES.find((t) => t.id === prefs.themeId)?.label ?? ""}  ▶`;
        else if (r.kind === "animations") trailing = `◀  ${ANIM_LABEL[prefs.animations]}  ▶`;
        else if (r.kind === "mood") trailing = `◀  ${MOODS.find((m) => m.id === prefs.musicMood)?.label ?? ""}  ▶`;
        const detail = r.kind === "mood" ? (MOODS.find((m) => m.id === prefs.musicMood)?.description ?? r.detail) : r.detail;
        return { id: r.id, label: r.label, detail, trailing: trailing || undefined };
      }),
    [rows, prefs],
  );

  const previewSound = () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => playSfx("move"), 150);
  };

  const adjust = (id: string, dir: -1 | 1) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (row.kind === "number") {
      const lim = LIMITS[row.key];
      const next = Math.min(lim.max, Math.max(lim.min, round(prefs[row.key] + dir * lim.step, lim.step / 10)));
      setUiPrefs({ [row.key]: Number(next.toFixed(3)) } as Partial<UiPrefs>);
      if (row.key === "sfxVolume") previewSound();
    } else if (row.kind === "bool") {
      setUiPrefs({ [row.key]: !prefs[row.key] } as Partial<UiPrefs>);
    } else if (row.kind === "theme") {
      const at = THEMES.findIndex((t) => t.id === prefs.themeId);
      const next = THEMES[(at + dir + THEMES.length) % THEMES.length];
      setUiPrefs({ themeId: next.id });
    } else if (row.kind === "mood") {
      const at = MOODS.findIndex((m) => m.id === prefs.musicMood);
      setUiPrefs({ musicMood: MOODS[(at + dir + MOODS.length) % MOODS.length].id });
    } else if (row.kind === "animations") {
      const at = ANIM_ORDER.indexOf(prefs.animations);
      setUiPrefs({ animations: ANIM_ORDER[(at + dir + ANIM_ORDER.length) % ANIM_ORDER.length] });
    }
  };

  const onSelect = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (row.kind === "reset") resetUiPrefs();
    else adjust(id, 1);
  };

  // △: die Zeile auf den Standardwert zurücksetzen.
  const resetRow = (id: string | null) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (row.kind === "number" || row.kind === "bool") setUiPrefs({ [row.key]: DEFAULT_UI_PREFS[row.key] } as Partial<UiPrefs>);
    else if (row.kind === "theme") setUiPrefs({ themeId: DEFAULT_UI_PREFS.themeId });
    else if (row.kind === "mood") setUiPrefs({ musicMood: DEFAULT_UI_PREFS.musicMood });
    else if (row.kind === "animations") setUiPrefs({ animations: DEFAULT_UI_PREFS.animations });
  };

  const { title, subtitle } = TITLES[section];
  return (
    <PopupList
      title={title}
      subtitle={subtitle}
      width="wide"
      align="right"
      dim={0.35}
      items={items}
      active={active}
      hints={[
        { symbol: "cross", label: "Weiter wählen" },
        { symbol: "triangle", label: "Standard", action: "triangle" },
        { symbol: "circle", label: "Zurück" },
      ]}
      footer={{ text: "←/→ ändert den Wert · Änderungen gelten sofort", kind: "info" }}
      onSelect={onSelect}
      onHorizontal={(id, _item, dir) => adjust(id, dir)}
      onAlt={resetRow}
      altLabel="Standard"
      onBack={onClose}
    />
  );
}
