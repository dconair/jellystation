#!/usr/bin/env bash
# JellyStation – ein Befehl: auf den neuesten Stand bringen und starten.
#
#   jellystation               aktualisieren, dann das JellyStation-Fenster starten (Tauri)
#   jellystation --web         aktualisieren, dann nur die Browser-Vorschau öffnen (http://localhost:1420)
#   jellystation --build       aktualisieren, die Release-App bauen und öffnen
#   jellystation --no-update   ohne Update starten (mit --web oder --build kombinierbar)
#   jellystation --status      nur den Stand anzeigen (lokal und GitHub, Emulatoren); ändert nichts
#   jellystation --emulators   Emulatoren jetzt prüfen und fehlende nachinstallieren (auch wenn es zuletzt nicht klappte)
#   jellystation --update-emulators   Emulatoren zusätzlich auf den neuesten Stand bringen
#   jellystation --no-emulators       die Emulator-Prüfung diesmal überspringen
#   jellystation -y, --yes     Rückfragen automatisch mit "Ja" beantworten
#   jellystation -h, --help    diese Hilfe
#
# Bei jedem Start prüft JellyStation kurz, ob die Emulatoren (RPCS3, DuckStation, PCSX2, PPSSPP, Dolphin) installiert
# sind, und sagt nur etwas, wenn welche fehlen. Was nicht automatisch installiert werden konnte, wird höchstens alle
# 24 Stunden erneut versucht (Merkdatei ~/.jellystation/emulators.check); dazwischen erinnert eine Zeile daran.
#
# Ohne den Befehl "jellystation" (siehe scripts/install-launcher.sh) geht es genauso mit:
#   bash scripts/jellystation.sh [Optionen]
#
# Umgebungsvariablen:
#   JELLYSTATION_BRANCH       Branch, dem JellyStation folgt (Standard: claude/serene-ride-x8ll06)
#   JELLYSTATION_REMOTE_URL   GitHub-Adresse, falls der Ordner erst verbunden werden muss
#                             (Standard: https://github.com/dconair/jellystation.git)
#   JELLYSTATION_DRY_RUN=1    nur anzeigen, was ausgeführt würde (npm, Emulatoren, Start), nichts davon tun
#   JELLYSTATION_EMULATORS=skip   die Emulator-Prüfung und -Installation ganz auslassen
set -euo pipefail

# Interne Optionen (werden von setup-mac.sh nach der Einrichtung aufgerufen):
#   --mark-deps       merkt sich den Stand der Pakete, damit der erste Start sie nicht gleich noch einmal installiert
#   --mark-emulators  merkt sich den Stand der Emulatoren (Merkdatei), damit der erste Start nicht gleich dasselbe wiederholt

BRANCH="${JELLYSTATION_BRANCH:-claude/serene-ride-x8ll06}"
REMOTE_URL="${JELLYSTATION_REMOTE_URL:-https://github.com/dconair/jellystation.git}"
DRY_RUN="${JELLYSTATION_DRY_RUN:-0}"
DEV_PORT=1420
NODE_MIN=20

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
DEPS_MARKER="$REPO_DIR/node_modules/.jellystation-deps"
TS="$(date +%Y%m%d-%H%M%S)"

MODE=dev
MODE_SET=0
UPDATE=1
STATUS=0
ASSUME_YES=0
MARK_DEPS=0
MARK_EMU=0
EMU_FORCE=0      # --emulators: jetzt prüfen/nachinstallieren, auch ohne Merkdatei
EMU_UPDATE=0     # --update-emulators: auch auf den neuesten Stand bringen
EMU_SKIP=0       # --no-emulators
EMU_INSTALLER="$SCRIPT_DIR/install-emulators.sh"
EMU_MARKER="${JELLYSTATION_HOME:-${HOME:-}}/.jellystation/emulators.check"
EMU_RETRY_SECONDS=86400
EMU_TOTAL="" EMU_INSTALLED="" EMU_MISSING="" EMU_MISSING_NAMES="" EMU_MANUAL=""

# ---------------------------------------------------------------- Ausgabe ----

C_RESET="" C_BOLD="" C_DIM="" C_GREEN="" C_YELLOW="" C_BLUE="" E_RED="" E_RESET=""
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  if [ -t 1 ]; then
    C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
    C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
  fi
  if [ -t 2 ]; then
    E_RED=$'\033[31m' E_RESET=$'\033[0m'
  fi
fi

say()  { printf '\n%s==> %s%s\n' "$C_BLUE$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
dim()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
err()  { printf '  %s✕ %s%s\n' "$E_RED" "$*" "$E_RESET" >&2; }
die()  { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
dry()  { printf '  %s[Trockenlauf]%s würde ausführen: %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
quote() { printf '%q' "$1"; }

print_help() {
  # Kopfkommentar dieser Datei (ab Zeile 2 bis zur ersten Nicht-Kommentarzeile)
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SCRIPT_PATH"
}

# ----------------------------------------------------------- Vorbereitung ----

# Homebrew (Apple Silicon: /opt/homebrew, Intel: /usr/local) und Rust (~/.cargo) liegen in
# einem frisch geöffneten Terminal nicht immer im PATH – hier nachholen.
prepare_path() {
  local d
  for d in "$HOME/.cargo/bin" /usr/local/sbin /usr/local/bin /opt/homebrew/sbin /opt/homebrew/bin; do
    if [ -d "$d" ]; then
      case ":$PATH:" in
        *":$d:"*) ;;
        *) PATH="$d:$PATH" ;;
      esac
    fi
  done
  export PATH
}

check_prereqs() {
  local need_cargo="$1" missing="" nl=$'\n' node_major
  if [ "$(uname -s)" = "Darwin" ] && have xcode-select && ! xcode-select -p >/dev/null 2>&1; then
    missing="${missing}  - Xcode Command Line Tools (Compiler, enthalten git)${nl}"
  elif ! have git; then
    missing="${missing}  - git${nl}"
  fi
  if ! have node; then
    missing="${missing}  - Node.js (Version $NODE_MIN oder neuer)${nl}"
  else
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$node_major" -lt "$NODE_MIN" ] 2>/dev/null; then
      missing="${missing}  - Node.js ist zu alt ($(node -v)) – benötigt wird Version $NODE_MIN oder neuer${nl}"
    fi
  fi
  have npm || missing="${missing}  - npm (gehört zu Node.js)${nl}"
  if [ "$need_cargo" = 1 ] && ! have cargo; then
    missing="${missing}  - Rust (cargo)${nl}"
  fi
  [ -z "$missing" ] && return 0

  err "Es fehlen noch Werkzeuge:"
  printf '%s' "$missing" >&2
  printf '\n  Das behebt ein Befehl (er installiert nur, was fehlt):\n\n    cd %s\n    bash scripts/setup-mac.sh --install-missing --prepare\n\n  Danach "jellystation" einfach erneut starten.\n' "$(quote "$REPO_DIR")" >&2
  exit 1
}

# ------------------------------------------------------------------- Git ----

g() { git -C "$REPO_DIR" "$@"; }

is_repo() { [ -e "$REPO_DIR/.git" ]; }

# stash/branch brauchen eine Git-Identität; auf einem frischen Mac ist keine eingerichtet.
ensure_git_identity() {
  if [ -z "$(g config user.name 2>/dev/null || true)" ]; then
    export GIT_AUTHOR_NAME="JellyStation" GIT_COMMITTER_NAME="JellyStation"
  fi
  if [ -z "$(g config user.email 2>/dev/null || true)" ]; then
    export GIT_AUTHOR_EMAIL="jellystation@localhost" GIT_COMMITTER_EMAIL="jellystation@localhost"
  fi
}

short_hash() { g rev-parse --short "$1" 2>/dev/null || printf '%s' "${1:0:7}"; }
commit_subject() { g log -1 --format=%s "$1" 2>/dev/null || true; }

# Nie nach Passwort fragen (hängt/verwirrt): fehlgeschlagene Anmeldung soll sofort scheitern.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15}"
GIT_NET_OPTS=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30)

FETCH_ERR=""
fetch_remote() {
  local rc=0
  FETCH_ERR="$(LC_ALL=C git -C "$REPO_DIR" "${GIT_NET_OPTS[@]}" fetch --quiet --no-tags origin \
    "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>&1)" || rc=$?
  return "$rc"
}

print_gh_help() {
  info "Ist das Repository inzwischen privat? Dann einmalig bei GitHub anmelden:"
  info "    brew install gh        (nur falls 'gh' noch fehlt)"
  info "    gh auth login          (GitHub.com, HTTPS, Git-Anmeldung mit Ja bestätigen, Anmeldung im Browser)"
  info "    gh auth setup-git"
  info "Danach funktioniert 'jellystation' wieder wie gewohnt."
}

explain_fetch_failure() {
  local msg="$1"
  case "$msg" in
    *"couldn't find remote ref"*)
      warn "Den Branch '$BRANCH' gibt es auf GitHub nicht (mehr) – vermutlich wurde er in 'main' übernommen."
      info "Anderen Branch verwenden, z. B.:  JELLYSTATION_BRANCH=main jellystation"
      ;;
    *"Could not resolve host"*|*"Failed to connect"*|*"timed out"*|*"Operation too slow"*|*"Network is unreachable"*|*"Connection"*)
      warn "GitHub ist gerade nicht erreichbar (Internetverbindung prüfen)."
      ;;
    *"Authentication failed"*|*"could not read Username"*|*"terminal prompts disabled"*|*"Repository not found"*|*"Permission denied"*|*"401"*|*"403"*|*"404"*)
      warn "GitHub verweigert den Zugriff – das Repository ist vermutlich privat."
      print_gh_help
      ;;
    *)
      warn "Die Updates konnten nicht von GitHub geholt werden."
      print_gh_help
      ;;
  esac
  if [ -n "$msg" ]; then
    printf '%s\n' "$msg" | head -n 2 | while IFS= read -r line; do dim "Git sagt: $line"; done
  fi
}

ask_yes() {
  local prompt="$1" answer=""
  if [ "$ASSUME_YES" = 1 ]; then
    info "$prompt → Ja (-y)"
    return 0
  fi
  if [ ! -t 0 ]; then
    warn "Rückfrage nicht möglich (keine Eingabe). Mit  jellystation -y  wird sie automatisch mit Ja beantwortet."
    return 1
  fi
  printf '  %s [J/n] ' "$prompt"
  read -r answer || answer=""
  case "$answer" in
    ""|[JjYy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# ZIP-Ordner (ohne .git) mit GitHub verbinden. Es wird erst etwas angelegt, wenn GitHub erreichbar ist.
adopt_repo() {
  local out rc=0
  say "Ordner mit GitHub verbinden"
  info "Dieser Ordner ist kein Git-Ordner (vermutlich ein ZIP-Download)."
  info "Verbinden heißt: Er bekommt die neueste Version von GitHub; Updates gehen danach mit einem Befehl."
  ask_yes "Jetzt verbinden?" || { warn "Übersprungen – der Ordner bleibt unverändert."; return 1; }

  out="$(LC_ALL=C git "${GIT_NET_OPTS[@]}" ls-remote --exit-code "$REMOTE_URL" "refs/heads/$BRANCH" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -eq 2 ] && out="couldn't find remote ref refs/heads/$BRANCH"
    explain_fetch_failure "$out"
    warn "Ich mache mit dem lokalen Stand weiter (der Ordner bleibt unverändert)."
    return 1
  fi
  g init -q
  g symbolic-ref HEAD "refs/heads/$BRANCH"
  g remote add origin "$REMOTE_URL"
  ok "Mit GitHub verbunden ($REMOTE_URL)"
  return 0
}

# Spiele- und BIOS-Ordner im Programmordner (Standard: ~/JellyStation/Games und ~/JellyStation/BIOS) gehören dem Nutzer.
# Git darf sie nie anfassen: Sonst würde "git stash -u" beim Update alle Spiele wegsichern. Der Eintrag steht nur in
# .git/info/exclude (lokal), nicht im Projekt.
protect_user_dirs() {
  local ex d
  is_repo || return 0
  [ -d "$REPO_DIR/Games" ] || [ -d "$REPO_DIR/BIOS" ] || return 0
  ex="$(g rev-parse --git-path info/exclude 2>/dev/null || true)"
  [ -n "$ex" ] || return 0
  case "$ex" in /*) ;; *) ex="$REPO_DIR/$ex" ;; esac
  for d in Games BIOS; do
    [ -d "$REPO_DIR/$d" ] || continue
    grep -qxF -e "/$d" -e "/$d/" "$ex" 2>/dev/null && continue
    # ohne abschließenden Schrägstrich: gilt dann auch, wenn der Ordner ein Link auf eine andere Platte ist
    if mkdir -p "$(dirname "$ex")" 2>/dev/null; then printf '/%s\n' "$d" >> "$ex" 2>/dev/null || true; fi
  done
}

# Zählt Zeilen einer (evtl. leeren) Textvariablen.
count_lines() { printf '%s\n' "$1" | awk 'NF { n++ } END { print n + 0 }'; }

# Neuer Ordner ohne Commit (frisch aus einer ZIP übernommen): Dateien aus der ZIP werden durch
# die aktuelle Version ersetzt. Vorher werden abweichende Dateien gesichert, damit nichts verloren geht.
sync_unborn() {
  local new="$1" changed
  g symbolic-ref HEAD "refs/heads/$BRANCH"
  g reset -q --mixed "$new" || { err "Konnte den Stand von GitHub nicht übernehmen."; return 1; }
  g branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
  changed="$(g diff --name-only)" || { err "Konnte Dateien nicht vergleichen."; return 1; }
  if [ -n "$changed" ]; then
    local n before after name="jellystation-zip-vorher-$TS"
    n="$(count_lines "$changed")"
    before="$(g rev-parse -q --verify refs/stash 2>/dev/null || true)"
    g stash push -q -m "$name" || { err "Konnte die alten Dateien nicht sichern – nichts verändert."; return 1; }
    after="$(g rev-parse -q --verify refs/stash 2>/dev/null || true)"
    [ "$after" != "$before" ] || { err "Sicherung der alten Dateien fehlgeschlagen – abgebrochen."; return 1; }
    if [ "$n" = 1 ]; then
      ok "1 Datei war anders als die neueste Version und ist jetzt aktuell."
    else
      ok "$n Dateien waren anders als die neueste Version und sind jetzt aktuell."
    fi
    dim "Die alten Fassungen liegen sicherheitshalber im Git-Stash '$name'"
    dim "(nur wichtig, falls du etwas selbst geändert hattest:  git -C $(quote "$REPO_DIR") stash list)"
  fi
  ok "Übernommen: $(short_hash "$new") $(commit_subject "$new")"
}

sync_normal() {
  local old="$1" new="$2" porcelain n cur before after name backup line total
  porcelain="$(g status --porcelain)" || { err "git status schlug fehl – Update abgebrochen (nichts verändert)."; return 1; }
  cur="$(g symbolic-ref -q --short HEAD 2>/dev/null || true)"

  if [ -n "$porcelain" ]; then
    n="$(count_lines "$porcelain")"
    name="jellystation-auto-stash-$TS"
    before="$(g rev-parse -q --verify refs/stash 2>/dev/null || true)"
    g stash push -u -q -m "$name" || { err "Lokale Änderungen konnten nicht gesichert werden – Update abgebrochen (nichts verändert)."; return 1; }
    after="$(g rev-parse -q --verify refs/stash 2>/dev/null || true)"
    if [ "$after" = "$before" ]; then
      err "Lokale Änderungen konnten nicht gesichert werden – Update abgebrochen (nichts verändert)."
      return 1
    fi
    local what="$n Einträge"
    [ "$n" != 1 ] || what="1 Eintrag"
    warn "Lokale Änderungen gefunden ($what) – sie sind sicher abgelegt, nichts geht verloren:"
    dim "Stash '$name'"
    dim "Ansehen:  git -C $(quote "$REPO_DIR") stash list"
    dim "Zurückholen:  git -C $(quote "$REPO_DIR") stash pop"
  fi

  # Wurde der Branch auf GitHub neu aufgesetzt (oder gab es lokale Commits), bleibt der alte Stand erhalten.
  if [ "$old" != "$new" ] && ! g merge-base --is-ancestor "$old" "$new" 2>/dev/null; then
    backup="jellystation-alt-$TS-$(short_hash "$old")"
    if g branch "$backup" "$old" 2>/dev/null || [ "$(g rev-parse -q --verify "refs/heads/$backup" 2>/dev/null)" = "$old" ]; then
      info "Der bisherige Stand ($(short_hash "$old")) ist nicht in der neuen Version enthalten und bleibt als Branch '$backup' erhalten."
    fi
  fi

  g checkout -q -f -B "$BRANCH" "refs/remotes/origin/$BRANCH" -- \
    || { err "Konnte nicht auf den neuen Stand wechseln."; return 1; }
  [ "$(g rev-parse HEAD)" = "$new" ] || { err "Nach dem Update stimmt der Stand nicht (HEAD ≠ GitHub)."; return 1; }

  if [ "$cur" != "$BRANCH" ]; then
    ok "Auf Branch '$BRANCH' gewechselt${cur:+ (vorher: $cur)}"
  fi
  if [ "$old" = "$new" ]; then
    ok "Bereits aktuell ($(short_hash "$new") $(commit_subject "$new"))"
  else
    ok "Aktualisiert: $(short_hash "$old") → $(short_hash "$new")"
    total="$(g rev-list --count "$old..$new" 2>/dev/null || echo 0)"
    g log --oneline -n 10 "$old..$new" 2>/dev/null | while IFS= read -r line; do info "$line"; done
    if [ "$total" -gt 10 ] 2>/dev/null; then
      info "… und $((total - 10)) weitere Änderungen"
    fi
    # Nur wenn wirklich dieser Branch neu aufgesetzt wurde (nicht beim Wechsel von einem anderen Branch).
    if [ "$cur" = "$BRANCH" ] && ! g merge-base --is-ancestor "$old" "$new" 2>/dev/null; then
      dim "(Der Branch wurde auf GitHub neu aufgesetzt; gezeigt werden die Änderungen seit dem gemeinsamen Stand.)"
    fi
  fi
}

# Rückgabe 0: Stand ist jetzt der von GitHub. 1: nichts geändert, es geht mit dem lokalen Stand weiter.
update_repo() {
  local old new
  ensure_git_identity
  if ! is_repo; then
    adopt_repo || return 1
  elif ! g remote get-url origin >/dev/null 2>&1; then
    g remote add origin "$REMOTE_URL"
  fi
  protect_user_dirs

  say "Suche Updates auf GitHub (Branch $BRANCH)"
  if ! fetch_remote; then
    explain_fetch_failure "$FETCH_ERR"
    warn "Ich mache mit dem lokalen Stand weiter."
    return 1
  fi
  new="$(g rev-parse -q --verify "refs/remotes/origin/$BRANCH^{commit}" 2>/dev/null)" \
    || { warn "GitHub hat keinen Stand für '$BRANCH' geliefert – ich mache mit dem lokalen Stand weiter."; return 1; }
  old="$(g rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)"

  if [ -z "$old" ]; then
    sync_unborn "$new" || return 1
  else
    sync_normal "$old" "$new" || return 1
  fi
  return 0
}

# ---------------------------------------------------------------- Status ----

pkg_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" 2>/dev/null | head -n 1
}

row() { printf '  %s%-11s%s %s\n' "$C_BOLD" "$1" "$C_RESET" "$2"; }

status_report() {
  local local_head="" cur remote_line remote_hash="" rc=0 out porcelain target behind
  export GIT_OPTIONAL_LOCKS=0   # git status darf hier nicht einmal den Index auffrischen
  say "JellyStation – Stand"
  row "Ordner" "$REPO_DIR"
  row "Version" "$(pkg_version)"
  row "Branch" "$BRANCH (Ziel)"

  if is_repo; then
    cur="$(g symbolic-ref -q --short HEAD 2>/dev/null || echo '(losgelöst)')"
    local_head="$(g rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)"
    if [ -n "$local_head" ]; then
      row "Lokal" "$(short_hash "$local_head") $(commit_subject "$local_head")  [Branch $cur]"
    else
      row "Lokal" "noch kein Stand (Ordner ist nur halb mit Git verbunden)"
    fi
    porcelain="$(g status --porcelain 2>/dev/null || true)"
    if [ -n "$porcelain" ] && [ -n "$local_head" ]; then
      row "Dateien" "lokal geändert: $(count_lines "$porcelain") – werden beim Update sicher abgelegt (Stash)"
    fi
    target=origin
    g remote get-url origin >/dev/null 2>&1 || target="$REMOTE_URL"
    out="$(LC_ALL=C git -C "$REPO_DIR" "${GIT_NET_OPTS[@]}" ls-remote --exit-code "$target" "refs/heads/$BRANCH" 2>&1)" || rc=$?
  else
    row "Lokal" "kein Git-Ordner (vermutlich ZIP) – wird beim nächsten Start mit GitHub verbunden"
    out="$(LC_ALL=C git "${GIT_NET_OPTS[@]}" ls-remote --exit-code "$REMOTE_URL" "refs/heads/$BRANCH" 2>&1)" || rc=$?
  fi

  if [ "$rc" -ne 0 ]; then
    [ "$rc" -eq 2 ] && out="couldn't find remote ref refs/heads/$BRANCH"
    emu_status_row
    echo
    explain_fetch_failure "$out"
  else
    remote_line="$(printf '%s\n' "$out" | head -n 1)"
    remote_hash="${remote_line%%[[:space:]]*}"
    if is_repo && g cat-file -e "$remote_hash^{commit}" 2>/dev/null; then
      row "GitHub" "$(short_hash "$remote_hash") $(commit_subject "$remote_hash")"
    else
      row "GitHub" "${remote_hash:0:7} (Beschreibung erst nach dem Update sichtbar)"
    fi
    emu_status_row
    echo
    if [ -z "$local_head" ]; then
      warn "Beim nächsten Start wird der Ordner auf die neueste Version gebracht."
    elif [ "$local_head" = "$remote_hash" ]; then
      ok "Aktuell – lokal und GitHub sind gleich."
    elif ! g cat-file -e "$remote_hash^{commit}" 2>/dev/null; then
      warn "GitHub hat einen anderen (vermutlich neueren) Stand. 'jellystation' holt ihn vor dem Start."
    elif g merge-base --is-ancestor "$local_head" "$remote_hash" 2>/dev/null; then
      behind="$(g rev-list --count "$local_head..$remote_hash" 2>/dev/null || echo '?')"
      warn "GitHub ist $behind Änderung(en) voraus. 'jellystation' holt sie vor dem Start."
    else
      warn "Lokal und GitHub unterscheiden sich. 'jellystation' bringt den Ordner beim Start auf den Stand von GitHub."
    fi
  fi

  if [ -d "$REPO_DIR/node_modules" ] && [ -f "$DEPS_MARKER" ]; then
    if [ "$(marker_get npm)" = "$(file_hash "$REPO_DIR/package-lock.json")" ] \
      && [ "$(marker_get cargo)" = "$(file_hash "$REPO_DIR/src-tauri/Cargo.lock")" ]; then
      ok "Pakete passen zum Stand."
    else
      warn "Pakete sind veraltet und werden beim nächsten Start neu installiert."
    fi
  else
    warn "Pakete sind noch nicht (oder nicht von JellyStation) installiert – das passiert beim nächsten Start."
  fi
}

# ------------------------------------------------------------- Pakete -------

hash_stdin() {
  if have shasum; then shasum -a 256 | awk '{ print $1 }'
  elif have sha256sum; then sha256sum | awk '{ print $1 }'
  else cksum | awk '{ print $1 "-" $2 }'
  fi
}

file_hash() {
  if [ -f "$1" ]; then hash_stdin < "$1"; else printf 'fehlt'; fi
}

marker_get() {
  [ -f "$DEPS_MARKER" ] || return 0
  sed -n "s/^$1=//p" "$DEPS_MARKER" | head -n 1
}

write_marker() {
  [ -d "$REPO_DIR/node_modules" ] || return 0
  printf 'npm=%s\ncargo=%s\n' \
    "$(file_hash "$REPO_DIR/package-lock.json")" \
    "$(file_hash "$REPO_DIR/src-tauri/Cargo.lock")" > "$DEPS_MARKER"
}

ensure_deps() {
  local reason="" npm_now cargo_now cargo_changed=0
  npm_now="$(file_hash "$REPO_DIR/package-lock.json")"
  cargo_now="$(file_hash "$REPO_DIR/src-tauri/Cargo.lock")"

  if [ ! -d "$REPO_DIR/node_modules" ]; then
    reason="node_modules fehlt"
  elif [ ! -f "$DEPS_MARKER" ]; then
    reason="Stand der installierten Pakete ist unbekannt"
  else
    if [ "$(marker_get npm)" != "$npm_now" ]; then
      reason="package-lock.json hat sich geändert"
    fi
    if [ "$(marker_get cargo)" != "$cargo_now" ]; then
      cargo_changed=1
      [ -n "$reason" ] || reason="Cargo.lock hat sich geändert"
    fi
  fi

  say "Pakete prüfen"
  if [ -z "$reason" ]; then
    ok "Pakete sind aktuell – Installation übersprungen"
  else
    info "Abhängigkeiten müssen installiert werden ($reason) → npm ci"
    if [ "$DRY_RUN" = 1 ]; then
      dry "npm ci   (Ersatz bei Fehler: npm install)"
    else
      (cd "$REPO_DIR" && { npm ci || { warn "npm ci schlug fehl – versuche npm install"; npm install; }; }) \
        || die "Pakete konnten nicht installiert werden – Ausgabe oben prüfen (Internet? Speicherplatz?)"
      write_marker
      ok "Pakete installiert"
    fi
  fi
  if [ "$cargo_changed" = 1 ]; then
    info "Die Rust-Pakete haben sich geändert: Der nächste Start kompiliert den Rust-Teil neu (kann einige Minuten dauern)."
  fi
}

# -------------------------------------------------------------- Emulatoren ---

# Lohnt sich die Emulator-Prüfung hier überhaupt? (nur auf dem Mac, nur mit dem Installationsskript)
emu_available() {
  [ "$(uname -s)" = "Darwin" ] && [ -f "$EMU_INSTALLER" ]
}

# Schnelle Prüfung ohne Ausgabe (install-emulators.sh --check --quiet --porcelain).
# Setzt EMU_TOTAL, EMU_INSTALLED, EMU_MISSING (IDs, mit Komma), EMU_MISSING_NAMES, EMU_MANUAL.
# Rückgabe: 0 = alles da, 1 = etwas fehlt, 2 = nicht prüfbar (dann bleiben die Werte leer)
emu_probe() {
  local out rc=0 k v
  EMU_TOTAL="" EMU_INSTALLED="" EMU_MISSING="" EMU_MISSING_NAMES="" EMU_MANUAL=""
  emu_available || return 2
  out="$(bash "$EMU_INSTALLER" --check --quiet --porcelain 2>/dev/null)" || rc=$?
  [ "$rc" -le 1 ] || return 2
  while IFS='=' read -r k v; do
    case "$k" in
      total) EMU_TOTAL="$v" ;;
      installed) EMU_INSTALLED="$v" ;;
      missing) EMU_MISSING="$v" ;;
      missing_names) EMU_MISSING_NAMES="$v" ;;
      manual) EMU_MANUAL="$v" ;;
    esac
  done <<< "$out"
  case "$EMU_TOTAL" in ''|0|*[!0-9]*) EMU_TOTAL="" EMU_INSTALLED=""; return 2 ;; esac
  return "$rc"
}

# Zeile "Emulatoren: n/5 installiert" für --status (nichts, wenn es hier keine Emulator-Prüfung gibt)
emu_status_row() {
  local erc=0
  emu_available || return 0
  emu_probe || erc=$?
  if [ "$erc" -eq 0 ]; then
    row "Emulatoren:" "$EMU_INSTALLED/$EMU_TOTAL installiert"
  elif [ "$erc" -eq 1 ]; then
    row "Emulatoren:" "$EMU_INSTALLED/$EMU_TOTAL installiert (es fehlen: $EMU_MISSING_NAMES)"
  fi
  return 0
}

# Merkdatei ~/.jellystation/emulators.check:  time=<Sekunden seit 1970>, result=ok|offen, missing=<IDs mit Komma>
EMU_MARK_TIME=0 EMU_MARK_MISSING=""
emu_marker_read() {
  local k v
  EMU_MARK_TIME=0 EMU_MARK_MISSING=""
  [ -f "$EMU_MARKER" ] || return 0
  while IFS='=' read -r k v; do
    case "$k" in
      time) case "$v" in ''|*[!0-9]*) ;; *) EMU_MARK_TIME="$v" ;; esac ;;
      missing) EMU_MARK_MISSING="$v" ;;
    esac
  done < "$EMU_MARKER"
}

emu_marker_write() {   # $1 = Ergebnis (ok|offen)
  mkdir -p "$(dirname "$EMU_MARKER")" 2>/dev/null || return 0
  printf 'time=%s\nresult=%s\nmissing=%s\n' "$(date +%s)" "$1" "$EMU_MISSING" > "$EMU_MARKER.tmp.$$" 2>/dev/null \
    && mv "$EMU_MARKER.tmp.$$" "$EMU_MARKER" 2>/dev/null || rm -f "$EMU_MARKER.tmp.$$" 2>/dev/null || true
}

# Ist ein neuer Versuch fällig? Ja, wenn es noch keinen gab, er über 24 Stunden her ist (oder die Uhr zurückgestellt
# wurde) oder ein Emulator fehlt, der beim letzten Versuch noch da war.
emu_due() {
  local now id
  emu_marker_read
  [ "$EMU_MARK_TIME" -gt 0 ] 2>/dev/null || return 0
  now="$(date +%s)"
  [ "$now" -ge "$EMU_MARK_TIME" ] || return 0
  [ $((now - EMU_MARK_TIME)) -lt "$EMU_RETRY_SECONDS" ] || return 0
  for id in ${EMU_MISSING//,/ }; do
    case ",$EMU_MARK_MISSING," in *",$id,"*) ;; *) return 0 ;; esac
  done
  return 1
}

emu_reminder() {
  local by_hand=""
  if [ -n "$EMU_MANUAL" ]; then
    by_hand=", von Hand: $EMU_MANUAL"
  else
    by_hand=", Download-Seiten: bash $(quote "$EMU_INSTALLER") --check"
  fi
  warn "Emulatoren fehlen noch: $EMU_MISSING_NAMES – nachholen mit  jellystation --emulators$by_hand"
}

# Installationsskript wirklich ausführen (oder im Trockenlauf nur anzeigen)
emu_run_installer() {
  local args=""
  [ "$ASSUME_YES" = 0 ] || args="$args --yes"
  [ "$EMU_UPDATE" = 0 ] || args="$args --update"
  if [ "$DRY_RUN" = 1 ]; then
    dry "bash $(quote "$EMU_INSTALLER")$args"
    return 0
  fi
  # shellcheck disable=SC2086   # $args enthält nur die festen Schalter von oben
  bash "$EMU_INSTALLER" $args || warn "Die Emulator-Einrichtung meldete ein Problem (Ausgabe oben) – gestartet wird trotzdem."
}

# Kurz prüfen und das Ergebnis in der Merkdatei festhalten (im Trockenlauf wird nichts geschrieben)
emu_record() {
  local rc=0
  emu_probe || rc=$?
  [ "$DRY_RUN" != 1 ] || return 0
  if [ "$rc" -eq 0 ]; then emu_marker_write ok; elif [ "$rc" -eq 1 ]; then emu_marker_write offen; fi
  return 0
}

# Emulatoren prüfen und bei Bedarf einrichten (vor dem Start).
#   --emulators / --update-emulators: immer jetzt (ohne Rücksicht auf die Merkdatei)
#   sonst: kurze stille Prüfung; fehlt etwas, wird höchstens alle 24 Stunden neu versucht, dazwischen erinnert eine Zeile
ensure_emulators() {
  local rc=0 forced=0
  if [ "$EMU_FORCE" = 1 ] || [ "$EMU_UPDATE" = 1 ]; then forced=1; fi
  if [ "$forced" = 0 ]; then
    [ "$EMU_SKIP" = 0 ] || return 0
    [ "${JELLYSTATION_EMULATORS:-}" != "skip" ] || return 0
    [ "$MODE" != web ] || return 0   # die Browser-Vorschau startet keine Emulatoren
  fi
  emu_available || return 0

  if [ "$forced" = 1 ]; then
    say "Emulatoren"
    emu_run_installer
  else
    emu_probe || rc=$?
    [ "$rc" -eq 1 ] || return 0   # alles da (0) oder nicht prüfbar (2): nichts sagen
    if ! emu_due; then
      emu_reminder
      return 0
    fi
    say "Emulatoren"
    info "Es fehlen: $EMU_MISSING_NAMES"
    emu_run_installer
  fi

  emu_record   # Stand nach dem Versuch merken
  return 0
}

# ------------------------------------------------------------------ Start ---

banner() {
  local label="$1" version commit="" subj="" hash dirty=""
  version="$(pkg_version)"
  if is_repo && hash="$(g rev-parse --short 'HEAD^{commit}' 2>/dev/null)"; then
    commit="$hash"
    subj="$(g log -1 --format=%s 2>/dev/null || true)"
    [ -z "$(GIT_OPTIONAL_LOCKS=0 g status --porcelain 2>/dev/null || true)" ] || dirty=", mit lokalen Änderungen"
  fi
  echo
  if [ -n "$commit" ]; then
    printf '  %sJellyStation %s%s  (%s – %s%s)\n' "$C_BOLD" "${version:-?}" "$C_RESET" "$commit" "$subj" "$dirty"
  else
    printf '  %sJellyStation %s%s  (Stand unbekannt: kein Git-Ordner)\n' "$C_BOLD" "${version:-?}" "$C_RESET"
  fi
  if [ -n "$EMU_TOTAL" ]; then info "Emulatoren: $EMU_INSTALLED/$EMU_TOTAL installiert"; fi
  info "$label"
}

warn_port_busy() {
  if have lsof && lsof -nP -iTCP:"$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Port $DEV_PORT ist schon belegt – läuft JellyStation vielleicht noch in einem anderen Terminal? (Dort mit Strg+C beenden.)"
  fi
}

first_build_hint() {
  [ -d "$REPO_DIR/src-tauri/target/$1" ] && return 0
  info "Beim ersten Mal wird der Rust-Teil kompiliert – das dauert einige Minuten. Bitte warten, das ist normal."
}

start_app() {
  case "$MODE" in
    dev)
      banner "Startet:  JellyStation-Fenster (npm run tauri dev) – beenden mit Strg+C"
      first_build_hint debug
      warn_port_busy
      if [ "$DRY_RUN" = 1 ]; then dry "(cd $(quote "$REPO_DIR") && npm run tauri dev)"; return 0; fi
      cd "$REPO_DIR"
      exec npm run tauri dev
      ;;
    web)
      banner "Startet:  Browser-Vorschau (npm run dev) auf http://localhost:$DEV_PORT – beenden mit Strg+C"
      warn_port_busy
      if [ "$DRY_RUN" = 1 ]; then dry "(cd $(quote "$REPO_DIR") && npm run dev -- --open)"; return 0; fi
      cd "$REPO_DIR"
      exec npm run dev -- --open
      ;;
    build)
      local app="$REPO_DIR/src-tauri/target/release/bundle/macos/JellyStation.app"
      banner "Baut:  Release-App (npm run tauri build) und öffnet sie danach"
      first_build_hint release
      if [ "$DRY_RUN" = 1 ]; then
        dry "(cd $(quote "$REPO_DIR") && npm run tauri build)"
        dry "open $(quote "$app")"
        return 0
      fi
      (cd "$REPO_DIR" && npm run tauri build) || die "Der Build ist fehlgeschlagen – Ausgabe oben prüfen."
      if [ "$(uname -s)" = "Darwin" ]; then
        [ -d "$app" ] || die "Build abgeschlossen, aber $app wurde nicht gefunden – Ausgabe oben prüfen."
        ok "App: $app"
        open "$app"
      else
        ok "Build fertig (Ergebnis unter $REPO_DIR/src-tauri/target/release/bundle/)"
      fi
      ;;
  esac
}

# ------------------------------------------------------------------- main ---

set_mode() {
  if [ "$MODE_SET" = 1 ] && [ "$MODE" != "$1" ]; then
    echo "--web und --build schließen sich aus." >&2
    exit 2
  fi
  MODE="$1"
  MODE_SET=1
}

main() {
  local arg self_before self_after
  for arg in "$@"; do
    case "$arg" in
      --web) set_mode web ;;
      --build) set_mode build ;;
      --no-update) UPDATE=0 ;;
      --status) STATUS=1 ;;
      --emulators) EMU_FORCE=1 ;;
      --update-emulators) EMU_UPDATE=1 ;;
      --no-emulators) EMU_SKIP=1 ;;
      -y|--yes) ASSUME_YES=1 ;;
      --mark-deps) MARK_DEPS=1 ;;
      --mark-emulators) MARK_EMU=1 ;;
      -h|--help) print_help; return 0 ;;
      *)
        echo "Unbekannte Option: $arg" >&2
        echo "Alle Optionen zeigt:  jellystation --help" >&2
        return 2
        ;;
    esac
  done

  if [ "$EMU_SKIP" = 1 ] && { [ "$EMU_FORCE" = 1 ] || [ "$EMU_UPDATE" = 1 ]; }; then
    echo "--no-emulators lässt sich nicht mit --emulators oder --update-emulators kombinieren." >&2
    return 2
  fi

  prepare_path

  if [ "$MARK_DEPS" = 1 ]; then
    write_marker
    return 0
  fi

  if [ "$MARK_EMU" = 1 ]; then
    if emu_available && [ "${JELLYSTATION_EMULATORS:-}" != "skip" ]; then emu_record; fi
    return 0
  fi

  if [ "$STATUS" = 1 ]; then
    check_prereqs_for_status
    status_report
    return 0
  fi

  if [ "$MODE" = web ]; then check_prereqs 0; else check_prereqs 1; fi

  if [ "$UPDATE" = 1 ]; then
    self_before="$(file_hash "$SCRIPT_PATH")"
    update_repo || true
    self_after="$(file_hash "$SCRIPT_PATH")"
    # Das Startskript selbst kann Teil des Updates sein: dann mit der neuen Fassung weitermachen.
    if [ "$self_before" != "$self_after" ] && [ -z "${JELLYSTATION_REEXEC:-}" ]; then
      ok "Das Startskript wurde mit aktualisiert – starte mit der neuen Fassung neu."
      export JELLYSTATION_REEXEC=1
      set -- --no-update
      [ "$MODE" = dev ] || set -- "$@" "--$MODE"
      [ "$ASSUME_YES" = 0 ] || set -- "$@" --yes
      [ "$EMU_FORCE" = 0 ] || set -- "$@" --emulators
      [ "$EMU_UPDATE" = 0 ] || set -- "$@" --update-emulators
      [ "$EMU_SKIP" = 0 ] || set -- "$@" --no-emulators
      exec bash "$SCRIPT_PATH" "$@"
    fi
  else
    say "Update übersprungen (--no-update)"
  fi

  ensure_deps
  ensure_emulators
  start_app
}

check_prereqs_for_status() {
  have git || die "git fehlt – 'bash scripts/setup-mac.sh --install-missing --prepare' installiert es."
  if [ "$(uname -s)" = "Darwin" ] && have xcode-select && ! xcode-select -p >/dev/null 2>&1; then
    die "Die Xcode Command Line Tools fehlen – 'bash scripts/setup-mac.sh --install-missing --prepare' installiert sie."
  fi
}

# Ganze Datei wird vor der Ausführung gelesen, damit ein Update dieses Skripts mittendrin nichts durcheinanderbringt.
main "$@"; exit $?
