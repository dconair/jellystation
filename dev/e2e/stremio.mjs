#!/usr/bin/env node
// E2E: Stremio-Anbindung – Playwright/Chromium gegen den Vite-Dev-Server und ein Mock-Addon (wird hier selbst gestartet).
//
//   npx vite --port 5310 --strictPort --host 127.0.0.1 &
//   node dev/e2e/stremio.mjs --app http://127.0.0.1:5310 [--out <Ordner>] [--cinemeta]
//                            [--proxy <http://host:port>] [--playwright <Pfad zu playwright/index.mjs>] [--chromium <Browser>]
//
// Prüft: Spalten aus dem Katalog, Film → Streamliste (Torrent/YouTube ausgeblendet) → Player, Serie → Staffeln → Folgen → Stream,
// Einstellungen → Addon hinzufügen (mit Prüfung, Fehlermeldung bei falscher Adresse) und entfernen. Mit --cinemeta zusätzlich
// der echte Cinemeta-Katalog (braucht Internet).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockStremio } from "../mock-stremio/server.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP = arg("app", "http://127.0.0.1:1420").replace(/\/+$/, "");
const OUT = path.resolve(arg("out", fs.mkdtempSync(path.join(os.tmpdir(), "jellystation-stremio-"))));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import(arg("playwright", process.env.PLAYWRIGHT_MODULE || "playwright"));
const CHROMIUM = arg("chromium", process.env.CHROMIUM_PATH || undefined);

const mock = await startMockStremio({ port: Number(arg("mock-port", "0")) });
const PROXY = arg("proxy", "");
const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

let failed = 0;
let cinemetaBrowser = null;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK   " : "FEHLT"} ${name}${extra !== "" ? ` – ${extra}` : ""}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

const settings = (addons) => ({
  version: 1,
  jellyfin: { url: "", apiKey: "" },
  gamesDir: "",
  completedAt: "2026-01-01T00:00:00Z",
  ui: { bootAnimation: false },
  ...(addons.length ? { stremio: { addons } } : {}),
});

async function open(addons, b = browser) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem("jellystation.settings")) localStorage.setItem("jellystation.settings", JSON.stringify(s));
  }, settings(addons));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(APP);
  await page.waitForFunction(() => document.querySelector(".xmb") || document.body.innerText.length > 50, null, { timeout: 15000 });
  await sleep(800);
  return { ctx, page };
}
const key = async (page, k, n = 1) => {
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press(k);
    await sleep(160);
  }
};

try {
  /* ---- A: Spalten, Film, Serie ---- */
  {
    const { ctx, page } = await open([{ id: "mock1", url: mock.manifestUrl, name: "Mock-Addon" }]);
    await sleep(1200);
    let t = await text(page);
    check("Katalog-Spalten „Testfilme“ und „Testserien“", /Testfilme/.test(t) && /Testserien/.test(t));
    check("Katalog mit Suchpflicht wird übersprungen", !mock.log.some((l) => l.includes("mock-search")));
    // Zur Spalte „Testfilme“ navigieren (rechts bis sie fokussiert ist).
    for (let i = 0; i < 12 && !/Testfilm/.test(await text(page)); i += 1) await key(page, "ArrowRight");
    await sleep(500);
    check("Testfilm ist fokussiert", /Testfilm/.test(await text(page)));
    await page.screenshot({ path: path.join(OUT, "a1-spalte.png") });
    await key(page, "Enter");
    await sleep(1500);
    t = await text(page);
    check("Streamliste zeigt den direkten Link", /Mock 720p/.test(t) && /Mock-Addon/.test(t));
    check("Torrent und YouTube sind ausgeblendet (Hinweis)", !/Torrent\b.*Mock-Addon/.test(t) && /2 Streams ausgeblendet/.test(t), t.slice(0, 200));
    await page.screenshot({ path: path.join(OUT, "a2-streams.png") });
    await key(page, "Enter");
    await sleep(2500);
    const playing = await page.evaluate(() => {
      const v = document.querySelector("video");
      return v ? { src: v.currentSrc || v.src, t: v.currentTime, err: v.error?.code ?? null, ready: v.readyState } : null;
    });
    check("Player spielt die Stream-Adresse", !!playing && playing.src.includes("/demo.webm") && playing.err === null && playing.ready >= 2, JSON.stringify(playing));
    await page.screenshot({ path: path.join(OUT, "a3-player.png") });
    await key(page, "Escape");
    await sleep(1200);
    await key(page, "Escape");
    await sleep(600);
    check("Zurück im Menü", !(await page.evaluate(() => !!document.querySelector("video"))));

    // Serie
    await key(page, "ArrowRight");
    await sleep(500);
    check("Testserie ist fokussiert", /Testserie/.test(await text(page)));
    await key(page, "Enter");
    await sleep(1500);
    t = await text(page);
    check("Staffelliste", /Staffel 1/.test(t) && /Staffel 2/.test(t) && /3 Folgen/.test(t));
    await page.screenshot({ path: path.join(OUT, "a4-staffeln.png") });
    await key(page, "ArrowDown");
    await key(page, "Enter");
    await sleep(800);
    t = await text(page);
    check("Folgenliste der Staffel 2", /1\. Folge 1 der Staffel 2/.test(t) && /3\. Folge 3 der Staffel 2/.test(t));
    await page.screenshot({ path: path.join(OUT, "a5-folgen.png") });
    await key(page, "ArrowDown");
    await key(page, "Enter");
    await sleep(1500);
    t = await text(page);
    check("Streams der Folge", /Mock 720p/.test(t) && /S02 E02/.test(t));
    check("Stream-Anfrage mit Folgen-ID", mock.log.some((l) => /\/stream\/series\/tt9000002(:|%3A)2(:|%3A)2\.json/.test(l)), mock.log.filter((l) => l.includes("/stream/")).join(", "));
    await key(page, "Escape");
    await sleep(500);
    check("○ geht zurück zur Folgenliste", /Folge 1 der Staffel 2/.test(await text(page)));
    await key(page, "Escape");
    await sleep(400);
    await key(page, "Escape");
    await sleep(400);
    check("○ schließt alles", !/Staffel 1/.test(await text(page)));
    await ctx.close();
  }

  /* ---- B: Einstellungen – hinzufügen, falsche Adresse, entfernen ---- */
  {
    const { ctx, page } = await open([]);
    let t = await text(page);
    check("Ohne Addons keine Stremio-Spalten", !/Testfilme|Beliebt – Filme/.test(t));
    // Einstellungen-Spalte (ganz rechts), dort „Stremio“.
    await key(page, "ArrowRight", 14);
    await sleep(500);
    for (let i = 0; i < 14 && !/^\s*Stremio\b/.test(await page.evaluate(() => document.querySelector(".xmb-detail")?.innerText ?? "")); i += 1) await key(page, "ArrowDown");
    check("Einstellungen enthalten „Stremio“", /Stremio/.test(await text(page)));
    await key(page, "Enter");
    await sleep(700);
    t = await text(page);
    check("Liste mit Konto-Anmeldung und Hinzufügen", /Addon hinzufügen/.test(t) && /Mit Stremio-Konto anmelden/.test(t));
    await page.screenshot({ path: path.join(OUT, "b1-liste.png") });
    await key(page, "ArrowDown"); // erste Zeile ist die Konto-Anmeldung
    await key(page, "Enter");
    await sleep(500);
    const input = page.locator("input[inputmode=url]");
    await input.fill("https://127.0.0.1:1/manifest.json");
    await key(page, "Enter");
    await sleep(2500);
    check("Falsche Adresse → Fehlermeldung", /nicht erreichbar|Zeitüberschreitung/.test(await text(page)));
    await page.screenshot({ path: path.join(OUT, "b2-fehler.png") });
    await input.fill(`stremio://${mock.manifestUrl.replace(/^https?:\/\//, "")}`.replace("stremio://", "http://"));
    await key(page, "Enter");
    await sleep(1500);
    t = await text(page);
    check("Addon wird gespeichert und gelistet", /Mock-Addon/.test(t) && /1 eingetragen/.test(t), t.slice(0, 200));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("jellystation.settings")).stremio?.addons?.length ?? 0);
    check("Einstellungen enthalten das Addon", saved === 1);
    await key(page, "o");
    await sleep(400);
    check("△ fragt vor dem Entfernen nach", /Addon entfernen\?/.test(await text(page)));
    await key(page, "ArrowLeft");
    await key(page, "Enter");
    await sleep(600);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem("jellystation.settings")).stremio?.addons?.length ?? 0);
    check("Addon entfernt", after === 0);
    await ctx.close();
  }

  /* ---- C: echtes Cinemeta (optional) ---- */
  if (argv.includes("--cinemeta")) {
    // Eigener Browser: nur dieser Teil geht (falls nötig über --proxy) ins Netz, die lokalen Tests oben nicht.
    cinemetaBrowser = await chromium.launch({
      ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
      ...(PROXY ? { proxy: { server: PROXY } } : {}),
      // Die App selbst liegt auf 127.0.0.1 und darf nicht über den Proxy laufen.
      args: ["--no-sandbox", ...(PROXY ? ["--proxy-bypass-list=<-loopback>;127.0.0.1;localhost"] : [])],
    });
    const { ctx, page } = await open([{ id: "cm", url: "https://v3-cinemeta.strem.io/manifest.json", name: "Cinemeta" }], cinemetaBrowser);
    await sleep(5000);
    const labelOf = () => page.evaluate(() => document.querySelector(".xmb-detail")?.innerText ?? "");
    await key(page, "ArrowRight", 3); // Zuletzt → Filme → Serien → erste Stremio-Spalte
    await sleep(800);
    const t = await text(page);
    const detail = await labelOf();
    check("Cinemeta: Katalog-Spalten sichtbar", /Beliebt – Filme/.test(t), t.slice(0, 160));
    check("Cinemeta: echte Titel mit Poster", !/Lade Kataloge|nicht erreichbar/.test(t) && detail.length > 5, detail.slice(0, 100));
    await page.screenshot({ path: path.join(OUT, "c1-cinemeta.png") });
    await ctx.close();
  }
} catch (err) {
  console.log("FEHLER", err);
  failed += 1;
} finally {
  await browser.close();
  await cinemetaBrowser?.close();
  await mock.close();
}
console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen. Screenshots: ${OUT}` : `\nAlles in Ordnung. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
