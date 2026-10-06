import { useEffect, useState } from "react";
import type { XmbCategory } from "../data/types";
import { MOCK_BASE_DIR, MOCK_LISTING } from "./mockLibrary";
import { buildSystemCategories, scanGamesDir } from "./scanGames";

export interface GameLibrary {
  /** "loading" bis der Scan beim App-Start abgeschlossen ist. */
  source: "loading" | "disk" | "mock";
  categories: XmbCategory[];
}

/** Scannt beim Start einmal den Basisordner; fällt andernfalls auf Demo-Daten zurück. */
export function useGameLibrary(baseDir?: string): GameLibrary {
  const [library, setLibrary] = useState<GameLibrary>({ source: "loading", categories: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const scan = await scanGamesDir(baseDir || undefined);
        if (!cancelled) {
          setLibrary({ source: "disk", categories: buildSystemCategories(scan.listing, scan.baseDir, false) });
        }
      } catch (err) {
        console.info("Spielebibliothek: Mockup-Modus –", err instanceof Error ? err.message : err);
        if (!cancelled) {
          setLibrary({
            source: "mock",
            categories: buildSystemCategories(MOCK_LISTING, MOCK_BASE_DIR, true),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseDir]);

  return library;
}
