#!/usr/bin/env bash
# Erzeugt kleine Test-Archive mit .app-Paketen.   Aufruf: bash make-fixtures.sh <Zielordner>
# (echte ZIPs, ein tar-Archiv als "7z", ein ZIP als "dmg" – die Stubs für hdiutil/7zz verstehen genau das)
set -euo pipefail
out="${1:?Zielordner fehlt}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/emu-fixtures.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# mkapp <Ordner> <AppName> <Programm> <Version> <Kennzeichen> [Bundle-ID]
mkapp() {
  local d="$1/$2"
  mkdir -p "$d/Contents/MacOS" "$d/Contents/Resources"
  cat > "$d/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key>
<string>$4</string>
<key>CFBundleIdentifier</key>
<string>${6:-test.$3}</string>
</dict></plist>
PL
  printf '#!/bin/sh\necho %s\n' "$3" > "$d/Contents/MacOS/$3"
  chmod +x "$d/Contents/MacOS/$3"
  head -c 200000 /dev/urandom > "$d/Contents/Resources/data.bin"   # nicht komprimierbar
  printf '%s\n' "$5" > "$d/Contents/Resources/tag.txt"
}

# zipit <Name.zip> <Ordner> – ZIP mit dem Inhalt des Ordners (Symlinks bleiben erhalten)
zipit() { ( cd "$2" && zip -qry "$out/$1" . ); }

build() { # <Archiv> <Ordnername> <AppName> <Programm> <Version> <Kennzeichen> [Bundle-ID]
  local d="$tmp/$2"
  rm -rf "$d"; mkdir -p "$d"
  mkapp "$d" "$3" "$4" "$5" "$6" "${7:-}"
  zipit "$1" "$d"
}

build rpcs3-arm64.zip a1 RPCS3.app rpcs3 0.0.34 rpcs3-arm64 net.rpcs3.rpcs3
build rpcs3-x64.zip a2 RPCS3.app rpcs3 0.0.34 rpcs3-x64 net.rpcs3.rpcs3
build rpcs3-new.zip a3 RPCS3.app rpcs3 0.0.35 rpcs3-new net.rpcs3.rpcs3
build rpcs3-versioned-name.zip a4 RPCS3-v0.0.34.app rpcs3 0.0.34 rpcs3-versioned net.rpcs3.rpcs3
build rpcs3-wrongname.zip a5 Foo.app foo 1.0 wrongname com.example.foo
build rpcs3-bundleid.zip a9 Seltsamer-Name.app rpcs3 0.0.34 rpcs3-bundleid net.rpcs3.rpcs3
build duckstation-mac-release.zip a6 DuckStation.app duckstation 0.1-100 duck-direct org.duckstation.duckstation
build duckstation-gh.zip a7 DuckStation.app duckstation 0.1-200 duck-github org.duckstation.duckstation
build duckstation-x64.zip a8 DuckStation.app duckstation 0.1-300 duck-x64 org.duckstation.duckstation

# ZIP mit mehreren Apps: Updater und Deinstallierer dürfen nicht statt des Emulators installiert werden
rm -rf "$tmp/a10"; mkdir -p "$tmp/a10"
mkapp "$tmp/a10" "RPCS3-Updater.app" updater 1.0 updater net.rpcs3.updater
mkapp "$tmp/a10" "Uninstall RPCS3.app" uninst 1.0 uninst com.example.uninst
mkapp "$tmp/a10" "RPCS3.app" rpcs3 0.0.34 main net.rpcs3.rpcs3
mkapp "$tmp/a10" "RPCS3 Helper Long Name.app" helper 1.0 helper net.rpcs3.helper
zipit rpcs3-two-apps.zip "$tmp/a10"

# ZIP ohne App
mkdir -p "$tmp/noapp"; echo "nur Text" > "$tmp/noapp/LIESMICH.txt"; zipit rpcs3-noapp.zip "$tmp/noapp"

# abgeschnittenes ZIP (60 % der Bytes)
total="$(wc -c < "$out/rpcs3-arm64.zip")"
head -c $((total * 6 / 10)) "$out/rpcs3-arm64.zip" > "$out/rpcs3-bad.zip"

# "7z": in Wirklichkeit ein tar-Archiv (der Stub 7zz entpackt es)
mkdir -p "$tmp/s7"; mkapp "$tmp/s7" RPCS3.app rpcs3 0.0.34 rpcs3-7z
( cd "$tmp/s7" && tar -cf "$out/rpcs3.7z" RPCS3.app )

# "dmg": in Wirklichkeit ein ZIP mit App, Link auf /Applications und einem Hintergrund-Ordner
mkdir -p "$tmp/dm"; mkapp "$tmp/dm" RPCS3.app rpcs3 0.0.34 rpcs3-dmg
ln -s /Applications "$tmp/dm/Applications"; mkdir -p "$tmp/dm/.background"; echo bg > "$tmp/dm/.background/bg.txt"
zipit rpcs3.dmg "$tmp/dm"
# "dmg" ohne App
mkdir -p "$tmp/dm2"; echo leer > "$tmp/dm2/LIESMICH.txt"; zipit rpcs3-noapp.dmg "$tmp/dm2"

# ein .tar.xz mit App (für den Archivweg "tar")
mkdir -p "$tmp/tx"; mkapp "$tmp/tx" RPCS3.app rpcs3 0.0.34 rpcs3-tarxz
( cd "$tmp/tx" && tar -cJf "$out/rpcs3.tar.xz" RPCS3.app )

# "7z" nur für den Stub 7zz lesbar: Kennung "FAKE7Z\n" + tar-Archiv (echtes tar scheitert daran)
{ printf 'FAKE7Z\n'; cat "$out/rpcs3.7z"; } > "$out/rpcs3-fake7z.7z"

# ZIP mit __MACOSX-Ordner (Finder-Archive) vor dem echten Paket und einer Verschachtelung
mkdir -p "$tmp/mx/__MACOSX/RPCS3.app/Contents" "$tmp/mx/Release/mac"
echo "meta" > "$tmp/mx/__MACOSX/RPCS3.app/Contents/._Info.plist"
mkapp "$tmp/mx/Release/mac" RPCS3.app rpcs3 0.0.34 rpcs3-macosx
zipit rpcs3-macosx.zip "$tmp/mx"

# "7z", das niemand lesen kann (kein tar, kein 7-Zip)
head -c 5000 /dev/urandom > "$out/rpcs3-opaque.7z"

# Dateien für Asset-Listen, die nicht passen sollen
echo "x" > "$out/dummy.txt"
printf 'MZ' > "$out/duckstation-windows-x64-release.zip"
printf 'ELF' > "$out/duckstation-linux-x64.AppImage"
echo "fertig: $out"
