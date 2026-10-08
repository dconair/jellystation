// TEMPORÄR: Galerie zum Prüfen von src/ui/popup (wird nach dem Test gelöscht).
import "@fontsource-variable/source-sans-3";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { categories } from "../../data/library";
import type { XmbEntry } from "../../data/types";
import { Xmb } from "../../xmb/Xmb";
import "../../index.css";
import { ConfirmDialog, MessageDialog, OverlayFrame, PopupList, ProgressDialog, useOverlayInput } from "./index";
import type { PopupItem } from "./index";

declare global {
  interface Window {
    __log: string[];
    __g: Record<string, any>;
  }
}
window.__log = [];
window.__g = {};
const log = (m: string) => {
  window.__log.push(m);
};

const params = new URLSearchParams(location.search);
const scenario = params.get("s") ?? "basic";
const bg = params.get("bg") ?? "xmb";

const cover = (id: string, title: string, hue: number, shape: "landscape" | "poster" = "landscape"): XmbEntry => ({
  id,
  title,
  hue,
  art: { kind: "generated" },
  artShape: shape,
});

/** Echtes Bild über den HTTP-Weg von ArtImage (PNG als data-URL; ArtImage akzeptiert nur Rastergrafiken). */
const pngCache = new Map<string, string>();
const pngUrl = (hue: number, title: string) => {
  const key = `${hue}|${title}`;
  let url = pngCache.get(key);
  if (!url) {
    const c = document.createElement("canvas");
    c.width = 192;
    c.height = 108;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 192, 108);
    grad.addColorStop(0, `hsl(${hue},80%,55%)`);
    grad.addColorStop(1, `hsl(${(hue + 50) % 360},70%,20%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 192, 108);
    g.fillStyle = "rgba(255,255,255,.25)";
    g.beginPath();
    g.arc(140, 36, 24, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 18px sans-serif";
    g.fillText(title, 10, 96);
    url = c.toDataURL("image/png");
    pngCache.set(key, url);
  }
  return url;
};
const svgArt = (id: string, title: string, hue: number): XmbEntry => ({
  id,
  title,
  hue,
  artShape: "landscape",
  art: { kind: "http", url: pngUrl(hue, title) },
});

const BASIC: PopupItem[] = [
  { id: "resume", label: "Fortsetzen", detail: "bei 42:10 von 2:44:00", trailing: "2:44" },
  { id: "start", label: "Von vorn beginnen" },
  { id: "audio", label: "Tonspur wählen" },
  { id: "sub", label: "Untertitel wählen" },
  { id: "dis", label: "Trailer (nicht verfügbar)", disabled: true },
  { id: "info", label: "Informationen" },
];

const RICH: PopupItem[] = [
  { id: "h1", label: "Gefunden", header: true },
  { id: "rpcs3", label: "RPCS3", detail: "/Applications/RPCS3.app · Version 0.0.34", status: "ok", trailing: "PS3" },
  { id: "duck", label: "DuckStation", detail: "/Users/test/Applications/DuckStation.app", status: "ok", trailing: "PS1" },
  { id: "pcsx2", label: "PCSX2", detail: "Nicht ausführbar – Rechte prüfen", status: "warn", trailing: "PS2" },
  { id: "h2", label: "Nicht gefunden", header: true },
  { id: "ppsspp", label: "PPSSPP", detail: "Weder installiert noch ausgewählt", status: "error", trailing: "PSP" },
  { id: "dolphin", label: "Dolphin", detail: "Suche läuft …", status: "busy", trailing: "GC/Wii" },
  { id: "h3", label: "Ausgewählt", header: true },
  { id: "lang-de", label: "Deutsch · AC3 5.1", checked: true },
  { id: "lang-en", label: "Englisch · DTS 5.1" },
  { id: "lang-off", label: "Aus", disabled: true },
  { id: "both", label: "Status und Häkchen", status: "ok", checked: true },
  { id: "long", label: "Ein sehr langer Name, der garantiert nicht in eine Zeile passt und deshalb gekürzt wird", detail: "/Users/test/Library/Application Support/Sehr/Langer/Pfad/Der/Nicht/Passt/Datei.iso", trailing: "12:34" },
];

const EPISODES: PopupItem[] = Array.from({ length: 24 }, (_, i) => {
  const n = i + 1;
  const watched = n <= 5;
  const partial = n === 6;
  return {
    id: `ep${n}`,
    label: `${n}. ${["Der Anfang", "Zwei Wege", "Im Nebel", "Das Experiment", "Ausgeschlossen", "Rückkehr", "Die Wahrheit", "Schatten"][i % 8]}${n === 9 ? " – ein ungewöhnlich langer Folgentitel, der abgeschnitten werden muss" : ""}`,
    detail: `Staffel 1 · Folge ${n}${watched ? " · gesehen" : ""}`,
    trailing: `${40 + (n % 7)} Min.`,
    art: n % 3 === 0 ? svgArt(`epimg${n}`, `E${n}`, (n * 37) % 360) : cover(`epimg${n}`, `Folge ${n}`, (n * 37) % 360),
    progress: watched ? 1 : partial ? 0.42 : n === 7 ? 0.08 : undefined,
    checked: n === 6,
  } satisfies PopupItem;
});

const LONG: PopupItem[] = Array.from({ length: 200 }, (_, i) => {
  if (i % 25 === 0) return { id: `h${i}`, label: `Gruppe ${i / 25 + 1}`, header: true };
  return { id: `i${i}`, label: `Eintrag ${i}`, detail: i % 4 === 0 ? `Beschreibung ${i}` : undefined, trailing: i % 5 === 0 ? `${i} Min.` : undefined };
});

const HUGE: PopupItem[] = Array.from({ length: 1500 }, (_, i) => ({ id: `h${i}`, label: `Eintrag ${i}`, detail: i % 3 === 0 ? `Detail ${i}` : undefined, trailing: `${i}` }));
const HUGE_ART: PopupItem[] = Array.from({ length: 300 }, (_, i) => ({
  id: `a${i}`,
  label: `Folge ${i}`,
  detail: `Bild über HTTP-Weg`,
  art: svgArt(`ha${i}`, `F${i}`, (i * 23) % 360),
  progress: i % 4 === 0 ? 0.5 : undefined,
}));

function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <>
      {bg === "xmb" ? <Xmb categories={categories} inputEnabled={false} /> : <div className="boot" />}
      {children}
    </>
  );
}

/* ---------------------------------------------------------------- Szenarien */

function ListScenario({ items, ...rest }: { items: PopupItem[] } & Partial<React.ComponentProps<typeof PopupList>>) {
  return (
    <PopupList
      title="Blade Runner 2049"
      subtitle="2017 · Science-Fiction · 2 Std. 44 Min."
      items={items}
      onSelect={(id) => log(`select:${id}`)}
      onBack={() => log("back")}
      onAlt={(id) => log(`alt:${id}`)}
      altLabel="Optionen"
      onFocusChange={(id) => log(`focus:${id}`)}
      {...rest}
    />
  );
}

function Stack({ forgot = false }: { forgot?: boolean }) {
  const [dialog, setDialog] = useState<null | "confirm" | "message">(null);
  const [result, setResult] = useState("");
  return (
    <>
      <PopupList
        title="Emulatoren"
        subtitle="Gefundene Programme"
        items={[...RICH.slice(0, 7)]}
        active={forgot || dialog === null}
        footer={result ? { text: result, kind: "ok" } : undefined}
        onSelect={(id) => {
          log(`list-select:${id}`);
          setDialog(id === "rpcs3" ? "confirm" : "message");
        }}
        onBack={() => log("list-back")}
        onAlt={(id) => log(`list-alt:${id}`)}
        onFocusChange={(id) => log(`list-focus:${id}`)}
      />
      {dialog === "confirm" && (
        <ConfirmDialog
          title="Emulator entfernen?"
          message={"RPCS3 wird aus der Liste gelöscht.\nDie Anwendung selbst bleibt erhalten."}
          confirmLabel="Entfernen"
          danger
          onConfirm={() => {
            log("dialog-confirm");
            setResult("RPCS3 entfernt");
            setDialog(null);
          }}
          onCancel={() => {
            log("dialog-cancel");
            setDialog(null);
          }}
        />
      )}
      {dialog === "message" && (
        <MessageDialog
          title="Start fehlgeschlagen"
          kind="error"
          lines={["Der Emulator ließ sich nicht starten.", "Programm: /Applications/PCSX2.app"]}
          detail={Array.from({ length: 40 }, (_, i) => `[${String(i).padStart(2, "0")}] stderr: Zeile ${i} des Fehlerprotokolls`)}
          onClose={() => {
            log("message-close");
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

function Dynamic() {
  const [tick, setTick] = useState(0);
  const [removed, setRemoved] = useState<string[]>([]);
  const [top, setTop] = useState(0);
  useEffect(() => {
    window.__g.dyn = {
      bump: () => setTick((t) => t + 1),
      remove: (id: string) => setRemoved((r) => [...r, id]),
      insertTop: (n: number) => setTop((t) => t + n),
      restore: () => setRemoved([]),
    };
  }, []);
  const base: PopupItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, label: `Eintrag ${i}`, detail: `Stand ${tick}` }));
  const extra: PopupItem[] = Array.from({ length: top }, (_, i) => ({ id: `n${i}`, label: `Neu ${i}` }));
  const items = [...extra, ...base].filter((it) => !removed.includes(it.id));
  return <ListScenario items={items} title="Dynamisch" subtitle={`Render ${tick}`} />;
}

function ActiveToggle() {
  const [active, setActive] = useState(true);
  useEffect(() => {
    window.__g.setActive = setActive;
  }, []);
  return <ListScenario items={BASIC} active={active} />;
}

function Progress() {
  const [lines, setLines] = useState<string[]>(["Suche in /Applications …", "Gefunden: RPCS3.app"]);
  const [progress, setProgress] = useState<number | null | undefined>(0.2);
  const [status, setStatus] = useState("Emulatoren werden gesucht …");
  useEffect(() => {
    window.__g.progress = {
      addLine: (l: string) => setLines((ls) => [...ls, l]),
      set: (p: number | null | undefined) => setProgress(p),
      status: (s: string) => setStatus(s),
    };
  }, []);
  return (
    <ProgressDialog
      title="Suche läuft"
      status={status}
      lines={params.get("nolog") ? undefined : lines}
      progress={params.get("indet") ? null : params.get("nobar") ? undefined : progress}
      onCancel={params.get("nocancel") ? undefined : () => log("progress-cancel")}
    />
  );
}

function FrameCustom() {
  const [open, setOpen] = useState(true);
  useOverlayInput({ active: false, onAction: () => {} });
  return (
    <OverlayFrame
      align="right"
      open={open}
      onBack={() => {
        log("frame-back");
        setOpen(false);
      }}
      onExited={() => log("frame-exited")}
    >
      <div style={{ padding: "2rem 3rem", background: "rgba(10,20,60,.85)", borderRadius: ".6rem", fontSize: "1.5rem" }}>
        Eigener Inhalt im OverlayFrame
        <br />
        (○ / Esc / Klick daneben = zurück)
      </div>
    </OverlayFrame>
  );
}

function Hold() {
  // Eigener Inhalt, der eine Liste ohne eigenen Rahmen einbettet
  return (
    <OverlayFrame align="left" dim={0.35} onBack={() => log("frame-back")}>
      <PopupList
        title="Eingebettet"
        subtitle="Liste in eigenem Rahmen"
        width="narrow"
        items={BASIC}
        onSelect={(id) => log(`select:${id}`)}
        onBack={() => log("list-back")}
      />
    </OverlayFrame>
  );
}

const SCENARIOS: Record<string, () => React.ReactNode> = {
  basic: () => <ListScenario items={BASIC} focusId={params.get("focus") ?? undefined} footer={params.get("footer") ? { text: "Der Eintrag lässt sich nicht öffnen: Datei nicht gefunden (/Users/test/Filme/Blade Runner 2049.mkv)", kind: "error" } : undefined} />,
  narrow: () => <ListScenario items={BASIC.slice(0, 3)} width="narrow" altLabel="Optionen" />,
  rich: () => <ListScenario items={RICH} width="wide" title="Emulatoren" subtitle="Gefunden, ausgewählt und fehlend" altLabel="Pfad wählen" footer="Suche abgeschlossen: 2 gefunden" onSquare={(id) => log(`square:${id}`)} squareLabel="Erneut suchen" />,
  episodes: () => <ListScenario items={EPISODES} width="wide" title="Staffel 1" subtitle="Dark Matter · 24 Folgen" focusId="ep6" />,
  long: () => <ListScenario items={LONG} title="Lange Liste" subtitle="200 Zeilen" />,
  huge: () => <ListScenario items={HUGE} title="Riesige Liste" subtitle="1500 Zeilen" />,
  "huge-art": () => <ListScenario items={HUGE_ART} width="wide" title="Viele Bilder" subtitle="300 Zeilen mit Bild" />,
  empty: () => <ListScenario items={[]} title="Leere Liste" />,
  "empty-text": () => <ListScenario items={[]} title="Leere Liste" emptyText="Keine Folgen gefunden" />,
  "busy-empty": () => <ListScenario items={[]} title="Lädt" busy />,
  busy: () => <ListScenario items={BASIC} busy title="Lädt weiter" />,
  stack: () => <Stack />,
  "stack-forgot": () => <Stack forgot />,
  dynamic: () => <Dynamic />,
  active: () => <ActiveToggle />,
  hold: () => <Hold />,
  frame: () => <FrameCustom />,
  confirm: () => (
    <ConfirmDialog
      title="Wiedergabe fortsetzen?"
      message={"Du hast „Blade Runner 2049“ bei 42:10 beendet.\nMöchtest du dort weitermachen?"}
      confirmLabel="Fortsetzen"
      cancelLabel="Von vorn"
      onConfirm={() => log("confirm")}
      onCancel={() => log("cancel")}
    />
  ),
  "confirm-danger": () => (
    <ConfirmDialog
      title="Spiel beenden?"
      message="Nicht gespeicherter Fortschritt geht verloren."
      confirmLabel="Beenden"
      danger
      onConfirm={() => log("confirm")}
      onCancel={() => log("cancel")}
    />
  ),
  "message-info": () => <MessageDialog title="Hinweis" lines={["Der Emulator wurde gestartet.", "", "Dieses Fenster kannst du schließen."]} onClose={() => log("close")} />,
  "message-success": () => <MessageDialog title="Fertig" kind="success" lines={["RPCS3 wurde installiert."]} okLabel="Weiter" onClose={() => log("close")} />,
  "message-error": () => (
    <MessageDialog
      title="Spiel beendet"
      kind="error"
      lines={["RPCS3 wurde unerwartet beendet (Code 139).", "Die letzten Zeilen des Protokolls:"]}
      detail={Array.from({ length: 40 }, (_, i) => `[${String(i).padStart(2, "0")}] ${i === 39 ? "FEHLER: Segmentation fault beim Laden von /Users/test/Games/PS3/Spiel/PS3_GAME/USRDIR/EBOOT.BIN" : `Info: Schritt ${i} abgeschlossen`}`)}
      onClose={() => log("close")}
    />
  ),
  progress: () => <Progress />,
};

function Gallery() {
  const make = SCENARIOS[scenario] ?? SCENARIOS.basic;
  return <Backdrop>{make()}</Backdrop>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Gallery />);
