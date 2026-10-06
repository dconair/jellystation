import { useCallback, useRef, useState } from "react";
import { EMULATORS } from "../config/games";
import type { GameRef, XmbEntry } from "../data/types";
import { isTauri } from "../platform";

export type Notify = (text: string) => void;

interface LaunchSpec {
  /** Programmname aus dem Shell-Scope (capabilities/emulators.json). */
  command: string;
  args: string[];
  emulator: string;
}

/** Wählt den Emulator anhand des System-Ordners; native .app-Spiele starten über `open`. */
export function resolveLaunch(game: GameRef): LaunchSpec | null {
  const emu = EMULATORS[game.system.toLowerCase()];
  if (emu) return { command: emu.command, args: emu.args(game.path), emulator: emu.name };
  if (/\.app\/?$/i.test(game.path)) {
    return { command: "open-app", args: [game.path], emulator: "macOS" };
  }
  return null;
}

/**
 * Startet Spiele als eigenständige Prozesse (Tauri Shell `spawn`). Die XMB bleibt
 * währenddessen geöffnet; welche Titel laufen, steht in `running`.
 */
export function useGameLauncher() {
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  // Verhindert Doppelstarts auch zwischen zwei Renders (z. B. bei schnellem Doppel-Klick).
  const active = useRef(new Set<string>());

  const setActive = useCallback((id: string, on: boolean) => {
    if (on) active.current.add(id);
    else active.current.delete(id);
    setRunning(new Set(active.current));
  }, []);

  const launch = useCallback(
    async (entry: XmbEntry, notify: Notify) => {
      const game = entry.game;
      if (!game) {
        notify(`„${entry.title}“ wird geöffnet …`);
        return;
      }
      if (active.current.has(entry.id)) {
        notify(`„${entry.title}“ läuft bereits`);
        return;
      }
      const spec = resolveLaunch(game);
      if (!spec) {
        notify(`Kein Emulator für „${game.system}“ konfiguriert`);
        return;
      }
      if (game.mock) {
        notify(`Vorschau: „${entry.title}“ würde mit ${spec.emulator} starten`);
        return;
      }
      if (!isTauri()) {
        notify("Spiele lassen sich nur in der Desktop-App starten");
        return;
      }

      setActive(entry.id, true);
      try {
        const { Command } = await import("@tauri-apps/plugin-shell");
        const cmd = Command.create(spec.command, spec.args);
        cmd.on("close", ({ code }) => {
          setActive(entry.id, false);
          notify(
            code && code !== 0
              ? `„${entry.title}“ beendet (Code ${code})`
              : `„${entry.title}“ beendet`,
          );
        });
        cmd.on("error", (msg) => {
          setActive(entry.id, false);
          notify(`Fehler beim Ausführen: ${msg}`);
        });
        await cmd.spawn();
        notify(`„${entry.title}“ startet mit ${spec.emulator} …`);
      } catch (err) {
        setActive(entry.id, false);
        notify(`Start fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [setActive],
  );

  return { running, launch };
}
