// Test-Gerüst für Läufe der ECHTEN Tauri-App unter Linux (WebKitGTK unter xvfb).
//
// Ablauf: temporäres HOME mit vorbereiteten Einstellungen und einem Fake-Emulator → Vite-Dev-Server
// (Debug-Builds laden devUrl http://localhost:1420) → tauri-driver (startet WebKitWebDriver) → App.
// Aufruf von Testskripten:  xvfb-run -a -s "-screen 0 1280x720x24" node dev/e2e/<skript>.mjs
//
// Voraussetzungen: cargo build (src-tauri/target/debug/jellystation), tauri-driver (cargo install tauri-driver),
// WebKitWebDriver (apt: webkit2gtk-driver), xvfb.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebDriver, sleep } from "./webdriver.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export { sleep };

const children = [];
export function track(child) {
  children.push(child);
  return child;
}

export async function waitForHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* noch nicht bereit */
    }
    await sleep(250);
  }
  throw new Error(`Zeitüberschreitung beim Warten auf ${url}`);
}

/** Legt ein temporäres HOME an: Einstellungen, Spiele-Ordner, Fake-Emulatoren. */
export function makeHome({ settings, games = {}, emulators = [] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jellystation-e2e-"));
  // Store-Plugin: <AppData>/settings.json mit { settings: {...} }
  const dataDir = path.join(home, ".local/share/dev.jellystation.app");
  fs.mkdirSync(dataDir, { recursive: true });
  if (settings) fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ settings }, null, 2));
  for (const [system, files] of Object.entries(games)) {
    const dir = path.join(home, "JellyStation/Games", system);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), "fake game data");
  }
  for (const emu of emulators) makeFakeEmulator(home, emu);
  return home;
}

/**
 * Fake-Emulator als .app-Bundle (Info.plist + Shell-Skript). Das Skript schreibt seine Argumente nach
 * $FAKE_EMU_LOG, meldet etwas auf stderr, wartet $FAKE_EMU_SLEEP Sekunden und endet mit $FAKE_EMU_EXIT.
 */
export function makeFakeEmulator(home, { bundle = "RPCS3.app", exe = "rpcs3", id = "net.rpcs3.rpcs3", version = "0.0.99", dir = "Applications" }) {
  const root = path.join(home, dir, bundle);
  fs.mkdirSync(path.join(root, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleName</key><string>${bundle.replace(/\.app$/, "")}</string>
</dict></plist>
`,
  );
  const script = path.join(root, "Contents/MacOS", exe);
  fs.writeFileSync(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > "\${FAKE_EMU_LOG:-/dev/null}"
echo "fake-emulator: gestartet mit $# Argumenten" >&2
sleep "\${FAKE_EMU_SLEEP:-3}"
exit "\${FAKE_EMU_EXIT:-0}"
`,
    { mode: 0o755 },
  );
  return root;
}

/**
 * Startet Vite (Port 1420) und tauri-driver und öffnet die App. Gibt { wd, home, env, stop } zurück.
 * options: { home, env (zusätzliche Umgebungsvariablen), binary, viewport }
 */
export async function startApp({ home, env = {}, binary = path.join(REPO, "src-tauri/target/debug/jellystation"), log = false }) {
  const appEnv = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    ...env,
  };
  // Vite
  const vite = track(spawn("npx", ["vite", "--port", "1420", "--strictPort", "--host", "127.0.0.1"], { cwd: REPO, env: appEnv, stdio: ["ignore", "pipe", "pipe"] }));
  if (log) vite.stdout.on("data", (d) => process.stdout.write("[vite] " + d));
  await waitForHttp("http://127.0.0.1:1420/");
  // tauri-driver
  const driver = track(spawn("tauri-driver", ["--port", "4444", "--native-port", "4445"], { env: appEnv, stdio: ["ignore", "pipe", "pipe"] }));
  if (log) {
    driver.stdout.on("data", (d) => process.stdout.write("[driver] " + d));
    driver.stderr.on("data", (d) => process.stdout.write("[driver!] " + d));
  }
  await waitForHttp("http://127.0.0.1:4444/status");
  const wd = new WebDriver("http://127.0.0.1:4444");
  await wd.newSession({ browserName: "wry", "tauri:options": { application: binary } });
  await wd.setTimeouts({ script: 120000, pageLoad: 60000, implicit: 0 });
  return {
    wd,
    home,
    async stop() {
      await wd.quit();
      for (const c of children.splice(0)) {
        try {
          c.kill("SIGTERM");
        } catch {
          /* schon beendet */
        }
      }
    },
  };
}

/** Wartet, bis fn (Text, im Seitenkontext ausgewertet) einen wahren Wert liefert. */
export async function waitFor(wd, fnSource, { timeout = 15000, interval = 250, label = fnSource } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await wd.exec(`return (${fnSource})();`);
      if (last) return last;
    } catch (e) {
      last = String(e);
    }
    await sleep(interval);
  }
  throw new Error(`Zeitüberschreitung: ${label} (zuletzt: ${JSON.stringify(last)})`);
}

/** Taste an die App schicken: echtes WebDriver-Ereignis (vertrauenswürdig) mit Rückfall auf ein synthetisches. */
export async function press(wd, key, { times = 1, pause = 120 } = {}) {
  const map = { Enter: "", Escape: "", ArrowUp: "", ArrowDown: "", ArrowLeft: "", ArrowRight: "", Backspace: "", " ": " " };
  for (let i = 0; i < times; i++) {
    const value = map[key] ?? key;
    try {
      await wd.req("POST", `/session/${wd.sid}/actions`, {
        actions: [{ type: "key", id: "kbd", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }],
      });
    } catch {
      await wd.exec(
        `for (const t of ["keydown","keyup"]) window.dispatchEvent(new KeyboardEvent(t, { key: arguments[0], bubbles: true, cancelable: true }));`,
        [key],
      );
    }
    await sleep(pause);
  }
}

export function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
