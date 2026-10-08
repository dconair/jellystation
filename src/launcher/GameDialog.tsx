import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { PadAction } from "../input/useGamepad";
import { OverlayFrame, useOverlayInput } from "../ui/popup";
import type { PopupHint } from "../ui/popup";
import { HintBar, KindIcon, useResizeGuard } from "../ui/popup/parts";
import { playSfx } from "../xmb/sound";

export interface GameDialogProps {
  tone: "error" | "info" | "success";
  title: string;
  lines: readonly string[];
  /** Monospace-Block unter dem Text (Befehl, Fehlerausgabe). */
  detail?: readonly string[];
  /** Zweite Option neben „Schließen“, z. B. „Emulatoren prüfen“. Der Dialog schließt sich zuerst, dann läuft `run`. */
  action?: { label: string; run: () => void };
  closeLabel?: string;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe (liegt ein anderes Overlay darüber). */
  active?: boolean;
}

/**
 * Meldung mit zwei Optionen (Aktion / Schließen) und Detailblock. MessageDialog aus ui/popup kennt nur „OK“; hier
 * braucht der Fehlerdialog nach einem gescheiterten Spielstart zusätzlich den Weg zu den Emulator-Einstellungen.
 * Aussehen und Bedienung folgen MessageDialog/ConfirmDialog (gleiche CSS-Klassen aus popup.css): ←→ wechseln,
 * ✕ wählt, ○ schließt, ↑↓ / L1 R1 blättern im Detailblock.
 */
export function GameDialog({ tone, title, lines, detail, action, closeLabel = "Schließen", onClose, active = true }: GameDialogProps) {
  const uid = useId();
  const panelRef = useRef<HTMLElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLPreElement>(null);
  useResizeGuard(panelRef);

  const labels = action ? [action.label, closeLabel] : [closeLabel];
  // Der Fokus liegt zuerst auf „Schließen“ (sichere Option): ein hastiges ✕ soll nichts Neues öffnen.
  const [index, setIndex] = useState(labels.length - 1);
  const indexRef = useRef(index);
  const cb = useRef({ action, onClose });
  cb.current = { action, onClose };

  const move = (i: number) => {
    if (i < 0 || i >= labels.length || i === indexRef.current) return;
    indexRef.current = i;
    setIndex(i);
    playSfx("move");
  };
  const pick = (i: number) => {
    const { action: act, onClose: close } = cb.current;
    if (act && i === 0) {
      playSfx("confirm");
      close();
      act.run();
    } else {
      playSfx("back");
      close();
    }
  };

  const scroll = (dir: 1 | -1, page: boolean) => {
    const d = detailRef.current;
    const el = d && d.scrollHeight > d.clientHeight ? d : messageRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const unit = page ? el.clientHeight * 0.85 : (parseFloat(getComputedStyle(el).lineHeight) || 20) * 3;
    el.scrollBy({ top: dir * unit, behavior: "smooth" });
  };

  useOverlayInput({
    active,
    onAction: (a: PadAction) => {
      switch (a) {
        case "left":
          return move(indexRef.current - 1);
        case "right":
          return move(indexRef.current + 1);
        case "confirm":
          return pick(indexRef.current);
        case "back":
          return pick(labels.length - 1);
        case "up":
          return scroll(-1, false);
        case "down":
          return scroll(1, false);
        case "l1":
          return scroll(-1, true);
        case "r1":
          return scroll(1, true);
        default:
          return;
      }
    },
  });

  // Fehlerausgaben enden meist mit der Ursache: dort beginnen.
  const hasDetail = !!detail && detail.length > 0;
  useLayoutEffect(() => {
    const el = detailRef.current;
    if (el) el.scrollTop = tone === "error" ? el.scrollHeight : 0;
  }, [hasDetail, tone, detail?.length]);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const hints: PopupHint[] = [
    { symbol: "cross", label: "Auswählen" },
    { symbol: "circle", label: closeLabel },
  ];

  return (
    <OverlayFrame keyboard={false} active={active} onBack={() => cb.current.onClose()}>
      <section
        ref={panelRef}
        className={`pop-panel pop-dialog pop-dialog--message is-${tone}${active ? "" : " is-inactive"}`}
        role={tone === "error" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-msg`}
      >
        <header className="pop-head">
          <KindIcon kind={tone} />
          <div className="pop-head__text">
            <h2 id={`${uid}-title`} className="pop-title">
              {title}
            </h2>
          </div>
        </header>
        <div className="pop-dialog__body">
          <div id={`${uid}-msg`} ref={messageRef} className="pop-message" role={tone === "error" ? "alert" : undefined}>
            {lines.map((line, i) => (
              <p key={i} className={line.trim() === "" ? "pop-gap" : undefined}>
                {line}
              </p>
            ))}
          </div>
          {hasDetail && (
            <pre ref={detailRef} className="pop-detail" aria-label="Details">
              {detail.map((line, i) => (
                <span key={i}>{line + "\n"}</span>
              ))}
            </pre>
          )}
        </div>
        <div className={`pop-choices${ready ? " is-ready" : ""}`} role="group">
          <div className="pop-choices__row">
            <div
              className="pop-choice-bar"
              aria-hidden="true"
              style={{ transform: `translate3d(calc(${index} * (var(--choice-w) + var(--choice-gap))), 0, 0)` }}
            >
              <span className="pop-bar__halo" />
            </div>
            {labels.map((label, i) => (
              <button
                key={label}
                type="button"
                tabIndex={-1}
                className={`pop-choice${i === index ? " is-focused" : ""}`}
                aria-current={i === index ? "true" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!active) return;
                  move(i);
                  pick(i);
                }}
              >
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <HintBar
          hints={hints}
          onHint={(a) => {
            if (!active) return;
            if (a === "confirm") pick(indexRef.current);
            else if (a === "back") pick(labels.length - 1);
          }}
        />
      </section>
    </OverlayFrame>
  );
}
