import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, OverlayFrame, PopupList, useOverlayInput } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { playSfx } from "../xmb/sound";
import "../web/web.css";
import { fetchManifest, normalizeAddonUrl } from "./api";
import { forgetManifest } from "./manifests";
import type { StremioAddonCfg } from "./types";

/** Offizieller Katalog-Dienst von Stremio: liefert Kataloge und Infos, aber keine Streams – nur als Beispiel zum Ausprobieren. */
export const CINEMETA_URL = "https://v3-cinemeta.strem.io/manifest.json";

const ADD = "__add";
const EXAMPLE = "__cinemeta";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const newId = () => Math.random().toString(36).slice(2, 10);

export interface StremioAddonsDialogProps {
  addons: readonly StremioAddonCfg[];
  onChange: (addons: StremioAddonCfg[]) => void;
  onClose: () => void;
}

/**
 * Einstellungen → Stremio-Addons: Liste der eingetragenen Addons. ✕ auf „Addon hinzufügen“ öffnet das Formular,
 * △ entfernt das fokussierte Addon (nach Rückfrage). Die App bringt keine Addons mit.
 */
export function StremioAddonsDialog({ addons, onChange, onClose }: StremioAddonsDialogProps) {
  const [view, setView] = useState<{ kind: "list" } | { kind: "add"; url?: string } | { kind: "remove"; id: string }>({ kind: "list" });
  const [focusId, setFocusId] = useState<string | null>(null);

  const hasCinemeta = addons.some((a) => a.url === CINEMETA_URL);
  const items: PopupItem[] = [
    ...addons.map((a) => ({ id: a.id, label: a.name, detail: hostOf(a.url), status: "ok" as const })),
    { id: ADD, label: "Addon hinzufügen …", detail: "Adresse der manifest.json oder stremio://-Link einfügen" },
    ...(hasCinemeta ? [] : [{ id: EXAMPLE, label: "Beispiel: Cinemeta hinzufügen", detail: "Offizieller Katalog (Beliebt, Neu) – ohne Streams, also nur zum Stöbern" }]),
  ];

  if (view.kind === "add") {
    return (
      <AddForm
        initialUrl={view.url}
        existing={addons}
        onClose={() => setView({ kind: "list" })}
        onAdd={(addon) => {
          onChange([...addons, addon]);
          setFocusId(addon.id);
          setView({ kind: "list" });
        }}
      />
    );
  }

  const removing = view.kind === "remove" ? addons.find((a) => a.id === view.id) : undefined;
  return (
    <>
      <PopupList
        title="Stremio-Addons"
        subtitle={addons.length ? `${addons.length} eingetragen` : "Noch keine Addons"}
        width="normal"
        items={items}
        focusId={focusId}
        active={!removing}
        footer={{
          text: "Eigene Addons bringst du selbst mit. Streams spielt die App nur ab, wenn sie eine direkte Adresse liefern (kein Torrent). Nutze nur Inhalte, die du legal ansehen darfst.",
          kind: "info",
        }}
        onSelect={(id) => {
          if (id === ADD) setView({ kind: "add" });
          else if (id === EXAMPLE) setView({ kind: "add", url: CINEMETA_URL });
        }}
        onAlt={(id) => id && addons.some((a) => a.id === id) && setView({ kind: "remove", id })}
        altLabel="Entfernen"
        onBack={onClose}
      />
      {removing && (
        <ConfirmDialog
          title="Addon entfernen?"
          message={`„${removing.name}“ (${hostOf(removing.url)}) wird aus der Liste gelöscht. Die zugehörigen Titel verschwinden aus dem Menü.`}
          confirmLabel="Entfernen"
          danger
          onCancel={() => setView({ kind: "list" })}
          onConfirm={() => {
            forgetManifest(removing.url);
            onChange(addons.filter((a) => a.id !== removing.id));
            setView({ kind: "list" });
          }}
        />
      )}
    </>
  );
}

function AddForm({
  initialUrl,
  existing,
  onAdd,
  onClose,
}: {
  initialUrl?: string;
  existing: readonly StremioAddonCfg[];
  onAdd: (addon: StremioAddonCfg) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(initialUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    ref.current?.focus();
    return () => abort.current?.abort();
  }, []);
  useOverlayInput({ active: true, onAction: (a) => a === "back" && onClose() });

  const fail = (text: string) => {
    setError(text);
    setBusy(false);
    playSfx("error");
    ref.current?.focus();
  };

  const save = async () => {
    if (busy) return;
    const url = normalizeAddonUrl(address);
    if (!url) return fail("Bitte eine gültige Adresse eintragen (z. B. https://…/manifest.json)");
    if (existing.some((a) => a.url === url)) return fail("Dieses Addon ist schon eingetragen");
    setError(null);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const manifest = await fetchManifest(url, ctl.signal);
      if (ctl.signal.aborted) return;
      playSfx("confirm");
      onAdd({ id: newId(), url, name: manifest.name.slice(0, 80) });
    } catch (err) {
      if (ctl.signal.aborted) return;
      fail(err instanceof Error ? err.message : "Addon nicht erreichbar");
    }
  };

  return (
    <OverlayFrame onBack={onClose} keyboard={false}>
      <form
        className="pop-panel pop-panel--normal web-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 className="pop-title">Stremio-Addon hinzufügen</h2>
            <p className="pop-subtitle">Die App prüft die Adresse, bevor sie gespeichert wird</p>
          </div>
        </header>
        <div className="web-form__body">
          <label>
            <span>Adresse des Addons</span>
            <input
              ref={ref}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError(null);
              }}
              placeholder="https://…/manifest.json"
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          {error && (
            <p className="web-form__error" role="alert">
              {error}
            </p>
          )}
          <p className="web-form__note">
            Trage nur Addons ein, deren Inhalte du legal nutzen darfst. JellyStation bringt keine Addons mit und empfiehlt keine.
          </p>
        </div>
        <footer className="web-form__actions">
          <button type="button" className="web-btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="web-btn web-btn--primary" disabled={busy}>
            {busy ? "Prüfe …" : "Prüfen und speichern"}
          </button>
        </footer>
      </form>
    </OverlayFrame>
  );
}
