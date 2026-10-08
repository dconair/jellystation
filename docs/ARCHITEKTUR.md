# JellyStation – Architektur

Tauri 2 (Rust) + React 19 + TypeScript + Vite. Oberfläche im Stil der PS3-XrossMediaBar (XMB).
UI-Texte und Kommentare sind deutsch. Dieses Dokument beschreibt die Bausteine und ihre Schnittstellen.

```
src/
  App.tsx                  Gatekeeper (Einstellungen laden → Setup-Wizard oder Hauptmenü) + Overlay-Steuerung
  xmb/                     Hauptmenü (Xmb.tsx), Hintergrund, Icons, Sound, Detailkarte
  setup/                   Setup-Wizard (4 Schritte) und Abhängigkeits-Checks
  settings/settings.ts     Persistenz (Tauri-Store bzw. localStorage im Browser)
  library/                 Spiele-Scan (Ordner → Kategorien), Demo-Daten
  jellyfin/                Jellyfin-Zugriff: Bibliothek, Kontext/Benutzer, Wiedergabeplanung, Berichte
  player/                  Video-Player im PS3-Stil
  emulators/               Emulator-Katalog, Erkennung, Dialoge
  launcher/                Spielstart (Rust-Befehl game_launch) + Start-Overlay
  ui/                      Gemeinsame PS3-Bausteine (PsSymbol, Popup-Listen, Dialoge)
  art/                     Cover-Bilder (lokal, HTTP, generiert)
  input/                   Gamepad-Hook (D-Pad, Stick, ✕ ○ △ □, L1/R1/L2/R2, Optionen)
src-tauri/src/             Rust: lib.rs, media_proxy.rs, emulators.rs
public/demo/               Demo-Video (mp4 + webm) und Untertitel für den Player ohne Server
```

## Eingabe

`PadAction` (src/input/useGamepad.ts): `up down left right confirm(✕) back(○) triangle(△) square(□) l1 r1 l2 r2 options share`.
Tastatur: Pfeile, Enter = ✕, Esc/Backspace = ○, `o` = △.
Das Hauptmenü (`<Xmb inputEnabled={…}>`) ignoriert jede Eingabe, solange ein Overlay offen ist. Jedes Overlay
(Player, Dialoge) nimmt seine Eingabe selbst entgegen (Tastatur + `useGamepad`) und gibt sie bei `active={false}`
(z. B. weil darüber ein weiteres Overlay liegt) frei.

## Rust-Befehle (Aufruf mit `invoke` aus `@tauri-apps/api/core`)

### Medien-Proxy (`media_proxy.rs`)
Hintergrund: Ein `<video>` im WebView kann keine Anmelde-Header senden, und `http://`-Server im LAN werden vom
WebView je nach Plattform blockiert (Mixed Content / App Transport Security). Der Proxy ist ein kleiner HTTP-Server
nur auf `127.0.0.1`, der Anfragen mit Anmeldung an Jellyfin weiterreicht.

- `media_proxy_start({ baseUrl, apiKey }) -> string` – startet (idempotent) den Server und stellt das Ziel ein. Rückgabe:
  Präfix `http://127.0.0.1:PORT/p/TOKEN` (ohne `/` am Ende). Der Token im Pfad ist zufällig und verhindert, dass
  fremde Webseiten/Prozesse den Proxy nutzen. `GET|HEAD <Präfix>/<Pfad>?<Query>` wird zu `GET|HEAD <baseUrl>/<Pfad>?<Query>`
  mit `X-Emby-Token` und `Authorization: MediaBrowser Token=…`. `Range`/`If-Range` werden durchgereicht (206),
  Antwort-Header `Content-Type/Length/Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, `Cache-Control` kommen zurück,
  CORS ist offen (`Access-Control-Allow-Origin: *`, `OPTIONS` → 204). `.m3u8`-Antworten werden umgeschrieben:
  absolute URLs des Servers und root-relative Pfade (`/videos/…`) zeigen danach auf den Proxy. Nur GET/HEAD/OPTIONS.
- `media_proxy_stop()` – beendet den Server.

### Emulatoren (`emulators.rs`)
- `emulator_find({ specs: [{ id, appPattern, bundleIds }] }) -> [{ id, matches: [{ path, source }] }]` – sucht
  `.app`-Bundles (Name passt auf den regulären Ausdruck `appPattern`, ohne Groß-/Kleinschreibung) in `/Applications`,
  `~/Applications`, deren direkten Unterordnern, `~/Downloads`, `~/Desktop` und per Spotlight (`mdfind`, nur macOS).
  `source` ∈ `applications | user-applications | subfolder | downloads | desktop | spotlight`. Beste Treffer zuerst.
- `emulator_inspect({ path }) -> { path, exists, kind: "bundle"|"file"|"other", executable, name, bundleId, version, error }` –
  prüft einen vom Nutzer gewählten Pfad: bei einer `.app` wird `Contents/Info.plist` gelesen (`CFBundleExecutable`),
  die Programmdatei in `Contents/MacOS` aufgelöst und auf Ausführbarkeit geprüft; bei einer Datei die Ausführbarkeit.
- `game_launch({ id, program, args, label? }) -> { id, pid, executable, commandLine }` – startet `program`
  (`.app`-Bundle oder ausführbare Datei) mit `args` als eigenen Prozess (eigene Prozessgruppe, stdin geschlossen, stdout/stderr
  werden mitgelesen). Fehler (nicht gefunden, nicht ausführbar, schon gestartet) kommen als deutscher Text zurück (`Err(String)`).
- Event `game-exit` (Rust → Frontend, `listen` aus `@tauri-apps/api/event`):
  `{ id, code: number|null, signal: string|null, durationMs, stderrTail: string[], stdoutTail: string[] }`.
- `game_kill({ id }) -> boolean`, `game_running() -> string[]`.
- `launch_log_tail({ lines }) -> string[]` – letzte Zeilen von `launch.log` im App-Log-Ordner (jeder Start/Ende/Fehler wird dort protokolliert).

Shell-Plugin (`@tauri-apps/plugin-shell`): nur für `open()` (Webseiten öffnen; `plugins.shell.open` in tauri.conf.json) und
`brew install --cask <name>` (Scope in `capabilities/emulators.json`, Pfade `/opt/homebrew/bin/brew` und `/usr/local/bin/brew`).

## Jellyfin (`src/jellyfin/`)

- `createJfContext({ url, apiKey, userId? }) -> JfContext` – ermittelt den Benutzer (per `GET /Users`; ohne gespeicherte
  `userId` der zuletzt aktive, nicht deaktivierte Benutzer), stellt eine feste Geräte-ID bereit (`localStorage` `jellystation.deviceId`)
  und startet in Tauri den Medien-Proxy. `mediaUrl(ctx, "/Videos/…?…")` liefert eine abspielbare URL
  (über den Proxy; im Browser mit angehängtem `api_key`).
- `listJfUsers(cfg)`, `getItem`, `getEpisodes(ctx, seriesId)`, `getNextUp`.
- `buildDeviceProfile()` – Geräteprofil nach `canPlayType` des tatsächlichen WebViews (Direct Play nur für Formate, die
  die Engine kann; sonst HLS-Transkodierung nach H.264/AAC).
- `planPlayback(ctx, itemId, opts) -> PlaybackPlan` – ruft `POST /Items/{id}/PlaybackInfo`, entscheidet Direct Play /
  Direct Stream / Transcode (HLS) und liefert URL, Dauer, Audio-/Untertitel-Spuren, `PlaySessionId`.
- `PlaybackReporter` – meldet Start/Fortschritt/Ende (Wiedergabeposition = „Weiterschauen“) und beendet Transkodierungen.
  Mit API-Key funktionieren die älteren Endpunkte `/Users/{userId}/PlayingItems/…` zuverlässig; die neueren `/Sessions/Playing*`
  sind Rückfall.
- Positionen: Jellyfin-Ticks (1 s = 10 000 000). Bibliotheks-Einträge tragen `entry.jellyfin` (`JellyfinRef`).

## Oberfläche

- `src/ui/popup/`: `PopupList` (Liste im PS3-Stil, Tastatur + Controller, ✕/○/△), `ConfirmDialog`, `MessageDialog`,
  `ProgressDialog`, `OverlayFrame`. Alle Dialoge geben Eingabe frei, wenn `active={false}`.
- `src/player/Player.tsx`: Vollbild-Player. `src/emulators/…`: `EmulatorsDialog`, `useEmulators`, Start-Overlay.
- App.tsx hält genau ein Overlay-Objekt (`overlay: null | {kind: …}`); solange es gesetzt ist, ist das Hauptmenü gesperrt.

## Tests

Es gibt bewusst keine Test-Bibliothek im Projekt. Geprüft wird mit Playwright (Chromium) gegen den Vite-Dev-Server,
einem Mock-Jellyfin-Server (`dev/mock-jellyfin/`) und – für die Rust-Befehle – mit `cargo test` sowie einem Lauf der echten
Tauri-App unter Linux (xvfb + WebKitGTK).
