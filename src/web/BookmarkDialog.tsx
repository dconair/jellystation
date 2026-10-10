import { useEffect, useRef, useState } from "react";
import { OverlayFrame, useOverlayInput } from "../ui/popup";
import { playSfx } from "../xmb/sound";
import { normalizeWebUrl } from "./webApi";
import "./web.css";

export interface BookmarkDialogProps {
  onSave: (name: string, url: string) => void;
  onClose: () => void;
}

/** Neues Lesezeichen: Name und Adresse (Tastatur; ○ / Esc bricht ab, Enter im letzten Feld speichert). */
export function BookmarkDialog({ onSave, onClose }: BookmarkDialogProps) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);
  useOverlayInput({ active: true, onAction: (a) => a === "back" && onClose() });

  const save = () => {
    const url = normalizeWebUrl(address);
    if (!url) {
      setError("Bitte eine gültige Adresse eintragen (z. B. https://archive.org)");
      playSfx("error");
      urlRef.current?.focus();
      return;
    }
    const title = name.trim() || new URL(url).hostname.replace(/^www\./, "");
    playSfx("confirm");
    onSave(title.slice(0, 60), url);
  };

  return (
    <OverlayFrame onBack={onClose} keyboard={false}>
      <form
        className="pop-panel pop-panel--normal web-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 className="pop-title">Lesezeichen hinzufügen</h2>
            <p className="pop-subtitle">Die Seite öffnet in einem eigenen Fenster der App</p>
          </div>
        </header>
        <div className="web-form__body">
          <label>
            <span>Name</span>
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Meine Spiele-Seite" maxLength={60} spellCheck={false} />
          </label>
          <label>
            <span>Adresse</span>
            <input
              ref={urlRef}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError(null);
              }}
              placeholder="https://…"
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          {error && <p className="web-form__error" role="alert">{error}</p>}
          <p className="web-form__note">Lade nur Spiele, die du besitzt oder legal beziehen darfst (eigene Sicherungen, Homebrew, gemeinfreie Titel).</p>
        </div>
        <footer className="web-form__actions">
          <button type="button" className="web-btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="web-btn web-btn--primary">
            Speichern
          </button>
        </footer>
      </form>
    </OverlayFrame>
  );
}
