#!/usr/bin/env bash
# Abbruch mit Strg+C (SIGINT), SIGTERM und SIGHUP: Temp-Ordner weg, keine halb kopierte App, Images ausgeworfen,
# die alte Version bleibt oder kommt zurück.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"
set -m   # Jobsteuerung: der Installer läuft in einer eigenen Prozessgruppe, ein Signal an die Gruppe wirkt wie Strg+C

slow() { # Download in Stücken ausliefern (200 KB in ca. 4 s)
  route_file "GET /dl/$1" "$FIX/$1" '"chunkBytes": 20000, "chunkMs": 400'
}

echo "== Strg+C während des Downloads =="
new_world s1; casks_present
route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-v1.zip rpcs3-arm64.zip)")"
slow rpcs3-arm64.zip; start_server
run_bg --yes --only rpcs3
wait_for "$W/srv/requests.log" "GET /dl/rpcs3-arm64.zip" 10 && ok_ "Download hat begonnen" || no_ "Download hat nicht begonnen"
sleep 0.6
ls "$W/tmp" | grep -q . && ok_ "während des Downloads existiert der Temp-Ordner" || no_ "kein Temp-Ordner gefunden"
t0=$(date +%s)
bg_signal INT
t1=$(date +%s)
rc_is 130; has "Abgebrochen"
[ $((t1 - t0)) -le 3 ] && ok_ "endet sofort ($((t1 - t0)) s)" || no_ "brauchte $((t1 - t0)) s"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner weg"
absent "$W/apps/RPCS3.app"; eq "$(leftovers)" "" "keine Reste im Programme-Ordner"
pgrep -f "$W/bin" >/dev/null 2>&1 && no_ "es laufen noch Prozesse der Welt" || ok_ "keine Restprozesse"

echo "== SIGTERM und SIGHUP während des Downloads =="
for sig in TERM HUP; do
  new_world "s2$sig"; casks_present
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-v1.zip rpcs3-arm64.zip)")"
  slow rpcs3-arm64.zip; start_server
  run_bg --yes --only rpcs3
  wait_for "$W/srv/requests.log" "GET /dl/rpcs3-arm64.zip" 10 || no_ "Download hat nicht begonnen"
  sleep 0.5
  bg_signal "$sig"
  if [ "$sig" = TERM ]; then rc_is 143; else rc_is 129; fi
  eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "$sig: Temp-Ordner weg"; absent "$W/apps/RPCS3.app"; eq "$(leftovers)" "" "$sig: keine Reste"
done

# Ausgangslage für Update-Abbrüche: RPCS3 ist installiert (Merkdatei vorhanden), eine neue Version wartet
upd_world() {
  new_world "$1"; casks_present
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-v1.zip rpcs3-arm64.zip)")"
  route_downloads; start_server
  run --yes --only rpcs3 >/dev/null
  [ "$(tag_of "$W/apps/RPCS3.app")" = rpcs3-arm64 ] || echo "!! Ausgangslage fehlt"
  ROUTES=()
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-2 "$(asset rpcs3-v2.zip rpcs3-new.zip)")"
  route_downloads; write_routes
}

echo "== Strg+C während des Kopierens: Teilkopie weg, alte Version bleibt =="
upd_world s3; T_ENV+=("STUB_DITTO_SLEEP=30")
run_bg --update --only rpcs3
wait_for "$W/state/calls.log" "ditto-sleep" 10 && ok_ "Kopieren hat begonnen" || no_ "Kopieren hat nicht begonnen"
find "$W/apps" -maxdepth 1 -name '.RPCS3.app.jellystation-new.*' | grep -q . && ok_ "Zwischenordner existiert währenddessen" || no_ "kein Zwischenordner"
bg_signal INT
rc_is 130; eq "$(leftovers)" "" "Zwischenordner entfernt"; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version unverändert"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner weg"
exists "$W/apps/RPCS3.app/Contents/MacOS/rpcs3" "alte App vollständig"

echo "== Strg+C zwischen Wegräumen der alten und Einsetzen der neuen App: alte kommt zurück =="
upd_world s4; T_ENV+=("STUB_MV_SLEEP_NEW=30")
run_bg --update --only rpcs3
wait_for "$W/state/calls.log" "mv-sleep" 10 && ok_ "Umbenennen hat begonnen" || no_ "Umbenennen hat nicht begonnen"
find "$W/apps" -maxdepth 1 -name '.RPCS3.app.jellystation-old.*' | grep -q . && ok_ "alte Version liegt währenddessen beiseite" || no_ "alte Version nicht beiseite gelegt"
absent "$W/apps/RPCS3.app" "währenddessen fehlt die App am Zielort"
bg_signal INT
rc_is 130; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version zurückbenannt"; eq "$(leftovers)" "" "keine Reste (weder .new noch .old)"

echo "== Strg+C bei eingehängtem Disk-Image: wird ausgeworfen =="
new_world s5; casks_present
route_downloads; start_server; rpcs3_url rpcs3.dmg; T_ENV+=("STUB_DITTO_SLEEP=30")
run_bg --yes --only rpcs3
wait_for "$W/state/calls.log" "ditto-sleep" 10 && ok_ "Kopieren aus dem Image hat begonnen" || no_ "Kopieren hat nicht begonnen"
eq "$(mounts_open)" "1" "Image ist währenddessen eingehängt"
bg_signal INT
rc_is 130; eq "$(mounts_open)" "0" "Image ausgeworfen"; file_has "$W/state/calls.log" "hdiutil detach" "detach aufgerufen"
eq "$(leftovers)" "" "keine Reste"; absent "$W/apps/RPCS3.app"; eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner weg"

echo "== Strg+C bei eingehängtem Image und hängendem detach: -force versucht =="
new_world s6; casks_present
route_downloads; start_server; rpcs3_url rpcs3.dmg; T_ENV+=("STUB_DITTO_SLEEP=30" "STUB_HDIUTIL_FAIL=detach")
run_bg --yes --only rpcs3
wait_for "$W/state/calls.log" "ditto-sleep" 10 || no_ "Kopieren hat nicht begonnen"
bg_signal INT
rc_is 130; eq "$(mounts_open)" "0" "mit -force ausgeworfen"; file_has "$W/state/calls.log" "force=1" "zweiter Versuch mit -force"

finish
