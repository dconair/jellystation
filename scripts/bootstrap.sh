#!/usr/bin/env bash
# JellyStation – Ersteinrichtung auf einem frischen Mac mit einem einzigen Befehl.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/dconair/jellystation/main/scripts/bootstrap.sh)"
#
# Das Skript
#   1. prüft macOS und sorgt für git (startet bei Bedarf die Installation der Xcode Command Line Tools),
#   2. lädt JellyStation nach ~/JellyStation (oder aktualisiert den vorhandenen Ordner),
#   3. installiert fehlende Werkzeuge und Pakete und richtet die Emulatoren (RPCS3, DuckStation, PCSX2, PPSSPP, Dolphin)
#      samt Ordnern ~/JellyStation/Games/<System> und ~/JellyStation/BIOS ein (scripts/setup-mac.sh --install-missing --prepare),
#   4. richtet den Befehl "jellystation" ein (scripts/install-launcher.sh).
# Danach genügt in einem neuen Terminal-Fenster:  jellystation
# Es fehlen dann nur noch die Spiele (und BIOS/Firmware): Sie kommen selbst in ~/JellyStation/Games/<System>/.
#
# Bewusst als  bash -c "$(curl …)"  und nicht als  curl … | bash  gedacht: So bleibt die Tastatur des
# Terminals angeschlossen, und Rückfragen (Mac-Passwort, Xcode, Homebrew) funktionieren.
#
# Umgebungsvariablen:
#   JELLYSTATION_DIR          Zielordner (Standard: ~/JellyStation)
#   JELLYSTATION_BRANCH       Branch (Standard: main)
#   JELLYSTATION_REMOTE_URL   GitHub-Adresse (Standard: https://github.com/dconair/jellystation.git)
set -euo pipefail

BRANCH="${JELLYSTATION_BRANCH:-main}"
REMOTE_URL="${JELLYSTATION_REMOTE_URL:-https://github.com/dconair/jellystation.git}"
XCODE_WAIT_SECONDS=1800

C_RESET="" C_BOLD="" C_DIM="" C_GREEN="" C_YELLOW="" C_BLUE="" E_RED="" E_RESET=""
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  if [ -t 1 ]; then
    C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
    C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
  fi
  if [ -t 2 ]; then E_RED=$'\033[31m' E_RESET=$'\033[0m'; fi
fi
say()  { printf '\n%s==> %s%s\n' "$C_BLUE$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
dim()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
err()  { printf '  %s✕ %s%s\n' "$E_RED" "$*" "$E_RESET" >&2; }
die()  { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Nie nach Passwort fragen (würde hängen/verwirren): fehlgeschlagene Anmeldung soll sofort scheitern.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15}"
GIT_NET_OPTS=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30)

private_repo_help() {
  info "Falls das Repository inzwischen privat ist, brauchst du einmalig einen GitHub-Login:"
  info "    brew install gh"
  info "    gh auth login          (GitHub.com, HTTPS, Git-Anmeldung mit Ja bestätigen, Anmeldung im Browser)"
  info "    gh auth setup-git"
  info "Dann den Ordner mit  gh repo clone dconair/jellystation ~/JellyStation -- --branch $BRANCH"
  info "laden und danach  bash ~/JellyStation/scripts/bootstrap.sh  ausführen."
}

# git ist auf einem frischen Mac nur eine Attrappe, bis die Xcode Command Line Tools installiert sind.
ensure_git() {
  if have xcode-select && ! xcode-select -p >/dev/null 2>&1; then
    info "Die Xcode Command Line Tools (enthalten git und den Compiler) fehlen noch."
    info "Es erscheint gleich ein Fenster von macOS – dort auf Installieren klicken und die Lizenz bestätigen."
    xcode-select --install >/dev/null 2>&1 || true
    local waited=0
    until xcode-select -p >/dev/null 2>&1; do
      if [ "$waited" -ge "$XCODE_WAIT_SECONDS" ]; then
        die "Die Installation der Xcode Command Line Tools wurde nicht abgeschlossen. Bitte erneut starten, sobald sie fertig sind."
      fi
      [ $((waited % 60)) -ne 0 ] || [ "$waited" -eq 0 ] || info "… warte auf die Xcode-Installation (Abbrechen mit Strg+C)"
      sleep 5
      waited=$((waited + 5))
    done
    ok "Xcode Command Line Tools installiert"
  fi
  have git || die "git wurde nicht gefunden. Bitte die Xcode Command Line Tools installieren (xcode-select --install) und erneut starten."
  ok "git $(git --version | awk '{ print $3 }')"
}

# Ordner, in dem dieses Skript liegt – nur wenn es aus einem vorhandenen Projektordner gestartet wurde
# (bei  bash -c "$(curl …)"  gibt es keinen Skriptpfad).
own_project_dir() {
  local src="${BASH_SOURCE[0]:-}" dir
  [ -n "$src" ] && [ -f "$src" ] && [ "$(basename "$src")" = "bootstrap.sh" ] || return 1
  dir="$(cd -P "$(dirname "$src")/.." 2>/dev/null && pwd)" || return 1
  [ -f "$dir/package.json" ] && [ -f "$dir/scripts/setup-mac.sh" ] || return 1
  printf '%s' "$dir"
}

is_empty_dir() { [ -d "$1" ] && [ -z "$(ls -A "$1" 2>/dev/null || true)" ]; }

# ZIP-Ordner (ohne .git), z. B. ein früherer Download, mit GitHub verbinden. Erst wenn GitHub antwortet,
# wird etwas angelegt; node_modules und eigene Dateien bleiben unberührt. Danach bringt update_existing
# den Ordner auf den neuesten Stand (abweichende Dateien kommen dabei vorher in einen Git-Stash).
adopt_zip() {
  local dir="$1" out rc=0
  info "Der Ordner $dir ist ein ZIP-Download (kein Git). Er wird jetzt mit GitHub verbunden:"
  info "node_modules und eigene Dateien bleiben unberührt, abweichende Dateien werden vorher gesichert."
  out="$(LC_ALL=C git "${GIT_NET_OPTS[@]}" ls-remote --exit-code "$REMOTE_URL" "refs/heads/$BRANCH" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -ne 2 ] || out="couldn't find remote ref refs/heads/$BRANCH"
    warn "Verbinden nicht möglich – der Ordner bleibt unverändert."
    printf '%s\n' "$out" | head -n 2 | while IFS= read -r line; do dim "Git sagt: $line"; done
    private_repo_help
    return 1
  fi
  git -C "$dir" init -q
  git -C "$dir" symbolic-ref HEAD "refs/heads/$BRANCH"
  git -C "$dir" remote add origin "$REMOTE_URL"
  ok "Mit GitHub verbunden"
}

# Spiele- und BIOS-Ordner im Programmordner (Standard: ~/JellyStation/Games und ~/JellyStation/BIOS) gehören dem Nutzer.
# Git darf sie nie anfassen: Sonst würde "git stash -u" beim Update alle Spiele wegsichern. Der Eintrag steht nur in
# .git/info/exclude (lokal), nicht im Projekt.
protect_user_dirs() {
  local dir="$1" ex d
  [ -e "$dir/.git" ] || return 0
  [ -d "$dir/Games" ] || [ -d "$dir/BIOS" ] || return 0
  ex="$(git -C "$dir" rev-parse --git-path info/exclude 2>/dev/null || true)"
  [ -n "$ex" ] || return 0
  case "$ex" in /*) ;; *) ex="$dir/$ex" ;; esac
  for d in Games BIOS; do
    [ -d "$dir/$d" ] || continue
    grep -qxF -e "/$d" -e "/$d/" "$ex" 2>/dev/null && continue
    # ohne abschließenden Schrägstrich: gilt dann auch, wenn der Ordner ein Link auf eine andere Platte ist
    if mkdir -p "$(dirname "$ex")" 2>/dev/null; then printf '/%s\n' "$d" >> "$ex" 2>/dev/null || true; fi
  done
}

# Bestehenden Git-Ordner auf den Stand von GitHub bringen (eigene Änderungen werden vorher gesichert).
update_existing() {
  local dir="$1" out rc=0 new old porcelain stamp changed backup before after
  stamp="$(date +%Y%m%d-%H%M%S)"
  [ -n "$(git -C "$dir" config user.name 2>/dev/null || true)" ] || export GIT_AUTHOR_NAME="JellyStation" GIT_COMMITTER_NAME="JellyStation"
  [ -n "$(git -C "$dir" config user.email 2>/dev/null || true)" ] || export GIT_AUTHOR_EMAIL="jellystation@localhost" GIT_COMMITTER_EMAIL="jellystation@localhost"
  git -C "$dir" remote get-url origin >/dev/null 2>&1 || git -C "$dir" remote add origin "$REMOTE_URL"
  protect_user_dirs "$dir"

  out="$(LC_ALL=C git -C "$dir" "${GIT_NET_OPTS[@]}" fetch --quiet --no-tags origin \
    "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "Aktualisieren nicht möglich – ich arbeite mit dem vorhandenen Stand weiter."
    printf '%s\n' "$out" | head -n 2 | while IFS= read -r line; do dim "Git sagt: $line"; done
    private_repo_help
    return 0
  fi
  new="$(git -C "$dir" rev-parse -q --verify "refs/remotes/origin/$BRANCH^{commit}")" \
    || die "Auf GitHub gibt es den Branch '$BRANCH' nicht."
  old="$(git -C "$dir" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)"

  if [ -z "$old" ]; then
    # Frisch verbundener ZIP-Ordner (noch ohne Commit): Die Dateien werden durch die neueste Version ersetzt.
    git -C "$dir" symbolic-ref HEAD "refs/heads/$BRANCH"
    git -C "$dir" reset -q --mixed "$new" || die "Konnte den Stand von GitHub nicht übernehmen."
    changed="$(git -C "$dir" diff --name-only)"
    if [ -n "$changed" ]; then
      before="$(git -C "$dir" rev-parse -q --verify refs/stash 2>/dev/null || true)"
      git -C "$dir" stash push -q -m "jellystation-zip-vorher-$stamp" \
        || die "Konnte die alten Dateien nicht sichern – nichts verändert."
      after="$(git -C "$dir" rev-parse -q --verify refs/stash 2>/dev/null || true)"
      [ "$after" != "$before" ] || die "Sicherung der alten Dateien fehlgeschlagen – abgebrochen."
      warn "Manche Dateien waren anders als die neueste Version. Die alten Fassungen liegen im Git-Stash 'jellystation-zip-vorher-$stamp'."
    fi
  else
    porcelain="$(git -C "$dir" status --porcelain)"
    if [ -n "$porcelain" ]; then
      before="$(git -C "$dir" rev-parse -q --verify refs/stash 2>/dev/null || true)"
      git -C "$dir" stash push -u -q -m "jellystation-auto-stash-$stamp" \
        || die "Lokale Änderungen konnten nicht gesichert werden – nichts verändert."
      after="$(git -C "$dir" rev-parse -q --verify refs/stash 2>/dev/null || true)"
      [ "$after" != "$before" ] || die "Lokale Änderungen konnten nicht gesichert werden – nichts verändert."
      warn "Lokale Änderungen sind gesichert (git stash, 'jellystation-auto-stash-$stamp'); nichts ist verloren."
    fi
    # Neu aufgesetzter Branch auf GitHub oder eigene Commits: der bisherige Stand bleibt als Branch erhalten.
    if [ "$old" != "$new" ] && ! git -C "$dir" merge-base --is-ancestor "$old" "$new" 2>/dev/null; then
      backup="jellystation-alt-$stamp-$(git -C "$dir" rev-parse --short "$old")"
      git -C "$dir" branch -q "$backup" "$old" 2>/dev/null \
        && info "Der bisherige Stand bleibt als Branch '$backup' erhalten."
    fi
    git -C "$dir" checkout -q -f -B "$BRANCH" "refs/remotes/origin/$BRANCH" -- \
      || die "Konnte nicht auf den neuen Stand wechseln."
  fi
  ok "Aktualisiert auf $(git -C "$dir" log -1 --format='%h – %s' "$new")"
}

clone_fresh() {
  local dir="$1" out rc=0
  info "Lade JellyStation nach $dir …"
  out="$(LC_ALL=C git "${GIT_NET_OPTS[@]}" clone --quiet --branch "$BRANCH" --single-branch "$REMOTE_URL" "$dir" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    err "Das Herunterladen von GitHub ist fehlgeschlagen."
    printf '%s\n' "$out" | head -n 3 | while IFS= read -r line; do dim "Git sagt: $line"; done >&2
    case "$out" in
      *"Remote branch"*|*"not found in upstream"*) info "Den Branch '$BRANCH' gibt es nicht (mehr). Anderen Branch wählen, z. B.:  JELLYSTATION_BRANCH=main" ;;
      *"Could not resolve host"*|*"Failed to connect"*|*"timed out"*|*"Operation too slow"*) info "Keine Verbindung zu GitHub – bitte Internet prüfen und den Befehl erneut einfügen." ;;
      *) private_repo_help ;;
    esac
    exit 1
  fi
  ok "Heruntergeladen: $(git -C "$dir" log -1 --format='%h – %s')"
}

main() {
  local target own
  say "JellyStation einrichten"

  say "1/4 Mac und git prüfen"
  [ "$(uname -s)" = "Darwin" ] || die "Dieses Skript ist für macOS gedacht."
  ok "macOS $(sw_vers -productVersion 2>/dev/null || uname -r)"
  ensure_git

  say "2/4 JellyStation herunterladen"
  if [ -n "${JELLYSTATION_DIR:-}" ]; then
    target="$JELLYSTATION_DIR"
  elif own="$(own_project_dir)"; then
    target="$own"
  else
    target="$HOME/JellyStation"
  fi
  mkdir -p "$(dirname "$target")"
  target="$(cd -P "$(dirname "$target")" && pwd)/$(basename "$target")"

  if [ ! -e "$target" ] || is_empty_dir "$target"; then
    clone_fresh "$target"
  elif [ -e "$target/.git" ]; then
    info "Ordner $target ist schon da – ich aktualisiere ihn."
    update_existing "$target"
  elif [ -f "$target/package.json" ] && [ -f "$target/scripts/setup-mac.sh" ]; then
    if adopt_zip "$target"; then
      update_existing "$target"
    else
      warn "Ich mache mit dem vorhandenen Stand des Ordners weiter."
    fi
  else
    die "Der Ordner $target existiert schon und enthält etwas anderes. Anderen Zielordner wählen, z. B.:  JELLYSTATION_DIR=\$HOME/JellyStation2  und den Befehl erneut einfügen."
  fi

  grep -q -- '--prepare' "$target/scripts/setup-mac.sh" 2>/dev/null \
    || die "Der Ordner $target ist zu alt für diese Einrichtung (setup-mac.sh kennt --prepare nicht) und konnte nicht von GitHub aktualisiert werden. Bitte Internet prüfen (bzw. die Hinweise oben beachten) und den Befehl erneut einfügen."
  [ -f "$target/scripts/install-launcher.sh" ] \
    || die "scripts/install-launcher.sh fehlt in $target – der Ordner ist veraltet. Bitte erneut starten, sobald GitHub erreichbar ist."

  say "3/4 Werkzeuge, Pakete, Emulatoren und Ordner vorbereiten (kann einige Minuten dauern)"
  if ! grep -q 'install-emulators' "$target/scripts/setup-mac.sh" 2>/dev/null; then
    warn "Dieser Ordner ist älter: die Emulator-Einrichtung fehlt noch. Sie kommt mit dem nächsten erfolgreichen Update (dann: jellystation --emulators)."
  fi
  bash "$target/scripts/setup-mac.sh" --install-missing --prepare

  say "4/4 Befehl \"jellystation\" einrichten"
  bash "$target/scripts/install-launcher.sh"

  printf '\n%s%sFertig!%s Öffne ein neues Terminal-Fenster und tippe: %sjellystation%s\n' "$C_GREEN" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  info "Der Befehl aktualisiert JellyStation vor jedem Start automatisch."
  info "Der erste Start kompiliert den Rust-Teil und dauert einige Minuten – das ist normal."
  info "Ordner: $target"
  if [ -d "$HOME/JellyStation/Games" ]; then
    info "Spiele kommen in $HOME/JellyStation/Games/<System>/ (z. B. .../PS2/) – die Ordner sind angelegt."
    info "BIOS und Firmware gehören nicht zum Lieferumfang: Hinweise je Emulator stehen in $HOME/JellyStation/BIOS/."
  fi
}

# Erst die ganze Datei lesen, dann ausführen (wichtig, falls das Skript sich beim Update selbst ersetzt).
main "$@"; exit $?
