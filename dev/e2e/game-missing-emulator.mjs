// E2E: Spiel ohne installierten Emulator → Dialog mit Hinweis (kein stiller Fehlschlag).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeHome, startApp, waitFor, press, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-e2e-out-"));
fs.mkdirSync(out, { recursive: true });
const home = makeHome({
  settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" },
  games: { PS3: ["Test Game.iso"] },
});
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "OK  " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`); if (!ok) failed++; };
const app = await startApp({ home });
const wd = app.wd;
try {
  await waitFor(wd, "() => document.querySelector('.xmb')", { timeout: 40000 });
  await sleep(3000);
  await press(wd, "ArrowRight", { times: 2, pause: 500 });
  await sleep(800);
  await press(wd, "Enter");
  await sleep(3500);
  const text = await wd.exec("return document.body.innerText");
  console.log(text.replace(/\s+/g, " ").slice(0, 400));
  check("Dialog nennt RPCS3", /RPCS3/.test(text));
  check("Dialog bietet Installation/Suche an", /Installier|Homebrew|Download|Pfad|nicht gefunden/i.test(text));
  await wd.screenshot(path.join(out, "m1-missing.png"));
} catch (e) { console.log("FEHLER:", e.message); failed++; }
finally { await app.stop(); }
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);
