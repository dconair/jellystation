// Gleicht src/emulators/emulators.json (Datenquelle für scripts/install-emulators.sh) mit dem App-Katalog
// src/emulators/catalog.ts ab, damit beide Seiten nicht auseinanderlaufen.
//
//   node dev/check-emulator-data.mjs [pfad/zu/emulators.json]
//
// Geprüft (Abweichung = Exit-Code 1): ids, systems, appPattern, bundleIds, brewCask, downloadUrl (und folders, falls der Katalog sie nennt).
// Nur gemeldet (Exit-Code bleibt 0): name, consoles, setupNote, Reihenfolge der Emulatoren, GAMES_BASE_DIR.
// Außerdem: Jeder Systemordner der Bibliothek muss (wie in der App über normalizeSystem) genau einem Emulator des Katalogs
// zugeordnet sein, und scripts/install-emulators.sh --validate-data muss die Datei akzeptieren.
// Der Katalog wird per Vite-SSR geladen (kein Build, kein Fenster, kein Netz).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = resolve(process.argv[2] ?? `${root}/src/emulators/emulators.json`);

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);
const note = (msg) => notes.push(msg);

let data;
try {
  data = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (e) {
  console.error(`✕ ${jsonPath} ist nicht lesbar oder kein gültiges JSON: ${e.message}`);
  process.exit(1);
}

// ---- Katalog laden
let catalogModule;
let gamesModule = null;
const server = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  appType: "custom",
  clearScreen: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: null },
});
try {
  catalogModule = await server.ssrLoadModule("/src/emulators/catalog.ts");
  try {
    gamesModule = await server.ssrLoadModule("/src/config/games.ts");
  } catch {
    gamesModule = null; // nur für einen Zusatzhinweis, nicht nötig
  }
} catch (e) {
  console.error(`✕ src/emulators/catalog.ts ließ sich nicht laden: ${e.message}`);
  await server.close();
  process.exit(1);
}
await server.close();

const catalog = catalogModule.EMULATORS;
if (!Array.isArray(catalog)) {
  console.error(`✕ catalog.ts exportiert kein Feld EMULATORS (vorhanden: ${Object.keys(catalogModule).join(", ")}).`);
  process.exit(1);
}
const normalize = typeof catalogModule.normalizeSystem === "function"
  ? catalogModule.normalizeSystem
  : (n) => n.toLowerCase().replace(/[\s_\-.]+/g, "");

const sameSet = (a, b) => {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const show = (a) => JSON.stringify(a ?? null);

// ---- Emulatoren vergleichen
const jsonEmus = Array.isArray(data.emulators) ? data.emulators : [];
const jsonById = new Map(jsonEmus.map((e) => [e.id, e]));
const catById = new Map(catalog.map((e) => [e.id, e]));

for (const id of catById.keys()) if (!jsonById.has(id)) fail(`Emulator '${id}' steht im Katalog, fehlt aber in emulators.json`);
for (const id of jsonById.keys()) if (!catById.has(id)) fail(`Emulator '${id}' steht in emulators.json, fehlt aber im Katalog`);

for (const [id, c] of catById) {
  const j = jsonById.get(id);
  if (!j) continue;
  if (!sameSet(c.systems, j.systems)) fail(`${id}: systems weichen ab – Katalog ${show(c.systems)}, JSON ${show(j.systems)}`);
  if (c.appPattern !== j.appPattern) fail(`${id}: appPattern weicht ab – Katalog ${show(c.appPattern)}, JSON ${show(j.appPattern)}`);
  if (!sameSet(c.bundleIds, j.bundleIds)) fail(`${id}: bundleIds weichen ab – Katalog ${show(c.bundleIds)}, JSON ${show(j.bundleIds)}`);
  if ((c.brewCask ?? null) !== (j.brewCask ?? null)) fail(`${id}: brewCask weicht ab – Katalog ${show(c.brewCask ?? null)}, JSON ${show(j.brewCask ?? null)}`);
  if (c.downloadUrl !== j.downloadUrl) fail(`${id}: downloadUrl weicht ab – Katalog ${show(c.downloadUrl)}, JSON ${show(j.downloadUrl)}`);
  if (c.name !== j.name) note(`${id}: name weicht ab – Katalog ${show(c.name)}, JSON ${show(j.name)}`);
  if (c.consoles !== j.consoles) note(`${id}: consoles weicht ab – Katalog ${show(c.consoles)}, JSON ${show(j.consoles)}`);
  if ((c.setupNote ?? "") !== (j.setupNote ?? "")) note(`${id}: setupNote weicht ab (Katalog: ${show(c.setupNote ?? "")}, JSON: ${show(j.setupNote ?? "")})`);
}
if (!problems.length && catalog.map((e) => e.id).join() !== jsonEmus.map((e) => e.id).join()) {
  note("Die Reihenfolge der Emulatoren ist im Katalog und in emulators.json verschieden (nur Hinweis).");
}

// ---- Systemordner der Bibliothek müssen je genau einem Emulator des Katalogs gehören
const folders = Array.isArray(data.library?.systemFolders) ? data.library.systemFolders : [];
if (folders.length === 0) fail("library.systemFolders fehlt oder ist leer");
for (const f of folders) {
  const key = normalize(f);
  const owners = catalog.filter((e) => e.systems.includes(key)).map((e) => e.id);
  if (owners.length === 0) fail(`Systemordner '${f}' (${key}) gehört im Katalog zu keinem Emulator`);
  else if (owners.length > 1) fail(`Systemordner '${f}' (${key}) gehört im Katalog zu mehreren Emulatoren: ${owners.join(", ")}`);
}
for (const c of catalog) {
  const mine = folders.filter((f) => c.systems.includes(normalize(f)));
  if (mine.length === 0) note(`${c.id}: kein Systemordner in library.systemFolders – für diesen Emulator wird kein Spiele-Ordner angelegt`);
  // Neuere Kataloge nennen die Ordnernamen selbst (folders): sie müssen genau die Ordner sein, die das Skript anlegt.
  if (Array.isArray(c.folders) && !sameSet(c.folders, mine)) {
    fail(`${c.id}: folders weichen ab – Katalog ${show(c.folders)}, library.systemFolders (diesem Emulator zugeordnet) ${show(mine)}`);
  }
}

// ---- Standard-Spielebasisordner der App
if (gamesModule && typeof gamesModule.GAMES_BASE_DIR === "string" && gamesModule.GAMES_BASE_DIR !== data.library?.baseDir) {
  note(`GAMES_BASE_DIR (src/config/games.ts) ist ${show(gamesModule.GAMES_BASE_DIR)}, library.baseDir ist ${show(data.library?.baseDir)}`);
}

// ---- Formatprüfung durch das Installationsskript selbst (eine einzige Quelle der Regeln)
const script = `${root}/scripts/install-emulators.sh`;
const probe = spawnSync("bash", [script, "--validate-data"], {
  env: { ...process.env, JELLYSTATION_DATA: jsonPath },
  encoding: "utf8",
});
if (probe.error) {
  note(`Formatprüfung übersprungen (bash nicht startbar: ${probe.error.message})`);
} else if (probe.status !== 0) {
  fail(`scripts/install-emulators.sh --validate-data lehnt die Datei ab:\n${(probe.stderr || probe.stdout).trim().replace(/^/gm, "    ")}`);
}

// ---- Ergebnis
for (const n of notes) console.log(`  Hinweis: ${n}`);
if (problems.length) {
  console.error(`✕ emulators.json und catalog.ts passen nicht zusammen (${problems.length} Abweichung${problems.length === 1 ? "" : "en"}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ emulators.json und catalog.ts stimmen überein (${catalog.length} Emulatoren, ${folders.length} Systemordner).`);
