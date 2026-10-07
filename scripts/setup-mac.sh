#!/usr/bin/env bash
# JellyStation – Einrichtung, Entwicklungsstart und Release-Build auf macOS.
#
#   ./scripts/setup-mac.sh                      prüft Voraussetzungen, installiert npm-Pakete, baut die App
#   ./scripts/setup-mac.sh --install-missing    installiert fehlende Werkzeuge (Node, Rust, Xcode CLT) selbst
#   ./scripts/setup-mac.sh --prepare            nur vorbereiten: Voraussetzungen prüfen/installieren und
#                                               npm-Pakete installieren (npm ci), aber nichts bauen oder starten
#   ./scripts/setup-mac.sh --dev                startet statt des Builds die Entwicklungsversion
#   ./scripts/setup-mac.sh --open               öffnet die fertige App nach dem Build
#
# Üblich für die Ersteinrichtung:  bash scripts/setup-mac.sh --install-missing --prepare
# Danach startet und aktualisiert alles der Befehl "jellystation" (siehe scripts/install-launcher.sh).
#
# Ohne --install-missing wird nichts am System verändert, außer node_modules und dem Build-Ordner.
set -euo pipefail

INSTALL_MISSING=0
MODE=build
PREPARE=0
DEV=0
OPEN_APP=0
for arg in "$@"; do
  case "$arg" in
    --install-missing) INSTALL_MISSING=1 ;;
    --prepare) PREPARE=1 ;;
    --dev) DEV=1 ;;
    --open) OPEN_APP=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done
# --prepare baut und startet nichts; die Kombination mit --dev/--open wäre widersprüchlich.
if [ "$PREPARE" = 1 ] && { [ "$DEV" = 1 ] || [ "$OPEN_APP" = 1 ]; }; then
  echo "--prepare lässt sich nicht mit --dev oder --open kombinieren (es wird nichts gebaut oder gestartet)." >&2
  exit 2
fi
if [ "$PREPARE" = 1 ]; then MODE=prepare; elif [ "$DEV" = 1 ]; then MODE=dev; fi

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || fail "Dieses Skript ist für macOS gedacht."

# Rust-Werkzeuge liegen nach der Installation in ~/.cargo/bin.
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

cd "$(dirname "$0")/.."

case "$MODE" in
  prepare) STEPS=2 ;;
  dev) STEPS=3 ;;
  *) STEPS=4 ;;
esac

say "1/$STEPS Voraussetzungen prüfen"

# Xcode Command Line Tools (Compiler & Linker für Rust)
if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode Command Line Tools"
elif [ "$INSTALL_MISSING" = 1 ]; then
  echo "  Starte Installation – bitte im erscheinenden Fenster auf Installieren klicken …"
  xcode-select --install || true
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  ok "Xcode Command Line Tools installiert"
else
  fail "Xcode Command Line Tools fehlen → 'xcode-select --install' (oder Skript mit --install-missing starten)"
fi

# Homebrew liegt auf Apple-Silicon-Macs unter /opt/homebrew, auf Intel-Macs unter /usr/local.
load_brew() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      return 0
    fi
  done
  return 1
}
have brew || load_brew || true

# Node.js >= 20
if ! have node && [ "$INSTALL_MISSING" = 1 ]; then
  if ! have brew; then
    echo "  Installiere Homebrew - du wirst nach deinem Mac-Passwort gefragt (die Eingabe bleibt unsichtbar) ..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_brew || fail "Homebrew wurde nicht gefunden - bitte das Terminal neu öffnen und das Skript erneut starten"
    # Damit npm auch in neuen Terminal-Fenstern gefunden wird:
    BREW_BIN="$(command -v brew)"
    grep -qs "brew shellenv" "$HOME/.zprofile" || echo "eval \"\$($BREW_BIN shellenv)\"" >> "$HOME/.zprofile"
    ok "Homebrew installiert"
  fi
  brew install node
fi
have node || fail "Node.js fehlt -> 'brew install node' (oder Skript mit --install-missing starten)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $(node -v) ist zu alt – benötigt wird Version 20 oder neuer"
ok "Node.js $(node -v), npm $(npm -v)"

# Rust
if ! have cargo && [ "$INSTALL_MISSING" = 1 ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
have cargo || fail "Rust fehlt → https://rustup.rs (oder Skript mit --install-missing starten)"
ok "$(rustc --version)"

say "2/$STEPS npm-Pakete installieren"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
ok "Pakete installiert"
# Stand der Pakete für den Befehl "jellystation" merken, damit er sie nicht gleich noch einmal installiert.
bash scripts/jellystation.sh --mark-deps >/dev/null 2>&1 || true

if [ "$MODE" = prepare ]; then
  echo
  ok "Vorbereitung abgeschlossen: Werkzeuge und Pakete sind bereit (gebaut oder gestartet wurde nichts)."
  echo "  Als Nächstes:  bash scripts/install-launcher.sh   (richtet den Befehl 'jellystation' ein)"
  echo "  Starten:       bash scripts/jellystation.sh       (aktualisiert und startet JellyStation)"
  exit 0
fi

if [ "$MODE" = dev ]; then
  say "3/$STEPS Entwicklungsversion starten (beenden mit Strg+C)"
  exec npm run tauri dev
fi

say "3/$STEPS App bauen (beim ersten Mal dauert das einige Minuten)"
npm run tauri build

APP="src-tauri/target/release/bundle/macos/JellyStation.app"
say "4/$STEPS Fertig"
[ -d "$APP" ] || fail "Build abgeschlossen, aber $APP wurde nicht gefunden – Ausgabe oben prüfen"
ok "App:  $PWD/$APP"
for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
  [ -e "$dmg" ] && ok "DMG:  $PWD/$dmg"
done
echo "  Tipp: Die App in den Ordner Programme ziehen - oder mit  open \"$APP\"  starten."
[ "$OPEN_APP" = 1 ] && open "$APP"
exit 0
