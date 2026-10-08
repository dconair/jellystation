#!/usr/bin/env bash
# Erzeugt die Testmedien für den Mock-Jellyfin-Server (nur bei Bedarf, ffmpeg nötig):
#   media/clip.webm        30 s, VP9 + 2 Opus-Tonspuren (Deutsch 440 Hz, Englisch 880 Hz)  → Direktwiedergabe
#   media/clip.mkv         derselbe Inhalt in Matroska                                      → "nicht direkt abspielbar"
#   media/hls0/, hls1/     HLS (fMP4, VP9 + Opus) je Tonspur, in Chromium abspielbar        → Umwandeln
#   media/sub.de.vtt, sub.en.vtt   WebVTT-Untertitel
# Aufruf:  ./make-media.sh [--force]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${MEDIA_DIR:-$here/media}"
force=0
[[ "${1:-}" == "--force" ]] && force=1

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg fehlt (Linux: apt install ffmpeg, macOS: brew install ffmpeg)" >&2
  exit 1
fi

if [[ $force -eq 0 && -f "$out/clip.webm" && -f "$out/clip.mkv" && -f "$out/hls0/index.m3u8" && -f "$out/hls1/index.m3u8" \
      && -f "$out/sub.de.vtt" && -f "$out/sub.en.vtt" ]]; then
  echo "Medien vorhanden: $out (mit --force neu erzeugen)"
  exit 0
fi

mkdir -p "$out"
rm -rf "$out/hls0" "$out/hls1"
mkdir -p "$out/hls0" "$out/hls1"
ff=(ffmpeg -hide_banner -loglevel error -y)

echo "Erzeuge clip.webm (VP9 + 2x Opus) …"
# testsrc2: bewegtes Testbild mit Zähler; Keyframe alle 2 s (-g 50), damit HLS-Segmente zu 4 s sauber trennen.
"${ff[@]}" \
  -f lavfi -i "testsrc2=size=640x360:rate=25:duration=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=30" \
  -map 0:v -map 1:a -map 2:a \
  -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -row-mt 1 -g 50 -keyint_min 50 -pix_fmt yuv420p \
  -c:a libopus -b:a 64k -ac 2 \
  -metadata:s:a:0 language=ger -metadata:s:a:0 title="Deutsch" \
  -metadata:s:a:1 language=eng -metadata:s:a:1 title="English" \
  "$out/clip.webm"

echo "Erzeuge clip.mkv …"
"${ff[@]}" -i "$out/clip.webm" -map 0 -c copy "$out/clip.mkv"

for v in 0 1; do
  echo "Erzeuge HLS hls$v (Tonspur $((v + 1))) …"
  "${ff[@]}" -i "$out/clip.webm" -map 0:v:0 -map "0:a:$v" -c copy -strict -2 \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$out/hls$v/seg%d.m4s" \
    "$out/hls$v/index.m3u8"
done

echo "Schreibe Untertitel …"
vtt() { # $1 = Sprache, $2 = Datei
  {
    echo "WEBVTT"
    echo
    for i in 0 1 2 3 4 5; do
      s=$((i * 5)); e=$((i * 5 + 3))
      printf '%d\n00:00:%02d.000 --> 00:00:%02d.000\n' "$((i + 1))" "$s" "$e"
      printf 'Untertitel (%s) Nr. %d bei %d s\n\n' "$1" "$((i + 1))" "$s"
    done
  } >"$2"
}
vtt Deutsch "$out/sub.de.vtt"
vtt English "$out/sub.en.vtt"

echo "Fertig: $out"
du -sh "$out"
