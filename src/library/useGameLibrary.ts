import { useCallback, useEffect, useRef, useState } from "react";
import { coversSupported, startCoverJob, withCover, withoutCover } from "../art/coverService";
import type { CoverJob, CoverJobSummary, CoverRequest, CoverResult } from "../art/coverService";
import type { XmbCategory, XmbEntry } from "../data/types";
import { MOCK_BASE_DIR, MOCK_LISTING } from "./mockLibrary";
import { buildSystemCategories, scanGamesDir } from "./scanGames";

/** Stand der Cover-Suche im Hintergrund. */
export interface CoverProgress {
  running: boolean;
  done: number;
  total: number;
  found: number;
}

export interface GameLibrary {
  /** "loading" bis der Scan beim App-Start abgeschlossen ist. */
  source: "loading" | "disk" | "mock";
  categories: XmbCategory[];
  covers: CoverProgress;
  /**
   * Sucht jetzt für alle Spiele ohne Bild – auch solche, die schon als „nicht gefunden“ gemerkt sind, und auch
   * dann, wenn automatisches Laden ausgeschaltet ist (der Nutzer hat es ausdrücklich verlangt).
   */
  searchCovers: (onProgress?: (summary: CoverJobSummary) => void) => CoverJob | null;
  /** Bricht eine laufende Suche ab; schon gefundene Cover bleiben. */
  cancelCovers: () => void;
  /** Nach dem Leeren des Cache: aus dem Cache stammende Cover wieder durch Platzhalter ersetzen. */
  dropAutoCovers: () => void;
  /** Liest den Spiele-Ordner neu ein (z. B. nach einem Download). */
  rescan: () => void;
}

const IDLE: CoverProgress = { running: false, done: 0, total: 0, found: 0 };

/** Spiele ohne Bild: weder eigenes Bild neben dem Spiel noch schon geholtes Cover. Demo-Spiele zählen nie. */
const needsCover = (entry: XmbEntry) => Boolean(entry.game && !entry.game.mock && entry.art?.kind === "generated");

function requestsFor(categories: XmbCategory[]): CoverRequest[] {
  const out: CoverRequest[] = [];
  for (const category of categories) {
    for (const entry of category.entries) {
      if (needsCover(entry) && entry.game) {
        out.push({ id: entry.id, system: entry.game.system, path: entry.game.path, title: entry.title });
      }
    }
  }
  return out;
}

/** Wie viele echte Spiele es gibt und wie viele davon ein Bild haben (eigenes oder automatisches). */
export function countCovers(categories: readonly XmbCategory[]): { total: number; withCover: number } {
  let total = 0;
  let withCover = 0;
  for (const category of categories) {
    for (const entry of category.entries) {
      if (!entry.game || entry.game.mock) continue;
      total++;
      if (entry.art?.kind === "file") withCover++;
    }
  }
  return { total, withCover };
}

/** Ersetzt genau einen Eintrag; alle anderen Kategorien und Einträge behalten ihre Objekte (kein unnötiges Neuzeichnen). */
function mapEntry(categories: XmbCategory[], id: string, change: (entry: XmbEntry) => XmbEntry): XmbCategory[] {
  return categories.map((category) => {
    const at = category.entries.findIndex((e) => e.id === id);
    if (at < 0) return category;
    const entries = category.entries.slice();
    entries[at] = change(entries[at]);
    return { ...category, entries };
  });
}

/**
 * Scannt beim Start einmal den Basisordner; fällt andernfalls auf Demo-Daten zurück.
 *
 * Die Kategorien erscheinen sofort mit Platzhaltern. Fehlende Cover werden danach im Hintergrund nachgeladen
 * (zuerst aus dem Spiel selbst, mit `autoCovers` auch aus dem Netz, höchstens zwei Spiele gleichzeitig). Die
 * Einträge behalten ihre IDs; nur `art` und `artShape` ändern sich, die Kachel blendet das Bild ein.
 */
export function useGameLibrary(baseDir?: string, autoCovers = true): GameLibrary {
  const [library, setLibrary] = useState<{ source: GameLibrary["source"]; categories: XmbCategory[]; scan: number }>({
    source: "loading",
    categories: [],
    scan: 0,
  });
  const [progress, setProgress] = useState<CoverProgress>(IDLE);
  const [scanNonce, setScanNonce] = useState(0);
  const rescan = useCallback(() => setScanNonce((n) => n + 1), []);
  const latest = useRef(library);
  latest.current = library;
  const job = useRef<CoverJob | null>(null);
  /** Einträge, deren Bild vom Cover-Dienst stammt (nicht vom Nutzer). */
  const autoIds = useRef(new Set<string>());

  const stopJob = useCallback(() => {
    job.current?.cancel();
    job.current = null;
  }, []);

  const applyFound = useCallback((request: CoverRequest, result: CoverResult) => {
    autoIds.current.add(request.id);
    setLibrary((cur) => ({ ...cur, categories: mapEntry(cur.categories, request.id, (e) => withCover(e, result)) }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    stopJob();
    autoIds.current.clear();
    setProgress(IDLE);
    (async () => {
      try {
        const scan = await scanGamesDir(baseDir || undefined);
        if (!cancelled) {
          setLibrary((cur) => ({
            source: "disk",
            categories: buildSystemCategories(scan.listing, scan.baseDir, false),
            scan: cur.scan + 1,
          }));
        }
      } catch (err) {
        console.info("Spielebibliothek: Mockup-Modus –", err instanceof Error ? err.message : err);
        if (!cancelled) {
          setLibrary((cur) => ({
            source: "mock",
            categories: buildSystemCategories(MOCK_LISTING, MOCK_BASE_DIR, true),
            scan: cur.scan + 1,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
      stopJob();
    };
  }, [baseDir, stopJob, scanNonce]);

  // Cover im Hintergrund: nach jedem Scan und wenn „automatisch laden“ umgeschaltet wird.
  useEffect(() => {
    if (library.source !== "disk" || !coversSupported()) return;
    stopJob();
    const requests = requestsFor(latest.current.categories);
    if (requests.length === 0) {
      setProgress(IDLE);
      return;
    }
    setProgress({ running: true, done: 0, total: requests.length, found: 0 });
    const started = startCoverJob(requests, {
      online: autoCovers,
      onFound: applyFound,
      onProgress: (s) => setProgress({ running: s.done < s.total, done: s.done, total: s.total, found: s.found }),
    });
    job.current = started;
    void started.done.then((s) => {
      if (job.current === started) {
        job.current = null;
        setProgress({ running: false, done: s.done, total: s.total, found: s.found });
      }
    });
    return stopJob;
    // Nur der Scan und die Einstellung lösen eine Suche aus – neue Cover (categories) nicht.
  }, [library.scan, library.source, autoCovers, applyFound, stopJob]);

  const searchCovers = useCallback(
    (onProgress?: (summary: CoverJobSummary) => void): CoverJob | null => {
      if (latest.current.source !== "disk" || !coversSupported()) return null;
      stopJob();
      const requests = requestsFor(latest.current.categories);
      setProgress({ running: requests.length > 0, done: 0, total: requests.length, found: 0 });
      const started = startCoverJob(requests, {
        online: true,
        retry: true,
        onFound: applyFound,
        onProgress: (s) => {
          setProgress({ running: s.done < s.total, done: s.done, total: s.total, found: s.found });
          onProgress?.(s);
        },
      });
      job.current = started;
      void started.done.then((s) => {
        if (job.current === started) job.current = null;
        setProgress({ running: false, done: s.done, total: s.total, found: s.found });
      });
      return started;
    },
    [applyFound, stopJob],
  );

  const cancelCovers = useCallback(() => {
    stopJob();
    setProgress((p) => ({ ...p, running: false }));
  }, [stopJob]);

  const dropAutoCovers = useCallback(() => {
    stopJob();
    const ids = autoIds.current;
    if (ids.size === 0) return;
    setLibrary((cur) => {
      let categories = cur.categories;
      for (const id of ids) categories = mapEntry(categories, id, withoutCover);
      return { ...cur, categories };
    });
    ids.clear();
    setProgress(IDLE);
  }, [stopJob]);

  return { source: library.source, categories: library.categories, covers: progress, searchCovers, cancelCovers, dropAutoCovers, rescan };
}
