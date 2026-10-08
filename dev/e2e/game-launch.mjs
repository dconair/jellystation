// E2E in der echten Tauri-App (Linux/WebKitGTK): Ein Spiel im Ordner wird mit dem Fake-RPCS3 gestartet.
//   xvfb-run -a -s "-screen 0 1280x720x24" node dev/e2e/game-launch.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeHome, startApp, waitFor, press, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-e2e-out-"));
fs.mkdirSync(out, { recursive: true });
const home = makeHome({
  settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" },
  games: { PS3: ["Test Game.iso"] },
  emulators: [{}],
});
const log = path.join(home, "emu-args.txt");
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK  " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`);
  if (!ok) failed++;
};

const app = await startApp({ home, env: { FAKE_EMU_LOG: log, FAKE_EMU_SLEEP: "6", FAKE_EMU_EXIT: "0" } });
const wd = app.wd;
try {
  await waitFor(wd, "() => document.querySelector('.xmb')", { timeout: 40000, label: ".xmb" });
  await sleep(3000);
  const cats = await wd.exec("return [...document.querySelectorAll('.xmb-category__label')].map(e=>e.textContent)");
  console.log("Kategorien:", JSON.stringify(cats));
  check("Spiele-Kategorie aus dem Ordner", cats.some((c) => /PS3/.test(c)));
  const notice = await wd.exec("return [...document.querySelectorAll('.xmb-notice')].map(e=>e.textContent)");
  check("kein Vorschau-Modus (echter Ordner gelesen)", !notice.some((n) => /Vorschau/.test(n)), JSON.stringify(notice));
  await wd.screenshot(path.join(out, "g1-menu.png"));
  // zur PS3-Kategorie: Filme → Serien → Spiele · PS3
  await press(wd, "ArrowRight", { times: 2, pause: 500 });
  await sleep(800);
  await press(wd, "Enter");
  await sleep(2500);
  await wd.screenshot(path.join(out, "g2-launching.png"));
  const started = await waitFor(wd, "() => true", { timeout: 1000 }).then(() => true);
  void started;
  const end = Date.now() + 10000;
  while (!fs.existsSync(log) && Date.now() < end) await sleep(300);
  const args = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : null;
  check("Emulator wurde gestartet", !!args, args ? JSON.stringify(args) : "keine Argumentdatei");
  if (args) {
    check("Argument --no-gui", args.includes("--no-gui"));
    check("Spieldatei als Argument", args.some((a) => /Test Game\.iso$/.test(a)));
  }
  await sleep(1500);
  const running = await wd.exec("return document.body.innerText");
  check("Menü zeigt „Läuft“", /Läuft/.test(running));
  await wd.screenshot(path.join(out, "g3-running.png"));
} catch (e) {
  console.log("FEHLER:", e.message);
  failed++;
  try { await wd.screenshot(path.join(out, "g-error.png")); } catch {}
} finally {
  await app.stop();
}
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
console.log("Bilder:", out);
process.exit(failed ? 1 : 0);
