# Mock-Jellyfin

Kleiner Jellyfin-Server für Tests (nur Node, keine Abhängigkeiten, gehört nicht zur App). Er antwortet wie ein echter Server –
mit Anmeldung, Benutzerdaten, PlaybackInfo (Aushandlung nach dem gesendeten Geräteprofil), Range-Anfragen, HLS und Untertiteln –
und lässt sich per Szenario in Fehlerlagen bringen.

## Start

```sh
./make-media.sh                      # einmalig: Testmedien mit ffmpeg erzeugen (media/, nicht im Repo)
node server.mjs --port 18110         # API-Key: abc123 (mit --key ändern)
```

Als Bibliothek (z. B. in Playwright-Tests):

```js
import { startMockJellyfin } from "./dev/mock-jellyfin/server.mjs";
const mock = await startMockJellyfin({ port: 18110, apiKey: "abc123", mediaDir: "./dev/mock-jellyfin/media" });
// mock.url, mock.log, mock.setScenario("transcode"), mock.reset(), await mock.close()
```

Die App spricht ihn mit `http://127.0.0.1:18110` und dem Key `abc123` an. Ohne `--scenario` laufen alle Achsen im Normalzustand.

## Testmedien (`make-media.sh`)

| Datei | Inhalt |
| --- | --- |
| `media/clip.webm` | 30 s, VP9 + zwei Opus-Tonspuren (Deutsch 440 Hz, English 880 Hz) – Direktwiedergabe in Chromium |
| `media/clip.mkv` | derselbe Inhalt in Matroska – wird im Szenario `transcode` als "HEVC + DTS, nicht direkt abspielbar" ausgegeben |
| `media/hls0/`, `media/hls1/` | HLS (fMP4, VP9 + Opus), je Tonspur – Chromium-tauglich; `AudioStreamIndex=2` liefert `hls1` |
| `media/sub.de.vtt`, `sub.en.vtt` | WebVTT-Untertitel |
| `media/trickplay/160/`, `trickplay/320/` | Kachelbilder für die Vorschau auf der Zeitleiste: 1 Bild pro Sekunde, 5 × 5 Bilder je JPG (`0.jpg` voll, `1.jpg` mit 5 Bildern), Bilder 160×90 bzw. 320×180 |

`make-media.sh` erzeugt nur, was fehlt (laufende Mock-Server mit den vorhandenen Medien werden nicht gestört); `--force` erzeugt alles neu.

Streams jedes Titels: 0 Video, 1 Audio Deutsch (Standard), 2 Audio English, 3 Untertitel Deutsch (extern, Text), 4 Untertitel English (Text),
5 Untertitel Deutsch (PGS, Bild → nur per Einbrennen).

## Szenarien

`POST /__mock/scenario?name=a,b` – mehrere Namen mit Komma; jeder Name stellt nur seine Achse um.

| Achse | Namen (Standard zuerst) |
| --- | --- |
| Wiedergabe (`PlaybackInfo`) | `direct` (WebM, Direct Play), `transcode` (MKV → HLS-`TranscodingUrl`), `nosource`, `emptysources`, `notallowed`, `ratelimit`, `error500`, `badinfo`, `notranscode`, `slowinfo` (3 s) |
| Bibliothek (`GET /Items`) | `normal`, `many` (412 Filme/350 Serien), `badjson`, `items500`, `html`, `noitems`, `emptyall`, `emptyseries`, `slow` (12 s) |
| Benutzerliste | `usersok`, `nousers`, `users403`, `users500` |
| Benutzerdaten-Pfade | `modern`, `legacy` (Server ≤ 10.8: neue Pfade 404/405), `userdata500`, `userdata404` |
| Anmeldung | `legacyauth` (alles geht), `strictauth` (wie neue Server: `X-Emby-Token` und `?api_key=` werden abgelehnt) |
| Adressen in HLS-Listen | `hls-relative`, `hls-root` (`/videos/…`), `hls-absolute` (`http://host/videos/…`) |
| Form der `TranscodingUrl` | `url-root` (`/videos/…`), `url-rel` (`videos/…`) |
| Vorschaubilder (Trickplay) | `trickplay` (Item-DTO meldet `Trickplay`, Kachelbilder gibt es), `notrickplay` (kein Feld, Kachelbilder 404 → Player nimmt die Bilder selbst auf), `trickplay404` (Feld da, Kachelbilder 404) |

Weitere Befehle:

| Befehl | Wirkung |
| --- | --- |
| `GET /__mock/log[?since=N&match=REGEX&method=POST]` | aufgezeichnete Anfragen: `n`, `method`, `path`, `query`, `body`, `auth` (`authorization`, `ApiKey`, `x-emby-token`, `api_key`, `proxy`), `status`, `viaProxy` |
| `POST /__mock/reset` | Szenarien, Einstellungen, Benutzer, Wiedergabestände und Protokoll zurücksetzen |
| `POST /__mock/config?defaultAudio=2&defaultSubtitle=3&delayMs=400&altSourceIds=1` | Vorgabe-Tonspur/-Untertitel des Servers, künstliche Verzögerung, Quellen-Id ≠ Titel-Id (Titel mit mehreren Versionen) |
| `GET /__mock/state` | Szenarien, Benutzer, laufende Umwandlungen (`encodings`), gespeicherte Benutzerdaten |
| `POST /__mock/users` (JSON-Liste `[{id,name,last,disabled}]`) | Benutzerliste ersetzen |
| `POST /__mock/userdata` (`{userId,itemId,data:{PlaybackPositionTicks,Played,…}}`) | Wiedergabestand setzen |

## Daten

- Benutzer: Alice (zuletzt aktiv), Bob (deaktiviert, aber jüngste Aktivität), Carol. Wiedergabestände gelten je Benutzer.
  Zusätzlich gilt `alice-token` als Token eines normalen Benutzers (Alice, kein Administrator): `GET /Users` → 403, `GET /Users/Me` → Alice.
- Filme (Alice): `Testfilm` (neu), `Testfilm (angefangen)` (12 s), `Testfilm (gesehen)`, `Blade Runner 2049` (12 s), `Das Boot` (gesehen), `Alien` (95 %).
- Serien: `Testserie` (S01E01 gesehen, S01E02 bei 12 s, dazu Staffel 2, ein Special und eine "fehlende" Folge, die nur ohne `isMissing=false` erscheint),
  `Serie fertig` (alles gesehen), `Serie neu` (nichts gesehen – `Shows/NextUp` bleibt hier leer; echte Server antworten dann je nach Version leer oder mit Folge 1, der Client muss beides können).
- Alle Titel sind 30 s lang und spielen denselben Clip.

## Verhalten, das dem echten Server nachgebildet ist

- Anmeldung: `Authorization: MediaBrowser …Token="…"`, `?ApiKey=`; mit `legacyauth` zusätzlich `X-Emby-Token` und `?api_key=`.
- `Sessions/Playing*` werden angenommen (204), speichern aber nichts (API-Key-Sitzung ohne Benutzer); `Sessions/Playing/Stopped` beendet die Umwandlung.
- `PlaybackInfo` prüft das gesendete `DeviceProfile` (Container, Video-/Audiocodec, zweite Tonspur, Bitrate, Untertitelformat) und liefert danach Direct Play
  oder eine `TranscodingUrl` mit `TranscodeReasons`; Bild-Untertitel werden eingebrannt (`SubtitleMethod=Encode`).
- Vorschau: `GET /Items/{id}` und `GET /Items?ids=…&fields=Trickplay,Chapters` liefern `Trickplay` (`{ <quellenId>: { "160": {Width, Height, TileWidth, TileHeight, ThumbnailCount, Interval, Bandwidth}, "320": … } }`)
  und `Chapters` (Anfang / Die Mitte / Finale); `GET /Videos/{id}/Trickplay/{breite}/{n}.jpg[?mediaSourceId=…]` liefert die Kachelbilder (404 für unbekannte Breite/Nummer).
- Medien: `GET /Videos/{id}/stream[.ext]` mit `Range` (206, `Content-Range`), HLS unter `/videos/{id}/master.m3u8` → `main.m3u8` → `hls1/main/N.mp4`,
  Untertitel unter `/Videos/{id}/{quelle}/Subtitles/{index}[/{ticks}]/Stream.vtt`.
- Proxy-Nachbildung: Alles unter `/p/<beliebig>/…` geht ohne Anmeldung durch (nur GET/HEAD); `.m3u8`-Antworten werden wie beim echten Proxy umgeschrieben
  (root-relative und absolute Server-Adressen zeigen danach auf `/p/<beliebig>`).
