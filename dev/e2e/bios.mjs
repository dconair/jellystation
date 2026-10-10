// E2E in der echten Tauri-App: BIOS-/Firmware-Prüfung (Setup-Schritt „Dateien“, Dialog, Vorabprüfung beim Spielstart).
//   xvfb-run -a -s "-screen 0 1280x720x24" node dev/e2e/bios.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeHome, startApp, waitFor, press, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-e2e-out-"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "OK  " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`); if (!ok) failed++; };
const clickBtn = (wd, label) => wd.exec(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith(arguments[0])); if(b){b.click();return true} return false`, [label]);
const bodyText = (wd) => wd.exec("return document.body.innerText.replace(/\\s+/g,' ')");

/* ---- A: Setup-Schritt „Dateien“ ---- */
{
  const home = makeHome({});
  fs.mkdirSync(path.join(home, "JellyStation/BIOS/PS2"), { recursive: true });
  fs.writeFileSync(path.join(home, "JellyStation/BIOS/PS2/scph10000.bin"), Buffer.alloc(4 * 1024 * 1024));
  const app = await startApp({ home });
  const wd = app.wd;
  try {
    await waitFor(wd, "() => document.querySelector('input[inputmode=url]')", { timeout: 40000 });
    await clickBtn(wd, "Überspringen"); await sleep(600);
    await clickBtn(wd, "Überspringen"); await sleep(3000);
    const t = await bodyText(wd);
    console.log(t.slice(0, 700));
    check("Schritt „Emulatoren, BIOS & Firmware“", /Emulatoren, BIOS/.test(t));
    check("PS2-BIOS im BIOS-Ordner erkannt", /PS2-BIOS Im BIOS-Ordner gefunden/.test(t));
    check("PS1-BIOS fehlt", /PS1-BIOS Fehlt/.test(t));
    check("Link-Buttons vorhanden", /Download-Seite öffnen/.test(t) && /PCSX2: BIOS sichern/.test(t));
    check("Zusammenfassung „Noch offen“", /Noch offen:/.test(t));
    await wd.screenshot(path.join(out, "b1-wizard.png"));
  } catch (e) { console.log("FEHLER A:", e.message); failed++; try { await wd.screenshot(path.join(out, "b-errorA.png")); } catch {} }
  finally { await app.stop(); }
}

/* ---- B: Vorabprüfung, Dialog, Übernehmen ---- */
{
  const home = makeHome({
    settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" },
    games: { PS2: ["Test Game.iso"] },
    emulators: [{ bundle: "PCSX2.app", exe: "PCSX2", id: "net.pcsx2.pcsx2" }],
  });
  fs.mkdirSync(path.join(home, "JellyStation/BIOS"), { recursive: true });
  fs.writeFileSync(path.join(home, "JellyStation/BIOS/scph77001.bin"), Buffer.alloc(4 * 1024 * 1024));
  const log = path.join(home, "emu-args.txt");
  const app = await startApp({ home, env: { FAKE_EMU_LOG: log, FAKE_EMU_SLEEP: "5" } });
  const wd = app.wd;
  try {
    await waitFor(wd, "() => document.querySelector('.xmb')", { timeout: 40000 });
    await sleep(3000);
    await press(wd, "ArrowRight", { times: 2, pause: 500 });
    await sleep(800);
    await press(wd, "Enter");
    await sleep(3000);
    let t = await bodyText(wd);
    check("Vor dem Start erscheint der Hinweis zu PS2-BIOS", /BIOS & Firmware/.test(t) && /PCSX2 braucht noch: PS2-BIOS/.test(t), t.slice(0, 200));
    check("Spiel wurde (noch) nicht gestartet", !fs.existsSync(log));
    await wd.screenshot(path.join(out, "b2-preflight.png"));
    await press(wd, "Enter"); await sleep(1200); // Aktionsliste der fokussierten Anforderung
    t = await bodyText(wd);
    check("Aktion „In den Emulator übernehmen“", /In den Emulator übernehmen/.test(t));
    await wd.screenshot(path.join(out, "b3-actions.png"));
    await press(wd, "Enter"); await sleep(2500);
    const dest = path.join(home, "Library/Application Support/PCSX2/bios/scph77001.bin");
    check("BIOS wurde in den PCSX2-Ordner kopiert", fs.existsSync(dest) && fs.statSync(dest).size === 4 * 1024 * 1024, dest);
    t = await bodyText(wd);
    check("Erfolgsmeldung", /übernommen/.test(t));
    await wd.screenshot(path.join(out, "b4-copied.png"));
    await press(wd, "Enter"); await sleep(800);          // Meldung schließen
    await press(wd, "Escape", { times: 2, pause: 800 }); // Aktionsliste/Dialog schließen
    await sleep(500);
    await press(wd, "Enter"); await sleep(3500);          // Spiel erneut starten
    const end = Date.now() + 8000;
    while (!fs.existsSync(log) && Date.now() < end) await sleep(300);
    check("Spiel startet jetzt", fs.existsSync(log), fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().replace(/\n/g, " ") : "");
  } catch (e) { console.log("FEHLER B:", e.message); failed++; try { await wd.screenshot(path.join(out, "b-errorB.png")); } catch {} }
  finally { await app.stop(); }
}
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);
