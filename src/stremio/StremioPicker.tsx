import { useEffect, useMemo, useRef, useState } from "react";
import type { XmbEntry } from "../data/types";
import { hueFromTitle } from "../jellyfin/library";
import { isAbortError } from "../jellyfin/errors";
import { MessageDialog, PopupList } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { findStreams, loadMeta } from "./resolve";
import type { Meta, MetaVideo, StreamResult, StremioAddonCfg } from "./types";

export interface StremioPickerProps {
  /** Der gewählte Titel aus der Stremio-Spalte (Film oder Serie). */
  entry: XmbEntry;
  addons: readonly StremioAddonCfg[];
  /** Ein Stream ist gewählt: der Eintrag trägt `stremio.streamUrl` und kann in den Player. */
  onPlay: (entry: XmbEntry) => void;
  onClose: () => void;
}

/** Eine abspielbare Einheit: der Film selbst oder eine Folge. */
interface Target {
  stremioId: string;
  title: string;
  subtitle?: string;
  art?: XmbEntry["art"];
  artShape?: XmbEntry["artShape"];
}

type Stage =
  | { kind: "loading"; text: string }
  | { kind: "error"; title: string; lines: string[] }
  | { kind: "seasons"; meta: Meta }
  | { kind: "episodes"; meta: Meta; season: number }
  | { kind: "streams"; meta: Meta | null; target: Target; result: StreamResult };

const seasonLabel = (n: number) => (n === 0 ? "Specials" : `Staffel ${n}`);
const pad = (n: number) => String(n).padStart(2, "0");

const dateFormat = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", year: "numeric" });
function releaseText(released?: string): string | undefined {
  if (!released) return undefined;
  const t = Date.parse(released);
  if (!Number.isFinite(t)) return undefined;
  return t > Date.now() ? `erscheint am ${dateFormat.format(t)}` : dateFormat.format(t);
}

function groupSeasons(videos: readonly MetaVideo[]): Map<number, MetaVideo[]> {
  const map = new Map<number, MetaVideo[]>();
  for (const v of videos) {
    const list = map.get(v.season) ?? [];
    list.push(v);
    map.set(v.season, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.episode - b.episode);
  return map;
}

/** Staffeln aufsteigend, die Specials (Staffel 0) ans Ende. */
const seasonOrder = (map: Map<number, MetaVideo[]>) => [...map.keys()].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));

/**
 * Weg vom Titel zum Stream: Filme fragen sofort die Stream-Addons, Serien zeigen erst Staffeln und Folgen.
 * ○ geht jeweils eine Stufe zurück, ✕ auf einem Stream startet den Player.
 */
export function StremioPicker({ entry, addons, onPlay, onClose }: StremioPickerProps) {
  const ref = entry.stremio;
  const [stage, setStage] = useState<Stage>({ kind: "loading", text: ref?.type === "series" ? "Lade Folgen …" : "Suche Streams …" });
  const work = useRef<AbortController | null>(null);

  const begin = () => {
    work.current?.abort();
    const ctl = new AbortController();
    work.current = ctl;
    return ctl;
  };
  useEffect(() => () => work.current?.abort(), []);

  const searchStreams = (meta: Meta | null, target: Target) => {
    if (!ref) return;
    const ctl = begin();
    setStage({ kind: "loading", text: "Suche Streams …" });
    findStreams(addons, ref.type, target.stremioId, ctl.signal).then(
      (result) => !ctl.signal.aborted && setStage({ kind: "streams", meta, target, result }),
      (err: unknown) => {
        if (ctl.signal.aborted || isAbortError(err)) return;
        setStage({ kind: "error", title: "Streams nicht abrufbar", lines: [err instanceof Error ? err.message : "Unerwarteter Fehler"] });
      },
    );
  };

  // Beim Öffnen: Serie → Meta laden, Film → gleich Streams suchen.
  useEffect(() => {
    if (!ref) return;
    if (ref.type === "movie") {
      searchStreams(null, { stremioId: ref.id, title: entry.title, subtitle: entry.subtitle, art: entry.art, artShape: entry.artShape });
      return;
    }
    const ctl = begin();
    loadMeta(addons, ref.addonId, "series", ref.id, ctl.signal).then(
      (meta) => {
        if (ctl.signal.aborted) return;
        const seasons = groupSeasons(meta.videos);
        if (seasons.size === 0) {
          setStage({ kind: "error", title: "Keine Folgen", lines: [`„${meta.name}“ hat laut Addon keine Folgenliste.`] });
        } else if (seasons.size === 1) {
          setStage({ kind: "episodes", meta, season: seasonOrder(seasons)[0] });
        } else {
          setStage({ kind: "seasons", meta });
        }
      },
      (err: unknown) => {
        if (ctl.signal.aborted || isAbortError(err)) return;
        setStage({ kind: "error", title: "Folgen nicht abrufbar", lines: [err instanceof Error ? err.message : "Unerwarteter Fehler"] });
      },
    );
    // Einmal pro geöffnetem Titel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  const seasons = useMemo(() => (stage.kind === "seasons" || stage.kind === "episodes" ? groupSeasons(stage.meta.videos) : null), [stage]);

  if (!ref) return null;

  if (stage.kind === "loading") {
    return <PopupList key="loading" title={entry.title} subtitle={entry.subtitle} width="narrow" items={[]} busy emptyText={stage.text} onSelect={() => undefined} onBack={onClose} />;
  }

  if (stage.kind === "error") {
    return <MessageDialog title={stage.title} lines={stage.lines} kind="error" onClose={onClose} />;
  }

  if (stage.kind === "seasons" && seasons) {
    const items: PopupItem[] = seasonOrder(seasons).map((n) => ({
      id: String(n),
      label: seasonLabel(n),
      detail: `${seasons.get(n)?.length ?? 0} Folgen`,
    }));
    return (
      <PopupList
        key="seasons"
        title={stage.meta.name}
        subtitle="Staffel wählen"
        width="narrow"
        items={items}
        onSelect={(id) => setStage({ kind: "episodes", meta: stage.meta, season: Number(id) })}
        onBack={onClose}
      />
    );
  }

  if (stage.kind === "episodes" && seasons) {
    const { meta, season } = stage;
    const episodes = seasons.get(season) ?? [];
    const items: PopupItem[] = episodes.map((v) => ({
      id: v.id,
      label: `${v.episode}. ${v.title}`,
      detail: releaseText(v.released),
      ...(v.thumbnail
        ? { art: { id: `thumb/${v.id}`, title: v.title, hue: hueFromTitle(v.title), art: { kind: "http" as const, url: v.thumbnail }, artShape: "landscape" as const } }
        : {}),
    }));
    return (
      <PopupList
        key={`season-${season}`}
        title={meta.name}
        subtitle={seasonLabel(season)}
        width="wide"
        items={items}
        onSelect={(id) => {
          const v = episodes.find((e) => e.id === id);
          if (!v) return;
          searchStreams(meta, {
            stremioId: v.id,
            title: v.title,
            subtitle: `${meta.name} · S${pad(v.season)} E${pad(v.episode)}`,
            art: v.thumbnail ? { kind: "http", url: v.thumbnail } : entry.art,
            artShape: v.thumbnail ? "landscape" : entry.artShape,
          });
        }}
        onBack={() => (seasons.size > 1 ? setStage({ kind: "seasons", meta }) : onClose())}
      />
    );
  }

  if (stage.kind === "streams") {
    const { result, target, meta } = stage;
    const items: PopupItem[] = result.playable.map((s, i) => ({
      id: String(i),
      label: s.name || s.addonName,
      detail: [s.description, s.risky ? "läuft evtl. nicht in der App" : ""].filter(Boolean).join(" · ") || undefined,
      trailing: s.addonName,
      status: s.risky ? ("warn" as const) : undefined,
    }));
    const notes: string[] = [];
    if (result.asked === 0) notes.push("Kein eingetragenes Addon bietet Streams für diesen Titel. Cinemeta liefert nur Kataloge – zum Abspielen braucht es ein Stream-Addon.");
    else if (result.playable.length === 0) notes.push("Keine abspielbaren Streams gefunden.");
    if (result.skipped > 0) notes.push(`${result.skipped} Stream${result.skipped === 1 ? "" : "s"} ausgeblendet (Torrent, YouTube oder externe Seite – die App spielt nur direkte Links).`);
    if (result.failedAddons.length > 0) notes.push(`Keine Antwort von: ${result.failedAddons.join(", ")}.`);
    return (
      <PopupList
        key="streams"
        title={target.title}
        subtitle={target.subtitle ?? "Stream wählen"}
        width="wide"
        items={items}
        emptyText="Keine abspielbaren Streams"
        footer={notes.length ? { text: notes.join(" "), kind: result.playable.length ? "info" : "warn" } : undefined}
        onSelect={(id) => {
          const stream = result.playable[Number(id)];
          if (!stream || !ref) return;
          onPlay({
            id: `st/${ref.addonId}/${ref.type}/${target.stremioId}`,
            title: target.title,
            ...(target.subtitle ? { subtitle: target.subtitle } : {}),
            hue: entry.hue,
            ...(target.art ? { art: target.art } : {}),
            ...(target.artShape ? { artShape: target.artShape } : {}),
            stremio: { addonId: ref.addonId, type: ref.type, id: target.stremioId, streamUrl: stream.url },
          });
        }}
        onBack={() => {
          if (meta && ref.type === "series") {
            const grouped = groupSeasons(meta.videos);
            const season = Number(target.stremioId.split(":")[1] ?? "");
            setStage({ kind: "episodes", meta, season: grouped.has(season) ? season : seasonOrder(grouped)[0] });
          } else {
            onClose();
          }
        }}
      />
    );
  }

  return null;
}
