#!/usr/bin/env bash
# Datendatei emulators.json: Prüfung der Form (rc 3 bei Fehlern) und Abgleich mit catalog.ts (dev/check-emulator-data.mjs).
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

# mutate '<JS-Code, ändert j>' – schreibt $W/data.json (Kopie der echten Datei mit Änderung) und setzt JELLYSTATION_DATA
mutate() {
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const r = (function (j) { '"$1"' ; return j; })(j);
    fs.writeFileSync(process.argv[2], typeof r === "string" ? r : JSON.stringify(r, null, 2));
  ' "$REPO_DIR/src/emulators/emulators.json" "$W/data.json"
  T_ENV=("JELLYSTATION_DATA=$W/data.json")
}
expect_bad() { # <Name> <JS> <Text in der Meldung>
  new_world "d-$1"; mutate "$2"
  run --check
  rc_is 3; has "Die Emulator-Daten sind unbrauchbar"; has "$3"
  run --validate-data; rc_is 3
  run --yes; rc_is 3; eq "$(find "$W/apps" -mindepth 1 | wc -l | tr -d ' ')" "0" "nichts installiert"
}

echo "== echte Datei =="
new_world d0
run --validate-data; rc_is 0; has "Daten in Ordnung: 5 Emulatoren"
run --check --porcelain; rc_is 1; has "total=5"
echo "== unbekannte Zusatzfelder und Kommentare stören nicht =="
new_world d00; mutate 'j._neu = "x"; j.emulators[0].extra = {a: 1}; j.emulators[0]._comment = ["a","b"]'
run --validate-data; rc_is 0

echo "== kaputte Dateien =="
new_world d1; mutate 'return "das ist {kein json"'
run --check; rc_is 3; has "kein gültiges JSON"
new_world d2; T_ENV=("JELLYSTATION_DATA=$W/gibt-es-nicht.json")
run --check; rc_is 3; has "Datendatei nicht gefunden"
run; rc_is 3
new_world d3; : > "$W/data.json"; T_ENV=("JELLYSTATION_DATA=$W/data.json")
run --check; rc_is 3
expect_bad version2 'j.version = 2' "version muss 1 sein"
expect_bad kind 'j.emulators[0].install.kind = "magie"' "install.kind ist unbekannt: magie"
expect_bad lookahead 'j.emulators[0].appPattern = "^RPCS3(?=x).*\\.app$"' "Regex-Funktionen, die die Shell nicht kennt"
expect_bad backslash_d 'j.emulators[0].appPattern = "^RPCS3\\d+\\.app$"' "Regex-Funktionen, die die Shell nicht kennt"
expect_bad badregex 'j.emulators[0].appPattern = "^RPCS3(.app$"' "kein gültiger regulärer Ausdruck"
expect_bad assetregex 'j.emulators[0].install.assetMatch.include = ["(kaputt"]' "kein gültiger regulärer Ausdruck"
expect_bad nohosts 'j.emulators[0].install.allowedHosts = []' "install.allowedHosts fehlt"
expect_bad noinclude 'j.emulators[0].install.assetMatch.include = []' "assetMatch.include darf nicht leer sein"
expect_bad norepo 'j.emulators[0].install.github = {}' "install.github braucht arm64, x86_64 oder any"
expect_bad badrepo 'j.emulators[0].install.github.arm64 = "nur-ein-name"' "hat ein ungültiges Format"
expect_bad hostnotlisted 'j.emulators[1].install.directUrl.any = "https://evil.example.com/x.zip"' "steht nicht in allowedHosts"
expect_bad httpurl 'j.emulators[1].install.directUrl.any = "http://github.com/x.zip"' "hat ein ungültiges Format"
expect_bad nodirect 'j.emulators[1].install.directUrl = {}' "install.directUrl braucht arm64, x86_64 oder any"
expect_bad folder 'j.library.systemFolders.push("Dreamcast")' "gehört zu keinem Emulator"
expect_bad dotdot 'j.library.baseDir = "~/../etc"' "'..' ist nicht erlaubt"
expect_bad notilde 'j.library.baseDir = "/etc/spiele"' "hat ein ungültiges Format"
expect_bad slashfolder 'j.library.systemFolders[0] = "PS1/../.."' "hat ein ungültiges Format"
expect_bad dupid 'j.emulators[1].id = "rpcs3"' "kommt doppelt vor"
expect_bad badid 'j.emulators[0].id = "RPCS3 !"' "hat ein ungültiges Format"
expect_bad ctrl 'j.emulators[0].setupNote = "a\u0007b"' "enthält Steuerzeichen"
expect_bad nocask 'j.emulators[2].brewCask = null' "braucht brewCask"
expect_bad badcask 'j.emulators[2].brewCask = "a b; rm -rf /"' "hat ein ungültiges Format"
expect_bad badfallback 'j.emulators[2].install.fallback = ["brew-cask"]' "ist nicht erlaubt"
expect_bad fallbackself 'j.emulators[1].install.fallback = ["direct-url"]' "ist nicht erlaubt"
expect_bad badhost 'j.emulators[0].install.allowedHosts = ["evil.com/pfad"]' "hat ein ungültiges Format"
expect_bad noemus 'j.emulators = []' "emulators fehlt oder ist leer"
expect_bad badreleases 'j.emulators[0].install.github.releasesPath = "../../etc"' "hat ein ungültiges Format"
expect_bad badapi 'j.download.githubApi = "http://api.github.com"' "hat ein ungültiges Format"
expect_bad bundle 'j.emulators[0].bundleIds = ["net rpcs3"]' "hat ein ungültiges Format"
expect_bad twoowners 'j.emulators[0].systems.push("ps2")' "gehört zu zwei Emulatoren"

echo "== Node.js fehlt / liegt nur im Homebrew-Ordner =="
if unshare -m true 2>/dev/null; then
  new_world n1; T_ENV=("PATH=$W/bin:/usr/bin:/bin"); MASK_DIRS="/usr/local/bin"   # /usr/local/bin wie auf einem Mac ohne Node
  run --check; rc_is 3; has "Node.js fehlt"; run; rc_is 3; has "setup-mac.sh --install-missing --prepare"
  run --help; rc_is 0; has "Emulatoren prüfen, installieren"
  run --check --porcelain; rc_is 3
  MASK_LINKS="/usr/local/bin/node=$(command -v node)"   # Node.js nur im Homebrew-Ordner (nicht im PATH): wird gefunden
  run --check --porcelain; rc_is 1; has "total=5"
  MASK_LINKS=""
else
  echo "  (übersprungen: unshare -m nicht möglich)"
fi

echo "== Abgleich mit dem App-Katalog (dev/check-emulator-data.mjs) =="
cd "$REPO_DIR" || exit 1
OUT="$(node dev/check-emulator-data.mjs 2>&1)"; RC=$?
rc_is 0; has "stimmen überein (5 Emulatoren, 6 Systemordner)"
new_world c1
mutate 'j.emulators[0].appPattern = "^RPCS3\\.app$"'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "rpcs3: appPattern weicht ab"
mutate 'j.emulators[2].brewCask = "pcsx2-beta"'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "pcsx2: brewCask weicht ab"
mutate 'j.emulators[3].systems = ["psp"]'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "ppsspp: systems weichen ab"
mutate 'j.emulators[3].bundleIds = ["org.ppsspp.andere"]'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "ppsspp: bundleIds weichen ab"
mutate 'j.emulators[4].downloadUrl = "https://dolphin-emu.org/andere-seite"'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "dolphin: downloadUrl weicht ab"
mutate 'j.emulators.splice(1, 1); j.library.systemFolders = j.library.systemFolders.filter(f => f !== "PS1")'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "Emulator 'duckstation' steht im Katalog, fehlt aber in emulators.json"
mutate 'j.emulators.push({...j.emulators[0], id: "extra"})'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "Emulator 'extra' steht in emulators.json, fehlt aber im Katalog"
mutate 'j.library.systemFolders = j.library.systemFolders.filter(f => f !== "Wii")'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "dolphin: folders weichen ab"
echo "-- Hinweise (name/setupNote) ändern den Exit-Code nicht --"
mutate 'j.emulators[0].name = "RPCS3 neu"; j.emulators[0].setupNote = "anderer Text"'
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 0; has "Hinweis: rpcs3: name weicht ab"; has "Hinweis: rpcs3: setupNote weicht ab"
echo "-- kaputte JSON --"
echo "{kaputt" > "$W/data.json"
OUT="$(node dev/check-emulator-data.mjs "$W/data.json" 2>&1)"; RC=$?
rc_is 1; has "kein gültiges JSON"

finish
