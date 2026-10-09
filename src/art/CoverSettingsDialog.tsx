import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoverJob } from "./coverService";
import { clearCoverCache, coverCacheStats, coversSupported, formatBytes } from "./coverService";
import type { CacheStats } from "./coverService";
import { countCovers } from "../library/useGameLibrary";
import type { GameLibrary } from "../library/useGameLibrary";
import { ConfirmDialog, MessageDialog, PopupList } from "../ui/popup";
import type { PopupFooter, PopupItem } from "../ui/popup";

export interface CoverSettingsDialogProps {
  /** „Cover automatisch laden“ ist eingeschaltet. */
  auto: boolean;
  onChangeAuto: (auto: boolean) => void;
  library: Pick<GameLibrary, "source" | "categories" | "covers" | "searchCovers" | "cancelCovers" | "dropAutoCovers">;
  onClose: () => void;
  /** false = sichtbar, aber ohne Eingabe. */
  active?: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const OWN_IMAGES_HELP = [
  "Lege neben das Spiel ein Bild mit demselben Namen, z. B. „Gran Turismo 5.jpg“ oder „Gran Turismo 5.png“ neben „Gran Turismo 5.iso“.",
  "Auch die Unterordner „covers“, „media/covers“ und „images“ im Systemordner werden gefunden.",
  "Eigene Bilder haben immer Vorrang vor automatisch geladenen. Nach dem Ablegen genügt ein Neustart der App.",
];

/**
 * Einstellungen für Spiele-Cover: automatisches Laden an/aus, Suche anstoßen, Zustand des Cache.
 * Eigene Bilder neben dem Spiel gehen immer vor (siehe findCover in src/library/scanGames.ts).
 */
export function CoverSettingsDialog({ auto, onChangeAuto, library, onClose, active = true }: CoverSettingsDialogProps) {
  const [layer, setLayer] = useState<"clear" | "help" | null>(null);
  const [footer, setFooter] = useState<PopupFooter | null>(null);
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const alive = useRef(true);
  const manualJob = useRef<CoverJob | null>(null);
  const supported = coversSupported() && library.source === "disk";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshCache = useCallback(() => {
    if (!coversSupported()) return;
    coverCacheStats().then(
      (stats) => alive.current && setCache(stats),
      () => alive.current && setCache(null),
    );
  }, []);

  const running = library.covers.running;
  // Zahl der Bilder im Cache neu lesen, wenn eine Suche fertig ist oder Cover eingetroffen sind
  useEffect(() => {
    if (!running) refreshCache();
  }, [running, library.covers.found, refreshCache]);

  const counts = useMemo(() => countCovers(library.categories), [library.categories]);
  const missing = counts.total - counts.withCover;

  const search = () => {
    if (running) {
      library.cancelCovers();
      manualJob.current = null;
      setFooter({ text: "Suche abgebrochen", kind: "info" });
      return;
    }
    setFooter(null);
    const job = library.searchCovers();
    manualJob.current = job;
    void job?.done.then((summary) => {
      if (!alive.current || manualJob.current !== job) return;
      manualJob.current = null;
      if (summary.cancelled) return;
      if (summary.found > 0) setFooter({ text: `${plural(summary.found, "Cover", "Cover")} gefunden`, kind: "ok" });
      else if (summary.failed > 0 && summary.error) setFooter({ text: summary.error, kind: "error" });
      else setFooter({ text: "Keine neuen Cover gefunden", kind: "info" });
    });
  };

  const clear = async () => {
    setLayer(null);
    setClearing(true);
    try {
      const result = await clearCoverCache();
      library.dropAutoCovers();
      setFooter({ text: `${plural(result.removed, "Bild", "Bilder")} gelöscht (${formatBytes(result.bytes)})`, kind: "ok" });
    } catch (err) {
      setFooter({ text: typeof err === "string" ? err : err instanceof Error ? err.message : "Cache nicht geleert", kind: "error" });
    } finally {
      if (alive.current) setClearing(false);
      refreshCache();
    }
  };

  const items: PopupItem[] = [
    { id: "h-auto", label: "Laden", header: true },
    {
      id: "auto",
      label: "Cover automatisch laden",
      detail: "Dazu werden Spiel- und Systemname an thumbnails.libretro.com gesendet.",
      trailing: auto ? "An" : "Aus",
    },
    running
      ? {
          id: "search",
          label: "Suche läuft …",
          detail: `${library.covers.done} von ${library.covers.total} Spielen geprüft · ${plural(library.covers.found, "Cover", "Cover")} · ✕ bricht ab`,
          status: "busy",
        }
      : {
          id: "search",
          label: "Jetzt nach fehlenden Covern suchen",
          detail: !supported
            ? coversSupported()
              ? "Keine Spiele aus einem Ordner gefunden"
              : "Nur in der App möglich"
            : missing > 0
              ? `${plural(missing, "Spiel", "Spiele")} ohne Cover – auch bei ausgeschaltetem automatischem Laden`
              : "Alle Spiele haben ein Cover",
          disabled: !supported || missing === 0,
        },
    {
      id: "h-stats",
      label: !supported
        ? "Keine Spiele aus einem Ordner"
        : `${counts.withCover} von ${plural(counts.total, "Spiel", "Spielen")} mit Cover${cache ? ` · Cache ${formatBytes(cache.bytes)}` : ""}`,
      header: true,
    },
    {
      id: "clear",
      label: "Cache leeren",
      detail: cache
        ? cache.count > 0
          ? `${plural(cache.count, "geladenes Bild", "geladene Bilder")} (${formatBytes(cache.bytes)}) löschen – eigene Bilder bleiben`
          : "Nichts zu löschen"
        : "Löscht geladene Cover – eigene Bilder bleiben",
      disabled: clearing || !coversSupported() || (cache !== null && cache.bytes === 0),
    },
    {
      id: "own",
      label: "Eigene Bilder",
      detail: "Lege neben das Spiel ein gleichnamiges .jpg/.png – es hat Vorrang.",
    },
  ];

  return (
    <>
      <PopupList
        title="Cover & Grafiken"
        subtitle="Bilder für deine Spiele"
        width="wide"
        items={items}
        busy={running || clearing}
        active={active && layer === null}
        footer={footer ?? undefined}
        onSelect={(id) => {
          if (id === "auto") onChangeAuto(!auto);
          else if (id === "search") search();
          else if (id === "clear") setLayer("clear");
          else if (id === "own") setLayer("help");
        }}
        onBack={onClose}
      />
      {layer === "clear" && (
        <ConfirmDialog
          title="Cover-Cache leeren?"
          message={[
            "Alle automatisch geladenen Cover werden gelöscht und müssen bei Bedarf neu geholt werden.",
            "Bilder, die du selbst neben die Spiele gelegt hast, bleiben unberührt.",
          ]}
          confirmLabel="Leeren"
          danger
          onConfirm={() => void clear()}
          onCancel={() => setLayer(null)}
        />
      )}
      {layer === "help" && <MessageDialog title="Eigene Bilder" lines={OWN_IMAGES_HELP} onClose={() => setLayer(null)} />}
    </>
  );
}
