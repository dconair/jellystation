/** Zuletzt gestartete Spiele (Eintrags-IDs, neueste zuerst) – lokal gemerkt. */
const KEY = "jellystation.recentGames";
const MAX = 8;

export function loadRecentGames(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberGame(id: string): string[] {
  const next = [id, ...loadRecentGames().filter((x) => x !== id)].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // bewusst ignoriert: ohne Speicher gibt es nur keinen Verlauf
  }
  return next;
}
