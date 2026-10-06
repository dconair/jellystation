import { useCallback, useMemo } from "react";
import { categories as baseCategories } from "./data/library";
import type { XmbCategory, XmbEntry } from "./data/types";
import { useGameLauncher } from "./launcher/useGameLauncher";
import { useGameLibrary } from "./library/useGameLibrary";
import { Xmb } from "./xmb/Xmb";

export default function App() {
  const library = useGameLibrary();
  const { running, launch } = useGameLauncher();

  // Spiele-Systeme (PS1, PS2, PS3 …) landen direkt hinter den Serien.
  const categories = useMemo<XmbCategory[]>(() => {
    const at = baseCategories.findIndex((c) => c.id === "series") + 1;
    return [...baseCategories.slice(0, at), ...library.categories, ...baseCategories.slice(at)];
  }, [library.categories]);

  const onActivate = useCallback(
    (entry: XmbEntry, _category: XmbCategory, notify: (text: string) => void) => {
      void launch(entry, notify);
    },
    [launch],
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
