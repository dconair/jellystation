import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Aktueller Git-Stand (Kurz-Hash + Betreff); bei ZIP-Downloads ohne .git "unbekannt". */
function gitInfo() {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  return {
    commit: run("git rev-parse --short HEAD") || "unbekannt",
    subject: run("git log -1 --pretty=%s"),
    dirty: run("git status --porcelain") !== "",
  };
}

const git = gitInfo();

// Tauri erwartet einen festen Port und soll nicht den Terminal-Bildschirm löschen.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_COMMIT__: JSON.stringify(git.commit),
    __APP_COMMIT_SUBJECT__: JSON.stringify(git.subject),
    __APP_DIRTY__: JSON.stringify(git.dirty),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
