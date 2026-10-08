#!/usr/bin/env bash
# Zielordner: /Applications nicht beschreibbar → ~/Applications; Pfade mit Leerzeichen; Rechte beim Update.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

if ! unshare -m true 2>/dev/null; then
  echo "== übersprungen: unshare -m (schreibgeschützte Mounts) ist hier nicht möglich =="
  echo "ERGEBNIS (t_dirs.sh, $BASHBIN): 0 bestanden, 0 fehlgeschlagen (übersprungen)"
  exit 0
fi

echo "== /Applications nicht beschreibbar → Ausweichordner ~/Applications =="
new_world r1; std_routes; start_server; ds_override
RO_DIRS="$W/apps"
run --yes
rc_is 0
has "ist für dich nicht beschreibbar – die Emulatoren kommen nach $W/uapps"; has "Installationsordner: $W/uapps"
for app in RPCS3 DuckStation PCSX2 PPSSPPSDL Dolphin; do exists "$W/uapps/$app.app" "$app.app im Ausweichordner"; done
eq "$(ls -A "$W/apps" | wc -l | tr -d ' ')" "0" "der schreibgeschützte Ordner bleibt leer"
file_has "$W/state/calls.log" "brew install --cask --appdir=$W/uapps pcsx2" "Homebrew bekommt den Ausweichordner (--appdir)"
has "Fertig: 5 von 5 Emulatoren sind installiert."
run
rc_is 0; has "Nichts zu tun"; has "$W/uapps/RPCS3.app" 
run --check; rc_is 0
echo "-- Ausweichordner wird bei Bedarf angelegt, auch mit Leerzeichen im Namen --"
new_world r2; std_routes; start_server; ds_override
RO_DIRS="$W/apps"; T_ENV+=("JELLYSTATION_USER_APPS_DIR=$W/home/Meine Programme")
run --yes --only rpcs3
rc_is 0; exists "$W/home/Meine Programme/RPCS3.app" "Ausweichordner neu angelegt"

echo "== beide Ordner nicht beschreibbar =="
new_world r3; std_routes; start_server; ds_override
mkdir -p "$W/uapps"; RO_DIRS="$W/apps
$W/uapps"
run --yes
rc_is 0; has "Weder $W/apps noch $W/uapps ist beschreibbar"
eq "$(find "$W/apps" "$W/uapps" -mindepth 1 | wc -l | tr -d ' ')" "0" "nichts installiert"
exists "$W/home/JellyStation/Games/PS2" "Spiele-Ordner trotzdem angelegt"
eq "$(n_requests GET)" "0" "es wurde nichts heruntergeladen"

echo "== Update, aber der Ordner der alten App ist nicht beschreibbar =="
new_world r4; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-v1.zip rpcs3-arm64.zip)")"
route_downloads; start_server
run --yes --only rpcs3; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "Ausgangslage"
ROUTES=(); route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-2 "$(asset rpcs3-v2.zip rpcs3-new.zip)")"; route_downloads; write_routes
RO_DIRS="$W/apps"
run --update --only rpcs3
rc_is 0; has "RPCS3 konnte nicht aktualisiert werden:"; has "$W/apps ist nicht beschreibbar"; has "Die vorhandene Version bleibt erhalten"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version unverändert"; eq "$(ls -A "$W/uapps" 2>/dev/null | wc -l | tr -d ' ')" "0" "kein heimliches Doppel im Ausweichordner"

echo "== Pfade mit Leerzeichen (Benutzerordner, Programme-Ordner, Temp, Mock-Dateien) =="
new_world "Mit Leer zeichen"
HOME_W="$W/Benutzer Ordner/ich"; mkdir -p "$HOME_W"; rm -rf "$W/apps"; mkdir -p "$W/Meine Apps"
T_ENV+=("JELLYSTATION_APPS_DIR=$W/Meine Apps" "JELLYSTATION_USER_APPS_DIR=$W/Meine Apps 2")
std_routes; start_server; ds_override
run --yes
rc_is 0; has "Fertig: 5 von 5 Emulatoren sind installiert."
for app in RPCS3 DuckStation PCSX2 PPSSPPSDL Dolphin; do exists "$W/Meine Apps/$app.app" "$app.app (Pfad mit Leerzeichen)"; done
exists "$HOME_W/JellyStation/Games/PS3" "Spiele-Ordner unter Benutzerordner mit Leerzeichen"
exists "$HOME_W/JellyStation/BIOS/PCSX2/README.txt" "BIOS-Hinweis"
exists "$HOME_W/Library/Application Support/PCSX2/bios" "PCSX2-BIOS-Ordner"
exists "$HOME_W/.jellystation/emulators.installed" "Merkdatei"
eq "$(find "$W/Meine Apps" -maxdepth 1 -name '.*jellystation*' | wc -l | tr -d ' ')" "0" "keine Reste"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"
hasnt "~/~"; has "~/JellyStation/Games/<System>/"
run; rc_is 0; has "Nichts zu tun"
echo "-- Update mit Leerzeichen --"
ROUTES=(); std_routes_new() { route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-2 "$(asset rpcs3-v2.zip rpcs3-new.zip)")"; route_downloads; write_routes; }; std_routes_new
run --update --only rpcs3
rc_is 0; has "RPCS3 aktualisiert"; eq "$(tag_of "$W/Meine Apps/RPCS3.app")" "rpcs3-new" "ersetzt"

echo "== JELLYSTATION_HOME statt \$HOME =="
new_world h1; std_routes; start_server; ds_override
mkdir -p "$W/echtes home"; HOME_W="$W/echtes home"
T_ENV+=("JELLYSTATION_HOME=$W/anderes home")
run --yes --only rpcs3
rc_is 0; exists "$W/anderes home/JellyStation/Games/PS3" "Bibliothek unter JELLYSTATION_HOME"; exists "$W/anderes home/.jellystation/emulators.installed" "Merkdatei dort"
eq "$(ls -A "$W/echtes home" | wc -l | tr -d ' ')" "0" "echtes HOME unberührt"

finish
