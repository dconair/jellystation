const KEY = "jellystation.searchHistory";
const MAX = 8;

/** Die zuletzt gesuchten Begriffe, neuester zuerst (nur im Speicher des Browsers bzw. der App-Oberfläche). */
export function loadSearchHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(query: string): string[] {
  const q = query.trim();
  if (!q) return loadSearchHistory();
  const next = [q, ...loadSearchHistory().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Speicher gesperrt – der Verlauf ist nur eine Bequemlichkeit */
  }
  return next;
}

export function clearSearchHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* s. o. */
  }
}
