import { useMemo, useState } from "react";
import { OverlayFrame, PopupList } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import type { EngineState } from "./engine";

export type FitMode = "contain" | "cover" | "fill";

export const FIT_LABEL: Record<FitMode, string> = { contain: "Einpassen", cover: "Füllen", fill: "Strecken" };
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const MBIT = 1_000_000;
export const QUALITIES: ReadonlyArray<{ bps: number | undefined; label: string }> = [
  { bps: undefined, label: "Automatisch (Original)" },
  ...[40, 20, 12, 8, 4, 2].map((m) => ({ bps: m * MBIT, label: `${m} Mbit/s` })),
];

export const qualityLabel = (bps: number | undefined) => QUALITIES.find((q) => q.bps === bps)?.label ?? (bps ? `${Math.round(bps / MBIT)} Mbit/s` : "Automatisch (Original)");
export const speedLabel = (r: number) => `${String(r).replace(".", ",")}×`;

type View = "root" | "audio" | "subtitles" | "quality" | "fit" | "speed";

export interface OptionsMenuProps {
  st: EngineState;
  demo: boolean;
  fit: FitMode;
  onClose(): void;
  onAudio(index: number): void;
  onSubtitle(index: number | null): void;
  onQuality(bps: number | undefined): void;
  onFit(fit: FitMode): void;
  onSpeed(rate: number): void;
  onInfo(): void;
  onFullscreen(): void;
}

/**
 * Optionen (△): eine Liste mit Untermenüs. Eine Auswahl schließt das Menü, damit das Bild gleich wieder frei liegt.
 * Alle Listen stecken in einem gemeinsamen Rahmen, der Wechsel zwischen Haupt- und Unterliste blendet also nicht neu ein.
 */
export function OptionsMenu(p: OptionsMenuProps) {
  const { st, demo } = p;
  const [view, setView] = useState<View>("root");
  const [rootFocus, setRootFocus] = useState<string | undefined>(undefined);
  const plan = st.plan;

  const audioNow = plan?.audio.find((a) => a.index === plan.audioIndex);
  const subNow = st.subtitleIndex === null ? undefined : plan?.subtitles.find((s) => s.index === st.subtitleIndex);

  const root = useMemo<PopupItem[]>(
    () => [
      {
        id: "audio",
        label: "Audio",
        detail: demo ? "Nur mit Jellyfin" : audioNow ? audioNow.label : plan && plan.audio.length === 0 ? "Keine Tonspuren" : undefined,
        disabled: demo || !plan || plan.audio.length === 0,
      },
      {
        id: "subtitles",
        label: "Untertitel",
        detail: !plan || plan.subtitles.length === 0 ? "Keine vorhanden" : subNow ? subNow.label : "Aus",
        disabled: !plan || plan.subtitles.length === 0,
      },
      { id: "quality", label: "Qualität", detail: demo ? "Nur mit Jellyfin" : qualityLabel(st.maxBitrate), disabled: demo },
      { id: "fit", label: "Bildformat", detail: FIT_LABEL[p.fit] },
      { id: "speed", label: "Geschwindigkeit", detail: speedLabel(st.rate) },
      { id: "info", label: "Stream-Info", disabled: !plan },
      { id: "fullscreen", label: "Vollbild ein/aus" },
    ],
    [demo, audioNow, plan, subNow, st.maxBitrate, st.rate, p.fit],
  );

  const items = useMemo<PopupItem[]>(() => {
    switch (view) {
      case "audio":
        return (plan?.audio ?? []).map((a) => ({ id: `a${a.index}`, label: a.label, checked: a.index === plan?.audioIndex }));
      case "subtitles":
        return [
          { id: "off", label: "Aus", checked: st.subtitleIndex === null },
          ...(plan?.subtitles ?? []).map((s) => ({
            id: `s${s.index}`,
            label: s.label,
            detail: s.burnIn ? "wird eingebrannt (Transkodierung)" : s.isForced ? "Erzwungen" : undefined,
            checked: s.index === st.subtitleIndex,
          })),
        ];
      case "quality":
        return QUALITIES.map((q) => ({ id: `q${q.bps ?? 0}`, label: q.label, checked: q.bps === st.maxBitrate }));
      case "fit":
        return (Object.keys(FIT_LABEL) as FitMode[]).map((m) => ({ id: m, label: FIT_LABEL[m], checked: m === p.fit }));
      case "speed":
        return SPEEDS.map((r) => ({ id: `r${r}`, label: speedLabel(r), checked: r === st.rate }));
      default:
        return root;
    }
  }, [view, root, plan, st.subtitleIndex, st.maxBitrate, st.rate, p.fit]);

  const title = { root: "Optionen", audio: "Audio", subtitles: "Untertitel", quality: "Qualität", fit: "Bildformat", speed: "Geschwindigkeit" }[view];

  const select = (id: string) => {
    if (view === "root") {
      setRootFocus(id);
      if (id === "info") return p.onInfo();
      if (id === "fullscreen") return p.onFullscreen();
      return setView(id as View);
    }
    if (view === "audio") p.onAudio(Number(id.slice(1)));
    else if (view === "subtitles") p.onSubtitle(id === "off" ? null : Number(id.slice(1)));
    else if (view === "quality") p.onQuality(id === "q0" ? undefined : Number(id.slice(1)));
    else if (view === "fit") p.onFit(id as FitMode);
    else if (view === "speed") p.onSpeed(Number(id.slice(1)));
  };

  const back = () => (view === "root" ? p.onClose() : setView("root"));
  // Beim Zurückkehren steht der Fokus wieder auf dem Eintrag, aus dem man kam.
  const focusId = view === "root" ? rootFocus : (items.find((i) => i.checked)?.id ?? undefined);

  return (
    <OverlayFrame align="right" dim={0.38} onBack={p.onClose} keyboard={false}>
      <PopupList key={view} frame={false} title={title} items={items} focusId={focusId} onSelect={select} onBack={back} width="normal" />
    </OverlayFrame>
  );
}
