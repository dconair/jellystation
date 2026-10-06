import { useEffect, useState } from "react";
import { prettyPadName } from "./useGamepad";

/**
 * Beobachtet den Controller für den Setup-Assistenten: Name des verbundenen Geräts und
 * ob mindestens eine Taste gedrückt / ein Stick bewegt wurde (Browser geben Gamepads
 * erst nach der ersten Eingabe frei).
 */
export function useControllerProbe(active: boolean) {
  const [name, setName] = useState<string | null>(null);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    if (!active || typeof navigator.getGamepads !== "function") return;
    let raf = 0;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pad = Array.from(navigator.getGamepads()).find((p) => p?.connected);
      setName(pad ? prettyPadName(pad.id) : null);
      if (pad && (pad.buttons.some((b) => b.pressed) || pad.axes.some((a) => Math.abs(a) > 0.6))) {
        setPressed(true);
      }
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return { name, pressed };
}
