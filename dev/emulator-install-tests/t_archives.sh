#!/usr/bin/env bash
# Archive: abgebrochene/defekte Downloads, dmg, 7z, tar, Namen der App, Rückbenennen bei Fehlern, Quarantäne.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

# Ein RPCS3-Archiv aus $FIX über die eigene Adresse installieren: arch_run <Datei> [weitere Optionen]
arch_run() { local f="$1"; shift; rpcs3_url "$f"; run --yes --only rpcs3 "$@"; }
fresh() { new_world "$1"; casks_present; route_downloads; }

echo "== Download bricht mitten drin ab (Content-Length größer als geliefert) =="
fresh a1
route_file "GET /dl/rpcs3-arm64.zip" "$FIX/rpcs3-arm64.zip" '"truncateAt": 50000'
start_server; arch_run rpcs3-arm64.zip
rc_is 0; has "RPCS3 wurde nicht installiert: Download fehlgeschlagen: der Download wurde unterbrochen und ist unvollständig"
absent "$W/apps/RPCS3.app"; eq "$(leftovers)" "" "keine Reste im Programme-Ordner"; eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"
has "RPCS3 → https://rpcs3.net/download"

echo "== Vollständig geladen, aber das ZIP ist abgeschnitten/defekt =="
fresh a2; start_server; arch_run rpcs3-bad.zip
rc_is 0; has "Das ZIP-Archiv ließ sich nicht entpacken (unvollständig oder beschädigt)"; absent "$W/apps/RPCS3.app"
eq "$(leftovers)" "" "keine Reste"; eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"

echo "== ZIP ohne App / mit falschem App-Namen / mit Versionssuffix / __MACOSX + Unterordner =="
fresh a3; start_server; arch_run rpcs3-noapp.zip
has "Im Download wurde keine App (.app) gefunden"; absent "$W/apps/RPCS3.app"
fresh a4; start_server; arch_run rpcs3-wrongname.zip
has "Das Archiv enthält 'Foo.app' – weder der Name noch die Bundle-ID passen zu RPCS3"; absent "$W/apps/Foo.app"; absent "$W/apps/RPCS3.app"
fresh a5; start_server; arch_run rpcs3-versioned-name.zip
rc_is 0; exists "$W/apps/RPCS3.app" "als RPCS3.app installiert"; absent "$W/apps/RPCS3-v0.0.34.app"; has "App-Name im Archiv: RPCS3-v0.0.34.app → installiert als RPCS3.app"
fresh a5b; start_server; arch_run rpcs3-bundleid.zip
rc_is 0; exists "$W/apps/RPCS3.app" "unbekannter Dateiname, aber richtige Bundle-ID → als RPCS3.app installiert"; absent "$W/apps/Seltsamer-Name.app"
fresh a5c; start_server; arch_run rpcs3-two-apps.zip
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "main" "der Emulator, nicht Updater/Deinstallierer/Helfer"
eq "$(apps_list)" "Dolphin.app PCSX2.app PPSSPP.app RPCS3.app " "nur eine App installiert"
fresh a6; start_server; arch_run rpcs3-macosx.zip
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-macosx" "echtes Paket statt __MACOSX-Eintrag, auch aus einem Unterordner"

echo "== dmg: einhängen, kopieren, IMMER auswerfen =="
fresh d1; start_server; arch_run rpcs3.dmg
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-dmg" "App aus dem Image"
file_has "$W/state/calls.log" "hdiutil attach rpcs3.dmg $W/tmp/" "attach mit Einhängepunkt im Temp-Ordner"
eq "$(count_in "$W/state/calls.log" "hdiutil attach")" "1" "ein attach"; eq "$(count_in "$W/state/calls.log" "hdiutil detach")" "1" "ein detach"
eq "$(mounts_open)" "0" "nichts bleibt eingehängt"; eq "$(leftovers)" "" "keine Reste"; eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"
absent "$W/apps/Applications" "der Link auf /Applications wird nicht mitkopiert"
fresh d2; start_server; arch_run rpcs3-noapp.dmg
has "Im Disk-Image wurde keine App gefunden"; eq "$(mounts_open)" "0" "auch ohne App: ausgeworfen"; eq "$(count_in "$W/state/calls.log" "hdiutil detach")" "1" "detach trotz Fehler"
fresh d3; start_server; T_ENV+=("STUB_HDIUTIL_FAIL=attach"); arch_run rpcs3.dmg
has "Das Disk-Image (.dmg) ließ sich nicht öffnen"; absent "$W/apps/RPCS3.app"; eq "$(count_in "$W/state/calls.log" "hdiutil detach")" "0" "nichts auszuwerfen"
fresh d4; start_server; T_ENV+=("STUB_HDIUTIL_FAIL=detach"); arch_run rpcs3.dmg
rc_is 0; exists "$W/apps/RPCS3.app"; file_has "$W/state/calls.log" "hdiutil detach $W/tmp/" "erster detach"; file_has "$W/state/calls.log" "force=1" "zweiter Versuch mit -force"
echo "-- Kopierfehler bei eingehängtem Image: trotzdem auswerfen --"
fresh d5; start_server; T_ENV+=("STUB_DITTO_FAIL=1"); arch_run rpcs3.dmg
has "Kopieren in den Programme-Ordner fehlgeschlagen"; eq "$(mounts_open)" "0" "ausgeworfen"; eq "$(leftovers)" "" "Teilkopie entfernt"; absent "$W/apps/RPCS3.app"

echo "== tar.xz =="
fresh t1; start_server; arch_run rpcs3.tar.xz
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-tarxz" "aus tar.xz"

echo "== 7z =="
fresh z1; start_server; link_stubs 7zz; arch_run rpcs3-fake7z.7z
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-7z" "mit vorhandenem 7zz"; file_has "$W/state/calls.log" "7zz x -y -o" "7zz aufgerufen"
fresh z2; start_server; arch_run rpcs3.7z    # kein 7zz, aber tar kann es lesen (wie das macOS-tar mit 7z)
rc_is 0; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-7z" "ohne 7-Zip: tar liest das Archiv"; file_hasnt "$W/state/calls.log" "brew install sevenzip" "Homebrew nicht nötig"
fresh z3; start_server; arch_run rpcs3-fake7z.7z    # kein 7zz, tar kann nicht → Homebrew: sevenzip
rc_is 0; has "installiere es mit Homebrew (brew install sevenzip)"; file_has "$W/state/calls.log" "brew install sevenzip" "brew install sevenzip"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-7z" "danach entpackt"
fresh z4; start_server; unlink_stub brew; arch_run rpcs3-fake7z.7z
rc_is 0; has "Zum Entpacken von .7z-Dateien fehlt ein Programm (Homebrew-Paket 'sevenzip')"; absent "$W/apps/RPCS3.app"; has "bash scripts/setup-mac.sh --install-missing --prepare"
fresh z5; start_server; T_ENV+=("STUB_BREW_FAIL=sevenzip"); arch_run rpcs3-fake7z.7z
has "Zum Entpacken von .7z-Dateien fehlt ein Programm"; absent "$W/apps/RPCS3.app"
fresh z6; start_server; link_stubs 7zz; arch_run rpcs3-opaque.7z
has "Das 7z-Archiv ließ sich nicht entpacken (unvollständig oder beschädigt)"; absent "$W/apps/RPCS3.app"; eq "$(leftovers)" "" "keine Reste"; eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "Temp-Ordner aufgeräumt"

echo "== Quarantäne-Merkmal: Fehler sind egal =="
fresh q1; start_server; T_ENV+=("STUB_XATTR_FAIL=1"); arch_run rpcs3-arm64.zip
rc_is 0; exists "$W/apps/RPCS3.app" "trotz xattr-Fehler installiert"; has "RPCS3 installiert"

echo "== Kopieren scheitert: nichts halb installiert =="
fresh c1; start_server; T_ENV+=("STUB_DITTO_FAIL=1"); arch_run rpcs3-arm64.zip
rc_is 0; has "Kopieren in den Programme-Ordner fehlgeschlagen"; absent "$W/apps/RPCS3.app"; eq "$(leftovers)" "" "Teilkopie entfernt"

echo "== Alte Version ersetzen: bei Fehlern zurückbenennen =="
# Ausgangslage: RPCS3 über das Skript installiert (Merkdatei vorhanden), später kommt eine neue Version
upd_world() {
  fresh "$1"
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-1 "$(asset rpcs3-v1-arm64.zip rpcs3-arm64.zip)")"
  start_server
  run --yes --only rpcs3 >/dev/null; [ "$(tag_of "$W/apps/RPCS3.app")" = rpcs3-arm64 ] || echo "!! Ausgangslage fehlt"
  # neue Version veröffentlichen
  ROUTES=(); casks_present_routes
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" "$(release build-2 "$(asset rpcs3-v2-arm64.zip rpcs3-new.zip)")"
  route_downloads; write_routes
}
casks_present_routes() { :; }
upd_world u1; T_ENV+=("STUB_DITTO_FAIL=1")
run --update --only rpcs3
rc_is 0; has "RPCS3 konnte nicht aktualisiert werden: Kopieren in den Programme-Ordner fehlgeschlagen"; has "Die vorhandene Version bleibt erhalten"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version unverändert"; eq "$(leftovers)" "" "keine Reste"
has "RPCS3 (Update): RPCS3 →"
upd_world u2; T_ENV+=("STUB_MV_FAIL_NEW=1")
run --update --only rpcs3
rc_is 0; has "Die neue App ließ sich nicht an ihren Platz bringen"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version zurückbenannt"; eq "$(leftovers)" "" "keine Reste (weder .new noch .old)"
upd_world u2b; T_ENV+=("STUB_MV_FAIL_OLD=1")
run --update --only rpcs3
rc_is 0; has "Die vorhandene App ließ sich nicht ersetzen"; has "App-Verwaltung"
eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-arm64" "alte Version unverändert"; eq "$(leftovers)" "" "keine Reste (Zwischenordner entfernt)"
upd_world u3
run --update --only rpcs3
rc_is 0; has "RPCS3 aktualisiert"; eq "$(tag_of "$W/apps/RPCS3.app")" "rpcs3-new" "neue Version"; eq "$(leftovers)" "" "keine Reste"
eq "$(apps_list)" "Dolphin.app PCSX2.app PPSSPP.app RPCS3.app " "genau diese Apps"

finish
