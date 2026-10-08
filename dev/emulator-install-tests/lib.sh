#!/usr/bin/env bash
# Gemeinsame Hilfen für die Installationstests (wird von den t_*.sh-Dateien eingebunden).
#
# Jeder Test baut sich eine eigene "Welt" unter $SCRATCH/w/<Name>:
#   home/ apps/ uapps/ tmp/  Benutzerordner, Programme-Ordner, Ausweichordner, TMPDIR
#   bin/                      Attrappen für macOS-Befehle (Symlinks auf stubs/) – steht im PATH ganz vorn
#   state/                    Protokolle der Attrappen (calls.log, Mounts, Homebrew-Casks)
#   srv/                      routes.json, requests.log und Downloads des Mock-Servers
# Umgebungsvariablen:
#   EMU_TEST_DIR   Arbeitsordner für die Welten (Standard: $TMPDIR/jellystation-emu-tests)
#   BASHBIN        Interpreter für die Skripte unter Test (Standard: bash; z. B. eine echte Bash 3.2)
#   NODE_BIN_DIR   Ordner mit node (Standard: wird aus dem PATH ermittelt)
# shellcheck disable=SC1091,SC2034,SC2012,SC2119,SC2120,SC2088,SC2002,SC2016,SC2015,SC2010  # Testhilfen: Variablen werden dateiübergreifend genutzt

T_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -P "$T_ROOT/../.." && pwd)"
INSTALLER="$REPO_DIR/scripts/install-emulators.sh"
SCRATCH="${EMU_TEST_DIR:-${TMPDIR:-/tmp}/jellystation-emu-tests}"
BASHBIN="${BASHBIN:-bash}"
BASE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
NODE_BIN_DIR="${NODE_BIN_DIR:-$(dirname "$(command -v node)")}"
case ":$BASE_PATH:" in *":$NODE_BIN_DIR:"*) ;; *) BASE_PATH="$BASE_PATH:$NODE_BIN_DIR" ;; esac
FIX="$SCRATCH/fix"
PASS=0
FAIL=0
SERVER_PID=""
PORT=""

mkdir -p "$SCRATCH"
[ -f "$FIX/rpcs3-arm64.zip" ] || bash "$T_ROOT/make-fixtures.sh" "$FIX" >/dev/null

# ------------------------------------------------------------------ Prüfungen ----

ok_() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
no_() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
show_out() { printf '%s\n' "$OUT" | sed 's/^/        | /' | head -n "${1:-60}"; }
has()   { if printf '%s' "$OUT" | grep -qF -- "$1"; then ok_ "Ausgabe enthält: $1"; else no_ "Ausgabe enthält NICHT: $1"; show_out; fi; }
hasnt() { if printf '%s' "$OUT" | grep -qF -- "$1"; then no_ "Ausgabe enthält (unerwartet): $1"; show_out; else ok_ "Ausgabe enthält nicht: $1"; fi; }
eq()    { if [ "$1" = "$2" ]; then ok_ "$3"; else no_ "$3 (ist '$1', erwartet '$2')"; fi; }
rc_is() { eq "$RC" "$1" "Exit-Code $1"; }
exists() { if [ -e "$1" ]; then ok_ "vorhanden: ${2:-$1}"; else no_ "fehlt: ${2:-$1}"; fi; }
absent() { if [ ! -e "$1" ]; then ok_ "nicht vorhanden: ${2:-$1}"; else no_ "unerwartet vorhanden: ${2:-$1}"; fi; }
file_has() { if grep -qF -- "$2" "$1" 2>/dev/null; then ok_ "${3:-$1 enthält: $2}"; else no_ "${3:-$1 enthält NICHT: $2}"; fi; }
file_hasnt() { if grep -qF -- "$2" "$1" 2>/dev/null; then no_ "${3:-$1 enthält (unerwartet): $2}"; else ok_ "${3:-$1 enthält nicht: $2}"; fi; }
count_in() { grep -cF -- "$2" "$1" 2>/dev/null || true; }   # Anzahl Zeilen mit Text
snapshot() { ( cd "$1" && find . -printf '%p %y %s %T@\n' 2>/dev/null | sort | sha256sum | awk '{print $1}' ); }
tag_of() { cat "$1/Contents/Resources/tag.txt" 2>/dev/null | tr -d '\n'; }

finish() {
  stop_server
  echo
  echo "ERGEBNIS ($(basename "$0"), $BASHBIN): $PASS bestanden, $FAIL fehlgeschlagen"
  [ "$FAIL" -eq 0 ]
}

# --------------------------------------------------------------------- Welt ----

T_ENV=()   # zusätzliche Umgebungsvariablen "NAME=Wert" für den nächsten Lauf
ARM=1      # 1 = Apple Silicon (sysctl hw.optional.arm64 = 1)

# link_stubs [Namen…] – Attrappen in den PATH legen (ohne Namen: alle)
link_stubs() {
  local f n
  if [ $# -eq 0 ]; then
    for f in "$T_ROOT"/stubs/*; do ln -sf "$f" "$W/bin/$(basename "$f")"; done
    rm -f "$W/bin/7zz"   # 7-Zip ist standardmäßig NICHT installiert
  else
    for n in "$@"; do ln -sf "$T_ROOT/stubs/$n" "$W/bin/$n"; done
  fi
}
unlink_stub() { rm -f "$W/bin/$1"; }

new_world() {   # $1 = Name
  stop_server
  W="$SCRATCH/w/$1"
  rm -rf "$W"
  mkdir -p "$W/home" "$W/apps" "$W/tmp" "$W/bin" "$W/state" "$W/srv"
  : > "$W/state/calls.log"
  : > "$W/srv/requests.log"
  T_ENV=()
  ARM=1
  RO_DIRS=""
  MASK_DIRS=""
  MASK_LINKS=""
  ROUTES=()
  HOME_W="$W/home"
  case "$BASHBIN" in /*) ln -sf "$BASHBIN" "$W/bin/bash" ;; esac
  link_stubs
}

# make_cmd [Optionen für den Installer] – baut den Aufruf (BASHBIN, PATH mit Attrappen, saubere Umgebung) in CMD[]
# RO_DIRS   (Ordner, einer pro Zeile): werden in einem eigenen Mount-Namespace schreibgeschützt eingehängt
# MASK_DIRS (Ordner, einer pro Zeile): werden dort mit einem leeren tmpfs überdeckt (damit z. B. /usr/local/bin des Test-
#           rechners nicht vor den Attrappen im PATH landet – jellystation.sh stellt /usr/local/bin bewusst voran)
RO_DIRS=""
MASK_DIRS=""
MASK_LINKS=""   # Zeilen "Pfad=Ziel": nach dem Überdecken werden diese Links angelegt (z. B. /usr/local/bin/node=/opt/node/bin/node)
CMD=()
SUT=""   # anderes Skript unter Test (Standard: der Installer)
make_cmd() {
  CMD=(env -i
      HOME="$HOME_W" PATH="$W/bin:$BASE_PATH" TERM=dumb LANG=C.UTF-8 TMPDIR="$W/tmp"
      STUB_STATE="$W/state" STUB_BIN="$W/bin" STUB_ARM="$ARM"
      JELLYSTATION_APPS_DIR="$W/apps" JELLYSTATION_USER_APPS_DIR="$W/uapps" JELLYSTATION_TEST=1
      ${SERVER_URL:+JELLYSTATION_GITHUB_API="$SERVER_URL"}
      ${T_ENV[@]+"${T_ENV[@]}"}
      "$BASHBIN" "${SUT:-$INSTALLER}" "$@")
  if [ -n "$RO_DIRS" ] || [ -n "$MASK_DIRS" ]; then
    CMD=(unshare -m bash -c 'ro="$1"; mask="$2"; links="$3"; shift 3
      while IFS= read -r d; do [ -n "$d" ] || continue; mount -t tmpfs tmpfs "$d" || exit 99; done <<< "$mask"
      while IFS= read -r l; do [ -n "$l" ] || continue; ln -s "${l#*=}" "${l%%=*}" || exit 99; done <<< "$links"
      while IFS= read -r d; do [ -n "$d" ] || continue; mount --bind "$d" "$d" && mount -o remount,ro,bind "$d" || exit 99; done <<< "$ro"
      exec "$@"' x "$RO_DIRS" "$MASK_DIRS" "$MASK_LINKS" "${CMD[@]}")
  fi
}

# run [Optionen] – führt den Installer aus. Ergebnis: RC (Exit-Code), OUT (Ausgabe), $W/out.txt
run() {
  RC=0
  make_cmd "$@"
  ( cd "$W" && "${CMD[@]}" ) > "$W/out.txt" 2>&1 < /dev/null || RC=$?
  OUT="$(cat "$W/out.txt")"
}

# run_bg [Optionen] – wie run, aber im Hintergrund (eigene Prozessgruppe, setzt BG_PID; braucht "set -m")
BG_PID=""
run_bg() {
  make_cmd "$@"
  ( cd "$W" && exec "${CMD[@]}" ) > "$W/out.txt" 2>&1 < /dev/null &
  BG_PID=$!
}
# wait_for <Datei> <Text> [Sekunden] – wartet, bis der Text in der Datei steht
wait_for() {
  local n=0 max=$(( ${3:-10} * 10 ))
  while ! grep -qF -- "$2" "$1" 2>/dev/null; do
    n=$((n + 1)); [ "$n" -lt "$max" ] || return 1
    sleep 0.1
  done
}
# bg_signal <SIGNAL> – Signal an die ganze Prozessgruppe (wie Strg+C im Terminal); danach auf das Ende warten
bg_signal() {
  kill "-$1" -- "-$BG_PID" 2>/dev/null || true
  RC=0
  wait "$BG_PID" 2>/dev/null || RC=$?
  OUT="$(cat "$W/out.txt")"
}

# --------------------------------------------------------------- Mock-Server ----

SERVER_URL=""
ROUTES=()

# route "GET /pfad" '<Antwortobjekt als JSON>' – Antwort vormerken (mit write_routes festschreiben)
route() { ROUTES+=("\"$1\": $2"); }
route_json() { route "$1" "{\"status\": ${3:-200}, \"json\": $2}"; }
route_file() { route "$1" "{\"file\": \"$2\"${3:+, $3}}"; }
route_status() { local body="${3:-}"; [ -n "$body" ] || body='{"message": "Fehler"}'; route "$1" "{\"status\": $2, \"json\": $body}"; }

write_routes() {
  local IFS=,
  printf '{%s}\n' "${ROUTES[*]-}" > "$W/srv/routes.json"
}

# asset <Name> <Datei in $FIX> [auto|none|bad] – Asset-Objekt der GitHub-API (Download unter /dl/<Datei>)
asset() {
  local name="$1" file="$2" dig="${3:-auto}" size sha d=""
  size="$(wc -c < "$FIX/$file")"
  sha="$(sha256sum "$FIX/$file" | cut -d' ' -f1)"
  case "$dig" in
    auto) d="\"digest\": \"sha256:$sha\"," ;;
    bad) d="\"digest\": \"sha256:$(printf '0%.0s' $(seq 64))\"," ;;
    wrongsize) d="\"digest\": \"sha256:$sha\","; size=$((size + 1000)) ;;
  esac
  printf '{"name": "%s", "state": "uploaded", "size": %s, %s "browser_download_url": "{{BASE}}/dl/%s"}' "$name" "$size" "$d" "$file"
}

# release <Tag> <Asset-Objekt>… – Release-Objekt
release() {
  local tag="$1" a list=""
  shift
  for a in "$@"; do list="${list:+$list,}$a"; done
  printf '{"tag_name": "%s", "draft": false, "prerelease": false, "assets": [%s]}' "$tag" "$list"
}

# Standard-Downloads (alle Dateien aus $FIX unter /dl/<Name>) bereitstellen
route_downloads() {
  local f n
  for f in "$FIX"/*; do
    n="$(basename "$f")"
    case "${ROUTES[*]-}" in *"\"GET /dl/$n\""*) continue ;; esac   # schon eigens festgelegt (z. B. 404)
    route_file "GET /dl/$n" "$f"
  done
}

start_server() {
  stop_server
  write_routes
  local p try=0
  for p in $(seq 18200 18299); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
  done
  [ -n "$PORT" ] || { echo "kein freier Port 18200–18299" >&2; return 1; }
  : > "$W/srv/requests.log"
  node "$T_ROOT/mock-github.mjs" "$PORT" "$W/srv/routes.json" "$W/srv/requests.log" >/dev/null 2>&1 &
  SERVER_PID=$!
  while ! grep -q '^listening' "$W/srv/requests.log" 2>/dev/null; do
    try=$((try + 1)); [ "$try" -lt 100 ] || { echo "Mock-Server startet nicht" >&2; return 1; }
    sleep 0.1
  done
  SERVER_URL="http://127.0.0.1:$PORT"
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
  SERVER_URL=""
  PORT=""
}

requests() { grep -v '^listening' "$W/srv/requests.log" 2>/dev/null || true; }
n_requests() { requests | grep -cF -- "$1" || true; }

# Standard-Routen: RPCS3 (arm64- und x64-Repo) mit je einem passenden Archiv, DuckStation-Direktlink
std_routes() {
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac-arm64/releases/latest" \
    "$(release build-arm "$(asset rpcs3-v0.0.34-1_macos_arm64.zip rpcs3-arm64.zip)" "$(asset rpcs3-v0.0.34-1_macos_arm64.zip.sha256 dummy.txt)")"
  route_json "GET /repos/RPCS3/rpcs3-binaries-mac/releases/latest" \
    "$(release build-x64 "$(asset rpcs3-v0.0.34-1_macos_x64.zip rpcs3-x64.zip)")"
  route_downloads
}

# DuckStation-Direktlink auf den Mock-Server umbiegen (nach start_server aufrufen)
ds_override() { T_ENV+=("JELLYSTATION_URL_DUCKSTATION=$SERVER_URL/dl/${1:-duckstation-mac-release.zip}"); }

# Alles, was im Programme-Ordner liegt (inkl. versteckter Reste), als Liste – zum Prüfen auf Reste
apps_list() { ls -A "${1:-$W/apps}" 2>/dev/null | tr '\n' ' '; }

# RPCS3-Download auf eine Datei des Mock-Servers legen (nach start_server aufrufen)
rpcs3_url() { T_ENV+=("JELLYSTATION_URL_RPCS3=$SERVER_URL/dl/$1"); }
mkapp() { mkdir -p "$1/Contents/MacOS"; printf '<key>CFBundleShortVersionString</key><string>%s</string>\n' "${2:-1}" > "$1/Contents/Info.plist"; [ -z "${3:-}" ] || { mkdir -p "$1/Contents/Resources"; echo "$3" > "$1/Contents/Resources/tag.txt"; }; }
casks_present() { mkapp "$W/apps/PCSX2.app" 1; mkapp "$W/apps/PPSSPP.app" 1; mkapp "$W/apps/Dolphin.app" 1; }
leftovers() { find "$W/apps" "$W/uapps" -name '.*jellystation*' 2>/dev/null | tr '\n' ' '; }
mounts_open() { ls -A "$W/state/mounted" 2>/dev/null | wc -l | tr -d ' '; }

# run_tty [--expect T --send S]… -- [Optionen] – wie run, aber in einem Pseudo-Terminal (TTY) mit Antworten auf Rückfragen
# Aufruf:  run_tty "<expect>" "<send>" [Optionen…]   (ohne Antwort: run_tty "" "" …)
run_tty() {
  local ex="$1" sd="$2"; shift 2
  RC=0
  make_cmd "$@"
  local pa=()
  [ -z "$ex" ] || pa=(--expect "$ex" --send "$sd")
  ( cd "$W" && python3 "$T_ROOT/pty_run.py" ${pa[@]+"${pa[@]}"} --timeout 60 -- "${CMD[@]}" ) > "$W/out.txt" 2>&1 < /dev/null || RC=$?
  OUT="$(cat "$W/out.txt")"
}
# run_tty_sh '<Shell-Befehl mit "$@" für den Installer>' [Optionen] – wie run_tty, aber mit einem Shell-Umweg (z. B. stdin = /dev/null)
run_tty_sh() {
  local wrapper="$1"; shift
  RC=0
  make_cmd "$@"
  ( cd "$W" && python3 "$T_ROOT/pty_run.py" --timeout 60 -- bash -c "$wrapper" x "${CMD[@]}" ) > "$W/out.txt" 2>&1 < /dev/null || RC=$?
  OUT="$(cat "$W/out.txt")"
}

# ----------------------------------------------------- Welt mit Git-Ordner ----
# int_world <Name> – wie new_world, plus: Projektordner $W/home/JellyStation (Git-Klon eines lokalen Ursprungs mit den
# Skripten und der Datendatei aus diesem Repo), npm-Attrappe, JELLYSTATION_REMOTE_URL auf den lokalen Ursprung.
BR="claude/serene-ride-x8ll06"
gi() { GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@t git "$@"; }
int_world() {
  new_world "$1"
  ORIGIN="$W/origin.git"; PROJ="$W/home/JellyStation"; SEED="$W/seed"
  mkdir -p "$SEED/scripts" "$SEED/src/emulators" "$SEED/src-tauri"
  cp "$REPO_DIR"/scripts/*.sh "$SEED/scripts/"
  cp "$REPO_DIR/src/emulators/emulators.json" "$SEED/src/emulators/"
  cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$REPO_DIR/.gitignore" "$SEED/"
  cp "$REPO_DIR/src-tauri/Cargo.lock" "$SEED/src-tauri/"
  git init -q --bare -b "$BR" "$ORIGIN"
  ( cd "$SEED" && git init -q -b "$BR" && gi add -A && gi commit -q -m "Startstand" && git remote add origin "file://$ORIGIN" && git push -q origin "$BR" 2>/dev/null )
  git clone -q --branch "$BR" "file://$ORIGIN" "$PROJ" 2>/dev/null
  cat > "$W/bin/npm" <<NPM
#!/usr/bin/env bash
echo "npm \$*  (cwd=\$PWD)" >> "$W/npm.log"
if [ "\${1:-}" = -v ]; then echo 10.0.0; exit 0; fi
if [ "\$1" = ci ] || [ "\$1" = install ]; then mkdir -p node_modules; fi
if [ "\$*" = "run tauri build" ]; then mkdir -p src-tauri/target/release/bundle/macos/JellyStation.app; fi
exit 0
NPM
  chmod +x "$W/bin/npm"
  printf '#!/bin/sh\necho "cargo $*" >> "%s/npm.log"\n' "$W" > "$W/bin/cargo"; chmod +x "$W/bin/cargo"
  printf '#!/bin/sh\necho "rustc 1.80.0 (Attrappe)"\n' > "$W/bin/rustc"; chmod +x "$W/bin/rustc"
  if unshare -m true 2>/dev/null; then MASK_DIRS="/usr/local/bin
/usr/local/sbin"; fi
  : > "$W/npm.log"
  T_ENV+=("JELLYSTATION_REMOTE_URL=file://$ORIGIN")
}
# origin_commit <Datei> <Inhalt> – neuer Commit im lokalen Ursprung
origin_commit() {
  ( cd "$SEED" && mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" > "$1" && gi add -A && gi commit -q -m "Neu: $1" && git push -q origin "$BR" 2>/dev/null )
}
# jellystation / setup / bootstrap ausführen (SUT = Skript im Projektordner)
runj() { SUT="$PROJ/scripts/jellystation.sh"; run "$@"; SUT=""; }
runs() { SUT="$PROJ/scripts/setup-mac.sh"; run "$@"; SUT=""; }
runb() { SUT="$PROJ/scripts/bootstrap.sh"; run "$@"; SUT=""; }
# set_marker <Sekunden vor jetzt> <ok|offen> <fehlende IDs>
set_marker() {
  mkdir -p "$HOME_W/.jellystation"
  printf 'time=%s\nresult=%s\nmissing=%s\n' "$(( $(date +%s) - $1 ))" "$2" "$3" > "$HOME_W/.jellystation/emulators.check"
}
