/**
 * Emulator mit Homebrew installieren: `brew install --cask <cask>` als Kindprozess des Shell-Plugins.
 *
 * Die erlaubten Programme stehen im Shell-Scope (src-tauri/capabilities/emulators.json): "brew-arm" =
 * /opt/homebrew/bin/brew, "brew-intel" = /usr/local/bin/brew. Ein anderer Aufruf wird vom Plugin abgelehnt.
 */
import { errorText } from "./backend";
import type { BrewInfo } from "./detect";

/**
 * Umgebung für Homebrew (wird zur geerbten Umgebung hinzugefügt, ersetzt sie nicht): Kein Update der ganzen
 * Paketliste vor jeder Installation, kein Aufräumen alter Versionen, keine Statistik – das macht den Aufruf
 * schneller und vermeidet lange Wartezeiten ohne Ausgabe.
 */
export const BREW_ENV: Record<string, string> = {
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_INSTALL_CLEANUP: "1",
  HOMEBREW_NO_ANALYTICS: "1",
};

/** So viele Zeilen merkt sich ein Lauf höchstens (für die Fehleranzeige). */
const MAX_LINES = 400;

export interface BrewResult {
  /** Exit-Code; null bei Abbruch durch ein Signal oder wenn der Prozess nicht starten konnte. */
  code: number | null;
  signal: number | null;
  /** Gesetzt, wenn der Prozess nicht starten konnte oder das Plugin einen Fehler meldete. */
  error: string | null;
  /** true = vom Nutzer abgebrochen. */
  cancelled: boolean;
  /** Alle Ausgabezeilen (höchstens die letzten 400), stdout und stderr gemischt. */
  lines: string[];
}

export interface BrewRun {
  /** Beendet den Prozess (so gut es geht) und liefert das Ergebnis sofort. */
  cancel: () => Promise<void>;
  done: Promise<BrewResult>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Macht aus einem Stück Prozessausgabe lesbare Zeilen: Farbcodes weg, Wagenrücklauf (curl-Fortschrittsbalken
 * überschreiben sich damit selbst) zählt als Zeilenende – es bleibt der jeweils letzte Stand.
 */
export function cleanOutput(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.replace(ANSI, "").split("\n")) {
    const parts = line.split("\r");
    // Mehrere durch \r getrennte Stände derselben Zeile: nur der letzte nichtleere zählt.
    const last = [...parts].reverse().find((p) => p.trim() !== "");
    if (last === undefined) continue;
    const text = last.replace(/\s+$/, "");
    // curl-Fortschrittsbalken („#####   45,2%“) wären als Zeichenkette unlesbar: als Prozentangabe zeigen.
    const bar = /^[#=>\-\s]*?\s(\d{1,3}(?:[.,]\d+)?)\s*%$/.exec(text);
    out.push(bar && /^[#=>\-\s]+/.test(text) ? `${PROGRESS_PREFIX}${bar[1].replace(".", ",")} %` : text);
  }
  return out;
}

/** Beginn der Zeilen, die cleanOutput() aus Fortschrittsbalken macht (aufeinanderfolgende ersetzen sich). */
export const PROGRESS_PREFIX = "Download: ";

/** Prozentwert aus einer Fortschrittszeile („###### 45,2 %“ / „45.2%“), sonst null. */
export function percentOf(line: string): number | null {
  const m = /(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(line);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** Aussagekräftiger Hinweis zu einer Homebrew-Fehlermeldung (oder null). */
export function brewFailureHint(lines: readonly string[], cask: string): string | null {
  const text = lines.join("\n");
  if (/already an app at|It seems there is already an App/i.test(text)) {
    return "Die App liegt schon im Ordner „Programme“, wurde aber nicht erkannt – wähle sie mit „App auswählen …“ aus.";
  }
  if (/No available cask|Cask '.*' is unavailable|unknown cask/i.test(text)) {
    return "Dieses Homebrew-Paket gibt es nicht (mehr). Nutze stattdessen die Download-Seite.";
  }
  if (/sudo|password|a terminal is required/i.test(text)) {
    return `Homebrew braucht ein Passwort und kann es hier nicht abfragen. Installiere im Terminal:  brew install --cask ${cask}`;
  }
  if (/Permission denied|Operation not permitted/i.test(text)) {
    return "Dem Programm fehlt die Berechtigung für den Zielordner. Installiere im Terminal oder nutze die Download-Seite.";
  }
  if (/Could not resolve host|Failed to connect|timed out|Network is unreachable|curl: \(\d+\)/i.test(text)) {
    return "Der Download ist fehlgeschlagen – prüfe die Internetverbindung und versuche es erneut.";
  }
  return null;
}

/**
 * Startet die Installation. `onLine` bekommt jede bereinigte Ausgabezeile (stdout und stderr).
 * Das Ergebnis `done` wird nie abgelehnt: auch Startfehler (z. B. Shell-Scope verweigert) stehen in `error`.
 */
export function runBrewInstall(
  brew: BrewInfo,
  cask: string,
  onLine: (line: string, stream: "stdout" | "stderr") => void,
): BrewRun {
  const lines: string[] = [];
  let cancelled = false;
  let finished = false;
  let kill: (() => Promise<void>) | null = null;
  let finish!: (r: BrewResult) => void;
  const done = new Promise<BrewResult>((resolve) => {
    finish = (r) => {
      if (finished) return;
      finished = true;
      resolve(r);
    };
  });
  const result = (r: Partial<BrewResult>): BrewResult => ({
    code: null,
    signal: null,
    error: null,
    cancelled,
    lines: lines.slice(-MAX_LINES),
    ...r,
  });

  const push = (raw: string, stream: "stdout" | "stderr") => {
    for (const line of cleanOutput(String(raw))) {
      lines.push(line);
      if (lines.length > MAX_LINES * 2) lines.splice(0, lines.length - MAX_LINES);
      onLine(line, stream);
    }
  };

  void (async () => {
    if (!brew.available || !brew.command) {
      finish(result({ error: "Homebrew wurde nicht gefunden." }));
      return;
    }
    try {
      const { Command } = await import("@tauri-apps/plugin-shell");
      const cmd = Command.create(brew.command, ["install", "--cask", cask], { env: BREW_ENV });
      cmd.stdout.on("data", (l) => push(String(l), "stdout"));
      cmd.stderr.on("data", (l) => push(String(l), "stderr"));
      cmd.on("close", ({ code, signal }) => finish(result({ code, signal })));
      cmd.on("error", (msg) => finish(result({ error: errorText(msg) })));
      const child = await cmd.spawn();
      kill = () => child.kill();
      // Abgebrochen, noch bevor der Prozess lief: sofort wieder beenden.
      if (cancelled) await child.kill().catch(() => undefined);
    } catch (err) {
      finish(result({ error: errorText(err) }));
    }
  })();

  return {
    done,
    cancel: async () => {
      if (finished) return;
      cancelled = true;
      try {
        await kill?.();
      } catch {
        // Der Prozess lief schon nicht mehr – nichts weiter zu tun.
      }
      // Die Anzeige soll nicht auf den Abschluss des Prozesses warten (er kann hängen).
      finish(result({ cancelled: true }));
    },
  };
}
