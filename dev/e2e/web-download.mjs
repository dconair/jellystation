// E2E in der echten Tauri-App: Web-Fenster öffnen, Datei laden, einem System zuordnen.
//   xvfb-run -a -s "-screen 0 1280x720x24" node dev/e2e/web-download.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { makeHome, startApp, waitFor, press, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-e2e-out-"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "OK  " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`); if (!ok) failed++; };

const server = http.createServer((req, res) => {
  if (req.url === "/spiel.iso") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="Testspiel.iso"', "Content-Length": 1024 });
    res.end(Buffer.alloc(1024, 7));
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Testseite</h1>");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const home = makeHome({ settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" }, games: { PS2: ["Altes Spiel.iso"] } });
const app = await startApp({ home });
const wd = app.wd;
const invoke = (cmd, args) => wd.exec(`return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e) }))`, [cmd, args]);
try {
  await waitFor(wd, "() => document.querySelector('.xmb')", { timeout: 40000 });
  await sleep(2500);
  const dl = path.join(home, "JellyStation/Games/Downloads");
  let r = await invoke("web_open", { url: "file:///etc/passwd", title: "x", downloadDir: dl });
  check("file:// wird abgelehnt", r && r.ok === false, JSON.stringify(r));
  r = await invoke("web_open", { url: `http://127.0.0.1:${port}/spiel.iso`, title: "Test", downloadDir: dl });
  check("Web-Fenster öffnet", r && r.ok === true, JSON.stringify(r));
  const dialog = await waitFor(wd, "() => /Testspiel.*\\.iso“ geladen/.test(document.body.innerText.replace(/\\s+/g,' '))", { timeout: 25000, label: "Import-Dialog" }).catch(() => false);
  check("Nach dem Download fragt die App nach dem System", !!dialog);
  const files = () => (fs.existsSync(dl) ? fs.readdirSync(dl).filter((f) => /^Testspiel.*\.iso$/.test(f)) : []);
  check("Datei liegt im Download-Ordner", files().length === 1, files().join(","));
  await wd.screenshot(path.join(out, "wd1-import.png"));
  await press(wd, "ArrowDown", { pause: 300 });
  await press(wd, "Enter", { pause: 1500 });
  const ps2 = path.join(home, "JellyStation/Games/PS2");
  const moved = fs.readdirSync(ps2).filter((f) => /^Testspiel.*\.iso$/.test(f));
  check("Datei wurde nach PS2/ verschoben", moved.length === 1 && files().length === 0, moved.join(","));
  const t = await wd.exec("return document.body.innerText.replace(/\\s+/g,' ')");
  check("Meldung „Übernommen“", /Übernommen/.test(t));
  await wd.screenshot(path.join(out, "wd2-done.png"));
  r = await invoke("web_close", {});
  check("Fenster lässt sich schließen", r && r.ok === true);
} catch (e) { console.log("FEHLER:", e.message); failed++; try { await wd.screenshot(path.join(out, "wd-error.png")); } catch {} }
finally { await app.stop(); server.close(); }
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);
