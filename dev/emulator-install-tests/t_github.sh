#!/usr/bin/env bash
# GitHub-Abfrage: Rate-Limit, 404, kein Treffer, Prüfsummen, Bauart (ARM/Intel/Rosetta), Rückfälle, erlaubte Server.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"


echo "== API 403 (Rate-Limit): sofort abbrechen, nur eine Anfrage, Rest läuft weiter =="
new_world g403; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" '{"message": "API rate limit exceeded for 1.2.3.4.", "documentation_url": "x"}' 403
route_downloads; start_server; ds_override
run --yes
rc_is 0
has "RPCS3 wurde nicht installiert: GitHub begrenzt gerade die Anfragen (Rate-Limit)"; has "GITHUB_TOKEN"
has "RPCS3 → https://rpcs3.net/download"
absent "$W/apps/RPCS3.app"; exists "$W/apps/DuckStation.app" "DuckStation trotzdem installiert"
eq "$(n_requests '/repos/RPCS3/')" "1" "nach Rate-Limit keine weiteren Anfragen"
has "4 von 5 Emulatoren sind installiert."

echo "== API 403 ohne Rate-Limit-Text =="
new_world g403b; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" '{"message": "Forbidden"}' 403
start_server; run --yes --only rpcs3
has "GitHub verweigert die Abfrage (HTTP 403)"

echo "== API 401 (ungültiges Token) =="
new_world g401; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" '{"message": "Bad credentials"}' 401
start_server; T_ENV+=("GITHUB_TOKEN=abgelaufen")
run --yes --only rpcs3
rc_is 0; has "GitHub lehnt das GITHUB_TOKEN ab (HTTP 401)"; hasnt "abgelaufen"

echo "== API 5xx / keine Verbindung =="
new_world g500; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" '{"message": "Server Error"}' 503
start_server; T_ENV+=("JELLYSTATION_APPS_DIR=$W/apps")
run --yes --only rpcs3
has "GitHub meldet einen Fehler (HTTP 503)"; eq "$(n_requests '/repos/RPCS3/')" "1" "kein Durchprobieren bei Serverfehler"
new_world gdown; casks_present
SERVER_URL="http://127.0.0.1:18299"   # dort lauscht niemand
run --yes --only rpcs3
rc_is 0; has "GitHub nicht erreichbar: keine Verbindung (Internet prüfen)"; has "RPCS3 → https://rpcs3.net/download"; SERVER_URL=""

echo "== Antwort ist kein JSON (z. B. Anmeldeseite eines WLANs) =="
new_world ghtml; casks_present
route "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" '{"status": 200, "text": "<html><body>Bitte anmelden</body></html>"}'
route "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases?per_page=10" '{"status": 200, "text": "<html></html>"}'
route "GET /repos/RPCS3/rpcs3-binaries-mac/releases/latest" '{"status": 200, "text": "<html></html>"}'
route "GET /repos/RPCS3/rpcs3-binaries-mac/releases?per_page=10" '{"status": 200, "text": "<html></html>"}'
start_server
run --yes --only rpcs3
rc_is 0; has "war nicht lesbar (kein JSON"; has "RPCS3 → https://rpcs3.net/download"; absent "$W/apps/RPCS3.app"

echo "== API 404 überall =="
new_world g404; casks_present
start_server; ds_override
run --yes --only rpcs3
rc_is 0
has "RPCS3 wurde nicht installiert:"; has "bei GitHub nicht gefunden (HTTP 404)"
eq "$(n_requests 'GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest')" "1" "arm64: latest abgefragt"
eq "$(n_requests 'GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases?per_page=10')" "1" "arm64: letzte 10 abgefragt"
eq "$(n_requests 'GET /repos/RPCS3/rpcs3-binaries-mac/releases/latest')" "1" "x64 (Rosetta-Weg): latest abgefragt"
eq "$(n_requests 'GET /repos/RPCS3/rpcs3-binaries-mac/releases?per_page=10')" "1" "x64: letzte 10 abgefragt"
has "Manuell nötig:"

echo "== latest ist 404, aber die Liste der letzten 10 enthält ein passendes Archiv =="
new_world glist; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases?per_page=10" "[$(release build-b "$(asset rpcs3-b.zip.sha256 dummy.txt)" "$(asset rpcs3-b-symbols.zip dummy.txt)"),$(release build-a "$(asset rpcs3-a-macos-arm64.zip rpcs3-arm64.zip)")]"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; has "RPCS3 installiert"; has "Version build-a"; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "Archiv aus dem zweiten Release"

echo "== latest ohne passendes Asset, Liste mit Treffer; Entwürfe werden ignoriert =="
new_world gdraft; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-z "$(asset nur-symbols.zip dummy.txt)")"
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases?per_page=10" "[{\"tag_name\":\"entwurf\",\"draft\":true,\"assets\":[$(asset rpcs3-entwurf.zip rpcs3-new.zip)]},$(release build-ok "$(asset rpcs3-ok-arm64.zip rpcs3-arm64.zip)")]"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "Entwurf übersprungen"

echo "== kein passendes Asset =="
new_world gnone; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-debug.zip dummy.txt)" "$(asset rpcs3-symbols.7z dummy.txt)" "$(asset rpcs3.sha256 dummy.txt)" "$(asset rpcs3-dSYM.zip dummy.txt)" "$(asset notes.txt dummy.txt)" "$(asset rpcs3.zip.blockmap dummy.txt)")"
route_json "GET /repos/RPCS3/rpcs3-binaries-mac/releases/latest" "$(release build-2 "$(asset nur-ein-text.txt dummy.txt)")"
start_server
run --yes --only rpcs3
rc_is 0; has "kein passendes Download-Archiv"; has "vorhanden: rpcs3-debug.zip, rpcs3-symbols.7z"; has "RPCS3 wurde nicht installiert"
absent "$W/apps/RPCS3.app"

echo "== Prüfsumme: falsch / richtig / fehlt =="
new_world gsha; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-arm64.zip rpcs3-arm64.zip bad)")"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; has "Die Prüfsumme (SHA-256) stimmt nicht"; has "Datei verworfen"; absent "$W/apps/RPCS3.app"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "falsche Prüfsumme: Temp-Ordner aufgeräumt"
new_world gsha2; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-arm64.zip rpcs3-arm64.zip none)")"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; has "keine Prüfsumme"; exists "$W/apps/RPCS3.app"
new_world gsize; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-arm64.zip rpcs3-arm64.zip wrongsize)")"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; has "Der Download ist unvollständig"; absent "$W/apps/RPCS3.app"

echo "== Bauart: Apple Silicon ohne ARM-Build → Intel-Build mit Rosetta-Hinweis =="
new_world garm1; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac/releases/latest" "$(release build-x "$(asset rpcs3-x64.zip rpcs3-x64.zip)")"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-x64" "Intel-Build installiert"
has "Kein eigener Apple-Silicon-Build gefunden"; has "Rosetta 2"
echo "== Bauart: Intel-Mac fragt nur das Intel-Repo =="
new_world gintel; casks_present; ARM=0
std_routes; start_server
run --yes --only rpcs3
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-x64" "Intel-Build"; hasnt "Rosetta"
eq "$(n_requests 'mac-arm64')" "0" "ARM-Repo nie angefragt"
echo "== Bauart: Apple Silicon mit ARM-Build: kein Rosetta =="
new_world garm2; casks_present
std_routes; start_server
run --yes --only rpcs3
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "ARM-Build"; hasnt "Rosetta"

echo "== Bauart in einem gemeinsamen Repo (DuckStation-Rückfall, Asset-Namen mit arm64/x64) =="
ds_release() { release latest "$(asset duckstation-windows-x64-release.zip duckstation-windows-x64-release.zip none)" "$(asset duckstation-linux-x64.AppImage duckstation-linux-x64.AppImage none)" "$@"; }
new_world gds1; casks_present; mkapp "$W/apps/RPCS3.app" 1
route_status "GET /dl/duckstation-mac-release.zip" 404
route_json "GET /repos/stenzek/duckstation/releases/tags/latest" "$(ds_release "$(asset duckstation-mac-x64.zip duckstation-x64.zip none)" "$(asset duckstation-mac-arm64.zip duckstation-gh.zip none)")"
route_downloads; start_server; ds_override
run --yes --only duckstation
rc_is 0; has "versuche einen anderen Weg"; has "stenzek/duckstation"; eq "$(tag_of "$W/apps/DuckStation.app")" "duck-github" "ARM-Asset gewählt (Fallback)"
hasnt "Rosetta"
eq "$(n_requests 'GET /repos/stenzek/duckstation/releases/tags/latest')" "1" "Release-Pfad aus den Daten (tags/latest)"
new_world gds2; casks_present; mkapp "$W/apps/RPCS3.app" 1; ARM=0
route_status "GET /dl/duckstation-mac-release.zip" 404
route_json "GET /repos/stenzek/duckstation/releases/tags/latest" "$(ds_release "$(asset duckstation-mac-x64.zip duckstation-x64.zip none)" "$(asset duckstation-mac-arm64.zip duckstation-gh.zip none)")"
route_downloads; start_server; ds_override
run --yes --only duckstation
rc_is 0; eq "$(tag_of "$W/apps/DuckStation.app")" "duck-x64" "Intel: x64-Asset gewählt"
new_world gds3; casks_present; mkapp "$W/apps/RPCS3.app" 1   # ARM-Mac, nur ein x64-Asset im gemeinsamen Repo → Rosetta
route_status "GET /dl/duckstation-mac-release.zip" 404
route_json "GET /repos/stenzek/duckstation/releases/tags/latest" "$(ds_release "$(asset duckstation-mac-x64.zip duckstation-x64.zip none)")"
route_downloads; start_server; ds_override
run --yes --only duckstation
rc_is 0; eq "$(tag_of "$W/apps/DuckStation.app")" "duck-x64" "x64-Asset auf ARM"; has "Rosetta 2"
new_world gds4; casks_present; mkapp "$W/apps/RPCS3.app" 1; ARM=0   # Intel-Mac, nur ein arm64-Asset → unbrauchbar
route_status "GET /dl/duckstation-mac-release.zip" 404
route_json "GET /repos/stenzek/duckstation/releases/tags/latest" "$(ds_release "$(asset duckstation-mac-arm64.zip duckstation-gh.zip none)")"
route_downloads; start_server; ds_override
run --yes --only duckstation
rc_is 0; has "DuckStation wurde nicht installiert"; has "kein passendes Download-Archiv"; absent "$W/apps/DuckStation.app"
echo "-- weder Windows- noch Linux-Dateien werden genommen --"
new_world gds5; casks_present; mkapp "$W/apps/RPCS3.app" 1
route_status "GET /dl/duckstation-mac-release.zip" 404
route_json "GET /repos/stenzek/duckstation/releases/tags/latest" "$(ds_release)"
route_downloads; start_server; ds_override
run --yes --only duckstation
has "vorhanden: duckstation-windows-x64-release.zip, duckstation-linux-x64.AppImage"; absent "$W/apps/DuckStation.app"
echo "-- direkter Weg und Rückfall scheitern beide: beide Gründe, manuelle Anleitung --"
new_world gds6; casks_present; mkapp "$W/apps/RPCS3.app" 1
route_status "GET /dl/duckstation-mac-release.zip" 404
start_server; ds_override
run --yes --only duckstation
rc_is 0; has "versuche einen anderen Weg"; has "DuckStation wurde nicht installiert"; has "DuckStation → https://www.duckstation.org/"

echo "== Dateiendung: dmg vor zip vor tar vor 7z (gleiche Bauart vorausgesetzt) =="
new_world gext; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-arm64.7z rpcs3.7z none)" "$(asset rpcs3-arm64.tar.xz rpcs3.tar.xz none)" "$(asset rpcs3-arm64.zip rpcs3-arm64.zip none)" "$(asset rpcs3-arm64.dmg rpcs3.dmg none)")"
route_downloads; start_server
run --yes --only rpcs3
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-dmg" "dmg bevorzugt"
new_world gext2; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-arm64.7z rpcs3.7z none)" "$(asset rpcs3-arm64.tar.xz rpcs3.tar.xz none)" "$(asset rpcs3-arm64.zip rpcs3-arm64.zip none)")"
route_downloads; start_server
run --yes --only rpcs3
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "zip vor tar.xz und 7z"
new_world gext3; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-arm64.7z rpcs3.7z none)" "$(asset rpcs3-arm64.tar.xz rpcs3.tar.xz none)")"
route_downloads; start_server
run --yes --only rpcs3
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-tarxz" "tar.xz vor 7z"
echo "-- die passende Bauart schlägt die bevorzugte Endung --"
new_world gext4; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-x64.dmg rpcs3.dmg none)" "$(asset rpcs3-arm64.zip rpcs3-arm64.zip none)")"
route_downloads; start_server
run --yes --only rpcs3
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "arm64-zip statt x64-dmg"
echo "-- universal läuft überall --"
new_world gext5; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-x64.zip rpcs3-x64.zip none)" "$(asset rpcs3-universal.zip rpcs3-new.zip none)")"
route_downloads; start_server
run --yes --only rpcs3
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-new" "universal statt x64"; hasnt "Rosetta"

echo "== Erlaubte Server =="
new_world ghost1; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 '{"name":"rpcs3.zip","state":"uploaded","size":10,"browser_download_url":"https://evil.example.com/rpcs3.zip"}')"
start_server
run --yes --only rpcs3
rc_is 0; has "Der Download-Server 'evil.example.com' steht nicht auf der Liste der erlaubten Server"; absent "$W/apps/RPCS3.app"
file_hasnt "$W/state/curl.log" "evil.example.com" "es wurde gar nicht erst dorthin verbunden"
new_world ghost2; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 '{"name":"rpcs3.zip","state":"uploaded","size":10,"browser_download_url":"https://github.com@evil.example.com/rpcs3.zip"}')"
start_server
run --yes --only rpcs3
has "nicht zulässig"; absent "$W/apps/RPCS3.app"
new_world ghost3; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 '{"name":"rpcs3.zip","state":"uploaded","size":10,"browser_download_url":"http://github.com/rpcs3.zip"}')"
start_server; T_ENV+=("JELLYSTATION_TEST=0")
run --yes --only rpcs3
has "nicht zulässig"; absent "$W/apps/RPCS3.app"
echo "-- Test-Aufweichung gilt nur mit JELLYSTATION_TEST=1 --"
new_world ghost4; casks_present
std_routes; start_server; T_ENV+=("JELLYSTATION_TEST=0")
run --yes --only rpcs3
rc_is 0; has "Die GitHub-Adresse ist nicht zulässig"; absent "$W/apps/RPCS3.app"
eq "$(n_requests GET)" "0" "ohne JELLYSTATION_TEST=1 wird 127.0.0.1 nicht angefragt"
new_world ghost5; casks_present
start_server; T_ENV+=("JELLYSTATION_TEST=0" "JELLYSTATION_GITHUB_API=https://evil.example.com")
run --yes --only rpcs3
has "steht nicht auf der Liste der erlaubten Server"; absent "$W/apps/RPCS3.app"
file_hasnt "$W/state/curl.log" "evil.example.com" "kein Verbindungsversuch zu evil.example.com"
echo "-- Umleitung auf einen Server, der nicht auf der Liste steht (127.0.0.2) --"
new_world ghost6; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 '{"name":"rpcs3.zip","state":"uploaded","size":201680,"browser_download_url":"{{BASE}}/redir/rpcs3.zip"}')"
route "GET /redir/rpcs3.zip" '{"status": 302, "headers": {"location": "http://127.0.0.2:18200/dl/rpcs3-arm64.zip"}}'
route_downloads; start_server
sed -i "s|http://127.0.0.2:18200|http://127.0.0.2:$PORT|" "$W/srv/routes.json"
run --yes --only rpcs3
rc_is 0; has "auf einen nicht erlaubten Server umgeleitet"; has "127.0.0.2"; absent "$W/apps/RPCS3.app"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"

echo "== Token: nur an die API, nie in der Prozessliste =="
new_world gtok; casks_present
std_routes; start_server; T_ENV+=("GITHUB_TOKEN=ghp_GEHEIMER_TEST_WERT")
run --yes --only rpcs3
rc_is 0; exists "$W/apps/RPCS3.app"
file_has "$W/srv/requests.log" "releases/latest auth=ja" "API-Anfrage mit Token"
file_has "$W/srv/requests.log" "GET /dl/rpcs3-arm64.zip auth=nein" "Download ohne Token"
file_hasnt "$W/state/curl.log" "GEHEIMER" "Token steht nicht in den curl-Argumenten"
hasnt "GEHEIMER"
new_world gtok2; casks_present
std_routes; start_server
run --yes --only rpcs3
file_has "$W/srv/requests.log" "releases/latest auth=nein" "ohne Token: keine Anmeldung"

echo "== Eigene Adresse (JELLYSTATION_URL_<ID>) =="
new_world gurl; casks_present
route_downloads; start_server; T_ENV+=("JELLYSTATION_URL_RPCS3=$SERVER_URL/dl/rpcs3-x64.zip")
run --yes --only rpcs3
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-x64" "Adresse aus der Umgebung"
eq "$(n_requests '/repos/')" "0" "keine API-Abfrage bei eigener Adresse"

finish
