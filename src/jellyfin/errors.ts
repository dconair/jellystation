/** Grobe Ursache eines Jellyfin-Fehlers – die Oberfläche kann daran z. B. "Erneut versuchen" anbieten. */
export type JfErrorKind =
  /** Eingabe unvollständig (Adresse/API-Key fehlt oder ist ungültig). */
  | "config"
  /** Server nicht erreichbar (Netz, DNS, Verbindung abgebrochen). */
  | "network"
  /** Keine Antwort innerhalb der Frist. */
  | "timeout"
  /** API-Key abgelehnt (401/403). */
  | "auth"
  /** Titel/Benutzer/Pfad nicht gefunden (404). */
  | "notfound"
  /** Server meldet einen Fehler (5xx) oder lehnt die Anfrage ab (4xx). */
  | "server"
  /** Antwort ist kein gültiges JSON oder hat eine unerwartete Form. */
  | "protocol"
  /** Der Server hat keine abspielbare Quelle für diesen Player. */
  | "unplayable";

/**
 * Fehler mit einer Meldung, die direkt angezeigt werden darf (deutsch, knapp).
 * `status` ist der HTTP-Status, falls der Fehler von einer Antwort stammt.
 */
export class JfError extends Error {
  readonly kind: JfErrorKind;
  readonly status?: number;

  constructor(message: string, kind: JfErrorKind = "protocol", status?: number) {
    super(message);
    this.name = "JfError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** Abbruch durch den Aufrufer (AbortSignal) – wird von Oberflächen still ignoriert. */
export function abortError(): DOMException {
  return new DOMException("Abgebrochen", "AbortError");
}

/** true, wenn der Fehler ein Abbruch durch den Aufrufer ist. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Meldungen je HTTP-Status; was fehlt, bekommt den Standardtext. */
export interface StatusMessages {
  401?: string;
  403?: string;
  404?: string;
  /** Text für alle übrigen Fehlerstatus. */
  other?: (status: number) => string;
}

/** Übersetzt einen HTTP-Fehlerstatus in einen {@link JfError} mit deutschem Text. */
export function statusError(status: number, messages: StatusMessages = {}): JfError {
  if (status === 401) return new JfError(messages[401] ?? "API-Key ungültig", "auth", status);
  if (status === 403) return new JfError(messages[403] ?? "API-Key ungültig", "auth", status);
  if (status === 404) return new JfError(messages[404] ?? "Nicht auf dem Server gefunden", "notfound", status);
  return new JfError(
    messages.other?.(status) ?? `Server antwortet mit Status ${status}`,
    "server",
    status,
  );
}
