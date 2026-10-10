/**
 * Warteschlange für Spiele-Downloads. Lebt so lange wie die App (nicht wie der Dialog): Man kann den Dialog
 * schließen, im Menü weiterstöbern und später wieder nachsehen. Es läuft immer nur ein Download gleichzeitig.
 * Abbrechen lässt die unfertige Datei liegen – „Fortsetzen“ macht an derselben Stelle weiter.
 */
import { useSyncExternalStore } from "react";
import { downloadCancel, downloadDiscard, downloadStart, errorText, onDownloadProgress } from "./backend";

export type QueueState = "queued" | "running" | "verifying" | "done" | "failed" | "cancelled";

export interface QueueItem {
  id: string;
  name: string;
  url: string;
  /** Systemordner, z. B. "PS2" (nur zur Anzeige). */
  system: string;
  destDir: string;
  allowedHosts: string[];
  state: QueueState;
  received: number;
  total: number | null;
  message?: string;
  /** Fertige Datei. */
  path?: string;
  /** Unfertige Datei, solange sie existiert. */
  partPath?: string;
}

export type QueueRequest = Pick<QueueItem, "name" | "url" | "system" | "destDir" | "allowedHosts">;

let items: QueueItem[] = [];
let seq = 0;
let running: string | null = null;
let listening = false;
const listeners = new Set<() => void>();
const doneCallbacks = new Set<(item: QueueItem) => void>();

const emit = () => listeners.forEach((l) => l());
const update = (id: string, patch: Partial<QueueItem>) => {
  items = items.map((i) => (i.id === id ? { ...i, ...patch } : i));
  emit();
};

async function ensureListener() {
  if (listening) return;
  listening = true;
  try {
    await onDownloadProgress((p) => {
      if (!p.id.startsWith("game-")) return;
      const item = items.find((i) => i.id === p.id);
      if (!item) return;
      if (p.state === "running" || p.state === "verifying") update(p.id, { state: p.state, received: p.received, total: p.total });
      if (p.partPath) update(p.id, { partPath: p.partPath });
    });
  } catch {
    listening = false;
  }
}

async function pump() {
  if (running) return;
  const next = items.find((i) => i.state === "queued");
  if (!next) return;
  running = next.id;
  await ensureListener();
  update(next.id, { state: "running", message: undefined });
  try {
    const res = await downloadStart({
      id: next.id,
      url: next.url,
      destDir: next.destDir,
      allowedHosts: next.allowedHosts,
      allowHttp: true,
      blockExecutables: true,
    });
    update(next.id, { state: "done", received: res.size, total: res.size, path: res.path, partPath: undefined, name: res.fileName, message: res.alreadyPresent ? "Lag schon im Ordner" : undefined });
    const done = items.find((i) => i.id === next.id);
    if (done) doneCallbacks.forEach((cb) => cb(done));
  } catch (err) {
    const message = errorText(err);
    const cancelled = items.find((i) => i.id === next.id)?.state === "cancelled" || /abgebrochen/i.test(message);
    update(next.id, { state: cancelled ? "cancelled" : "failed", message: cancelled ? "Abgebrochen – Fortsetzen macht dort weiter, wo es aufgehört hat" : message });
  } finally {
    running = null;
    void pump();
  }
}

/** Reiht einen Download ein. */
export function enqueue(req: QueueRequest): QueueItem {
  const item: QueueItem = { ...req, id: `game-${Date.now().toString(36)}-${++seq}`, state: "queued", received: 0, total: null };
  items = [...items, item];
  emit();
  void pump();
  return item;
}

/** Bricht ab (läuft er gerade) bzw. nimmt ihn aus der Warteschlange. */
export function cancelItem(id: string) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (item.state === "running" || item.state === "verifying") {
    update(id, { state: "cancelled" });
    void downloadCancel(id).catch(() => undefined);
  } else if (item.state === "queued") {
    update(id, { state: "cancelled", message: "Nicht gestartet" });
  }
}

/** Startet einen abgebrochenen oder fehlgeschlagenen Download erneut; eine unfertige Datei wird fortgesetzt. */
export function retryItem(id: string) {
  const item = items.find((i) => i.id === id);
  if (!item || (item.state !== "failed" && item.state !== "cancelled")) return;
  update(id, { state: "queued", message: undefined });
  void pump();
}

/** Entfernt einen beendeten Eintrag; mit `discard` auch die unfertige Datei. */
export function removeItem(id: string, discard = false) {
  const item = items.find((i) => i.id === id);
  if (!item || item.state === "running" || item.state === "verifying") return;
  if (discard && item.partPath) void downloadDiscard(item.partPath).catch(() => undefined);
  items = items.filter((i) => i.id !== id);
  emit();
}

/** Wird aufgerufen, wenn ein Download fertig ist (z. B. um die Bibliothek neu zu lesen). Gibt die Abmeldung zurück. */
export function onItemDone(cb: (item: QueueItem) => void): () => void {
  doneCallbacks.add(cb);
  return () => doneCallbacks.delete(cb);
}

export const hasActiveDownloads = () => items.some((i) => i.state === "queued" || i.state === "running" || i.state === "verifying");

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Die aktuelle Warteschlange (aktualisiert sich bei jeder Änderung). */
export function useDownloadQueue(): readonly QueueItem[] {
  return useSyncExternalStore(subscribe, () => items);
}
