const DEVICE_ID_KEY = "jellystation.deviceId";

/** Falls localStorage nicht nutzbar ist (privates Fenster, Vorschau): wenigstens für diese Sitzung stabil. */
let memoryId: string | null = null;

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // weiter mit dem Notbehelf unten
  }
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/**
 * Feste Geräte-ID dieser Installation. Jellyfin ordnet Sitzungen und Transkodierungen darüber zu –
 * ändert sie sich bei jedem Start, sammeln sich auf dem Server "Geräte" an.
 */
export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
    const id = memoryId ?? randomId();
    localStorage.setItem(DEVICE_ID_KEY, id);
    memoryId = id;
    return id;
  } catch {
    memoryId ??= randomId();
    return memoryId;
  }
}

/** Gerätename, wie er im Jellyfin-Dashboard erscheint (ohne Komma/Anführungszeichen: der Header-Parser des Servers kennt keine Maskierung). */
export function getDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows-PC";
  if (/Linux|X11/i.test(ua)) return "Linux-PC";
  return "Computer";
}
