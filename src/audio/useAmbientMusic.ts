import { useEffect, useRef } from "react";
import { useUiPrefs } from "../prefs/uiPrefs";
import { isMuted, onMutedChange } from "../xmb/sound";
import { createAmbientMusic } from "./ambient";
import type { AmbientMusic } from "./ambient";

/**
 * Hintergrundmusik im Menü: startet nach der ersten Eingabe (Autoplay-Regeln), folgt den Einstellungen (an/aus, Stimmung,
 * Lautstärke) und blendet weich aus, solange `suspended` gilt (Film/Spiel läuft), die Stummschaltung (Taste M) an ist
 * oder das Fenster nicht sichtbar ist.
 */
export function useAmbientMusic({ suspended }: { suspended: boolean }): void {
  const { musicEnabled, musicVolume, musicMood } = useUiPrefs();
  const engine = useRef<AmbientMusic | null>(null);
  const hidden = useRef(typeof document !== "undefined" && document.hidden);
  const muted = useRef(isMuted());
  // Erst nach der ersten Eingabe darf Ton starten (Autoplay-Regeln); vorher entsteht gar kein AudioContext.
  const armed = useRef(false);
  const wanted = useRef({ suspended, musicEnabled });
  wanted.current = { suspended, musicEnabled };

  const recompute = () => {
    const e = engine.current;
    if (!e) return;
    const off = !wanted.current.musicEnabled || wanted.current.suspended || muted.current || hidden.current;
    e.setSuspended(off);
    if (!off && armed.current) e.start();
  };

  useEffect(() => {
    const e = createAmbientMusic();
    engine.current = e;
    const unlock = () => {
      armed.current = true;
      recompute();
    };
    const events = ["keydown", "pointerdown", "touchstart", "gamepadconnected"] as const;
    for (const ev of events) window.addEventListener(ev, unlock, { capture: true, passive: true });
    // Controller-Tasten lösen kein Fensterereignis aus: kurz nachsehen, bis etwas gedrückt wurde.
    const pad = window.setInterval(() => {
      const pads = navigator.getGamepads?.() ?? [];
      if (Array.from(pads).some((p) => p?.buttons.some((b) => b.pressed))) unlock();
    }, 400);
    const onVis = () => {
      hidden.current = document.hidden;
      recompute();
    };
    document.addEventListener("visibilitychange", onVis);
    const offMute = onMutedChange((m) => {
      muted.current = m;
      recompute();
    });
    return () => {
      for (const ev of events) window.removeEventListener(ev, unlock, { capture: true });
      window.clearInterval(pad);
      document.removeEventListener("visibilitychange", onVis);
      offMute();
      e.dispose();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engine.current?.setMood(musicMood);
  }, [musicMood]);
  useEffect(() => {
    engine.current?.setVolume(musicVolume);
  }, [musicVolume]);
  useEffect(() => {
    // Nicht beim Start (das übernimmt die erste Eingabe), nur bei Änderungen danach.
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended, musicEnabled]);
}
