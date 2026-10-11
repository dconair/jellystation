#!/usr/bin/env node
// E2E: Diagnose – Playwright/Chromium gegen den Vite-Dev-Server, Tauri-Attrappe (dev/tauri-mock.mjs) und
// erfundene Antworten der Diagnose-Befehle (kein echtes Dateisystem, keine echten Emulatoren).
//
//   npx vite --port 5310 --strictPort --host 127.0.0.1 &
//   node dev/e2e/diagnose.mjs --app http://127.0.0.1:5310 [--out <Ordner>]
//                             [--playwright <Pfad zu playwright/index.mjs>] [--chromium <Browser>]
//
// Prüft: Einstellungen → Diagnose zeigt Befunde (Quarantäne, BIOS im BIOS-Ordner, defekte Spieldateien), „Behebbares
// beheben“ ruft diag_clear_quarantine und bios_copy auf, und ein sofort beendetes Spiel öffnet die Diagnose von selbst.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeEmulatorBackend, installTauriMock } from "../tauri-mock.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP = arg("app", "http://127.0.0.1:1420").replace(/\/+$/, "");
const OUT = path.resolve(arg("out", fs.mkdtempSync(path.join(os.tmpdir(), "jellystation-diagnose-"))));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import(arg("playwright", process.env.PLAYWRIGHT_MODULE || "playwright"));
const CHROMIUM = arg("chromium", process.env.CHROMIUM_PATH || undefined);

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK   " : "FEHLT"} ${name}${extra !== "" ? ` – ${extra}` : ""}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = "/Users/test";
const GAMES = `${HOME}/Games`;
const probeBase = { exists: true, isDir: false, isFile: true, readable: true, size: 4096, headHex: "", names: [], refs: [], quarantined: false, error: null };
const FILES = {
  [`${GAMES}/Gut.iso`]: { ...probeBase },
  [`${GAMES}/Leer.iso`]: { ...probeBase, size: 0 },
  [`${GAMES}/Weg.iso`]: { ...probeBase, exists: false, isFile: false, readable: false },
  [`${GAMES}/Gepackt.zip`]: { ...probeBase, headHex: "504b0304" },
  [GAMES]: { ...probeBase, isDir: true, isFile: false },
  "/Applications/PCSX2.app": { ...probeBase, isDir: true, isFile: false, quarantined: true },
};

const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on("pageerror", (e) => console.log("Seitenfehler:", e.message));

const mock = await installTauriMock(page, {
  home: HOME,
  store: { "settings.json": { settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: GAMES, completedAt: "2026-01-01T00:00:00Z", ui: { bootAnimation: false } } } },
});
const fake = installFakeEmulatorBackend(mock, { home: HOME, apps: { "/Applications/PCSX2.app": { version: "2.0.0", bundleId: "net.pcsx2.pcsx2" } } });
let quarantined = true;
let biosCopied = false;
const game = (name, system = "PS2") => ({
  path: `${GAMES}/${name}`, rel: name, name: name.replace(/\.[^.]+$/, ""), kind: "file", ext: name.split(".").pop(), size: 4096,
  system, how: "content", uncertain: false, guess: null, serial: null, title: null, reason: "Test",
});
mock.on("games_scan", async () => ({
  root: GAMES,
  games: [game("Gut.iso"), game("Leer.iso"), game("Weg.iso"), game("Gepackt.zip")],
  images: [], truncated: false, unreadable: 0,
}));
mock.on("cover_resolve", async () => ({ path: null, source: null, width: 0, height: 0, serial: null, error: null }));
mock.on("requirements_scan", async ({ specs }) =>
  specs.map((s) => ({
    id: s.id,
    found: s.id === "ps2-bios" && !biosCopied ? [{ kind: "folder", dir: `${HOME}/JellyStation/BIOS`, path: `${HOME}/JellyStation/BIOS/scph.bin`, size: 4 << 20 }]
      : s.id === "ps2-bios" ? [{ kind: "emulator", dir: "x", path: "x/scph.bin", size: 4 << 20 }] : [],
  })),
);
mock.on("bios_copy", async () => { biosCopied = true; return `${HOME}/Library/Application Support/PCSX2/bios/scph.bin`; });
mock.on("diag_probe", async ({ paths }) =>
  paths.map((p) => {
    const f = FILES[p];
    if (p === "/Applications/PCSX2.app") return { ...f, path: p, quarantined };
    if (p.endsWith("scph.bin")) return { ...probeBase, path: p, size: 4 << 20, headHex: "0c0f20e30000a0e1" };
    return { ...(f ?? { ...probeBase, exists: false, isFile: false, readable: false }), path: p };
  }),
);
mock.on("diag_log_tail", async () => null);
mock.on("diag_clear_quarantine", async () => { quarantined = false; });

const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const key = async (k, times = 1) => { for (let i = 0; i < times; i++) { await page.keyboard.press(k); await sleep(250); } };

try {
  await page.goto(APP + "/");
  await page.waitForSelector(".xmb", { timeout: 30000 });
  await sleep(1500);

  // Einstellungen → Diagnose
  let guard = 0;
  while (!(await text()).includes("Einstellungen") && guard++ < 3) await sleep(500);
  const settings = page.getByText("Einstellungen", { exact: true }).first();
  await settings.click({ timeout: 5000 }).catch(() => undefined);
  await sleep(900);
  let found = false;
  for (let i = 0; i < 14 && !found; i++) {
    const focused = await page.evaluate(() => document.querySelector(".xmb")?.innerText ?? "");
    if (/Diagnose/.test(focused) && /Probleme mit Spielen/.test(focused)) found = true;
    else await key("ArrowDown");
  }
  await page.screenshot({ path: path.join(OUT, "d1-menu.png") });
  check("Einstellungen enthält den Eintrag „Diagnose“", found);
  // Der Eintrag muss fokussiert sein; ✕ öffnet ihn.
  for (let i = 0; i < 14; i++) {
    const sel = await page.evaluate(() => document.querySelector(".xmb [aria-current='true'], .xmb .is-focused, .xmb [data-focused='true']")?.textContent ?? "");
    if (/Diagnose/.test(sel)) break;
    await key("ArrowDown");
  }
  await key("Enter");
  await page.waitForFunction(() => /Diagnose/.test(document.body.innerText) && /Probleme|Hinweise/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => undefined);
  await sleep(1500);
  let t = await text();
  await page.screenshot({ path: path.join(OUT, "d2-diagnose.png") });
  check("Diagnose-Dialog öffnet", /Diagnose/.test(t) && /Neu prüfen/.test(t), t.slice(0, 160));
  check("Quarantäne wird erkannt", /PCSX2: von macOS in Quarantäne gesetzt/.test(t));
  check("BIOS im BIOS-Ordner wird erkannt", /PS2-BIOS liegt noch im BIOS-Ordner/.test(t));
  check("Fehlende Spieldatei wird gemeldet", /Spieldatei nicht gefunden/.test(t));
  check("Leere Spieldatei wird gemeldet", /Spieldatei ist leer/.test(t));
  check("Archiv wird gemeldet", /Spiel liegt noch gepackt vor/.test(t));
  check("„Behebbares beheben (2)“ wird angeboten", /Behebbares beheben \(2\)/.test(t));

  // Alles Behebbare beheben
  const fixAll = page.getByText(/Behebbares beheben/).first();
  await fixAll.click();
  await page.waitForFunction(() => /Erledigt/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => undefined);
  await sleep(800);
  t = await text();
  await page.screenshot({ path: path.join(OUT, "d3-fixed.png") });
  check("diag_clear_quarantine wurde aufgerufen", mock.callsOf("diag_clear_quarantine").length === 1);
  check("bios_copy wurde aufgerufen", mock.callsOf("bios_copy").length === 1);
  check("Meldung „Erledigt“", /Erledigt/.test(t));
  await key("Enter"); // Meldung schließen
  await sleep(1500);
  t = await text();
  check("Nach dem Beheben sind Quarantäne und BIOS-Hinweis weg", !/in Quarantäne gesetzt/.test(t) && !/liegt noch im BIOS-Ordner/.test(t) && /PS2-BIOS vorhanden/.test(t));
  for (let i = 0; i < 4 && /Neu prüfen/.test(await text()); i++) await key("Escape");
  await sleep(600);
  check("Dialog lässt sich mit ○ schließen", !/Neu prüfen/.test(await text()));

  // Fehlstart → Diagnose öffnet von selbst
  fake.onLaunch((req, ctl) => setTimeout(() => ctl.exit({ code: 1, durationMs: 600, stderrTail: ["E/Host: No BIOS image found for this region"] }), 200));
  await key("ArrowLeft", 5); // Einstellungen → Spiele · PS2
  await sleep(600);
  await key("Enter");
  await page.waitForFunction(() => /Das Spiel wurde sofort beendet/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => undefined);
  await sleep(800);
  t = await text();
  await page.screenshot({ path: path.join(OUT, "d4-launch-failed.png") });
  check("Nach einem Fehlstart öffnet sich die Diagnose von selbst", /Diagnose/.test(t) && /Das Spiel wurde sofort beendet/.test(t));
  check("Die Ausgabe wird als Ursache erkannt (BIOS)", /BIOS fehlt oder wird nicht gefunden/.test(t));
  await key("ArrowDown");
  await key("Enter"); // Befund „BIOS fehlt“ öffnen
  await sleep(800);
  t = await text();
  await page.screenshot({ path: path.join(OUT, "d5-finding.png") });
  check("Befund zeigt Erklärung, Auszug aus der Ausgabe und die Behebung", /Lege dein eigenes BIOS/.test(t) && /No BIOS image found/.test(t) && /BIOS & Firmware/.test(t));
} catch (e) {
  console.log("FEHLER:", e.message);
  failed += 1;
  try { await page.screenshot({ path: path.join(OUT, "fehler.png") }); } catch { /* egal */ }
} finally {
  await browser.close();
}
console.log(`\nScreenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
