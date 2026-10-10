#!/usr/bin/env bash
# Terminal-Verhalten: Rückfrage [J/n] nur bei echtem Terminal, Fortschrittsbalken, Farben, Strg+C an der Rückfrage.
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt
. "$(dirname "$0")/lib.sh"

if ! command -v python3 >/dev/null 2>&1; then
  echo "== übersprungen: python3 fehlt (wird nur für ein Pseudo-Terminal gebraucht) =="
  echo "ERGEBNIS (t_tty.sh, $BASHBIN): 0 bestanden, 0 fehlgeschlagen (übersprungen)"
  exit 0
fi

PROMPT="Fehlende Emulatoren jetzt installieren: RPCS3, DuckStation, PCSX2, PPSSPP, Dolphin? [J/n]"
tty_world() { new_world "$1"; std_routes; start_server; ds_override; T_ENV+=("TERM=xterm-256color"); }

echo "== Rückfrage: Nein =="
tty_world y1
run_tty "[J/n]" "n\n"
rc_is 0; has "$PROMPT"; has "Übersprungen"
eq "$(find "$W/apps" -mindepth 1 | wc -l | tr -d ' ')" "0" "nichts installiert"; eq "$(n_requests GET)" "0" "nichts geladen"
exists "$W/home/JellyStation/Games/PS2" "Ordner werden trotzdem angelegt"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "kein Temp-Ordner angelegt"
echo "== Rückfrage: Enter = Ja =="
tty_world y2
run_tty "[J/n]" "\n"
rc_is 0; has "$PROMPT"; has "Fertig: 5 von 5 Emulatoren sind installiert."
file_has "$W/state/curl.log" "--progress-bar" "mit Terminal: Fortschrittsbalken"
echo "== Rückfrage: j / Ja / N =="
tty_world y3; run_tty "[J/n]" "j\n"; has "Fertig: 5 von 5"
tty_world y4; run_tty "[J/n]" "Ja\n"; has "Fertig: 5 von 5"
tty_world y5; run_tty "[J/n]" "N\n"; has "Übersprungen"; eq "$(find "$W/apps" -mindepth 1 | wc -l | tr -d ' ')" "0" "N = Nein"
tty_world y6; run_tty "[J/n]" "quatsch\n"; has "Übersprungen"
echo "== --yes: keine Rückfrage =="
tty_world y7
run_tty "" "" --yes
rc_is 0; hasnt "[J/n]"; has "Fertig: 5 von 5"
echo "== nichts fehlt: keine Rückfrage; --check: keine Rückfrage =="
tty_world y8
run_tty "" "" --yes >/dev/null
run_tty "" ""; rc_is 0; hasnt "[J/n]"; has "Nichts zu tun"
tty_world y9; run_tty "" "" --check; rc_is 1; hasnt "[J/n]"; has "Es fehlen 5 von 5"
echo "== Farben: mit Terminal ja, mit NO_COLOR nein =="
tty_world y10; run_tty "" "" --yes --only rpcs3
printf '%s' "$OUT" | grep -q $'\033\\[' && ok_ "mit Terminal: Farben" || no_ "keine Farben im Terminal"
tty_world y11; T_ENV+=("NO_COLOR=1"); run_tty "" "" --yes --only rpcs3
printf '%s' "$OUT" | grep -q $'\033\\[' && no_ "NO_COLOR ignoriert" || ok_ "NO_COLOR: keine Farben"
tty_world y12; run --yes --only rpcs3
printf '%s' "$OUT" | grep -q $'\033\\[' && no_ "Farben in einer Datei" || ok_ "ohne Terminal: keine Farben"
file_hasnt "$W/state/curl.log" "--progress-bar" "ohne Terminal: kein Fortschrittsbalken"
file_has "$W/state/curl.log" "-sS" "ohne Terminal: leise"

echo "== nur stdout ist ein Terminal (stdin = /dev/null) oder nur stdin: nicht fragen, sondern Ja =="
tty_world y13
run_tty_sh '"$@" < /dev/null'
rc_is 0; hasnt "[J/n]"; has "Fertig: 5 von 5"
tty_world y14
run_tty_sh '"$@" | cat'
rc_is 0; hasnt "[J/n]"; has "Fertig: 5 von 5"

echo "== Strg+C an der Rückfrage =="
tty_world y15
run_tty "[J/n]" "\x03"
rc_is 130; has "Abgebrochen"; eq "$(find "$W/apps" -mindepth 1 | wc -l | tr -d ' ')" "0" "nichts installiert"
eq "$(ls -A "$W/tmp" | wc -l | tr -d ' ')" "0" "kein Temp-Ordner"

finish
