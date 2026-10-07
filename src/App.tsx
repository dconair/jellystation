import { useCallback, useEffect, useMemo, useState } from "react";
import { categories as baseCategories } from "./data/library";
import type { XmbCategory, XmbEntry } from "./data/types";
import { emptyLibraryEntry } from "./jellyfin/library";
import { useJellyfinLibrary } from "./jellyfin/useJellyfinLibrary";
import { useGameLauncher } from "./launcher/useGameLauncher";
import { useGameLibrary } from "./library/useGameLibrary";
import { loadSettings } from "./settings/settings";
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

  // `key` erzwingt nach dem Setup einen frischen Start des Menüs mit den neuen Werten.
  return (
    <Main
      key={settings?.completedAt}
      settings={settings}
      onRunSetup={() => setPhase("setup")}
    />
  );
}

function Main({ settings, onRunSetup }: { settings: Settings | null; onRunSetup: () => void }) {
  const library = useGameLibrary(settings?.gamesDir);
  const jellyfin = useJellyfinLibrary(settings?.jellyfin);
  const { running, launch } = useGameLauncher();

  // Echte Jellyfin-Titel ersetzen die Demo-Einträge – aber nur, wenn überhaupt etwas geladen wurde.
  const hasJellyfinItems = jellyfin.status === "ok" && jellyfin.movies.length + jellyfin.series.length > 0;

  const categories = useMemo<XmbCategory[]>(() => {
    const base = baseCategories.map((cat) => {
      if (hasJellyfinItems && (cat.id === "movies" || cat.id === "series")) {
        // Hat der Server nur Filme oder nur Serien, zeigt die andere Spalte das ehrlich an (keine Demo-Daten daneben).
        const real = cat.id === "movies" ? jellyfin.movies : jellyfin.series;
        return { ...cat, entries: real.length ? real : [emptyLibraryEntry(cat.id === "movies" ? "Movie" : "Series")] };
      }
      // Einstellungen: Server-Eintrag zeigt die gespeicherte Adresse.
      return cat.id !== "settings"
        ? cat
        : {
            ...cat,
            entries: cat.entries.map((e) =>
              e.id === "st1"
                ? { ...e, subtitle: settings?.jellyfin.url || "Nicht eingerichtet" }
                : e.id === "st-games" && settings?.gamesDir
                  ? { ...e, subtitle: settings.gamesDir }
                  : e,
            ),
          };
    });
    // Spiele-Systeme (PS1, PS2, PS3 …) landen direkt hinter den Serien.
    const at = base.findIndex((c) => c.id === "series") + 1;
    return [...base.slice(0, at), ...library.categories, ...base.slice(at)];
  }, [library.categories, settings, hasJellyfinItems, jellyfin.movies, jellyfin.series]);

  const onActivate = useCallback(
    (entry: XmbEntry, category: XmbCategory, notify: (text: string) => void) => {
      if (entry.action === "run-setup") onRunSetup();
      else if (entry.id.startsWith("jf-empty/")) return; // Platzhalter einer leeren Spalte
      else if (category.id === "movies" || category.id === "series") {
        notify("Wiedergabe folgt in einer späteren Version");
      } else void launch(entry, notify);
    },
    [launch, onRunSetup],
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

  return (
    <Xmb
      categories={categories}
      onActivate={onActivate}
      runningIds={running}
      notice={notice}
    />
  );
}
