#!/usr/bin/env bash
# JellyStation – Einrichtung, Entwicklungsstart und Release-Build auf macOS.
#
#   ./scripts/setup-mac.sh                      prüft Voraussetzungen, installiert npm-Pakete, baut die App
#   ./scripts/setup-mac.sh --install-missing    installiert fehlende Werkzeuge (Node, Rust, Xcode CLT) selbst
#   ./scripts/setup-mac.sh --dev                startet statt des Builds die Entwicklungsversion
#   ./scripts/setup-mac.sh --open               öffnet die fertige App nach dem Build
#
# Ohne --install-missing wird nichts am System verändert, außer node_modules und dem Build-Ordner.
set -euo pipefail

INSTALL_MISSING=0
MODE=build
OPEN_APP=0
for arg in "$@"; do
  case "$arg" in
    --install-missing) INSTALL_MISSING=1 ;;
    --dev) MODE=dev ;;
    --open) OPEN_APP=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || fail "Dieses Skript ist für macOS gedacht."

# Rust-Werkzeuge liegen nach der Installation in ~/.cargo/bin.
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

cd "$(dirname "$0")/.."

say "1/4 Voraussetzungen prüfen"

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

# Node.js >= 20
if ! have node && [ "$INSTALL_MISSING" = 1 ]; then
  have brew || fail "Node.js fehlt und Homebrew ist nicht installiert (https://brew.sh) → danach erneut starten"
  brew install node
fi
have node || fail "Node.js fehlt → 'brew install node' (oder --install-missing)"
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

say "2/4 npm-Pakete installieren"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
ok "Pakete installiert"

if [ "$MODE" = dev ]; then
  say "3/4 Entwicklungsversion starten (beenden mit Strg+C)"
  exec npm run tauri dev
fi

say "3/4 App bauen (beim ersten Mal dauert das einige Minuten)"
npm run tauri build

APP="src-tauri/target/release/bundle/macos/JellyStation.app"
say "4/4 Fertig"
[ -d "$APP" ] || fail "Build abgeschlossen, aber $APP wurde nicht gefunden – Ausgabe oben prüfen"
ok "App:  $PWD/$APP"
for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
  [ -e "$dmg" ] && ok "DMG:  $PWD/$dmg"
done
echo "  Tipp: Die App in den Ordner Programme ziehen - oder mit  open \"$APP\"  starten."
[ "$OPEN_APP" = 1 ] && open "$APP"
exit 0
