# JellyStation

Ein Media-Hub im Stil der PS3-XrossMediaBar (XMB) – Tauri 2 + React + TypeScript.

```bash
npm install
npm run dev          # nur Frontend im Browser (Demo-Daten)
npm run tauri dev    # komplette Desktop-App
npm run tauri build
```

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

- Basisordner: `GAMES_BASE_DIR` in `src/config/games.ts` (aktuell Platzhalter `~/JellyStation/Games`).
- Struktur: `<Basisordner>/<System>/<Spiel>.<iso|app|pkg|cue|chd|bin|elf>` – jeder Systemordner wird zu einer
  Kategorie „Spiele · <System>“, der Dateiname ohne Endung ist der Titel.
- Existiert der Ordner nicht (oder läuft die App im Browser), erscheinen Demo-Daten
  (3 Konsolen × 5 fiktive Spiele, Hinweis „Vorschau-Modus“).
- Beim Wechsel auf einen echten Pfad zusätzlich `src-tauri/capabilities/library.json` (fs-Scope) anpassen.

## Emulatoren (macOS)

- Zuordnung System → Emulator: `EMULATORS` in `src/config/games.ts` (aktuell `PS3` → RPCS3).
- Absolute Pfade der Programme stehen im Shell-Scope `src-tauri/capabilities/emulators.json`
  (`/Applications/RPCS3.app/Contents/MacOS/rpcs3`). Weitere Emulatoren dort und in `EMULATORS` ergänzen.
- Gestartet wird per `spawn`; die XMB bleibt offen und zeigt „Läuft“ am Eintrag.
