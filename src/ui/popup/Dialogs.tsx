import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { PadAction } from "../../input/useGamepad";
import { playSfx } from "../../xmb/sound";
import { MaybeFrame, useFrameClaim } from "./OverlayFrame";
import type { OverlayAlign } from "./OverlayFrame";
import { DotSpinner, HintBar, KindIcon } from "./parts";
import { clamp01 } from "./listLayout";
import type { PopupHint } from "./types";
import { useOverlayInput } from "./useOverlayInput";
import "./popup.css";

/** Gemeinsame, optionale Einstellungen der Dialoge. */
interface DialogBase {
  /** false = sichtbar, aber ohne Eingabe (z. B. weil ein weiterer Dialog darüber liegt). */
  active?: boolean;
  /** false = kein eigener OverlayFrame. */
  frame?: boolean;
  align?: OverlayAlign;
  dim?: boolean | number;
}

/** Text mit Zeilenumbrüchen als Absätze (leere Zeilen werden zu Abstand). */
function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <p key={i} className={line.trim() === "" ? "pop-gap" : undefined}>
          {line}
        </p>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ Auswahl-Leiste (Dialog-Optionen) */

interface Choice {
  id: string;
  label: string;
  /** Rot hervorgehoben (gefährliche Aktion). */
  danger?: boolean;
}

/**
 * Nebeneinander stehende Optionen mit EINEM Leuchtbalken, der zur gewählten Option gleitet –
 * dasselbe Prinzip wie in PopupList. Breite und Abstand sind fest, die Position ergibt sich daraus.
 */
function Choices({
  choices,
  index,
  onPick,
  active,
}: {
  choices: readonly Choice[];
  index: number;
  onPick: (i: number) => void;
  active: boolean;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const current = choices[index];
  return (
    <div className={`pop-choices${ready ? " is-ready" : ""}`} role="group">
      <div className="pop-choices__row">
        <div
          className={`pop-choice-bar${current?.danger ? " is-danger" : ""}`}
          aria-hidden="true"
          style={{ transform: `translate3d(calc(${index} * (var(--choice-w) + var(--choice-gap))), 0, 0)` }}
        >
          <span className="pop-bar__halo" />
        </div>
        {choices.map((choice, i) => (
          <button
            key={choice.id}
            type="button"
            tabIndex={-1}
            className={`pop-choice${i === index ? " is-focused" : ""}${choice.danger ? " is-danger" : ""}`}
            aria-pressed={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => active && onPick(i)}
          >
            <span>{choice.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ ConfirmDialog */

export interface ConfirmDialogProps extends DialogBase {
  title: string;
  /** Text der Frage; „\n“ beginnt einen neuen Absatz. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** ○ / Esc / Klick neben das Panel / Auswahl der zweiten Option. */
  onCancel: () => void;
  /** Gefährliche Aktion: Standardfokus auf „Abbrechen“, die Bestätigung ist rot. */
  danger?: boolean;
}

/**
 * Frage mit zwei Optionen. Der Fokus liegt zuerst auf der sicheren Option (bei `danger` „Abbrechen“, sonst
 * „Bestätigen“). ←→↑↓ wechseln, ✕ / Enter führt die fokussierte Option aus, ○ / Esc bricht immer ab.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Bestätigen",
  cancelLabel = "Abbrechen",
  onConfirm,
  onCancel,
  danger = false,
  active = true,
  frame = true,
  align,
  dim,
}: ConfirmDialogProps) {
  const uid = useId();
  useFrameClaim();
  const [index, setIndex] = useState(danger ? 1 : 0);
  const indexRef = useRef(index);
  const cb = useRef({ onConfirm, onCancel });
  cb.current = { onConfirm, onCancel };

  const choices: Choice[] = [
    { id: "confirm", label: confirmLabel, danger },
    { id: "cancel", label: cancelLabel },
  ];

  const pick = (i: number) => {
    if (i === 0) {
      playSfx("confirm");
      cb.current.onConfirm();
    } else {
      playSfx("back");
      cb.current.onCancel();
    }
  };
  const move = (i: number) => {
    if (i === indexRef.current) return;
    indexRef.current = i;
    setIndex(i);
    playSfx("move");
  };

  useOverlayInput({
    active,
    onAction: (action: PadAction) => {
      switch (action) {
        case "left":
          return move(0);
        case "right":
          return move(1);
        case "up":
        case "down":
          return move(indexRef.current === 0 ? 1 : 0);
        case "confirm":
          return pick(indexRef.current);
        case "back":
          return pick(1);
        default:
          return;
      }
    },
  });

  const hints: PopupHint[] = [
    { symbol: "cross", label: "Auswählen" },
    { symbol: "circle", label: cancelLabel },
  ];

  return (
    <MaybeFrame frame={frame} align={align} dim={dim} onBack={() => cb.current.onCancel()} active={active}>
      <section
        className={`pop-panel pop-dialog pop-dialog--confirm${active ? "" : " is-inactive"}`}
        role={danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-msg`}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 id={`${uid}-title`} className="pop-title">
              {title}
            </h2>
          </div>
        </header>
        <div id={`${uid}-msg`} className="pop-message">
          <Paragraphs text={message} />
        </div>
        <Choices choices={choices} index={index} onPick={(i) => {
            move(i);
            pick(i);
          }} active={active} />
        <HintBar
          hints={hints}
          onHint={(a) => {
            if (!active) return;
            if (a === "confirm") pick(indexRef.current);
            else if (a === "back") pick(1);
          }}
        />
      </section>
    </MaybeFrame>
  );
}

/* ------------------------------------------------------------------ MessageDialog */

export interface MessageDialogProps extends DialogBase {
  title: string;
  lines: readonly string[];
  okLabel?: string;
  onClose: () => void;
  kind?: "info" | "error" | "success";
  /** Monospace-Block unter dem Text, z. B. Protokollzeilen; ↑↓ / L1 R1 blättern darin. */
  detail?: readonly string[];
  /** Wo der Block beginnt. Standard: bei Fehlern am Ende (dort steht meist die Ursache), sonst am Anfang. */
  detailStart?: "top" | "bottom";
}

/**
 * Meldung mit einer Option („OK“). ✕, ○, Enter und Esc schließen. Fehler werden als role="alert" ausgegeben,
 * sodass Screenreader sie sofort vorlesen.
 */
export function MessageDialog({
  title,
  lines,
  okLabel = "OK",
  onClose,
  kind = "info",
  detail,
  detailStart,
  active = true,
  frame = true,
  align,
  dim,
}: MessageDialogProps) {
  const uid = useId();
  useFrameClaim();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const detailRef = useRef<HTMLPreElement>(null);

  const close = (sound: "confirm" | "back") => {
    playSfx(sound);
    onCloseRef.current();
  };

  const scrollDetail = (dir: 1 | -1, pageWise: boolean) => {
    const el = detailRef.current;
    if (!el) return;
    const unit = pageWise ? el.clientHeight * 0.85 : (parseFloat(getComputedStyle(el).lineHeight) || 20) * 3;
    el.scrollBy({ top: dir * unit, behavior: "smooth" });
  };

  useOverlayInput({
    active,
    onAction: (action: PadAction) => {
      switch (action) {
        case "confirm":
          return close("confirm");
        case "back":
          return close("back");
        case "up":
          return scrollDetail(-1, false);
        case "down":
          return scrollDetail(1, false);
        case "l1":
          return scrollDetail(-1, true);
        case "r1":
          return scrollDetail(1, true);
        default:
          return;
      }
    },
  });

  // Fehlerprotokolle enden meist mit der Ursache: dort beginnen.
  const startAtBottom = (detailStart ?? (kind === "error" ? "bottom" : "top")) === "bottom";
  const hasDetail = !!detail && detail.length > 0;
  useLayoutEffect(() => {
    const el = detailRef.current;
    if (el) el.scrollTop = startAtBottom ? el.scrollHeight : 0;
  }, [hasDetail, startAtBottom, detail?.length]);

  const hints: PopupHint[] = [{ symbol: "cross", label: okLabel }];

  return (
    <MaybeFrame frame={frame} align={align} dim={dim} onBack={() => onCloseRef.current()} active={active}>
      <section
        className={`pop-panel pop-dialog pop-dialog--message is-${kind}${active ? "" : " is-inactive"}`}
        role={kind === "error" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-msg`}
      >
        <header className="pop-head">
          <KindIcon kind={kind} />
          <div className="pop-head__text">
            <h2 id={`${uid}-title`} className="pop-title">
              {title}
            </h2>
          </div>
        </header>
        <div className="pop-dialog__body">
          <div id={`${uid}-msg`} className="pop-message" role={kind === "error" ? "alert" : undefined}>
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
        <Choices choices={[{ id: "ok", label: okLabel }]} index={0} onPick={() => close("confirm")} active={active} />
        <HintBar hints={hints} onHint={(a) => active && (a === "confirm" || a === "back") && close("confirm")} />
      </section>
    </MaybeFrame>
  );
}

/* ------------------------------------------------------------------ ProgressDialog */

export interface ProgressDialogProps extends DialogBase {
  title: string;
  /** Aktuelle Tätigkeit, eine Zeile. */
  status: string;
  /** Protokoll; angezeigt werden die letzten Zeilen. */
  lines?: readonly string[];
  /** 0..1 = Balken mit Prozent, null = Balken ohne Fortschrittsangabe (läuft), undefined = kein Balken. */
  progress?: number | null;
  /** Ohne diese Funktion lässt sich der Dialog nicht abbrechen (und es gibt keinen ○-Hinweis). */
  onCancel?: () => void;
  cancelLabel?: string;
}

/** So viele Protokollzeilen bleiben sichtbar. */
const LOG_LINES = 8;

/**
 * Fortschrittsdialog: Ladeanzeige aus Punkten, Statuszeile, optional Balken und mitlaufendes Protokoll.
 * Eingabe gibt es nur mit `onCancel` (○ / Esc); sonst bleibt der Dialog reine Anzeige.
 */
export function ProgressDialog({
  title,
  status,
  lines,
  progress,
  onCancel,
  cancelLabel = "Abbrechen",
  active = true,
  frame = true,
  align,
  dim,
}: ProgressDialogProps) {
  const uid = useId();
  useFrameClaim();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  const cancel = () => {
    if (!cancelRef.current) return;
    playSfx("back");
    cancelRef.current();
  };

  useOverlayInput({
    active: active && !!onCancel,
    onAction: (action: PadAction) => {
      if (action === "back") cancel();
    },
  });

  // Neue Zeilen schieben das Protokoll sanft nach oben statt zu springen.
  const logRef = useRef<HTMLUListElement>(null);
  const previous = useRef(lines?.length ?? 0);
  const count = lines?.length ?? 0;
  useLayoutEffect(() => {
    const list = logRef.current;
    const added = count - previous.current;
    previous.current = count;
    if (!list || added <= 0 || typeof list.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const last = list.lastElementChild as HTMLElement | null;
    if (!last) return;
    const shift = Math.min(added, LOG_LINES) * last.offsetHeight;
    list.animate([{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], {
      duration: 260,
      easing: "cubic-bezier(0.3, 1.08, 0.4, 1)",
    });
  }, [count]);

  const shown = lines ? lines.slice(-LOG_LINES) : [];
  const firstShown = count - shown.length;
  const determinate = typeof progress === "number";
  const value = determinate ? clamp01(progress) : 0;
  const percent = Math.round(value * 100);

  return (
    <MaybeFrame frame={frame} align={align} dim={dim} onBack={cancelRef.current ? cancel : undefined} active={active}>
      <section
        className={`pop-panel pop-dialog pop-dialog--progress${active ? "" : " is-inactive"}`}
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-status`}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 id={`${uid}-title`} className="pop-title">
              {title}
            </h2>
          </div>
        </header>
        <div className="pop-dialog__body">
          <div className="pop-prog">
            <DotSpinner size="4.6rem" className="pop-prog__spinner" />
            <div className="pop-prog__main">
              <p id={`${uid}-status`} className="pop-status" role="status">
                {status}
              </p>
              {progress !== undefined && (
                <div className="pop-meter">
                  <div
                    className={`pop-meter__track${determinate ? "" : " is-indeterminate"}`}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={determinate ? percent : undefined}
                  >
                    <i style={determinate ? { transform: `scaleX(${value})` } : undefined} />
                  </div>
                  <span className="pop-meter__value">{determinate ? `${percent} %` : ""}</span>
                </div>
              )}
            </div>
          </div>
          {lines !== undefined && (
            <div className="pop-log" aria-label="Protokoll" role="log">
              <ul ref={logRef}>
                {shown.map((line, i) => (
                  <li key={firstShown + i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {onCancel && (
          <HintBar
            hints={[{ symbol: "circle", label: cancelLabel }]}
            onHint={(a) => active && a === "back" && cancel()}
          />
        )}
        {!onCancel && <div className="pop-hints-spacer" aria-hidden="true" />}
      </section>
    </MaybeFrame>
  );
}
