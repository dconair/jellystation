#!/usr/bin/env bash
# JellyStation – richtet den Befehl "jellystation" im Terminal ein.
#
#   bash scripts/install-launcher.sh
#
# Das Skript trägt einen kleinen, klar markierten Block in ~/.zshrc ein (und in ~/.bash_profile,
# falls bash deine Standard-Shell ist). Er definiert die Funktion "jellystation", die dieses
# Repo-Verzeichnis kennt und scripts/jellystation.sh startet. Mehrfaches Ausführen ist unbedenklich:
# der Block wird ersetzt, nie verdoppelt. Alles außerhalb der Markierungen bleibt unangetastet.
# Wird der Ordner später verschoben, dieses Skript am neuen Ort einfach noch einmal ausführen.
set -euo pipefail

BEGIN_MARK="# >>> jellystation >>>"
END_MARK="# <<< jellystation <<<"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$SCRIPT_DIR/jellystation.sh"

C_RESET="" C_BOLD="" C_GREEN="" C_YELLOW="" E_RED="" E_RESET=""
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  if [ -t 1 ]; then C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'; fi
  if [ -t 2 ]; then E_RED=$'\033[31m' E_RESET=$'\033[0m'; fi
fi
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '  %s✕ %s%s\n' "$E_RED" "$*" "$E_RESET" >&2; exit 1; }

[ -f "$LAUNCHER" ] || die "scripts/jellystation.sh wurde neben diesem Skript nicht gefunden ($LAUNCHER)."

# Pfad sicher in einfache Anführungszeichen setzen (gilt für zsh und bash gleichermaßen).
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

block_text() {
  printf '%s\n' "$BEGIN_MARK"
  cat <<'BLOCK_HEAD'
# Von scripts/install-launcher.sh angelegt. Bei Änderungen dort erneut ausführen.
jellystation() {
BLOCK_HEAD
  printf '  local script=%s\n' "$(shell_quote "$LAUNCHER")"
  cat <<'BLOCK_TAIL'
  if [ ! -f "$script" ]; then
    echo "JellyStation: Startskript nicht gefunden: $script" >&2
    echo "  Wurde der Ordner verschoben? Dann am neuen Ort 'bash scripts/install-launcher.sh' erneut ausführen." >&2
    return 1
  fi
  bash "$script" "$@"
}
BLOCK_TAIL
  printf '%s\n' "$END_MARK"
}

# Prüft, dass die Markierungen sauber paarweise vorkommen (BEGIN, dann END, nie verschachtelt).
markers_ok() {
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b { if (open) bad = 1; open = 1; next }
    $0 == e { if (!open) bad = 1; open = 0; next }
    END { exit (bad || open) ? 1 : 0 }
  ' "$1"
}

# Schreibt die Datei neu: ein vorhandener Block wird an seiner Stelle ersetzt (weitere Blöcke entfallen),
# fehlt er, wird er am Ende angehängt. Alles außerhalb des Blocks bleibt unverändert.
merge_block() {
  local file="$1" blockfile="$2"
  if [ ! -s "$file" ]; then
    cat "$blockfile"
    return 0
  fi
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v blockfile="$blockfile" '
    BEGIN { while ((getline line < blockfile) > 0) blk = blk line "\n" }
    $0 == b { if (!done) { printf "%s", blk; done = 1 } skip = 1; next }
    $0 == e { skip = 0; next }
    skip { next }
    { print; last = $0 }
    END { if (!done) { if (last != "") print ""; printf "%s", blk } }
  ' "$file"
}

install_into() {
  local file="$1" blockfile tmp state shown
  shown="~${file#"$HOME"}"   # nur zur Anzeige
  if [ -f "$file" ] && ! markers_ok "$file"; then
    die "$shown enthält eine unvollständige oder verschachtelte jellystation-Markierung – bitte die Zeilen '$BEGIN_MARK' und '$END_MARK' prüfen. Es wurde nichts verändert."
  fi

  blockfile="$(mktemp "${TMPDIR:-/tmp}/jellystation-block.XXXXXX")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/jellystation-rc.XXXXXX")"
  block_text > "$blockfile"
  merge_block "$file" "$blockfile" > "$tmp"

  if [ -f "$file" ] && cmp -s "$tmp" "$file"; then
    state="schon eingerichtet (unverändert)"
  else
    if [ -f "$file" ]; then
      # Einmalige Sicherheitskopie der ursprünglichen Datei
      if [ ! -e "$file.jellystation-backup" ]; then cp -p "$file" "$file.jellystation-backup"; fi
      if grep -qxF "$BEGIN_MARK" "$file"; then state="Block aktualisiert"; else state="Block angehängt"; fi
    else
      state="Datei neu angelegt"
    fi
    # "cat >" schreibt auch dann korrekt, wenn die Datei ein Link ist (z. B. auf ein Dotfiles-Repo).
    cat "$tmp" > "$file"
  fi
  rm -f "$tmp" "$blockfile"
  ok "$shown: $state"
}

printf '\n%sBefehl "jellystation" einrichten%s\n' "$C_BOLD" "$C_RESET"

login_shell="$(basename "${SHELL:-}")"
install_into "$HOME/.zshrc"
case "$login_shell" in
  bash) install_into "$HOME/.bash_profile" ;;
  zsh|"") ;;
  *) warn "Deine Standard-Shell ist '$login_shell' – eingerichtet wurden nur zsh (~/.zshrc) und bash. Dort bitte selbst einen Alias auf: bash $(shell_quote "$LAUNCHER")" ;;
esac

cat <<EOF

  Fertig. So benutzt du den Befehl:
    1. Öffne ein neues Terminal-Fenster (oder tippe:  source ~/.zshrc)
    2. Tippe:  jellystation

  Weitere Varianten:  jellystation --web   (nur Browser-Vorschau)
                      jellystation --build (App bauen und öffnen)
                      jellystation --status (Stand anzeigen)
                      jellystation --help
EOF
