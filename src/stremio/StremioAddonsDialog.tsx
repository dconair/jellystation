import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, OverlayFrame, PopupList, useOverlayInput } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { playSfx } from "../xmb/sound";
import "../web/web.css";
import { fetchAccountAddons, stremioLogin, stremioLogout } from "./account";
import { mergeAccountAddons, newAddonId } from "./addons";
import { fetchManifest, normalizeAddonUrl } from "./api";
import { forgetManifest } from "./manifests";
import type { StremioAddonCfg, StremioSettings } from "./types";

const ADD = "__add";
const ACCOUNT = "__account";
const LOGOUT = "__logout";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const newId = newAddonId;

export interface StremioAddonsDialogProps {
  stremio: StremioSettings | undefined;
  /** undefined = weder Konto noch Addons (die Stremio-Spalten verschwinden). */
  onChange: (next: StremioSettings | undefined) => void;
  onClose: () => void;
}

const keep = (addons: StremioAddonCfg[], account: StremioSettings["account"]): StremioSettings | undefined =>
  addons.length || account ? { addons, ...(account ? { account } : {}) } : undefined;

/**
 * Einstellungen → Stremio-Addons: Anmeldung mit dem Stremio-Konto (lädt dessen Addons) und die Liste der Addons.
 * ✕ auf „Addon hinzufügen“ öffnet das Formular, △ entfernt das fokussierte von Hand eingetragene Addon (nach Rückfrage).
 * Die App bringt keine Addons mit.
 */
export function StremioAddonsDialog({ stremio, onChange, onClose }: StremioAddonsDialogProps) {
  const addons = stremio?.addons ?? [];
  const account = stremio?.account;
  const [view, setView] = useState<{ kind: "list" } | { kind: "add" } | { kind: "login" } | { kind: "remove"; id: string } | { kind: "logout" }>({ kind: "list" });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; kind: "info" | "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const refresh = async () => {
    if (!account || busy) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setNote({ text: "Lade die Addons deines Kontos …", kind: "info" });
    try {
      const list = await fetchAccountAddons(account.authKey, ctl.signal);
      if (ctl.signal.aborted) return;
      onChange(keep(mergeAccountAddons(addons, list), account));
      setNote({ text: `${list.length} Addon${list.length === 1 ? "" : "s"} aus dem Konto geladen`, kind: "ok" });
    } catch (err) {
      if (ctl.signal.aborted) return;
      playSfx("error");
      setNote({ text: err instanceof Error ? err.message : "Konto nicht erreichbar", kind: "error" });
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  };

  const items: PopupItem[] = [
    account
      ? { id: ACCOUNT, label: `Stremio-Konto: ${account.email}`, detail: "Addons aus dem Konto neu laden", status: busy ? "busy" : "ok" }
      : { id: ACCOUNT, label: "Mit Stremio-Konto anmelden …", detail: "Lädt deine Addons (und Cinemeta-Kataloge) wie in Stremio – das Passwort wird nicht gespeichert" },
    ...(account ? [{ id: LOGOUT, label: "Abmelden", detail: "Entfernt das Konto und seine Addons aus der App" }] : []),
    ...addons.map((a) => ({ id: a.id, label: a.name, detail: hostOf(a.url), trailing: a.fromAccount ? "Konto" : undefined, status: "ok" as const })),
    { id: ADD, label: "Addon hinzufügen …", detail: "Adresse der manifest.json oder stremio://-Link einfügen" },
  ];

  if (view.kind === "login") {
    return (
      <LoginForm
        onClose={() => setView({ kind: "list" })}
        onLogin={(acc, list) => {
          onChange(keep(mergeAccountAddons(addons, list), acc));
          setFocusId(ACCOUNT);
          setNote({ text: `Angemeldet – ${list.length} Addon${list.length === 1 ? "" : "s"} aus dem Konto geladen`, kind: "ok" });
          setView({ kind: "list" });
        }}
      />
    );
  }

  if (view.kind === "add") {
    return (
      <AddForm
        existing={addons}
        onClose={() => setView({ kind: "list" })}
        onAdd={(addon) => {
          onChange(keep([...addons, addon], account));
          setFocusId(addon.id);
          setNote(null);
          setView({ kind: "list" });
        }}
      />
    );
  }

  const removing = view.kind === "remove" ? addons.find((a) => a.id === view.id) : undefined;
  const modal = removing || view.kind === "logout";
  return (
    <>
      <PopupList
        title="Stremio"
        subtitle={account ? `${addons.length} Addon${addons.length === 1 ? "" : "s"} · ${account.email}` : addons.length ? `${addons.length} eingetragen` : "Noch nichts eingerichtet"}
        width="normal"
        items={items}
        focusId={focusId}
        active={!modal}
        busy={busy}
        footer={
          note
            ? { text: note.text, kind: note.kind }
            : {
                text: "Streams spielt die App nur ab, wenn sie eine direkte Adresse liefern (kein Torrent). Nutze nur Inhalte, die du legal ansehen darfst.",
                kind: "info",
              }
        }
        onSelect={(id) => {
          if (id === ADD) setView({ kind: "add" });
          else if (id === ACCOUNT) account ? void refresh() : setView({ kind: "login" });
          else if (id === LOGOUT) setView({ kind: "logout" });
        }}
        onAlt={(id) => {
          const addon = addons.find((a) => a.id === id);
          if (!addon) return;
          if (addon.fromAccount) setNote({ text: "Addons aus dem Konto verwaltest du in Stremio selbst – hier werden sie beim Neuladen übernommen.", kind: "info" });
          else setView({ kind: "remove", id: addon.id });
        }}
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
            onChange(keep(addons.filter((a) => a.id !== removing.id), account));
            setView({ kind: "list" });
          }}
        />
      )}
      {view.kind === "logout" && account && (
        <ConfirmDialog
          title="Abmelden?"
          message={`Das Stremio-Konto ${account.email} und seine Addons werden aus der App entfernt. Von Hand eingetragene Addons bleiben.`}
          confirmLabel="Abmelden"
          danger
          onCancel={() => setView({ kind: "list" })}
          onConfirm={() => {
            void stremioLogout(account.authKey);
            onChange(keep(addons.filter((a) => !a.fromAccount), undefined));
            setNote(null);
            setFocusId(ACCOUNT);
            setView({ kind: "list" });
          }}
        />
      )}
    </>
  );
}

function LoginForm({ onLogin, onClose }: { onLogin: (account: NonNullable<StremioSettings["account"]>, addons: Awaited<ReturnType<typeof fetchAccountAddons>>) => void; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    ref.current?.focus();
    return () => abort.current?.abort();
  }, []);
  useOverlayInput({ active: true, onAction: (a) => a === "back" && onClose() });

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Bitte E-Mail-Adresse und Passwort eintragen");
      playSfx("error");
      return;
    }
    setError(null);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const account = await stremioLogin(email.trim(), password, ctl.signal);
      const addons = await fetchAccountAddons(account.authKey, ctl.signal);
      if (ctl.signal.aborted) return;
      playSfx("confirm");
      onLogin(account, addons);
    } catch (err) {
      if (ctl.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Stremio nicht erreichbar");
      setBusy(false);
      playSfx("error");
    }
  };

  return (
    <OverlayFrame onBack={onClose} keyboard={false}>
      <form
        className="pop-panel pop-panel--normal web-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header className="pop-head">
          <div className="pop-head__text">
            <h2 className="pop-title">Bei Stremio anmelden</h2>
            <p className="pop-subtitle">Die Addons deines Kontos werden übernommen</p>
          </div>
        </header>
        <div className="web-form__body">
          <label>
            <span>E-Mail-Adresse</span>
            <input
              ref={ref}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <label>
            <span>Passwort</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          {error && (
            <p className="web-form__error" role="alert">
              {error}
            </p>
          )}
          <p className="web-form__note">
            Das Passwort geht nur an Stremio (api.strem.io) und wird nicht gespeichert – die App merkt sich nur den Anmeldeschlüssel. Mit Google/Facebook
            angemeldet? Lege in Stremio unter „Konto“ ein Passwort fest.
          </p>
        </div>
        <footer className="web-form__actions">
          <button type="button" className="web-btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="web-btn web-btn--primary" disabled={busy}>
            {busy ? "Melde an …" : "Anmelden"}
          </button>
        </footer>
      </form>
    </OverlayFrame>
  );
}

function AddForm({
  existing,
  onAdd,
  onClose,
}: {
  existing: readonly StremioAddonCfg[];
  onAdd: (addon: StremioAddonCfg) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState("");
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
