// Prüft die reine Logik von „Einrichtung & Downloads“ (src/install/) ohne Fenster und ohne Netz:
// Archiv-Auswahl aus GitHub-Antworten, Quellen je System, Listen-Erkennung, BIOS-Prüfung.
//
//   node dev/check-install-logic.mjs
//
// Die Module werden per Vite-SSR geladen (wie in dev/check-emulator-data.mjs). Exit-Code 1 bei Abweichung.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, configFile: false, logLevel: "silent", appType: "custom", server: { middlewareMode: true } });
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✕ ${name}\n  ${e.message}`);
  }
};

try {
  const gh = await server.ssrLoadModule("/src/install/github.ts");
  const src = await server.ssrLoadModule("/src/install/sources.ts");
  const gs = await server.ssrLoadModule("/src/install/gameSources.ts");
  const bios = await server.ssrLoadModule("/src/install/biosCheck.ts");

  const asset = (name, extra = {}) => ({ name, browser_download_url: `https://github.com/x/y/releases/download/t/${name}`, state: "uploaded", ...extra });
  const rules = { include: ["\\.(dmg|zip|7z)$"], exclude: ["debug", "symbols?", "\\.sha256$"] };
  const pick = (assets, repoArch, hw) => gh.pickAsset([{ tag_name: "v1", assets }], rules, repoArch, hw, src.ARCH_HINTS, src.EXTENSION_ORDER);

  test("Apple Silicon bevorzugt den arm64-Build, dann dmg vor zip", () => {
    const r = pick([asset("app-x64.zip"), asset("app-arm64.zip"), asset("app-arm64.dmg")], "any", "arm64");
    assert.equal(r.asset.name, "app-arm64.dmg");
    assert.equal(r.asset.emulated, false);
  });
  test("Intel/x64 nimmt nie einen reinen ARM-Build", () => {
    const r = pick([asset("app-arm64.zip")], "any", "x86_64");
    assert.equal(r.asset, null);
    assert.deepEqual(r.seen, ["app-arm64.zip"]);
  });
  test("Apple Silicon ohne ARM-Build nimmt Intel und meldet Emulation", () => {
    const r = pick([asset("app-x64.zip")], "x86_64", "arm64");
    assert.equal(r.asset.name, "app-x64.zip");
    assert.equal(r.asset.emulated, true);
  });
  test("Ausschlüsse, Entwürfe und SHA-256 aus dem digest-Feld", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const r = gh.pickAsset(
      [{ tag_name: "draft", draft: true, assets: [asset("ok.zip")] }, { tag_name: "v2", assets: [asset("app-debug.zip"), asset("app.zip", { digest, size: 1234 }), asset("app.zip.sha256")] }],
      rules, "any", "x86_64", src.ARCH_HINTS, src.EXTENSION_ORDER,
    );
    assert.equal(r.asset.tag, "v2");
    assert.equal(r.asset.name, "app.zip");
    assert.equal(r.asset.sha256, "ab".repeat(32));
    assert.equal(r.asset.size, 1234);
  });
  test("Universal-Builds laufen auf beiden", () => {
    assert.equal(pick([asset("app-universal.dmg")], "any", "x86_64").asset.name, "app-universal.dmg");
    assert.equal(pick([asset("app-universal.dmg")], "any", "arm64").asset.emulated, false);
  });

  test("Quellen: Mac liest emulators.json, Windows die eigene Tabelle", () => {
    const rpcsArm = src.installSpec("rpcs3", "macos", "arm64");
    assert.deepEqual(rpcsArm.sources.map((s) => s.repo), ["RPCS3/rpcs3-binaries-mac-arm64", "RPCS3/rpcs3-binaries-mac"]);
    const rpcsIntel = src.installSpec("rpcs3", "macos", "x86_64");
    assert.deepEqual(rpcsIntel.sources.map((s) => s.repo), ["RPCS3/rpcs3-binaries-mac"]);
    const duck = src.installSpec("duckstation", "macos", "arm64");
    assert.match(duck.directUrl, /^https:\/\/github\.com\/stenzek\//);
    assert.equal(src.installSpec("pcsx2", "macos", "arm64"), null, "Homebrew-Cask, kein GitHub-Weg");
    assert.equal(src.installSpec("rpcs3", "windows", "x86_64").exePattern, "^rpcs3\\.exe$");
    assert.equal(src.installSpec("dolphin", "windows", "x86_64"), null);
    assert.equal(src.installSpec("rpcs3", "linux", "x86_64"), null);
    assert.deepEqual(src.installSpec("shadps4", "macos", "arm64").sources.map((s) => s.repo), ["shadps4-emu/shadPS4"]);
    assert.equal(src.installSpec("shadps4", "windows", "x86_64").exePattern, "^shadps4\\.exe$");
    for (const os of ["macos", "windows"]) for (const e of ["rpcs3", "shadps4", "duckstation", "pcsx2"]) {
      const s = src.installSpec(e, os, "x86_64");
      if (s) for (const re of [...s.rules.include, ...s.rules.exclude]) new RegExp(re, "i");
    }
  });
  test("Windows-Muster treffen plausible Dateinamen", () => {
    const rp = src.installSpec("rpcs3", "windows", "x86_64");
    const r = gh.pickAsset([{ tag_name: "build", assets: [asset("rpcs3-v0.0.34-1_win64.7z"), asset("rpcs3-v0.0.34-1_linux64.AppImage"), asset("rpcs3-v0.0.34-1_win_aarch64.7z")] }], rp.rules, "any", "x86_64", src.ARCH_HINTS, src.EXTENSION_ORDER);
    assert.equal(r.asset.name, "rpcs3-v0.0.34-1_win64.7z");
    const dk = src.installSpec("duckstation", "windows", "x86_64");
    const d = gh.pickAsset([{ tag_name: "latest", assets: [asset("duckstation-windows-x64-release.zip"), asset("duckstation-windows-arm64-release.zip"), asset("duckstation-mac-release.zip")] }], dk.rules, "any", "x86_64", src.ARCH_HINTS, src.EXTENSION_ORDER);
    assert.equal(d.asset.name, "duckstation-windows-x64-release.zip");
    const sp = src.installSpec("shadps4", "windows", "x86_64");
    const sh = gh.pickAsset([{ tag_name: "v.0.12.0", assets: [asset("shadps4-linux-qt-0.12.0.zip"), asset("shadps4-win64-sdl-0.12.0.zip"), asset("shadps4-win64-qt-0.12.0.zip"), asset("shadps4-macos-qt-0.12.0.zip")] }], sp.rules, "any", "x86_64", src.ARCH_HINTS, src.EXTENSION_ORDER);
    assert.equal(sh.asset.name, "shadps4-win64-qt-0.12.0.zip", "Qt-Ausgabe für Windows, nicht SDL/Linux/Mac");
    const sm = src.installSpec("shadps4", "macos", "arm64");
    const shMac = gh.pickAsset([{ tag_name: "v.0.12.0", assets: [asset("shadps4-win64-qt-0.12.0.zip"), asset("shadps4-macos-sdl-0.12.0.zip"), asset("shadps4-macos-qt-0.12.0.zip")] }], sm.rules, "any", "arm64", src.ARCH_HINTS, src.EXTENSION_ORDER);
    assert.equal(shMac.asset.name, "shadps4-macos-qt-0.12.0.zip");
    const p2 = src.installSpec("pcsx2", "windows", "x86_64");
    const p = gh.pickAsset([{ tag_name: "v2", assets: [asset("pcsx2-v2.0.0-windows-x64-Qt.7z"), asset("pcsx2-v2.0.0-windows-x64-Qt-symbols.7z"), asset("pcsx2-v2.0.0-macos-Qt.tar.xz")] }], p2.rules, "any", "x86_64", src.ARCH_HINTS, src.EXTENSION_ORDER);
    assert.equal(p.asset.name, "pcsx2-v2.0.0-windows-x64-Qt.7z");
  });

  test("Listen: Verzeichnisseite, Adressliste, JSON", () => {
    const html = `<html><a href="?C=N;O=D">Name</a><a href="../">Parent</a><a href="PS2/">PS2/</a><a href="Spiel%20Eins.iso">x</a><a href="/roms/zwei.CHD">y</a><a href="notes.txt">n</a><a href="Spiel%20Eins.iso">dup</a><a href='https://fremd.de/drei.zip'>z</a></html>`;
    const g = gs.parseListing(html, "https://meine-seite.de/spiele/");
    assert.deepEqual(g.map((x) => [x.name, x.url]), [
      ["Spiel Eins.iso", "https://meine-seite.de/spiele/Spiel%20Eins.iso"],
      ["zwei.CHD", "https://meine-seite.de/roms/zwei.CHD"],
      ["drei.zip", "https://fremd.de/drei.zip"],
    ]);
    const lines = gs.parseListing("# Kommentar\nhttps://a.de/x.iso\nMein Spiel | https://a.de/y.bin | PS1\n\nkaputt\n", "https://a.de/");
    assert.deepEqual(lines.map((x) => [x.name, x.system]), [["x.iso", undefined], ["Mein Spiel", "PS1"]]);
    const json = gs.parseListing(JSON.stringify({ games: [{ name: "A", url: "/a.iso", system: "PSP", size: 5 }, "https://a.de/b.iso", { name: "ohne url" }] }), "https://a.de/");
    assert.deepEqual(json.map((x) => [x.name, x.url, x.system, x.size]), [["A", "https://a.de/a.iso", "PSP", 5], ["b.iso", "https://a.de/b.iso", undefined, undefined]]);
    assert.deepEqual(gs.parseListing("javascript:alert(1)\nftp://a.de/x.iso", "https://a.de/"), []);
  });
  test("Quellen: Adressen, fremde Server, Einstellungen", () => {
    assert.equal(gs.normalizeSourceUrl("meine-seite.de/spiele"), "https://meine-seite.de/spiele");
    assert.equal(gs.normalizeSourceUrl("javascript:alert(1)"), null);
    assert.equal(gs.normalizeSourceUrl("  "), null);
    assert.equal(gs.isGameFileUrl("https://a.de/x/Spiel%20A.iso?token=1"), true);
    assert.equal(gs.isGameFileUrl("https://a.de/spiele/"), false);
    const source = { id: "s", name: "S", url: "https://meine-seite.de/liste.txt", trustedHosts: ["cdn.de"] };
    const games = [{ name: "a", url: "https://meine-seite.de/a.iso" }, { name: "b", url: "https://CDN.de/b.iso" }, { name: "c", url: "https://fremd.de/c.iso" }];
    assert.deepEqual(gs.foreignHosts(source, games), ["fremd.de"]);
    assert.deepEqual(gs.allowedHostsOf(source), ["meine-seite.de", "cdn.de"]);
    assert.deepEqual(gs.sanitizeGameSources([{ id: "a", url: "ftp://x" }, { id: "b", url: "https://x.de", name: " ", system: "PS2", trustedHosts: ["ok.de", "böse host"] }]), [{ id: "b", name: "x.de", url: "https://x.de", system: "PS2", trustedHosts: ["ok.de"] }]);
  });

  test("BIOS: Größe, Dateikopf, bekannte Prüfsumme", () => {
    const fp = (size, head = "00", md5 = "") => ({ size, head, md5, sha256: "" });
    assert.equal(bios.analyzeBios("ps1-bios", fp(512 * 1024, "00", "490f666e1afb15b7362b406ed1cea246")).verdict, "known");
    assert.equal(bios.analyzeBios("ps1-bios", fp(512 * 1024)).verdict, "plausible");
    assert.equal(bios.analyzeBios("ps1-bios", fp(1000)).verdict, "invalid");
    assert.equal(bios.analyzeBios("ps2-bios", fp(4 * 1024 * 1024)).verdict, "plausible");
    assert.equal(bios.analyzeBios("ps2-bios", fp(10)).verdict, "invalid");
    assert.equal(bios.analyzeBios("ps3-firmware", fp(200 * 1024 * 1024, "5343455546000000")).verdict, "plausible");
    assert.equal(bios.analyzeBios("ps3-firmware", fp(200 * 1024 * 1024, "3c68746d6c3e")).verdict, "invalid");
    assert.equal(bios.analyzeBios("ps3-firmware", fp(1024, "5343455546")).verdict, "invalid");
  });
  test("Sony-Server werden streng erkannt", () => {
    assert.equal(bios.isSonyHost("https://www.playstation.com/x.pup"), true);
    assert.equal(bios.isSonyHost("http://dus01.ps3.update.playstation.net/update/PS3UPDAT.PUP"), true);
    assert.equal(bios.isSonyHost("https://playstation.com.evil.de/x"), false);
    assert.equal(bios.isSonyHost("https://evilplaystation.com/x"), false);
    assert.equal(bios.isSonyHost("kein url"), false);
  });
} finally {
  await server.close();
}
console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failed ? 1 : 0);
