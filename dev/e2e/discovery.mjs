// E2E: Setup-Assistent sucht Jellyfin-Server per UDP-Broadcast (ein Fake-Server antwortet auf Port 7359).
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeHome, startApp, waitFor, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-e2e-out-"));
fs.mkdirSync(out, { recursive: true });
const home = makeHome({}); // keine Einstellungen → Setup-Assistent
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "OK  " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`); if (!ok) failed++; };

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
let asked = 0;
sock.on("message", (msg, rinfo) => {
  if (msg.toString() !== "who is JellyfinServer?") return;
  asked++;
  sock.send(JSON.stringify({ Address: "http://192.168.77.5:8096", Id: "abc123", Name: "Testserver" }), rinfo.port, rinfo.address);
});
await new Promise((r) => sock.bind(7359, "0.0.0.0", r));

const app = await startApp({ home });
const wd = app.wd;
try {
  await waitFor(wd, "() => document.querySelector('input[inputmode=url]')", { timeout: 40000, label: "Setup" });
  await sleep(3500);
  const text = await wd.exec("return document.body.innerText");
  console.log(text.replace(/\s+/g, " ").slice(0, 500));
  check("Fake-Server wurde angefragt", asked > 0, `${asked} Anfrage(n)`);
  check("Server gefunden", /Server gefunden|Kein Server gefunden/.test(text));
  const url = await wd.exec("return document.querySelector('input[inputmode=url]').value");
  console.log("URL-Feld:", url);
  await wd.screenshot(path.join(out, "d1-setup.png"));
} catch (e) { console.log("FEHLER:", e.message); failed++; }
finally { await app.stop(); sock.close(); }
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);
