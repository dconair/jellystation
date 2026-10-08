import { useEffect, useRef, useState } from "react";

/**
 * ✕ = confirm, ○ = back, △ = triangle, □ = square (PlayStation-Layout);
 * l1/r1/l2/r2 = Schultertasten, options/share = die kleinen Tasten neben dem Touchpad.
 */
export type PadAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "confirm"
  | "back"
  | "triangle"
  | "square"
  | "l1"
  | "r1"
  | "l2"
  | "r2"
  | "options"
  | "share";

interface Options {
  onAction: (action: PadAction) => void;
  enabled?: boolean;
}

// "Standard"-Mapping der Gamepad-API (DualShock 4: ✕ = 0, ○ = 1, □ = 2, △ = 3).
const BUTTON = {
  confirm: 0,
  back: 1,
  square: 2,
  triangle: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  share: 8,
  options: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;
/** Tasten, die nur beim Drücken (nicht beim Halten) einmal auslösen. */
const FACE_BUTTONS = ["confirm", "back", "triangle", "square", "l1", "r1", "l2", "r2", "share", "options"] as const;
type FaceButton = (typeof FACE_BUTTONS)[number];
const DIRECTIONS = ["up", "down", "left", "right"] as const;
type Direction = (typeof DIRECTIONS)[number];

const STICK_ON = 0.55; // ab hier gilt der Stick als gedrückt …
const STICK_OFF = 0.35; // … und erst darunter wieder als losgelassen (Hysterese)
const REPEAT_DELAY = 400; // ms bis zur ersten Wiederholung
const REPEAT_INTERVAL = 120; // ms zwischen Wiederholungen

export const prettyPadName = (id: string) => {
  if (/054c/i.test(id)) {
    if (/0ce6|0df2/i.test(id)) return "DualSense";
    if (/05c4|09cc/i.test(id)) return "DualShock 4";
  }
  return id.replace(/\(.*\)/, "").trim() || "Controller";
};

/**
 * Globaler Gamepad-Hook (HTML5 Gamepad API): D-Pad und linker Stick erzeugen
 * Richtungen mit Auto-Repeat, ✕ → "confirm", ○ → "back". Die Aktionen laufen durch
 * denselben Handler wie die Tastatur und lösen damit Fokuswechsel, CSS-Animationen
 * und Soundeffekte aus. Gibt den Namen des verbundenen Controllers zurück.
 */
export function useGamepad({ onAction, enabled = true }: Options) {
  const [controller, setController] = useState<string | null>(null);
  const handler = useRef(onAction);
  handler.current = onAction;

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;

    let raf = 0;
    let primed = false; // erster Frame nach (Re-)Aktivierung nur zum Abgleichen
    let current: string | null = null;
    const held = new Map<Direction, number>(); // Richtung → Zeitpunkt der nächsten Auslösung
    const stickDir = { x: 0, y: 0 };
    const prevButton = Object.fromEntries(FACE_BUTTONS.map((b) => [b, false])) as Record<FaceButton, boolean>;

    const releaseAll = () => {
      held.clear();
      stickDir.x = stickDir.y = 0;
    };

    const stickAxis = (value: number, state: number) => {
      const abs = Math.abs(value);
      if (state !== 0 && abs > STICK_OFF) return state;
      return abs > STICK_ON ? Math.sign(value) : 0;
    };

    const poll = (now: number) => {
      raf = requestAnimationFrame(poll);

      // Ohne Fokus liefert der Browser ohnehin keine Eingaben – kein Phantom-Input beim Zurückkehren.
      if (!document.hasFocus()) {
        primed = false;
        releaseAll();
        return;
      }

      const pads = Array.from(navigator.getGamepads()).filter(
        (p): p is Gamepad => p !== null && p.connected,
      );
      const name = pads.length > 0 ? prettyPadName(pads[0].id) : null;
      if (name !== current) {
        current = name;
        setController(name);
      }

      const down: Record<Direction, boolean> = { up: false, down: false, left: false, right: false };
      const pressed = Object.fromEntries(FACE_BUTTONS.map((b) => [b, false])) as Record<FaceButton, boolean>;
      for (const pad of pads) {
        for (const d of DIRECTIONS) if (pad.buttons[BUTTON[d]]?.pressed) down[d] = true;
        for (const b of FACE_BUTTONS) pressed[b] ||= !!pad.buttons[BUTTON[b]]?.pressed;

        // Linker Stick: immer nur die dominante Achse, damit Diagonalen nicht doppelt auslösen.
        const x = pad.axes[0] ?? 0;
        const y = pad.axes[1] ?? 0;
        const horizontal = Math.abs(x) >= Math.abs(y);
        stickDir.x = horizontal ? stickAxis(x, stickDir.x) : 0;
        stickDir.y = horizontal ? 0 : stickAxis(y, stickDir.y);
        if (stickDir.x < 0) down.left = true;
        if (stickDir.x > 0) down.right = true;
        if (stickDir.y < 0) down.up = true;
        if (stickDir.y > 0) down.down = true;
      }

      if (!primed) {
        // Bereits gehaltene Tasten ignorieren, bis sie losgelassen werden.
        for (const b of FACE_BUTTONS) prevButton[b] = pressed[b];
        for (const d of DIRECTIONS) if (down[d]) held.set(d, Infinity);
        primed = true;
        return;
      }

      for (const d of DIRECTIONS) {
        if (!down[d]) {
          held.delete(d);
          continue;
        }
        const next = held.get(d);
        if (next === undefined) {
          held.set(d, now + REPEAT_DELAY);
          handler.current(d);
        } else if (now >= next) {
          held.set(d, now + REPEAT_INTERVAL);
          handler.current(d);
        }
      }

      for (const b of FACE_BUTTONS) {
        if (pressed[b] && !prevButton[b]) handler.current(b);
        prevButton[b] = pressed[b];
      }
    };

    raf = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(raf);
      setController(null);
    };
  }, [enabled]);

  return { controller };
}
