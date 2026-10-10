# JellyStation – Hinweise für Claude

Media-Hub im Stil der PS3-XrossMediaBar (XMB): Tauri 2 (Rust) + React 19 + TypeScript + Vite.
UI-Texte, Kommentare und Commit-Nachrichten sind **deutsch**.

## Befehle

- `npm install` bzw. `npm ci` – Abhängigkeiten
- `npm run dev` – nur Frontend im Browser (Demo-Daten, kein Tauri)
- `npm run typecheck` – TypeScript prüfen
- `npm run build` – `tsc --noEmit` + Vite-Build (vor jedem Abschluss ausführen)
- `npm run tauri dev` / `npm run tauri build` – komplette Desktop-App (braucht Rust-Toolchain)

Es gibt keine Unit-Tests. Die E2E-Skripte in `dev/e2e/` brauchen Playwright/Chromium bzw. xvfb und
tauri-driver und werden nur auf ausdrücklichen Wunsch ausgeführt (Aufrufe stehen jeweils im Skriptkopf).

## Wo liegt was

Ausführlich in `docs/ARCHITEKTUR.md` – vor größeren Änderungen lesen.

- `src/xmb/` Hauptmenü (`Xmb.tsx`), Hintergrund, Sound, Detailkarte, Styles in `xmb.css`
- `src/ui/` gemeinsame PS3-Bausteine (Popup-Listen, Dialoge, `PsSymbol`)
- `src/player/`, `src/jellyfin/`, `src/series/` Video-Player, Jellyfin-Zugriff, Serien-Screen
- `src/library/`, `src/emulators/`, `src/launcher/` Spielebibliothek, Emulator-Katalog, Spielstart
- `src/setup/`, `src/settings/` Setup-Assistent und Einstellungen (Tauri-Store bzw. localStorage im Browser)
- `src/input/` Gamepad-Hook
- `src-tauri/src/` Rust-Befehle (Medien-Proxy, Server-Suche, Web-Bereich, Emulator-Start, Cover)
- `scripts/` Installations- und Startskripte für macOS, `dev/` Testwerkzeuge und Mock-Jellyfin

## Konventionen

- Jede Eingabe (Tastatur, Maus, Controller) läuft durch denselben Handler (`dispatch` in `src/xmb/Xmb.tsx`),
  damit Fokus-Animationen und Sounds identisch sind. Neue Bedienelemente müssen mit Tastatur **und** Controller
  funktionieren. Overlays nehmen ihre Eingabe selbst entgegen und geben sie bei `active={false}` frei.
- Das Hauptmenü ignoriert jede Eingabe, solange ein Overlay offen ist.
- Im Browser (`npm run dev`) gibt es keine Tauri-Funktionen. Dort erscheinen Demo-Daten, Code darf das nicht voraussetzen.
- Rust-Befehle werden mit `invoke` aus `@tauri-apps/api/core` aufgerufen. Neue Befehle in `docs/ARCHITEKTUR.md` dokumentieren.
- Berechtigungen für Dateizugriffe stehen in `src-tauri/capabilities/`.

## Arbeitsweise

- Ein Branch pro Aufgabe, ausgehend von `main`, ein Pull Request pro Thema.
- Vor „fertig“: `npm run typecheck` und `npm run build` ausführen und die Ergebnisse nennen.
  Änderungen unter `src-tauri/` zusätzlich mit `cargo check` im Ordner `src-tauri` prüfen, falls möglich. Wenn nicht, offen sagen.
- Keine Änderungen an `.github/workflows/`, `package.json` (Abhängigkeiten) oder `src-tauri/Cargo.toml` ohne Rückfrage.
- Die Mac-App ist nicht signiert (siehe Kopfkommentar in `.github/workflows/build-mac.yml`). Das nicht „reparieren“.
- Spiele, BIOS und Firmware bringen Nutzer selbst mit. Nichts davon ins Repo legen und keine Download-Quellen dafür einbauen.
