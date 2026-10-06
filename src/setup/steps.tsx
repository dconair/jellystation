import { useEffect, useState } from "react";
import { EMULATORS, GAMES_BASE_DIR } from "../config/games";
import { isValidServerUrl, normalizeServerUrl } from "../jellyfin/testConnection";
import type { ConnectionResult } from "../jellyfin/testConnection";
import { pickGameFiles, scanGamesDir } from "../library/scanGames";
import { isTauri } from "../platform";
import { CategoryIcon } from "../xmb/CategoryIcon";
import { CHECKS } from "./checks";
import type { CheckResult } from "./checks";

export interface Draft {
  url: string;
  apiKey: string;
  gamesDir: string;
}

/* ---------- Schritt 1: Jellyfin ---------- */

interface JellyfinStepProps {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  test: { busy: boolean; result: ConnectionResult | null };
  onTest: () => void;
}

export function JellyfinStep({ draft, onChange, test, onTest }: JellyfinStepProps) {
  const [showKey, setShowKey] = useState(false);
  const urlOk = isValidServerUrl(draft.url);
  return (
    <>
      <h2>Jellyfin-Server verbinden</h2>
      <p className="setup-lead">
        Adresse und API-Schlüssel deines Servers. Den Schlüssel erzeugst du in Jellyfin unter
        <em> Dashboard → API-Schlüssel</em>.
      </p>

      <label className="setup-field">
        <span>Server-URL</span>
        <input
          type="text"
          inputMode="url"
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          placeholder="http://192.168.1.20:8096"
          value={draft.url}
          onChange={(e) => onChange({ url: e.target.value })}
          onBlur={() => draft.url && onChange({ url: normalizeServerUrl(draft.url) })}
        />
      </label>

      <label className="setup-field">
        <span>API-Key</span>
        <div className="setup-input-row">
          <input
            type={showKey ? "text" : "password"}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder="32-stelliger Schlüssel"
            value={draft.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
          />
          <button type="button" className="ps-btn ps-btn--ghost" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "Verbergen" : "Anzeigen"}
          </button>
        </div>
      </label>

      <div className="setup-test">
        <button
          type="button"
          className="ps-btn"
          disabled={!urlOk || test.busy}
          onClick={onTest}
        >
          {test.busy ? "Teste …" : "Verbindung testen"}
        </button>
        {test.result && (
          <span className={`setup-result is-${test.result.status}`} role="status">
            {test.result.message}
          </span>
        )}
      </div>
    </>
  );
}

/* ---------- Schritt 2: Spiele-Pfade & Emulatoren ---------- */

interface GamesStepProps {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}

export function GamesStep({ draft, onChange }: GamesStepProps) {
  const tauri = isTauri();
  const [preview, setPreview] = useState<string>("");

  const choose = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        recursive: true, // gibt den Ordner samt Unterordnern für das Auslesen frei
        title: "Basisordner mit deinen Spielen wählen",
        defaultPath: draft.gamesDir || undefined,
      });
      if (typeof picked === "string") onChange({ gamesDir: picked });
    } catch (err) {
      setPreview(`Dialog konnte nicht geöffnet werden: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Vorschau: welche Systeme liegen im gewählten Ordner?
  useEffect(() => {
    if (!tauri || !draft.gamesDir) {
      setPreview("");
      return;
    }
    let cancelled = false;
    scanGamesDir(draft.gamesDir)
      .then(({ listing }) => {
        if (cancelled) return;
        const found = Object.entries(listing)
          .map(([sys, files]) => [sys, pickGameFiles(files).length] as const)
          .filter(([, n]) => n > 0)
          .map(([sys, n]) => `${sys} (${n})`);
        setPreview(found.length ? `Gefunden: ${found.join(", ")}` : "Noch keine Spiele in Unterordnern gefunden");
      })
      .catch((err) => !cancelled && setPreview(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [tauri, draft.gamesDir]);

  return (
    <>
      <h2>Spiele &amp; Emulatoren</h2>
      <p className="setup-lead">
        Wähle den Ordner, in dem pro System ein Unterordner liegt. Jeder Unterordner wird zu einer
        eigenen Kategorie im Menü.
      </p>

      <div className="setup-field">
        <span>Basisordner</span>
        <div className="setup-input-row">
          <input
            type="text"
            spellCheck={false}
            readOnly={tauri}
            placeholder={GAMES_BASE_DIR}
            value={draft.gamesDir}
            onChange={(e) => onChange({ gamesDir: e.target.value })}
          />
          <button type="button" className="ps-btn" disabled={!tauri} onClick={choose}>
            Ordner wählen …
          </button>
        </div>
        {!tauri && <small>Der native Ordnerdialog ist nur in der Desktop-App verfügbar.</small>}
      </div>

      {preview && <p className="setup-preview">{preview}</p>}

      <pre className="setup-tree" aria-label="Beispiel für die Ordnerstruktur">{`Spiele/
├─ PS3/   Gran Turismo 5.iso · Demon's Souls.pkg
├─ PS2/   …
└─ PS1/   …`}</pre>
      <p className="setup-note">
        Emulatoren werden unter ihrem Standardpfad erwartet:{" "}
        {Object.values(EMULATORS).map((e) => `${e.name} → ${e.binary}`).join(", ")}
      </p>
    </>
  );
}

/* ---------- Schritt 3: Controller ---------- */

export function ControllerStep({ name, pressed }: { name: string | null; pressed: boolean }) {
  const state = pressed ? "pressed" : name ? "connected" : "idle";
  return (
    <>
      <h2>Controller verbinden</h2>
      <p className="setup-lead">
        Verbinde deinen DualShock 4 per USB-Kabel oder Bluetooth (<kbd>PS</kbd> + <kbd>SHARE</kbd> gedrückt
        halten, bis die Leuchtleiste blinkt) und drücke dann eine beliebige Taste.
      </p>
      <div className={`pad-orb is-${state}`} aria-live="polite">
        <div className="pad-orb__ring" />
        <CategoryIcon name="games" />
      </div>
      <p className={`setup-result pad-status is-${pressed ? "ok" : name ? "warn" : "idle"}`}>
        {pressed
          ? `${name ?? "Controller"} funktioniert ✓`
          : name
            ? `${name} erkannt – drücke jetzt eine Taste`
            : "Warte auf Controller …"}
      </p>
      <p className="setup-note">Ein Controller ist optional – du kannst diesen Schritt überspringen.</p>
    </>
  );
}

/* ---------- Schritt 4: Abhängigkeiten ---------- */

const symbol: Record<CheckResult["status"], string> = {
  pending: "·",
  running: "",
  ok: "✓",
  warn: "!",
  fail: "✕",
};

export function CheckStep({ results }: { results: CheckResult[] }) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return (
    <>
      <h2>Alles bereit?</h2>
      <p className="setup-lead">Ich prüfe, ob alles für einen reibungslosen Betrieb vorhanden ist.</p>
      <ul className="setup-checks">
        {CHECKS.map((def) => {
          const r = byId.get(def.id) ?? { id: def.id, label: def.label, status: "pending", detail: "" };
          return (
            <li key={def.id} className={`is-${r.status}`}>
              <span className="check-icon" aria-hidden="true">
                {r.status === "running" ? <i className="spinner" /> : symbol[r.status]}
              </span>
              <span className="check-text">
                <strong>{r.label}</strong>
                <small>{r.detail}</small>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
