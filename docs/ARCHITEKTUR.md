# JellyStation – Architektur

Tauri 2 (Rust) + React 19 + TypeScript + Vite. Oberfläche im Stil der PS3-XrossMediaBar (XMB).
UI-Texte und Kommentare sind deutsch. Dieses Dokument beschreibt die Bausteine und ihre Schnittstellen.

```
src/
  App.tsx                  Gatekeeper (Einstellungen laden → Setup-Wizard oder Hauptmenü) + Overlay-Steuerung
  xmb/                     Hauptmenü (Xmb.tsx), Hintergrund, Icons, Sound, Detailkarte
  boot/                    Start-Animation (BootAnimation.tsx)
  audio/                   Hintergrundmusik und PS3-Klänge (ps3Sounds.ts)
  setup/                   Setup-Wizard (Jellyfin, Stremio, Spiele, Dateien, Controller, Prüfung) und Abhängigkeits-Checks
  settings/settings.ts     Persistenz (Tauri-Store bzw. localStorage im Browser)
  library/                 Spielebibliothek: Scan-Ergebnis → Kategorien, Zuordnung von Hand, Demo-Daten
  jellyfin/                Jellyfin-Zugriff: Bibliothek, Kontext/Benutzer, Wiedergabeplanung, Berichte
  stremio/                 Stremio als zweite Quelle: Konto, Addons, Kataloge, Stream-Auswahl, Suche
  search/                  Suche in Jellyfin und Stremio (SearchDialog, Verlauf)
  player/                  Video-Player im PS3-Stil
  movie/                   Film-Detailseite vor dem Player (Logo, Optionen)
  emulators/               Emulator-Katalog, Erkennung, Dialoge
  diagnose/                Diagnose: Prüflauf, Regeln, Dialog „Diagnose“
  install/                 „Einrichtung & Downloads“: Emulatoren von GitHub laden, BIOS/Firmware prüfen, eigene Spiele-Quellen
  launcher/                Spielstart (Rust-Befehl game_launch) + Start-Overlay
  ui/                      Gemeinsame PS3-Bausteine (PsSymbol, Popup-Listen, Dialoge)
  art/                     Cover-Bilder (lokal, HTTP, generiert)
  input/                   Gamepad-Hook (D-Pad, Stick, ✕ ○ △ □, L1/R1/L2/R2, Optionen)
src-tauri/src/             Rust: lib.rs, media_proxy.rs, emulators.rs
public/demo/               Demo-Video (mp4 + webm) und Untertitel für den Player ohne Server
public/branding/, branding/    Logo: Qualle als SVG (App-Icon, Start-Animation), Generator make-logo.mjs; src-tauri/icons daraus erzeugt (npx tauri icon)
```

## Eingabe

`PadAction` (src/input/useGamepad.ts): `up down left right confirm(✕) back(○) triangle(△) square(□) l1 r1 l2 r2 options share`.
Tastatur: Pfeile, Enter = ✕, Esc/Backspace = ○, `o` = △.
Das Hauptmenü (`<Xmb inputEnabled={…}>`) ignoriert jede Eingabe, solange ein Overlay offen ist. Jedes Overlay
(Player, Dialoge) nimmt seine Eingabe selbst entgegen (Tastatur + `useGamepad`) und gibt sie bei `active={false}`
(z. B. weil darüber ein weiteres Overlay liegt) frei.

## Start-Animation, Hintergründe, Klänge

- **Start-Animation** (`src/boot/BootAnimation.tsx`): läuft einmal pro App-Start über dem Hauptmenü (10 s, passend zum Startklang `coldboot`),
  zeigt den Hintergrund aus den Einstellungen (das Band blendet zum Anschwellen des Klangs auf, auf dem Höhepunkt bei ca. 4,5 s folgt ein Lichtblitz und die JellyStation-Qualle `public/branding/jellyfish.svg` taucht auf, danach klingt alles aus) und blendet ins Menü über. Jede Taste, jeder Klick und jede
  Controller-Taste überspringt (nach 0,6 s). `settings.ui.bootAnimation` (Standard An) schaltet sie ab; bei „Animationen: Aus“ entfällt sie. Einstellungen →
  Animationen hat zusätzlich „Start-Animation ansehen“.
- **Hintergrund-Designs** (`src/xmb/background/`): `xmb` = „PS3-Original“ (verdrehtes Band aus feinen Fäden mit Funkeln und kräftigerem Farbverlauf, Standard für neue Installationen), `ps3` = die bisherigen
  „JellyStation-Wellen“ (bleiben wählbar, gespeicherte Einstellungen ändern sich nicht), dazu Nordlicht, Sternenhimmel, Tiefsee, Neon-Gitter, Farbverlauf.
  Farbe: Monatsfarbe (Standard), feste Farbthemen oder eigener Farbton – gilt für jedes Design.
- **Akzentfarbe** (`src/prefs/accent.ts`, Einstellung `accentId`/`accentHue`, Einstellungen → Anzeige & Farben): Listen, Dialoge, Serien-Screen, Setup und Player sind dunkle, durchscheinende
  Flächen über dem Hintergrundbild (wie die Listen der PS3), getönt in der Akzentfarbe. Standard „Wie Farbthema“ = Monatsfarbe bzw. gewähltes Farbthema; alternativ PS3-Weiß (neutral),
  ein Thema oder ein eigener Farbton. `UiEffects` schreibt eine Helligkeitsleiter `--ui-l92 … --ui-l5` (RGB-Tripel, feste HSL-Helligkeit) an `<html>`; die Stylesheets nutzen sie als
  `rgba(var(--ui-l76), 0.4)` – keine festen Blautöne mehr. Standardwerte (Blau) stehen in `index.css`. Beim Serien-Screen tritt die Menü-Ebene zurück, das Hintergrundbild bleibt (`:has(.series-frame)` in `series.css`).
- **Schnelle Farbwahl** (`src/prefs/AccentPicker.tsx`): △ im Serien-Screen (Übersicht und Folgen-Details) und auf der Film-Detailseite öffnet eine Liste der Akzentfarben. Beim Bewegen färbt
  sich die Oberfläche sofort um (`setUiPrefs({ accentId })`), ✕ übernimmt, ○ stellt die vorherige Farbe wieder her. Es ist dieselbe Einstellung wie Einstellungen → Anzeige & Farben → Akzentfarbe.
  Die Folgenliste des Serien-Screens und die beiden Flächen der Film-Detailseite sind Glasflächen wie die Listen der PS3 (Verlauf aus `--ui-l…`, Lichtkante oben).
- **Oberflächen-Stil** (`interfaceStyle` in `src/prefs/uiPrefs.ts`, Einstellungen → Anzeige & Farben → Oberflächen-Stil): „Klassisch (PS3)“ ist der Standard und bleibt unverändert. „Liquid Glass“
  setzt `data-look="glass"` an `<html>` (`UiEffects`); `src/prefs/glass.css` überschreibt dann nur Flächen: Popup-Listen, Film- und Serienseite, Kategorie-Leiste, Uhr, Hinweisleiste und Detailkarte
  des Hauptmenüs sowie die Bedienung des Players (Titel, Uhr, Zeitleiste mit Hinweisen, Vorschau, Pause-Karte). Glas = Tönung (Lesbarkeit) + Verlauf mit Lichtkante + `backdrop-filter`. Bewusst
  nicht hinterlegt sind die Einträge und Kategorien des Hauptmenüs (die MotionEngine bewegt sie jedes Bild). Ohne `backdrop-filter` bzw. bei „Transparenz reduzieren“ des Systems werden die
  Flächen deckend. Die Einblend-Animationen von `.pop-overlay` und `.pop-panel` laufen im Glas-Stil mit `animation-fill-mode: backwards`, sonst bliebe der Hintergrundfilter wirkungslos.
- **Kategorie-Icons** (`src/xmb/CategoryIcon.tsx`): selbst gezeichnete Vektor-Piktogramme nach dem Vorbild der XMB (Video = Filmstreifen, Foto = Kamera, Einstellungen = Werkzeugkasten, Spiele = Gamepad …). Es liegen keine Sony-Originaldateien im Repo.
- **PS3-Klänge** (`src/audio/ps3Sounds.ts`, Dateien in `public/sounds/ps3/`, Einstellung `soundPack`: `ps3` | `synth`): Zuordnung in `sound.ts`
  (`SFX_AS_PS3`): Cursor-Bewegung und Kategoriewechsel → `snd_option` (auf der PS3 bytegleich mit `snd_cursor`, `snd_decide` und `snd_category_decide`), Zurück → `snd_cancel`, Bestätigen → `snd_system_ok`, Fehler → `snd_system_ng`; dazu
  `playSound("trophy")` (Erfolgsmeldung), `playSound("gameboot")` (Spielstart) und `startBootSound()` (coldboot). Die Originale sind sehr leise; `psGain` hebt sie auf einen einheitlichen Pegel. `snd_error.wav` ist praktisch
  stumm (1,75 ms, −91 dB) und wird nicht verwendet.
- **Herkunft/Rechte:** Die WAV-Dateien stammen aus der PS3-Systemsoftware (Sony) und liegen auf ausdrücklichen Wunsch des Projekteigentümers im Repo.
  Rechte daran liegen bei Sony. Wer sie nicht ausliefern will, löscht `public/sounds/ps3/`: Die App fällt dann automatisch auf die synthetischen Töne
  zurück (Boot-Animation läuft lautlos).

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

### Lokales Umwandeln mit ffmpeg (`transcode.rs`)
Für Stremio-Streams, die das WebView nicht abspielt (HEVC, DTS, MKV …) und für die kein Jellyfin-Server umwandeln kann.
ffmpeg liefern die Installer mit: Die Build-Workflows (`build-windows.yml`, `build-mac.yml`) laden ein statisches GPL-Build
(Windows: BtbN/FFmpeg-Builds, macOS: eugeneware/ffmpeg-static) nach `src-tauri/ffmpeg-bin/` und packen es über eine
Zusatz-Konfiguration (`--config src-tauri/tauri.ffmpeg.conf.json`, nur in CI) als Ressource `ffmpeg/` in die App; `NOTICE.txt`
nennt Lizenz (GPL v3) und Quelle. Schlägt das Holen fehl, entsteht der Installer ohne ffmpeg. Gesucht wird zuerst im
Ressourcenordner der App, dann im PATH und an üblichen Orten (Windows: WinGet-Links, Scoop, Chocolatey, `C:\ffmpeg`;
macOS: Homebrew); `JELLYSTATION_FFMPEG` überschreibt das. In der Entwicklung (`tauri dev`) braucht es daher ein
installiertes ffmpeg.

- `transcode_start({ url }) -> { url, durationSec, video, audio }` – prüft die Quelle (nur http/https, `ffmpeg -i` liest
  Dauer und Codecs) und startet einen HTTP-Server auf `127.0.0.1` (zufälliger Token im Pfad). Er liefert eine VOD-Wiedergabeliste
  mit 6-Sekunden-Segmenten (`/t/TOKEN/index.m3u8`, `segN.ts`); jedes Segment wandelt erst beim Abruf ein eigener ffmpeg-Aufruf
  in H.264 (höchstens 1080p) und Stereo-AAC um, mit den Zeitstempeln der Quelle. Dadurch klappen Springen und Fortsetzen
  ohne Vorab-Umwandlung. Ein neuer Aufruf ersetzt den laufenden Strom. Fehler `ffmpeg_missing`: ffmpeg nicht gefunden.
- `transcode_stop()` – beendet den Server.

Im Player: `makeStremioPlan(...).replan({ forceTranscode: true })` (`src/stremio/plan.ts`, `transcode.ts`) liefert den
lokalen HLS-Plan; die Engine nutzt ihn als automatische Rückfallstufe bei Formatfehlern und bei „Immer umwandeln“.

### Server-Suche (`discovery.rs`)
- `jellyfin_discover({ waitMs? }) -> [{ address, id, name }]` – UDP-Broadcast „who is JellyfinServer?“ an Port 7359; jeder Server einmal.
  Der Setup-Assistent sucht beim Öffnen automatisch (nur Desktop-App) und übernimmt einen einzelnen Fund.

### Web-Bereich (`web.rs`)
- `web_open({ url, title?, downloadDir })` – öffnet nur http/https in einem eigenen Fenster „web“ (ohne Tauri-Rechte, eigenes Profil), Downloads
  landen in `downloadDir` (= `<Spiele-Ordner>/Downloads`), Event `web-download` `{ name, path, state: started|done|failed }`.
- `game_import({ from, gamesDir, system })` – verschiebt eine Datei aus `Downloads/` nach `<Spiele-Ordner>/<System>/` (kein Überschreiben, nur gültige Systemnamen); `system: ""` legt sie direkt in den Spiele-Ordner, wo `games_scan` das System erkennt.
- `web_close()`. Frontend: `src/web/*`, Lesezeichen in `settings.bookmarks`; keine Seiten vorinstalliert, nichts wird automatisch geladen oder entpackt.

### BIOS/Firmware (`requirements.rs`)
- `requirements_scan({ specs: [{ id, locations: [{ kind: "emulator"|"folder", dir }], nameRegex?, minSize, maxSize, markers[] }] }) -> [{ id, found: [{ kind, dir, path, size }] }]` –
  sucht Dateien nach Namensmuster/Größe (im BIOS-Ordner auch eine Ebene tiefer) und Markerdateien (z. B. `sys/external/liblv2.sprx` der
  eingespielten PS3-Firmware). `~` wird aufgelöst. Katalog und Auswertung: `src/emulators/requirements.ts`.
  Orte dürfen `{appdir}` enthalten (Ordner der gefundenen Windows-`.exe`; z. B. liegt RPCS3s `dev_flash` neben der `rpcs3.exe`, bei einem
  Ordner `portable` darin). Die Erkennung (`detect.ts`) merkt sich die Programmpfade (`rememberEmulatorApp`); ist ein `{appdir}`-Ort
  geprüft, gilt „fehlt“ als sicher (`RequirementStatus.sure`) und blockiert den Start mit einer klaren Meldung. Die PS3-Firmware lässt sich
  unter „Einrichtung & Downloads“ per `rpcs3 --installfw <PUP>` einspielen.
- `bios_copy({ from, toDir }) -> string` – kopiert eine Datei des Nutzers in einen Emulator-Datenordner; Ziel nur im Benutzerordner, nie überschreiben.
- Frontend: Setup-Schritt „Dateien“ (`FilesStep`), Dialog `RequirementsDialog`, Vorabprüfung `preflight` in `useGameLauncher`.

### Emulatoren (`emulators.rs`)
- `emulator_find({ specs: [{ id, appPattern, bundleIds }] }) -> [{ id, matches: [{ path, source }] }]` – sucht
  `.app`-Bundles (Name passt auf den regulären Ausdruck `appPattern`, ohne Groß-/Kleinschreibung) in `/Applications`,
  `~/Applications`, deren direkten Unterordnern, `~/Downloads`, `~/Desktop` und per Spotlight (`mdfind`, nur macOS).
  `source` ∈ `applications | user-applications | subfolder | downloads | desktop | spotlight`. Beste Treffer zuerst.
  Unter Windows wird stattdessen nach `.exe` gesucht (das Muster wird von `….app$` auf `….exe$` umgestellt; Installationsordner der App
  `%LOCALAPPDATA%\JellyStation\Emulators`, `Programs`, `C:\Emulators`/`Emulatoren`/`Emulation` (auch `D:`), Programme, Downloads, Schreibtisch;
  bis zu drei Ebenen tief, Updater/Deinstaller werden übersprungen). `emulator_inspect`/`game_launch` verlangen dort eine `.exe`/`.com`/`.bat`/`.cmd`.
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

### Diagnose (`diagnose.rs`)
Alles lesend; die App ändert nur auf Klick. Befehle:

- `diag_probe({ paths }) -> [FileProbe]` – je Pfad (gleiche Reihenfolge): `exists`, `isDir`, `isFile`, `readable`, `size`, `headHex` (erste 16 Bytes als Hex),
  `names` (bei Ordnern, höchstens 60), `refs` (zu `.cue`/`.m3u`: genannte Dateien und ob sie daneben liegen), `quarantined` (nur macOS und nur bei `.app`), `error`.
  Höchstens 2000 Pfade je Aufruf; Pfade mit `..` werden abgelehnt.
- `diag_log_tail({ candidates, lines? }) -> { path, modifiedMs, lines } | null` – Ende (höchstens 192 KB) der zuletzt geänderten Datei unter den Kandidaten;
  nur Dateien im Benutzerordner, ANSI-Codes und Steuerzeichen entfernt.
- `diag_clear_quarantine({ path })` – `xattr -dr com.apple.quarantine` für ein vorhandenes `.app`-Paket (nur macOS). Die einzige ändernde Funktion.

Frontend `src/diagnose/`:

- `run.ts` `runDiagnosis(input)` prüft in dieser Reihenfolge: Anlass (Exit-Code/Signal/Ausgabe eines gescheiterten Starts, Emulator-Protokoll, Datei des Spiels),
  Spiele-Ordner, jeder Emulator (installiert, startbar, Quarantäne), BIOS/Firmware (nutzt `checkRequirements` aus `emulators/requirements.ts`; dazu Kopfprüfung:
  PS3-`.PUP` beginnt mit „SCEUF“, BIOS nicht nur Nullen/Einsen), alle Spieldateien der Bibliothek (lesbar, nicht leer, `.cue`-/`.m3u`-Teile vorhanden, kein Archiv,
  passende Endung, Ordnerform bei PS3/PS4/PSP). Ergebnis: `DiagnoseReport` mit `Finding`s (`error|warn|info|ok`, Erklärung mit nächstem Schritt, optional `fix`).
  `applyFix()` führt `copy-bios` (über `bios_copy`) und `clear-quarantine` aus; `open-emulators|open-files|open-games-dir` öffnet der Aufrufer.
- Protokoll von RPCS3 (`RPCS3.log`): Windows `<rpcs3.exe-Ordner>/log/` (bzw. `portable/log/`), sonst im Cache-Ordner. Es wird nach einem
  fehlgeschlagenen Start gelesen; nur die gezielten RPCS3-Regeln (Firmware fehlt/zu alt, Disc-Schlüssel fehlt, Pfad kein Spiel, Installationsort ohne
  Schreibrechte) werten es aus. Die Texte stammen aus `Emulator.cpp` (`game_boot_result`) und `rpcs3.cpp`.
- `rules.ts` – reine Regeln: erlaubte Endungen je Emulator, Protokollpfade, Muster für typische Fehlermeldungen (BIOS/Firmware/Lizenz/Abbild/Rechte/Quarantäne/Architektur/Grafik …).
  Die Muster sind bewusst weit gefasst, die Texte vorsichtig („vermutlich“). Es gibt **keine** Hashlisten bekannter BIOS-Dateien (nichts davon wird mitgeliefert).
- `DiagnoseDialog.tsx` – Liste der Befunde (Probleme, Hinweise, In Ordnung), „Behebbares beheben“, „Neu prüfen“, Protokolle, „Bericht kopieren“.
- Einstiege: Einstellungen → „Diagnose“ (`open-diagnose`) und **automatisch**, wenn ein Start scheitert (`onDiagnose` in `useGameLauncher`, Anlass = `DiagnoseContext`);
  ohne `onDiagnose` zeigt der Starter wie bisher den Fehlerdialog.

### Spielebibliothek (`library.rs`)
Ein einziger Spiele-Ordner genügt: Der Nutzer legt Spiele unsortiert hinein (auch in Unterordner), die App sortiert **nur virtuell**, es wird nie
etwas verschoben, umbenannt oder entpackt.

- `games_scan({ dir }) -> { root, games: [ScannedGame], images: [relPfad], truncated, unreadable }` – durchsucht `dir` rekursiv (Tiefe 12, höchstens 20 000 Spiele;
  versteckte Einträge, Papierkörbe und Verknüpfungen auf Ordner werden übersprungen) und erkennt das System jedes Spiels.
  `ScannedGame`: `path` (absolut), `rel` (relativ zum Spiele-Ordner, stabiler Schlüssel), `name`, `kind` (`file` | `folder` | `bundle`), `ext`, `size`,
  `system` (`PS1` `PS2` `PS3` `PS4` `PSP` `GameCube` `Wii` oder `null`), `how` (`content` | `serial` | `format` | `folder` | `size` | `none`), `uncertain`,
  `guess` (Vorschlag bei `null`), `serial`, `title` (aus `PARAM.SFO`/Disc-Kopf), `reason` (Begründung, für die Beschreibung im Menü).
- **Reihenfolge der Erkennung** (sicher → vage), das erste Ergebnis gilt:
  1. *Inhalt* (nur die ersten Sektoren werden gelesen, `covers/embedded.rs`): `PS3_GAME/PARAM.SFO` oder `PS3_DISC.SFB` → PS3, `PSP_GAME/PARAM.SFO` und `EBOOT.PBP` → PSP, Ordner mit `eboot.bin` und `sce_sys/param.sfo` (Titelnummer `CUSA…`, die Vita hat denselben Aufbau mit `PCS…`) → PS4,
     `SYSTEM.CNF` mit `BOOT2` → PS2, mit `BOOT` → PS1, Disc-Kopf mit GameCube-/Wii-Kennung (auch in `.rvz`, `.wia`, `.wbfs`, `.ciso`). Entpackte Spieleordner (`PS3_GAME/`, installierte PS3-Spiele,
     `PSP_GAME/`) sind **ein** Spiel und werden nicht weiter durchsucht.
  2. *Seriennummer im Dateinamen*, nur wo das Präfix eindeutig ist (PS3: `BLUS`, `BCES`, `NPUB` …; PSP: `ULES`, `UCUS`, `NPUZ` …; PS4: `CUSA` …). PS1 und PS2 teilen sich ihre Präfixe (`SLUS`, `SCES` …), dort entscheidet nur der Inhalt.
  3. *Dateiformat*: `.cso` → PSP, `.pkg` (Kopf `\x7fPKG`, Typ 1) → PS3, `.pkg` (Kopf `\x7fCNT`) → PS4, ELF-Maschine PowerPC64 → PS3, `.dol`/`.gcz`/`.gcm` → GameCube. Ein PowerPC- oder MIPS-ELF ist nicht eindeutig (nur Vorschlag).
  4. *Ordnername* irgendwo über der Datei (`PS3`, `PlayStation 2 Spiele`, `Wii-Spiele` …) – die alte Struktur `<System>/<Spiel>` funktioniert unverändert. Ein Inhalt, der etwas anderes sagt, geht vor.
  5. *Größe* bei CHD (MAME-Kopf v5): CD-CHD über 800 MB ist keine PS1 → PS2, DVD-CHD über 1,9 GB ist keine PSP → PS2. Eine kleine CD-CHD gilt als PS1, aber `uncertain` (Menü: „vermutet“).
  Bleibt nichts übrig, ist `system` `null`: Das Spiel erscheint unter „Nicht zugeordnet“.
- Zusammengehörendes ist **ein** Spiel: `.cue` mit allen `.bin`-Spuren (ein `.bin` neben gleichnamiger `.cue` ebenso), `.m3u` mit den aufgezählten Discs; das System kommt von der ersten Disc.
  macOS-`.app`-Pakete (`kind: "bundle"`) starten direkt ohne Emulator und erscheinen unter „Programme“.
- Cache: `library-scan.json` im App-Cache-Ordner merkt sich das Prüfergebnis je Datei (Pfad, Größe, Änderungszeit; anderer Spiele-Ordner → verworfen). Der zweite Start liest also nur noch Ordnerlisten.
- Frontend: `src/library/scanGames.ts` (`scanGamesDir`, `buildLibraryCategories`, Cover-Zuordnung aus der Bilderliste), `useGameLibrary(baseDir, autoCovers, overrides)`.
  Kategorien: eine je System („Spiele · PS3“), danach „Programme“ und „Nicht zugeordnet“. Eintrags-ID `games/<rel>`.
- **Zuordnung von Hand**: ✕ auf einem Spiel unter „Nicht zugeordnet“ öffnet `AssignSystemList` (Vorschlag zuerst), △ auf jedem Spiel ändert das System, „Nicht anzeigen“ blendet aus.
  Gespeichert wird nur in `settings.gameSystems` (`rel` → System | `"ignore"`); die Kategorien werden daraus neu gebaut, ohne den Ordner erneut zu lesen. Einstellungen → „Spiele-Zuordnung“
  (`AssignmentsList`) setzt einzelne oder alle Zuordnungen zurück. Der Emulator ergibt sich weiter aus dem Systemnamen (`emulatorForSystem`, `src/emulators/catalog.ts`).
- Browser (`npm run dev`): Demo-Daten (`mockLibrary.ts`) laufen durch dieselbe Pipeline, dazu eine Beispieldatei „Mystery Disc.iso“ unter „Nicht zugeordnet“.
### Downloads und Einrichtung (`downloads.rs`, `hashing.rs`)
Grundlage für „Einstellungen → Einrichtung & Downloads“ (`src/install/`). Die App bringt keine Quellen für Spiele, BIOS oder Firmware mit.
- `download_start({ req: { id, url, destDir, fileName?, sha256?, allowedHosts?, allowHttp?, blockExecutables? } }) -> { path, fileName, size, resumed, alreadyPresent, sha256 }` –
  lädt eine Datei streamend nach `<destDir>/<Name>.part` und benennt sie am Ende um. Fortsetzen: ein abgebrochener Download bleibt als `.part` samt Merkzettel
  (`.part.json` mit Adresse, ETag/Last-Modified) liegen und wird per `Range`/`If-Range` fortgesetzt; liefert der Server etwas anderes, beginnt er von vorn.
  Nur https (http nur mit `allowHttp`, für selbst eingetragene Adressen); Weiterleitungen nur auf `allowedHosts` (leer = nur der Server der Adresse,
  `*.beispiel.de` = Unterserver) und nie von https zu http; Dateiname aus `fileName`, sonst `Content-Disposition`, sonst Adresse – immer bereinigt
  (kein Pfad, keine Windows-Sonderzeichen); eine Webseite statt einer Datei wird abgelehnt; `blockExecutables` lehnt .exe/.sh/… ab; vorhandene Dateien werden nie
  überschrieben (`Name (2).iso`), eine gleich große vorhandene Datei wird nicht neu geladen (`alreadyPresent`). 60 s ohne Daten = Abbruch mit Hinweis zum Fortsetzen.
  Stimmt `sha256` nicht, wird die Datei verworfen. Event `download-progress` `{ id, received, total, state: starting|running|verifying|done|failed|cancelled, message, partPath }`.
- `download_cancel({ id }) -> boolean` (das Teilstück bleibt), `download_discard({ partPath })` (löscht nur `….part` samt Merkzettel).
- `file_fingerprint({ path }) -> { size, head, md5, sha256 }` – ein Durchgang, eigene SHA-256-/MD5-Implementierung (`hashing.rs`, keine neuen Pakete).
- `install_platform() -> { os, arch, emulatorsDir, home }` – macOS `~/Applications`, sonst `<Datenordner>/JellyStation/Emulators`.
- `install_archive({ req: { archive, id, destRoot, exePattern?, removeArchive? } }) -> { path, root }` – entpackt mit Bordmitteln (macOS `ditto`/`hdiutil` für .dmg,
  Windows `System32\tar.exe`, sonst `unzip`/`tar`; `.7z` über `tar`/7-Zip, sonst Hinweis zum Entpacken von Hand). macOS: die `.app` kommt nach `destRoot`. Windows/Linux:
  Inhalt wird in `destRoot/<id>` zusammengeführt (eigene Einstellungen und Spielstände des Emulators bleiben), die Programmdatei wird per `exePattern` gesucht.
- Frontend `src/install/`: `backend.ts` (Hülle), `github.ts` (`pickAsset`: Archiv je Betriebssystem/Prozessor aus der GitHub-Antwort, `digest` = SHA-256), `sources.ts` (macOS aus
  `emulators.json`, Windows eigene Tabelle – ungeprüft gegen echte Releases, Dateinamen werden zur Laufzeit gelesen), `emulatorInstall.ts`, `biosCheck.ts` (Größe, Dateikopf
  „SCEUF“ der PS3-Firmware, bekannte PS1-MD5; unbekannte Prüfsumme ist kein Fehler), `gameSources.ts` (Quellen: Datei, Verzeichnisseite, Adressliste, JSON; Server außerhalb der Quelle
  müssen bestätigt werden), `downloadQueue.ts` (Warteschlange, lebt so lange wie die App), `InstallDialog.tsx`, `GameSourcesDialog.tsx`. Einstellung: `settings.gameSources`.
  Im Hauptmenü steht die Spalte „Spiele laden“ (`games-get` in `App.tsx`, hinter den Spiele-Systemen): „Link einfügen und laden“ öffnet `GameSourcesDialog` mit `start="link"` (Datei-Link wird sofort geladen, Listen-Link als unsichtbare Quelle zur Auswahl; △ speichert sie), dazu Verknüpfungen zu Quellen/Downloads, BIOS & Firmware und Einrichtung.
  Spiele landen im Spiele-Ordner (`settings.gamesDir`), bei Bedarf in einem Unterordner-Hinweis der Quelle; das System erkennt `library.rs` danach selbst. PS3-Firmware lädt die App nur von Adressen auf playstation.com/.net und sony.com, die der Nutzer einfügt.
- Prüfung der reinen Logik ohne Fenster und Netz: `node dev/check-install-logic.mjs`; Rust-Tests: `cargo test --lib -- downloads hashing` (lokaler Mock-Server).

### Cover (`covers.rs`)
- `cover_resolve({ system, path, title, online, retry? }) -> { path, source: "embedded"|"online"|"cache"|null, width, height, serial, error }` –
  liefert eine Bilddatei im Cache für ein Spiel ohne eigenes Bild. Reihenfolge: Cache → eingebettet → online. Ein Treffer
  wird unverändert abgelegt (`<App-Cache>/covers/<system>/<hash>.png|jpg|webp`, Name aus Hash von System und Spielname).
  `online: false` ruft nichts im Netz ab. `error` ist gesetzt, wenn nur ein Netzproblem die Suche verhindert hat (kein „nicht gefunden“).
  `retry: true` ignoriert den Merker „nicht gefunden“ (Knopf „Jetzt nach fehlenden Covern suchen“).
- Eingebettet (`covers/iso.rs`, `embedded.rs`): ISO 9660 nur lesend (2048-Byte-Sektoren, auch rohe 2352-Byte-Abbilder Mode 1/Mode 2 Form 1),
  nie komplett gelesen. PS3: `PS3_GAME/ICON0.PNG` (320x176, Querformat) und `PARAM.SFO`; PSP: `PSP_GAME/ICON0.PNG`; PS4: `sce_sys/icon0.png` und `param.sfo` im Spieleordner; PS1/PS2: `SYSTEM.CNF`
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
- `getMovieInfo(ctx, id) -> MovieInfo` (`movie.ts`): Einzelabruf eines Films für die Detailseite – Logo (`Images/Logo`), Hintergrundbild (`Images/Backdrop`), Tagline, Altersfreigabe, Wertung, Regie/Besetzung
  und je Fassung (`MediaSources`) die Ton- und Untertitelspuren mit ihren Stream-Indizes.
- **Film-Detailseite** (`src/movie/MovieScreen.tsx`, `useMovieData.ts`): ✕ auf einem Film (Filme, Zuletzt) öffnet erst diese Seite, nicht den Player. Links Logo (sonst der Titel als Text), Eckdaten, Beschreibung;
  rechts die Optionen: Abspielen bzw. Fortsetzen bei …, Von vorn, Fassung, Tonspur, Untertitel (←/→ schalten durch, ✕ öffnet eine Liste), Als gesehen markieren, Farbe. Die Wahl geht als `choice`
  (`mediaSourceId`, `audioIndex`, `subtitleIndex`; `null` = Untertitel aus) über `Player` an `PlayerEngine.open` und von dort in `planPlayback`; „Automatisch“ überlässt es dem Server bzw. der gemerkten Sprache.
  Ist der Abruf der Details fehlgeschlagen, bleibt Abspielen möglich. Demo-Filme zeigen nur Abspielen und Farbe.

## Stremio (`src/stremio/`)

Zweite Quelle neben Jellyfin: „Streaming auf Abruf“ über das offene Addon-Protokoll (https://github.com/Stremio/stremio-addon-sdk).
Die App bringt **keine** Addons mit und empfiehlt keine. Der Nutzer meldet sich unter Einstellungen → „Verbindungen“ → Stremio mit seinem Stremio-Konto an
(lädt dessen Addons) und/oder trägt Addon-Adressen von Hand ein (`stremio://` und fehlendes `/manifest.json` werden ergänzt, Prüfung per Manifest-Abruf).
Gespeichert wird `settings.stremio: { addons: [{ id, url, name, fromAccount? }], account?: { email, authKey } }` – **nie das Passwort**.

**Warum Kataloge von Cinemeta kommen:** Stream-Addons (Torrentio & Co.) haben keine Kataloge, sie liefern nur Streams. Die Titellisten in Stremio kommen von
Cinemeta, das in jedem Konto vorinstalliert ist. `addons.ts` → `effectiveAddons()` ergänzt Cinemeta deshalb still, wenn es nicht eingetragen ist; ein Ausfall
von Cinemeta wird nur gemeldet, wenn sonst nichts da ist. Ohne Konto und ohne Addons gibt es keine Stremio-Spalten.

- `account.ts` – Konto über `api.strem.io`: `login` (E-Mail + Passwort → `authKey`), `addonCollectionGet` (Addons mit Manifest; das „Lokale Dateien“-Addon (`/local-addon/`) und Addons ohne Katalog/Meta/Stream wie reine Untertitel-Addons fallen weg), `logout`. `useStremioAccountSync.ts` lädt die Liste einmal pro
  App-Start neu (`addons.ts` → `mergeAccountAddons()` ersetzt nur Einträge mit `fromAccount`, von Hand eingetragene bleiben).
- `api.ts` – Abrufe `manifest.json`, `catalog/<typ>/<id>.json`, `catalog/<typ>/<id>/search=<Begriff>.json`, `meta/…`, `stream/…` (in Tauri über das HTTP-Plugin, im Browser
  über `fetch`, 12 s Frist). `supports()` wertet `resources`/`types`/`idPrefixes` aus, `listCatalogs()` liefert Kataloge ohne Pflicht-Zusatzangabe, `findSearchCatalog()` den
  ersten mit `search`. `parseStreams()` behält nur Streams mit direkter http(s)-Adresse und ohne `proxyHeaders`; Torrent (`infoHash`), `ytId`, `externalUrl` zählt die Oberfläche als „ausgeblendet“
  (keine Torrent-Engine; mit einem Debrid-Dienst im Addon sind die Links direkt).
- `manifests.ts` – Manifest-Cache pro Adresse (der Abruf läuft unabhängig vom Abbruch einzelner Aufrufer; Konto-Manifeste werden vorab eingetragen).
- `library.ts`, `useStremioLibrary.ts` – je Addon bis zu zwei Kataloge pro Typ (Filme/Serien), höchstens 100 Titel je Katalog und 8 Spalten insgesamt. Jeder Katalog wird eine XMB-Spalte
  hinter den Serien („Beliebt – Filme“, „Empfohlen – Serien“ …). Davor steht die Einstiegsspalte „Stremio“ (immer sichtbar): „Suchen …“ und „Konto & Addons“. Einträge tragen `entry.stremio` (`StremioRef`).
- `search.ts` – Suche in allen Addons, deren Katalog `search` versteht (Cinemeta tut das); gleiche Titel erscheinen einmal.
- `setup/steps.tsx` → `StremioStep` – derselbe Login und Addon-Eintrag als optionaler Schritt 2 des Setup-Assistenten (Schrittnummern: `SETUP_STEP` in `SetupWizard.tsx`).
- `api.ts` – Netz: In Tauri erst das HTTP-Plugin, scheitert es, das Fetch des Fensters (Rückfall). Netzfehler nennen den Rechner und die technische Ursache („api.strem.io ist nicht erreichbar (…)“). Adressen werden toleriert (`stremio://`, eingefügte `…/configure`-Seite, Anführungszeichen); `parseManifest` füllt fehlenden Namen/ID aus dem jeweils anderen und kommt auch ohne `resources` aus, wenn Kataloge da sind.
- `src/connections/ConnectionsDialog.tsx` – „Einstellungen → Verbindungen“ (Aktion `open-connections`): eine Zeile je Dienst (Jellyfin, Stremio) mit Statuspunkt und Meldung. Beim Öffnen werden beide geprüft (`testJellyfinAddresses`, `stremio/check.ts` → `checkStremio`: Kontoschlüssel gültig, von Hand eingetragene Addons antworten); ✕ öffnet die Einrichtung (`SetupWizard` mit `onlyStep` bzw. `StremioAddonsDialog`) und kehrt danach zur Liste zurück, △ prüft erneut. Die alten Einträge „Server“ und „Stremio“ in den Einstellungen sind darin aufgegangen.
- `StremioAddonsDialog.tsx` – Konto-Login/-Abmeldung/-Neuladen, Addon-Liste, Addon von Hand hinzufügen oder (△) entfernen. Konto-Addons verwaltet man in Stremio selbst.
- `StremioPicker.tsx` – Film: Streams aller Addons mit passendem Typ/ID abfragen → Liste → Player. Serie: Meta laden → Staffeln → Folgen → Streams.
  ○ geht je eine Stufe zurück. `resolve.ts` fragt die Addons gleichzeitig ab; ein stummes Addon hält die anderen nicht auf.
- `plan.ts` – `makeStremioPlan()`: Wiedergabeplan für eine direkte Adresse (Direktwiedergabe, `.m3u8` als HLS, keine Berichte/Umwandlung/Spuren). Die Engine nutzt ihn für Einträge mit
  `entry.stremio.streamUrl` im selben Zweig wie die Demo (`isDemoEntry` = kein Jellyfin-Titel).
- Noch nicht dabei: gespeicherte Position („Weiterschauen“), Untertitel aus Addons, „Nächste Folge“, Anmeldung über Google/Facebook (in Stremio ein Passwort festlegen).
- Test: `dev/mock-stremio/server.mjs` (Mock-Addon) und `dev/e2e/stremio.mjs` (Playwright, Aufruf im Skriptkopf).

## Suche (`src/search/`)

Der Eintrag „Suchen …“ in den Spalten „Suche“ und „Stremio“ (Aktion `open-search`), darunter die zuletzt gesuchten Begriffe (localStorage, `history.ts`).
`SearchDialog.tsx`: Suchfeld → Trefferliste nach Quelle und Typ (Jellyfin · Filme/Serien, Stremio · Filme/Serien). Jellyfin über `searchJellyfin()` in `jellyfin/library.ts`
(`/Items?searchTerm=`, mit dem gewählten Benutzer), Stremio über `stremio/search.ts`. Ein Treffer öffnet wie in den Spalten: Jellyfin-Film → Player, Jellyfin-Serie → Serien-Screen,
Stremio-Titel → Stream-Auswahl. Beide Quellen laufen gleichzeitig; fällt eine aus, steht der Grund unter der Liste.

## Oberfläche

- `src/ui/popup/`: `PopupList` (Liste im PS3-Stil, Tastatur + Controller, ✕/○/△), `ConfirmDialog`, `MessageDialog`,
  `ProgressDialog`, `OverlayFrame`. Alle Dialoge geben Eingabe frei, wenn `active={false}`.
- `src/player/Player.tsx`: Vollbild-Player. `src/emulators/…`: `EmulatorsDialog`, `useEmulators`, Start-Overlay.
- App.tsx hält genau ein Overlay-Objekt (`overlay: null | {kind: …}`); solange es gesetzt ist, ist das Hauptmenü gesperrt.

## Tests

Es gibt bewusst keine Test-Bibliothek im Projekt. Geprüft wird mit Playwright (Chromium) gegen den Vite-Dev-Server,
einem Mock-Jellyfin-Server (`dev/mock-jellyfin/`) und – für die Rust-Befehle – mit `cargo test` sowie einem Lauf der echten
Tauri-App unter Linux (xvfb + WebKitGTK).
