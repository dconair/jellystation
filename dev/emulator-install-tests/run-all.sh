#!/usr/bin/env bash
# Führt alle Tests für scripts/install-emulators.sh und seine Einbindung aus – ohne Mac, ohne echtes GitHub:
# macOS-Befehle (uname, sysctl, brew, hdiutil, ditto, xattr, defaults, 7zz …) sind Attrappen aus stubs/,
# GitHub und die Download-Server spielt mock-github.mjs auf 127.0.0.1 (Ports 18200–18299).
#
#   bash dev/emulator-install-tests/run-all.sh              Tests mit dem System-bash
#   BASH32=/pfad/zu/bash-3.2.57/bash bash dev/emulator-install-tests/run-all.sh
#                                                           zusätzlich mit einer echten Bash 3.2 (wie auf dem Mac)
#   EMU_TEST_DIR=/pfad/zum/arbeitsordner                    Arbeitsordner (Standard: $TMPDIR/jellystation-emu-tests)
#   ONLY="t_basic t_github"                                 nur diese Testdateien
#
# Voraussetzungen (gedacht für Linux mit GNU-Werkzeugen, nicht für den Mac): bash, node, git, curl, zip/unzip, tar;
# optional: python3 (Pseudo-Terminal-Tests), shellcheck, unshare/mount als root (Tests mit schreibgeschützten Ordnern).
# legacy/*.alt sind die Fassungen von jellystation.sh und setup-mac.sh vor der Emulator-Einrichtung (Commit 6dac11f):
# Gegenprobe für den Schutz der Spiele-Ordner und für den Hinweis im Bootstrap-Skript bei einem alten Projektordner.
# Am Ende: Exit-Code 0 nur, wenn alle Tests bestanden haben.
set -u
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -P "$HERE/../.." && pwd)"
TESTS="${ONLY:-t_basic t_github t_archives t_update t_dirs t_signals t_tty t_data t_integration}"
bashes="bash"
[ -z "${BASH32:-}" ] || bashes="$bashes $BASH32"

failed=""
total_pass=0
for b in $bashes; do
  echo "################ Interpreter: $b ($("$b" --version | head -n 1)) ################"
  for t in $TESTS; do
    echo "---------------- $t ----------------"
    out="$(BASHBIN="$b" bash "$HERE/$t.sh" 2>&1)"; rc=$?
    printf '%s\n' "$out" | grep -E "^(==|--|  FAIL|ERGEBNIS)" | grep -v "^  PASS" | sed 's/^/  /'
    printf '%s\n' "$out" | grep -A8 "^  FAIL" | grep "^        |" | head -n 12
    n="$(printf '%s\n' "$out" | sed -n 's/^ERGEBNIS .*: \([0-9]*\) bestanden.*/\1/p' | tail -n 1)"
    total_pass=$((total_pass + ${n:-0}))
    if [ "$rc" -ne 0 ]; then failed="$failed $t($b)"; fi
  done
done

echo "---------------- Datenabgleich mit catalog.ts ----------------"
if node "$REPO/dev/check-emulator-data.mjs"; then :; else failed="$failed check-emulator-data"; fi

echo "---------------- shellcheck ----------------"
if command -v shellcheck >/dev/null 2>&1; then
  if LC_ALL=C.UTF-8 shellcheck -x -S style "$REPO"/scripts/*.sh "$HERE"/*.sh "$HERE"/stubs/*; then
    echo "  shellcheck: keine Beanstandungen"
  else
    failed="$failed shellcheck"
  fi
else
  echo "  (shellcheck nicht installiert – übersprungen)"
fi

echo
if [ -z "$failed" ]; then
  echo "ALLES BESTANDEN ($total_pass Prüfungen)"
  exit 0
fi
echo "FEHLGESCHLAGEN:$failed"
exit 1
