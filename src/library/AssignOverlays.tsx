import { useMemo } from "react";
import type { XmbEntry } from "../data/types";
import { emulatorForSystem } from "../emulators/catalog";
import { PopupList } from "../ui/popup";
import type { PopupItem } from "../ui/popup";
import { GAME_SYSTEMS, IGNORE, titleOfGame } from "./scanGames";

/** Antwort der Zuordnung: ein System, "ignore" (ausblenden) oder AUTO (eigene Zuordnung entfernen). */
export const AUTO = "__auto";

const consolesOf = (system: string) => {
  const def = emulatorForSystem(system);
  return def ? `${def.consoles} · ${def.name}` : system;
};

interface AssignSystemProps {
  entry: XmbEntry;
  /** Von Hand gewähltes System oder "ignore", falls es schon eine eigene Zuordnung gibt. */
  override?: string;
  onPick: (value: string) => void;
  onBack: () => void;
}

/**
 * „Welches System ist das?“ – für Spiele unter „Nicht zugeordnet“ (✕) und zum Ändern einer Erkennung (△).
 * Die Datei bleibt, wo sie ist; die Zuordnung steht in den Einstellungen (settings.gameSystems).
 */
export function AssignSystemList({ entry, override, onPick, onBack }: AssignSystemProps) {
  const game = entry.game;
  const items = useMemo<PopupItem[]>(() => {
    const current = override && override !== IGNORE ? override : game?.system;
    const guess = game?.guess;
    const systems = [...GAME_SYSTEMS].sort((a, b) => Number(b === guess) - Number(a === guess));
    const list: PopupItem[] = systems.map((system) => ({
      id: system,
      label: system,
      detail: `${system === guess ? "Vorschlag · " : ""}${consolesOf(system)}`,
      checked: system === current,
    }));
    list.push({ id: IGNORE, label: "Nicht anzeigen", detail: "Blendet das Spiel aus – unter Einstellungen → Spiele-Zuordnung wieder einblendbar", checked: override === IGNORE });
    if (override) list.push({ id: AUTO, label: "Automatisch erkennen", detail: "Meine Zuordnung entfernen" });
    return list;
  }, [game?.guess, game?.system, override]);

  return (
    <PopupList
      title={`„${entry.title}“ zuordnen`}
      subtitle={game?.unassigned ? "Das System ließ sich nicht erkennen. Welches ist es?" : "Zu welchem System gehört das Spiel?"}
      width="narrow"
      items={items}
      focusId={game?.guess ?? undefined}
      onSelect={(id) => onPick(id)}
      onBack={onBack}
    />
  );
}

interface AssignmentsProps {
  overrides: Readonly<Record<string, string>>;
  onReset: (rel: string) => void;
  onResetAll: () => void;
  onBack: () => void;
}

const RESET_ALL = "__all";

/** Alle Zuordnungen von Hand (auch ausgeblendete Spiele) – ✕ setzt eine zurück. */
export function AssignmentsList({ overrides, onReset, onResetAll, onBack }: AssignmentsProps) {
  const entries = Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b, "de", { numeric: true, sensitivity: "base" }));
  const items: PopupItem[] = entries.map(([rel, value]) => ({
    id: rel,
    label: titleOfGame({ name: rel.slice(rel.lastIndexOf("/") + 1), kind: "file", title: null }),
    detail: rel,
    trailing: value === IGNORE ? "ausgeblendet" : value,
  }));
  if (items.length > 1) items.push({ id: RESET_ALL, label: "Alle zurücksetzen", detail: "Alle Spiele werden wieder automatisch erkannt" });
  return (
    <PopupList
      title="Spiele-Zuordnung"
      subtitle="Spiele, die du von Hand zugeordnet oder ausgeblendet hast. ✕ setzt zurück."
      width="normal"
      items={items}
      emptyText="Keine eigenen Zuordnungen – alles wird automatisch erkannt."
      onSelect={(id) => (id === RESET_ALL ? onResetAll() : onReset(id))}
      onBack={onBack}
    />
  );
}
