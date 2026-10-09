// E2E in der echten Tauri-App (Linux/WebKitGTK): automatische Spiele-Cover.
//   xvfb-run -a -s "-screen 0 1280x720x24" node dev/e2e/covers.mjs [Bilderordner]
//
// Aufbau: temporäres HOME mit PS3-Spielen: "Embedded Game.iso" (Mini-ISO mit PS3_GAME/ICON0.PNG), "Online Game.iso"
// (nur Platzhalterdaten, das Cover kommt vom lokalen Mock-Server), "Own Game.iso" mit eigenem Bild daneben und
// "Nothing Here.iso" (nirgends ein Cover). Der Mock-Server ersetzt thumbnails.libretro.com
// (JELLYSTATION_COVER_BASE, nur Debug-Build).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { makeHome, startApp, waitFor, press, sleep } from "./harness.mjs";

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "js-covers-out-"));
fs.mkdirSync(out, { recursive: true });

/* ------------------------------------------------------------------ Testdaten */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
/** Einfarbiges PNG (RGB) mit einem helleren Balken in der Mitte. */
function png(w, h, [r, g, b]) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const bar = Math.abs(y - h / 2) < h / 10;
      row[1 + x * 3] = bar ? 255 : r;
      row[2 + x * 3] = bar ? 255 : g;
      row[3 + x * 3] = bar ? 255 : b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PARAM.SFO mit Textfeldern. */
function sfo(entries) {
  const n = entries.length;
  const keyStart = 20 + n * 16;
  let keys = Buffer.alloc(0);
  const index = [];
  let data = Buffer.alloc(0);
  const keyOffsets = [];
  for (const [k] of entries) {
    keyOffsets.push(keys.length);
    keys = Buffer.concat([keys, Buffer.from(k + "\0")]);
  }
  while ((keyStart + keys.length) % 4) keys = Buffer.concat([keys, Buffer.from([0])]);
  const dataStart = keyStart + keys.length;
  entries.forEach(([, v], i) => {
    const val = Buffer.from(v + "\0");
    const idx = Buffer.alloc(16);
    idx.writeUInt16LE(keyOffsets[i], 0);
    idx.writeUInt16LE(0x0204, 2);
    idx.writeUInt32LE(val.length, 4);
    idx.writeUInt32LE(val.length, 8);
    idx.writeUInt32LE(data.length, 12);
    index.push(idx);
    data = Buffer.concat([data, val]);
  });
  const head = Buffer.alloc(20);
  head.write("\0PSF", 0, "latin1");
  head.writeUInt32LE(0x101, 4);
  head.writeUInt32LE(keyStart, 8);
  head.writeUInt32LE(dataStart, 12);
  head.writeUInt32LE(n, 16);
  return Buffer.concat([head, ...index, keys, data]);
}

/** ISO 9660 (2048-Byte-Sektoren) aus einem Baum { name: Buffer | { ... } }. */
function iso(tree) {
  const SEC = 2048;
  const up = (s) => s.toUpperCase();
  const recLen = (n) => 33 + n + ((33 + n) % 2);
  const dirSize = (items) => Math.ceil((2 * 34 + Object.keys(items).reduce((s, n) => s + recLen(up(n).length + (Buffer.isBuffer(items[n]) ? 2 : 0)), 0)) / SEC) * SEC;
  const extents = [];
  let next = 18;
  const alloc = (bytes) => {
    const lba = next;
    next += Math.max(1, Math.ceil(bytes / SEC));
    return lba;
  };
  const record = (name, lba, size, isDir) => {
    const len = recLen(name.length);
    const r = Buffer.alloc(len);
    r[0] = len;
    r.writeUInt32LE(lba, 2);
    r.writeUInt32BE(lba, 6);
    r.writeUInt32LE(size, 10);
    r.writeUInt32BE(size, 14);
    r[25] = isDir ? 2 : 0;
    r.writeUInt16LE(1, 28);
    r.writeUInt16BE(1, 30);
    r[32] = name.length;
    Buffer.from(name, "latin1").copy(r, 33);
    return r;
  };
  const place = (items, selfLba, parentLba) => {
    const recs = [record("\0", selfLba, dirSize(items), true), record("\x01", parentLba, dirSize(items), true)];
    for (const [name, value] of Object.entries(items)) {
      if (Buffer.isBuffer(value)) {
        const lba = alloc(value.length);
        extents.push([lba, value]);
        recs.push(record(up(name) + ";1", lba, value.length, false));
      } else {
        const lba = alloc(dirSize(value));
        place(value, lba, selfLba);
        recs.push(record(up(name), lba, dirSize(value), true));
      }
    }
    extents.push([selfLba, Buffer.concat(recs)]);
  };
  const rootLba = alloc(dirSize(tree));
  place(tree, rootLba, rootLba);
  const image = Buffer.alloc(next * SEC);
  const pvd = 16 * SEC;
  image[pvd] = 1;
  image.write("CD001", pvd + 1, "latin1");
  image[pvd + 6] = 1;
  image.fill(0x20, pvd + 40, pvd + 72);
  image.writeUInt32LE(next, pvd + 80);
  image.writeUInt32BE(next, pvd + 84);
  image.writeUInt16LE(SEC, pvd + 128);
  image.writeUInt16BE(SEC, pvd + 130);
  record("\0", rootLba, dirSize(tree), true).copy(image, pvd + 156);
  image[17 * SEC] = 255;
  image.write("CD001", 17 * SEC + 1, "latin1");
  image[17 * SEC + 6] = 1;
  for (const [lba, data] of extents) data.copy(image, lba * SEC);
  return image;
}

const ICON_EMBEDDED = png(320, 176, [200, 40, 40]); // rot, 16:9
const BOX_ONLINE = png(200, 280, [30, 170, 60]); // grün, Hochformat
const OWN_IMAGE = png(300, 200, [40, 60, 220]); // blau, neben dem Spiel

/* ------------------------------------------------------------------ Mock-Server (statt thumbnails.libretro.com) */

function startMock({ delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    requests.push(url);
    const reply = () => {
      if (url === "/Sony - PlayStation 3/Named_Boxarts/") {
        res.setHeader("content-type", "text/html");
        res.end(`<html><body><h1>Index of /</h1><pre><a href="../">../</a>\n<a href="Online%20Game%20%28USA%29.png">Online Game (USA).png</a>   01-Jan-2024 00:00 1000\n<a href="Other%20Title%20%28Europe%29.png">Other Title (Europe).png</a>   01-Jan-2024 00:00 1000\n</pre></body></html>`);
      } else if (url === "/Sony - PlayStation 3/Named_Boxarts/Online Game (USA).png") {
        res.setHeader("content-type", "image/png");
        res.end(BOX_ONLINE);
      } else {
        res.statusCode = 404;
        res.end("nicht gefunden");
      }
    };
    setTimeout(reply, delayMs);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() })),
  );
}

/* ------------------------------------------------------------------ Hilfen */

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK   " : "FEHLT"} ${name}${extra ? " – " + extra : ""}`);
  if (!ok) failed++;
};

/** Kacheln der aktiven Spalte: Titel, Rahmen, Bild (Größe, Mittelpunkt-Farbe), Platzhalter verdeckt? */
const SNAPSHOT = `
  const out = {};
  for (const el of document.querySelectorAll('.xmb-column.is-active .xmb-item')) {
    const title = el.querySelector('.xmb-item__title')?.textContent;
    if (!title) continue;
    const r = el.getBoundingClientRect();
    const art = el.querySelector('.art-image');
    const img = el.querySelector('img.art-image__img:not(.art-image__img--backdrop)');
    let pixel = null, nat = null;
    if (img && img.complete && img.naturalWidth) {
      nat = [img.naturalWidth, img.naturalHeight];
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
      pixel = Array.from(g.getImageData(1, 1, 1, 1).data.slice(0, 3));
    }
    out[title] = { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], img: !!img, nat, pixel, covered: !!art?.classList.contains('is-covered'), contain: !!img?.classList.contains('is-contain'), cls: img?.className ?? null };
  }
  return out;`;
const snapshot = (wd) => wd.exec(SNAPSHOT);
const near = (p, [r, g, b], tol = 40) => p && Math.abs(p[0] - r) < tol && Math.abs(p[1] - g) < tol && Math.abs(p[2] - b) < tol;

function makeLibrary(autoSetting) {
  const home = makeHome({
    settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: "", ...(autoSetting === undefined ? {} : { covers: { auto: autoSetting } }), completedAt: "2026-01-01T00:00:00Z" },
    games: {},
    emulators: [{}],
  });
  const dir = path.join(home, "JellyStation/Games/PS3");
  fs.mkdirSync(dir, { recursive: true });
  const embedded = iso({
    PS3_GAME: { "ICON0.PNG": ICON_EMBEDDED, "PARAM.SFO": sfo([["TITLE", "Embedded Game"], ["TITLE_ID", "BLES00001"]]) },
  });
  fs.writeFileSync(path.join(dir, "Embedded Game.iso"), embedded);
  fs.writeFileSync(path.join(dir, "Online Game.iso"), "fake game data");
  fs.writeFileSync(path.join(dir, "Own Game.iso"), "fake game data");
  fs.writeFileSync(path.join(dir, "Own Game.png"), OWN_IMAGE);
  fs.writeFileSync(path.join(dir, "Nothing Here.iso"), "fake game data");
  return home;
}

async function openGames(wd) {
  await waitFor(wd, "() => document.querySelector('.xmb')", { timeout: 40000, label: ".xmb" });
  await sleep(2500);
  await press(wd, "ArrowRight", { times: 2, pause: 500 });
  await sleep(1000);
  const cats = await wd.exec("return [...document.querySelectorAll('.xmb-category.is-active .xmb-category__label')].map(e=>e.textContent)");
  console.log("Aktive Kategorie:", JSON.stringify(cats));
}

/* ------------------------------------------------------------------ Lauf 1: automatisch laden = An */

async function runAuto() {
  console.log("\n== Cover automatisch laden: An ==");
  const mock = await startMock({ delayMs: 5000 });
  const home = makeLibrary(undefined);
  const app = await startApp({ home, env: { JELLYSTATION_COVER_BASE: mock.base } });
  const wd = app.wd;
  try {
    await openGames(wd);
    const before = await snapshot(wd);
    console.log("Kacheln:", Object.keys(before).join(", "));
    check("vier Spiele in der Spalte", Object.keys(before).length === 4);
    check("Eigenes Bild neben dem Spiel sofort da", before["Own Game"]?.img === true);
    await wd.screenshot(path.join(out, "c1-start.png"));

    const embeddedShown = await waitFor(wd, `() => { ${SNAPSHOT.replace("return out;", "")} return out['Embedded Game']?.pixel ? out : null; }`, { timeout: 20000, label: "eingebettetes Cover" });
    void embeddedShown;
    const mid = await snapshot(wd);
    check("Eingebettetes ICON0 wird gezeigt (rot, 320x176)", near(mid["Embedded Game"]?.pixel, [200, 40, 40]) && mid["Embedded Game"]?.nat?.join("x") === "320x176", JSON.stringify(mid["Embedded Game"]));
    check("Eingebettetes Cover ist Querformat (kein Hochformat-Zuschnitt)", mid["Embedded Game"]?.contain === false);
    check("Platzhalter des eingebetteten Spiels ist verdeckt", mid["Embedded Game"]?.covered === true);
    check("Online-Spiel hat noch kein Bild (Mock antwortet verzögert)", mid["Online Game"]?.img === false, JSON.stringify(mid["Online Game"]));
    await wd.screenshot(path.join(out, "c2-embedded.png"));

    await waitFor(wd, `() => { ${SNAPSHOT.replace("return out;", "")} return out['Online Game']?.pixel ? out : null; }`, { timeout: 30000, label: "Online-Cover" });
    await sleep(1200); // Einblenden abwarten
    const after = await snapshot(wd);
    check("Online-Boxart wird gezeigt (grün, 200x280)", near(after["Online Game"]?.pixel, [30, 170, 60]) && after["Online Game"]?.nat?.join("x") === "200x280", JSON.stringify(after["Online Game"]));
    check("Hochformat-Cover wird ganz gezeigt (contain)", after["Online Game"]?.contain === true);
    check("Eigenes Bild bleibt blau (Vorrang, nicht überschrieben)", near(after["Own Game"]?.pixel, [40, 60, 220]), JSON.stringify(after["Own Game"]?.pixel));
    check("Spiel ohne Cover behält den Platzhalter", after["Nothing Here"]?.img === false && after["Nothing Here"]?.covered === false);
    const moved = Object.keys(before).filter((t) => JSON.stringify(before[t].rect) !== JSON.stringify(after[t]?.rect));
    check("Keine Kachel springt (Rahmen vorher = nachher)", moved.length === 0, moved.join(", "));
    check("Mock wurde nach Online-Spiel gefragt", mock.requests.some((r) => r.endsWith("Online Game (USA).png")), JSON.stringify(mock.requests));
    check("Nur Systemname + Titel gehen ins Netz (kein Dateipfad/HOME)", mock.requests.every((r) => !r.includes(home) && !r.includes("JellyStation")), "");
    await wd.screenshot(path.join(out, "c3-online.png"));

    // Detailkarte: Online-Spiel anwählen
    const active = await wd.exec("return document.querySelector('.xmb-column.is-active .xmb-item.is-focused .xmb-item__title')?.textContent");
    console.log("Aktiver Eintrag:", active);
    for (let i = 0; i < 4; i++) {
      const t = await wd.exec("return document.querySelector('.xmb-column.is-active .xmb-item.is-focused .xmb-item__title')?.textContent");
      if (t === "Online Game") break;
      await press(wd, "ArrowDown", { pause: 500 });
    }
    await sleep(1200);
    await wd.screenshot(path.join(out, "c4-detail.png"));

    // Neustart-Cache: zweiter Start holt nichts mehr (Cache), siehe unten
    const countAfterFirst = mock.requests.length;
    return { home, countAfterFirst, mock, app, wd };
  } catch (e) {
    console.log("FEHLER:", e.message);
    failed++;
    try { await wd.screenshot(path.join(out, "c-error.png")); } catch {}
    mock.close();
    await app.stop();
    return null;
  }
}

/* ------------------------------------------------------------------ Lauf 2: Dialog und Cache */

async function runDialog(ctx) {
  const { wd } = ctx;
  console.log("\n== Dialog „Cover & Grafiken“ ==");
  try {
    // Zur Einstellungen-Spalte: letzte Kategorie
    const n = await wd.exec("return document.querySelectorAll('.xmb-category').length");
    const cur = await wd.exec("return [...document.querySelectorAll('.xmb-category')].findIndex(e => e.classList.contains('is-active'))");
    await press(wd, "ArrowRight", { times: n - 1 - cur, pause: 350 });
    await sleep(900);
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      const t = await wd.exec("return document.querySelector('.xmb-column.is-active .xmb-item.is-focused .xmb-item__title')?.textContent");
      if (t === "Cover & Grafiken") found = true;
      else await press(wd, "ArrowDown", { pause: 350 });
    }
    check("Eintrag „Cover & Grafiken“ in der Spalte Einstellungen", found);
    if (!found) return;
    const sub = await wd.exec("return document.querySelector('.xmb-column.is-active .xmb-item.is-focused .xmb-item__subtitle')?.textContent");
    check("Untertitel zeigt den Zustand", /Automatisch laden: An/.test(sub ?? ""), String(sub));
    await press(wd, "Enter");
    await sleep(1200);
    const bodyText = () => wd.exec("return document.body.innerText");
    let text = await bodyText();
    check("Dialog zeigt Datenschutz-Hinweis", /thumbnails\.libretro\.com/.test(text));
    await wd.screenshot(path.join(out, "d1-dialog-search.png"));
    await waitFor(wd, "() => /Cache \\d/i.test(document.body.innerText)", { timeout: 30000, label: "Statistik mit Cache" });
    text = await bodyText();
    check("Dialog zeigt Statistik und Cache", /\d+ von \d+ Spielen mit Cover · Cache/i.test(text), (text.match(/\d+ von \d+ Spielen mit Cover[^\n]*/i) ?? [""])[0]);
    await wd.screenshot(path.join(out, "d2-dialog-stats.png"));
    // Cache leeren: Abwärts über „Suche“ zu „Cache leeren“, Bestätigung mit „Leeren“
    await press(wd, "ArrowDown", { times: 2, pause: 300 });
    await press(wd, "Enter");
    await sleep(800);
    text = await bodyText();
    check("Cache leeren fragt nach", /Cover-Cache leeren/.test(text));
    await wd.screenshot(path.join(out, "d3-dialog-confirm.png"));
    await press(wd, "Escape");
    await sleep(500);
    const cacheDir = path.join(ctx.home, ".cache/dev.jellystation.app/covers");
    const count = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }).filter((f) => /\.(png|jpg)$/.test(String(f))).length : 0);
    check("Abbrechen löscht nichts", count() === 2, String(count()));
    await press(wd, "Enter");
    await sleep(600);
    await press(wd, "ArrowUp");
    await press(wd, "Enter");
    await sleep(1500);
    check("Cache geleert (Bilder gelöscht)", count() === 0, String(count()));
    text = await bodyText();
    check("Dialog meldet das Löschen", /gelöscht/.test(text));
    await wd.screenshot(path.join(out, "d4-dialog-cleared.png"));
    // Umschalten: Aus
    await press(wd, "ArrowUp", { times: 2, pause: 300 });
    await press(wd, "Enter");
    await sleep(800);
    text = await bodyText();
    check("Schalter springt auf „Aus“", /\bAus\b/.test(text));
    const saved = fs.readFileSync(path.join(ctx.home, ".local/share/dev.jellystation.app/settings.json"), "utf8");
    check("Einstellung wird gespeichert (covers.auto = false)", /"auto":\s*false/.test(saved));
    await press(wd, "Escape");
    await sleep(800);
    await wd.screenshot(path.join(out, "d5-after.png"));
  } catch (e) {
    console.log("FEHLER:", e.message);
    failed++;
    try { await wd.screenshot(path.join(out, "d-error.png")); } catch {}
  }
}

/* ------------------------------------------------------------------ Lauf 3: automatisch laden = Aus */

async function runOff() {
  console.log("\n== Cover automatisch laden: Aus ==");
  const mock = await startMock();
  const home = makeLibrary(false);
  const app = await startApp({ home, env: { JELLYSTATION_COVER_BASE: mock.base } });
  const wd = app.wd;
  try {
    await openGames(wd);
    await waitFor(wd, `() => { ${SNAPSHOT.replace("return out;", "")} return out['Embedded Game']?.pixel ? out : null; }`, { timeout: 20000, label: "eingebettetes Cover" });
    await sleep(4000);
    const snap = await snapshot(wd);
    check("Eingebettetes Cover kommt auch offline", near(snap["Embedded Game"]?.pixel, [200, 40, 40]));
    check("Online-Spiel bleibt beim Platzhalter", snap["Online Game"]?.img === false);
    check("Es wurde NICHTS abgerufen", mock.requests.length === 0, JSON.stringify(mock.requests));
    await wd.screenshot(path.join(out, "o1-off.png"));
  } catch (e) {
    console.log("FEHLER:", e.message);
    failed++;
    try { await wd.screenshot(path.join(out, "o-error.png")); } catch {}
  } finally {
    mock.close();
    await app.stop();
  }
}

/* ------------------------------------------------------------------ Ablauf */

const ctx = await runAuto();
if (ctx) {
  await runDialog(ctx);
  ctx.mock.close();
  await ctx.app.stop();
}
await runOff();

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : "\nAlles in Ordnung");
console.log("Bilder:", out);
process.exit(failed ? 1 : 0);
