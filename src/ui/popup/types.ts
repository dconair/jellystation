import type { XmbEntry } from "../../data/types";
import type { PsSymbolName } from "../PsSymbol";

/** Zustandspunkt vor einer Zeile (ok = grün, warn = gelb, error = rot, busy = laufende Punkte). */
export type PopupStatus = "ok" | "warn" | "error" | "busy";

/** Tonart einer Statuszeile (footer). */
export type PopupTone = "info" | "ok" | "warn" | "error";

/** Eine Zeile von PopupList. `id` muss in der Liste eindeutig sein; der Fokus hängt an der id, nicht am Index. */
export interface PopupItem {
  id: string;
  label: string;
  /** Zweite, gedimmte Zeile unter dem Namen (z. B. Pfad oder Version). */
  detail?: string;
  status?: PopupStatus;
  /** Häkchen vor der Zeile (z. B. aktuell gewählte Tonspur). */
  checked?: boolean;
  /** Ausgegraut und nicht anwählbar (der Fokus überspringt die Zeile). */
  disabled?: boolean;
  /** Abschnittsüberschrift: nicht fokussierbar, trennt Gruppen. */
  header?: boolean;
  /** 16:9-Kachel vor dem Text (Cover, Folgenbild); wird über ArtImage geladen. */
  art?: XmbEntry;
  /** 0..1: feiner Fortschrittsbalken (z. B. „Weiterschauen“). Bei Zeilen mit `art` liegt er auf der Kachel. */
  progress?: number;
  /** Rechtsbündiger Text (z. B. Laufzeit). */
  trailing?: string;
}

/** Aktionen, die ein Tastenhinweis auslösen kann, wenn man ihn anklickt. */
export type HintAction = "confirm" | "back" | "triangle" | "square";

/** Eintrag der Hinweisleiste unten im Panel. */
export interface PopupHint {
  symbol: PsSymbolName;
  label: string;
  /** Standard: ✕ = confirm, ○ = back, △ = triangle, □ = square. */
  action?: HintAction;
}

/** Statuszeile über der Hinweisleiste. `kind: "error"` wird als role="alert" ausgegeben. */
export interface PopupFooter {
  text: string;
  kind?: PopupTone;
}

export type PopupWidth = "narrow" | "normal" | "wide";

/** Breiten in rem. */
export const POPUP_WIDTH: Record<PopupWidth, number> = { narrow: 26, normal: 38, wide: 52 };
