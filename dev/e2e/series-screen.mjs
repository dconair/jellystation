#!/usr/bin/env node
// E2E: Serien-Screen (Staffel-Auswahl, Folgenliste, Folgen-Details) – Playwright/Chromium gegen den Vite-Dev-Server,
// den Mock-Jellyfin (wird hier selbst gestartet) und den Demo-Modus.
//
//   npx vite --port 5302 --strictPort --host 127.0.0.1 &
//   node dev/e2e/series-screen.mjs --app http://127.0.0.1:5302 [--out <Ordner>] [--mock-port 18302]
//                                  [--only uebersicht,details,sonder,laden,maus,pad,demo,groessen]
//                                  [--playwright <Pfad zu playwright/index.mjs>] [--chromium <Browser>]
//
// Playwright und Browser lassen sich per Argument oder Umgebung (PLAYWRIGHT_MODULE, CHROMIUM_PATH) angeben; ohne beides gilt
// `import("playwright")`. Der Controller wird über navigator.getGamepads nachgebaut. Screenshots (1280×720 und 1024×640) landen in --out.
// Testdaten: Mock-Serie "Stranger Things" (4 Staffeln + Specials, lange Texte, Folge S2 E2 bei 0:12), "Testserie", "Serie fertig",
// "Serie neu", "Serie ohne Staffelzahl" (ohne Folgen); Demo: 2 Staffeln, eine Folge gesehen, eine angefangen.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockJellyfin } from "../mock-jellyfin/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP = arg("app", "http://127.0.0.1:1420").replace(/\/+$/, "");
const OUT = path.resolve(arg("out", fs.mkdtempSync(path.join(os.tmpdir(), "jellystation-series-"))));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import(arg("playwright", process.env.PLAYWRIGHT_MODULE || "playwright"));
const CHROMIUM = arg("chromium", process.env.CHROMIUM_PATH || undefined);

const mock = await startMockJellyfin({ port: Number(arg("mock-port", "0")), mediaDir: path.join(HERE, "../mock-jellyfin/media") });
const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK   " : "FEHLT"} ${name}${extra !== "" ? ` – ${extra}` : ""}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Nur bestimmte Abschnitte laufen lassen: --only details,maus (uebersicht, details, sonder, laden, maus, pad, demo, groessen). */
const only = arg("only", "").split(",").filter(Boolean);
const run = (name) => only.length === 0 || only.includes(name);

/* ------------------------------------------------------------------ Hilfen */

const PAD_BUTTON = { confirm: 0, back: 1, l1: 4, r1: 5, up: 12, down: 13, left: 14, right: 15 };

async function newPage(jellyfinUrl, size = { width: 1280, height: 720 }) {
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.addInitScript(
    (s) => localStorage.setItem("jellystation.settings", s),
    JSON.stringify({ version: 1, jellyfin: { url: jellyfinUrl, apiKey: jellyfinUrl ? "abc123" : "" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" }),
  );
  // Controller: ein DualSense, dessen Tasten über window.__tap gedrückt werden
  await page.addInitScript(() => {
    const pad = {
      id: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
      index: 0,
      connected: true,
      mapping: "standard",
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    navigator.getGamepads = () => [pad];
    window.__tap = (i) =>
      new Promise((resolve) => {
        pad.buttons[i].pressed = true;
        setTimeout(() => {
          pad.buttons[i].pressed = false;
          setTimeout(resolve, 100);
        }, 100);
      });
  });
  await page.goto(`${APP}/`);
  await page.waitForSelector(".xmb", { timeout: 20000 });
  await sleep(2500);
  return { page, ctx, errors };
}

const key = async (page, k, n = 1, wait = 450) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(k);
    await sleep(wait);
  }
};
const tap = async (page, name, n = 1, wait = 350) => {
  for (let i = 0; i < n; i++) {
    await page.evaluate((b) => window.__tap(b), PAD_BUTTON[name]);
    await sleep(wait);
  }
};

const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 1500 }).then((t) => (t ?? "").replace(/\s+/g, " ").trim()).catch(() => null);
const texts = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));
const count = (page, sel) => page.locator(sel).count();
const has = async (page, sel) => (await count(page, sel)) > 0;
const waitFor = (page, sel, ms = 8000) => page.waitForSelector(sel, { timeout: ms }).then(() => true, () => false);
const gone = (page, sel, ms = 4000) => page.waitForSelector(sel, { state: "detached", timeout: ms }).then(() => true, () => false);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const seasonLabel = (page) => text(page, ".series-select__label");
const mainLabel = (page) => text(page, ".series-play");
const rowTitles = (page) => texts(page, ".series-list:not(.is-leaving) .series-row__title");
const focusedRow = (page) => text(page, ".series-row.is-focused .series-row__title");
const detailTitle = (page) => text(page, ".series-detail:not(.is-leaving) .series-detail__title");
const buttonLabels = (page) => texts(page, ".series-detail .series-btn");
const focusedButton = (page) => text(page, ".series-detail .series-btn.is-focused");
const playerInfo = (page) =>
  page.evaluate(() => {
    const v = document.querySelector("video.player-video");
    return v ? { t: v.currentTime, paused: v.paused, src: v.currentSrc } : null;
  });

/** Zur Kategorie „Serien“ und zum Eintrag `title`; Enter öffnet den Serien-Screen. */
async function openSeries(page, title, via = "key") {
  const press = (name) => (via === "pad" ? tap(page, name, 1, 400) : key(page, { right: "ArrowRight", down: "ArrowDown", confirm: "Enter" }[name], 1, 450));
  for (let i = 0; i < 12 && !/Serien/i.test((await text(page, ".xmb-category.is-active .xmb-category__label")) ?? ""); i++) await press("right");
  for (let i = 0; i < 14; i++) await key(page, "ArrowUp", 1, 120); // erst nach oben, der Fokus kann noch weiter unten stehen
  for (let i = 0; i < 24; i++) {
    const t = await text(page, ".xmb-item.is-focused .xmb-item__title");
    if (title === "*" || t === title) break;
    await press("down");
  }
  await sleep(500);
  await press("confirm");
  return waitFor(page, ".series-screen", 8000);
}

async function waitReady(page) {
  await page.waitForFunction(() => !document.querySelector(".series-status[role=status]") || /Keine Folgen/.test(document.querySelector(".series-status")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
  await sleep(500);
}

/** Läuft das Bild und steht es ungefähr bei `t0..t1` Sekunden? */
async function expectPlayer(page, name, t0, t1) {
  const ok = await page
    .waitForFunction(
      ([a, b]) => {
        const v = document.querySelector("video.player-video");
        return !!v && !v.paused && v.currentTime >= a && v.currentTime <= b;
      },
      [t0, t1],
      { timeout: 25000 },
    )
    .then(() => true, () => false);
  const info = await playerInfo(page);
  check(name, ok, info ? `t=${info.t.toFixed(1)} s` : "kein Player");
  return ok;
}

async function closePlayer(page) {
  for (let i = 0; i < 4 && (await has(page, "video.player-video")); i++) await key(page, "Escape", 1, 900);
}

const logOf = (re, method) => mock.log.filter((e) => re.test(e.path) && (!method || e.method === method));

/* ------------------------------------------------------- 1. Mock: Übersicht */

if (run("uebersicht")) {
  console.log("\n== Mock-Jellyfin: Übersicht, Staffel-Auswahl ==");
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);
  check("Serien-Screen öffnet", await openSeries(page, "Stranger Things"));
  await waitReady(page);
  await sleep(800);
  check("Hauptknopf: Weiterschauen · S2 E2", /Weiterschauen · S2 E2/.test((await mainLabel(page)) ?? ""), await mainLabel(page));
  check("Hauptknopf hat den Fokus beim Öffnen", await has(page, ".series-play.is-focused"));
  check("Staffel der Weiterschauen-Folge ist vorgewählt", (await seasonLabel(page)) === "Staffel 2", await seasonLabel(page));
  check("Titelzeile: Jahr · Genre · Staffeln", /2016 · Fantasy · 4 Staffeln/.test((await text(page, ".series-meta")) ?? ""), await text(page, ".series-meta"));
  check("nur die Folgen der gewählten Staffel", (await rowTitles(page)).length === 2, (await rowTitles(page)).join(" | "));
  check("Beschreibung der Serie (lang) wird nachgeladen", /Vier Staffeln lang/.test((await text(page, ".series-synopsis")) ?? "") || (await text(page, ".series-synopsis"))?.endsWith("…") === true || (await text(page, ".series-synopsis")) !== "", await text(page, ".series-synopsis"));
  await shot(page, "m01-uebersicht");

  // Das Hauptmenü ist gesperrt: Pfeil nach links/rechts bewegt die Kategorien nicht
  await key(page, "ArrowRight", 2, 400);
  await key(page, "ArrowLeft", 2, 400);
  check("Hauptmenü bleibt gesperrt", /Serien/.test((await text(page, ".xmb-category.is-active .xmb-category__label")) ?? ""));

  // Fokus-Reihenfolge Hauptknopf → Dropdown → Liste
  await key(page, "ArrowDown");
  check("↓ Hauptknopf → Staffel-Auswahl", await has(page, ".series-select.is-focused"));
  await sleep(500);
  await shot(page, "m02-staffelfokus");
  await key(page, "ArrowDown");
  check("↓ Staffel-Auswahl → Folgenliste (Fokus auf der Weiterschauen-Folge)", (await focusedRow(page)) === "Kapitel Zwei: Süßes oder Saures, Freak", await focusedRow(page));
  await key(page, "ArrowUp");
  check("↑ in der Liste", (await focusedRow(page)) === "Kapitel Eins: Mad Max", await focusedRow(page));
  await key(page, "ArrowDown");
  await key(page, "ArrowDown");
  check("↓ am Listenende bleibt stehen", (await focusedRow(page)) === "Kapitel Zwei: Süßes oder Saures, Freak");
  await key(page, "ArrowUp", 3);
  check("↑↑↑ (Liste, Staffel-Auswahl) zurück zum Hauptknopf", await has(page, ".series-play.is-focused"));

  // Dropdown öffnen, Staffel per ✕ wählen
  await key(page, "ArrowDown");
  await key(page, "Enter", 1, 500);
  check("✕ öffnet die Staffelliste", await has(page, ".series-menu"));
  const names = await texts(page, ".series-menu__row");
  check("Liste: Staffel 1–4, Specials zuletzt, mit Stand", names.length === 5 && /^Staffel 1.*Alle 3 gesehen/.test(names[0]) && /^Staffel 2.*1 von 2 gesehen/.test(names[1]) && /^Staffel 3.*2 Folgen/.test(names[2]) && /^Specials.*1 Folge/.test(names[4]), names.join(" | "));
  check("aktuelle Staffel hat den Haken", (await count(page, ".series-menu__check svg")) === 1 && /Staffel 2/.test((await text(page, ".series-menu__row.is-focused")) ?? ""));
  await shot(page, "m03-dropdown");
  await key(page, "ArrowDown");
  await key(page, "Enter", 1, 800);
  check("Staffel 3 gewählt", (await seasonLabel(page)) === "Staffel 3" && !(await has(page, ".series-menu")), await seasonLabel(page));
  check("Liste zeigt Staffel 3", (await rowTitles(page)).length === 2 && /Suzie/.test((await rowTitles(page))[0] ?? ""), (await rowTitles(page)).join(" | "));
  await sleep(600);
  check("Überblendung ist vorbei (keine alte Liste)", (await count(page, ".series-list")) === 1, `Listen: ${await count(page, ".series-list")}`);
  await shot(page, "m04-staffel3");

  // ○ schließt zuerst nur die Liste
  await key(page, "Enter", 1, 500);
  await key(page, "Escape", 1, 500);
  check("○ schließt nur die Staffelliste", !(await has(page, ".series-menu")) && (await has(page, ".series-screen")));

  // ←/→ auf dem Dropdown, PageUp/PageDown überall
  await key(page, "ArrowRight");
  check("→ auf dem Dropdown: nächste Staffel", (await seasonLabel(page)) === "Staffel 4", await seasonLabel(page));
  await key(page, "ArrowLeft", 2);
  check("← ← : Staffel 2", (await seasonLabel(page)) === "Staffel 2", await seasonLabel(page));
  await key(page, "ArrowRight", 3);
  check("→ bis zu den Specials, dort Schluss", (await seasonLabel(page)) === "Specials" && (await rowTitles(page)).length === 1, await seasonLabel(page));
  await key(page, "ArrowDown");
  await key(page, "PageUp");
  check("Bild↑ in der Liste: vorige Staffel, Fokus bleibt in der Liste", (await seasonLabel(page)) === "Staffel 4" && (await focusedRow(page)) === "Kapitel Eins: Der Hellfire Club", `${await seasonLabel(page)} / ${await focusedRow(page)}`);
  await key(page, "PageDown");
  check("Bild↓: nächste Staffel (Specials)", (await seasonLabel(page)) === "Specials");
  await key(page, "ArrowUp", 2);
  await key(page, "PageUp", 4);
  check("Bild↑ vom Hauptknopf aus: Staffel 1", (await seasonLabel(page)) === "Staffel 1" && (await has(page, ".series-play.is-focused")), await seasonLabel(page));
  check("Staffel 1 wurde nur gewechselt, nichts gestartet", !(await has(page, "video")));
  await shot(page, "m05-staffel1-expanded");
  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ------------------------------------- 2. Mock: Details, Fortsetzen, Markieren */

if (run("details")) {
  console.log("\n== Mock-Jellyfin: Folgen-Details ==");
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);
  await openSeries(page, "Stranger Things");
  await waitReady(page);
  // Staffel 1, erste Folge (gesehen, lange Beschreibung)
  await key(page, "PageUp");
  await key(page, "ArrowDown", 2);
  check("Fokus auf Folge 1", (await focusedRow(page)) === "Kapitel Eins: Das Verschwinden von Will Byers", await focusedRow(page));
  await shot(page, "m06-liste-staffel1");
  await key(page, "Enter", 1, 900);
  check("✕ auf einer Folge öffnet die Details (und startet nicht)", (await has(page, ".series-detail")) && !(await has(page, "video")));
  check("Titel der Folge", (await detailTitle(page)) === "Kapitel Eins: Das Verschwinden von Will Byers", await detailTitle(page));
  check("Kopfzeile: S1 E1 · 1 Min.", /S1 E1 · 1 Min\./.test((await text(page, ".series-detail__meta")) ?? ""), await text(page, ".series-detail__meta"));
  await page.waitForFunction(() => document.querySelectorAll(".series-detail__text p").length >= 4, null, { timeout: 8000 }).catch(() => {});
  check("volle Beschreibung (4 Absätze)", (await count(page, ".series-detail__text p")) === 4, `${await count(page, ".series-detail__text p")}`);
  check("lange Beschreibung ist scrollbar", await has(page, ".series-detail__textwrap.is-scrollable"));
  check("Gesehen-Haken sichtbar", await has(page, ".series-detail__seen"));
  check("Knöpfe: Abspielen + Als ungesehen markieren", (await buttonLabels(page)).join("|") === "Abspielen|Als ungesehen markieren", (await buttonLabels(page)).join("|"));
  check("Abspielen ist fokussiert", (await focusedButton(page)) === "Abspielen");
  check("Reihe „Weitere Folgen“: 4 Kacheln", (await count(page, ".series-tile")) === 4, `${await count(page, ".series-tile")}`);
  await sleep(500);
  await shot(page, "m07-detail-lang");

  // Beschreibung mit ↑↓ lesen
  await key(page, "ArrowUp", 1, 500);
  check("↑ springt in die Beschreibung", await has(page, ".series-detail__textwrap.is-focused"));
  await key(page, "ArrowDown", 1, 700);
  const sc1 = await page.evaluate(() => document.querySelector(".series-detail__text")?.scrollTop ?? 0);
  check("↓ scrollt die Beschreibung", sc1 > 20, `scrollTop ${Math.round(sc1)}`);
  await shot(page, "m08-detail-gelesen");
  for (let i = 0; i < 14 && (await has(page, ".series-detail__textwrap.is-focused")); i++) await key(page, "ArrowDown", 1, 450);
  check("am Ende der Beschreibung geht ↓ zu den Knöpfen", !(await has(page, ".series-detail__textwrap.is-focused")) && (await focusedButton(page)) === "Abspielen");

  // Gesehen/ungesehen umschalten (Server)
  await key(page, "ArrowRight");
  check("→ wählt „Als ungesehen markieren“", (await focusedButton(page)) === "Als ungesehen markieren");
  await key(page, "Enter", 1, 900);
  check("Server bekommt DELETE /UserPlayedItems", logOf(/userplayeditems/i, "DELETE").length === 1, JSON.stringify(logOf(/userplayeditems/i).map((e) => e.method)));
  check("Knopf heißt jetzt „Als gesehen markieren“", (await buttonLabels(page))[1] === "Als gesehen markieren" && !(await has(page, ".series-detail__seen")), (await buttonLabels(page)).join("|"));
  await key(page, "Enter", 1, 900);
  check("zurück: POST /UserPlayedItems", logOf(/userplayeditems/i, "POST").length === 1 && (await buttonLabels(page))[1] === "Als ungesehen markieren");

  // Weitere Folgen und Folgenwechsel
  await key(page, "ArrowDown");
  check("↓ auf die Reihe „Weitere Folgen“", await has(page, ".series-tile.is-focused"));
  await key(page, "ArrowRight");
  await key(page, "Enter", 1, 900);
  check("✕ auf einer Kachel wechselt die Detailseite", (await detailTitle(page)) === "Kapitel Drei: Holly, Jolly", await detailTitle(page));
  await key(page, "PageDown", 1, 700);
  check("Bild↓ (R1): nächste Folge", (await detailTitle(page)) === "Kapitel Eins: Mad Max", await detailTitle(page));
  await key(page, "PageUp", 2, 700);
  check("Bild↑ (L1): vorige Folgen", (await detailTitle(page)) === "Kapitel Zwei: Die Verrückte in der Straße", await detailTitle(page));
  await shot(page, "m09-detail-kurz");

  // ○ zurück: Übersicht, Fokus auf der Folge, Staffel stimmt
  await key(page, "Escape", 1, 900);
  check("○ schließt die Details", !(await has(page, ".series-detail")) && (await has(page, ".series-screen")));
  check("Fokus bleibt auf der Folge", (await focusedRow(page)) === "Kapitel Zwei: Die Verrückte in der Straße" && (await seasonLabel(page)) === "Staffel 1", `${await focusedRow(page)} / ${await seasonLabel(page)}`);

  // Folge mit Stand: Fortsetzen / Von vorn
  await key(page, "PageDown");
  await key(page, "ArrowDown");
  check("Staffel 2, Folge 2 fokussiert", (await focusedRow(page)) === "Kapitel Zwei: Süßes oder Saures, Freak", await focusedRow(page));
  check("Fortschrittsbalken in der Zeile", await has(page, ".series-row.is-focused .series-row__progress"));
  await key(page, "Enter", 1, 900);
  check("Knöpfe: Fortsetzen bei 0:12 / Von vorn / Markieren", (await buttonLabels(page)).join("|") === "Fortsetzen bei 0:12|Von vorn beginnen|Als gesehen markieren", (await buttonLabels(page)).join("|"));
  check("Fortschritt mit Restzeit", /noch 1 Min\./.test((await text(page, ".series-detail__state")) ?? ""), await text(page, ".series-detail__state"));
  await shot(page, "m10-detail-fortsetzen");
  await key(page, "Enter", 1, 400);
  await expectPlayer(page, "Fortsetzen: Player startet bei ≈ 12 s", 11.5, 20);
  await closePlayer(page);

  await openSeries(page, "Stranger Things");
  await waitReady(page);
  await key(page, "ArrowDown", 2);
  await key(page, "Enter", 1, 900);
  check("Details der Weiterschauen-Folge", (await detailTitle(page)) === "Kapitel Zwei: Süßes oder Saures, Freak", await detailTitle(page));
  await key(page, "ArrowRight");
  await key(page, "Enter", 1, 400);
  await expectPlayer(page, "Von vorn beginnen: Player startet bei ≈ 0 s", 0, 5);
  await closePlayer(page);

  // Hauptknopf: Weiterschauen startet direkt an der Stelle
  await openSeries(page, "Stranger Things");
  await waitReady(page);
  await key(page, "Enter", 1, 400);
  await expectPlayer(page, "Hauptknopf „Weiterschauen“: Player bei ≈ 12 s", 11.5, 20);
  await closePlayer(page);
  check("Player zu: zurück im Hauptmenü", !(await has(page, "video.player-video")));
  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* -------------------------------------------- 3. Mock: Sonderfälle der Serien */

if (run("sonder")) {
  console.log("\n== Mock-Jellyfin: Sonderfälle ==");
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);

  await openSeries(page, "Testserie");
  await waitReady(page);
  check("Testserie: Weiterschauen · S1 E2", /Weiterschauen · S1 E2/.test((await mainLabel(page)) ?? ""), await mainLabel(page));
  await key(page, "ArrowDown", 2);
  await key(page, "Escape", 1, 900);
  check("Testserie: ○ in der Liste schließt den Screen", !(await has(page, ".series-screen")));

  await openSeries(page, "Testserie");
  await waitReady(page);
  await key(page, "ArrowDown");
  await key(page, "Enter", 1, 500);
  const names = await texts(page, ".series-menu__row");
  check("Testserie: Staffel 1, 2 und Specials (fehlende Folge zählt nicht)", names.length === 3 && /Staffel 2.*2 Folgen/.test(names[1]) && /^Specials/.test(names[2]), names.join(" | "));
  await key(page, "Escape", 1, 400);
  await key(page, "Escape", 1, 900);

  await openSeries(page, "Serie fertig");
  await waitReady(page);
  check("Serie fertig: Von vorn · S1 E1", /Von vorn · S1 E1/.test((await mainLabel(page)) ?? ""), await mainLabel(page));
  await key(page, "ArrowDown");
  await key(page, "Enter", 1, 500);
  check("einzige Staffel: kein Pfeil, keine Liste", (await has(page, ".series-select.is-single")) && !(await has(page, ".series-menu")));
  await key(page, "ArrowRight");
  check("einzige Staffel: → wechselt nichts", (await seasonLabel(page)) === "Staffel 1");
  await shot(page, "m11-einzelstaffel");
  await key(page, "Escape", 1, 900);

  await openSeries(page, "Serie neu");
  await waitReady(page);
  check("Serie neu: Abspielen · S1 E1", /Abspielen · S1 E1/.test((await mainLabel(page)) ?? ""), await mainLabel(page));
  await key(page, "Escape", 1, 900);

  await openSeries(page, "Serie ohne Staffelzahl");
  await waitReady(page);
  check("Serie ohne Folgen: „Keine Folgen gefunden“", /Keine Folgen gefunden/.test((await text(page, ".series-status")) ?? ""), await text(page, ".series-status"));
  check("… ohne Hauptknopf und Liste", !(await has(page, ".series-play")) && !(await has(page, ".series-row")));
  await shot(page, "m12-leer");
  await key(page, "Enter", 1, 300);
  await key(page, "ArrowDown", 1, 300);
  check("… ✕ und ↓ stören nicht", await has(page, ".series-screen"));
  await key(page, "Escape", 1, 900);
  check("… ○ geht zurück", !(await has(page, ".series-screen")));

  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ------------------------------------------------------ 4. Laden und Fehler */

if (run("laden")) {
  console.log("\n== Laden und Fehler ==");
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);
  let mode = "slow";
  await page.route(/\/Shows\/[^/]+\/Episodes/i, async (route) => {
    if (mode === "slow") await sleep(2500);
    if (mode === "error") return route.fulfill({ status: 500, contentType: "text/plain", body: "Serverfehler" });
    return route.continue();
  });
  await openSeries(page, "Stranger Things");
  await sleep(600);
  check("„Lade Folgen …“ während des Ladens", /Lade Folgen/.test((await text(page, ".series-status")) ?? ""), await text(page, ".series-status"));
  await shot(page, "m13-laden");
  await waitReady(page);
  check("nach dem Laden: Hauptknopf", await has(page, ".series-play"));
  await key(page, "Escape", 1, 900);

  mode = "error";
  await openSeries(page, "Stranger Things");
  await page.waitForSelector(".series-status.is-error", { timeout: 15000 }).catch(() => {});
  check("Fehlertext, wenn der Server patzt", await has(page, ".series-status.is-error"), await text(page, ".series-status"));
  await shot(page, "m14-fehler");
  mode = "ok";
  await key(page, "Enter", 1, 400);
  await waitReady(page);
  check("✕ lädt erneut", await has(page, ".series-play"));
  await key(page, "Escape", 1, 900);
  mode = "error";
  await openSeries(page, "Stranger Things");
  await page.waitForSelector(".series-status.is-error", { timeout: 15000 }).catch(() => {});
  await key(page, "Escape", 1, 900);
  check("○ schließt den Fehlerzustand", !(await has(page, ".series-screen")));
  check("keine unerwarteten Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------------------------------- Maus */

if (run("maus")) {
  console.log("\n== Maus ==");
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);
  await openSeries(page, "Stranger Things");
  await waitReady(page);
  await page.locator(".series-select").hover();
  await sleep(300);
  check("Maus über dem Dropdown: Fokus", await has(page, ".series-select.is-focused"));
  await page.locator(".series-select").click();
  await sleep(500);
  check("Klick öffnet die Staffelliste", await has(page, ".series-menu"));
  await page.locator(".series-menu__row", { hasText: "Staffel 4" }).click();
  await sleep(700);
  check("Klick auf eine Staffel wählt sie", (await seasonLabel(page)) === "Staffel 4" && !(await has(page, ".series-menu")), await seasonLabel(page));
  await page.locator(".series-select").click();
  await sleep(400);
  await page.mouse.click(1100, 300);
  await sleep(400);
  check("Klick daneben schließt die Liste", !(await has(page, ".series-menu")));
  await page.locator(".series-row", { hasText: "Vecnas Fluch" }).click();
  await sleep(900);
  check("Klick auf eine Folge öffnet die Details", (await detailTitle(page)) === "Kapitel Zwei: Vecnas Fluch", await detailTitle(page));
  await page.locator(".series-tile", { hasText: "Der Monsterschlächter" }).click();
  await sleep(900);
  check("Klick auf eine Kachel wechselt die Folge", (await detailTitle(page)) === "Kapitel Drei: Der Monsterschlächter", await detailTitle(page));
  await page.locator(".series-detail .series-hints .pop-hint", { hasText: "Zurück" }).click();
  await sleep(900);
  check("Klick auf „Zurück“ in der Hinweisleiste", !(await has(page, ".series-detail")) && (await focusedRow(page)) === "Kapitel Drei: Der Monsterschlächter", await focusedRow(page));
  await page.locator(".series-row", { hasText: "Hellfire" }).click();
  await sleep(900);
  await page.locator(".series-btn", { hasText: "Abspielen" }).click();
  await expectPlayer(page, "Klick auf „Abspielen“ startet den Player", 0, 8);
  await closePlayer(page);
  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ----------------------------------------------------------------- Controller */

if (run("pad")) {
  console.log("\n== Controller (nur Gamepad) ==");
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);
  check("Serien-Screen per Controller geöffnet", await openSeries(page, "Stranger Things", "pad"));
  await waitReady(page);
  check("Weiterschauen · S2 E2", /Weiterschauen · S2 E2/.test((await mainLabel(page)) ?? ""), await mainLabel(page));
  await tap(page, "r1");
  check("R1: Staffel 3", (await seasonLabel(page)) === "Staffel 3", await seasonLabel(page));
  await tap(page, "r1", 2);
  check("R1 R1: Specials", (await seasonLabel(page)) === "Specials", await seasonLabel(page));
  await tap(page, "r1");
  check("R1 am Ende: bleibt", (await seasonLabel(page)) === "Specials");
  await tap(page, "l1", 4);
  check("L1 ×4: Staffel 1 (nicht weiter)", (await seasonLabel(page)) === "Staffel 1", await seasonLabel(page));
  await tap(page, "down");
  await tap(page, "confirm", 1, 600);
  check("↓ ✕: Staffelliste offen", await has(page, ".series-menu"));
  await tap(page, "down", 3);
  await tap(page, "confirm", 1, 900);
  check("↓↓↓ ✕: Staffel 4", (await seasonLabel(page)) === "Staffel 4", await seasonLabel(page));
  await tap(page, "right");
  check("→ auf dem Dropdown: Specials", (await seasonLabel(page)) === "Specials");
  await tap(page, "left");
  await tap(page, "down", 2);
  check("↓↓: Folge in der Liste fokussiert", (await focusedRow(page)) === "Kapitel Zwei: Vecnas Fluch", await focusedRow(page));
  await tap(page, "confirm", 1, 900);
  check("✕: Detailseite", (await detailTitle(page)) === "Kapitel Zwei: Vecnas Fluch", await detailTitle(page));
  await tap(page, "down");
  await tap(page, "right");
  await tap(page, "confirm", 1, 900);
  check("↓ → ✕: Detailseite wechselt", (await detailTitle(page)) === "Special 1" || (await detailTitle(page)) === "Zurück nach Hawkins", await detailTitle(page));
  await tap(page, "l1", 1, 700);
  check("L1: vorige Folge", (await detailTitle(page)) === "Kapitel Drei: Der Monsterschlächter", await detailTitle(page));
  await tap(page, "back", 1, 900);
  check("○: zurück zur Übersicht, Fokus auf der Folge", !(await has(page, ".series-detail")) && (await focusedRow(page)) === "Kapitel Drei: Der Monsterschlächter", await focusedRow(page));
  await tap(page, "up", 3);
  await tap(page, "confirm", 1, 600);
  await expectPlayer(page, "Controller: Hauptknopf startet die Folge bei ≈ 12 s", 11.5, 20);
  await tap(page, "back", 1, 900);
  await tap(page, "back", 1, 900);
  await closePlayer(page);
  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ----------------------------------------------------------------------- Demo */

if (run("demo")) {
  console.log("\n== Demo (ohne Server) ==");
  const { page, ctx, errors } = await newPage("");
  check("Serien-Screen öffnet in der Demo", await openSeries(page, "*"));
  await waitReady(page);
  check("Weiterschauen · S1 E2", /Weiterschauen · S1 E2/.test((await mainLabel(page)) ?? ""), await mainLabel(page));
  check("2 Staffeln", /2 Staffeln/.test((await text(page, ".series-meta")) ?? ""), await text(page, ".series-meta"));
  check("Staffel 1 hat 4 Folgen, eine gesehen, eine angefangen", (await rowTitles(page)).length === 4 && (await count(page, ".series-row.is-played")) === 1 && (await count(page, ".series-row__progress")) === 1);
  await shot(page, "d01-uebersicht");
  await key(page, "ArrowDown");
  await shot(page, "d02-staffelfokus");
  await key(page, "Enter", 1, 500);
  await key(page, "ArrowDown");
  await key(page, "Enter", 1, 900);
  check("Staffel 2 (Demo)", (await seasonLabel(page)) === "Staffel 2" && (await rowTitles(page)).length === 3, `${await seasonLabel(page)} / ${(await rowTitles(page)).join(" | ")}`);
  await shot(page, "d03-staffel2");
  await key(page, "ArrowDown", 2);
  await key(page, "ArrowDown", 1, 600);
  check("lange Titel werden gekürzt, nicht umgebrochen", (await focusedRow(page)) === "Wenn der Wind sich dreht und alle Pläne in Frage stehen", await focusedRow(page));
  await shot(page, "d04-langer-titel");
  await key(page, "Enter", 1, 900);
  await shot(page, "d05-detail-langer-titel");
  await key(page, "Escape", 1, 900);
  await key(page, "PageUp", 1, 700);
  await key(page, "ArrowDown", 1, 500);
  await key(page, "ArrowDown", 1, 500);
  await key(page, "Enter", 1, 900);
  check("Detail der angefangenen Demo-Folge", (await buttonLabels(page))[0] === "Fortsetzen bei 20:15", (await buttonLabels(page)).join("|"));
  await shot(page, "d06-detail-fortsetzen");
  await key(page, "ArrowRight", 2);
  await key(page, "Enter", 1, 500);
  check("Demo: Markieren wirkt lokal", (await buttonLabels(page))[0] === "Abspielen" && !(await has(page, ".series-detail__progress")), (await buttonLabels(page)).join("|"));
  await key(page, "ArrowLeft", 2);
  await key(page, "Enter", 1, 500);
  const info = await (async () => {
    const ok = await page.waitForSelector("video.player-video", { timeout: 15000 }).then(() => true, () => false);
    return ok ? playerInfo(page) : null;
  })();
  check("Demo: „Abspielen“ startet den Demo-Clip", !!info, info ? `t=${info.t.toFixed(1)} s` : "");
  await closePlayer(page);
  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------- Größen und Animationen: aus */

for (const size of run("groessen") ? [{ width: 1024, height: 640 }, { width: 1280, height: 720 }] : []) {
  console.log(`\n== Darstellung ${size.width}×${size.height} ==`);
  mock.reset();
  const tag = `${size.width}`;
  const { page, ctx, errors } = await newPage(mock.url, size);
  await openSeries(page, "Stranger Things");
  await waitReady(page);
  await sleep(800);
  await shot(page, `v-${tag}-1-uebersicht`);
  const overlap = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const play = r(".series-play");
    const sel = r(".series-select");
    const hints = r(".series-hints");
    return { playBottom: play?.bottom, selTop: sel?.top, selBottom: sel?.bottom, hintsTop: hints?.top, vw: innerWidth, right: play?.right };
  });
  check("Hauptknopf und Staffel-Auswahl überlappen nicht", overlap.playBottom <= overlap.selTop, JSON.stringify(overlap));
  await key(page, "ArrowDown", 2);
  await shot(page, `v-${tag}-2-liste`);
  await key(page, "PageUp", 1, 700);
  await key(page, "Enter", 1, 1000);
  await page.waitForFunction(() => document.querySelectorAll(".series-detail__text p").length >= 4, null, { timeout: 8000 }).catch(() => {});
  await sleep(500);
  await shot(page, `v-${tag}-3-detail`);
  const lay = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const btn = r(".series-detail__buttons");
    const more = r(".series-more");
    const hints = r(".series-hints");
    const body = r(".series-detail__body");
    const text = r(".series-detail__textwrap");
    return { btnBottom: btn?.bottom, moreTop: more?.top, moreBottom: more?.bottom, hintsTop: hints?.top, bodyBottom: body?.bottom, textH: text?.height, btnRight: btn?.right, vw: innerWidth };
  });
  check("Knöpfe und „Weitere Folgen“ überlappen nicht", lay.btnBottom <= lay.moreTop, JSON.stringify(lay));
  check("Kachelreihe liegt über der Hinweisleiste", lay.moreBottom <= lay.hintsTop + 1, `${Math.round(lay.moreBottom)} / ${Math.round(lay.hintsTop)}`);
  check("Beschreibung hat Platz (≥ 3 Zeilen)", lay.textH >= 3 * 1.55 * 1.6 * (size.width / 96), `${Math.round(lay.textH)} px`);
  check("kein waagerechtes Überlaufen", lay.btnRight <= lay.vw);
  await key(page, "Escape", 1, 800);
  await key(page, "Escape", 1, 800);

  if (size.width === 1280) {
    await page.evaluate(() => (document.documentElement.dataset.anim = "off"));
    await openSeries(page, "Stranger Things");
    await waitReady(page);
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".series-screen")).animationName);
    check("Animationen: aus – keine Einblendung", anim === "none", anim);
    await key(page, "ArrowDown", 2, 200);
    await key(page, "PageUp", 1, 150);
    check("Animationen: aus – Staffelwechsel ohne Überblendung", (await count(page, ".series-list")) === 1, `${await count(page, ".series-list")}`);
  }
  check("keine Konsolenfehler", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
await mock.close();
console.log(`\nScreenshots: ${OUT}`);
console.log(failed === 0 ? "ALLES OK" : `${failed} Prüfung(en) FEHLGESCHLAGEN`);
process.exit(failed === 0 ? 0 : 1);
