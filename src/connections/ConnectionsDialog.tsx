import { useCallback, useEffect, useRef, useState } from "react";
import { testJellyfinAddresses } from "../jellyfin/testConnection";
import type { ConnectionResult } from "../jellyfin/testConnection";
import type { Settings } from "../settings/settings";
import { SETUP_STEP, SetupWizard } from "../setup/SetupWizard";
import { checkStremio } from "../stremio/check";
import type { StremioCheck } from "../stremio/check";
import { StremioAddonsDialog } from "../stremio/StremioAddonsDialog";
import { PopupList } from "../ui/popup";
import type { PopupItem, PopupStatus } from "../ui/popup";

/*
 * Einstellungen → Verbindungen: eine Karte pro Dienst (Jellyfin, Stremio) mit Status und Prüfung an einer Stelle.
 * Beim Öffnen werden beide Dienste einmal geprüft; ✕ öffnet die Einrichtung des Dienstes (dieselben Bausteine wie im
 * Setup-Assistenten bzw. der Stremio-Verwaltung), △ prüft den fokussierten Dienst erneut. Zugangsdaten bleiben in den
 * jeweiligen Formularen – hier steht nur, ob es klappt und woran es hakt.
 */

type ServiceId = "jf" | "st";
type Check = { status: PopupStatus; message: string };

const JF = "jf";
const ST = "st";
const ALL = "__all";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const fromJellyfin = (r: ConnectionResult): Check => ({ status: r.status === "ok" ? "ok" : r.status === "warn" ? "warn" : "error", message: r.message });
const fromStremio = (r: StremioCheck): Check => ({ status: r.status === "ok" ? "ok" : r.status === "warn" ? "warn" : "error", message: r.message });

export interface ConnectionsDialogProps {
  settings: Settings;
  onChangeSettings: (next: Settings) => void;
  onClose: () => void;
}

export function ConnectionsDialog({ settings, onChangeSettings, onClose }: ConnectionsDialogProps) {
  const [view, setView] = useState<"list" | "jellyfin" | "stremio">("list");
  const [checks, setChecks] = useState<Partial<Record<ServiceId, Check>>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const abort = useRef<Partial<Record<ServiceId, AbortController>>>({});
  const latest = useRef(settings);
  latest.current = settings;

  const run = useCallback(async (id: ServiceId) => {
    abort.current[id]?.abort();
    const ctl = new AbortController();
    abort.current[id] = ctl;
    const s = latest.current;
    if (id === JF && !s.jellyfin.url.trim()) {
      setChecks((c) => ({ ...c, [JF]: { status: "warn", message: "Nicht eingerichtet" } }));
      return;
    }
    setChecks((c) => ({ ...c, [id]: { status: "busy", message: "Prüfe …" } }));
    let result: Check;
    try {
      result =
        id === JF
          ? fromJellyfin(await testJellyfinAddresses(s.jellyfin.url, s.jellyfin.altUrl ?? "", s.jellyfin.apiKey, s.jellyfin.userId))
          : fromStremio(await checkStremio(s.stremio, ctl.signal));
    } catch {
      if (ctl.signal.aborted) return;
      result = { status: "error", message: "Prüfung fehlgeschlagen" };
    }
    if (ctl.signal.aborted) return;
    setChecks((c) => ({ ...c, [id]: result }));
  }, []);

  // Beim Öffnen beide Dienste prüfen; beim Schließen laufende Prüfungen abbrechen.
  useEffect(() => {
    void run(JF);
    void run(ST);
    const pending = abort.current;
    return () => {
      for (const ctl of Object.values(pending)) ctl?.abort();
    };
  }, [run]);

  if (view === "jellyfin") {
    return (
      <SetupWizard
        initial={settings}
        onlyStep={SETUP_STEP.jellyfin}
        onCancel={() => setView("list")}
        onComplete={(saved) => {
          onChangeSettings(saved);
          latest.current = saved;
          setView("list");
          setFocusId(JF);
          void run(JF);
        }}
      />
    );
  }
  if (view === "stremio") {
    return (
      <StremioAddonsDialog
        stremio={settings.stremio}
        onChange={(next) => {
          const s = { ...settings, stremio: next };
          latest.current = s;
          onChangeSettings(s);
        }}
        onClose={() => {
          setView("list");
          setFocusId(ST);
          void run(ST);
        }}
      />
    );
  }

  const jf = settings.jellyfin;
  const jfAddress = jf.url.trim() ? [hostOf(jf.url), jf.altUrl ? hostOf(jf.altUrl) : ""].filter(Boolean).join(" · ") : "";
  const stSummary = settings.stremio?.account
    ? settings.stremio.account.email
    : settings.stremio?.addons.length
      ? `${settings.stremio.addons.length} Addon${settings.stremio.addons.length === 1 ? "" : "s"} von Hand`
      : "";

  const row = (id: ServiceId, label: string, who: string): PopupItem => {
    const c = checks[id];
    return {
      id,
      label,
      detail: c?.message ?? (who || "Nicht eingerichtet – auswählen zum Verbinden"),
      status: c?.status === "warn" ? "warn" : c?.status,
    };
  };
  const items: PopupItem[] = [
    row(JF, "Jellyfin", jfAddress),
    row(ST, "Stremio", stSummary),
    { id: ALL, label: "Alle Verbindungen prüfen", detail: "Testet Jellyfin und Stremio erneut und zeigt, woran es hakt" },
  ];
  const busy = Object.values(checks).some((c) => c.status === "busy");
  const broken = Object.values(checks).filter((c) => c.status === "error").length;
  const ready = Object.values(checks).filter((c) => c.status === "ok").length;

  return (
    <PopupList
      title="Verbindungen"
      subtitle={busy ? "Prüfe …" : broken ? `${broken} Problem${broken === 1 ? "" : "e"}` : ready === 2 ? "Alles verbunden" : "Dienste einrichten"}
      width="wide"
      items={items}
      focusId={focusId}
      busy={busy}
      footer={{
        text: "✕ richtet den Dienst ein (Adresse, Anmeldung, Addons). △ prüft ihn erneut. Passwörter werden nie gespeichert.",
        kind: broken ? "error" : "info",
      }}
      onSelect={(id) => {
        if (id === JF) setView("jellyfin");
        else if (id === ST) setView("stremio");
        else {
          void run(JF);
          void run(ST);
        }
      }}
      onAlt={(id) => {
        if (id === JF || id === ST) void run(id);
      }}
      altLabel="Prüfen"
      onBack={onClose}
    />
  );
}
