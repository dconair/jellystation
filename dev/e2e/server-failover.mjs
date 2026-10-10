// E2E: Hauptadresse tot, zweite Adresse (Tailscale-Ersatz) lebt → App wechselt selbst und spielt den Film.
// Voraussetzung: node dev/mock-jellyfin/server.mjs --port 18110 läuft (Medien: dev/mock-jellyfin/make-media.sh).
//   xvfb-run -a -s "-screen 0 1280x720x24" node dev/e2e/player-jellyfin.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeHome, startApp, waitFor, press, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-e2e-out-"));
fs.mkdirSync(out, { recursive: true });
const home = makeHome({
  settings: { version: 1, jellyfin: { url: "http://127.0.0.1:18199", altUrl: "http://127.0.0.1:18110", apiKey: "abc123" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" },
});
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK  " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`);
  if (!ok) failed++;
};
const app = await startApp({ home });
const wd = app.wd;
const video = () => wd.exec("const v=document.querySelector('video'); return v?{t:v.currentTime,paused:v.paused,dur:v.duration,err:v.error&&v.error.message,src:v.currentSrc.slice(0,80)}:null");
try {
  await waitFor(wd, "() => document.querySelector('.xmb')", { timeout: 40000, label: ".xmb" });
  await sleep(4000);
  const notice = await wd.exec("return [...document.querySelectorAll('.xmb-notice')].map(e=>e.textContent)");
  console.log("Hinweis:", JSON.stringify(notice));
  await wd.screenshot(path.join(out, "p1-menu.png"));
  await press(wd, "ArrowRight", { pause: 700 }); // Das Menü startet auf „Zuletzt“, der Film steht in „Filme“
  await press(wd, "Enter");
  await sleep(6000);
  const v = await video();
  console.log("Video:", JSON.stringify(v));
  check("Video-Element im Player", !!v);
  check("Wiedergabe läuft", !!v && v.t > 1 && !v.paused, v ? `t=${v.t}` : "");
  // WebKitGTK kann kein natives HLS: hls.js speist per MSE ein (blob:); sonst läuft die Quelle direkt über den Proxy.
  check("Quelle: MSE (HLS) oder Medien-Proxy", !!v && /^(blob:|http:\/\/127\.0\.0\.1:\d+\/p\/)/.test(v.src), v ? v.src : "");
  await wd.screenshot(path.join(out, "p2-player.png"));
  await press(wd, "Escape", { times: 2, pause: 1500 });
  check("Player geschlossen", (await video()) === null);
} catch (e) {
  console.log("FEHLER:", e.message);
  failed++;
  try { await wd.screenshot(path.join(out, "p-error.png")); } catch {}
} finally {
  await app.stop();
}
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);
