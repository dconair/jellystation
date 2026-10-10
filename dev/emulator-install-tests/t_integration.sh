#!/usr/bin/env bash
# Einbindung: jellystation.sh (Prüfung, Merkdatei, Optionen, Status), setup-mac.sh (Schritt "Emulatoren und Ordner"),
# bootstrap.sh (Texte, Schutz der Spiele-Ordner vor dem Update).
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

all_apps() { local a; for a in RPCS3 DuckStation PCSX2 PPSSPPSDL Dolphin; do mkapp "$W/apps/$a.app" 1; done; }
# curl, das nur den Homebrew-Installer abfängt (alles andere geht an das echte curl) – ersetzt den Symlink, ändert nie die Vorlage
fake_homebrew_curl() {
  rm -f "$W/bin/curl"
  printf '#!/usr/bin/env bash\ncase "$*" in *Homebrew/install*) echo "curl $*" >> "%s/state/calls.log"; exit 0 ;; esac\nexec /usr/bin/curl "$@"\n' "$W" > "$W/bin/curl"
  chmod +x "$W/bin/curl"
}
inst_calls() { count_in "$W/state/calls.log" "$1"; }
marker() { cat "$HOME_W/.jellystation/emulators.check" 2>/dev/null; }

echo "== jellystation --status: Zeile \"Emulatoren: n/5 installiert\", ändert nichts =="
int_world j1; T_ENV+=("JELLYSTATION_DRY_RUN=1")
snap="$(snapshot "$W/home")$(snapshot "$W/apps")"
runj --status; rc_is 0; has "Emulatoren: 0/5 installiert (es fehlen: RPCS3, DuckStation, PCSX2, PPSSPP, Dolphin)"
eq "$(snapshot "$W/home")$(snapshot "$W/apps")" "$snap" "--status ändert nichts (keine Merkdatei, keine Ordner)"
mkapp "$W/apps/RPCS3.app" 1; mkapp "$W/apps/PCSX2.app" 1; mkapp "$W/apps/Dolphin.app" 1
runj --status; has "Emulatoren: 3/5 installiert (es fehlen: DuckStation, PPSSPP)"
all_apps; runj --status; has "Emulatoren: 5/5 installiert"; hasnt "es fehlen"
echo "-- auch ohne Verbindung zu GitHub bleibt die Zeile --"
git -C "$PROJ" remote set-url origin "file://$W/gibt-es-nicht.git"
runj --status; has "Emulatoren: 5/5 installiert"
git -C "$PROJ" remote set-url origin "file://$ORIGIN"
echo "-- nicht auf dem Mac / mit skip: keine Zeile --"
T_ENV+=("JELLYSTATION_EMULATORS=skip"); runj --status; hasnt "Emulatoren"
int_world j1b; T_ENV+=("JELLYSTATION_DRY_RUN=1"); unlink_stub uname
runj --status; rc_is 0; hasnt "Emulatoren"

echo "== Standardlauf: alles da → still (nur die Zeile im Banner) =="
int_world j2; T_ENV+=("JELLYSTATION_DRY_RUN=1"); all_apps
runj --no-update; rc_is 0
has "Emulatoren: 5/5 installiert"; hasnt "==> Emulatoren"; hasnt "fehlen"; hasnt "install-emulators"
eq "$(find "$HOME_W" -name '.jellystation' | wc -l | tr -d ' ')" "0" "keine Merkdatei angelegt"
echo "-- Schnelligkeit: die stille Prüfung dauert unter 1 Sekunde --"
t0=$(date +%s%N); for _ in 1 2 3 4 5; do runj --no-update >/dev/null; done; t1=$(date +%s%N)
per=$(( (t1 - t0) / 5000000 )); [ "$per" -lt 1000 ] && ok_ "ganzer Start im Trockenlauf: $per ms je Lauf" || no_ "zu langsam: $per ms"
t0=$(date +%s%N); for _ in 1 2 3 4 5; do run --check --quiet; done; t1=$(date +%s%N)
per=$(( (t1 - t0) / 5000000 )); [ "$per" -lt 1000 ] && ok_ "install-emulators.sh --check --quiet: $per ms je Lauf" || no_ "zu langsam: $per ms"
echo "  (Hinweis: gemessen mit Attrappen unter Linux; auf dem Mac kommen Node-Start und defaults dazu)"

echo "== fehlt etwas, noch nie versucht → Versuch (Trockenlauf zeigt ihn nur an) =="
int_world j3; T_ENV+=("JELLYSTATION_DRY_RUN=1"); mkapp "$W/apps/RPCS3.app" 1
runj --no-update; rc_is 0
has "==> Emulatoren"; has "Es fehlen: DuckStation, PCSX2, PPSSPP, Dolphin"; has "[Trockenlauf] würde ausführen: bash $PROJ/scripts/install-emulators.sh"
absent "$HOME_W/.jellystation/emulators.check" "Trockenlauf schreibt keine Merkdatei"
eq "$(inst_calls brew)" "0" "nichts installiert"
runj --no-update --emulators -y --update-emulators; has "install-emulators.sh --yes --update"

echo "== echter Lauf: Versuch installiert, Merkdatei wird geschrieben, danach still =="
int_world j4; std_routes; start_server; ds_override; T_ENV+=("JELLYSTATION_DRY_RUN=0")
mkdir -p "$PROJ/node_modules"; bash "$PROJ/scripts/jellystation.sh" --mark-deps 2>/dev/null
runj --no-update -y
rc_is 0; has "==> Emulatoren"; has "Fertig: 5 von 5 Emulatoren sind installiert."; has "Emulatoren: 5/5 installiert"
file_has "$W/npm.log" "npm run tauri dev" "danach wird die App gestartet"
exists "$W/apps/RPCS3.app"; file_has "$HOME_W/.jellystation/emulators.check" "result=ok" "Merkdatei: ok"; file_has "$HOME_W/.jellystation/emulators.check" "missing=" "Merkdatei: nichts fehlt"
reqs="$(n_requests GET)"
runj --no-update; rc_is 0; hasnt "==> Emulatoren"; hasnt "Nichts zu tun"; eq "$(n_requests GET)" "$reqs" "zweiter Start: keine Anfragen"

echo "== Versuch scheitert teilweise: Merkdatei, danach nur noch eine Erinnerung =="
int_world j5; std_routes; start_server; unlink_stub brew; T_ENV+=("JELLYSTATION_DRY_RUN=0")
mkdir -p "$PROJ/node_modules"; bash "$PROJ/scripts/jellystation.sh" --mark-deps 2>/dev/null
ds_override; runj --no-update -y
rc_is 0; has "2 von 5 Emulatoren sind installiert."; file_has "$HOME_W/.jellystation/emulators.check" "result=offen" "Merkdatei: offen"
file_has "$HOME_W/.jellystation/emulators.check" "missing=pcsx2,ppsspp,dolphin" "Merkdatei: fehlende IDs"
file_has "$W/npm.log" "npm run tauri dev" "App startet trotzdem"
reqs="$(n_requests GET)"; calls="$(wc -l < "$W/state/calls.log")"
runj --no-update; rc_is 0
has "Emulatoren fehlen noch: PCSX2, PPSSPP, Dolphin – nachholen mit  jellystation --emulators"; has "Download-Seiten: bash $PROJ/scripts/install-emulators.sh --check"
hasnt "==> Emulatoren"; hasnt "Lade "; eq "$(n_requests GET)" "$reqs" "kein neuer Versuch (keine Anfragen)"; eq "$(wc -l < "$W/state/calls.log")" "$calls" "kein neuer Versuch (keine Aufrufe)"
file_has "$W/npm.log" "npm run tauri dev" "App startet"
echo "-- genau ein Emulator fehlt: Download-Seite in der Zeile --"
mkapp "$W/apps/PCSX2.app" 1; mkapp "$W/apps/PPSSPP.app" 1
printf 'time=%s\nresult=offen\nmissing=dolphin\n' "$(date +%s)" > "$HOME_W/.jellystation/emulators.check"
runj --no-update; has "Emulatoren fehlen noch: Dolphin – nachholen mit  jellystation --emulators, von Hand: https://dolphin-emu.org/download/"

echo "== wann erneut versucht wird: nach 24 Stunden, bei neu fehlendem Emulator, bei Uhrsprung =="
int_world j6; T_ENV+=("JELLYSTATION_DRY_RUN=1"); mkapp "$W/apps/RPCS3.app" 1; mkapp "$W/apps/DuckStation.app" 1
set_marker 3600 offen "pcsx2,ppsspp,dolphin"
runj --no-update; hasnt "==> Emulatoren"; has "Emulatoren fehlen noch: PCSX2, PPSSPP, Dolphin"; hasnt "würde ausführen: bash"
set_marker 86300 offen "pcsx2,ppsspp,dolphin"; runj --no-update; hasnt "==> Emulatoren"   # knapp unter 24 Stunden
set_marker 86500 offen "pcsx2,ppsspp,dolphin"; runj --no-update; has "==> Emulatoren"; has "würde ausführen: bash"   # knapp darüber
set_marker 3600 offen "pcsx2,ppsspp"; runj --no-update; has "==> Emulatoren"; has "Es fehlen: PCSX2, PPSSPP, Dolphin"
set_marker -3600 offen "pcsx2,ppsspp,dolphin"; runj --no-update; has "==> Emulatoren"
set_marker 3600 ok ""; runj --no-update; has "==> Emulatoren"
printf 'quatsch\n' > "$HOME_W/.jellystation/emulators.check"; runj --no-update; has "==> Emulatoren"
printf 'time=abc\nmissing=pcsx2,ppsspp,dolphin\n' > "$HOME_W/.jellystation/emulators.check"; runj --no-update; has "==> Emulatoren"

echo "== --emulators erzwingt, --no-emulators und skip lassen aus =="
int_world j7; T_ENV+=("JELLYSTATION_DRY_RUN=1"); mkapp "$W/apps/RPCS3.app" 1
set_marker 60 offen "duckstation,pcsx2,ppsspp,dolphin"
runj --no-update; hasnt "==> Emulatoren"
runj --no-update --emulators; has "==> Emulatoren"; has "würde ausführen: bash"
all_apps; runj --no-update --emulators; has "==> Emulatoren"; has "würde ausführen: bash"   # auch wenn alles da ist
runj --no-update --update-emulators; has "install-emulators.sh --update"
rm -rf "$W/apps"/*; set_marker 99999 offen ""
runj --no-update --no-emulators; hasnt "Emulatoren"; hasnt "install-emulators"
T_ENV+=("JELLYSTATION_EMULATORS=skip"); runj --no-update; hasnt "Emulatoren"
runj --no-update --emulators --no-emulators; rc_is 2; has "--no-emulators lässt sich nicht mit --emulators oder --update-emulators kombinieren"
runj --no-update --update-emulators --no-emulators; rc_is 2
echo "-- Browser-Vorschau fragt nicht nach Emulatoren --"
int_world j8; T_ENV+=("JELLYSTATION_DRY_RUN=1")
runj --no-update --web; rc_is 0; hasnt "Emulatoren"; has "npm run dev -- --open"
runj --no-update --web --emulators; has "==> Emulatoren"
echo "-- nicht auf dem Mac: nichts --"
int_world j9; T_ENV+=("JELLYSTATION_DRY_RUN=1"); unlink_stub uname
runj --no-update; rc_is 0; hasnt "Emulatoren"; hasnt "install-emulators"
runj --no-update --emulators; rc_is 0; hasnt "install-emulators"
echo "-- Hilfe nennt die neuen Optionen --"
runj --help; rc_is 0; has "--emulators"; has "--update-emulators"; has "--no-emulators"; has "24 Stunden erneut"; has "JELLYSTATION_EMULATORS=skip"
echo "-- kaputtes Installationsskript/Daten stören den Start nicht --"
int_world j10; T_ENV+=("JELLYSTATION_DRY_RUN=1"); echo "kaputt" > "$PROJ/src/emulators/emulators.json"
runj --no-update; rc_is 0; hasnt "Emulatoren"; has "npm run tauri dev"
runj --no-update --emulators; rc_is 0; has "würde ausführen"
runj --status; rc_is 0; hasnt "Emulatoren: "
rm "$PROJ/scripts/install-emulators.sh"; runj --no-update; rc_is 0; hasnt "Emulatoren"

echo "== Update mit Neustart des Startskripts behält die Emulator-Optionen =="
int_world j11; T_ENV+=("JELLYSTATION_DRY_RUN=1"); mkapp "$W/apps/RPCS3.app" 1
origin_commit scripts/jellystation.sh "$(cat "$PROJ/scripts/jellystation.sh")
# neue Fassung"
runj --emulators -y
rc_is 0; has "starte mit der neuen Fassung neu"; eq "$(count_in "$W/out.txt" "würde ausführen: bash $PROJ/scripts/install-emulators.sh --yes")" "1" "Emulatoren-Schritt genau einmal, mit --yes"

echo "== Spiele-Ordner im Programmordner überstehen das Update =="
int_world j12; T_ENV+=("JELLYSTATION_DRY_RUN=1"); all_apps
mkdir -p "$PROJ/Games/PS2" "$PROJ/BIOS/PCSX2"; echo "iso" > "$PROJ/Games/PS2/spiel.iso"; echo "bios" > "$PROJ/BIOS/PCSX2/scph.bin"
echo "lokale Änderung" >> "$PROJ/package.json"
origin_commit docs/neu.txt "neu"
runj
rc_is 0; has "Lokale Änderungen gefunden (1 Eintrag)"
exists "$PROJ/Games/PS2/spiel.iso" "Spiel liegt noch da"; exists "$PROJ/BIOS/PCSX2/scph.bin" "BIOS liegt noch da"
file_has "$PROJ/.git/info/exclude" "/Games" "exclude: /Games"; file_has "$PROJ/.git/info/exclude" "/BIOS" "exclude: /BIOS"
eq "$(git -C "$PROJ" stash list | wc -l | tr -d ' ')" "1" "ein Stash (nur package.json)"
eq "$(git -C "$PROJ" stash show --name-only --include-untracked "stash@{0}" 2>/dev/null | grep -c 'Games\|BIOS')" "0" "Stash enthält keine Spiele"
echo "-- Games ist ein Link auf eine andere Platte --"
int_world j12b; T_ENV+=("JELLYSTATION_DRY_RUN=1"); all_apps
mkdir -p "$W/Platte/Games/PS2"; echo "iso" > "$W/Platte/Games/PS2/spiel.iso"; ln -s "$W/Platte/Games" "$PROJ/Games"
echo "lokale Änderung" >> "$PROJ/package.json"; origin_commit docs/neu.txt "neu"
runj; rc_is 0
[ -L "$PROJ/Games" ] && ok_ "der Link Games liegt noch da" || no_ "der Link Games wurde weggesichert"
exists "$PROJ/Games/PS2/spiel.iso" "Spiel über den Link erreichbar"; file_has "$PROJ/.git/info/exclude" "/Games" "exclude: /Games"
echo "-- Gegenprobe: die alte Fassung hätte die Spiele weggesichert --"
int_world j13; T_ENV+=("JELLYSTATION_DRY_RUN=1")
# legacy/jellystation.sh.alt ist die Fassung vor der Emulator-Einrichtung (aus dem Commit 6dac11f)
grep -q protect_user_dirs "$T_ROOT/legacy/jellystation.sh.alt" && no_ "legacy/jellystation.sh.alt ist keine alte Fassung" || ok_ "legacy/jellystation.sh.alt ist die alte Fassung"
cp "$T_ROOT/legacy/jellystation.sh.alt" "$PROJ/scripts/jellystation.sh"
git -C "$PROJ" -c user.name=t -c user.email=t@t commit -q -am "alte Fassung" && git -C "$PROJ" push -q origin "$BR" 2>/dev/null
mkdir -p "$PROJ/Games/PS2"; echo "iso" > "$PROJ/Games/PS2/spiel.iso"
origin_commit docs/neu.txt "neu"
runj
[ ! -e "$PROJ/Games/PS2/spiel.iso" ] && ok_ "alte Fassung: Spiel wurde in den Stash verschoben (das Problem war real)" || no_ "alte Fassung hat das Spiel nicht angefasst"

echo "== setup-mac.sh =="
int_world s1; link_stubs
runs --help; rc_is 0; has "--no-emulators"; has "Emulatoren und Ordner"; has "JELLYSTATION_EMULATORS=skip"; hasnt "set -euo"
echo "-- --prepare: 3 Schritte, der letzte richtet die Emulatoren ein --"
std_routes; start_server; ds_override
runs --prepare
rc_is 0; has "1/3 Voraussetzungen prüfen"; has "2/3 npm-Pakete installieren"; has "3/3 Emulatoren und Ordner"; has "Vorbereitung abgeschlossen: Werkzeuge, Pakete und Emulatoren sind bereit"
has "Fertig: 5 von 5 Emulatoren sind installiert."; hasnt "==> 4/"; exists "$W/apps/RPCS3.app"; exists "$HOME_W/JellyStation/Games/PS2"
file_has "$W/npm.log" "npm ci" "npm ci lief vor den Emulatoren"
echo "-- erneut: nichts mehr zu tun --"
runs --prepare; rc_is 0; has "Nichts zu tun"
echo "-- --prepare --no-emulators: wie früher (2 Schritte) --"
int_world s2
runs --prepare --no-emulators; rc_is 0; has "1/2 Voraussetzungen prüfen"; has "2/2 npm-Pakete installieren"; hasnt "Emulatoren und Ordner"; hasnt "==> 3/"; has "Vorbereitung abgeschlossen"
absent "$W/apps/RPCS3.app"; absent "$HOME_W/JellyStation/Games" ; eq "$(inst_calls brew)" "0" "kein Homebrew-Aufruf"
echo "-- voller Lauf: 5 Schritte, ohne Emulatoren 4 --"
int_world s3; std_routes; start_server; ds_override
runs; rc_is 0; has "1/5 Voraussetzungen prüfen"; has "3/5 Emulatoren und Ordner"; has "4/5 App bauen"; has "5/5 Fertig"
file_has "$W/npm.log" "npm run tauri build" "gebaut"
int_world s3b
runs --no-emulators; rc_is 0; has "1/4 Voraussetzungen prüfen"; has "3/4 App bauen"; has "4/4 Fertig"; hasnt "Emulatoren und Ordner"
echo "-- --dev: kein Emulator-Schritt, 3 Schritte --"
int_world s4
runs --dev; rc_is 0; has "1/3 Voraussetzungen prüfen"; has "3/3 Entwicklungsversion starten"; hasnt "Emulatoren und Ordner"
file_has "$W/npm.log" "npm run tauri dev" "dev gestartet"
echo "-- das Ergebnis wird für \"jellystation\" gemerkt: kein sofortiger zweiter Versuch --"
int_world s11; unlink_stub brew; std_routes; start_server; ds_override     # Cask-Emulatoren scheitern
runs --prepare
rc_is 0; has "2 von 5 Emulatoren sind installiert."
file_has "$HOME_W/.jellystation/emulators.check" "result=offen" "Merkdatei: offen"; file_has "$HOME_W/.jellystation/emulators.check" "missing=pcsx2,ppsspp,dolphin" "Merkdatei: fehlende IDs"
T_ENV+=("JELLYSTATION_DRY_RUN=1"); runj --no-update
has "Emulatoren fehlen noch: PCSX2, PPSSPP, Dolphin"; hasnt "==> Emulatoren"; hasnt "würde ausführen: bash"
int_world s12; std_routes; start_server; ds_override
runs --prepare; rc_is 0
file_has "$HOME_W/.jellystation/emulators.check" "result=ok" "Merkdatei: ok"
echo "-- --mark-emulators (intern) --"
int_world s13; T_ENV+=("JELLYSTATION_DRY_RUN=1")
runj --mark-emulators; rc_is 0; absent "$HOME_W/.jellystation/emulators.check" "Trockenlauf schreibt nichts"
T_ENV=("${T_ENV[@]:0:${#T_ENV[@]}-1}" "JELLYSTATION_DRY_RUN=0"); mkapp "$W/apps/RPCS3.app" 1
runj --mark-emulators; rc_is 0; eq "$OUT" "" "still"; file_has "$HOME_W/.jellystation/emulators.check" "result=offen" "partiell: offen"; file_has "$HOME_W/.jellystation/emulators.check" "missing=duckstation,pcsx2,ppsspp,dolphin" "fehlende IDs"
rm -f "$HOME_W/.jellystation/emulators.check"; T_ENV+=("JELLYSTATION_EMULATORS=skip"); runj --mark-emulators; absent "$HOME_W/.jellystation/emulators.check" "skip: nichts gemerkt"
echo "-- Fehler im Emulator-Schritt brechen die Einrichtung nicht ab --"
int_world s5
printf '#!/usr/bin/env bash\necho "Installer-Attrappe: %s" >> "%s/state/calls.log"\nexit 7\n' '$*' "$W" > "$PROJ/scripts/install-emulators.sh"
runs --prepare; rc_is 0; has "3/3 Emulatoren und Ordner"; has "Die Emulator-Einrichtung hat nicht alles geschafft - 'jellystation --emulators' versucht es später erneut."; has "Vorbereitung abgeschlossen"
file_has "$W/state/calls.log" "Installer-Attrappe: --yes" "Aufruf mit --yes"
rm "$PROJ/scripts/install-emulators.sh"
runs --prepare; rc_is 0; has "scripts/install-emulators.sh fehlt - die Emulatoren werden übersprungen."; has "Vorbereitung abgeschlossen"
echo "-- skip --"
int_world s6; T_ENV+=("JELLYSTATION_EMULATORS=skip"); runs --prepare; rc_is 0; has "Emulatoren übersprungen"
absent "$W/apps/RPCS3.app"
echo "-- Aufruf aus einem anderen Ordner und mit relativem Pfad --"
int_world s7; std_routes; start_server; ds_override
SUT="scripts/setup-mac.sh"; RC=0; make_cmd --prepare
( cd "$PROJ" && "${CMD[@]}" ) > "$W/out.txt" 2>&1 < /dev/null || RC=$?; OUT="$(cat "$W/out.txt")"; SUT=""
rc_is 0; has "3/3 Emulatoren und Ordner"; exists "$W/apps/RPCS3.app" "relativer Aufruf findet install-emulators.sh"

echo "-- Homebrew nur bei Bedarf: --install-missing ohne brew, mit fehlenden Cask-Emulatoren --"
int_world s8; unlink_stub brew; std_routes; start_server; ds_override
fake_homebrew_curl
runs --install-missing --prepare
rc_is 0; has "Für einige Emulatoren wird Homebrew gebraucht."; has "Installiere Homebrew"; has "Homebrew ließ sich nicht installieren"
file_has "$W/state/calls.log" "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh" "offizielles Installationsskript angefordert"
exists "$W/apps/RPCS3.app" "die übrigen Emulatoren werden trotzdem installiert"; absent "$W/apps/PCSX2.app"; has "Vorbereitung abgeschlossen"
echo "-- ohne --install-missing wird Homebrew nie angefasst --"
int_world s9; unlink_stub brew; std_routes; start_server; ds_override
fake_homebrew_curl
runs --prepare; rc_is 0; hasnt "Installiere Homebrew"; file_hasnt "$W/state/calls.log" "Homebrew/install" "kein Homebrew-Installer"
echo "-- nur RPCS3/DuckStation fehlen: kein Homebrew nötig --"
int_world s10; unlink_stub brew; std_routes; start_server; ds_override
mkapp "$W/apps/PCSX2.app" 1; mkapp "$W/apps/PPSSPP.app" 1; mkapp "$W/apps/Dolphin.app" 1
fake_homebrew_curl
runs --install-missing --prepare; rc_is 0; hasnt "Installiere Homebrew"; exists "$W/apps/RPCS3.app"

echo "== bootstrap.sh =="
bash -n "$REPO_DIR/scripts/bootstrap.sh" && ok_ "bootstrap.sh: Syntax in Ordnung (bash)"
if [ -x "$BASHBIN" ] || command -v "$BASHBIN" >/dev/null 2>&1; then "$BASHBIN" -n "$REPO_DIR/scripts/bootstrap.sh" && ok_ "bootstrap.sh: Syntax in Ordnung ($BASHBIN)"; fi
int_world b1; std_routes; start_server; ds_override
rm -rf "$PROJ"
T_ENV+=("JELLYSTATION_DIR=$W/home/Ziel/JellyStation" "SHELL=/bin/zsh")
SUT="$SEED/scripts/bootstrap.sh"; run; SUT=""
rc_is 0; has "1/4 Mac und git prüfen"; has "2/4 JellyStation herunterladen"; has "3/4 Werkzeuge, Pakete, Emulatoren und Ordner vorbereiten (kann einige Minuten dauern)"
has "1/3 Voraussetzungen prüfen"; has "3/3 Emulatoren und Ordner"; has "4/4 Befehl \"jellystation\" einrichten"; has "Fertig! Öffne ein neues Terminal-Fenster"
has "Spiele kommen in $HOME_W/JellyStation/Games/<System>/"; has "BIOS und Firmware gehören nicht zum Lieferumfang"
exists "$W/apps/RPCS3.app" "Emulator durch bootstrap installiert"; exists "$HOME_W/JellyStation/Games/PS3"
echo "-- Zielordner mit altem setup-mac.sh (ohne Emulator-Schritt): Hinweis, aber kein Abbruch --"
int_world b2; rm -rf "$PROJ"
cp "$T_ROOT/legacy/setup-mac.sh.alt" "$SEED/scripts/setup-mac.sh"   # Fassung ohne Emulator-Schritt (aus dem Commit 6dac11f)
( cd "$SEED" && gi add -A && gi commit -q -m "alte setup-mac.sh" && git push -q origin "$BR" 2>/dev/null )
T_ENV+=("JELLYSTATION_DIR=$W/home/Ziel2" "SHELL=/bin/zsh")
SUT="$SEED/scripts/bootstrap.sh"; run; SUT=""
rc_is 0; has "Dieser Ordner ist älter: die Emulator-Einrichtung fehlt noch"; has "Fertig! Öffne ein neues Terminal-Fenster"
echo "-- bootstrap-Update sichert keine Spiele --"
int_world b3
mkdir -p "$PROJ/Games/PS2"; echo "iso" > "$PROJ/Games/PS2/spiel.iso"; echo "lokal" >> "$PROJ/package.json"
origin_commit docs/neu.txt "neu"
T_ENV+=("JELLYSTATION_DIR=$PROJ" "SHELL=/bin/zsh" "JELLYSTATION_EMULATORS=skip")
SUT="$PROJ/scripts/bootstrap.sh"; run; SUT=""
rc_is 0; has "Lokale Änderungen sind gesichert"; exists "$PROJ/Games/PS2/spiel.iso" "Spiel liegt noch da"; file_has "$PROJ/.git/info/exclude" "/Games" "exclude: /Games"

finish
