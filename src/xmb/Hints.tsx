import { PsSymbol } from "../ui/PsSymbol";

/**
 * Tastenhinweise unten rechts. Die PlayStation-Symbole stehen immer da (auch am Rechner),
 * die Tastaturkürzel folgen dezent dahinter.
 */
export function Hints() {
  return (
    <footer className="xmb-hints" aria-hidden="true">
      <span className="xmb-hint xmb-hint--cross">
        <PsSymbol symbol="cross" />
        <span className="xmb-hint__label">Öffnen</span>
        <kbd>Enter</kbd>
      </span>
      <span className="xmb-hint xmb-hint--circle">
        <PsSymbol symbol="circle" />
        <span className="xmb-hint__label">Zurück</span>
        <kbd>Esc</kbd>
      </span>
      <span className="xmb-hint xmb-hint--key">
        <kbd>M</kbd>
        <span className="xmb-hint__label">Ton</span>
      </span>
      <span className="xmb-hint xmb-hint--key">
        <kbd>F11</kbd>
        <span className="xmb-hint__label">Vollbild</span>
      </span>
    </footer>
  );
}
