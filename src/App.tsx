import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { categories as baseCategories } from "./data/library";
import type { XmbCategory, XmbEntry } from "./data/types";
import { EmulatorsDialog, summarizeEmulators, useEmulators } from "./emulators";
import { getJfContext, listJfUsers } from "./jellyfin/context";
import type { JfUser } from "./jellyfin/context";
import { getEpisodes, getNextUp } from "./jellyfin/items";
import { emptyLibraryEntry } from "./jellyfin/library";
import { Player } from "./player/Player";
import { loadPrefs, savePrefs } from "./player/prefs";
import { PopupList } from "./ui/popup";
import type { PopupItem } from "./ui/popup";
import { formatClock, formatRemaining, watchState } from "./xmb/progress";
import { useJellyfinLibrary } from "./jellyfin/useJellyfinLibrary";
import { useGameLauncher } from "./launcher/useGameLauncher";
import { useGameLibrary } from "./library/useGameLibrary";
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

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((loaded) => {
      if (cancelled) return;
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
  | { kind: "users"; users: JfUser[] | null; error?: string }
  | { kind: "resume"; entry: XmbEntry; playlist?: XmbEntry[] }
  | { kind: "episodes"; series: XmbEntry; episodes: XmbEntry[] | null; focusId?: string; error?: string }
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
  });

  const jfConfig = jfConfigOf(settings);

  // Echte Jellyfin-Titel ersetzen die Demo-Einträge – aber nur, wenn überhaupt etwas geladen wurde.
  const hasJellyfinItems = jellyfin.status === "ok" && jellyfin.movies.length + jellyfin.series.length > 0;

  const emulatorSummary = useMemo(() => summarizeEmulators(emulators.statuses), [emulators.statuses]);
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
  }, [library.categories, settings, hasJellyfinItems, jellyfin.movies, jellyfin.series, emulatorSummary, userName, jfConfig, alwaysTranscode]);

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
    async (series: XmbEntry) => {
      // Demo-Serien (ohne Server) spielen direkt das Demo-Video.
      if (!series.jellyfin || !jfConfig) return play(series);
      openOverlay({ kind: "episodes", series, episodes: null });
      const seq = overlaySeq.current;
      try {
        const ctx = await getJfContext(jfConfig);
        const [episodes, next] = await Promise.all([
          getEpisodes(ctx, series.jellyfin.id),
          getNextUp(ctx, series.jellyfin.id).catch(() => null),
        ]);
        if (overlaySeq.current !== seq) return;
        setOverlay({ kind: "episodes", series, episodes, focusId: next?.id ?? episodes[0]?.id });
      } catch (err) {
        if (overlaySeq.current !== seq) return;
        setOverlay({ kind: "episodes", series, episodes: [], error: errorMessage(err) });
      }
    },
    [jfConfig, openOverlay, play],
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
      else if (entry.action === "choose-jellyfin-user") void openUsers();
      else if (entry.action === "toggle-transcode") {
        const next = !loadPrefs().alwaysTranscode;
        savePrefs({ alwaysTranscode: next ? true : undefined });
        setAlwaysTranscode(next);
        notify(next ? "Der Server wandelt jetzt immer um" : "Dateien werden direkt abgespielt, wenn möglich");
      }
      else if (entry.id.startsWith("jf-empty/")) return; // Platzhalter einer leeren Spalte
      else if (category.id === "movies") play(entry);
      else if (category.id === "series") void openSeries(entry);
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
  } else if (overlay?.kind === "episodes") {
    layer = <EpisodesList overlay={overlay} onPick={(ep, list) => play(ep, list)} onBack={close} />;
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

function EpisodesList({
  overlay,
  onPick,
  onBack,
}: {
  overlay: Extract<Overlay, { kind: "episodes" }>;
  onPick: (episode: XmbEntry, list: XmbEntry[]) => void;
  onBack: () => void;
}) {
  const { series, episodes, error, focusId } = overlay;
  const items = useMemo<PopupItem[]>(() => {
    const out: PopupItem[] = [];
    let season: number | undefined | null = null;
    for (const ep of episodes ?? []) {
      const n = ep.jellyfin?.seasonNumber;
      if (n !== season) {
        season = n;
        out.push({ id: `season/${n ?? "x"}`, label: n === 0 ? "Specials" : n ? `Staffel ${n}` : "Folgen", header: true });
      }
      const state = watchState(ep);
      out.push({
        id: ep.id,
        label: ep.title,
        detail: ep.subtitle,
        art: ep,
        progress: state && !state.played && state.ratio > 0 ? state.ratio : undefined,
        status: state?.played ? "ok" : undefined,
        trailing: state?.played ? "Gesehen" : state?.remainingSec ? formatRemaining(state.remainingSec) : undefined,
      });
    }
    return out;
  }, [episodes]);

  return (
    <PopupList
      title={series.title}
      subtitle="Folgen"
      width="wide"
      items={items}
      busy={episodes === null}
      focusId={focusId}
      emptyText={episodes === null ? "Lade Folgen …" : "Keine Folgen gefunden"}
      footer={error ? { text: error, kind: "error" } : undefined}
      onSelect={(id) => {
        const ep = episodes?.find((e) => e.id === id);
        if (ep && episodes) onPick(ep, episodes);
      }}
      onBack={onBack}
    />
  );
}

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
