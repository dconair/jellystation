/** Version der App: Paketversion + Git-Stand zum Zeitpunkt von `dev`/`build`. */
export const APP_VERSION = "0.1.0";
export const APP_COMMIT = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "unbekannt";
export const APP_COMMIT_SUBJECT =
  typeof __APP_COMMIT_SUBJECT__ === "string" ? __APP_COMMIT_SUBJECT__ : "";
export const APP_DIRTY = typeof __APP_DIRTY__ === "boolean" ? __APP_DIRTY__ : false;

/** z. B. "0.1.0 · 14ec43a" (mit "+" bei lokalen Änderungen). */
export const APP_VERSION_LABEL = `${APP_VERSION} · ${APP_COMMIT}${APP_DIRTY ? "+" : ""}`;
