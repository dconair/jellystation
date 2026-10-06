# JellyStation

Ein Media-Hub im Stil der PS3-XrossMediaBar (XMB) – Tauri 2 + React + TypeScript.

```bash
npm install
npm run dev          # nur Frontend im Browser (Demo-Daten)
npm run tauri dev    # komplette Desktop-App
npm run tauri build
```

> **Mac-Installation Schritt für Schritt (mit Bildern):** [docs/ANLEITUNG-MAC.md](docs/ANLEITUNG-MAC.md) ·
> alles in einem Befehl: `./scripts/setup-mac.sh --install-missing --open`

## Ersteinrichtung & Einstellungen

Beim Start wird zuerst die gespeicherte Konfiguration geladen (`src/settings`, Tauri-Store →
`~/Library/Application Support/dev.jellystation.app/settings.json`, im Browser `localStorage`).
Fehlt sie, erscheint statt des Menüs der Setup-Assistent (`src/setup`): Jellyfin-Zugang testen →
Spiele-Ordner per nativem Dialog wählen → Controller prüfen → Abhängigkeiten prüfen. Nach „Einrichtung abschließen“
wird alles gespeichert und das Menü mit den echten Werten neu gestartet. Erneut aufrufbar über
*Einstellungen → Einrichtung erneut ausführen*.

## Bedienung

| Aktion                      | Tastatur             | Controller (DualShock 4) |
| --------------------------- | -------------------- | ------------------------ |
| Navigieren                  | Pfeiltasten, Mausrad | D-Pad / linker Stick     |
| Bestätigen                  | Enter                | ✕ (Button 0)             |
| Zurück (zum ersten Eintrag) | Esc / Backspace      | ○ (Button 1)             |
| Ton an/aus                  | M                    |                          |
| Vollbild                    | F11                  |                          |

Alle Eingabewege laufen durch denselben Handler (`dispatch` in `src/xmb/Xmb.tsx`) und lösen
dieselben Fokus-Animationen und Soundeffekte aus. Der Gamepad-Hook liegt in `src/input/useGamepad.ts`.

## Spielebibliothek

- Basisordner: wird im Setup gewählt (gespeichert in den Einstellungen); `GAMES_BASE_DIR` in `src/config/games.ts` ist nur der Standardwert.
- Struktur: `<Basisordner>/<System>/<Spiel>.<iso|app|pkg|cue|chd|bin|elf>` – jeder Systemordner wird zu einer
  Kategorie „Spiele · <System>“, der Dateiname ohne Endung ist der Titel.
- Existiert der Ordner nicht (oder läuft die App im Browser), erscheinen Demo-Daten
  (3 Konsolen × 5 fiktive Spiele, Hinweis „Vorschau-Modus“).
- Per Dialog gewählte Ordner werden zur Laufzeit für das Auslesen freigegeben und per `persisted-scope` gemerkt;
  die festen Pfade in `src-tauri/capabilities/library.json` gelten nur für den Standardordner und RPCS3.

## Emulatoren (macOS)

- Zuordnung System → Emulator: `EMULATORS` in `src/config/games.ts` (aktuell `PS3` → RPCS3).
- Absolute Pfade der Programme stehen im Shell-Scope `src-tauri/capabilities/emulators.json`
  (`/Applications/RPCS3.app/Contents/MacOS/rpcs3`). Weitere Emulatoren dort und in `EMULATORS` ergänzen.
- Gestartet wird per `spawn`; die XMB bleibt offen und zeigt „Läuft“ am Eintrag.
