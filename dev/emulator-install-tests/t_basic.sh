#!/usr/bin/env bash
# Grundfälle: nichts/alles/teilweise installiert, --check, Homebrew fehlt, --only/--skip, Ordner, Bedienfehler.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

echo "== Bedienung: Hilfe und falsche Optionen =="
new_world help
run --help; rc_is 0; has "--check"; has "--update"; has "--only"; has "JELLYSTATION_EMULATORS=skip"; hasnt "set -u"
run -h; rc_is 0; has "Emulatoren prüfen, installieren"
run --quatsch; rc_is 2; has "Unbekannte Option: --quatsch"
run --only; rc_is 2; has "--only braucht eine Liste"
run --check --update; rc_is 2; has "lässt sich nicht mit --update kombinieren"
run --porcelain; rc_is 2; has "nur zusammen mit --check"
run --only gibtsnicht; rc_is 2; has "Unbekannter Emulator 'gibtsnicht' bei --only"; has "rpcs3, duckstation, pcsx2, ppsspp, dolphin"
run --skip gibtsnicht; rc_is 2; has "bei --skip"
run --only ""; rc_is 2; has "--only braucht eine Liste"
run --only=; rc_is 2; has "--only braucht eine Liste"
run --skip ","; rc_is 2; has "--skip braucht eine Liste"

echo "== kein macOS: Hinweis und Exit 0 =="
new_world linux; unlink_stub uname
run --check; rc_is 0; has "nur auf dem Mac"
run; rc_is 0; has "nur auf dem Mac"
run --check --quiet; rc_is 0; eq "$OUT" "" "leise: keine Ausgabe"
run --check --porcelain; rc_is 0; has "total=0"
run --needs-brew; rc_is 1
eq "$(ls -A "$W/home" | wc -l | tr -d ' ')" "0" "auf Linux wird nichts angelegt"

echo "== Szenario 1: nichts installiert (Apple Silicon) =="
new_world s1
std_routes; start_server; ds_override
before_srv="$(n_requests GET)"
run --check
rc_is 1; has "fehlt"; has "RPCS3"; has "DuckStation"; has "PlayStation Portable"; has "Es fehlen 5 von 5"; has "jellystation --emulators"
eq "$(n_requests GET)" "0" "--check fragt das Netz nicht"
run --yes
rc_is 0
has "[1/5] RPCS3"; has "[5/5] Dolphin"
has "RPCS3/rpcs3-binaries-mac-arm64"; has "Prüfsumme (SHA-256) stimmt."; has "Fertig: 5 von 5 Emulatoren sind installiert."
for app in RPCS3 DuckStation PCSX2 PPSSPPSDL Dolphin; do exists "$W/apps/$app.app" "$app.app im Programme-Ordner"; done
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "RPCS3: Apple-Silicon-Build"
eq "$(tag_of "$W/apps/DuckStation.app")" "duck-direct" "DuckStation: Direktlink"
eq "$(apps_list)" "Dolphin.app DuckStation.app PCSX2.app PPSSPPSDL.app RPCS3.app " "keine Reste im Programme-Ordner"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"
eq "$(n_requests 'rpcs3-binaries-mac/')" "0" "Intel-Repo bei ARM nicht angefragt"
file_has "$W/state/curl.log" "--proto =http,https" "Test: http erlaubt nur mit JELLYSTATION_TEST"
file_has "$W/state/calls.log" "xattr -dr com.apple.quarantine $W/apps/RPCS3.app" "Quarantäne-Merkmal entfernt (RPCS3)"
file_has "$W/state/calls.log" "xattr -dr com.apple.quarantine $W/apps/DuckStation.app" "Quarantäne-Merkmal entfernt (DuckStation)"
file_hasnt "$W/state/calls.log" "SUDO" "sudo wurde nie aufgerufen"
file_has "$W/state/calls.log" "brew install --cask --appdir=$W/apps pcsx2" "Cask mit --appdir (Ordner ≠ /Applications)"
for sys in PS1 PS2 PS3 PSP GameCube Wii; do exists "$W/home/JellyStation/Games/$sys" "Spiele-Ordner $sys"; done
for emu in RPCS3 DuckStation PCSX2 PPSSPP Dolphin; do exists "$W/home/JellyStation/BIOS/$emu/README.txt" "BIOS-Hinweis $emu"; done
exists "$W/home/Library/Application Support/PCSX2/bios" "PCSX2-BIOS-Ordner"
exists "$W/home/Library/Application Support/DuckStation/bios" "DuckStation-BIOS-Ordner"
has "Jetzt noch: Spiele in ~/JellyStation/Games/<System>/ ablegen"
has "(PS1, PS2, PS3, PSP, GameCube, Wii)"
file_has "$W/home/JellyStation/BIOS/PCSX2/README.txt" "NICHT mit" "README: nicht mitgeliefert"
file_has "$W/home/JellyStation/BIOS/PCSX2/README.txt" "Application Support/PCSX2/bios" "README: Zielordner"
file_has "$W/home/JellyStation/BIOS/RPCS3/README.txt" "PS3UPDAT.PUP" "README: Firmware-Datei"
file_has "$W/home/.jellystation/emulators.installed" "rpcs3" "Merkdatei: RPCS3"

echo "== Szenario 1b: zweiter Lauf = nichts zu tun =="
snap1="$(snapshot "$W/apps")$(snapshot "$W/home")"
reqs="$(n_requests GET)"
run
rc_is 0; has "Nichts zu tun"; hasnt "[1/"; hasnt "Lade "
eq "$(n_requests GET)" "$reqs" "zweiter Lauf fragt das Netz nicht"
eq "$(snapshot "$W/apps")$(snapshot "$W/home")" "$snap1" "zweiter Lauf ändert nichts"
has "installiert"; has "Version"
run --quiet; rc_is 0; hasnt "Nichts zu tun"; hasnt "Emulator "
run --check; rc_is 0; has "Alle 5 Emulatoren sind installiert."
run --check --quiet; rc_is 0; eq "$OUT" "" "leise + alles da: keine Ausgabe"
run --check --porcelain; rc_is 0; has "total=5"; has "installed=5"; has "missing="
run --needs-brew; rc_is 1

echo "== Szenario 2: --check ändert nichts (Dateisystem-Vergleich) =="
new_world s2
mkdir -p "$W/apps/PCSX2.app/Contents"; echo '<key>CFBundleShortVersionString</key><string>2.0</string>' > "$W/apps/PCSX2.app/Contents/Info.plist"
snap_before="$(snapshot "$W")"
run --check; rc_is 1; has "Es fehlen 4 von 5"
run --check --quiet; rc_is 1; has "Emulator"
run --check --porcelain; rc_is 1; has "total=5"; has "installed=1"; has "missing=rpcs3,duckstation,ppsspp,dolphin"; has "missing_names=RPCS3, DuckStation, PPSSPP, Dolphin"
eq "$(grep -v '^$' "$W/out.txt" | grep -c '^manual=$')" "1" "bei mehreren fehlenden keine einzelne Adresse"
run --check --only rpcs3 --porcelain; has "missing=rpcs3"; has "manual=https://rpcs3.net/download"
run --needs-brew; rc_is 0   # PPSSPP und Dolphin fehlen → Homebrew gebraucht
run --only rpcs3 --needs-brew; rc_is 1   # RPCS3 kommt ohne Homebrew aus
# Vorher/Nachher-Vergleich in einer frischen Welt: kein Ordner, keine Merkdatei, kein Temp-Ordner
new_world s2c
snap_a="$(cd "$W" && find home apps tmp -mindepth 0 | sort | tr '\n' ' ')"
run --check; run --check --quiet; run --check --porcelain; run --check --only rpcs3
snap_b="$(cd "$W" && find home apps tmp -mindepth 0 | sort | tr '\n' ' ')"
eq "$snap_b" "$snap_a" "--check legt nichts an (weder Ordner noch Merkdatei noch Temp)"
absent "$W/uapps" "Ausweichordner nicht angelegt"
absent "$W/home/JellyStation" "Spiele-/BIOS-Ordner nicht angelegt"

echo "== Szenario 3: teilweise installiert / Erkennung =="
new_world s3
std_routes; start_server; ds_override
mkapp "$W/apps/pcsx2.app" "2.0.1"                # kleingeschrieben
mkapp "$W/apps/Emulatoren/PPSSPP.app" "1.17"     # Unterordner
mkapp "$W/uapps/Dolphin 2503.app" "2503"         # Benutzer-Programmordner, Name mit Zusatz
run --yes
rc_is 0
has "[1/2] RPCS3"; has "[2/2] DuckStation"; hasnt "[3/"
has "Fertig: 5 von 5 Emulatoren sind installiert."
file_hasnt "$W/state/calls.log" "brew install" "kein Cask installiert (alle drei waren schon da)"
exists "$W/apps/RPCS3.app"; exists "$W/apps/DuckStation.app"
absent "$W/apps/PCSX2.app" "pcsx2.app nicht doppelt installiert"
run --check; rc_is 0; has "(Version 2.0.1)"; has "(Version 1.17)"; has "Emulatoren/PPSSPP.app"; has "Dolphin 2503.app"
mkdir -p "$W/apps/NichtSupport.app"; rm -rf "$W/apps/RPCS3.app"
run --check --porcelain; has "missing=rpcs3"; has "installed=4"
echo "-- Nicht-Treffer: ähnliche Namen zählen nicht --"
new_world s3b
mkdir -p "$W/apps/MyRPCS3.app/Contents" "$W/apps/RPCS3.txt" "$W/apps/RPCS3-Helper.app.zip"
run --check --porcelain; has "installed=0"
mkdir -p "$W/apps/RPCS3 0.0.34.app/Contents"
run --check --porcelain; has "installed=1"; has "missing=duckstation,pcsx2,ppsspp,dolphin"

echo "== Szenario 4: Homebrew fehlt =="
new_world s4; unlink_stub brew
std_routes; start_server; ds_override
run --yes
rc_is 0
exists "$W/apps/RPCS3.app"; exists "$W/apps/DuckStation.app"
absent "$W/apps/PCSX2.app"; absent "$W/apps/Dolphin.app"
has "PCSX2 wurde nicht installiert: Homebrew fehlt"; has "PPSSPP wurde nicht installiert: Homebrew fehlt"; has "Dolphin wurde nicht installiert: Homebrew fehlt"
has "2 von 5 Emulatoren sind installiert."; has "Manuell nötig:"
has "PCSX2 → https://pcsx2.net/downloads"; has "PPSSPP → https://www.ppsspp.org/download"; has "Dolphin → https://dolphin-emu.org/download/"
has "bash scripts/setup-mac.sh --install-missing --prepare"
run --needs-brew; rc_is 0
echo "-- nur Cask-Emulatoren fehlen, Homebrew fehlt --"
new_world s4b; unlink_stub brew
mkapp "$W/apps/RPCS3.app" 1; mkapp "$W/apps/DuckStation.app" 1
run --needs-brew; rc_is 0
run --yes; rc_is 0; has "2 von 5 Emulatoren sind installiert."; has "PCSX2 wurde nicht installiert: Homebrew fehlt"
run --only rpcs3,duckstation --needs-brew; rc_is 1

echo "== Szenario 5: --only / --skip =="
new_world s5
std_routes; start_server; ds_override
run --only rpcs3 --yes
rc_is 0; has "[1/1] RPCS3"; hasnt "DuckStation  "; exists "$W/apps/RPCS3.app"; absent "$W/apps/PCSX2.app"
eq "$(ls "$W/home/JellyStation/Games")" "PS3" "nur der PS3-Ordner"
eq "$(ls "$W/home/JellyStation/BIOS")" "RPCS3" "nur BIOS/RPCS3"
run --skip rpcs3,duckstation,dolphin --yes
rc_is 0; has "[1/2] PCSX2"; has "[2/2] PPSSPP"; exists "$W/apps/PCSX2.app"; exists "$W/apps/PPSSPPSDL.app"; absent "$W/apps/Dolphin.app"
run --only=DOLPHIN,Pcsx2 --yes
rc_is 0; has "[1/1] Dolphin"; exists "$W/apps/Dolphin.app"
run --only pcsx2 --skip pcsx2; rc_is 0; has "Keine Emulatoren ausgewählt"
run --check --only rpcs3; rc_is 0; has "Alle 1 Emulatoren"
run --check --skip rpcs3; rc_is 1

echo "== Szenario 6: JELLYSTATION_EMULATORS=skip =="
new_world s6
T_ENV=("JELLYSTATION_EMULATORS=skip")
run; rc_is 0; has "übersprungen"; absent "$W/home/JellyStation"; absent "$W/uapps"
run --check; rc_is 0; has "übersprungen"
run --check --quiet; rc_is 0; eq "$OUT" "" "skip + leise: keine Ausgabe"
run --check --porcelain; rc_is 0; has "total=0"
run --yes; rc_is 0; eq "$(ls -A "$W/apps" | wc -l | tr -d ' ')" "0" "nichts installiert"
run --needs-brew; rc_is 1

echo "== Szenario 7: Bibliotheksordner: nichts überschreiben =="
new_world s7
mkapp "$W/apps/RPCS3.app" 1; mkapp "$W/apps/DuckStation.app" 1; mkapp "$W/apps/PCSX2.app" 1; mkapp "$W/apps/PPSSPP.app" 1; mkapp "$W/apps/Dolphin.app" 1
G="$W/home/JellyStation/Games"; B="$W/home/JellyStation/BIOS"
mkdir -p "$G/PS2" "$B/RPCS3" "$W/home/Library/Application Support/PCSX2/bios"
echo "iso-inhalt" > "$G/PS2/spiel.iso"; echo "mein eigener text" > "$B/RPCS3/README.txt"; echo "bios" > "$W/home/Library/Application Support/PCSX2/bios/scph.bin"
run
rc_is 0; has "Nichts zu tun"; has "Ordner für Spiele und BIOS"; has "neu angelegt"
eq "$(cat "$G/PS2/spiel.iso")" "iso-inhalt" "vorhandene Spieldatei unberührt"
eq "$(cat "$B/RPCS3/README.txt")" "mein eigener text" "vorhandene README unberührt"
eq "$(cat "$W/home/Library/Application Support/PCSX2/bios/scph.bin")" "bios" "vorhandene BIOS-Datei unberührt"
exists "$G/PS1"; exists "$G/Wii"; exists "$B/Dolphin/README.txt"
file_has "$B/PPSSPP/README.txt" "kein BIOS" "README PPSSPP: kein BIOS nötig"
snap_f="$(snapshot "$W/home")"
run; rc_is 0; hasnt "neu angelegt"; eq "$(snapshot "$W/home")" "$snap_f" "zweiter Lauf ändert die Ordner nicht"
run --quiet; rc_is 0; eq "$OUT" "" "leise und nichts Neues: keine Ausgabe"
new_world s7b; mkapp "$W/apps/RPCS3.app" 1
run --no-folders; rc_is 0; absent "$W/home/JellyStation" "--no-folders: kein Spiele-/BIOS-Ordner"; absent "$W/home/Library"
run --no-folders --only rpcs3 --yes; rc_is 0

echo "== Szenario 8: Spiele-Ordner im Programmordner werden von Git ignoriert =="
new_world s8
mkdir -p "$W/home/JellyStation/scripts" "$W/home/JellyStation/src/emulators"
cp "$REPO_DIR/scripts/install-emulators.sh" "$W/home/JellyStation/scripts/"; cp "$REPO_DIR/src/emulators/emulators.json" "$W/home/JellyStation/src/emulators/"
( cd "$W/home/JellyStation" && git init -q -b main . && git add -A && git -c user.name=t -c user.email=t@t commit -q -m start )
for e in RPCS3 DuckStation PCSX2 PPSSPP Dolphin; do mkapp "$W/apps/$e.app" 1; done
INSTALLER="$W/home/JellyStation/scripts/install-emulators.sh"
run; rc_is 0; has "wird von Git ignoriert"
file_has "$W/home/JellyStation/.git/info/exclude" "/Games" "exclude: /Games"
file_has "$W/home/JellyStation/.git/info/exclude" "/BIOS" "exclude: /BIOS"
echo "ein Spiel" > "$W/home/JellyStation/Games/PS2/spiel.iso"
eq "$(git -C "$W/home/JellyStation" status --porcelain | wc -l | tr -d ' ')" "0" "git status bleibt sauber"
git -C "$W/home/JellyStation" -c user.name=t -c user.email=t@t stash push -u -q -m test 2>/dev/null || true
exists "$W/home/JellyStation/Games/PS2/spiel.iso" "git stash -u nimmt die Spiele nicht mit"
run; eq "$(grep -c '^/Games$' "$W/home/JellyStation/.git/info/exclude")" "1" "Eintrag nicht doppelt"
INSTALLER="$REPO_DIR/scripts/install-emulators.sh"

finish
