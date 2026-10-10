#!/usr/bin/env node
// E2E: Vorschaubilder auf der Zeitleiste des Players (Playwright/Chromium gegen den Vite-Dev-Server, Mock-Jellyfin und Demo).
//
//   npx vite --port 5301 --strictPort --host 127.0.0.1 &            # die App
//   node dev/e2e/player-thumbs.mjs --app http://127.0.0.1:5301 [--out <Ordner>] [--mock-port 18301]
//                                  [--playwright <Pfad zu playwright/index.mjs>] [--chromium <Browser>]
//
// Der Mock-Jellyfin wird hier selbst gestartet (Testmedien: dev/mock-jellyfin/make-media.sh). Playwright und Browser lassen
// sich per Argument oder Umgebung (PLAYWRIGHT_MODULE, CHROMIUM_PATH) angeben; ohne beides gilt `import("playwright")`.
// Geprüft wird: Trickplay-Kacheln (lazy geladen, echte Bilder, passen zur Zeit), Rückfall ohne Trickplay (WebM direkt),
// Demo, nichts bei HLS-Umwandlung ohne Trickplay, Maus-Hover, Blase am Rand, Kapitel, Spulen stört die Wiedergabe nicht.
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
const OUT = path.resolve(arg("out", fs.mkdtempSync(path.join(os.tmpdir(), "jellystation-thumbs-"))));
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

/* ------------------------------------------------------------------ Hilfen */

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
  await page.goto(`${APP}/`);
  await page.waitForSelector(".xmb", { timeout: 20000 });
  await sleep(2500);
  return { page, ctx, errors };
}

/** Öffnet den ersten Film (Mock bzw. Demo; die Leiste steht beim Start auf "Filme") und wartet, bis das Bild läuft. */
async function openPlayer(page) {
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const v = document.querySelector("video.player-video");
    return !!v && v.currentTime > 0.6 && !v.paused;
  }, null, { timeout: 25000 });
}

const pause = async (page) => {
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("video.player-video")?.paused === true, null, { timeout: 5000 });
};

/** Pfeiltaste gedrückt halten (Wiederholungen alle `every` ms). */
async function hold(page, key, ms, every = 90) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.keyboard.down(key);
    await sleep(every);
  }
  await page.keyboard.up(key);
}

const bubble = (page) => page.locator(".player-bubble");
const previewInfo = (page) =>
  page.evaluate(() => {
    const p = document.querySelector(".player-bubble [data-testid=preview]");
    const img = p?.querySelector(".player-preview__img");
    const card = document.querySelector(".player-bubble__card");
    const cr = card?.getBoundingClientRect();
    return {
      has: !!p,
      kind: p?.getAttribute("data-kind") ?? null,
      frame: img?.getAttribute("data-frame") ?? null,
      exact: img?.getAttribute("data-exact") ?? null,
      time: document.querySelector(".player-bubble__time")?.textContent ?? null,
      chapter: document.querySelector(".player-bubble__chapter")?.textContent ?? null,
      card: cr ? { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom } : null,
      anchor: document.querySelector(".player-bubble")?.getBoundingClientRect().left ?? null,
      vw: innerWidth,
    };
  });

/** Pixel eines Elements (Bildschirmfoto, auf 32×18 verkleinert) + einfache Kennzahlen. */
async function shotStats(page, locator) {
  const buf = await locator.screenshot();
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const g = new OffscreenCanvas(32, 18).getContext("2d");
    g.drawImage(bmp, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    const lum = [];
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      colors.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
    }
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const std = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
    return { std, colors: colors.size, px: Array.from(d) };
  }, buf.toString("base64"));
}

/** Das Bild des Hauptvideos (direkt aus dem Element, ohne Bedienfeld darüber) auf 32×18. */
const videoFrame = (page) =>
  page.evaluate(() => {
    const v = document.querySelector("video.player-video");
    const g = new OffscreenCanvas(32, 18).getContext("2d");
    g.drawImage(v, 0, 0, 32, 18);
    return { t: v.currentTime, px: Array.from(g.getImageData(0, 0, 32, 18).data) };
  });

/** Mittlere Abweichung (0–255) zweier Pixelfelder ohne Alpha. */
function diff(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a[i + c] - b[i + c]);
      n += 1;
    }
  }
  return sum / n;
}

/** Zu welcher Sekunde (0–29) des Videos passt ein Pixelfeld am besten? Referenzbilder aus einem eigenen, unsichtbaren <video> auf dieselbe Datei. */
async function bestMatchSec(page, px) {
  const refs = await page.evaluate(async () => {
    const src = document.querySelector("video.player-video").currentSrc;
    const v = document.createElement("video");
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.src = src;
    await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    const g = new OffscreenCanvas(32, 18).getContext("2d");
    const out = [];
    for (let t = 0; t < Math.floor(v.duration); t++) {
      await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = t + 0.02; });
      g.drawImage(v, 0, 0, 32, 18);
      out.push(Array.from(g.getImageData(0, 0, 32, 18).data));
    }
    v.removeAttribute("src");
    return out;
  });
  let best = 0;
  let bestD = Infinity;
  refs.forEach((r, t) => {
    const d = diff(px, r);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  });
  return { sec: best, d: bestD };
}

/** Zeichnet in jedem Bild auf, ob die Blase ein Bild hat (Flackern: Bild weg, obwohl die Blase noch steht). */
const startRecorder = (page) =>
  page.evaluate(() => {
    window.__rec = { frames: 0, seen: false, gaps: 0, urls: new Set() };
    const tick = () => {
      const r = window.__rec;
      if (!r) return;
      const b = document.querySelector(".player-bubble");
      const img = b?.querySelector(".player-preview__img");
      if (!b) r.seen = false;
      else {
        r.frames += 1;
        if (img) {
          r.seen = true;
          r.urls.add(getComputedStyle(img).backgroundImage);
        } else if (r.seen) r.gaps += 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopRecorder = (page) =>
  page.evaluate(() => {
    const r = window.__rec;
    window.__rec = null;
    return { frames: r.frames, gaps: r.gaps, urls: r.urls.size };
  });

const sheetRequests = () => mock.log.filter((e) => /\/trickplay\/\d+\/\d+\.jpg$/i.test(e.path)).map((e) => ({ path: e.path.toLowerCase(), status: e.status }));

/* ============================================ 1. Trickplay (Mock, WebM direkt) */

console.log("\n== 1. Trickplay vom Server (Direktwiedergabe) ==");
{
  mock.reset();
  const { page, ctx, errors } = await newPage(mock.url);
  await openPlayer(page);
  // Vor dem Spulen ist noch kein Kachelbild geladen worden (nur Bedarf).
  const metaReq = mock.log.filter((e) => e.path === "/Items" && e.query.fields && /trickplay/i.test(String(e.query.fields)));
  check("Metadaten (fields=Trickplay) beim Start abgerufen", metaReq.length >= 1, `${metaReq.length} Anfrage(n)`);
  check("noch kein Kachelbild geladen, solange nicht gespult wird", sheetRequests().length === 0, `${sheetRequests().length}`);
  await pause(page);
  await startRecorder(page);

  // Pfeil rechts gedrückt halten
  const seen = [];
  const sampler = (async () => {
    for (let i = 0; i < 24; i++) {
      await sleep(60);
      seen.push(await previewInfo(page));
    }
  })();
  await hold(page, "ArrowRight", 2200, 90);
  await sampler;
  await page.screenshot({ path: path.join(OUT, "t1-hold-right.png") });
  const withPicture = seen.filter((s) => s.has && s.frame);
  check("Vorschau erscheint beim Halten von →", withPicture.length >= 3, `${withPicture.length}/${seen.length} Proben mit Bild`);
  check("Quelle ist der Server (Kachelbilder)", withPicture.length > 0 && withPicture.every((s) => s.kind === "trickplay"));
  const frames = new Set(withPicture.map((s) => s.frame));
  check("das Bild wechselt mit der Zielzeit", frames.size >= 2, `${frames.size} verschiedene Ausschnitte`);
  const rec = await stopRecorder(page);
  check("kein Flackern: nie ein Bildaussetzer bei stehender Blase", rec.gaps === 0, `${rec.gaps} Aussetzer in ${rec.frames} Bildern`);
  const reqs = sheetRequests();
  const first = reqs.length ? reqs[0].path : "";
  check("Kachelbilder mit Auflösung 320 (passend zu ~320 px) und mediaSourceId angefragt", /\/trickplay\/320\/0\.jpg$/.test(first), first);
  const counts = new Map();
  for (const r of reqs) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
  check("jedes Kachelbild höchstens zweimal angefragt (Zwischenspeicher)", [...counts.values()].every((n) => n <= 2), JSON.stringify([...counts]));
  check("alle Kachelbild-Anfragen erfolgreich", reqs.every((r) => r.status === 200));

  // Genaue Positionen per Zifferntaste: Bild gegen das echte Videobild prüfen.
  await sleep(1200);
  const shots = {};
  for (const [key, label] of [["2", "6"], ["8", "24"]]) {
    await page.keyboard.press(key);
    await sleep(500);
    const info = await previewInfo(page);
    const prev = await shotStats(page, page.locator(".player-bubble .player-preview"));
    await page.waitForFunction(() => !document.querySelector("video.player-video").seeking, null, { timeout: 5000 });
    await sleep(250);
    shots[label] = { info, prev, vid: await videoFrame(page) };
    await page.screenshot({ path: path.join(OUT, `t1-digit-${label}.png`) });
    check(`Zifferntaste ${key}: Vorschau bei ${label} s ist ein echtes Bild (nicht einfarbig)`, prev.std > 12 && prev.colors > 12, `Streuung ${prev.std.toFixed(1)}, ${prev.colors} Farben`);
  }
  for (const label of ["6", "24"]) {
    const m = await bestMatchSec(page, shots[label].prev.px);
    check(`Vorschau passt zur Zeit: Bild bei ${label} s entspricht dem Video bei ±2 s`, Math.abs(m.sec - Number(label)) <= 2, `bestes Video-Bild: ${m.sec} s (Δ ${m.d.toFixed(1)})`);
  }
  check("unterschiedliche Positionen → unterschiedliche Bilder", diff(shots["6"].prev.px, shots["24"].prev.px) > 3, `Δ=${diff(shots["6"].prev.px, shots["24"].prev.px)}`);
  check("Kapitel unter der Zeit (Finale bei 24 s)", shots["24"].info.chapter === "Finale", String(shots["24"].info.chapter));
  check("Kapitel unter der Zeit (Die Mitte bei 6 s ist noch Anfang)", shots["6"].info.chapter === "Anfang", String(shots["6"].info.chapter));
  const sheetsAfter = new Set(sheetRequests().map((r) => r.path));
  check("das zweite Kachelbild (Zeit ab 25 s) wird bei Bedarf geladen", [...sheetsAfter].some((p) => /\/320\/1\.jpg$/.test(p)), [...sheetsAfter].join(", "));

  // L1/R1 (Tasten j / l) und Maus
  await page.keyboard.press("j");
  await sleep(400);
  const l1 = await previewInfo(page);
  check("L1 (j) zeigt die Vorschau", l1.has && !!l1.frame);

  // Maus über der Leiste: Vorschau ohne Klick, folgt dem Zeiger
  await sleep(1400);
  const box = await page.locator(".player-track").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await sleep(500);
  const h1 = await previewInfo(page);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 6 });
  await sleep(500);
  const h2 = await previewInfo(page);
  await page.screenshot({ path: path.join(OUT, "t1-hover.png") });
  check("Maus über der Leiste zeigt die Vorschau", h1.has && !!h1.frame && h2.has && !!h2.frame);
  check("… sie folgt dem Zeiger (Blase und Bild wechseln)", h1.frame !== h2.frame && h2.anchor > h1.anchor + 100, `${h1.time} → ${h2.time}`);
  // Rand der Leiste: Blase bleibt im Bild, Spitze bleibt an der Stelle
  for (const [ratio, label] of [[0, "links"], [1, "rechts"]]) {
    await page.mouse.move(box.x + box.width * (ratio === 0 ? 0.001 : 0.999), box.y + box.height / 2, { steps: 4 });
    await sleep(450);
    const e = await previewInfo(page);
    check(`Blase am Rand (${label}) bleibt im Bild`, !!e.card && e.card.left >= 0 && e.card.right <= e.vw, e.card ? `${Math.round(e.card.left)}…${Math.round(e.card.right)} von ${e.vw}` : "keine Blase");
  }
  await page.mouse.move(640, 300);
  await sleep(1300);
  check("Blase verschwindet, wenn nichts mehr gespult wird", (await bubble(page).count()) === 0);
  check("keine Fehler in der Konsole", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ====================== 2. Rückfall ohne Trickplay: lokal erzeugt (WebM direkt) */

console.log("\n== 2. Ohne Trickplay (Szenario notrickplay, WebM direkt): lokal erzeugte Bilder ==");
{
  mock.reset();
  mock.setScenario("notrickplay");
  const { page, ctx, errors } = await newPage(mock.url);
  await openPlayer(page);
  await sleep(1500);
  check("kein Kachelbild angefragt", sheetRequests().length === 0);
  const hidden = await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({ cls: v.className, muted: v.muted, paused: v.paused, vol: v.volume, preload: v.preload })));
  check("verstecktes zweites <video> (stumm, ohne Wiedergabe)", hidden.length === 2 && hidden.some((v) => v.cls === "" && v.muted && v.paused), JSON.stringify(hidden));

  // Maus-Hover auf der Leiste während der Wiedergabe: darf das laufende Video nicht stören
  const box = await page.locator(".player-track").boundingBox();
  const t0 = await page.evaluate(() => ({ t: document.querySelector("video.player-video").currentTime, at: performance.now() }));
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(box.x + box.width * (0.1 + 0.1 * i), box.y + box.height / 2, { steps: 3 });
    await sleep(260);
  }
  const t1 = await page.evaluate(() => ({ t: document.querySelector("video.player-video").currentTime, at: performance.now(), paused: document.querySelector("video.player-video").paused }));
  const played = t1.t - t0.t;
  const wall = (t1.at - t0.at) / 1000;
  check("laufende Wiedergabe wird nicht gestört (Zeit läuft im Takt)", !t1.paused && played > wall * 0.85 && played < wall * 1.15 + 0.1, `${played.toFixed(2)} s Wiedergabe in ${wall.toFixed(2)} s`);
  const pi = await previewInfo(page);
  check("Vorschau kommt vom lokalen Rückfall", pi.has && pi.kind === "local", String(pi.kind));
  await page.screenshot({ path: path.join(OUT, "t2-local-hover.png") });
  await pause(page);

  const shots = {};
  for (const [key, label] of [["2", "6"], ["8", "24"]]) {
    await page.keyboard.press(key);
    await page.waitForFunction(() => !!document.querySelector(".player-bubble .player-preview__img"), null, { timeout: 6000 }).catch(() => undefined);
    await sleep(900);
    // Das Bild für genau diese Stelle (nicht das nächstliegende) ist inzwischen da – frisch drücken, damit die Blase steht.
    await page.keyboard.press(key === "2" ? "3" : "9");
    await sleep(100);
    await page.keyboard.press(key);
    await sleep(900);
    const info = await previewInfo(page);
    const prev = await shotStats(page, page.locator(".player-bubble .player-preview"));
    await page.waitForFunction(() => !document.querySelector("video.player-video").seeking, null, { timeout: 5000 });
    await sleep(250);
    shots[label] = { info, prev, vid: await videoFrame(page) };
    await page.screenshot({ path: path.join(OUT, `t2-digit-${label}.png`) });
    check(`Zifferntaste ${key}: lokal erzeugtes Bild bei ${label} s ist echt (nicht einfarbig)`, prev.std > 12 && prev.colors > 12 && info.exact === "1", `Streuung ${prev.std.toFixed(1)}, ${prev.colors} Farben, exakt=${info.exact}`);
  }
  for (const label of ["6", "24"]) {
    const m = await bestMatchSec(page, shots[label].prev.px);
    check(`lokal erzeugtes Bild bei ${label} s entspricht dem Video bei ±2 s`, Math.abs(m.sec - Number(label)) <= 2, `bestes Video-Bild: ${m.sec} s (Δ ${m.d.toFixed(1)})`);
  }
  check("Kapitel erscheint auch ohne Trickplay", shots["24"].info.chapter === "Finale");
  check("keine Fehler in der Konsole", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ============================ 3. Trickplay angekündigt, aber nicht lieferbar → Rückfall */

console.log("\n== 3. Kachelbilder nicht lieferbar (Szenario trickplay404) ==");
{
  mock.reset();
  mock.setScenario("trickplay404");
  const { page, ctx } = await newPage(mock.url);
  await openPlayer(page);
  await pause(page);
  await page.keyboard.press("5");
  let kind = null;
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    const pi = await previewInfo(page);
    if (pi.has && pi.kind === "local" && pi.frame) {
      kind = pi.kind;
      break;
    }
    if (i % 4 === 3) await page.keyboard.press(i % 8 === 3 ? "6" : "5");
  }
  check("fällt auf lokal erzeugte Bilder zurück", kind === "local");
  check("Kachelbild wurde zuvor angefragt (und lieferte 404)", sheetRequests().some((r) => r.status === 404));
  await ctx.close();
}

/* =========================== 4. HLS-Umwandlung: mit Trickplay Bilder, ohne nur die Zeit */

console.log("\n== 4. HLS-Umwandlung (Szenario transcode) ==");
for (const withTrickplay of [true, false]) {
  mock.reset();
  mock.setScenario(withTrickplay ? "transcode" : "transcode,notrickplay");
  const { page, ctx, errors } = await newPage(mock.url);
  await openPlayer(page);
  await sleep(1200);
  const plan = await page.evaluate(() => document.querySelector(".player-method")?.textContent ?? "");
  await pause(page);
  await page.keyboard.press("5");
  await sleep(500);
  const pi = await previewInfo(page);
  if (withTrickplay) {
    check("Umwandlung mit Server-Trickplay: Vorschaubild vorhanden", pi.has && pi.kind === "trickplay" && !!pi.frame, `${plan} / ${pi.kind}`);
  } else {
    check("Umwandlung ohne Trickplay: nur die Zeit (kein Bild, kein zweites Video)", !pi.has && !!pi.time && (await page.locator("video").count()) === 1, `${plan}; Zeit ${pi.time}`);
    await page.screenshot({ path: path.join(OUT, "t4-transcode-time-only.png") });
  }
  check("keine Fehler in der Konsole", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ------------------------------------------------------------------------ Demo */

console.log("\n== 5. Demo (ohne Server) ==");
{
  const { page, ctx, errors } = await newPage("");
  await openPlayer(page);
  await sleep(1200);
  await pause(page);
  const seen = [];
  const sampler = (async () => {
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      seen.push(await previewInfo(page));
    }
  })();
  await hold(page, "ArrowRight", 1500, 90);
  await sampler;
  const picture = seen.filter((s) => s.has && s.frame);
  check("Demo: Vorschaubilder beim Halten von →", picture.length >= 2 && picture.every((s) => s.kind === "local"), `${picture.length}/${seen.length}`);
  const shots = {};
  for (const [key, label] of [["2", "5"], ["8", "19"]]) {
    await page.keyboard.press(key);
    await sleep(1100);
    await page.keyboard.press(key === "2" ? "3" : "9");
    await sleep(100);
    await page.keyboard.press(key);
    await page.waitForFunction(() => document.querySelector(".player-bubble .player-preview__img")?.getAttribute("data-exact") === "1", null, { timeout: 6000 }).catch(() => undefined);
    await sleep(500);
    const prev = await shotStats(page, page.locator(".player-bubble .player-preview"));
    await page.waitForFunction(() => !document.querySelector("video.player-video").seeking, null, { timeout: 5000 });
    await sleep(250);
    shots[label] = { prev, vid: await videoFrame(page) };
    await page.screenshot({ path: path.join(OUT, `t5-demo-${label}.png`) });
    check(`Demo: Bild bei ${label} s ist nicht einfarbig`, shots[label].prev.std > 8 && shots[label].prev.colors > 12, `Streuung ${shots[label].prev.std.toFixed(1)}`);
  }
  check("Demo: unterschiedliche Positionen → unterschiedliche Bilder", diff(shots["5"].prev.px, shots["19"].prev.px) > 1.5, `Δ=${diff(shots["5"].prev.px, shots["19"].prev.px).toFixed(1)}`);
  check("keine Fehler in der Konsole", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ------------------------------------------------------- kleines Fenster, schmal */

console.log("\n== 6. Kleines und schmales Fenster ==");
for (const size of [{ width: 1024, height: 640 }, { width: 560, height: 640 }]) {
  mock.reset();
  const { page, ctx } = await newPage(mock.url, size);
  await openPlayer(page);
  await pause(page);
  const box = await page.locator(".player-track").boundingBox();
  for (const ratio of [0.001, 0.5, 0.999]) {
    await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2, { steps: 3 });
    await sleep(500);
    const e = await previewInfo(page);
    check(`${size.width}×${size.height}: Blase bei ${Math.round(ratio * 100)} % im Bild`, !!e.card && e.card.left >= 0 && e.card.right <= e.vw && e.card.top >= 0, e.card ? `${Math.round(e.card.left)}…${Math.round(e.card.right)} von ${e.vw}` : "keine Blase");
    await page.screenshot({ path: path.join(OUT, `t6-${size.width}-${Math.round(ratio * 100)}.png`) });
  }
  await ctx.close();
}

await browser.close();
await mock.close();
console.log(`\nBilder: ${OUT}`);
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);
