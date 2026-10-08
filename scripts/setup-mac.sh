#!/usr/bin/env bash
# JellyStation – Einrichtung, Entwicklungsstart und Release-Build auf macOS.
#
#   ./scripts/setup-mac.sh                      prüft Voraussetzungen, installiert npm-Pakete, baut die App
#   ./scripts/setup-mac.sh --install-missing    installiert fehlende Werkzeuge (Node, Rust, Xcode CLT) selbst
#   ./scripts/setup-mac.sh --prepare            nur vorbereiten: Voraussetzungen prüfen/installieren, npm-Pakete
#                                               installieren (npm ci) und die Emulatoren einrichten, aber nichts
#                                               bauen oder starten
#   ./scripts/setup-mac.sh --dev                startet statt des Builds die Entwicklungsversion
#   ./scripts/setup-mac.sh --open               öffnet die fertige App nach dem Build
#   ./scripts/setup-mac.sh --no-emulators       lässt den Schritt "Emulatoren und Ordner" aus
#
# Üblich für die Ersteinrichtung:  bash scripts/setup-mac.sh --install-missing --prepare
# Danach startet und aktualisiert alles der Befehl "jellystation" (siehe scripts/install-launcher.sh).
#
# Beim Vorbereiten (--prepare) und beim vollen Lauf folgt nach den npm-Paketen der Schritt "Emulatoren und Ordner"
# (scripts/install-emulators.sh --yes): RPCS3, DuckStation, PCSX2, PPSSPP und Dolphin werden installiert, soweit das
# automatisch geht, und ~/JellyStation/Games/<System> sowie ~/JellyStation/BIOS werden angelegt – danach fehlen nur noch
# die Spiele (und BIOS/Firmware). Ein Fehler dort bricht die Einrichtung nicht ab. Mit --install-missing wird dafür bei
# Bedarf auch Homebrew installiert. JELLYSTATION_EMULATORS=skip schaltet den Schritt ebenfalls ab.
#
# Ohne --install-missing wird nichts am System verändert, außer node_modules, dem Build-Ordner und den Emulatoren/Ordnern.
set -euo pipefail

INSTALL_MISSING=0
MODE=build
PREPARE=0
DEV=0
OPEN_APP=0
EMULATORS=1
for arg in "$@"; do
  case "$arg" in
    --install-missing) INSTALL_MISSING=1 ;;
    --prepare) PREPARE=1 ;;
    --dev) DEV=1 ;;
    --open) OPEN_APP=1 ;;
    --no-emulators) EMULATORS=0 ;;
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
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || fail "Dieses Skript ist für macOS gedacht."

# Rust-Werkzeuge liegen nach der Installation in ~/.cargo/bin.
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# Ordner dieses Skripts (vor dem Wechsel in den Projektordner festhalten, $0 kann relativ sein)
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Der Schritt "Emulatoren und Ordner" gehört zu --prepare und zum vollen Lauf (nicht zu --dev).
[ "$MODE" = dev ] && EMULATORS=0
case "$MODE" in
  prepare) STEPS=2 ;;
  dev) STEPS=3 ;;
  *) STEPS=4 ;;
esac
[ "$EMULATORS" = 0 ] || STEPS=$((STEPS + 1))
STEP=0
step() { STEP=$((STEP + 1)); say "$STEP/$STEPS $*"; }

step "Voraussetzungen prüfen"

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

# Homebrew installieren (fragt nach dem Mac-Passwort). Rückgabe 0 = Homebrew ist danach da.
install_homebrew() {
  echo "  Installiere Homebrew - du wirst nach deinem Mac-Passwort gefragt (die Eingabe bleibt unsichtbar) ..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || true
  load_brew || return 1
  # Damit brew (und damit npm) auch in neuen Terminal-Fenstern gefunden wird:
  BREW_BIN="$(command -v brew)"
  grep -qs "brew shellenv" "$HOME/.zprofile" || echo "eval \"\$($BREW_BIN shellenv)\"" >> "$HOME/.zprofile"
  ok "Homebrew installiert"
}

# Node.js >= 20
if ! have node && [ "$INSTALL_MISSING" = 1 ]; then
  if ! have brew; then
    install_homebrew || fail "Homebrew wurde nicht gefunden - bitte das Terminal neu öffnen und das Skript erneut starten"
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

step "npm-Pakete installieren"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
ok "Pakete installiert"
# Stand der Pakete für den Befehl "jellystation" merken, damit er sie nicht gleich noch einmal installiert.
bash scripts/jellystation.sh --mark-deps >/dev/null 2>&1 || true

# Emulatoren installieren und Ordner für Spiele/BIOS anlegen. Fehler hier brechen die Einrichtung nie ab:
# "jellystation --emulators" versucht es später noch einmal.
if [ "$EMULATORS" = 1 ]; then
  step "Emulatoren und Ordner"
  EMU_SCRIPT="$SCRIPT_DIR/install-emulators.sh"
  if [ ! -f "$EMU_SCRIPT" ]; then
    warn "scripts/install-emulators.sh fehlt - die Emulatoren werden übersprungen."
  else
    # Für PCSX2, PPSSPP und Dolphin wird Homebrew gebraucht (gibt es keinen eigenen Download).
    if [ "$INSTALL_MISSING" = 1 ] && ! have brew && bash "$EMU_SCRIPT" --needs-brew; then
      echo "  Für einige Emulatoren wird Homebrew gebraucht."
      install_homebrew || warn "Homebrew ließ sich nicht installieren - die betroffenen Emulatoren müssen von Hand geholt werden."
    fi
    bash "$EMU_SCRIPT" --yes \
      || warn "Die Emulator-Einrichtung hat nicht alles geschafft - 'jellystation --emulators' versucht es später erneut."
    # Ergebnis für den Befehl "jellystation" merken, damit der erste Start nicht gleich dasselbe wiederholt.
    bash scripts/jellystation.sh --mark-emulators >/dev/null 2>&1 || true
  fi
fi

if [ "$MODE" = prepare ]; then
  echo
  if [ "$EMULATORS" = 1 ]; then
    ok "Vorbereitung abgeschlossen: Werkzeuge, Pakete und Emulatoren sind bereit (gebaut oder gestartet wurde nichts)."
  else
    ok "Vorbereitung abgeschlossen: Werkzeuge und Pakete sind bereit (gebaut oder gestartet wurde nichts)."
  fi
  echo "  Als Nächstes:  bash scripts/install-launcher.sh   (richtet den Befehl 'jellystation' ein)"
  echo "  Starten:       bash scripts/jellystation.sh       (aktualisiert und startet JellyStation)"
  exit 0
fi

if [ "$MODE" = dev ]; then
  step "Entwicklungsversion starten (beenden mit Strg+C)"
  exec npm run tauri dev
fi

step "App bauen (beim ersten Mal dauert das einige Minuten)"
npm run tauri build

APP="src-tauri/target/release/bundle/macos/JellyStation.app"
step "Fertig"
[ -d "$APP" ] || fail "Build abgeschlossen, aber $APP wurde nicht gefunden – Ausgabe oben prüfen"
ok "App:  $PWD/$APP"
for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
  [ -e "$dmg" ] && ok "DMG:  $PWD/$dmg"
done
echo "  Tipp: Die App in den Ordner Programme ziehen - oder mit  open \"$APP\"  starten."
[ "$OPEN_APP" = 1 ] && open "$APP"
exit 0
