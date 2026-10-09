import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { categories as baseCategories } from "./data/library";
import type { XmbCategory, XmbEntry } from "./data/types";
import { EmulatorsDialog, summarizeEmulators, useEmulators } from "./emulators";
import { RequirementsDialog } from "./emulators/RequirementsDialog";
import { biosDirOf, blockingMissing, checkRequirements, missingLabels, requirementsFor } from "./emulators/requirements";
import { useRequirements } from "./emulators/useRequirements";
import { listJfUsers } from "./jellyfin/context";
import type { JfUser } from "./jellyfin/context";
import { emptyLibraryEntry } from "./jellyfin/library";
import { Player } from "./player/Player";
import { SettingsDialog } from "./prefs/SettingsDialog";
import type { SettingsSection } from "./prefs/SettingsDialog";
import { SeriesScreen } from "./series/SeriesScreen";
import { loadPrefs, savePrefs } from "./player/prefs";
import { PopupList } from "./ui/popup";
import type { PopupItem } from "./ui/popup";
import { formatClock, formatRemaining, watchState } from "./xmb/progress";
import { useJellyfinLibrary } from "./jellyfin/useJellyfinLibrary";
import { useGameLauncher } from "./launcher/useGameLauncher";
import { useGameLibrary } from "./library/useGameLibrary";
import { useAmbientMusic } from "./audio/useAmbientMusic";
import { initUiPrefs, THEMES, useUiPrefs } from "./prefs/uiPrefs";
import { MOODS } from "./audio/moods";
import { loadSettings, saveSettings } from "./settings/settings";
import type { Settings } from "./settings/settings";
import { SetupWizard } from "./setup/SetupWizard";
import { Xmb } from "./xmb/Xmb";

/**
 * Start-Gatekeeper: Erst wird die gespeicherte Konfiguration geladen. Fehlt sie, wird
 * das Hauptmenü gar nicht erst aufgebaut (kein Bibliotheks-Scan, keine Eingabeverarbeitung),
 * sondern der Setup-Assistent gezeigt.
 */
export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<"loading" | "setup" | "ready">("loading");

  // Neuester Stand der Einstellungen für das (entprellte) Speichern der Darstellungs-Einstellungen.
  const latest = useRef<Settings | null>(null);
  latest.current = settings;

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((loaded) => {
      if (cancelled) return;
      latest.current = loaded;
      // Darstellung/Klang sofort anwenden; Änderungen werden in settings.ui gespeichert.
      initUiPrefs(loaded?.ui, (ui) => {
        const cur = latest.current;
        if (!cur) return;
        const next = { ...cur, ui };
        latest.current = next;
        setSettings(next);
        void saveSettings(next).catch((err) => console.warn("Einstellungen nicht gespeichert", err));
      });
      setSettings(loaded);
      setPhase(loaded ? "ready" : "setup");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") return <div className="boot" />;

  if (phase === "setup") {
    return (
      <SetupWizard
        initial={settings}
        onCancel={settings ? () => setPhase("ready") : undefined}
        onComplete={(saved) => {
          setSettings(saved);
          setPhase("ready");
        }}
      />
    );
  }

  const changeSettings = (next: Settings) => {
    setSettings(next);
    void saveSettings(next).catch((err) => console.warn("Einstellungen nicht gespeichert", err));
  };

  // `key` erzwingt nach dem Setup einen frischen Start des Menüs mit den neuen Werten.
  return (
    <Main
      key={settings?.completedAt}
      settings={settings}
      onChangeSettings={changeSettings}
      onRunSetup={() => setPhase("setup")}
    />
  );
}

type Overlay =
  | { kind: "emulators"; focusId?: string; message?: string }
  | { kind: "files"; focusEmulatorId?: string; message?: string }
  | { kind: "users"; users: JfUser[] | null; error?: string }
  | { kind: "resume"; entry: XmbEntry; playlist?: XmbEntry[] }
  | { kind: "series"; series: XmbEntry }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "player"; entry: XmbEntry; startSec: number; playlist?: XmbEntry[] };

const jfConfigOf = (settings: Settings | null) =>
  settings && settings.jellyfin.url.trim() && settings.jellyfin.apiKey.trim() ? settings.jellyfin : null;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Unerwarteter Fehler");

function Main({
  settings,
  onChangeSettings,
  onRunSetup,
}: {
  settings: Settings | null;
  onChangeSettings: (next: Settings) => void;
  onRunSetup: () => void;
}) {
  const library = useGameLibrary(settings?.gamesDir);
  const jellyfin = useJellyfinLibrary(settings?.jellyfin);
  const emulators = useEmulators(settings?.emulators);
  const biosDir = settings?.biosDir ?? "";
  const requirements = useRequirements(biosDirOf(biosDir));
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [alwaysTranscode, setAlwaysTranscode] = useState(() => loadPrefs().alwaysTranscode === true);
  // Verhindert, dass eine spät eintreffende Antwort ein inzwischen geschlossenes Overlay wieder öffnet.
  const overlaySeq = useRef(0);
  const openOverlay = useCallback((next: Overlay | null) => {
    overlaySeq.current += 1;
    setOverlay(next);
  }, []);

  const { running, launch, overlay: launcherOverlay } = useGameLauncher({
    emulators,
    onNeedEmulator: (focusId, message) => openOverlay({ kind: "emulators", focusId, message }),
    // Vor dem Start frisch prüfen, ob BIOS/Firmware da ist – eine Meldung statt eines Absturzes im Emulator.
    preflight: async (def) => {
      const fresh = await checkRequirements(biosDirOf(biosDir), requirementsFor(def.id));
      const lacking = blockingMissing(fresh);
      if (lacking.length === 0) return null;
      return `${def.name} braucht noch: ${lacking.map((s) => s.req.label).join(", ")}.`;
    },
    onNeedFiles: (emulatorId, message) => openOverlay({ kind: "files", focusEmulatorId: emulatorId, message }),
  });

  const jfConfig = jfConfigOf(settings);
  // Hintergrundmusik pausiert, solange ein Film läuft oder ein Spiel startet/läuft.
  useAmbientMusic({ suspended: overlay?.kind === "player" || running.size > 0 || !!launcherOverlay });

  // Echte Jellyfin-Titel ersetzen die Demo-Einträge – aber nur, wenn überhaupt etwas geladen wurde.
  const hasJellyfinItems = jellyfin.status === "ok" && jellyfin.movies.length + jellyfin.series.length > 0;

  const ui = useUiPrefs();
  const displaySummary = `${THEMES.find((t) => t.id === ui.themeId)?.label ?? "Automatisch"} · Helligkeit ${Math.round(ui.brightness * 100)} %`;
  const motionSummary = ui.animations === "full" ? "Voll" : ui.animations === "reduced" ? "Reduziert" : "Aus";
  const soundSummary = ui.musicEnabled ? `Musik: ${MOODS.find((m) => m.id === ui.musicMood)?.label ?? ""}` : "Musik aus";
  const emulatorSummary = useMemo(() => summarizeEmulators(emulators.statuses), [emulators.statuses]);
  const filesSummary = useMemo(() => {
    const m = missingLabels(requirements.statuses);
    return requirements.loading ? "Wird geprüft …" : m.length ? `Fehlt: ${m.join(", ")}` : "Alles vorhanden";
  }, [requirements.statuses, requirements.loading]);
  const userName = settings?.jellyfin.userName || jellyfin.userName;

  const categories = useMemo<XmbCategory[]>(() => {
    const base = baseCategories.map((cat) => {
      if (hasJellyfinItems && (cat.id === "movies" || cat.id === "series")) {
        // Hat der Server nur Filme oder nur Serien, zeigt die andere Spalte das ehrlich an (keine Demo-Daten daneben).
        const real = cat.id === "movies" ? jellyfin.movies : jellyfin.series;
        return { ...cat, entries: real.length ? real : [emptyLibraryEntry(cat.id === "movies" ? "Movie" : "Series")] };
      }
      return cat.id !== "settings"
        ? cat
        : {
            ...cat,
            entries: cat.entries.map((e) =>
              e.id === "st1"
                ? { ...e, subtitle: settings?.jellyfin.url || "Nicht eingerichtet" }
                : e.id === "st-games" && settings?.gamesDir
                  ? { ...e, subtitle: settings.gamesDir }
                  : e.action === "open-emulators"
                    ? { ...e, subtitle: emulatorSummary }
                    : e.action === "open-display-settings"
                      ? { ...e, subtitle: displaySummary }
                    : e.action === "open-motion-settings"
                      ? { ...e, subtitle: motionSummary }
                    : e.action === "open-sound-settings"
                      ? { ...e, subtitle: soundSummary }
                    : e.action === "open-requirements"
                      ? { ...e, subtitle: filesSummary }
                    : e.action === "toggle-transcode"
                      ? { ...e, subtitle: alwaysTranscode ? "Immer vom Server umwandeln" : "Direkt, wenn möglich" }
                    : e.action === "choose-jellyfin-user"
                      ? { ...e, subtitle: userName || (jfConfig ? "Automatisch" : "Nicht verbunden") }
                      : e,
            ),
          };
    });
    // Spiele-Systeme (PS1, PS2, PS3 …) landen direkt hinter den Serien.
    const at = base.findIndex((c) => c.id === "series") + 1;
    return [...base.slice(0, at), ...library.categories, ...base.slice(at)];
  }, [library.categories, settings, hasJellyfinItems, jellyfin.movies, jellyfin.series, emulatorSummary, filesSummary, userName, jfConfig, alwaysTranscode, displaySummary, motionSummary, soundSummary]);

  /** Titel abspielen; ab einer gespeicherten Position fragt vorher ein Dialog nach Fortsetzen/Von vorn. */
  const play = useCallback(
    (entry: XmbEntry, playlist?: XmbEntry[]) => {
      const resume = watchState(entry)?.resumeSec ?? 0;
      if (entry.jellyfin && resume > 0) openOverlay({ kind: "resume", entry, playlist });
      else openOverlay({ kind: "player", entry, startSec: 0, playlist });
    },
    [openOverlay],
  );

  const openSeries = useCallback(
    (series: XmbEntry) => {
      // Demo-Serien (ohne Server) und echte Serien öffnen denselben Serien-Screen.
      openOverlay({ kind: "series", series });
    },
    [openOverlay],
  );

  const openUsers = useCallback(async () => {
    if (!jfConfig) return openOverlay({ kind: "users", users: [], error: "Jellyfin ist noch nicht eingerichtet." });
    openOverlay({ kind: "users", users: null });
    const seq = overlaySeq.current;
    try {
      const users = await listJfUsers(jfConfig);
      if (overlaySeq.current === seq) setOverlay({ kind: "users", users });
    } catch (err) {
      if (overlaySeq.current === seq) setOverlay({ kind: "users", users: [], error: errorMessage(err) });
    }
  }, [jfConfig, openOverlay]);

  const onActivate = useCallback(
    (entry: XmbEntry, category: XmbCategory, notify: (text: string) => void) => {
      if (entry.action === "run-setup") onRunSetup();
      else if (entry.action === "open-emulators") openOverlay({ kind: "emulators" });
      else if (entry.action === "open-requirements") openOverlay({ kind: "files" });
      else if (entry.action === "open-display-settings") openOverlay({ kind: "settings", section: "display" });
      else if (entry.action === "open-motion-settings") openOverlay({ kind: "settings", section: "motion" });
      else if (entry.action === "open-sound-settings") openOverlay({ kind: "settings", section: "sound" });
      else if (entry.action === "choose-jellyfin-user") void openUsers();
      else if (entry.action === "toggle-transcode") {
        const next = !loadPrefs().alwaysTranscode;
        savePrefs({ alwaysTranscode: next ? true : undefined });
        setAlwaysTranscode(next);
        notify(next ? "Der Server wandelt jetzt immer um" : "Dateien werden direkt abgespielt, wenn möglich");
      }
      else if (entry.id.startsWith("jf-empty/")) return; // Platzhalter einer leeren Spalte
      else if (category.id === "movies") play(entry);
      else if (category.id === "series") openSeries(entry);
      else void launch(entry, notify);
    },
    [launch, onRunSetup, openOverlay, openUsers, openSeries, play],
  );

  // Kopfzeilen-Hinweis: Spiele-Vorschau und/oder Zustand der Jellyfin-Verbindung.
  const notice =
    [
      library.source === "mock" ? "Vorschau-Modus · Demo-Spiele" : null,
      jellyfin.status === "error" ? `Jellyfin: ${jellyfin.error}` : null,
      jellyfin.status === "ok" && !hasJellyfinItems ? "Jellyfin: keine Filme oder Serien gefunden" : null,
      jellyfin.truncated ? `Jellyfin: ${jellyfin.truncated}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;

  const close = () => openOverlay(null);

  let layer: React.ReactNode = null;
  if (overlay?.kind === "player") {
    layer = (
      <Player
        entry={overlay.entry}
        jellyfin={jfConfig}
        startSec={overlay.startSec}
        playlist={overlay.playlist}
        onClose={(info) => {
          close();
          // Neue Wiedergabestände (Balken, Haken) sofort sichtbar machen.
          if (info.entry.jellyfin) jellyfin.reload();
        }}
      />
    );
  } else if (overlay?.kind === "resume") {
    const { entry, playlist } = overlay;
    const resumeSec = watchState(entry)?.resumeSec ?? 0;
    layer = (
      <PopupList
        title={entry.title}
        subtitle={entry.subtitle}
        width="narrow"
        items={[
          { id: "resume", label: `Fortsetzen bei ${formatClock(resumeSec)}`, detail: remainingText(entry) },
          { id: "restart", label: "Von vorn beginnen" },
        ]}
        onSelect={(id) => openOverlay({ kind: "player", entry, startSec: id === "resume" ? resumeSec : 0, playlist })}
        onBack={close}
      />
    );
  } else if (overlay?.kind === "series") {
    layer = (
      <SeriesScreen
        series={overlay.series}
        jellyfin={jfConfig}
        onPlay={(episode, playlist, startSec) => openOverlay({ kind: "player", entry: episode, startSec, playlist })}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "settings") {
    layer = <SettingsDialog section={overlay.section} onClose={close} />;
  } else if (overlay?.kind === "users") {
    layer = (
      <UsersList
        users={overlay.users}
        error={overlay.error}
        currentId={settings?.jellyfin.userId || jellyfin.userId}
        onPick={(user) => {
          if (settings) {
            onChangeSettings({ ...settings, jellyfin: { ...settings.jellyfin, userId: user.id, userName: user.name } });
          }
          close();
        }}
        onBack={close}
      />
    );
  } else if (overlay?.kind === "files") {
    layer = (
      <RequirementsDialog
        statuses={requirements.statuses}
        loading={requirements.loading}
        biosDir={biosDir}
        focusEmulatorId={overlay.focusEmulatorId}
        message={overlay.message}
        onSetBiosDir={(dir) => settings && onChangeSettings({ ...settings, biosDir: dir.trim() || undefined })}
        onRefresh={requirements.refresh}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "emulators") {
    layer = (
      <EmulatorsDialog
        statuses={emulators.statuses}
        brew={emulators.brew}
        loading={emulators.loading}
        focusId={overlay.focusId}
        message={overlay.message}
        onSetOverride={(id, path) => {
          if (!settings) return;
          const next = { ...(settings.emulators ?? {}) };
          if (path) next[id] = path;
          else delete next[id];
          onChangeSettings({ ...settings, emulators: next });
        }}
        onRefresh={emulators.refresh}
        onClose={close}
      />
    );
  }

  return (
    <>
      <Xmb
        categories={categories}
        onActivate={onActivate}
        runningIds={running}
        notice={notice}
        inputEnabled={!overlay && !launcherOverlay}
      />
      {layer}
      {launcherOverlay}
    </>
  );
}

const remainingText = (entry: XmbEntry) => {
  const left = watchState(entry)?.remainingSec;
  return left ? `noch ${formatRemaining(left)}` : undefined;
};

function UsersList({
  users,
  error,
  currentId,
  onPick,
  onBack,
}: {
  users: JfUser[] | null;
  error?: string;
  currentId?: string;
  onPick: (user: JfUser) => void;
  onBack: () => void;
}) {
  const items: PopupItem[] = (users ?? []).map((u) => ({
    id: u.id,
    label: u.name,
    detail: u.isAdmin ? "Administrator" : undefined,
    checked: u.id === currentId,
    disabled: u.isDisabled,
  }));
  return (
    <PopupList
      title="Jellyfin-Benutzer"
      subtitle="Wessen Wiedergabestand gilt?"
      width="narrow"
      items={items}
      busy={users === null}
      emptyText={users === null ? "Lade Benutzer …" : "Keine Benutzer gefunden"}
      footer={error ? { text: error, kind: "error" } : undefined}
      onSelect={(id) => {
        const user = users?.find((u) => u.id === id);
        if (user) onPick(user);
      }}
      onBack={onBack}
    />
  );
}
