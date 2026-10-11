import { useEffect, useMemo, useRef, useState } from "react";
import type { XmbEntry } from "../data/types";
import { isAbortError } from "../jellyfin/errors";
import { searchJellyfin } from "../jellyfin/library";
import { OverlayFrame, PopupList, useOverlayInput } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { searchStremio } from "../stremio/search";
import type { StremioAddonCfg } from "../stremio/types";
import { playSfx } from "../xmb/sound";
import "../web/web.css";
import { rememberSearch } from "./history";

export interface SearchDialogProps {
  /** Vorgabe im Suchfeld (z. B. aus dem Verlauf); mit Vorgabe startet die Suche sofort. */
  initialQuery?: string;
  /** Jellyfin-Zugang; null = nicht eingerichtet, dann sucht nur Stremio. */
  jellyfin: { url: string; apiKey: string; userId?: string } | null;
  /** Wirksame Stremio-Addons (leer = keine Stremio-Suche). */
  addons: readonly StremioAddonCfg[];
  /** Ein Treffer wurde gewählt (Jellyfin-Film/-Serie oder Stremio-Titel). */
  onPick: (entry: XmbEntry) => void;
  /** Der Suchverlauf hat sich geändert (neuester Begriff zuerst). */
  onSearched?: (history: string[]) => void;
  onClose: () => void;
}

interface Results {
  query: string;
  groups: { title: string; entries: XmbEntry[] }[];
  notes: string[];
}

/**
 * Suche in Jellyfin und in den Stremio-Addons: Suchbegriff eingeben (Enter), dann die Trefferliste nach Quelle und Typ.
 * ○ in der Trefferliste geht zurück zum Suchfeld, ○ im Suchfeld schließt.
 */
export function SearchDialog({ initialQuery = "", jellyfin, addons, onPick, onSearched, onClose }: SearchDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [stage, setStage] = useState<{ kind: "form" } | { kind: "loading" } | { kind: "results"; results: Results }>(
    initialQuery.trim() ? { kind: "loading" } : { kind: "form" },
  );
  const ref = useRef<HTMLInputElement>(null);
  const work = useRef<AbortController | null>(null);
  useEffect(() => () => work.current?.abort(), []);

  const run = (text: string) => {
    const q = text.trim();
    if (!q) return;
    onSearched?.(rememberSearch(q));
    work.current?.abort();
    const ctl = new AbortController();
    work.current = ctl;
    setStage({ kind: "loading" });
    const jf = jellyfin
      ? searchJellyfin(jellyfin.url, jellyfin.apiKey, q, ctl.signal, jellyfin.userId).then(
          (r) => ({ ok: true as const, ...r }),
          (err: unknown) => {
            if (isAbortError(err)) throw err;
            return { ok: false as const, error: err instanceof Error ? err.message : "Fehler" };
          },
        )
      : Promise.resolve(null);
    const st = addons.length ? searchStremio(addons, q, ctl.signal) : Promise.resolve(null);
    Promise.all([jf, st]).then(
      ([j, s]) => {
        if (ctl.signal.aborted) return;
        const groups: Results["groups"] = [];
        const notes: string[] = [];
        if (j?.ok) {
          groups.push({ title: "Jellyfin · Filme", entries: j.movies }, { title: "Jellyfin · Serien", entries: j.series });
        } else if (j) {
          notes.push(`Jellyfin: ${j.error}.`);
        }
        if (s) {
          groups.push({ title: "Stremio · Filme", entries: s.movies }, { title: "Stremio · Serien", entries: s.series });
          if (s.asked === 0) notes.push("Kein Stremio-Addon bietet eine Suche an.");
          if (s.failedAddons.length) notes.push(`Keine Antwort von: ${s.failedAddons.join(", ")}.`);
        }
        if (!jellyfin && !addons.length) notes.push("Weder Jellyfin noch Stremio sind eingerichtet.");
        setStage({ kind: "results", results: { query: q, groups: groups.filter((g) => g.entries.length > 0), notes } });
      },
      (err: unknown) => {
        if (ctl.signal.aborted || isAbortError(err)) return;
        setStage({ kind: "results", results: { query: q, groups: [], notes: [err instanceof Error ? err.message : "Unerwarteter Fehler"] } });
      },
    );
  };

  // Mit Vorgabe (Verlauf) sofort suchen.
  useEffect(() => {
    if (initialQuery.trim()) run(initialQuery);
    // einmal beim Öffnen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stage.kind === "form") ref.current?.focus();
  }, [stage.kind]);

  useOverlayInput({ active: stage.kind === "form", onAction: (a) => a === "back" && onClose() });

  const flat = useMemo(() => {
    if (stage.kind !== "results") return new Map<string, XmbEntry>();
    return new Map(stage.results.groups.flatMap((g) => g.entries).map((e) => [e.id, e] as const));
  }, [stage]);

  if (stage.kind === "form") {
    return (
      <OverlayFrame onBack={onClose} keyboard={false}>
        <form
          className="pop-panel pop-panel--normal web-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) run(query);
            else playSfx("error");
          }}
        >
          <header className="pop-head">
            <div className="pop-head__text">
              <h2 className="pop-title">Suche</h2>
              <p className="pop-subtitle">
                {[jellyfin ? "Jellyfin" : "", addons.length ? "Stremio" : ""].filter(Boolean).join(" und ") || "Nichts eingerichtet"}
              </p>
            </div>
          </header>
          <div className="web-form__body">
            <label>
              <span>Titel</span>
              <input
                ref={ref}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Film oder Serie …"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
              />
            </label>
          </div>
          <footer className="web-form__actions">
            <button type="button" className="web-btn" onClick={onClose}>
              Abbrechen
            </button>
            <button type="submit" className="web-btn web-btn--primary" disabled={!query.trim()}>
              Suchen
            </button>
          </footer>
        </form>
      </OverlayFrame>
    );
  }

  if (stage.kind === "loading") {
    return <PopupList key="loading" title="Suche" subtitle={`„${query.trim()}“`} width="narrow" items={[]} busy emptyText="Suche läuft …" onSelect={() => undefined} onBack={() => setStage({ kind: "form" })} />;
  }

  const { results } = stage;
  const items: PopupItem[] = results.groups.flatMap((g) => [
    { id: `h/${g.title}`, label: g.title, header: true },
    ...g.entries.map<PopupItem>((e) => ({ id: e.id, label: e.title, detail: e.subtitle, art: e })),
  ]);
  const total = results.groups.reduce((n, g) => n + g.entries.length, 0);
  return (
    <PopupList
      key="results"
      title={`„${results.query}“`}
      subtitle={total ? `${total} Treffer` : "Keine Treffer"}
      width="wide"
      items={items}
      emptyText="Nichts gefunden"
      footer={results.notes.length ? { text: results.notes.join(" "), kind: total ? "info" : "warn" } : undefined}
      onSelect={(id) => {
        const entry = flat.get(id);
        if (entry) onPick(entry);
      }}
      onBack={() => {
        setQuery(results.query);
        setStage({ kind: "form" });
      }}
    />
  );
}
