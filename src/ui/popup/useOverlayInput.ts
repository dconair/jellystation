import { useEffect, useRef } from "react";
import { useGamepad } from "../../input/useGamepad";
import type { PadAction } from "../../input/useGamepad";

/** Tastenbelegung: `KeyboardEvent.key` → Aktion. `null` gibt eine Standardtaste frei (sie bleibt unbehandelt). */
export type KeyMap = Readonly<Record<string, PadAction | null>>;

/** Standardbelegung der Tastatur – dieselben Aktionen wie der Controller. */
export const DEFAULT_KEY_MAP: Readonly<Record<string, PadAction>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "confirm",
  " ": "confirm",
  Escape: "back",
  Backspace: "back",
  o: "triangle",
  O: "triangle",
  q: "l1",
  Q: "l1",
  e: "r1",
  E: "r1",
};

/** Beim Gedrückthalten wiederholen nur Richtungen und Blättern – ✕ ○ △ □ lösen je Druck genau einmal aus. */
const REPEATABLE: ReadonlySet<PadAction> = new Set<PadAction>(["up", "down", "left", "right", "l1", "r1", "l2", "r2"]);

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"]);

/** Textfelder behalten ihre Tasten (Buchstaben, Leertaste, Backspace, Pfeile). */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

/*
 * Reihenfolge der Overlays: Wer zuletzt aktiv wurde, liegt oben und bekommt als Einziger die Eingabe.
 * Das ist ein Sicherheitsnetz – laut Vertrag setzt der Aufrufer ein darunterliegendes Overlay ohnehin auf
 * active={false} –, verhindert aber doppelte Reaktionen (z. B. ✕ wählt in der Liste UND im Dialog darüber).
 */
let layerCounter = 0;
const activeLayers = new Set<number>();
const isTopLayer = (id: number) => {
  for (const other of activeLayers) if (other > id) return false;
  return activeLayers.has(id);
};

export interface OverlayInputOptions {
  /** false = keine Tastatur-/Controller-Eingabe (z. B. weil darüber ein weiteres Overlay liegt). */
  active: boolean;
  onAction: (action: PadAction) => void;
  /** Zusätzliche/abweichende Tasten, wird über {@link DEFAULT_KEY_MAP} gelegt. */
  keyMap?: KeyMap;
  /**
   * Für Tasten ohne Aktion (z. B. Pos1/Ende). Rückgabe `true` = behandelt (die Taste wird dann
   * verschluckt, wie jede andere behandelte Taste).
   */
  onKey?: (event: KeyboardEvent) => boolean | void;
}

/**
 * Einheitliche Eingabe für Overlays: Tastatur (window, Capture-Phase) und Controller (useGamepad)
 * erzeugen dieselben {@link PadAction}s. Behandelte Tasten werden verschluckt (preventDefault + stopPropagation),
 * damit weder das Hauptmenü noch der Browser (Leertaste scrollt, Backspace „zurück“) mitreagiert.
 *
 * - Tasten mit Strg/Alt/Cmd bleiben unberührt (Kürzel der App und des Systems).
 * - In Textfeldern gilt nur Esc; alle anderen Tasten gehören dem Feld.
 * - Gedrückthalten wiederholt nur Richtungen und L1/R1; ✕ ○ △ □ einmal pro Druck. Das verhindert, dass der
 *   Druck, der ein Overlay geöffnet oder geschlossen hat, im nächsten sofort noch einmal wirkt.
 * - Der Controller-Zweig ignoriert beim Aktivieren bereits gehaltene Tasten (siehe useGamepad).
 */
export function useOverlayInput({ active, onAction, keyMap, onKey }: OverlayInputOptions): { controller: string | null } {
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const keyMapRef = useRef(keyMap);
  keyMapRef.current = keyMap;
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const layer = useRef(0);

  useEffect(() => {
    if (!active) return;
    const id = ++layerCounter;
    layer.current = id;
    activeLayers.add(id);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopLayer(id)) return;
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextField(e.target) && e.key !== "Escape") return;

      const custom = keyMapRef.current;
      const action =
        custom && Object.prototype.hasOwnProperty.call(custom, e.key) ? custom[e.key] : DEFAULT_KEY_MAP[e.key];
      if (action === undefined) {
        if (onKeyRef.current?.(e) === true) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (action === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && !REPEATABLE.has(action)) return;
      actionRef.current(action);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      activeLayers.delete(id);
    };
  }, [active]);

  const { controller } = useGamepad({
    enabled: active,
    onAction: (action) => {
      if (isTopLayer(layer.current)) actionRef.current(action);
    },
  });
  return { controller: active ? controller : null };
}
