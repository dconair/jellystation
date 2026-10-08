#!/usr/bin/env bash
# JellyStation – Emulatoren prüfen, installieren und die Ordner für Spiele und BIOS vorbereiten (macOS).
#
#   bash scripts/install-emulators.sh [Optionen]
#
# Ohne Optionen: zeigt in einer Tabelle, welche Emulatoren da sind (RPCS3, DuckStation, PCSX2, PPSSPP, Dolphin),
# installiert die fehlenden und legt die Ordner ~/JellyStation/Games/<System> und ~/JellyStation/BIOS an.
# Spiele (und BIOS/Firmware) bringst du selbst mit – sie werden weder mitgeliefert noch heruntergeladen.
#
#   --check          nur prüfen, ändert nichts (auch keine Ordner). Exit-Code 0 = alles da, 1 = etwas fehlt
#   -y, --yes        ohne Rückfrage installieren
#   --update         bereits installierte Emulatoren auf den neuesten Stand bringen (fehlende werden mit installiert)
#   --only a,b       nur diese Emulatoren (rpcs3, duckstation, pcsx2, ppsspp, dolphin)
#   --skip a,b       diese Emulatoren auslassen
#   --no-folders     keine Ordner für Spiele und BIOS anlegen
#   -q, --quiet      leise: bei "alles da" keine Ausgabe
#   -h, --help       diese Hilfe
#
# Ein einzelner Fehlschlag (kein Netz, Download-Seite geändert …) bricht nichts ab: Der Emulator wird übersprungen,
# am Ende steht, was von Hand zu tun ist. Der Exit-Code ist trotzdem 0 – nur --check liefert 0/1 (siehe oben),
# 2 steht für falsche Bedienung, 3 für ein Problem mit Node.js oder der Datendatei.
# Ohne Terminal (stdin/stdout) wird nie gefragt; es gilt dann "Ja".
#
# Umgebungsvariablen:
#   JELLYSTATION_EMULATORS=skip   überspringt alles ohne Fehler
#   GITHUB_TOKEN                  optional: höhere Rate für die GitHub-Abfragen (wird nur an die GitHub-API gesendet)
#   JELLYSTATION_APPS_DIR         Programme-Ordner (Standard: /Applications)
#   JELLYSTATION_USER_APPS_DIR    Ausweichordner, falls der erste nicht beschreibbar ist (Standard: ~/Applications)
#   JELLYSTATION_HOME             Benutzerordner für Spiele-, BIOS- und Merkdateien (Standard: $HOME)
#   JELLYSTATION_DATA             Pfad zur Datendatei (Standard: src/emulators/emulators.json)
#   JELLYSTATION_GITHUB_API       Basis-Adresse der GitHub-API (nur Tests/Spiegel; Server muss auf der Liste stehen)
#   JELLYSTATION_URL_<ID>=<url>   Download-Adresse eines Emulators festlegen, z. B. JELLYSTATION_URL_RPCS3 (Tests/Notfälle)
#   JELLYSTATION_TEST=1           nur für Tests: erlaubt http und 127.0.0.1 als Download-Server
#
# Intern (für die anderen Skripte): --porcelain (mit --check: maschinenlesbare Zeilen), --needs-brew (Exit 0, wenn
# für einen fehlenden Emulator Homebrew gebraucht wird), --validate-data (prüft nur die Datendatei).
#
# Sicherheit: kein sudo; nur https-Downloads von Servern, die in der Datendatei stehen (allowedHosts); SHA-256 wird
# geprüft, wenn GitHub eine Prüfsumme liefert; gelöscht wird nur, was dieses Skript selbst angelegt hat.
# Läuft mit der Bash 3.2 von macOS (keine assoziativen Arrays, kein mapfile, kein eval).
# shellcheck disable=SC2317   # cleanup/on_signal laufen nur über trap
set -u
set -o pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
RS=$'\036'   # Trenner innerhalb von Listen
US=$'\037'   # Trenner zwischen Feldern
NL=$'\n'
TAB=$'\t'

OPT_CHECK=0 OPT_YES=0 OPT_UPDATE=0 OPT_ONLY="" OPT_SKIP="" OPT_FOLDERS=1 OPT_QUIET=0
OPT_PORCELAIN=0 OPT_NEEDS_BREW=0 OPT_VALIDATE=0

# Zustand, der beim Aufräumen gebraucht wird (alles vorbelegt, wegen set -u)
WORK_DIR="" MOUNT_POINT="" STAGE_PATH="" BACKUP_PATH="" BACKUP_FINAL=""
TARGET_DIR="" HW_ARM="" SEVENZ="" APP_LIST="" FOUND_PATH=""
RES="" RES_WHY="" REPLY="" DEST_APP="" CUR_OLD="" APP_SRC="" DL_FILE=""
R_TAG="" R_NAME="" R_URL="" R_SHA="" R_SIZE="" R_ROSETTA="0" R_ASSETS="" R_NOTE="" API_STATUS="" API_MSG=""
EMU_COUNT=0 SEL="" FAILED="" HOMEBREW_HINT=0 EMU_ROSETTA_NOTE=0 R_REPO="" CUR_HOSTS="" OVERRIDE_URL="" OVERRIDE_ACTIVE=0
TEST_MODE=0 HOME_DIR="" APPS_DIR="" USER_APPS_DIR="" DATA_FILE="" STATE_DIR="" STATE_FILE="" GITHUB_API=""
N_INSTALLED=0 N_SEL=0 MISSING="" MISSING_NAMES="" MISSING_IDS=""
D_lib_baseDir="" D_lib_biosDir="" D_lib_systemFolders="" D_dl_api=""   # werden von load_data gefüllt

# ---------------------------------------------------------------- Ausgabe ----

C_RESET="" C_BOLD="" C_DIM="" C_GREEN="" C_YELLOW="" C_RED="" E_RED="" E_RESET=""
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  if [ -t 1 ]; then
    C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
    C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m'
  fi
  if [ -t 2 ]; then E_RED=$'\033[31m' E_RESET=$'\033[0m'; fi
fi

heading() { printf '\n  %s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
ok()      { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()    { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
bad()     { printf '  %s✕%s %s\n' "$C_RED" "$C_RESET" "$*"; }
info()    { printf '    %s\n' "$*"; }
dim()     { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
err()     { printf '  %s✕ %s%s\n' "$E_RED" "$*" "$E_RESET" >&2; }
have()    { command -v "$1" >/dev/null 2>&1; }

print_help() {
  # Kopfkommentar dieser Datei (ab Zeile 2 bis zur ersten Nicht-Kommentarzeile)
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SCRIPT_PATH"
}

usage_error() {
  printf '%s\n' "$1" >&2
  printf 'Alle Optionen zeigt:  bash scripts/install-emulators.sh --help\n' >&2
  exit 2
}

# --------------------------------------------------------------- Aufräumen ----

# Löscht nur, was dieses Skript selbst angelegt hat: den eigenen Temp-Ordner (und darin alles) sowie die
# Zwischen- und Sicherungsordner im Programme-Ordner, deren Pfade genau so vorher eingetragen wurden.
# Alles andere (leere Pfade, "/", relative Pfade, "..") lehnt die Funktion ab.
safe_rm() {
  local p="$1"
  [ -n "$p" ] && [ "$p" != "/" ] || return 1
  case "$p" in /*) ;; *) return 1 ;; esac
  case "$p" in */../*|*/..|*/./*|*/.) return 1 ;; esac
  if [ -n "$WORK_DIR" ]; then
    case "$p" in
      "$WORK_DIR"|"$WORK_DIR"/*)
        [ -z "$MOUNT_POINT" ] || return 1   # solange ein Image eingehängt ist, wird im Temp-Ordner nichts gelöscht
        rm -rf -- "$p"
        return 0
        ;;
    esac
  fi
  if [ -n "$STAGE_PATH" ] && [ "$p" = "$STAGE_PATH" ]; then
    case "${p##*/}" in .*.jellystation-new.*) rm -rf -- "$p"; return 0 ;; esac
  fi
  if [ -n "$BACKUP_PATH" ] && [ "$p" = "$BACKUP_PATH" ]; then
    case "${p##*/}" in .*.jellystation-old.*) rm -rf -- "$p"; return 0 ;; esac
  fi
  return 1
}

detach_dmg() {
  [ -n "$MOUNT_POINT" ] || return 0
  if hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 \
    || { sleep 1; hdiutil detach "$MOUNT_POINT" -force -quiet >/dev/null 2>&1; }; then
    MOUNT_POINT=""
  else
    warn "Das Disk-Image ($MOUNT_POINT) ließ sich nicht auswerfen – bitte im Finder auswerfen."
  fi
}

restore_backup() {
  if [ -n "$BACKUP_PATH" ] && [ -n "$BACKUP_FINAL" ] && [ -e "$BACKUP_PATH" ] && [ ! -e "$BACKUP_FINAL" ]; then
    mv "$BACKUP_PATH" "$BACKUP_FINAL" 2>/dev/null || warn "Die alte Version liegt noch unter $BACKUP_PATH"
  fi
  BACKUP_PATH="" BACKUP_FINAL=""
}

cleanup() {
  trap - EXIT INT TERM HUP
  detach_dmg
  [ -z "$STAGE_PATH" ] || { safe_rm "$STAGE_PATH" || true; STAGE_PATH=""; }
  restore_backup
  [ -z "$WORK_DIR" ] || { safe_rm "$WORK_DIR" || true; WORK_DIR=""; }
  return 0
}

on_signal() {
  printf '\n' >&2
  err "Abgebrochen – ich räume auf."
  exit "$1"
}

ensure_work_dir() {
  [ -z "$WORK_DIR" ] || return 0
  local base="${TMPDIR:-/tmp}"
  base="${base%/}"
  WORK_DIR="$(mktemp -d "$base/jellystation-emu.XXXXXX")" || { WORK_DIR=""; return 1; }
  case "$WORK_DIR" in /*) ;; *) WORK_DIR=""; return 1 ;; esac
  chmod 700 "$WORK_DIR" 2>/dev/null || true
  mkdir -p "$WORK_DIR/dl" "$WORK_DIR/x" "$WORK_DIR/mnt"
}

# ------------------------------------------------------------ Hilfsfunktionen ----

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Text mit "~" statt dem Benutzerordner (nur zur Anzeige)
shown() {
  # shellcheck disable=SC2088   # "~/" ist nur Anzeige
  case "$1" in
    "$HOME_DIR"/*) printf '~/%s' "${1#"$HOME_DIR"/}" ;;
    "$HOME_DIR") printf '~' ;;
    *) printf '%s' "$1" ;;
  esac
}

# "~/x" → "<Benutzerordner>/x"
expand_home() {
  # shellcheck disable=SC2088   # "~/" ist hier der Platzhalter aus der Datendatei, keine Shell-Tilde
  case "$1" in
    "~/"*) printf '%s/%s' "$HOME_DIR" "${1#"~/"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

fmt_size() {   # Bytes → "12.3 MB"
  local b="$1"
  case "$b" in ''|*[!0-9]*) printf 'unbekannte Größe'; return 0 ;; esac
  if [ "$b" -ge 1048576 ]; then
    printf '%s.%s MB' "$((b / 1048576))" "$(((b % 1048576) * 10 / 1048576))"
  elif [ "$b" -ge 1024 ]; then
    printf '%s KB' "$((b / 1024))"
  else
    printf '%s Byte' "$b"
  fi
}

sha256_of() {
  if have shasum; then shasum -a 256 "$1" 2>/dev/null | awk '{ print $1 }'
  elif have sha256sum; then sha256sum "$1" 2>/dev/null | awk '{ print $1 }'
  elif have openssl; then openssl dgst -sha256 "$1" 2>/dev/null | awk '{ print $NF }'
  else return 1
  fi
}

file_size() { printf '%s' "$(($(wc -c < "$1")))"; }

# Variablen mit dynamischem Namen (ohne eval): setv NAME WERT / getv NAME → REPLY
setv() { printf -v "$1" '%s' "$2"; }
getv() { local n="$1"; REPLY="${!n:-}"; }
# Feld eines Emulators aus der Datendatei: getf INDEX FELD → REPLY
getf() { local n="D_emu_${1}_${2}"; REPLY="${!n:-}"; }

in_csv() { case ",$2," in *",$1,"*) return 0 ;; esac; return 1; }

# Liste (mit \036 getrennt) → LIST[]
LIST=()
split_list() { IFS="$RS" read -r -a LIST <<< "$1" || true; }

# Groß-/Kleinschreibung ignorierender Regex-Vergleich (ERE): re_match_ci TEXT MUSTER
re_match_ci() {
  local rc=1 had=0
  shopt -q nocasematch && had=1
  shopt -s nocasematch
  # shellcheck disable=SC2015
  [[ $1 =~ $2 ]] && rc=0
  [ "$had" = 1 ] || shopt -u nocasematch
  return "$rc"
}

# Host einer URL (klein geschrieben). Nur https (mit JELLYSTATION_TEST=1 auch http); keine Zugangsdaten, kein Port.
url_host() {
  local u="$1" rest host
  case "$u" in
    https://*) rest="${u#https://}" ;;
    http://*) [ "$TEST_MODE" = 1 ] || return 1; rest="${u#http://}" ;;
    *) return 1 ;;
  esac
  host="${rest%%[/?#]*}"
  case "$host" in ''|*@*|*\ *) return 1 ;; esac
  case "$host" in
    *:*) [ "$TEST_MODE" = 1 ] || return 1; host="${host%%:*}" ;;
  esac
  lower "$host"
}

# Steht der Host auf der Liste (\036-getrennt, "*.beispiel.de" erlaubt)? Mit JELLYSTATION_TEST=1 zusätzlich 127.0.0.1.
host_allowed() {
  local h="$1" pat
  [ -n "$h" ] || return 1
  if [ "$TEST_MODE" = 1 ]; then
    case "$h" in 127.0.0.1|localhost) return 0 ;; esac
  fi
  split_list "$2"
  for pat in ${LIST[@]+"${LIST[@]}"}; do
    # shellcheck disable=SC2254
    case "$h" in $pat) return 0 ;; esac
  done
  return 1
}

# ---------------------------------------------------------------- Datendatei ----

# Liest die Datendatei mit Node.js, prüft sie und gibt "D_<name><TAB><wert>"-Zeilen aus.
# Listen sind mit \036 getrennt. Fehler: Meldung "FEHLER: …" und Exit-Code 1.
IFS= read -r -d '' LOADER_JS <<'JS_END' || true
"use strict";
const fs = require("fs");
const file = process.argv[1];
const RS = "\x1e";
const out = [];
function fail(msg) { fs.writeSync(2, "FEHLER: " + msg + "\n"); process.exit(1); }
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) { fail("Datendatei nicht lesbar oder kein gültiges JSON (" + file + "): " + e.message); }
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const CTRL = /[\u0000-\u001f\u007f]/;
function str(v, where, re, opt) {
  if (v === undefined || v === null) { if (opt) return ""; fail(where + " fehlt"); }
  if (typeof v !== "string") fail(where + " muss Text sein");
  if (v === "" && !opt) fail(where + " ist leer");
  if (CTRL.test(v)) fail(where + " enthält Steuerzeichen");
  if (re && v !== "" && !re.test(v)) fail(where + " hat ein ungültiges Format: " + v);
  return v;
}
function list(v, where, re, opt) {
  if (v === undefined || v === null) { if (opt) return []; fail(where + " fehlt"); }
  if (!Array.isArray(v)) fail(where + " muss eine Liste sein");
  return v.map((x, k) => str(x, where + "[" + k + "]", re));
}
function put(key, value) { out.push("D_" + key + "\t" + value); }
function regex(p, where) {
  try { return new RegExp(p, "i"); } catch (e) { fail(where + " ist kein gültiger regulärer Ausdruck: " + e.message); }
}
// Muster, die in der Shell (ERE) genauso gelten müssen wie in JavaScript
function ereSafe(p, where) {
  regex(p, where);
  if (/\(\?|\\[dDwWsSbB]|[*+?}]\?|\\[0-9]|\\k</.test(p)) fail(where + " nutzt Regex-Funktionen, die die Shell nicht kennt: " + p);
}
function homePath(v, where) {
  str(v, where, /^~\/[^~]+$/);
  if (v.split("/").includes("..")) fail(where + ": '..' ist nicht erlaubt");
  return v.replace(/\/+$/, "");
}
function hostMatches(h, pats) {
  return pats.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}
const normalizeSystem = (n) => n.toLowerCase().replace(/[\s_\-.]+/g, "");

if (!isObj(data) || data.version !== 1) fail("version muss 1 sein");

const lib = data.library;
if (!isObj(lib)) fail("library fehlt");
put("lib_baseDir", homePath(lib.baseDir, "library.baseDir"));
put("lib_biosDir", homePath(lib.biosDir, "library.biosDir"));
const folders = list(lib.systemFolders, "library.systemFolders", /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
if (folders.length === 0) fail("library.systemFolders ist leer");
put("lib_systemFolders", folders.join(RS));

const dl = data.download;
if (!isObj(dl)) fail("download fehlt");
put("dl_api", str(dl.githubApi, "download.githubApi", /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/));
if (!isObj(dl.archHints)) fail("download.archHints fehlt");
for (const k of ["arm64", "x86_64", "universal"]) regex(str(dl.archHints[k], "download.archHints." + k), "download.archHints." + k);
list(dl.extensionOrder, "download.extensionOrder").forEach((p, k) => regex(p, "download.extensionOrder[" + k + "]"));

if (!Array.isArray(data.emulators) || data.emulators.length === 0) fail("emulators fehlt oder ist leer");
const ids = new Set();
const folderOwner = {};
const KINDS = ["brew-cask", "github-release", "direct-url", "manual"];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOSTPAT = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

data.emulators.forEach((e, i) => {
  const w = "emulators[" + i + "]";
  if (!isObj(e)) fail(w + " muss ein Objekt sein");
  const id = str(e.id, w + ".id", /^[a-z][a-z0-9-]*$/);
  if (ids.has(id)) fail(w + ".id kommt doppelt vor: " + id);
  ids.add(id);
  put("emu_" + i + "_id", id);
  put("emu_" + i + "_name", str(e.name, w + ".name", /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/));
  put("emu_" + i + "_consoles", str(e.consoles, w + ".consoles"));
  const systems = list(e.systems, w + ".systems", /^[a-z0-9]+$/);
  if (systems.length === 0) fail(w + ".systems ist leer");
  put("emu_" + i + "_systems", systems.join(RS));
  put("emu_" + i + "_appPattern", (ereSafe(str(e.appPattern, w + ".appPattern"), w + ".appPattern"), e.appPattern));
  put("emu_" + i + "_bundleIds", list(e.bundleIds, w + ".bundleIds", /^[A-Za-z0-9.-]+$/, true).join(RS));
  const cask = e.brewCask === null || e.brewCask === undefined ? "" : str(e.brewCask, w + ".brewCask", /^[a-z0-9][a-z0-9@._-]*$/);
  put("emu_" + i + "_brewCask", cask);
  put("emu_" + i + "_downloadUrl", str(e.downloadUrl, w + ".downloadUrl", /^https:\/\/[^\s]+$/));
  put("emu_" + i + "_setupNote", str(e.setupNote, w + ".setupNote", null, true));
  put("emu_" + i + "_biosNote", str(e.biosNote, w + ".biosNote", null, true));
  put("emu_" + i + "_appSupportDirs", list(e.appSupportDirs, w + ".appSupportDirs", null, true).map((p, k) => homePath(p, w + ".appSupportDirs[" + k + "]")).join(RS));

  const mine = folders.filter((f) => systems.includes(normalizeSystem(f)));
  mine.forEach((f) => { if (folderOwner[f]) fail("library.systemFolders: '" + f + "' gehört zu zwei Emulatoren"); folderOwner[f] = id; });
  put("emu_" + i + "_folders", mine.join(RS));

  const ins = e.install;
  if (!isObj(ins)) fail(w + ".install fehlt");
  const kind = str(ins.kind, w + ".install.kind");
  if (!KINDS.includes(kind)) fail(w + ".install.kind ist unbekannt: " + kind + " (erlaubt: " + KINDS.join(", ") + ")");
  put("emu_" + i + "_install_kind", kind);
  const fb = list(ins.fallback, w + ".install.fallback", null, true);
  fb.forEach((k) => { if (!["github-release", "direct-url"].includes(k) || k === kind) fail(w + ".install.fallback: '" + k + "' ist nicht erlaubt"); });
  put("emu_" + i + "_install_fallback", fb.join(RS));
  const hosts = list(ins.allowedHosts, w + ".install.allowedHosts", HOSTPAT, true);
  put("emu_" + i + "_install_allowedHosts", hosts.join(RS));

  const needGithub = kind === "github-release" || fb.includes("github-release");
  const needDirect = kind === "direct-url" || fb.includes("direct-url");
  if (kind === "brew-cask" && cask === "") fail(w + ": install.kind brew-cask braucht brewCask");

  const gh = isObj(ins.github) ? ins.github : {};
  let repos = 0;
  for (const a of ["arm64", "x86_64", "any"]) {
    const r = str(gh[a], w + ".install.github." + a, REPO, true);
    if (r) repos++;
    put("emu_" + i + "_install_github_" + a, r);
  }
  put("emu_" + i + "_install_releasesPath", str(gh.releasesPath, w + ".install.github.releasesPath", /^(latest|tags\/[A-Za-z0-9._-]+)$/, true) || "latest");
  const am = isObj(ins.assetMatch) ? ins.assetMatch : {};
  const inc = list(am.include, w + ".install.assetMatch.include", null, true);
  const exc = list(am.exclude, w + ".install.assetMatch.exclude", null, true);
  inc.concat(exc).forEach((p) => regex(p, w + ".install.assetMatch"));
  if (needGithub) {
    if (repos === 0) fail(w + ".install.github braucht arm64, x86_64 oder any");
    if (inc.length === 0) fail(w + ".install.assetMatch.include darf nicht leer sein");
    if (hosts.length === 0) fail(w + ".install.allowedHosts fehlt");
  }

  const du = isObj(ins.directUrl) ? ins.directUrl : {};
  let urls = 0;
  for (const a of ["arm64", "x86_64", "any"]) {
    const u = str(du[a], w + ".install.directUrl." + a, /^https:\/\/[^\s]+$/, true);
    if (u) {
      urls++;
      const host = u.slice(8).split(/[\/?#]/)[0].toLowerCase();
      if (!hostMatches(host, hosts)) fail(w + ".install.directUrl." + a + ": Server '" + host + "' steht nicht in allowedHosts");
    }
    put("emu_" + i + "_install_directUrl_" + a, u);
  }
  if (needDirect) {
    if (urls === 0) fail(w + ".install.directUrl braucht arm64, x86_64 oder any");
    if (hosts.length === 0) fail(w + ".install.allowedHosts fehlt");
  }
});
folders.forEach((f) => { if (!folderOwner[f]) fail("library.systemFolders: '" + f + "' gehört zu keinem Emulator (systems in emulators)"); });
put("emu_count", data.emulators.length);
process.stdout.write(out.join("\n") + "\n");
JS_END

# Wählt aus einer Release-Antwort der GitHub-API das passende Download-Archiv.
# Aufruf: node -e "$PICK_JS" -- <Datendatei> <Release-JSON> <emulator-id> <arm64|x86_64|any> <1 bei ARM-Hardware>
# Ausgabe (Exit 0): Tag, Dateiname, URL, SHA-256, Größe, Rosetta (0/1) – getrennt mit \037.
# Exit 3: nichts Passendes (auf stderr: "ASSETS: <Dateinamen>"), Exit 2: Antwort unlesbar.
IFS= read -r -d '' PICK_JS <<'JS_END' || true
"use strict";
const fs = require("fs");
const [dataFile, relFile, id, repoArch, hwArm] = process.argv.slice(1);
let data, rel;
try { data = JSON.parse(fs.readFileSync(dataFile, "utf8")); } catch (e) { process.exit(2); }
try { rel = JSON.parse(fs.readFileSync(relFile, "utf8")); } catch (e) { process.exit(2); }
const emu = data.emulators.find((e) => e.id === id);
if (!emu) process.exit(2);
const am = emu.install.assetMatch || {};
const inc = (am.include || []).map((r) => new RegExp(r, "i"));
const exc = (am.exclude || []).map((r) => new RegExp(r, "i"));
const reArm = new RegExp(data.download.archHints.arm64, "i");
const reX64 = new RegExp(data.download.archHints.x86_64, "i");
const reUni = new RegExp(data.download.archHints.universal, "i");
const ext = data.download.extensionOrder.map((r) => new RegExp(r, "i"));
const releases = Array.isArray(rel) ? rel : [rel];
const wanted = repoArch === "any" ? (hwArm === "1" ? "arm64" : "x86_64") : repoArch;
const seen = [];
for (const r of releases) {
  if (!r || typeof r !== "object" || r.draft) continue;
  let best = null;
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    if (!a || typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
    seen.push(a.name);
    if (a.state && a.state !== "uploaded") continue;
    if (!inc.every((re) => re.test(a.name))) continue;
    if (exc.some((re) => re.test(a.name))) continue;
    const isArm = reArm.test(a.name), isX64 = reX64.test(a.name), isUni = reUni.test(a.name);
    let archScore;
    if (isUni) archScore = 2.5;
    else if (wanted === "arm64") archScore = isArm ? 3 : isX64 ? 0 : 2;
    else archScore = isX64 ? 3 : isArm ? -1 : 2;
    if (archScore < 0) continue;   // reiner ARM-Build läuft nicht auf Intel
    let e = ext.findIndex((re) => re.test(a.name));
    e = e < 0 ? 0 : ext.length - e;
    const score = archScore * 100 + e;
    if (!best || score > best.score) best = { a, score, isArm, isX64, isUni };
  }
  if (best) {
    const m = /^sha256:([0-9a-fA-F]{64})$/.exec(typeof best.a.digest === "string" ? best.a.digest : "");
    const rosetta = hwArm === "1" && !best.isUni && !best.isArm && (repoArch === "x86_64" || best.isX64) ? "1" : "0";
    const size = Number.isInteger(best.a.size) && best.a.size > 0 ? String(best.a.size) : "";
    fs.writeSync(1, [r.tag_name || "", best.a.name, best.a.browser_download_url, m ? m[1].toLowerCase() : "", size, rosetta].join("\x1f") + "\n");
    process.exit(0);
  }
}
fs.writeSync(2, "ASSETS: " + seen.slice(0, 8).join(", ") + (seen.length > 8 ? ", …" : "") + "\n");
process.exit(3);
JS_END

# Homebrew-Ordner (Apple Silicon: /opt/homebrew/bin, Intel: /usr/local/bin) liegen in einem frischen Terminal nicht immer
# im PATH, dort aber Node.js. Sie werden hinten angehängt, damit nichts Vorhandenes verdrängt wird.
add_brew_dirs_to_path() {
  local d
  for d in /opt/homebrew/bin /usr/local/bin; do
    [ -d "$d" ] || continue
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
  done
  export PATH
}

load_data() {
  local out rc=0 line k v
  have node || add_brew_dirs_to_path
  have node || { err "Node.js fehlt – ohne Node.js kann ich die Emulator-Daten nicht lesen. 'bash scripts/setup-mac.sh --install-missing --prepare' installiert es."; return 3; }
  [ -f "$DATA_FILE" ] || { err "Datendatei nicht gefunden: $DATA_FILE"; return 3; }
  out="$(node -e "$LOADER_JS" -- "$DATA_FILE" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    err "Die Emulator-Daten sind unbrauchbar:"
    printf '%s\n' "$out" | head -n 5 | while IFS= read -r line; do printf '    %s\n' "$line" >&2; done
    return 3
  fi
  while IFS= read -r line; do
    case "$line" in
      D_*"$TAB"*) ;;
      *) continue ;;
    esac
    k="${line%%"$TAB"*}"
    v="${line#*"$TAB"}"
    case "$k" in *[!A-Za-z0-9_]*) continue ;; esac
    setv "$k" "$v"
  done <<< "$out"
  EMU_COUNT="${D_emu_count:-0}"
  [ "$EMU_COUNT" -gt 0 ] 2>/dev/null || { err "Die Emulator-Daten enthalten keine Emulatoren."; return 3; }
  return 0
}

# ------------------------------------------------------------------ Erkennung ----

detect_arch() {
  [ -z "$HW_ARM" ] || return 0
  # uname -m meldet unter Rosetta x86_64 – sysctl zeigt die echte Hardware.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then HW_ARM=1; else HW_ARM=0; fi
}

# Sammelt alle .app-Pakete in /Applications, ~/Applications und deren direkten Unterordnern.
scan_apps() {
  local d p
  APP_LIST=""
  for d in "$APPS_DIR" "$USER_APPS_DIR"; do
    [ -d "$d" ] || continue
    for p in "$d"/*.app "$d"/*/*.app; do
      [ -d "$p" ] || continue
      APP_LIST="$APP_LIST$p$NL"
    done
  done
}

# Erster Treffer für einen Emulator in APP_LIST → FOUND_PATH (leer = nicht installiert)
find_installed() {
  local re p
  getf "$1" appPattern; re="$REPLY"
  FOUND_PATH=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if re_match_ci "${p##*/}" "$re"; then FOUND_PATH="$p"; return 0; fi
  done <<< "$APP_LIST"
  return 1
}

app_version() {
  local v=""
  have defaults || return 0
  v="$(defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
  [ -n "$v" ] || v="$(defaults read "$1/Contents/Info" CFBundleVersion 2>/dev/null || true)"
  printf '%s' "$v"
}

# Füllt für alle ausgewählten Emulatoren S_path_<i> und zählt: N_INSTALLED, MISSING (Indizes), MISSING_NAMES, MISSING_IDS
classify() {
  local i name id
  N_INSTALLED=0 N_SEL=0 MISSING="" MISSING_NAMES="" MISSING_IDS=""
  for i in $SEL; do
    N_SEL=$((N_SEL + 1))
    getf "$i" name; name="$REPLY"
    getf "$i" id; id="$REPLY"
    if find_installed "$i"; then
      setv "S_path_$i" "$FOUND_PATH"
      N_INSTALLED=$((N_INSTALLED + 1))
    else
      setv "S_path_$i" ""
      MISSING="$MISSING $i"
      MISSING_NAMES="${MISSING_NAMES:+$MISSING_NAMES, }$name"
      MISSING_IDS="${MISSING_IDS:+$MISSING_IDS,}$id"
    fi
  done
}

select_emulators() {
  local i id
  SEL=""
  i=0
  while [ "$i" -lt "$EMU_COUNT" ]; do
    getf "$i" id; id="$REPLY"
    if { [ -z "$OPT_ONLY" ] || in_csv "$id" "$OPT_ONLY"; } && { [ -z "$OPT_SKIP" ] || ! in_csv "$id" "$OPT_SKIP"; }; then
      SEL="$SEL $i"
    fi
    i=$((i + 1))
  done
}

validate_ids() {   # $1 = Liste (Komma), $2 = Optionsname
  local want id i found known=""
  [ -n "$1" ] || return 0
  i=0
  while [ "$i" -lt "$EMU_COUNT" ]; do getf "$i" id; known="${known:+$known, }$REPLY"; i=$((i + 1)); done
  while IFS= read -r want; do
    [ -n "$want" ] || continue
    found=0; i=0
    while [ "$i" -lt "$EMU_COUNT" ]; do
      getf "$i" id
      [ "$REPLY" != "$want" ] || found=1
      i=$((i + 1))
    done
    [ "$found" = 1 ] || usage_error "Unbekannter Emulator '$want' bei $2. Bekannt sind: $known"
  done <<< "${1//,/$NL}"
}

print_table() {
  local i name cons st loc ver w1=8 w2=7 w3=11
  for i in $SEL; do
    getf "$i" name; [ "${#REPLY}" -le "$w1" ] || w1="${#REPLY}"
    getf "$i" consoles; [ "${#REPLY}" -le "$w2" ] || w2="${#REPLY}"
  done
  printf '\n  %s%-*s  %-*s  %-*s  %s%s\n' "$C_BOLD" "$w1" "Emulator" "$w2" "Konsole" "$w3" "Status" "Ort / Version" "$C_RESET"
  for i in $SEL; do
    getf "$i" name; name="$REPLY"
    getf "$i" consoles; cons="$REPLY"
    getv "S_path_$i"; loc="$REPLY"
    if [ -n "$loc" ]; then
      st="installiert"
      ver="$(app_version "$loc")"
      loc="$(shown "$loc")${ver:+  (Version $ver)}"
      printf '  %-*s  %-*s  %s%-*s%s  %s\n' "$w1" "$name" "$w2" "$cons" "$C_GREEN" "$w3" "$st" "$C_RESET" "$loc"
    else
      printf '  %-*s  %-*s  %s%-*s%s  %s\n' "$w1" "$name" "$w2" "$cons" "$C_YELLOW" "$w3" "fehlt" "$C_RESET" "-"
    fi
  done
}

# ------------------------------------------------------------- Zielordner ----

choose_target_dir() {
  [ -z "$TARGET_DIR" ] || return 0
  if [ -d "$APPS_DIR" ] && [ -w "$APPS_DIR" ]; then
    TARGET_DIR="$APPS_DIR"
  elif mkdir -p "$USER_APPS_DIR" 2>/dev/null && [ -w "$USER_APPS_DIR" ]; then
    TARGET_DIR="$USER_APPS_DIR"
    warn "$(shown "$APPS_DIR") ist für dich nicht beschreibbar – die Emulatoren kommen nach $(shown "$USER_APPS_DIR")."
  else
    err "Weder $(shown "$APPS_DIR") noch $(shown "$USER_APPS_DIR") ist beschreibbar – Installation nicht möglich."
    return 1
  fi
  printf '\n'
  info "Installationsordner: $(shown "$TARGET_DIR")"
}

# ----------------------------------------------------------------- Homebrew ----

brew_ready() {
  local b
  have brew && return 0
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      PATH="${b%/*}:$PATH"
      export PATH
      return 0
    fi
  done
  return 1
}

# Homebrew-Cask installieren oder aktualisieren. $1 = Index. Setzt RES/RES_WHY.
method_brew() {
  local i="$1" cask rc=0 dir name managed url
  getf "$i" brewCask; cask="$REPLY"
  getf "$i" name; name="$REPLY"
  getf "$i" downloadUrl; url="$REPLY"
  [ -n "$cask" ] || { RES_WHY="Für $name gibt es keinen Homebrew-Cask"; return 1; }
  if ! brew_ready; then
    if [ -n "$CUR_OLD" ]; then
      RES=current; R_NOTE="Homebrew fehlt – automatisches Update nicht möglich (neue Version: $url)"
      return 0
    fi
    HOMEBREW_HINT=1
    RES_WHY="Homebrew fehlt (wird für $name gebraucht)"
    return 1
  fi
  # Soll nicht nach /Applications installiert werden, sagt Homebrew das über --appdir
  dir="${CUR_OLD:+${CUR_OLD%/*}}"
  dir="${dir:-$TARGET_DIR}"
  if [ -n "$CUR_OLD" ]; then
    managed="$(brew list --cask --versions "$cask" 2>/dev/null || true)"
    if [ -z "$managed" ]; then
      RES=current; R_NOTE="wurde nicht über Homebrew installiert, deshalb lasse ich es, wie es ist (neue Version: $url)"
      return 0
    fi
    info "Homebrew: brew upgrade --cask $cask …"
    (
      # Kein Aufräumen, keine Statistik, keine Tipps; die Paketliste darf sich aktualisieren (sonst sieht "upgrade" nichts Neues).
      # shellcheck disable=SC2030   # gilt absichtlich nur für diesen Aufruf
      export HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1
      if [ "$dir" != "/Applications" ]; then brew upgrade --cask --appdir="$dir" "$cask"; else brew upgrade --cask "$cask"; fi
    ) || rc=$?
    if [ "$rc" -ne 0 ]; then RES_WHY="brew upgrade --cask $cask ist fehlgeschlagen (Exit-Code $rc)"; return 1; fi
    RES=updated
  else
    info "Homebrew: brew install --cask $cask …"
    (
      # Wie in der App: kein Update der ganzen Paketliste vor der Installation (das dauert ohne Ausgabe), kein Aufräumen,
      # keine Statistik. Eine frisch installierte Homebrew ist ohnehin aktuell.
      # shellcheck disable=SC2031   # gilt absichtlich nur für diesen Aufruf
      export HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1
      if [ "$dir" != "/Applications" ]; then brew install --cask --appdir="$dir" "$cask"; else brew install --cask "$cask"; fi
    ) || rc=$?
    if [ "$rc" -ne 0 ]; then RES_WHY="brew install --cask $cask ist fehlgeschlagen (Exit-Code $rc)"; return 1; fi
    RES=installed
  fi
  scan_apps
  if ! find_installed "$i"; then
    RES_WHY="Homebrew meldet Erfolg, aber $name wurde nicht im Programme-Ordner gefunden"
    return 1
  fi
  DEST_APP="$FOUND_PATH"
  return 0
}

# ------------------------------------------------------------ GitHub/Download ----

curl_why() {   # curl-Exit-Code → Klartext
  case "$1" in
    5|6|7) printf 'keine Verbindung (Internet prüfen)' ;;
    47) printf 'zu viele Umleitungen' ;;
    28) printf 'Zeitüberschreitung (zu langsam oder keine Verbindung)' ;;
    18|56) printf 'der Download wurde unterbrochen und ist unvollständig' ;;
    22) printf 'der Server meldet einen Fehler (Datei nicht gefunden?)' ;;
    35|51|58|59|60|77|83) printf 'sichere Verbindung (TLS) nicht möglich' ;;
    23) printf 'Datei konnte nicht geschrieben werden (Speicherplatz?)' ;;
    *) printf 'curl-Fehler %s' "$1" ;;
  esac
}

curl_proto() { if [ "$TEST_MODE" = 1 ]; then printf '=http,https'; else printf '=https'; fi; }

# GitHub-API abfragen. $1 = Pfad, $2 = Zieldatei. Setzt API_STATUS (HTTP-Code oder 000) und API_MSG.
gh_api_get() {
  local url="$GITHUB_API$1" dest="$2" proto code="" rc=0 host
  proto="$(curl_proto)"
  API_STATUS="000" API_MSG=""
  host="$(url_host "$GITHUB_API")" || { API_MSG="Die GitHub-Adresse ist nicht zulässig (nur https): $GITHUB_API"; return 1; }
  host_allowed "$host" "$CUR_HOSTS" || { API_MSG="Der Server '$host' steht nicht auf der Liste der erlaubten Server"; return 1; }
  : > "$dest"
  set -- -sS -L --connect-timeout 20 --max-time 90 --proto "$proto" --proto-redir "$proto" \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -o "$dest" -w '%{http_code}'
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    # Das Token steht nur in einer privaten Datei, nicht in der Prozessliste.
    if [ ! -f "$WORK_DIR/gh-auth" ]; then
      ( umask 077; printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" > "$WORK_DIR/gh-auth" )
    fi
    set -- "$@" -H "@$WORK_DIR/gh-auth"
  fi
  code="$(curl "$@" "$url" 2>"$WORK_DIR/curl.err")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$code" ]; then
    API_STATUS="000"
    API_MSG="GitHub nicht erreichbar: $(curl_why "$rc")"
    return 1
  fi
  API_STATUS="$code"
  API_MSG="$(sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dest" 2>/dev/null | head -n 1)"
  [ "$code" = "200" ]
}

api_why() {   # API_STATUS/API_MSG → Klartext
  case "$API_STATUS" in
    000) printf '%s' "$API_MSG" ;;
    403|429)
      case "$API_MSG" in
        *[Rr]ate*|*limit*) printf 'GitHub begrenzt gerade die Anfragen (Rate-Limit) – später erneut versuchen oder GITHUB_TOKEN setzen' ;;
        *) printf 'GitHub verweigert die Abfrage (HTTP %s)' "$API_STATUS" ;;
      esac
      ;;
    401) printf 'GitHub lehnt das GITHUB_TOKEN ab (HTTP 401) – Token prüfen oder GITHUB_TOKEN entfernen' ;;
    404) printf 'bei GitHub nicht gefunden (HTTP 404)' ;;
    5??) printf 'GitHub meldet einen Fehler (HTTP %s)' "$API_STATUS" ;;
    *) printf 'unerwartete Antwort von GitHub (HTTP %s)' "$API_STATUS" ;;
  esac
}

# Asset wählen. $1 = Index, $2 = Release-JSON, $3 = arm64|x86_64|any. Setzt R_* (0 = gefunden, 1 = nichts Passendes, 2 = unlesbar)
pick_asset() {
  local id out rc=0 errtxt
  getf "$1" id; id="$REPLY"
  R_TAG="" R_NAME="" R_URL="" R_SHA="" R_SIZE="" R_ROSETTA="0" R_ASSETS=""
  out="$(node -e "$PICK_JS" -- "$DATA_FILE" "$2" "$id" "$3" "$HW_ARM" 2>"$WORK_DIR/pick.err")" || rc=$?
  case "$rc" in
    0) IFS="$US" read -r R_TAG R_NAME R_URL R_SHA R_SIZE R_ROSETTA <<< "$out"; return 0 ;;
    3)
      errtxt="$(cat "$WORK_DIR/pick.err" 2>/dev/null || true)"
      R_ASSETS="${errtxt#ASSETS: }"
      return 1
      ;;
    *) return 2 ;;
  esac
}

# Eine GitHub-Quelle durchsuchen. $1 = Index, $2 = owner/repo, $3 = Bauart, $4 = Pfad unter /releases/.
# 0 = Asset gefunden (R_*), 1 = in diesem Repo nichts Passendes, 2 = GitHub nicht brauchbar (Netz/Rate-Limit)
try_repo() {
  local i="$1" repo="$2" arch="$3" path="$4" rc why1=""
  if gh_api_get "/repos/$repo/releases/$path" "$WORK_DIR/rel1.json"; then
    rc=0
    pick_asset "$i" "$WORK_DIR/rel1.json" "$arch" || rc=$?
    [ "$rc" -ne 0 ] || { R_REPO="$repo"; return 0; }
    if [ "$rc" -eq 2 ]; then
      why1="Die Antwort von GitHub zu $repo war nicht lesbar (kein JSON – Anmeldeseite eines WLANs?)"
    else
      why1="In $repo gibt es kein passendes Download-Archiv${R_ASSETS:+ (vorhanden: $R_ASSETS)}"
    fi
  else
    case "$API_STATUS" in
      404) why1="$repo: Veröffentlichung '$path' $(api_why)" ;;
      *) RES_WHY="$(api_why)"; return 2 ;;
    esac
  fi
  # Nichts gefunden: die letzten 10 Veröffentlichungen durchsuchen
  if gh_api_get "/repos/$repo/releases?per_page=10" "$WORK_DIR/rel2.json"; then
    rc=0
    pick_asset "$i" "$WORK_DIR/rel2.json" "$arch" || rc=$?
    [ "$rc" -ne 0 ] || { R_REPO="$repo"; return 0; }
    RES_WHY="$why1 – auch in den letzten 10 Veröffentlichungen nichts Passendes"
    return 1
  fi
  case "$API_STATUS" in
    404) RES_WHY="$why1"; return 1 ;;
    *) RES_WHY="$(api_why)"; return 2 ;;
  esac
}

# GitHub-Release für einen Emulator bestimmen (Bauart passend zur Hardware). Setzt R_*. 0 = ok
resolve_github() {
  local i="$1" a x n path whys="" rc cand c arch repo tried=0
  getf "$i" install_github_arm64; a="$REPLY"
  getf "$i" install_github_x86_64; x="$REPLY"
  getf "$i" install_github_any; n="$REPLY"
  getf "$i" install_releasesPath; path="${REPLY:-latest}"
  getf "$i" install_allowedHosts; CUR_HOSTS="$REPLY"
  if [ -n "$a" ] && [ "$a" = "$x" ]; then n="$a"; a=""; x=""; fi
  # Reihenfolge der Quellen: ARM-Hardware zuerst der ARM-Build, zuletzt der Intel-Build (Rosetta)
  if [ "$HW_ARM" = 1 ]; then cand="arm64:$a any:$n x86_64:$x"; else cand="x86_64:$x any:$n"; fi
  for c in $cand; do
    arch="${c%%:*}"; repo="${c#*:}"
    [ -n "$repo" ] || continue
    tried=$((tried + 1))
    rc=0
    try_repo "$i" "$repo" "$arch" "$path" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ -n "$whys" ] && [ "$R_ROSETTA" = "1" ]; then R_NOTE="Kein eigener Apple-Silicon-Build gefunden – ich nehme den Intel-Build."; fi
      return 0
    fi
    whys="${whys:+$whys; }$RES_WHY"
    [ "$rc" -ne 2 ] || break
  done
  if [ "$tried" -eq 0 ]; then
    RES_WHY="Für diese Mac-Bauart ist keine GitHub-Quelle angegeben"
  else
    RES_WHY="$whys"
  fi
  return 1
}

# Datei laden und prüfen. $1 = Index, $2 = URL, $3 = Dateiname (ungeprüft), $4 = SHA-256 oder leer, $5 = Größe oder leer.
# Setzt DL_FILE. 0 = ok; sonst RES_WHY.
download_asset() {
  local i="$1" url="$2" name="$3" want_sha="$4" want_size="$5" host fhost hosts safe part final="" rc=0 got proto
  getf "$i" install_allowedHosts; hosts="$REPLY"
  host="$(url_host "$url")" || { RES_WHY="Die Download-Adresse ist nicht zulässig (nur https): $url"; return 1; }
  host_allowed "$host" "$hosts" || { RES_WHY="Der Download-Server '$host' steht nicht auf der Liste der erlaubten Server"; return 1; }
  safe="${name//[^A-Za-z0-9._+-]/_}"
  case "$safe" in ''|.*|-*) safe="datei-$safe" ;; esac
  part="$WORK_DIR/dl/$safe.part"
  DL_FILE="$WORK_DIR/dl/$safe"
  proto="$(curl_proto)"
  if [ -n "$want_size" ]; then info "Lade $name ($(fmt_size "$want_size")) …"; else info "Lade $name …"; fi
  set -- -fL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --proto "$proto" --proto-redir "$proto" \
    -o "$part" -w '%{url_effective}'
  if [ -t 2 ] && [ "$OPT_QUIET" = 0 ]; then
    set -- "$@" --progress-bar
    final="$(curl "$@" "$url")" || rc=$?
  else
    set -- "$@" -sS
    final="$(curl "$@" "$url" 2>"$WORK_DIR/curl.err")" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    RES_WHY="Download fehlgeschlagen: $(curl_why "$rc")"
    safe_rm "$part" || true
    return 1
  fi
  fhost="$(url_host "$final")" || fhost=""
  if ! host_allowed "$fhost" "$hosts"; then
    RES_WHY="Der Download wurde auf einen nicht erlaubten Server umgeleitet (${fhost:-unbekannt}) und verworfen"
    safe_rm "$part" || true
    return 1
  fi
  if [ -n "$want_size" ]; then
    got="$(file_size "$part")"
    if [ "$got" != "$want_size" ]; then
      RES_WHY="Der Download ist unvollständig ($(fmt_size "$got") statt $(fmt_size "$want_size"))"
      safe_rm "$part" || true
      return 1
    fi
  fi
  if [ -n "$want_sha" ]; then
    got="$(sha256_of "$part")" || got=""
    if [ -z "$got" ]; then
      RES_WHY="Die Prüfsumme (SHA-256) ließ sich nicht berechnen"
      safe_rm "$part" || true
      return 1
    fi
    if [ "$got" != "$want_sha" ]; then
      RES_WHY="Die Prüfsumme (SHA-256) stimmt nicht – Datei verworfen"
      safe_rm "$part" || true
      return 1
    fi
    dim "Prüfsumme (SHA-256) stimmt."
  else
    dim "Der Anbieter nennt keine Prüfsumme – nur die Verbindung (https) ist abgesichert."
  fi
  mv "$part" "$DL_FILE" || { RES_WHY="Datei konnte nicht abgelegt werden"; return 1; }
  return 0
}

# ------------------------------------------------------------ Entpacken/Einbauen ----

archive_kind() {   # Dateiname → dmg | zip | tar | 7z | "" (in REPLY)
  local n
  n="$(lower "$1")"
  case "$n" in
    *.dmg) REPLY=dmg ;;
    *.zip) REPLY=zip ;;
    *.tar.gz|*.tgz|*.tar.xz|*.txz|*.tar.bz2|*.tbz2|*.tar) REPLY=tar ;;
    *.7z) REPLY=7z ;;
    *) REPLY="" ;;
  esac
}

ensure_7z() {
  local c
  for c in 7zz 7z 7za 7zr; do
    if have "$c"; then SEVENZ="$c"; return 0; fi
  done
  return 1
}

# Archiv entpacken. $1 = Datei, $2 = leerer Zielordner. 0 = ok; sonst RES_WHY
unpack() {
  local file="$1" dest="$2" kind rc=0
  archive_kind "$file"; kind="$REPLY"
  case "$kind" in
    zip)
      ditto -x -k "$file" "$dest" >/dev/null 2>&1 || { RES_WHY="Das ZIP-Archiv ließ sich nicht entpacken (unvollständig oder beschädigt)"; return 1; }
      ;;
    tar)
      tar -xf "$file" -C "$dest" >/dev/null 2>&1 || { RES_WHY="Das Archiv ließ sich nicht entpacken (unvollständig oder beschädigt)"; return 1; }
      ;;
    7z)
      if ! ensure_7z; then
        # macOS-tar (libarchive) kann 7z oft selbst lesen
        if tar -xf "$file" -C "$dest" >/dev/null 2>&1 && [ -n "$(ls -A "$dest" 2>/dev/null || true)" ]; then return 0; fi
        safe_rm "$dest" || true; mkdir -p "$dest"
        if brew_ready; then
          info "Zum Entpacken von .7z fehlt ein Programm – installiere es mit Homebrew (brew install sevenzip) …"
          brew install sevenzip >/dev/null 2>&1 || true
        fi
        ensure_7z || { RES_WHY="Zum Entpacken von .7z-Dateien fehlt ein Programm (Homebrew-Paket 'sevenzip')"; HOMEBREW_HINT=1; return 1; }
      fi
      "$SEVENZ" x -y "-o$dest" "$file" >/dev/null 2>&1 || rc=$?
      [ "$rc" -eq 0 ] || { RES_WHY="Das 7z-Archiv ließ sich nicht entpacken (unvollständig oder beschädigt)"; return 1; }
      ;;
    *) RES_WHY="Unbekanntes Archivformat: ${file##*/}"; return 1 ;;
  esac
  return 0
}

plist_get() {   # $1 = App, $2 = Schlüssel
  have defaults || return 1
  defaults read "$1/Contents/Info" "$2" 2>/dev/null
}

# Gehört die App zum Emulator? Ja, wenn ihr Name zu appPattern passt oder ihre Bundle-ID in bundleIds steht. $1 = Index, $2 = App
app_matches() {
  local re bid b
  getf "$1" appPattern; re="$REPLY"
  if re_match_ci "${2##*/}" "$re"; then return 0; fi
  bid="$(plist_get "$2" CFBundleIdentifier || true)"
  [ -n "$bid" ] || return 1
  bid="$(lower "$bid")"
  getf "$1" bundleIds
  split_list "$REPLY"
  for b in ${LIST[@]+"${LIST[@]}"}; do
    [ "$(lower "$b")" != "$bid" ] || return 0
  done
  return 1
}

# .app im Ordner suchen (bis Tiefe 4): zuerst passender Name, dann passende Bundle-ID, sonst die erste → APP_SRC
find_app_in() {
  local re p first="" by_name="" by_id=""
  getf "$1" appPattern; re="$REPLY"
  APP_SRC=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in */__MACOSX/*) continue ;; esac
    [ -n "$first" ] || first="$p"
    if [ -z "$by_name" ] && re_match_ci "${p##*/}" "$re"; then by_name="$p"; fi
    if [ -z "$by_id" ] && [ -z "$by_name" ] && app_matches "$1" "$p"; then by_id="$p"; fi
  done <<< "$(find "$2" -maxdepth 4 -type d -name '*.app' -prune -print 2>/dev/null || true)"
  APP_SRC="${by_name:-${by_id:-$first}}"
  [ -n "$APP_SRC" ]
}

# Die .app in $APP_SRC an ihren Platz bringen. $1 = Index. Alte Version wird erst beiseite gelegt und nur nach Erfolg gelöscht.
install_bundle() {
  local i="$1" dest_dir dest_name re name final stage backup
  getf "$i" appPattern; re="$REPLY"
  getf "$i" name; name="$REPLY"
  if ! app_matches "$i" "$APP_SRC"; then
    RES_WHY="Das Archiv enthält '${APP_SRC##*/}' – weder der Name noch die Bundle-ID passen zu $name"
    return 1
  fi
  if [ -n "$CUR_OLD" ]; then
    dest_dir="${CUR_OLD%/*}"
    dest_name="${CUR_OLD##*/}"
  else
    dest_dir="$TARGET_DIR"
    # sauberer Name (wie ihn auch der Homebrew-Cask vergibt); passt der nicht zum Muster, bleibt der Name aus dem Archiv
    if re_match_ci "$name.app" "$re"; then dest_name="$name.app"; else dest_name="${APP_SRC##*/}"; fi
  fi
  if ! re_match_ci "$dest_name" "$re"; then
    RES_WHY="Der Name '$dest_name' würde von JellyStation nicht gefunden (erwartet: $re)"
    return 1
  fi
  if [ ! -d "$dest_dir" ] || [ ! -w "$dest_dir" ]; then
    RES_WHY="Der Ordner ${dest_dir:-?} ist nicht beschreibbar"
    return 1
  fi
  if [ "${APP_SRC##*/}" != "$dest_name" ]; then dim "App-Name im Archiv: ${APP_SRC##*/} → installiert als $dest_name"; fi

  final="$dest_dir/$dest_name"
  stage="$dest_dir/.$dest_name.jellystation-new.$$"
  backup="$dest_dir/.$dest_name.jellystation-old.$$"
  STAGE_PATH="$stage"
  safe_rm "$stage" || true
  info "Kopiere nach $(shown "$final") …"
  if ! ditto "$APP_SRC" "$stage" >/dev/null 2>&1 || [ ! -d "$stage/Contents" ]; then
    RES_WHY="Kopieren in den Programme-Ordner fehlgeschlagen (Speicherplatz? Rechte?)"
    safe_rm "$stage" || true; STAGE_PATH=""
    return 1
  fi
  if [ -e "$final" ] || [ -L "$final" ]; then
    BACKUP_PATH="$backup" BACKUP_FINAL="$final"
    if ! mv "$final" "$backup" 2>/dev/null; then
      BACKUP_PATH="" BACKUP_FINAL=""
      RES_WHY="Die vorhandene App ließ sich nicht ersetzen (läuft sie gerade? Rechte?)"
      safe_rm "$stage" || true; STAGE_PATH=""
      return 1
    fi
  fi
  if mv "$stage" "$final" 2>/dev/null; then
    STAGE_PATH=""
    if [ -n "$BACKUP_PATH" ]; then safe_rm "$BACKUP_PATH" || true; BACKUP_PATH="" BACKUP_FINAL=""; fi
  else
    RES_WHY="Die neue App ließ sich nicht an ihren Platz bringen"
    restore_backup
    safe_rm "$stage" || true; STAGE_PATH=""
    return 1
  fi
  # Von curl geladene Dateien sind nicht "unter Quarantäne"; falls doch, wird das Merkmal entfernt (Fehler egal).
  xattr -dr com.apple.quarantine "$final" >/dev/null 2>&1 || true
  DEST_APP="$final"
  return 0
}

# Archiv → App → Programme-Ordner. $1 = Index, $2 = heruntergeladene Datei
install_archive() {
  local i="$1" file="$2" kind xdir rc=0 mnt
  archive_kind "$file"; kind="$REPLY"
  if [ "$kind" = dmg ]; then
    mnt="$WORK_DIR/mnt/dmg"
    mkdir -p "$mnt"
    if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$file" </dev/null >/dev/null 2>"$WORK_DIR/hdiutil.err"; then
      RES_WHY="Das Disk-Image (.dmg) ließ sich nicht öffnen"
      return 1
    fi
    MOUNT_POINT="$mnt"
    if find_app_in "$i" "$mnt"; then install_bundle "$i" || rc=1; else RES_WHY="Im Disk-Image wurde keine App gefunden"; rc=1; fi
    detach_dmg
    return "$rc"
  fi
  xdir="$WORK_DIR/x/$i"
  mkdir -p "$xdir"
  unpack "$file" "$xdir" || return 1
  find_app_in "$i" "$xdir" || { RES_WHY="Im Download wurde keine App (.app) gefunden"; return 1; }
  install_bundle "$i"
}

# ------------------------------------------------------------ Merkdatei ----

state_get() {   # $1 = Emulator-ID, $2 = Feld (1 Tag, 2 Datei, 3 SHA-256, 4 Größe, 5 Zeit) → REPLY
  REPLY=""
  [ -f "$STATE_FILE" ] || return 0
  REPLY="$(awk -F '\t' -v id="$1" -v f="$2" '$1 == id { v = $(f + 1) } END { print v }' "$STATE_FILE" 2>/dev/null || true)"
}

state_put() {   # id tag datei sha größe
  local tmp="$STATE_FILE.tmp.$$"
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  {
    if [ -f "$STATE_FILE" ]; then awk -F '\t' -v id="$1" '$1 != id' "$STATE_FILE"; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$(date +%s)"
  } > "$tmp" 2>/dev/null && mv "$tmp" "$STATE_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# ------------------------------------------------------- Installation je Art ----

override_url() {   # $1 = ID → REPLY (leer, wenn nicht gesetzt)
  local up n
  up="$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
  n="JELLYSTATION_URL_$up"
  REPLY="${!n:-}"
}

# Download-Adresse für "direct-url" je nach Hardware. $1 = Index → REPLY, R_ROSETTA
direct_url_for() {
  local a x n
  getf "$1" install_directUrl_arm64; a="$REPLY"
  getf "$1" install_directUrl_x86_64; x="$REPLY"
  getf "$1" install_directUrl_any; n="$REPLY"
  R_ROSETTA=0
  if [ "$HW_ARM" = 1 ]; then
    if [ -n "$a" ]; then REPLY="$a"; elif [ -n "$n" ]; then REPLY="$n"; else REPLY="$x"; [ -z "$x" ] || R_ROSETTA=1; fi
  else
    if [ -n "$x" ]; then REPLY="$x"; else REPLY="$n"; fi
  fi
}

# Merkt sich, ob die Datei, die gerade geladen werden soll, dieselbe ist wie bei der letzten Installation durch dieses Skript.
# Rückgabe: 0 = gleich (aktuell), 1 = anders/unbekannt, 2 = nicht von JellyStation installiert
same_as_installed() {   # $1 = ID, $2 = Dateiname, $3 = SHA-256 oder leer, $4 = Größe oder leer
  local old_name old_sha old_size
  state_get "$1" 2; old_name="$REPLY"
  state_get "$1" 3; old_sha="$REPLY"
  state_get "$1" 4; old_size="$REPLY"
  [ -n "$old_name" ] || return 2
  [ "$old_name" = "$2" ] || return 1
  if [ -n "$3" ]; then
    [ "$old_sha" = "$3" ] && return 0
  elif [ -n "$4" ]; then
    [ "$old_size" = "$4" ] && return 0
  fi
  return 1
}

# "github-release": $1 = Index
method_github() {
  local i="$1" id same=0
  getf "$i" id; id="$REPLY"
  R_TAG="" R_NAME="" R_URL="" R_SHA="" R_SIZE="" R_ROSETTA=0 R_NOTE="" R_REPO=""
  if [ "$OVERRIDE_ACTIVE" = 1 ] && [ -n "$OVERRIDE_URL" ]; then
    R_URL="$OVERRIDE_URL"; R_NAME="${R_URL##*/}"; R_NAME="${R_NAME%%[?#]*}"; R_REPO="eigene Adresse ($(url_host "$R_URL" || printf '?'))"
  else
    resolve_github "$i" || return 1
  fi
  if [ -n "$CUR_OLD" ]; then
    same_as_installed "$id" "$R_NAME" "$R_SHA" "$R_SIZE" || same=$?
    if [ "$same" -eq 2 ]; then
      RES=current; R_NOTE="wurde nicht von JellyStation installiert, deshalb lasse ich es, wie es ist"
      return 0
    fi
    if [ "$same" -eq 0 ]; then RES=current; return 0; fi
  fi
  info "Quelle: ${R_REPO:-GitHub}${R_TAG:+, Version $R_TAG}"
  [ "$R_ROSETTA" != 1 ] || EMU_ROSETTA_NOTE=1
  [ -z "$R_NOTE" ] || { warn "$R_NOTE"; R_NOTE=""; }
  download_asset "$i" "$R_URL" "$R_NAME" "$R_SHA" "$R_SIZE" || return 1
  install_archive "$i" "$DL_FILE" || return 1
  state_put "$id" "$R_TAG" "$R_NAME" "$R_SHA" "$R_SIZE"
  if [ -n "$CUR_OLD" ]; then RES=updated; else RES=installed; fi
  return 0
}

# "direct-url": $1 = Index
method_direct() {
  local i="$1" id url name sha old_sha known
  getf "$i" id; id="$REPLY"
  R_TAG="" R_NAME="" R_URL="" R_SHA="" R_SIZE="" R_NOTE="" R_ROSETTA=0
  if [ "$OVERRIDE_ACTIVE" = 1 ] && [ -n "$OVERRIDE_URL" ]; then url="$OVERRIDE_URL"; R_ROSETTA=0; else direct_url_for "$i"; url="$REPLY"; fi
  [ -n "$url" ] || { RES_WHY="Für diese Mac-Bauart ist keine Download-Adresse angegeben"; return 1; }
  name="${url##*/}"; name="${name%%[?#]*}"
  if [ "$R_ROSETTA" = 1 ]; then
    EMU_ROSETTA_NOTE=1
    warn "Kein eigener Apple-Silicon-Build angegeben – ich nehme den Intel-Build."
  fi
  R_URL="$url"; R_NAME="$name"
  info "Quelle: $(url_host "$url" || printf '?')"
  if [ -n "$CUR_OLD" ]; then
    state_get "$id" 2; known="$REPLY"
    if [ -z "$known" ]; then
      RES=current; R_NOTE="wurde nicht von JellyStation installiert, deshalb lasse ich es, wie es ist"
      return 0
    fi
  fi
  download_asset "$i" "$url" "$name" "" "" || return 1
  sha="$(sha256_of "$DL_FILE")" || sha=""
  if [ -n "$CUR_OLD" ]; then
    state_get "$id" 3; old_sha="$REPLY"
    if [ -n "$sha" ] && [ "$sha" = "$old_sha" ]; then RES=current; return 0; fi
  fi
  install_archive "$i" "$DL_FILE" || return 1
  state_put "$id" "direkt" "$name" "$sha" ""
  if [ -n "$CUR_OLD" ]; then RES=updated; else RES=installed; fi
  return 0
}

# Eine Installationsart ausprobieren. $1 = Index, $2 = Art. 0 = ok (RES gesetzt), sonst RES_WHY.
try_method() {
  RES_WHY=""
  case "$2" in
    brew-cask) method_brew "$1" ;;
    github-release) method_github "$1" ;;
    direct-url) method_direct "$1" ;;
    *) RES_WHY="Dafür gibt es keinen automatischen Weg"; return 1 ;;
  esac
}

# Einen Emulator installieren/aktualisieren (Hauptweg, dann Rückfälle). Setzt RES = installed|updated|current|failed.
install_one() {
  local i="$1" kind k why1="" fbs id
  RES=failed; R_NOTE=""; DEST_APP=""
  getf "$i" id; id="$REPLY"
  getf "$i" install_kind; kind="$REPLY"
  getf "$i" install_fallback; fbs="$REPLY"
  # Eine eigene Adresse (JELLYSTATION_URL_<ID>) gilt nur für den Hauptweg; Rückfälle nutzen die normalen Quellen.
  override_url "$id"; OVERRIDE_URL="$REPLY"
  OVERRIDE_ACTIVE=1
  if try_method "$i" "$kind"; then OVERRIDE_ACTIVE=0; return 0; fi
  OVERRIDE_ACTIVE=0
  why1="$RES_WHY"
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    warn "$why1 – versuche einen anderen Weg …"
    # Eine halbe Installation des ersten Wegs wird nie stehen gelassen (install_bundle räumt selbst auf).
    if try_method "$i" "$k"; then return 0; fi
    why1="$RES_WHY"
  done <<< "${fbs//$RS/$NL}"
  RES=failed
  RES_WHY="$why1"
  return 1
}

# ------------------------------------------------------------ Ordner/BIOS ----

protect_in_repo() {   # $1 = Ordner; liegt er im JellyStation-Programmordner, wird er von Git ignoriert (nur lokal)
  local dir="$1" repo real rel ex
  repo="$(cd -P "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)" || return 0
  real="$(cd -P "$dir" 2>/dev/null && pwd -P)" || return 0
  case "$real" in "$repo"/*) ;; *) return 0 ;; esac
  [ -e "$repo/.git" ] || return 0
  rel="${real#"$repo"/}"
  ex="$(git -C "$repo" rev-parse --git-path info/exclude 2>/dev/null || true)"
  if [ -z "$ex" ]; then
    [ -d "$repo/.git" ] || return 0
    ex=".git/info/exclude"
  fi
  case "$ex" in /*) ;; *) ex="$repo/$ex" ;; esac
  # Ohne abschließenden Schrägstrich: gilt dann auch, wenn der Ordner ein Link auf eine andere Platte ist
  if ! grep -qxF -e "/$rel" -e "/$rel/" "$ex" 2>/dev/null; then
    mkdir -p "${ex%/*}" 2>/dev/null || return 0
    printf '/%s\n' "$rel" >> "$ex" 2>/dev/null || return 0
    dim "$(shown "$real") wird von Git ignoriert (nur auf diesem Mac), damit Updates deine Dateien nie anfassen."
  fi
}

write_bios_readme() {   # $1 = Index, $2 = Ordner
  local i="$1" dir="$2" name cons note setup readme dirs d
  readme="$dir/README.txt"
  [ ! -e "$readme" ] || return 0
  getf "$i" name; name="$REPLY"
  getf "$i" consoles; cons="$REPLY"
  getf "$i" biosNote; note="$REPLY"
  getf "$i" setupNote; setup="$REPLY"
  getf "$i" appSupportDirs; dirs="$REPLY"
  {
    printf 'JellyStation – BIOS und Firmware für %s (%s)\n' "$name" "$cons"
    printf '%s\n\n' "================================================================"
    printf '%s\n\n' "WICHTIG: BIOS- und Firmware-Dateien gehören den Konsolenherstellern. JellyStation liefert sie NICHT mit und lädt sie auch nicht herunter. Du musst sie selbst besorgen (zum Beispiel von deiner eigenen Konsole sichern)." | fold -s -w 78 | sed 's/[[:space:]]*$//'
    if [ -n "$note" ]; then
      printf 'Was wird gebraucht?\n'
      printf '%s\n\n' "$note" | fold -s -w 78 | sed 's/[[:space:]]*$//'
    fi
    if [ -n "$dirs" ]; then
      printf 'Wohin damit?\n'
      split_list "$dirs"
      for d in ${LIST[@]+"${LIST[@]}"}; do
        printf '  %s\n' "$(expand_home "$d")"
      done
      printf '  (Dieser Ordner wurde von JellyStation angelegt. %s sucht die Dateien dort.)\n\n' "$name"
    fi
    if [ -n "$setup" ]; then
      printf 'Einrichtung:\n'
      printf '%s\n\n' "$setup" | fold -s -w 78 | sed 's/[[:space:]]*$//'
    fi
    printf '%s\n' "Dieser Ordner hier ist nur eine Ablage und Merkhilfe – JellyStation legt nichts davon selbst an die richtige Stelle." | fold -s -w 78 | sed 's/[[:space:]]*$//'
  } > "$readme" 2>/dev/null || true
}

make_folders() {
  local base bios i name f d made=0 sys_list="" rdir wanted=""
  base="$(expand_home "$D_lib_baseDir")"
  bios="$(expand_home "$D_lib_biosDir")"
  if [ ! -d "$base" ]; then
    mkdir -p "$base" 2>/dev/null || { warn "Der Ordner $(shown "$base") ließ sich nicht anlegen."; return 0; }
    made=$((made + 1))
  fi
  # Systemordner der ausgewählten Emulatoren, in der Reihenfolge der Datendatei
  for i in $SEL; do getf "$i" folders; wanted="$wanted$RS$REPLY"; done
  wanted="$wanted$RS"
  split_list "$D_lib_systemFolders"
  for f in ${LIST[@]+"${LIST[@]}"}; do
    case "$wanted" in *"$RS$f$RS"*|*"$RS$f") ;; *) continue ;; esac
    if [ ! -d "$base/$f" ]; then mkdir -p "$base/$f" 2>/dev/null && made=$((made + 1)); fi
    sys_list="${sys_list:+$sys_list, }$f"
  done
  for i in $SEL; do
    getf "$i" name; name="$REPLY"
    rdir="$bios/$name"
    if [ ! -d "$rdir" ]; then mkdir -p "$rdir" 2>/dev/null && made=$((made + 1)); fi
    [ ! -d "$rdir" ] || write_bios_readme "$i" "$rdir"
    getf "$i" appSupportDirs
    split_list "$REPLY"
    for d in ${LIST[@]+"${LIST[@]}"}; do
      d="$(expand_home "$d")"
      if [ ! -d "$d" ]; then mkdir -p "$d" 2>/dev/null && made=$((made + 1)); fi
    done
  done
  protect_in_repo "$base"
  protect_in_repo "$bios"
  if [ "$made" -gt 0 ] || [ "$OPT_QUIET" = 0 ]; then
    heading "Ordner für Spiele und BIOS"
    ok "Spiele:  $(shown "$base")/<System>/   ($sys_list)"
    ok "BIOS-Hinweise:  $(shown "$bios")/<Emulator>/README.txt"
    [ "$made" -eq 0 ] || dim "$made Ordner neu angelegt; vorhandene Dateien blieben unberührt."
    printf '\n  Jetzt noch: Spiele in %s/<System>/ ablegen (z. B. %s/PS2/).\n' "$(shown "$base")" "$(shown "$base")"
    printf '  BIOS/Firmware (nicht enthalten) siehe %s/<Emulator>/README.txt\n' "$(shown "$bios")"
  fi
  return 0
}

# --------------------------------------------------------------------- main ----

confirm_install() {   # $1 = Namen der fehlenden Emulatoren
  local answer=""
  [ "$OPT_YES" = 1 ] && return 0
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\n  Fehlende Emulatoren jetzt installieren: %s? [J/n] ' "$1"
    read -r answer || answer=""
    case "$answer" in
      ""|[JjYy]*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0   # ohne Terminal nicht blockieren: es gilt "Ja"
}

manual_line() {   # $1 = Index → "Name → Adresse (Hinweis)"
  local name url
  getf "$1" name; name="$REPLY"
  getf "$1" downloadUrl; url="$REPLY"
  printf '%s → %s  (die App danach in %s ablegen)' "$name" "$url" "$(shown "${TARGET_DIR:-$APPS_DIR}")"
}

parse_args() {
  local ONLY_SET=0 SKIP_SET=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) OPT_CHECK=1 ;;
      -y|--yes) OPT_YES=1 ;;
      --update) OPT_UPDATE=1 ;;
      --only) [ $# -ge 2 ] || usage_error "--only braucht eine Liste, z. B.  --only rpcs3,pcsx2"; OPT_ONLY="$2"; ONLY_SET=1; shift ;;
      --only=*) OPT_ONLY="${1#--only=}"; ONLY_SET=1 ;;
      --skip) [ $# -ge 2 ] || usage_error "--skip braucht eine Liste, z. B.  --skip dolphin"; OPT_SKIP="$2"; SKIP_SET=1; shift ;;
      --skip=*) OPT_SKIP="${1#--skip=}"; SKIP_SET=1 ;;
      --no-folders) OPT_FOLDERS=0 ;;
      -q|--quiet) OPT_QUIET=1 ;;
      --porcelain) OPT_PORCELAIN=1 ;;
      --needs-brew) OPT_NEEDS_BREW=1 ;;
      --validate-data) OPT_VALIDATE=1 ;;
      -h|--help) print_help; exit 0 ;;
      *) usage_error "Unbekannte Option: $1" ;;
    esac
    shift
  done
  OPT_ONLY="$(lower "${OPT_ONLY// /}")"
  OPT_SKIP="$(lower "${OPT_SKIP// /}")"
  if [ "$ONLY_SET" = 1 ] && [ -z "${OPT_ONLY//,/}" ]; then usage_error "--only braucht eine Liste, z. B.  --only rpcs3,pcsx2"; fi
  if [ "$SKIP_SET" = 1 ] && [ -z "${OPT_SKIP//,/}" ]; then usage_error "--skip braucht eine Liste, z. B.  --skip dolphin"; fi
  if [ "$OPT_CHECK" = 1 ] && [ "$OPT_UPDATE" = 1 ]; then usage_error "--check ändert nichts und lässt sich nicht mit --update kombinieren."; fi
  if [ "$OPT_PORCELAIN" = 1 ] && [ "$OPT_CHECK" = 0 ]; then usage_error "--porcelain gibt es nur zusammen mit --check."; fi
}

# Maschinenlesbare Zeilen für andere Skripte (--check --porcelain)
print_porcelain() {
  local man="" count=0 i first=""
  for i in $MISSING; do count=$((count + 1)); [ -n "$first" ] || first="$i"; done
  # Genau ein fehlender Emulator: seine Download-Seite gleich mitgeben
  if [ "$count" -eq 1 ]; then getf "$first" downloadUrl; man="$REPLY"; fi
  printf 'total=%s\ninstalled=%s\nmissing=%s\nmissing_names=%s\nmanual=%s\n' "$N_SEL" "$N_INSTALLED" "$MISSING_IDS" "$MISSING_NAMES" "$man"
}

print_porcelain_empty() { printf 'total=0\ninstalled=0\nmissing=\nmissing_names=\nmanual=\n'; }

# Ergebnis des Laufs: Zusammenfassung und, was von Hand zu tun ist
print_summary() {
  local idx name
  scan_apps
  classify
  printf '\n'
  if [ -z "$FAILED" ]; then
    ok "Fertig: $N_INSTALLED von $N_SEL Emulatoren sind installiert."
  else
    warn "$N_INSTALLED von $N_SEL Emulatoren sind installiert."
    info "Manuell nötig:"
    while IFS= read -r idx; do
      [ -n "$idx" ] || continue
      getv "S_path_$idx"
      if [ -n "$REPLY" ]; then
        getf "$idx" name; name="$REPLY"
        info "  $name (Update): $(manual_line "$idx")"
      else
        info "  $(manual_line "$idx")"
      fi
    done <<< "$FAILED"
    if [ "$HOMEBREW_HINT" = 1 ]; then
      info "Homebrew (damit geht es automatisch) einrichten:  bash scripts/setup-mac.sh --install-missing --prepare"
    fi
    info "Später erneut versuchen:  bash scripts/install-emulators.sh   (oder:  jellystation --emulators)"
  fi
  if [ "$EMU_ROSETTA_NOTE" = 1 ]; then
    warn "Mindestens ein Emulator ist ein Intel-Programm und läuft auf diesem Mac über Rosetta 2 (macOS bietet die Installation beim ersten Start an)."
  fi
}

# Alle gewünschten Installationen/Updates nacheinander
run_installs() {   # $1 = Indizes
  local i n=0 total=0 name
  for i in $1; do total=$((total + 1)); done
  for i in $1; do
    n=$((n + 1))
    getf "$i" name; name="$REPLY"
    printf '\n  %s[%s/%s] %s%s\n' "$C_BOLD" "$n" "$total" "$name" "$C_RESET"
    getv "S_path_$i"; CUR_OLD="$REPLY"
    if install_one "$i"; then
      case "$RES" in
        installed) ok "$name installiert: $(shown "$DEST_APP")" ;;
        updated) ok "$name aktualisiert: $(shown "$DEST_APP")" ;;
        current) ok "$name ist aktuell${R_NOTE:+ ($R_NOTE)}." ;;
      esac
    else
      if [ -n "$CUR_OLD" ]; then
        bad "$name konnte nicht aktualisiert werden: $RES_WHY. Die vorhandene Version bleibt erhalten."
      else
        bad "$name wurde nicht installiert: $RES_WHY."
      fi
      FAILED="$FAILED$i$NL"
    fi
    CUR_OLD=""
  done
}

main() {
  local i need=""
  parse_args "$@"

  [ "${JELLYSTATION_TEST:-}" != "1" ] || TEST_MODE=1
  HOME_DIR="${JELLYSTATION_HOME:-${HOME:-}}"
  HOME_DIR="${HOME_DIR%/}"
  APPS_DIR="${JELLYSTATION_APPS_DIR:-/Applications}"
  USER_APPS_DIR="${JELLYSTATION_USER_APPS_DIR:-$HOME_DIR/Applications}"
  DATA_FILE="${JELLYSTATION_DATA:-$SCRIPT_DIR/../src/emulators/emulators.json}"
  STATE_DIR="$HOME_DIR/.jellystation"
  STATE_FILE="$STATE_DIR/emulators.installed"

  if [ "${JELLYSTATION_EMULATORS:-}" = "skip" ]; then
    if [ "$OPT_PORCELAIN" = 1 ]; then print_porcelain_empty
    elif [ "$OPT_QUIET" = 0 ]; then dim "Emulatoren übersprungen (JELLYSTATION_EMULATORS=skip)."
    fi
    [ "$OPT_NEEDS_BREW" = 0 ] || return 1
    return 0
  fi
  if [ "$(uname -s)" != "Darwin" ] && [ "$OPT_VALIDATE" = 0 ]; then
    if [ "$OPT_PORCELAIN" = 1 ]; then print_porcelain_empty
    elif [ "$OPT_QUIET" = 0 ]; then warn "Emulatoren lassen sich nur auf dem Mac einrichten (hier: $(uname -s)) – übersprungen."
    fi
    [ "$OPT_NEEDS_BREW" = 0 ] || return 1
    return 0
  fi
  [ -n "$HOME_DIR" ] || { err "Der Benutzerordner (HOME) ist nicht gesetzt."; return 3; }

  load_data || return 3

  if [ "$OPT_VALIDATE" = 1 ]; then
    printf 'Daten in Ordnung: %s Emulatoren, Spiele-Ordner %s\n' "$EMU_COUNT" "$D_lib_baseDir"
    return 0
  fi

  GITHUB_API="${JELLYSTATION_GITHUB_API:-$D_dl_api}"
  GITHUB_API="${GITHUB_API%/}"

  validate_ids "$OPT_ONLY" "--only"
  validate_ids "$OPT_SKIP" "--skip"
  select_emulators
  if [ -z "$SEL" ]; then
    [ "$OPT_QUIET" = 1 ] || warn "Keine Emulatoren ausgewählt."
    [ "$OPT_PORCELAIN" = 0 ] || print_porcelain_empty
    [ "$OPT_NEEDS_BREW" = 0 ] || return 1
    return 0
  fi

  scan_apps
  classify

  # ---- nur Auskunft für andere Skripte
  if [ "$OPT_NEEDS_BREW" = 1 ]; then
    for i in $MISSING; do
      getf "$i" install_kind
      [ "$REPLY" != "brew-cask" ] || return 0
    done
    return 1
  fi

  # ---- --check: nichts verändern
  if [ "$OPT_CHECK" = 1 ]; then
    if [ "$OPT_PORCELAIN" = 1 ]; then
      print_porcelain
    elif [ -n "$MISSING" ] || [ "$OPT_QUIET" = 0 ]; then
      print_table
      if [ -z "$MISSING" ]; then
        ok "Alle $N_SEL Emulatoren sind installiert."
      else
        warn "Es fehlen $((N_SEL - N_INSTALLED)) von $N_SEL: $MISSING_NAMES"
        info "Installieren:  bash scripts/install-emulators.sh   (oder:  jellystation --emulators)"
      fi
    fi
    [ -z "$MISSING" ]
    return $?
  fi

  # ---- Installation
  trap cleanup EXIT
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  trap 'on_signal 129' HUP

  if [ -n "$MISSING" ] || [ "$OPT_UPDATE" = 1 ] || [ "$OPT_QUIET" = 0 ]; then print_table; fi

  need="$MISSING"
  [ "$OPT_UPDATE" = 0 ] || need="$SEL"
  if [ -z "$need" ]; then
    [ "$OPT_QUIET" = 1 ] || ok "Nichts zu tun – alle $N_SEL Emulatoren sind installiert."
  elif [ -n "$MISSING" ] && ! confirm_install "$MISSING_NAMES"; then
    info "Übersprungen. Später nachholen:  bash scripts/install-emulators.sh   (oder:  jellystation --emulators)"
    need=""
  fi

  if [ -n "$need" ]; then
    ensure_work_dir || { err "Der Temp-Ordner konnte nicht angelegt werden."; return 3; }
    detect_arch
    if choose_target_dir; then
      run_installs "$need"
      print_summary
    fi
  fi

  if [ "$OPT_FOLDERS" = 1 ]; then make_folders; fi
  return 0
}

# Erst die ganze Datei lesen, dann ausführen (wichtig, falls das Skript beim Update ersetzt wird).
main "$@"; exit $?
