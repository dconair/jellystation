import { useCallback, useEffect, useMemo, useState } from "react";
import { categories as baseCategories } from "./data/library";
import type { XmbCategory, XmbEntry } from "./data/types";
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
  const { running, launch } = useGameLauncher();

  const categories = useMemo<XmbCategory[]>(() => {
    // Einstellungen: Server-Eintrag zeigt die gespeicherte Adresse.
    const base = baseCategories.map((cat) =>
      cat.id !== "settings"
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
          },
    );
    // Spiele-Systeme (PS1, PS2, PS3 …) landen direkt hinter den Serien.
    const at = base.findIndex((c) => c.id === "series") + 1;
    return [...base.slice(0, at), ...library.categories, ...base.slice(at)];
  }, [library.categories, settings]);

  const onActivate = useCallback(
    (entry: XmbEntry, _category: XmbCategory, notify: (text: string) => void) => {
      if (entry.action === "run-setup") onRunSetup();
      else void launch(entry, notify);
    },
    [launch, onRunSetup],
  );

  return (
    <Xmb
      categories={categories}
      onActivate={onActivate}
      runningIds={running}
      notice={library.source === "mock" ? "Vorschau-Modus · Demo-Spiele" : undefined}
    />
  );
}
