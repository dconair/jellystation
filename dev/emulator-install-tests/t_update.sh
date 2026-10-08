#!/usr/bin/env bash
# --update: Homebrew-Casks, GitHub-Releases, Direktlinks; was nicht von JellyStation stammt, bleibt unberührt.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

# RPCS3-Release setzen: rel_set <Asset-Name> <Datei>
rel_set() {
  ROUTES=()
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-x "$(asset "$1" "$2" "${3:-auto}")")"
  route_downloads; write_routes
}
n_copies() { count_in "$W/state/calls.log" "ditto copy"; }

echo "== Homebrew-Casks aktualisieren =="
new_world u1; std_routes; start_server; ds_override
run --yes; rc_is 0
run --update --only pcsx2,ppsspp,dolphin
rc_is 0
file_has "$W/state/calls.log" "brew upgrade --cask --appdir=$W/apps pcsx2" "brew upgrade pcsx2"
file_has "$W/state/calls.log" "brew upgrade --cask --appdir=$W/apps ppsspp-emulator" "brew upgrade ppsspp-emulator"
file_has "$W/state/calls.log" "brew upgrade --cask --appdir=$W/apps dolphin" "brew upgrade dolphin"
has "PCSX2 aktualisiert"; has "PPSSPP aktualisiert"; has "Dolphin aktualisiert"; hasnt "Manuell nötig"
file_has "$W/state/calls.log" "brew-env NO_AUTO_UPDATE=1 NO_ANALYTICS=1 NO_INSTALL_CLEANUP=1 (brew install)" "Installation: kein Auto-Update, keine Statistik, kein Aufräumen"
file_has "$W/state/calls.log" "brew-env NO_AUTO_UPDATE= NO_ANALYTICS=1 NO_INSTALL_CLEANUP=1 (brew upgrade)" "Upgrade: Paketliste darf sich aktualisieren"
run --check; has "(Version 9.9.9)"

echo "== Cask-App, die nicht über Homebrew kam: unberührt =="
new_world u2; mkapp "$W/apps/PCSX2.app" 2.0
run --update --only pcsx2
rc_is 0; has "PCSX2 ist aktuell (wurde nicht über Homebrew installiert"; file_hasnt "$W/state/calls.log" "brew upgrade" "kein brew upgrade"; hasnt "Manuell nötig"
echo "== Cask-App und Homebrew fehlt: kein Fehler =="
new_world u3; mkapp "$W/apps/PCSX2.app" 2.0; unlink_stub brew
run --update --only pcsx2
rc_is 0; has "Homebrew fehlt – automatisches Update nicht möglich"; hasnt "Manuell nötig"; hasnt "nicht installiert"
echo "== brew upgrade scheitert: vorhandene Version bleibt =="
new_world u4; std_routes; start_server; ds_override
run --yes --only pcsx2; T_ENV+=("STUB_BREW_FAIL=pcsx2")
run --update --only pcsx2
rc_is 0; has "PCSX2 konnte nicht aktualisiert werden: brew upgrade --cask pcsx2 ist fehlgeschlagen"; has "Die vorhandene Version bleibt erhalten"; has "PCSX2 (Update): PCSX2 →"
exists "$W/apps/PCSX2.app"

echo "== GitHub-Release: gleiche Datei = aktuell, neue Datei = aktualisiert =="
new_world u5; casks_present
rel_set rpcs3-v1_macos_arm64.zip rpcs3-arm64.zip; start_server
run --yes --only rpcs3; rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "Ausgangslage"
copies="$(n_copies)"; dls="$(n_requests 'GET /dl/')"
run --update --only rpcs3
rc_is 0; has "RPCS3 ist aktuell"; eq "$(n_copies)" "$copies" "nichts kopiert"; eq "$(n_requests 'GET /dl/')" "$dls" "nichts heruntergeladen"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "unverändert"
rel_set rpcs3-v2_macos_arm64.zip rpcs3-new.zip
run --update --only rpcs3
rc_is 0; has "RPCS3 aktualisiert"; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-new" "neue Version"; eq "$(leftovers)" "" "keine Reste"
eq "$(n_copies)" "$((copies + 1))" "genau einmal kopiert"
file_has "$W/home/.jellystation/emulators.installed" "rpcs3-v2_macos_arm64.zip" "Merkdatei aktualisiert"
run --update --only rpcs3; has "RPCS3 ist aktuell"; eq "$(n_copies)" "$((copies + 1))" "danach wieder aktuell"
echo "-- gleicher Dateiname, andere Prüfsumme → aktualisiert --"
rel_set rpcs3-v2_macos_arm64.zip rpcs3-arm64.zip
run --update --only rpcs3
has "RPCS3 aktualisiert"; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "Inhalt gewechselt"
echo "-- ohne Prüfsumme: gleiche Größe = aktuell, andere Größe = aktualisiert --"
rel_set rpcs3-v3.zip rpcs3-new.zip none
run --update --only rpcs3; has "RPCS3 aktualisiert"
run --update --only rpcs3; has "RPCS3 ist aktuell"
rel_set rpcs3-v3.zip rpcs3-versioned-name.zip none
run --update --only rpcs3; has "RPCS3 aktualisiert"

echo "== Update scheitert: alte Version bleibt =="
new_world u6; casks_present
rel_set rpcs3-v1_macos_arm64.zip rpcs3-arm64.zip; start_server
run --yes --only rpcs3
rel_set rpcs3-v2_macos_arm64.zip rpcs3-new.zip
route_status "GET /dl/rpcs3-new.zip" 404; write_routes
run --update --only rpcs3
rc_is 0; has "RPCS3 konnte nicht aktualisiert werden: Download fehlgeschlagen"; has "Die vorhandene Version bleibt erhalten"; has "RPCS3 (Update): RPCS3 → https://rpcs3.net/download"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version unverändert"; eq "$(leftovers)" "" "keine Reste"

echo "== Direktlink (DuckStation): Hash gleich = aktuell, anderer Hash = aktualisiert =="
new_world u7; casks_present; mkapp "$W/apps/RPCS3.app" 1
route_downloads; start_server; ds_override
run --yes --only duckstation; rc_is 0; eq "$(tag_of "$W/apps/DuckStation.app")" "duck-direct" "Ausgangslage"
copies="$(n_copies)"; dls="$(n_requests 'GET /dl/duckstation-mac-release.zip')"
run --update --only duckstation
rc_is 0; has "DuckStation ist aktuell"; eq "$(n_copies)" "$copies" "nichts kopiert"; eq "$(n_requests 'GET /dl/duckstation-mac-release.zip')" "$((dls + 1))" "geladen (zum Vergleichen)"
ROUTES=(); route_file "GET /dl/duckstation-mac-release.zip" "$FIX/duckstation-gh.zip"; write_routes
run --update --only duckstation
has "DuckStation aktualisiert"; eq "$(tag_of "$W/apps/DuckStation.app")" "duck-github" "neue Version"; eq "$(leftovers)" "" "keine Reste"

echo "== Nicht von JellyStation installiert (keine Merkdatei): unberührt =="
new_world u8; casks_present; mkapp "$W/apps/RPCS3.app" 1 handarbeit; mkapp "$W/apps/DuckStation.app" 1 handarbeit
std_routes; start_server; ds_override
run --update --only rpcs3,duckstation
rc_is 0; has "RPCS3 ist aktuell (wurde nicht von JellyStation installiert"; has "DuckStation ist aktuell (wurde nicht von JellyStation installiert"
eq "$(tag_of "$W/apps/RPCS3.app")" "handarbeit" "RPCS3 unverändert"; eq "$(tag_of "$W/apps/DuckStation.app")" "handarbeit" "DuckStation unverändert"
eq "$(n_requests 'GET /dl/')" "0" "nichts heruntergeladen"

echo "== --update installiert Fehlendes mit =="
new_world u9; casks_present
rel_set rpcs3-v1_macos_arm64.zip rpcs3-arm64.zip; start_server; ds_override
run --yes --only rpcs3
run --update --only rpcs3,duckstation
rc_is 0; has "[1/2] RPCS3"; has "[2/2] DuckStation"; has "RPCS3 ist aktuell"; has "DuckStation installiert"; exists "$W/apps/DuckStation.app"

echo "== Update ersetzt die App dort, wo sie liegt (Unterordner) =="
new_world u10; casks_present
rel_set rpcs3-v1_macos_arm64.zip rpcs3-arm64.zip; start_server
run --yes --only rpcs3
mkdir -p "$W/apps/Emulatoren"; mv "$W/apps/RPCS3.app" "$W/apps/Emulatoren/RPCS3.app"
rel_set rpcs3-v2_macos_arm64.zip rpcs3-new.zip
run --update --only rpcs3
rc_is 0; has "RPCS3 aktualisiert"; eq "$(tag_of "$W/apps/Emulatoren/RPCS3.app")" "rpcs3-new" "im Unterordner ersetzt"; absent "$W/apps/RPCS3.app" "keine zweite Kopie im Hauptordner"; eq "$(leftovers)" "" "keine Reste"

finish
