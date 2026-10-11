import { useEffect, useRef, useState } from "react";
import { GAMES_BASE_DIR } from "../config/games";
import { isTauri } from "../platform";
import { supportedFolderNames } from "../emulators/catalog";
import type { Settings } from "../settings/settings";
import { ConfirmDialog, MessageDialog, PopupList, ProgressDialog } from "../ui/popup";
import type { PopupItem, PopupStatus } from "../ui/popup";
import { errorText } from "./backend";
import { cancelItem, enqueue, removeItem, retryItem, useDownloadQueue } from "./downloadQueue";
import type { QueueItem } from "./downloadQueue";
import { FormDialog } from "./FormDialog";
import { allowedHostsOf, foreignHosts, hostOf, isGameFileUrl, loadListing, nameFromUrl, normalizeSourceUrl } from "./gameSources";
import type { GameSource, RemoteGame } from "./gameSources";
import { formatMB } from "./emulatorInstall";

export interface GameSourcesDialogProps {
  settings: Settings | null;
  onChangeSettings: (next: Settings) => void;
  onClose: () => void;
  active?: boolean;
  /** "link" öffnet gleich die Eingabe „Link einfügen und laden“ (Spiele-Spalte im Menü). */
  start?: "link";
}

type Layer =
  | { kind: "add" }
  | { kind: "link" }
  | { kind: "addSystem"; name: string; url: string }
  | { kind: "games"; source: GameSource; games: RemoteGame[] }
  | { kind: "item"; id: string }
  | { kind: "message"; tone: "info" | "error" | "success"; title: string; lines: string[] }
  | { kind: "confirm"; title: string; message: string[]; confirmLabel: string; danger?: boolean; onConfirm: () => void };

const AUTO = "__auto__";

const QUEUE_STATUS: Record<QueueItem["state"], PopupStatus | undefined> = {
  queued: "busy",
  running: "busy",
  verifying: "busy",
  done: "ok",
  failed: "error",
  cancelled: "warn",
};

const queueDetail = (q: QueueItem): string => {
  const where = `→ ${q.system || "Spiele-Ordner"}`;
  switch (q.state) {
    case "queued":
      return `Wartet · ${where}`;
    case "running":
      return `${q.total ? `${formatMB(q.received)} von ${formatMB(q.total)}` : formatMB(q.received)} · ${where}`;
    case "verifying":
      return `Wird geprüft · ${where}`;
    case "done":
      return `Fertig${q.message ? ` (${q.message})` : ""} · ${where}`;
    default:
      return q.message ?? "";
  }
};

/** Eigene Spiele-Quellen verwalten und Spiele von dort in den Spiele-Ordner laden. */
export function GameSourcesDialog({ settings, onChangeSettings, onClose, active = true, start }: GameSourcesDialogProps) {
  const [layers, setLayers] = useState<Layer[]>(start === "link" ? [{ kind: "link" }] : []);
  const [loading, setLoading] = useState<string | null>(null);
  const queue = useDownloadQueue();
  const loadCtl = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadCtl.current?.abort();
    };
  }, []);

  const sources = settings?.gameSources ?? [];
  const top = layers[layers.length - 1];
  const push = (l: Layer) => setLayers((ls) => [...ls, l]);
  const pop = () => setLayers((ls) => ls.slice(0, -1));
  const message = (tone: "info" | "error" | "success", title: string, lines: string[]) => push({ kind: "message", tone, title, lines });
  const gamesRoot = (settings?.gamesDir?.trim() || GAMES_BASE_DIR).replace(/[\\/]+$/, "");

  const saveSources = (next: GameSource[]) => {
    if (settings) onChangeSettings({ ...settings, gameSources: next.length ? next : undefined });
  };

  const openSource = async (source: GameSource) => {
    const ctl = new AbortController();
    loadCtl.current = ctl;
    setLoading(source.name);
    try {
      const games = await loadListing(source, ctl.signal);
      if (!mounted.current) return;
      setLoading(null);
      const foreign = foreignHosts(source, games);
      if (foreign.length) {
        push({
          kind: "confirm",
          title: "Weitere Server in der Liste",
          message: [
            `Die Liste verweist auf andere Server: ${foreign.join(", ")}.`,
            "Nur wenn du diesen Servern vertraust, lädt die App von dort. Sonst werden diese Einträge übersprungen.",
          ],
          confirmLabel: "Vertrauen",
          onConfirm: () => {
            const trusted = { ...source, trustedHosts: [...new Set([...(source.trustedHosts ?? []), ...foreign])] };
            saveSources(sources.map((s) => (s.id === source.id ? trusted : s)));
            push({ kind: "games", source: trusted, games });
          },
        });
        return;
      }
      push({ kind: "games", source, games });
    } catch (err) {
      if (!mounted.current || ctl.signal.aborted) return;
      setLoading(null);
      message("error", `${source.name}: Liste nicht geladen`, [errorText(err)]);
    }
  };

  /** `system` ist nur ein Unterordner-Hinweis; ohne ihn landet die Datei direkt im Spiele-Ordner (das System wird dort automatisch erkannt). */
  const startDownload = (source: GameSource, game: RemoteGame, system: string | undefined) => {
    const hosts = allowedHostsOf(source);
    if (!hosts.includes(hostOf(game.url))) {
      message("error", "Server nicht freigegeben", [`„${hostOf(game.url)}“ gehört nicht zu dieser Quelle. Öffne die Quelle erneut und bestätige den Server, falls du ihm vertraust.`]);
      return;
    }
    enqueue({ name: game.name, url: game.url, system: system ?? "", destDir: system ? `${gamesRoot}/${system}` : gamesRoot, allowedHosts: hosts });
    message("success", "Zur Download-Liste hinzugefügt", [
      `${game.name} wird in ${system ? `den Ordner „${system}“ im Spiele-Ordner` : "den Spiele-Ordner"} geladen${system ? "" : "; das System erkennt die App danach selbst"}. Den Fortschritt siehst du in der Liste „Downloads“, auch wenn du dieses Fenster schließt.`,
    ]);
  };

  /** Ein eingefügter Link: eine Spiel-Datei wird sofort geladen, eine Liste (Verzeichnisseite, Adressen, JSON) wird zur Auswahl geöffnet. */
  const submitLink = (rawUrl: string) => {
    const url = normalizeSourceUrl(rawUrl)!;
    if (!isTauri()) {
      message("info", "Nur in der Desktop-App", ["Das Laden von Spielen funktioniert nur in der Desktop-App, nicht im Browser."]);
      return;
    }
    if (isGameFileUrl(url)) {
      const game: RemoteGame = { name: nameFromUrl(url), url };
      startDownload({ id: "link", name: hostOf(url), url }, game, undefined);
    } else {
      void openSource({ id: `tmp-${Date.now().toString(36)}`, name: hostOf(url), url });
    }
  };

  const downloads = queue;
  const mainItems: PopupItem[] = [];
  if (downloads.length) {
    mainItems.push({ id: "h-dl", label: "Downloads", header: true });
    for (const q of downloads) {
      mainItems.push({
        id: `dl:${q.id}`,
        label: q.name,
        detail: queueDetail(q),
        status: QUEUE_STATUS[q.state],
        progress: q.state === "running" && q.total ? q.received / q.total : q.state === "done" ? 1 : undefined,
      });
    }
  }
  mainItems.push({ id: "h-src", label: "Meine Quellen", header: true });
  for (const s of sources) mainItems.push({ id: `src:${s.id}`, label: s.name, detail: `${hostOf(s.url)}${s.system ? ` · Unterordner ${s.system}` : " · direkt in den Spiele-Ordner"}` });
  mainItems.push({ id: "add", label: "Quelle hinzufügen …", detail: "Eigene Webseite, NAS oder Datei mit Adressen" });

  let overlay: React.ReactNode = null;
  if (top?.kind === "games") {
    const { source, games } = top;
    const allowed = new Set(allowedHostsOf(source));
    const gameItems: PopupItem[] = games.map((g, i) => ({
      id: `g:${i}`,
      label: g.name,
      detail: allowed.has(hostOf(g.url)) ? (g.system ?? source.system ?? "Spiele-Ordner") : `Anderer Server (${hostOf(g.url)}) – nicht freigegeben`,
      disabled: !allowed.has(hostOf(g.url)),
      trailing: g.size ? formatMB(g.size) : undefined,
    }));
    overlay = (
      <PopupList
        key={`games:${source.id}`}
        title={source.name}
        subtitle={`${games.length} Datei${games.length === 1 ? "" : "en"} gefunden`}
        width="wide"
        items={gameItems}
        active={active && top === layers[layers.length - 1]}
        footer={{ text: "Lade nur Spiele, die du besitzt oder legal beziehen darfst. ✕ lädt die Datei in den Spiele-Ordner.", kind: "info" }}
        onSelect={(id) => {
          const game = games[Number(id.slice(2))];
          if (!game) return;
          startDownload(source, game, game.system ?? source.system);
        }}
        onAlt={
          sources.some((x) => x.id === source.id)
            ? undefined
            : () => {
                saveSources([...sources, { ...source, name: hostOf(source.url) }]);
                message("success", "Quelle gespeichert", [`„${hostOf(source.url)}“ steht jetzt unter „Meine Quellen“.`]);
              }
        }
        altLabel="Als Quelle merken"
        onBack={pop}
      />
    );
  } else if (top?.kind === "addSystem") {
    const { name, url } = top;
    overlay = (
      <PopupList
        key="addSystem"
        title="Wohin sollen die Spiele?"
        subtitle="Das System erkennt die App danach selbst – ein Unterordner ist nur ein zusätzlicher Hinweis"
        width="normal"
        items={[{ id: AUTO, label: "Direkt in den Spiele-Ordner", detail: "Empfohlen" }, ...supportedFolderNames().map((n) => ({ id: n, label: `Unterordner „${n}“` , detail: undefined }))]}
        onSelect={(id) => {
          const source: GameSource = { id: `src-${Date.now().toString(36)}`, name, url, ...(id === AUTO ? {} : { system: id }) };
          saveSources([...sources, source]);
          setLayers([]);
        }}
        onBack={pop}
      />
    );
  } else if (top?.kind === "item") {
    const q = queue.find((x) => x.id === top.id);
    if (q) {
      const acts: PopupItem[] = [];
      if (q.state === "running" || q.state === "verifying" || q.state === "queued") acts.push({ id: "cancel", label: "Abbrechen", detail: "Das Teilstück bleibt liegen und lässt sich fortsetzen" });
      if (q.state === "failed" || q.state === "cancelled") acts.push({ id: "retry", label: q.partPath ? "Fortsetzen" : "Erneut versuchen" });
      if (q.state === "done") acts.push({ id: "remove", label: "Aus der Liste entfernen", detail: q.path });
      if (q.state === "failed" || q.state === "cancelled") acts.push({ id: "discard", label: "Verwerfen und Teilstück löschen" });
      overlay = (
        <PopupList
          key={`item:${q.id}`}
          title={q.name}
          subtitle={queueDetail(q)}
          width="normal"
          items={acts}
          active={active && top === layers[layers.length - 1]}
          footer={q.state === "failed" ? { text: q.message ?? "", kind: "error" } : undefined}
          onSelect={(id) => {
            if (id === "cancel") cancelItem(q.id);
            else if (id === "retry") retryItem(q.id);
            else if (id === "remove") removeItem(q.id);
            else if (id === "discard") removeItem(q.id, true);
            pop();
          }}
          onBack={pop}
        />
      );
    }
  }

  return (
    <>
      {!(start === "link" && layers.length === 1 && top?.kind === "link") && (
      <PopupList
        key="sources-main"
        title="Spiele-Quellen und Downloads"
        subtitle={`Ziel: ${gamesRoot}`}
        width="wide"
        items={mainItems}
        active={active && !top && !loading}
        footer={{ text: "Die App bringt keine Quellen mit: Du trägst nur Adressen ein, die dir gehören oder die du nutzen darfst. △ löscht eine Quelle.", kind: "info" }}
        onSelect={(id) => {
          if (id === "add") push({ kind: "add" });
          else if (id.startsWith("src:")) {
            const s = sources.find((x) => x.id === id.slice(4));
            if (s) void openSource(s);
          } else if (id.startsWith("dl:")) push({ kind: "item", id: id.slice(3) });
        }}
        onAlt={(id) => {
          if (!id?.startsWith("src:")) return;
          const s = sources.find((x) => x.id === id.slice(4));
          if (!s) return;
          push({
            kind: "confirm",
            title: "Quelle löschen?",
            message: [`„${s.name}“ wird aus der Liste entfernt. Bereits geladene Spiele bleiben im Spiele-Ordner.`],
            confirmLabel: "Löschen",
            danger: true,
            onConfirm: () => saveSources(sources.filter((x) => x.id !== s.id)),
          });
        }}
        altLabel="Löschen"
        onBack={onClose}
      />
      )}
      {overlay}
      {top?.kind === "add" && (
        <FormDialog
          title="Spiele-Quelle hinzufügen"
          subtitle="Deine Webseite, dein NAS oder eine Datei mit Adressen"
          fields={[
            { key: "name", label: "Name", placeholder: "z. B. Mein Server", maxLength: 60 },
            { key: "url", label: "Adresse", placeholder: "https://… (Datei, Verzeichnisseite oder Adressliste)" },
          ]}
          note="Erkannt werden: eine einzelne Spiel-Datei, eine Verzeichnisseite deines Webservers, eine Textdatei mit einer Adresse pro Zeile oder JSON. Lade nur Spiele, die du besitzt oder legal beziehen darfst."
          submitLabel="Weiter"
          validate={(v) => (normalizeSourceUrl(v.url) ? null : "Bitte eine gültige Adresse eintragen (z. B. https://meine-seite.de/spiele/)")}
          onSubmit={(v) => {
            const url = normalizeSourceUrl(v.url)!;
            pop();
            push({ kind: "addSystem", name: v.name.trim() || hostOf(url), url });
          }}
          onClose={pop}
        />
      )}
      {top?.kind === "link" && (
        <FormDialog
          title="Link einfügen und laden"
          subtitle="Direkter Link zu einer Spiel-Datei oder zu einer Seite mit einer Liste"
          fields={[{ key: "url", label: "Link", placeholder: "https://… (Datei, Verzeichnisseite oder Adressliste)" }]}
          note="Ein Link zu einer Spiel-Datei (ISO, CHD, CUE/BIN, PKG, ZIP …) wird sofort in den Spiele-Ordner geladen und das System danach automatisch erkannt. Bei einer Seite mit mehreren Dateien suchst du dir die Datei aus. Lade nur Spiele, die du besitzt oder legal beziehen darfst."
          submitLabel="Laden"
          validate={(v) => (normalizeSourceUrl(v.url) ? null : "Bitte einen gültigen Link eintragen (z. B. https://meine-seite.de/spiel.iso)")}
          onSubmit={(v) => {
            pop();
            submitLink(v.url);
          }}
          onClose={() => (layers.length === 1 && start === "link" ? onClose() : pop())}
        />
      )}
      {top?.kind === "message" && <MessageDialog title={top.title} lines={top.lines} kind={top.tone} onClose={pop} />}
      {top?.kind === "confirm" && (
        <ConfirmDialog
          title={top.title}
          message={top.message}
          confirmLabel={top.confirmLabel}
          danger={top.danger}
          onConfirm={() => {
            pop();
            top.onConfirm();
          }}
          onCancel={pop}
        />
      )}
      {loading && <ProgressDialog title={loading} status="Liste wird geladen …" progress={null} onCancel={() => loadCtl.current?.abort() ?? setLoading(null)} />}
    </>
  );
}
