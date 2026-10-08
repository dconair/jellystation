/** "192.168.1.20:8096/" → "http://192.168.1.20:8096" */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function isValidServerUrl(input: string): boolean {
  try {
    const u = new URL(normalizeServerUrl(input));
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}
