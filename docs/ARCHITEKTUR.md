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

### Server-Suche (`discovery.rs`)
- `jellyfin_discover({ waitMs? }) -> [{ address, id, name }]` – UDP-Broadcast „who is JellyfinServer?“ an Port 7359; jeder Server einmal.
  Der Setup-Assistent sucht beim Öffnen automatisch (nur Desktop-App) und übernimmt einen einzelnen Fund.

### BIOS/Firmware (`requirements.rs`)
- `requirements_scan({ specs: [{ id, locations: [{ kind: "emulator"|"folder", dir }], nameRegex?, minSize, maxSize, markers[] }] }) -> [{ id, found: [{ kind, dir, path, size }] }]` –
  sucht Dateien nach Namensmuster/Größe (im BIOS-Ordner auch eine Ebene tiefer) und Markerdateien (z. B. `sys/external/liblv2.sprx` der
  eingespielten PS3-Firmware). `~` wird aufgelöst. Katalog und Auswertung: `src/emulators/requirements.ts`.
- `bios_copy({ from, toDir }) -> string` – kopiert eine Datei des Nutzers in einen Emulator-Datenordner; Ziel nur im Benutzerordner, nie überschreiben.
- Frontend: Setup-Schritt „Dateien“ (`FilesStep`), Dialog `RequirementsDialog`, Vorabprüfung `preflight` in `useGameLauncher`.

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

### Cover (`covers.rs`)
- `cover_resolve({ system, path, title, online, retry? }) -> { path, source: "embedded"|"online"|"cache"|null, width, height, serial, error }` –
  liefert eine Bilddatei im Cache für ein Spiel ohne eigenes Bild. Reihenfolge: Cache → eingebettet → online. Ein Treffer
  wird unverändert abgelegt (`<App-Cache>/covers/<system>/<hash>.png|jpg|webp`, Name aus Hash von System und Spielname).
  `online: false` ruft nichts im Netz ab. `error` ist gesetzt, wenn nur ein Netzproblem die Suche verhindert hat (kein „nicht gefunden“).
  `retry: true` ignoriert den Merker „nicht gefunden“ (Knopf „Jetzt nach fehlenden Covern suchen“).
- Eingebettet (`covers/iso.rs`, `embedded.rs`): ISO 9660 nur lesend (2048-Byte-Sektoren, auch rohe 2352-Byte-Abbilder Mode 1/Mode 2 Form 1),
  nie komplett gelesen. PS3: `PS3_GAME/ICON0.PNG` (320x176, Querformat) und `PARAM.SFO`; PSP: `PSP_GAME/ICON0.PNG`; PS1/PS2: `SYSTEM.CNF`
  (Seriennummer für die Suche). Auch entpackte Spielordner. Verschlüsselte PS3-Abbilder (ungültige PNG-Signatur) weichen auf Online aus.
- Online (`matching.rs`): libretro-Thumbnails `https://thumbnails.libretro.com/<System>/Named_Boxarts|Named_Snaps|Named_Titles/<Titel>.png`.
  Die Dateiliste je System wird einmal geholt (30 Tage im Cache); Fuzzy-Abgleich (Normalisierung, Token-Jaccard + Levenshtein, Schwelle,
  Region-Vorzug). Gesendet werden nur System- und Bildname. Limits: 8 MB, Verbindung 8 s / gesamt 20 s, höchstens 2 Abrufe gleichzeitig,
  nur Bild-Signaturen, Weiterleitungen nur auf denselben Host. „Nicht gefunden“ wird 7 Tage, ein Netzfehler 10 Minuten gemerkt.
- `JELLYSTATION_COVER_BASE` ersetzt die Adresse (nur Debug-Build und Tests; Tests und `dev/e2e/covers.mjs` nutzen einen lokalen Mock-Server).
- `cover_cache_stats() -> { count, bytes }`, `cover_cache_clear() -> { removed, bytes }` (nur Bilder und Merker im Cover-Cache).
- Frontend: `src/art/coverService.ts` (Hülle, Warteschlange mit 2 parallelen Suchen), `useGameLibrary` (Kategorien sofort mit Platzhaltern,
  Cover danach nach und nach; Einträge behalten ihre IDs, nur `art`/`artShape` ändern sich), `CoverSettingsDialog` (Einstellungen →
  „Cover & Grafiken“, `settings.covers.auto`, Standard An). Eigene Bilder neben dem Spiel (`findCover`) haben immer Vorrang; Demo-Spiele holen nichts.
  Gelesen werden die Cache-Bilder wie jede Datei über den ArtLoader (`fs:allow-read-file` für `$APPCACHE/covers/**` in `capabilities/library.json`).
  Boxart ist Hochformat (`artShape: "poster"`): `ArtImage` zeigt sie ganz (`object-fit: contain`) vor einer unscharfen Kopie.

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
