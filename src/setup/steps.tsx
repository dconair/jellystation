import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { GAMES_BASE_DIR } from "../config/games";
import { openExternal } from "../emulators/actions";
import { EMULATORS, supportedFolderNames } from "../emulators/catalog";
import { DEFAULT_BIOS_DIR, describeRequirement, installRequirement, missingLabels, requirementsFor } from "../emulators/requirements";
import type { RequirementStatus } from "../emulators/requirements";
import type { EmulatorsState } from "../emulators/useEmulators";
import type { RequirementsState } from "../emulators/useRequirements";
import { discoverServers } from "../jellyfin/discover";
import type { FoundServer } from "../jellyfin/discover";
import { normalizeServerUrl } from "../jellyfin/testConnection";
import type { ConnectionResult } from "../jellyfin/testConnection";
import { countBySystem, scanGamesDir } from "../library/scanGames";
import { fetchAccountAddons, stremioLogin, stremioLogout } from "../stremio/account";
import { mergeAccountAddons, newAddonId } from "../stremio/addons";
import { fetchManifest, normalizeAddonUrl } from "../stremio/api";
import type { StremioSettings } from "../stremio/types";
import { isTauri } from "../platform";
import { CHECKS } from "./checks";
import type { CheckResult } from "./checks";

export interface Draft {
  url: string;
  /** Zweite Adresse für unterwegs (leer = keine). */
  altUrl: string;
  apiKey: string;
  gamesDir: string;
  /** BIOS-/Firmware-Ordner; leer = Standard (~/JellyStation/BIOS). */
  biosDir: string;
  /** Stremio-Konto und -Addons (leer = nicht eingerichtet). */
  stremio?: StremioSettings;
}

/* ---------- Stremio ---------- */

type StatusLine = { state: "idle" | "busy" | "ok" | "fail"; text: string };

interface StremioStepProps {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}

/**
 * Optionaler Schritt: Stremio-Konto anmelden (lädt die Addons des Kontos, auch Cinemeta für die Kataloge) und/oder
 * ein Addon von Hand eintragen. Das Passwort geht nur an Stremio und wird nicht gespeichert.
 */
export function StremioStep({ draft, onChange }: StremioStepProps) {
  const stremio = draft.stremio;
  const account = stremio?.account;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [addonUrl, setAddonUrl] = useState("");
  const [login, setLogin] = useState<StatusLine>({ state: "idle", text: "" });
  const [add, setAdd] = useState<StatusLine>({ state: "idle", text: "" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const doLogin = async () => {
    if (login.state === "busy") return;
    if (!email.trim() || !password) return setLogin({ state: "fail", text: "Bitte E-Mail-Adresse und Passwort eintragen" });
    const ctl = new AbortController();
    abort.current = ctl;
    setLogin({ state: "busy", text: "Melde an …" });
    try {
      const acc = await stremioLogin(email.trim(), password, ctl.signal);
      const list = await fetchAccountAddons(acc.authKey, ctl.signal);
      if (ctl.signal.aborted) return;
      onChange({ stremio: { account: acc, addons: mergeAccountAddons(stremio?.addons ?? [], list) } });
      setPassword("");
      setLogin({ state: "ok", text: `Angemeldet – ${list.length} Addon${list.length === 1 ? "" : "s"} aus dem Konto geladen` });
    } catch (err) {
      if (ctl.signal.aborted) return;
      setLogin({ state: "fail", text: err instanceof Error ? err.message : "Stremio nicht erreichbar" });
    }
  };

  const doLogout = () => {
    if (!account) return;
    void stremioLogout(account.authKey);
    const addons = (stremio?.addons ?? []).filter((a) => !a.fromAccount);
    onChange({ stremio: addons.length ? { addons } : undefined });
    setLogin({ state: "idle", text: "" });
  };

  const doAdd = async () => {
    if (add.state === "busy") return;
    const url = normalizeAddonUrl(addonUrl);
    if (!url) return setAdd({ state: "fail", text: "Bitte eine gültige Adresse eintragen (https://…/manifest.json)" });
    if (stremio?.addons.some((a) => a.url === url)) return setAdd({ state: "fail", text: "Dieses Addon ist schon eingetragen" });
    const ctl = new AbortController();
    abort.current = ctl;
    setAdd({ state: "busy", text: "Prüfe …" });
    try {
      const manifest = await fetchManifest(url, ctl.signal);
      if (ctl.signal.aborted) return;
      onChange({ stremio: { ...(account ? { account } : {}), addons: [...(stremio?.addons ?? []), { id: newAddonId(), url, name: manifest.name.slice(0, 80) }] } });
      setAddonUrl("");
      setAdd({ state: "ok", text: `„${manifest.name}“ hinzugefügt` });
    } catch (err) {
      if (ctl.signal.aborted) return;
      setAdd({ state: "fail", text: err instanceof Error ? err.message : "Addon nicht erreichbar" });
    }
  };

  /** Enter im Feld führt die Aktion des Felds aus (statt den Schritt zu wechseln), sobald etwas eingetragen ist. */
  const enter = (ready: boolean, run: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !ready) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  const names = (stremio?.addons ?? []).map((a) => a.name);
  return (
    <>
      <h2>Stremio verbinden (optional)</h2>
      <p className="setup-lead">
        Mit deinem Stremio-Konto erscheinen Kataloge und Streams deiner Addons im Menü, Suche inklusive. Du kannst den Schritt überspringen und
        später unter <em>Einstellungen → Stremio</em> nachholen.
      </p>

      <div className="setup-form">
        {account ? (
          <div className="setup-field">
            <span>Konto</span>
            <div className="setup-input-row">
              <div className="setup-result is-ok" role="status">
                {account.email}
              </div>
              <button type="button" className="ps-btn" onClick={doLogout}>
                Abmelden
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="setup-field">
              <span>Stremio-E-Mail</span>
              <input
                type="email"
                inputMode="email"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="setup-field">
              <span>Passwort</span>
              <div className="setup-input-row">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={enter(!!email.trim() && !!password, () => void doLogin())}
                />
                <button type="button" className="ps-btn" disabled={login.state === "busy"} onClick={() => void doLogin()}>
                  Anmelden
                </button>
              </div>
            </label>
          </>
        )}
        {login.text && (
          <div className={`setup-result is-${login.state === "fail" ? "fail" : login.state}`} role="status">
            {login.text}
          </div>
        )}

        <label className="setup-field">
          <span>Addon von Hand hinzufügen (optional)</span>
          <div className="setup-input-row">
            <input
              type="text"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="https://…/manifest.json"
              value={addonUrl}
              onChange={(e) => setAddonUrl(e.target.value)}
              onKeyDown={enter(!!addonUrl.trim(), () => void doAdd())}
            />
            <button type="button" className="ps-btn" disabled={add.state === "busy"} onClick={() => void doAdd()}>
              Hinzufügen
            </button>
          </div>
        </label>
        {add.text && (
          <div className={`setup-result is-${add.state === "fail" ? "fail" : add.state}`} role="status">
            {add.text}
          </div>
        )}

        <div className={`setup-result is-${names.length ? "ok" : "idle"}`} role="status">
          {names.length ? `Eingerichtet: ${names.join(", ")}` : "Noch nichts eingerichtet"}
        </div>
      </div>
      <p className="setup-lead">Streams spielt die App nur ab, wenn sie direkte Links liefern (z. B. Addons mit Debrid-Dienst). Nutze nur Inhalte, die du legal ansehen darfst.</p>
    </>
  );
}

/* ---------- Schritt 1: Jellyfin ---------- */

interface JellyfinStepProps {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  test: { busy: boolean; result: ConnectionResult | null };
  /** Der Test wird über die Tastenhinweis-Leiste (□) ausgelöst; hier nur aus Kompatibilitätsgründen. */
  onTest?: () => void;
}

export function JellyfinStep({ draft, onChange, test }: JellyfinStepProps) {
  const [showKey, setShowKey] = useState(false);
  const [search, setSearch] = useState<{ busy: boolean; found: FoundServer[]; done: boolean; error?: string }>({
    busy: false,
    found: [],
    done: false,
  });
  const searched = useRef(false);
  const draftUrl = useRef(draft.url);
  draftUrl.current = draft.url;
  const runSearch = async () => {
    setSearch({ busy: true, found: [], done: false });
    try {
      const found = await discoverServers();
      setSearch({ busy: false, found, done: true });
      // Genau ein Server und noch keine Adresse eingetragen: gleich übernehmen.
      if (found.length === 1 && !draftUrl.current.trim()) onChange({ url: found[0].address });
    } catch (err) {
      setSearch({ busy: false, found: [], done: true, error: err instanceof Error ? err.message : String(err) });
    }
  };
  // Einmal beim Öffnen suchen (nur in der Desktop-App).
  useEffect(() => {
    if (searched.current || !isTauri()) return;
    searched.current = true;
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Ergebnis, Hinweis oder Laufanzeige – immer genau eine Zeile, damit nichts springt.
  const state = test.busy ? "busy" : (test.result?.status ?? "idle");
  const text = test.busy ? "Teste …" : (test.result?.message ?? "Noch nicht getestet");
  return (
    <>
      <h2>Jellyfin-Server verbinden</h2>
      <p className="setup-lead">
        Adresse und API-Schlüssel deines Servers. Den Schlüssel erzeugst du in Jellyfin unter
        <em> Dashboard → API-Schlüssel</em>.
      </p>

      <div className="setup-form">
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
          <span>Zweite Adresse für unterwegs (optional)</span>
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="z. B. Tailscale: http://100.x.y.z:8096"
            value={draft.altUrl}
            onChange={(e) => onChange({ altUrl: e.target.value })}
            onBlur={() => draft.altUrl && onChange({ altUrl: normalizeServerUrl(draft.altUrl) })}
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
            <button type="button" className="ps-btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "Verbergen" : "Anzeigen"}
            </button>
          </div>
        </label>

        {isTauri() && (
          <div className="setup-field">
            <span>Im Netzwerk</span>
            <div className="setup-input-row">
              <div className={`setup-result is-${search.busy ? "busy" : search.error ? "error" : "idle"}`} role="status">
                {search.busy
                  ? "Suche Jellyfin-Server …"
                  : search.error
                    ? search.error
                    : !search.done
                      ? "Noch nicht gesucht"
                      : search.found.length
                        ? `${search.found.length} Server gefunden`
                        : "Kein Server gefunden – Adresse von Hand eintragen"}
              </div>
              <button type="button" className="ps-btn" disabled={search.busy} onClick={() => void runSearch()}>
                Server suchen
              </button>
            </div>
            {search.found.map((s) => (
              <button
                key={s.address}
                type="button"
                className="ps-btn"
                onClick={() => onChange({ url: s.address })}
              >
                {s.name} · {s.address}
              </button>
            ))}
          </div>
        )}

        <div className="setup-field setup-field--status">
          <span>Verbindung</span>
          <div className={`setup-result is-${state}`} role="status">
            {text}
          </div>
        </div>
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
  const chooseRef = useRef<HTMLButtonElement>(null);

  const choose = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        recursive: true, // gibt den Ordner samt Unterordnern für das Auslesen frei
        title: "Ordner mit deinen Spielen wählen",
        defaultPath: draft.gamesDir || undefined,
      });
      if (typeof picked === "string") {
        onChange({ gamesDir: picked });
        // Fokus lösen: Ein erneutes ✕ am Controller soll nun "Weiter" auslösen, nicht den Dialog neu öffnen.
        chooseRef.current?.blur();
      }
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
    setPreview("Wird gelesen …");
    scanGamesDir(draft.gamesDir)
      .then((scan) => {
        if (cancelled) return;
        const { systems, unassigned, programs } = countBySystem(scan);
        const found = Object.entries(systems).map(([sys, n]) => `${sys} (${n})`);
        if (programs) found.push(`Programme (${programs})`);
        if (unassigned) found.push(`nicht zugeordnet (${unassigned})`);
        setPreview(found.length ? `Erkannt: ${found.join(", ")}` : "Noch keine Spiele im Ordner gefunden");
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
        Wähle einen einzigen Ordner und lege alle Spiele einfach hinein – ISOs, CHD, CUE/BIN, Spieleordner, auch
        unsortiert oder in Unterordnern. JellyStation erkennt das System selbst, sortiert die Spiele im Menü und
        ordnet den passenden Emulator zu. Deine Dateien bleiben unverändert dort liegen, wo sie sind.
      </p>

      <div className="setup-form">
        <div className="setup-field">
          <span>Spiele-Ordner</span>
          <div className="setup-input-row">
            <input
              type="text"
              spellCheck={false}
              readOnly={tauri}
              // Browser: Pfad tippen; Desktop-App: der Ordner-Button ist das erste Ziel (✕ öffnet den Dialog).
              autoFocus={!tauri}
              placeholder={GAMES_BASE_DIR}
              value={draft.gamesDir}
              onChange={(e) => onChange({ gamesDir: e.target.value })}
            />
            <button
              type="button"
              className="ps-btn"
              ref={chooseRef}
              autoFocus={tauri && !draft.gamesDir}
              disabled={!tauri}
              onClick={choose}
            >
              Ordner wählen …
            </button>
          </div>
          {!tauri && <small>Der native Ordnerdialog ist nur in der Desktop-App verfügbar.</small>}
        </div>
        {preview && <p className="setup-preview">{preview}</p>}
      </div>

      <pre className="setup-tree" aria-label="Beispiel für den Spiele-Ordner">{`Spiele/
├─ Gran Turismo 5.iso
├─ Final Fantasy X.iso
├─ Crash Bandicoot.cue + .bin
├─ Mario Kart Wii.rvz
└─ irgendein Unterordner/Demon's Souls/PS3_GAME/…`}</pre>
      <p className="setup-note">
        Unterstützt werden {EMULATORS.map((e) => `${e.name} (${e.consoles})`).join(" · ")}. Sie werden automatisch
        gefunden und lassen sich später unter Einstellungen → Emulatoren installieren. Das System wird am Inhalt der
        Datei erkannt (z. B. PS3_GAME/PARAM.SFO, SYSTEM.CNF, Disc-Kopf), sonst an Seriennummer, Dateiformat oder
        Ordnername ({supportedFolderNames().join(", ")}). Was sich nicht erkennen lässt, erscheint im Menü unter
        „Nicht zugeordnet“ und lässt sich dort von Hand einem System zuweisen.
      </p>
    </>
  );
}


/* ---------- Schritt 3: Emulatoren, BIOS & Firmware ---------- */

interface FilesStepProps {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  emulators: EmulatorsState;
  requirements: RequirementsState;
  /** Systemordner mit Spielen (aus dem Spiele-Schritt), um „nötig“ hervorzuheben; leer = unbekannt. */
  systems?: string[];
}

const toneClass = (tone: "ok" | "warn" | "error" | undefined) => (tone === "ok" ? "is-ok" : tone === "warn" ? "is-warn" : tone === "error" ? "is-fail" : "is-pending");

export function FilesStep({ draft, onChange, emulators, requirements }: FilesStepProps) {
  const tauri = isTauri();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const chooseRef = useRef<HTMLButtonElement>(null);

  const chooseDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "Ordner mit BIOS- und Firmware-Dateien wählen", defaultPath: undefined });
      if (typeof picked === "string") {
        onChange({ biosDir: picked });
        chooseRef.current?.blur();
      }
    } catch (err) {
      setNote(`Dialog konnte nicht geöffnet werden: ${err instanceof Error ? err.message : err}`);
    }
  };

  const copy = async (status: RequirementStatus) => {
    setBusy(status.req.id);
    setNote("");
    try {
      await installRequirement(status);
      setNote(`${status.req.label} wurde in den Emulator übernommen.`);
    } catch (err) {
      setNote(`${status.req.label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
      void requirements.refresh();
    }
  };

  const missing = missingLabels(requirements.statuses);
  const emulatorMissing = emulators.statuses.filter((s) => s.checkable !== false && !s.valid).map((s) => s.def.name);

  return (
    <>
      <h2>Emulatoren, BIOS &amp; Firmware</h2>
      <p className="setup-lead">
        Damit später kein Spiel mit einer Fehlermeldung startet, siehst du hier, was noch fehlt. BIOS- und Firmware-Dateien
        werden weder mitgeliefert noch heruntergeladen – lege sie in einen Ordner und gib ihn hier an.
      </p>

      <div className="setup-form">
        <div className="setup-field">
          <span>Ordner mit BIOS- und Firmware-Dateien</span>
          <div className="setup-input-row">
            <input
              type="text"
              spellCheck={false}
              readOnly={tauri}
              placeholder={DEFAULT_BIOS_DIR}
              value={draft.biosDir}
              onChange={(e) => onChange({ biosDir: e.target.value })}
            />
            <button type="button" className="ps-btn" ref={chooseRef} disabled={!tauri} onClick={chooseDir}>
              Ordner wählen …
            </button>
            <button type="button" className="ps-btn" disabled={!tauri || requirements.loading} onClick={() => void requirements.refresh()}>
              Neu prüfen
            </button>
          </div>
          <small>Leer lassen = {DEFAULT_BIOS_DIR}. Unterordner (z. B. PS2/) werden mitgelesen.</small>
        </div>
      </div>

      <ul className="setup-checks setup-files">
        {EMULATORS.map((def) => {
          const st = emulators.statuses.find((s) => s.def.id === def.id);
          const found = !!st?.valid;
          const unknown = !st || st.checkable === false || emulators.loading;
          const reqs = requirementsFor(def.id).map((r) => requirements.statuses.find((x) => x.req.id === r.id)).filter((x): x is RequirementStatus => !!x);
          return (
            <li key={def.id} className={unknown ? "is-pending" : found ? "is-ok" : "is-warn"}>
              <span className="check-icon" aria-hidden="true">
                <i className={unknown ? "spinner" : undefined} />
              </span>
              <span className="check-text">
                <strong>
                  {def.name} <small>· {def.consoles}</small>
                </strong>
                <small>{unknown ? (tauri ? "Wird gesucht …" : "Nur in der Desktop-App prüfbar") : found ? "Gefunden" : "Nicht installiert – das Einrichtungsskript installiert ihn, sonst von Hand laden"}</small>
                {!unknown && !found && (
                  <span className="setup-files__links">
                    <button type="button" className="ps-btn" onClick={() => void openExternal(def.downloadUrl)}>
                      Download-Seite öffnen
                    </button>
                  </span>
                )}
                {reqs.map((rs) => {
                  const d = describeRequirement(rs);
                  return (
                    <span key={rs.req.id} className={`setup-files__req ${toneClass(d.tone)}`}>
                      <strong>{rs.req.label}</strong>
                      <span>{d.text}</span>
                      {rs.state !== "ready" && rs.state !== "unknown" && <em>{rs.req.description}</em>}
                      {rs.state === "in-folder" && (
                        <em>{rs.req.installHint}</em>
                      )}
                      {rs.state !== "ready" && rs.state !== "unknown" && (
                        <span className="setup-files__links">
                          {rs.state === "in-folder" && rs.req.copyTo && (
                            <button type="button" className="ps-btn" disabled={busy === rs.req.id} onClick={() => void copy(rs)}>
                              {busy === rs.req.id ? "Kopiere …" : "In den Emulator übernehmen"}
                            </button>
                          )}
                          {rs.req.links.map((l) => (
                            <button key={l.url} type="button" className="ps-btn" onClick={() => void openExternal(l.url)}>
                              {l.label}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                  );
                })}
              </span>
            </li>
          );
        })}
      </ul>

      {note && <p className="setup-preview">{note}</p>}
      {tauri && !requirements.loading && (
        <p className={`setup-result ${missing.length || emulatorMissing.length ? "is-warn" : "is-ok"}`} role="status">
          {missing.length || emulatorMissing.length
            ? `Noch offen: ${[...emulatorMissing.map((n) => `${n} (Emulator)`), ...missing].join(", ")}. Du kannst trotzdem fortfahren und es später unter Einstellungen → Emulatoren / BIOS & Firmware nachholen.`
            : "Alles vorhanden – es fehlt nichts."}
        </p>
      )}
    </>
  );
}

/* ---------- Schritt 4: Controller ---------- */

/**
 * Schlichte DualShock-Silhouette. Die ViewBox ist auf die gemessene Mitte der Form (32 | 20,26) gelegt, sodass das Bild
 * im Ring exakt zentriert sitzt; die vier Tasten zeigen die Originalfarben, sobald ein Controller da ist.
 */
function PadGlyph() {
  // Die Symbole stammen aus dem 24er-Raster von <PsSymbol>, hier verkleinert um (x, y) gesetzt.
  const face = (x: number, y: number, color: string, shape: ReactNode) => (
    <g transform={`translate(${x} ${y}) scale(0.34) translate(-12 -12)`} stroke={color} strokeWidth="2.6">
      {shape}
    </g>
  );
  return (
    <svg className="pad-glyph" viewBox="0 -1.74 64 44" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Gehäuse (spiegelsymmetrisch zu x = 32) */}
      <path d="M20 4H44C50 4 54 7 56.5 14L60 30C61.5 36 55 39 51.5 34L46.5 28H17.5L12.5 34C9 39 2.5 36 4 30L7.5 14C10 7 14 4 20 4Z" />
      {/* Touchpad */}
      <rect x="25" y="7.6" width="14" height="5" rx="1.6" strokeWidth="1.1" />
      {/* Steuerkreuz */}
      <path d="M16.5 14.6V22.2M12.7 18.4H20.3" strokeWidth="2.2" />
      {/* Analogsticks */}
      <circle cx="26" cy="21.6" r="2.7" strokeWidth="1.1" />
      <circle cx="36" cy="21.6" r="2.7" strokeWidth="1.1" />
      {/* Aktionstasten */}
      <g className="pad-glyph__face">
        {face(48.4, 13.4, "var(--ps-triangle)", <path d="M12 5.2 19 17.8H5Z" />)}
        {face(53.8, 18.4, "var(--ps-circle)", <circle cx="12" cy="12" r="6.6" />)}
        {face(48.4, 23.4, "var(--ps-cross)", <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />)}
        {face(43, 18.4, "var(--ps-square)", <rect x="5.8" y="5.8" width="12.4" height="12.4" rx="1" />)}
      </g>
    </svg>
  );
}

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
        <PadGlyph />
      </div>
      <p className={`setup-result pad-status is-${pressed ? "ok" : name ? "warn" : "idle"}`}>
        {pressed
          ? `${name ?? "Controller"} funktioniert`
          : name
            ? `${name} erkannt – drücke jetzt eine Taste`
            : "Warte auf Controller …"}
      </p>
      <p className="setup-note setup-note--center">Ein Controller ist optional – du kannst diesen Schritt überspringen.</p>
    </>
  );
}

/* ---------- Schritt 5: Abhängigkeiten ---------- */

/** Statusmarken als SVG im 24er-Raster – Unicode-Zeichen (✓ ! ✕) säßen je nach Schrift schief im Kreis. */
function StatusIcon({ status }: { status: CheckResult["status"] }) {
  if (status === "running") return <i className="spinner" />;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {status === "ok" && <path d="M6.2 12.4 10.3 16.4 17.8 8.2" />}
      {status === "warn" && (
        <>
          <path d="M12 6.4V13.4" />
          <path d="M12 17.4V17.5" strokeWidth="2.6" />
        </>
      )}
      {status === "fail" && <path d="M8 8 16 16M16 8 8 16" />}
      {status === "pending" && <path d="M12 12V12.01" strokeWidth="3" />}
    </svg>
  );
}

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
                <StatusIcon status={r.status} />
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
