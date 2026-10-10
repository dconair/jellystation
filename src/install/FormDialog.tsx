import { useEffect, useRef, useState } from "react";
import { OverlayFrame, useOverlayInput } from "../ui/popup";
import { playSfx } from "../xmb/sound";
import "../web/web.css";

export interface FormField {
  key: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  /** Anfangswert */
  value?: string;
}

export interface FormDialogProps {
  title: string;
  subtitle?: string;
  fields: readonly FormField[];
  /** Kleingedruckter Hinweis unter den Feldern. */
  note?: string;
  submitLabel?: string;
  /** Gibt einen Fehlertext zurück (und blockiert das Absenden) oder null. */
  validate?: (values: Record<string, string>) => string | null;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe (liegt ein anderes Overlay darüber). */
  active?: boolean;
}

/** Kleines Formular mit Textfeldern im Stil des Lesezeichen-Dialogs (Tastatur; ○ / Esc bricht ab, Enter sendet ab). */
export function FormDialog({ title, subtitle, fields, note, submitLabel = "Speichern", validate, onSubmit, onClose, active = true }: FormDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value ?? ""])));
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);
  useOverlayInput({ active, onAction: (a) => a === "back" && onClose() });

  const submit = () => {
    const problem = validate?.(values) ?? null;
    if (problem) {
      setError(problem);
      playSfx("error");
      return;
    }
    playSfx("confirm");
    onSubmit(values);
  };

  return (
    <OverlayFrame onBack={onClose} keyboard={false}>
      <form
        className="pop-panel pop-panel--normal web-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 className="pop-title">{title}</h2>
            {subtitle && <p className="pop-subtitle">{subtitle}</p>}
          </div>
        </header>
        <div className="web-form__body">
          {fields.map((f, i) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                ref={i === 0 ? first : undefined}
                value={values[f.key] ?? ""}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  setError(null);
                }}
                placeholder={f.placeholder}
                maxLength={f.maxLength}
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
          ))}
          {error && (
            <p className="web-form__error" role="alert">
              {error}
            </p>
          )}
          {note && <p className="web-form__note">{note}</p>}
        </div>
        <footer className="web-form__actions">
          <button type="button" className="web-btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="web-btn web-btn--primary">
            {submitLabel}
          </button>
        </footer>
      </form>
    </OverlayFrame>
  );
}
