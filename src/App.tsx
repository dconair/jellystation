import { useReachableServer } from "./jellyfin/useReachableServer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { categories as baseCategories } from "./data/library";
import type { XmbCategory, XmbEntry } from "./data/types";
import { EmulatorsDialog, summarizeEmulators, useEmulators } from "./emulators";
import { DiagnoseDialog } from "./diagnose/DiagnoseDialog";
import type { DiagnoseContext, DiagnoseGame } from "./diagnose/types";
import { RequirementsDialog } from "./emulators/RequirementsDialog";
import { biosDirOf, blockingMissing, checkRequirements, missingLabels, requirementsFor } from "./emulators/requirements";
import { useRequirements } from "./emulators/useRequirements";
import { listJfUsers } from "./jellyfin/context";
import type { JfUser } from "./jellyfin/context";
import { emptyLibraryEntry, hueFromTitle } from "./jellyfin/library";
import { Player } from "./player/Player";
import { SettingsDialog } from "./prefs/SettingsDialog";
import type { SettingsSection } from "./prefs/SettingsDialog";
import { MovieScreen } from "./movie/MovieScreen";
import type { MovieChoice } from "./movie/MovieScreen";
import { SeriesScreen } from "./series/SeriesScreen";
import { loadPrefs, savePrefs } from "./player/prefs";
import { MOODS } from "./audio/moods";
import { UiEffects } from "./prefs/UiEffects";
import { ConfirmDialog, MessageDialog, PopupList } from "./ui/popup";
import { supportedFolderNames } from "./emulators/catalog";
import { GameSourcesDialog } from "./install/GameSourcesDialog";
import { InstallDialog } from "./install/InstallDialog";
import { onItemDone, useDownloadQueue } from "./install/downloadQueue";
import { BookmarkDialog } from "./web/BookmarkDialog";
import { hostOf, importGame, onWebDownload, openWeb } from "./web/webApi";
import { APP_COMMIT_SUBJECT, APP_VERSION_LABEL } from "./version";
import type { PopupItem } from "./ui/popup";
import { formatClock, formatRemaining, watchState } from "./xmb/progress";
import { useJellyfinLibrary } from "./jellyfin/useJellyfinLibrary";
import { useGameLauncher } from "./launcher/useGameLauncher";
import { CoverSettingsDialog } from "./art/CoverSettingsDialog";
import { useGameLibrary } from "./library/useGameLibrary";
import { AUTO, AssignmentsList, AssignSystemList } from "./library/AssignOverlays";
import { useRecentJellyfin } from "./jellyfin/useRecent";
import { loadRecentGames, rememberGame } from "./library/recentGames";
import { useAmbientMusic } from "./audio/useAmbientMusic";
import { BootAnimation } from "./boot/BootAnimation";
import { getUiPrefs, initUiPrefs, THEMES, useUiPrefs } from "./prefs/uiPrefs";
import { coversAuto, loadSettings, saveSettings } from "./settings/settings";
import type { Settings } from "./settings/settings";
import { SETUP_STEP, SetupWizard } from "./setup/SetupWizard";
import { Xmb } from "./xmb/Xmb";
import { StremioAddonsDialog } from "./stremio/StremioAddonsDialog";
import { StremioPicker } from "./stremio/StremioPicker";
import { useStremioLibrary } from "./stremio/useStremioLibrary";
import { useStremioAccountSync } from "./stremio/useStremioAccountSync";
import { effectiveAddons } from "./stremio/addons";
import { SearchDialog } from "./search/SearchDialog";
import { loadSearchHistory } from "./search/history";

/**
 * Start-Gatekeeper: Erst wird die gespeicherte Konfiguration geladen. Fehlt sie, wird
 * das Hauptmenü gar nicht erst aufgebaut (kein Bibliotheks-Scan, keine Eingabeverarbeitung),
 * sondern der Setup-Assistent gezeigt.
 */
export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<"loading" | "setup" | "ready">("loading");
  // Schritt, der allein bearbeitet wird (Einstellungen → Server / Spiele-Ordner); undefined = ganzer Assistent.
  const [onlyStep, setOnlyStep] = useState<number | undefined>(undefined);

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
        onlyStep={onlyStep}
        onCancel={settings ? () => { setOnlyStep(undefined); setPhase("ready"); } : undefined}
        onComplete={(saved) => {
          setSettings(saved);
          setOnlyStep(undefined);
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
      onRunSetup={(step) => {
        setOnlyStep(step);
        setPhase("setup");
      }}
    />
  );
}

type Overlay =
  | { kind: "emulators"; focusId?: string; message?: string }
  | { kind: "files"; focusEmulatorId?: string; message?: string }
  | { kind: "diagnose"; context?: DiagnoseContext }
  | { kind: "install" }
  | { kind: "gameSources"; start?: "link" }
  | { kind: "users"; users: JfUser[] | null; error?: string }
  | { kind: "resume"; entry: XmbEntry; playlist?: XmbEntry[] }
  | { kind: "about" }
  | { kind: "bookmarkAdd" }
  | { kind: "bookmarkDelete"; id: string }
  | { kind: "webNotice"; id: string }
  | { kind: "import"; path: string; name: string }
  | { kind: "message"; title: string; lines: string[]; tone: "info" | "error" | "success" }
  | { kind: "setupStep"; step: number }
  | { kind: "series"; series: XmbEntry }
  | { kind: "movie"; movie: XmbEntry }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "covers" }
  | { kind: "assign"; entry: XmbEntry }
  | { kind: "assignments" }
  | { kind: "stremio"; entry: XmbEntry }
  | { kind: "stremioAddons" }
  | { kind: "search"; query?: string }
  | { kind: "player"; entry: XmbEntry; startSec: number; playlist?: XmbEntry[]; choice?: MovieChoice };

const jfConfigOf = (jellyfin: Settings["jellyfin"] | undefined) =>
  jellyfin && jellyfin.url.trim() && jellyfin.apiKey.trim() ? jellyfin : null;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Unerwarteter Fehler");

/** Auswahl „In den Spiele-Ordner legen“ im Dialog nach einem Download (leeres System = direkt in den Ordner). */
const AUTO_PLACE = "__auto";

/** Die Start-Animation läuft nur einmal pro App-Start (nicht erneut nach dem Setup-Assistenten). */
let bootHandled = false;

function Main({
  settings,
  onChangeSettings,
  onRunSetup,
}: {
  settings: Settings | null;
  onChangeSettings: (next: Settings) => void;
  onRunSetup: (onlyStep?: number) => void;
}) {
  const library = useGameLibrary(settings?.gamesDir, coversAuto(settings), settings?.gameSystems);
  // Hauptadresse oder (unterwegs, z. B. Tailscale) zweite Adresse – je nachdem, was gerade antwortet.
  const reachableJf = useReachableServer(settings?.jellyfin ?? null);
  const jellyfin = useJellyfinLibrary(reachableJf ?? undefined);
  // Eingetragene Addons plus Cinemeta (die Kataloge liefert in Stremio Cinemeta, Stream-Addons haben keine).
  const stremioAddons = useMemo(() => effectiveAddons(settings?.stremio), [settings?.stremio]);
  const stremio = useStremioLibrary(stremioAddons);
  useStremioAccountSync(settings?.stremio, (next) => settings && onChangeSettings({ ...settings, stremio: next }));
  const [searchHistory, setSearchHistory] = useState(loadSearchHistory);
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
    // Ein Spiel startet nicht: gleich die Diagnose mit Ursache und Behebung zeigen.
    onDiagnose: (context) => openOverlay({ kind: "diagnose", context }),
  });

  const jfConfig = jfConfigOf(reachableJf ?? undefined);
  const recentJf = useRecentJellyfin(jfConfig);
  const [recentGameIds, setRecentGameIds] = useState(loadRecentGames);
  // Beim ersten Aufbau startet das Menü auf „Zuletzt“, wenn dort voraussichtlich etwas steht.
  const [startCategory] = useState(() => (loadRecentGames().length > 0 || jfConfig ? "recent" : "movies"));
  // Start-Animation: einmal pro App-Start, wenn sie nicht abgeschaltet ist; in den Einstellungen auch zur Vorschau.
  const [booting, setBooting] = useState(() => {
    if (bootHandled) return false;
    bootHandled = true;
    const p = getUiPrefs();
    return p.bootAnimation && p.animations !== "off";
  });
  // Hintergrundmusik pausiert, solange ein Film läuft oder ein Spiel startet/läuft (und während der Start-Animation).
  useAmbientMusic({ suspended: booting || overlay?.kind === "player" || running.size > 0 || !!launcherOverlay });

  // Echte Jellyfin-Titel ersetzen die Demo-Einträge – aber nur, wenn überhaupt etwas geladen wurde.
  const hasJellyfinItems = jellyfin.status === "ok" && jellyfin.movies.length + jellyfin.series.length > 0;

  const ui = useUiPrefs();
  const displaySummary = `${THEMES.find((t) => t.id === ui.themeId)?.label ?? "Automatisch"} · Helligkeit ${Math.round(ui.brightness * 100)} %`;
  const motionSummary = ui.animations === "full" ? "Voll" : ui.animations === "reduced" ? "Reduziert" : "Aus";
  const soundSummary = ui.musicEnabled ? `Musik: ${MOODS.find((m) => m.id === ui.musicMood)?.label ?? ""} · Töne ${Math.round(ui.sfxVolume * 100)} %` : `Musik aus · Töne ${Math.round(ui.sfxVolume * 100)} %`;
  const assignmentCount = Object.keys(settings?.gameSystems ?? {}).length;
  const assignmentSummary = assignmentCount ? `${assignmentCount} von dir geändert` : "Alles automatisch erkannt";
  const emulatorSummary = useMemo(() => summarizeEmulators(emulators.statuses), [emulators.statuses]);
  // Echte Spiele der Bibliothek für die Diagnose (Demo-Einträge gibt es auf der Platte nicht).
  const diagnoseGames = useMemo<DiagnoseGame[]>(() => {
    const seen = new Set<string>();
    const out: DiagnoseGame[] = [];
    for (const e of library.categories.flatMap((c) => c.entries)) {
      const g = e.game;
      if (!g || g.mock || seen.has(g.path)) continue;
      seen.add(g.path);
      out.push({ title: e.title, path: g.path, system: g.system });
    }
    return out;
  }, [library.categories]);
  const filesSummary = useMemo(() => {
    const m = missingLabels(requirements.statuses);
    return requirements.loading ? "Wird geprüft …" : m.length ? `Fehlt: ${m.join(", ")}` : "Alles vorhanden";
  }, [requirements.statuses, requirements.loading]);
  const userName = settings?.jellyfin.userName || jellyfin.userName;

  const stremioAddonCount = settings?.stremio?.addons.length ?? 0;
  const stremioSummary = settings?.stremio?.account
    ? `${settings.stremio.account.email} · ${stremioAddonCount} Addon${stremioAddonCount === 1 ? "" : "s"}`
    : stremio.status === "idle"
      ? "Nicht eingerichtet"
      : `${stremioAddonCount} Addon${stremioAddonCount === 1 ? "" : "s"}`;
  // Die Spalte „Stremio“ ist der Einstieg (Suche, Konto & Addons); dahinter folgen die Kataloge wie auf der Stremio-Startseite.
  const stremioCategories = useMemo<XmbCategory[]>(() => {
    const status: XmbEntry[] =
      stremio.status === "idle"
        ? []
        : stremio.columns.length > 0
          ? []
          : [
              {
                id: "st-empty/stremio",
                title: stremio.status === "loading" ? "Lade Kataloge …" : "Keine Kataloge",
                subtitle: stremio.problems[0] ?? (stremio.status === "loading" ? undefined : "Die Addons liefern hier nichts"),
                description: "Konto und Addons verwaltest du unter „Konto & Addons“.",
                hue: 20,
              },
            ];
    const gateway: XmbCategory = {
      id: "stremio",
      label: "Stremio",
      icon: "livetv",
      entries: [
        { id: "st-search", title: "Suchen …", subtitle: "Filme und Serien in Stremio und Jellyfin", description: "Sucht in den Katalogen deiner Stremio-Addons und auf deinem Jellyfin-Server.", hue: 210, action: "open-search" },
        {
          id: "st-account",
          title: settings?.stremio?.account ? "Konto & Addons" : "Anmelden / Addons",
          subtitle: stremioSummary,
          description: "Melde dich mit deinem Stremio-Konto an, damit deine Addons und der Katalog wie in Stremio erscheinen, oder trage Addons von Hand ein.",
          hue: 20,
          action: "open-stremio",
        },
        ...status,
      ],
    };
    return [gateway, ...stremio.columns.map<XmbCategory>((c) => ({ id: c.id, label: c.label, icon: c.type === "movie" ? "movies" : "series", entries: c.entries }))];
  }, [stremio.status, stremio.columns, stremio.problems, settings?.stremio?.account, stremioSummary]);

  // Spalte hinter den Spiele-Systemen: eigene Links einfügen, Quellen und Downloads, BIOS/Emulatoren.
  const gameQueue = useDownloadQueue();
  const gameSourceCount = settings?.gameSources?.length ?? 0;
  const activeDownloads = gameQueue.filter((q) => q.state === "queued" || q.state === "running" || q.state === "verifying");
  const getGamesCategory = useMemo<XmbCategory>(
    () => ({
      id: "games-get",
      label: "Spiele laden",
      icon: "games",
      entries: [
        {
          id: "gg-link",
          title: "Link einfügen und laden",
          subtitle: "Spiel-Datei oder Liste von deiner Webseite",
          description: "Füge den Link zu einer Spiel-Datei ein (ISO, CHD, CUE/BIN, PKG, ZIP …): Die App lädt sie in den Spiele-Ordner, setzt abgebrochene Downloads fort und erkennt das System danach selbst. Zeigt der Link auf eine Seite mit mehreren Dateien, wählst du eine aus. Die Links suchst und bestätigst du selbst – lade nur Spiele, die du besitzt oder legal beziehen darfst.",
          hue: 140,
          action: "open-game-link",
        },
        {
          id: "gg-sources",
          title: "Quellen und Downloads",
          subtitle: activeDownloads.length
            ? `Lädt: ${activeDownloads[0].name}${activeDownloads.length > 1 ? ` (+${activeDownloads.length - 1})` : ""}`
            : gameSourceCount
              ? `${gameSourceCount} Quelle${gameSourceCount === 1 ? "" : "n"}`
              : "Noch keine Quelle",
          description: "Deine gespeicherten Quellen (eigene Webseite, NAS, Adressliste) und die laufenden Downloads mit Fortschritt.",
          hue: 175,
          action: "open-game-sources",
        },
        {
          id: "gg-files",
          title: "BIOS & Firmware",
          subtitle: filesSummary,
          description: "Zeigt, welche BIOS- und Firmware-Dateien die Emulatoren brauchen, mit Anleitung und Link. Die Dateien bringst du selbst mit.",
          hue: 40,
          action: "open-requirements",
        },
        {
          id: "gg-install",
          title: "Emulatoren einrichten",
          subtitle: emulatorSummary,
          description: "Lädt fehlende Emulatoren von den offiziellen Seiten der Projekte und richtet ein leeres System Schritt für Schritt ein.",
          hue: 210,
          action: "open-install",
        },
      ],
    }),
    [activeDownloads.length, activeDownloads[0]?.name, gameSourceCount, filesSummary, emulatorSummary],
  );

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
                    : e.action === "open-game-assignments"
                      ? { ...e, subtitle: assignmentSummary }
                    : e.action === "open-covers"
                      ? { ...e, subtitle: coversAuto(settings) ? "Automatisch laden: An" : "Automatisch laden: Aus" }
                    : e.action === "open-requirements"
                      ? { ...e, subtitle: filesSummary }
                    : e.action === "toggle-transcode"
                      ? { ...e, subtitle: alwaysTranscode ? "Immer vom Server umwandeln" : "Direkt, wenn möglich" }
                    : e.action === "open-stremio"
                      ? { ...e, subtitle: stremioSummary }
                    : e.action === "choose-jellyfin-user"
                      ? { ...e, subtitle: userName || (jfConfig ? "Automatisch" : "Nicht verbunden") }
                      : e,
            ),
          };
    });
    // „Zuletzt“: angefangene Filme/Folgen aus Jellyfin, dahinter die zuletzt gestarteten Spiele.
    const games = new Map(library.categories.flatMap((c) => c.entries).map((e) => [e.id, e] as const));
    const recentGames = recentGameIds.map((id) => games.get(id)).filter((e): e is XmbEntry => !!e);
    const recentEntries = [...recentJf.entries, ...recentGames];
    const bookmarks = (settings?.bookmarks ?? []).map<XmbEntry>((b) => ({
      id: `bm/${b.id}`,
      title: b.name,
      subtitle: hostOf(b.url),
      description: `${b.url} – öffnet in einem eigenen Fenster der App. △ löscht das Lesezeichen.`,
      hue: hueFromTitle(b.name),
    }));
    const searchEntries = searchHistory.map<XmbEntry>((q) => ({ id: `search-q/${q}`, title: q, subtitle: "Zuletzt gesucht", hue: hueFromTitle(q) }));
    const withRecent = base.map((cat) =>
      cat.id === "search" && searchEntries.length > 0
        ? { ...cat, entries: [...cat.entries, ...searchEntries] }
        : cat.id === "recent" && recentEntries.length > 0
        ? { ...cat, entries: recentEntries }
        : cat.id === "web"
          ? { ...cat, entries: [...bookmarks, ...cat.entries] }
          : cat,
    );
    // Stremio-Spalten (nur mit eingetragenen Addons) und danach die Spiele-Systeme (PS1, PS2, PS3 …) direkt hinter den Serien.
    const at = withRecent.findIndex((c) => c.id === "series") + 1;
    return [...withRecent.slice(0, at), ...stremioCategories, ...library.categories, getGamesCategory, ...withRecent.slice(at)];
  }, [stremioCategories, getGamesCategory, searchHistory, recentJf.entries, recentGameIds, library.categories, settings, hasJellyfinItems, jellyfin.movies, jellyfin.series, emulatorSummary, assignmentSummary, filesSummary, userName, jfConfig, alwaysTranscode, displaySummary, motionSummary, soundSummary]);

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

  /** Film: erst die Detailseite (Logo, Optionen), erst dort startet der Player. Demo-Filme öffnen dieselbe Seite. */
  const openMovie = useCallback((movie: XmbEntry) => openOverlay({ kind: "movie", movie }), [openOverlay]);

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

  const openBookmark = useCallback(
    async (id: string, notify?: (text: string) => void) => {
      const b = settings?.bookmarks?.find((x) => x.id === id);
      if (!b) return;
      try {
        await openWeb(b.url, b.name, settings?.gamesDir);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (notify) notify(text);
        else openOverlay({ kind: "message", title: "Seite lässt sich nicht öffnen", lines: [text], tone: "error" });
      }
    },
    [settings, openOverlay],
  );

  // Ein Spiele-Download aus „Einrichtung & Downloads“ ist fertig: Spiele-Ordner neu einlesen.
  const rescanGames = library.rescan;
  useEffect(() => onItemDone(() => rescanGames()), [rescanGames]);

  // Downloads aus dem Web-Fenster: danach fragen, in welches System die Datei gehört.
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void onWebDownload((e) => {
      if (e.state === "done" && e.path) setOverlay({ kind: "import", path: e.path, name: e.name });
      else if (e.state === "failed") setOverlay({ kind: "message", title: "Download fehlgeschlagen", lines: [`„${e.name}“ konnte nicht vollständig geladen werden.`], tone: "error" });
    }).then((fn) => (dead ? fn() : (off = fn)));
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  const onActivate = useCallback(
    (entry: XmbEntry, category: XmbCategory, notify: (text: string) => void) => {
      if (entry.action === "run-setup") onRunSetup();
      else if (entry.action === "open-server-settings") openOverlay({ kind: "setupStep", step: SETUP_STEP.jellyfin });
      else if (entry.action === "open-games-dir") openOverlay({ kind: "setupStep", step: SETUP_STEP.games });
      else if (entry.action === "open-about") openOverlay({ kind: "about" });
      else if (entry.action === "open-emulators") openOverlay({ kind: "emulators" });
      else if (entry.action === "open-requirements") openOverlay({ kind: "files" });
      else if (entry.action === "open-diagnose") openOverlay({ kind: "diagnose" });
      else if (entry.action === "open-install") openOverlay({ kind: "install" });
      else if (entry.action === "open-game-link") openOverlay({ kind: "gameSources", start: "link" });
      else if (entry.action === "open-game-sources") openOverlay({ kind: "gameSources" });
      else if (entry.action === "open-display-settings") openOverlay({ kind: "settings", section: "display" });
      else if (entry.action === "open-motion-settings") openOverlay({ kind: "settings", section: "motion" });
      else if (entry.action === "open-sound-settings") openOverlay({ kind: "settings", section: "sound" });
      else if (entry.action === "open-covers") openOverlay({ kind: "covers" });
      else if (entry.action === "open-game-assignments") openOverlay({ kind: "assignments" });
      else if (entry.action === "open-stremio") openOverlay({ kind: "stremioAddons" });
      else if (entry.action === "open-search") openOverlay({ kind: "search" });
      else if (entry.id.startsWith("search-q/")) openOverlay({ kind: "search", query: entry.id.slice("search-q/".length) });
      else if (entry.action === "choose-jellyfin-user") void openUsers();
      else if (entry.action === "toggle-transcode") {
        const next = !loadPrefs().alwaysTranscode;
        savePrefs({ alwaysTranscode: next ? true : undefined });
        setAlwaysTranscode(next);
        notify(next ? "Der Server wandelt jetzt immer um" : "Dateien werden direkt abgespielt, wenn möglich");
      }
      else if (entry.action === "add-bookmark") openOverlay({ kind: "bookmarkAdd" });
      else if (entry.id.startsWith("bm/")) {
        const id = entry.id.slice(3);
        if (localStorage.getItem("jellystation.webNotice") === "1") void openBookmark(id, notify);
        else openOverlay({ kind: "webNotice", id });
      } else if (entry.id.startsWith("jf-empty/") || entry.id.startsWith("st-empty/") || entry.id === "recent-empty") return; // Platzhalter einer leeren Spalte
      else if (entry.stremio) openOverlay({ kind: "stremio", entry });
      else if (entry.game?.unassigned) openOverlay({ kind: "assign", entry });
      else if (entry.game) {
        setRecentGameIds(rememberGame(entry.id));
        void launch(entry, notify);
      } else if (category.id === "recent") {
        if (entry.jellyfin?.type === "Movie") openMovie(entry);
        else play(entry);
      } else if (category.id === "movies") openMovie(entry);
      else if (category.id === "series") openSeries(entry);
      else void launch(entry, notify);
    },
    [launch, onRunSetup, openOverlay, openUsers, openSeries, openMovie, play, openBookmark],
  );

  // Kopfzeilen-Hinweis: Spiele-Vorschau und/oder Zustand der Jellyfin-Verbindung.
  const notice =
    [
      library.source === "mock" ? "Vorschau-Modus · Demo-Spiele" : null,
      library.scanNotice || null,
      jellyfin.status === "error" ? `Jellyfin: ${jellyfin.error}` : null,
      jellyfin.status === "ok" && !hasJellyfinItems ? "Jellyfin: keine Filme oder Serien gefunden" : null,
      jellyfin.truncated ? `Jellyfin: ${jellyfin.truncated}` : null,
      stremio.problems.length ? `Stremio: ${stremio.problems[0]}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;

  const close = () => openOverlay(null);

  // Vom Nutzer gewählter oder frisch installierter Emulator-Pfad (null = wieder automatisch suchen).
  const setEmulatorOverride = (id: string, path: string | null) => {
    if (!settings) return;
    const next = { ...(settings.emulators ?? {}) };
    if (path) next[id] = path;
    else delete next[id];
    onChangeSettings({ ...settings, emulators: next });
  };

  let layer: React.ReactNode = null;
  if (overlay?.kind === "player") {
    layer = (
      <Player
        entry={overlay.entry}
        jellyfin={jfConfig}
        startSec={overlay.startSec}
        playlist={overlay.playlist}
        choice={overlay.choice}
        onClose={(info) => {
          close();
          // Neue Wiedergabestände (Balken, Haken) sofort sichtbar machen.
          if (info.entry.jellyfin) {
            jellyfin.reload();
            recentJf.reload();
          }
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
  } else if (overlay?.kind === "setupStep") {
    layer = (
      <SetupWizard
        initial={settings}
        onlyStep={overlay.step}
        onCancel={close}
        onComplete={(saved) => {
          onChangeSettings(saved);
          close();
        }}
      />
    );
  } else if (overlay?.kind === "bookmarkAdd") {
    layer = (
      <BookmarkDialog
        onClose={close}
        onSave={(name, url) => {
          if (settings) {
            const id = Math.random().toString(36).slice(2, 10);
            onChangeSettings({ ...settings, bookmarks: [...(settings.bookmarks ?? []), { id, name, url }] });
          }
          close();
        }}
      />
    );
  } else if (overlay?.kind === "bookmarkDelete") {
    const target = settings?.bookmarks?.find((b) => b.id === overlay.id);
    layer = (
      <ConfirmDialog
        title="Lesezeichen löschen?"
        message={target ? `„${target.name}“ (${hostOf(target.url)}) wird aus der Liste entfernt.` : "Das Lesezeichen gibt es nicht mehr."}
        confirmLabel="Löschen"
        danger
        onCancel={close}
        onConfirm={() => {
          if (settings) onChangeSettings({ ...settings, bookmarks: (settings.bookmarks ?? []).filter((b) => b.id !== overlay.id) });
          close();
        }}
      />
    );
  } else if (overlay?.kind === "webNotice") {
    layer = (
      <ConfirmDialog
        title="Hinweis zum Web-Bereich"
        message={[
          "Die Seite öffnet in einem eigenen Fenster. Downloads landen im Ordner „Downloads“ deines Spiele-Ordners.",
          "Lade nur Spiele und Dateien, die du besitzt oder legal beziehen darfst (eigene Sicherungen, Homebrew, gemeinfreie Titel). Für Inhalte der Seiten ist JellyStation nicht verantwortlich.",
        ]}
        confirmLabel="Verstanden, öffnen"
        cancelLabel="Abbrechen"
        onCancel={close}
        onConfirm={() => {
          try {
            localStorage.setItem("jellystation.webNotice", "1");
          } catch {
            /* bewusst ignoriert */
          }
          close();
          void openBookmark(overlay.id);
        }}
      />
    );
  } else if (overlay?.kind === "import") {
    const archive = /\.(zip|7z|rar|tar|gz)$/i.test(overlay.name);
    layer = (
      <PopupList
        title={`„${overlay.name}“ geladen`}
        subtitle={archive ? "Archiv: muss vor dem Spielen entpackt werden" : "Wohin soll die Datei? Das System erkennt JellyStation selbst."}
        width="narrow"
        items={[
          { id: AUTO_PLACE, label: "In den Spiele-Ordner legen", detail: "Das System wird automatisch erkannt" },
          ...supportedFolderNames().map((s) => ({ id: s, label: `In den Ordner „${s}“`, detail: `→ ${s}/` })),
          { id: "", label: "Im Ordner „Downloads“ lassen", detail: "Wird trotzdem gefunden" },
        ]}
        onBack={close}
        onSelect={(choice) => {
          if (!choice) return close();
          const system = choice === AUTO_PLACE ? "" : choice;
          importGame(overlay.path, settings?.gamesDir, system).then(
            (dest) => {
              library.rescan();
              setOverlay({ kind: "message", title: "Übernommen", lines: [`Die Datei liegt jetzt in ${dest}.`, archive ? "Archive werden nicht automatisch entpackt – entpacke die Datei, damit das Spiel erscheint." : "Das Spiel erscheint im Menü."], tone: "success" });
            },
            (err) => setOverlay({ kind: "message", title: "Verschieben fehlgeschlagen", lines: [err instanceof Error ? err.message : String(err)], tone: "error" }),
          );
        }}
      />
    );
  } else if (overlay?.kind === "message") {
    layer = <MessageDialog title={overlay.title} lines={overlay.lines} kind={overlay.tone} onClose={close} />;
  } else if (overlay?.kind === "about") {
    layer = (
      <MessageDialog
        title="JellyStation"
        lines={[
          `Version ${APP_VERSION_LABEL}`,
          APP_COMMIT_SUBJECT ? `Letzte Änderung: ${APP_COMMIT_SUBJECT}` : "Ein Media-Hub im Stil der PS3-XrossMediaBar für Jellyfin und Spiele.",
          "Spiele, BIOS- und Firmware-Dateien werden nicht mitgeliefert. Nutze nur Inhalte, die du besitzt oder legal beziehen darfst.",
        ]}
        detail={[
          `Einstellungen: ${settings?.jellyfin.url ? "Jellyfin verbunden" : "kein Jellyfin-Server"}`,
          `Spiele-Ordner: ${settings?.gamesDir || "Standard / Demo"}`,
          "Quelltext und Anleitung: github.com/dconair/jellystation",
        ]}
        detailStart="top"
        onClose={close}
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
  } else if (overlay?.kind === "movie") {
    layer = (
      <MovieScreen
        movie={overlay.movie}
        jellyfin={jfConfig}
        onPlay={(movie, startSec, choice) => openOverlay({ kind: "player", entry: movie, startSec, choice })}
        onChanged={() => {
          jellyfin.reload();
          recentJf.reload();
        }}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "settings") {
    layer = <SettingsDialog section={overlay.section} onClose={close} onPreviewBoot={() => setBooting(true)} />;
  } else if (overlay?.kind === "assign" || overlay?.kind === "assignments") {
    const overrides = settings?.gameSystems ?? {};
    // Eine Änderung der Zuordnung speichert nur den Eintrag in den Einstellungen; die Datei bleibt, wo sie ist.
    const setOverrides = (next: Record<string, string>) => {
      if (!settings) return;
      onChangeSettings({ ...settings, gameSystems: Object.keys(next).length ? next : undefined });
    };
    if (overlay.kind === "assign") {
      const rel = overlay.entry.game?.rel;
      layer = settings && rel ? (
        <AssignSystemList
          entry={overlay.entry}
          override={overrides[rel]}
          onBack={close}
          onPick={(value) => {
            const next = { ...overrides };
            if (value === AUTO) delete next[rel];
            else next[rel] = value;
            setOverrides(next);
            close();
          }}
        />
      ) : (
        <MessageDialog
          title="Zuordnung nicht möglich"
          lines={["Die Zuordnung wird in den Einstellungen gespeichert. Schließe zuerst den Einrichtungsassistenten ab."]}
          kind="info"
          onClose={close}
        />
      );
    } else {
      layer = (
        <AssignmentsList
          overrides={overrides}
          onBack={close}
          onReset={(rel) => {
            const next = { ...overrides };
            delete next[rel];
            setOverrides(next);
          }}
          onResetAll={() => setOverrides({})}
        />
      );
    }
  } else if (overlay?.kind === "covers") {
    layer = (
      <CoverSettingsDialog
        auto={coversAuto(settings)}
        onChangeAuto={(auto) => settings && onChangeSettings({ ...settings, covers: { auto } })}
        library={library}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "stremio") {
    layer = (
      <StremioPicker
        entry={overlay.entry}
        addons={stremioAddons}
        onPlay={(entry) => openOverlay({ kind: "player", entry, startSec: 0 })}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "stremioAddons") {
    layer = (
      <StremioAddonsDialog
        stremio={settings?.stremio}
        onChange={(next) => settings && onChangeSettings({ ...settings, stremio: next })}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "search") {
    layer = (
      <SearchDialog
        initialQuery={overlay.query}
        jellyfin={jfConfig ? { url: jfConfig.url, apiKey: jfConfig.apiKey, userId: settings?.jellyfin.userId || jellyfin.userId } : null}
        addons={stremioAddons}
        onSearched={setSearchHistory}
        onPick={(entry) => {
          if (entry.stremio) openOverlay({ kind: "stremio", entry });
          else if (entry.jellyfin?.type === "Series") openSeries(entry);
          else if (entry.jellyfin?.type === "Movie") openMovie(entry);
          else play(entry);
        }}
        onClose={close}
      />
    );
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
  } else if (overlay?.kind === "diagnose") {
    layer = (
      <DiagnoseDialog
        emulators={emulators.statuses}
        refreshEmulators={emulators.refresh}
        biosDir={biosDirOf(biosDir)}
        gamesDir={settings?.gamesDir ?? ""}
        games={diagnoseGames}
        context={overlay.context}
        onOpenEmulators={(focusId) => openOverlay({ kind: "emulators", focusId })}
        onOpenFiles={(focusEmulatorId) => openOverlay({ kind: "files", focusEmulatorId })}
        onOpenGamesDir={() => openOverlay({ kind: "setupStep", step: SETUP_STEP.games })}
        onChanged={() => {
          void emulators.refresh();
          void requirements.refresh();
        }}
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
        onSetOverride={setEmulatorOverride}
        onRefresh={emulators.refresh}
        onClose={close}
      />
    );
  } else if (overlay?.kind === "gameSources") {
    layer = <GameSourcesDialog settings={settings} onChangeSettings={onChangeSettings} start={overlay.start} onClose={close} />;
  } else if (overlay?.kind === "install") {
    layer = (
      <InstallDialog
        settings={settings}
        onChangeSettings={onChangeSettings}
        emulators={emulators}
        requirements={requirements}
        onSetOverride={setEmulatorOverride}
        onOpenEmulators={(focusId) => openOverlay({ kind: "emulators", focusId })}
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
        inputEnabled={!overlay && !launcherOverlay && !booting}
        startCategoryId={startCategory}
        onSecondary={(entry) => {
          if (entry.id.startsWith("bm/")) openOverlay({ kind: "bookmarkDelete", id: entry.id.slice(3) });
          // △ auf einem Spiel: System ändern (Programme starten ohne Emulator und haben keins)
          else if (entry.game?.rel && (entry.game.system || entry.game.unassigned)) openOverlay({ kind: "assign", entry });
        }}
      />
      {layer}
      {launcherOverlay}
      {booting && <BootAnimation onDone={() => setBooting(false)} />}
      <UiEffects />
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
