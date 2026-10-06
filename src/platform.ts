/** true, wenn die App im Tauri-Fenster läuft (nicht im reinen Browser/`vite dev`). */
export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
