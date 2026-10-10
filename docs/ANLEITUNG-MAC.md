# JellyStation auf dem Mac: installieren, starten, aktuell halten

Diese Anleitung ist für den Alltag gedacht: **Einmal einrichten, danach immer nur ein Befehl** – er holt die neueste
Version von GitHub und startet die App. Die Bilder stammen aus der Browser-Vorschau; im echten Fenster sieht es gleich aus,
nur dass dort zusätzlich der echte macOS-Ordnerdialog und der Emulator-Start funktionieren.

| Setup-Assistent | Hauptmenü mit Cover-Kacheln |
| --- | --- |
| ![Setup](images/setup-1-jellyfin.png) | ![Filme](images/xmb-filme.png) |

---

## 1. Einmalig einrichten (ein Befehl)

Öffne das **Terminal** (`Cmd + Leertaste`, „Terminal“ tippen, Enter) und füge diese **eine Zeile** ein:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dconair/jellystation/claude/serene-ride-x8ll06/scripts/bootstrap.sh)"
```

Was das Skript macht (du siehst jeden Schritt im Terminal):

1. prüft, ob `git` da ist – falls nicht, öffnet macOS ein Fenster der **Xcode-Tools**: dort auf **Installieren** klicken und warten;
2. lädt JellyStation nach `~/JellyStation` (dein Benutzerordner);
3. installiert fehlende Werkzeuge (Homebrew, Node.js, Rust) – dabei fragt es einmal nach deinem **Mac-Passwort**
   (beim Tippen erscheint nichts, das ist normal);
4. installiert die Pakete und richtet den Befehl **`jellystation`** ein.

Am Ende steht: *„Fertig! Öffne ein neues Terminal-Fenster und tippe: jellystation“*. Das erste Einrichten dauert je nach
Internet etwa 5–15 Minuten.

> **Du hast die ZIP-Datei schon heruntergeladen?** Dann ist kein neuer Download nötig. Wechsle in den entpackten Ordner
> (im Terminal `cd ` tippen, den Ordner aus dem Finder ins Fenster ziehen, Enter) und führe aus:
> `bash scripts/bootstrap.sh`. Das Skript verbindet den Ordner mit GitHub; abweichende Dateien werden vorher gesichert.

---

## 2. Immer wieder: ein Befehl

Neues Terminal-Fenster öffnen und tippen:

```bash
jellystation
```

Das macht der Befehl der Reihe nach:

1. holt den neuesten Stand von GitHub und zeigt, was sich geändert hat (*„Aktualisiert: abc1234 → def5678“* samt Liste);
2. installiert neue Pakete nur dann, wenn sich etwas an den Abhängigkeiten geändert hat;
3. zeigt oben die Version (*„JellyStation 0.1.0 (def5678 – Betreff)“*);
4. startet das App-Fenster.

Der allererste Start kompiliert den Rust-Teil und dauert **5–15 Minuten**; danach geht es in Sekunden.

| Befehl | Wirkung |
| --- | --- |
| `jellystation` | aktualisieren + App-Fenster starten |
| `jellystation --web` | aktualisieren + nur die Browser-Vorschau (`http://localhost:1420`) – ohne Rust, schnell zum Anschauen |
| `jellystation --build` | aktualisieren + fertige `JellyStation.app` bauen und öffnen |
| `jellystation --no-update` | ohne Update starten (z. B. offline) |
| `jellystation --status` | nur anzeigen, ob du aktuell bist – ändert nichts |
| `jellystation --help` | Hilfe |

Beenden: im Terminal `Strg + C`.

### Habe ich die richtige (neueste) Version?

- **Im Terminal:** `jellystation --status` zeigt deinen Stand und den auf GitHub, und ob sie übereinstimmen.
- **In der App:** *Einstellungen → Über JellyStation* zeigt Version und Commit (z. B. `0.1.0 · 7250fe6`) samt Beschreibung der letzten Änderung.
- **Auf GitHub:** Auf dem Branch `claude/serene-ride-x8ll06` steht oben der neueste Commit – dieselbe Kurznummer.

Eigene Änderungen an Dateien gehen beim Update nicht verloren: Sie werden vorher automatisch in einen Git-Stash gesichert
(`git stash list` zeigt sie).

---

## 3. Der Setup-Assistent beim ersten Start

Beim ersten Start gibt es noch keine gespeicherte Konfiguration. Das Hauptmenü wird dann gar nicht erst geladen,
stattdessen erscheint der Assistent. Er lässt sich mit der Tastatur **und** dem Controller bedienen
(✕ weiter · ○ zurück · △ überspringen · □ testen/prüfen, D-Pad = Fokus wechseln).

**Schritt 1 – Jellyfin** · Adresse (z. B. `http://192.168.1.20:8096`) und API-Key eintragen, **Verbindung testen**.
Den Key legst du in Jellyfin unter *Dashboard → API-Schlüssel* an.

![Schritt 1](images/setup-1-jellyfin.png)

**Schritt 2 – Spiele-Ordner** · **Ordner wählen …** öffnet den echten macOS-Dialog. Pro System ein Unterordner
(`PS3/`, `PS2/`, …). Liegt der Ordner in *Dokumente*, *Schreibtisch* oder auf einem externen Laufwerk, fragt macOS einmalig
nach Zugriff → **OK**.

![Schritt 2](images/setup-2-spiele.png)

**Schritt 3 – Controller** · DualShock 4 per USB oder Bluetooth (`PS` + `SHARE` halten, bis die Leuchtleiste blinkt;
am Mac unter *Systemeinstellungen → Bluetooth* verbinden), dann eine Taste drücken.

| Wartet | Erkannt | Taste gedrückt |
| --- | --- | --- |
| ![wartet](images/setup-3a-controller-wartet.png) | ![erkannt](images/setup-3b-controller-erkannt.png) | ![ok](images/setup-3c-controller-ok.png) |

**Schritt 4 – Prüfung** · prüft Jellyfin, Ordnerstruktur, RPCS3 unter `/Applications/RPCS3.app`, Emulator-Zuordnung und Controller.
Gelb (!) = Hinweis, Rot (✕) = muss behoben werden; **Erneut prüfen**, danach **Einrichtung abschließen** – alles wird
gespeichert und das Menü startet neu. *(Im Browser-Bild sind Ordner- und Emulator-Check gelb, weil sie nur in der Desktop-App prüfbar sind.)*

![Schritt 4](images/setup-4-pruefung.png)

Später erneut aufrufen: *Einstellungen → Einrichtung erneut ausführen*. Zurücksetzen (Assistent erscheint wieder):

```bash
rm ~/Library/Application\ Support/dev.jellystation.app/settings.json
```

Die Einstellungen liegen dort im Klartext – **auch der API-Key**.

---

## 4. Cover und Game-Art

| Filme/Serien aus Jellyfin | Spiele | Einstellungen |
| --- | --- | --- |
| ![Jellyfin](images/xmb-jellyfin-cover.png) | ![Spiele](images/xmb-spiele.png) | ![Einstellungen](images/xmb-einstellungen.png) |

- **Filme und Serien:** Sind Jellyfin-Adresse und API-Key gesetzt, lädt die App deine Titel samt Plakaten (bis zu 300 pro Art; mehr
  wird in der Kopfzeile gemeldet). Ohne Verbindung (oder bei Fehlern, mit Hinweis in der Kopfzeile) siehst du Demo-Titel.
  Abspielen: siehe Abschnitt 5a.
- **Spiele:** Lege ein Bild **neben das Spiel** – gleicher Dateiname, Endung `png`, `jpg`, `jpeg` oder `webp`
  (z. B. `Gran Turismo 5.iso` + `Gran Turismo 5.jpg`) – oder in einen Unterordner `covers/`, `media/covers/` oder `images/` des Systems.
  Ohne Bild erzeugt die App ein passendes Platzhalter-Cover im PS3-Hüllen-Stil.
- Bilder werden erst beim Scrollen in die Nähe geladen; neue Cover erscheinen nach einem Neustart der App.

---

## 5. Spiele starten (Emulatoren)

**Die Emulatoren richtet das Skript selbst ein.** Bei der Einrichtung (und jederzeit mit `jellystation --emulators`) prüft
`scripts/install-emulators.sh`, welche Emulatoren schon da sind, und installiert die fehlenden – ohne `sudo`:

| System (Ordnername) | Emulator | Installation |
| --- | --- | --- |
| PS1 | DuckStation | Download von GitHub |
| PS2 | PCSX2 | Homebrew (`pcsx2`) |
| PS3 | RPCS3 | Download von GitHub |
| PSP | PPSSPP | Homebrew (`ppsspp-emulator`) |
| GameCube / Wii | Dolphin | Homebrew (`dolphin`) |

Außerdem legt es die Ordner `~/JellyStation/Games/<System>` und `~/JellyStation/BIOS` an. **Du musst nur noch Spiele hineinlegen**
(Ordnername = System, z. B. `PS3/Gran Turismo 5.iso`). Spiele, BIOS-Dateien und PS3-Firmware werden nie mitgeliefert oder
heruntergeladen – das bringst du selbst mit (nur legal besessene Spiele). PS1/PS2 brauchen ein BIOS, RPCS3 die PS3-Firmware
(einmal in RPCS3 einspielen).

### BIOS und Firmware: prüfen statt Fehlermeldung

Manche Emulatoren starten ohne zusätzliche Dateien nicht. Die App prüft das **vorher** und sagt dir, was fehlt:

| System | Was gebraucht wird | Woher |
| --- | --- | --- |
| PS1 (DuckStation) | PS1-BIOS (z. B. `scph1001.bin`, 512 KB) | von der eigenen Konsole sichern |
| PS2 (PCSX2) | PS2-BIOS (`scph*.bin`/`.rom0`, ca. 4 MB) | von der eigenen Konsole sichern (Anleitung bei PCSX2) |
| PS3 (RPCS3) | PS3-Firmware `PS3UPDAT.PUP` (ca. 200 MB) | offiziell kostenlos bei Sony (Link in der App) |
| PSP, GameCube/Wii | nichts | – |

BIOS-Dateien werden **nicht** mitgeliefert und **nicht** heruntergeladen (urheberrechtlich geschützt) – dafür gibt es nur
Anleitungen und, bei der PS3-Firmware, den offiziellen Sony-Link.

- **Setup-Assistent, Schritt „Dateien“:** zeigt je Emulator, ob er installiert ist (mit Download-Seite), und je BIOS/Firmware, ob sie
  gefunden wurde. Dort wählst du den **BIOS-Ordner** (Standard `~/JellyStation/BIOS`; Unterordner wie `PS2/` werden mitgelesen).
  Ganz unten steht, was noch offen ist. Auch der Abschlusscheck („Prüfung“) meldet fehlende Dateien für Systeme, von denen Spiele da sind.
- **Einstellungen → BIOS & Firmware:** dasselbe jederzeit. Liegt die Datei im BIOS-Ordner, übernimmt **„In den Emulator übernehmen“**
  sie in den Datenordner von DuckStation bzw. PCSX2. Die PS3-Firmware spielst du in RPCS3 ein (*Datei → Firmware installieren*).
- **Beim Spielstart:** Fehlt das BIOS, erscheint statt einer Emulator-Fehlermeldung dieser Dialog. Er warnt nur einmal je Emulator –
  ein zweiter Start versucht es trotzdem (falls du das BIOS im Emulator an anderer Stelle eingestellt hast).
- Bei RPCS3 ist der Ablageort der Firmware auf dem Mac nicht sicher bekannt; „nicht gefunden“ ist dort nur ein Hinweis.

Im Menü: *Einstellungen → Emulatoren* zeigt je Emulator „Bereit“ oder „Fehlt“. Dort kannst du Fehlendes per Homebrew
installieren lassen, die Download-Seite öffnen, einen Pfad von Hand wählen oder das Startprotokoll ansehen.
Spiel anwählen und ✕ / `Enter`: Ein Start-Bildschirm erscheint, der Emulator öffnet sich, das Menü bleibt im Hintergrund und
zeigt „Läuft“. Fehlt der Emulator oder bricht der Start sofort ab, erscheint stattdessen ein Dialog mit der Ursache.
`.pkg` ist bei RPCS3 ein Installationspaket: erst in RPCS3 über *File → Install .pkg* installieren.
Ohne Spiele-Ordner zeigt die App Demo-Spiele; ein Start läuft dann nur zur Probe durch (ohne Prozess).

## 5a. Filme und Serien abspielen (Jellyfin)

Der Jellyfin-Server liefert, die App spielt ab – im PS3-Stil mit Bedienfeld unten, Spulleiste und Zeitanzeige.

- **Film:** anwählen, ✕. Gibt es einen gespeicherten Stand, fragt ein Dialog: *Fortsetzen bei …* oder *Von vorn beginnen*.
- **Serie:** ✕ öffnet die Folgenliste (nach Staffeln, mit Fortschrittsbalken und „Gesehen“-Haken); der Fokus liegt auf der
  Folge, mit der es weitergeht. Am Ende einer Folge bietet der Player „Nächste Folge“ mit Countdown an.
- **Wiedergabe:** Der Player fragt den Server, was dein Mac abspielen kann. Passt das Format, wird direkt abgespielt, sonst
  wandelt der **Server** per HLS um – die App muss nur dekodieren. Unter *Einstellungen → Wiedergabe* kannst du „Immer vom
  Server umwandeln“ einschalten. Tonspur, Untertitel, Qualität und Bildformat: △ (Optionen) im Player.
- **Fortschritt:** Position und „Gesehen“ werden zum Server zurückgemeldet (Benutzer wählbar unter *Einstellungen → Jellyfin-Benutzer*).
- Ist der Server nicht erreichbar, versucht die App es automatisch erneut (nach 15 s, 30 s, 60 s …); der Hinweis oben zeigt den Grund.
- Ohne eingerichteten Server spielt der Player ein kurzes Demo-Video.

Player-Tasten: ✕ Pause · ○ Beenden · △ Optionen · □ Anzeige · ←/→ Spulen (gedrückt halten = schneller) · ↑/↓ Lautstärke ·
L1/R1 ±30 s · L2/R2 vorherige/nächste Folge. Tastatur: Leertaste/Enter, Esc, `O`, `J`/`L`, `PageUp`/`PageDown`.

---

## 6. Bedienung

| Aktion | Tastatur | Controller (DualShock 4) |
| --- | --- | --- |
| Navigieren | Pfeiltasten, Mausrad | D-Pad / linker Stick |
| Öffnen | Enter | ✕ |
| Zurück (zum ersten Eintrag) | Esc / Backspace | ○ |
| Ton an/aus | M | |
| Vollbild | F11 | |

---

## 6a. Menüpunkte im Überblick

| Menüpunkt | Was er kann |
| --- | --- |
| **Zuletzt** | Startseite: angefangene Filme und Folgen aus Jellyfin (mit Fortschrittsbalken), die nächsten Folgen deiner Serien und zuletzt gespielte Spiele. ✕ spielt direkt weiter. |
| **Filme / Serien** | Serien öffnen einen Bildschirm wie bei Netflix: Weiterschauen-Knopf, **Staffel-Auswahl** (✕ öffnet die Liste, L1/R1 wechseln direkt), Folgenliste der gewählten Staffel. ✕ auf einer Folge öffnet die **Detailseite** (großes Bild, volle Beschreibung, Abspielen/Fortsetzen/Von vorn, als gesehen markieren). |
| **Spiele · PS1/PS2/PS3/…** | Pro Systemordner eine Spalte; **Cover** kommen automatisch (siehe unten). |
| **Web** | Eigene Lesezeichen (✕ öffnet in einem App-Fenster, △ löscht). Downloads landen im Ordner `Downloads` deines Spiele-Ordners; danach fragt die App, in welches System die Datei gehört. Es sind **keine Seiten vorinstalliert** – lade nur, was du besitzt oder legal beziehen darfst. Fremdseiten lassen sich nur mit Maus/Tastatur bedienen. |
| **Einstellungen** | Server (Adresse/Schlüssel ändern), Spiele-Ordner, Emulatoren, BIOS & Firmware, Jellyfin-Benutzer, Wiedergabe, **Anzeige & Farben**, **Cover & Grafiken**, **Animationen**, **Ton & Musik**, Einrichtung, Über. |

**Im Player:** Beim Spulen (←/→ halten, Maus auf der Leiste, Zifferntasten) erscheinen **Vorschaubilder** mit Zeit und Kapitel – von Jellyfin (Trickplay), sonst lokal erzeugt, bei Server-Umwandlung ohne Trickplay nur die Zeit. Nach einigen Sekunden Pause blendet das **Pause-Bild** (Hintergrund, Logo, Beschreibung aus Jellyfin) ein.

**Cover:** Zuerst zählt ein Bild neben dem Spiel (`Spiel.iso` + `Spiel.jpg`). Fehlt es, liest die App eingebettete Grafiken aus PS3-/PSP-Abbildern und holt sonst Boxart von `thumbnails.libretro.com` (nur Spiel- und Systemname werden gesendet; abschaltbar unter *Einstellungen → Cover & Grafiken*). Verschlüsselte PS3-ISOs haben keine lesbare Grafik – dann hilft nur Online oder ein eigenes Bild.

**Anzeige:** Helligkeit, Farbthema (auch eigener Farbton), Tag/Nacht-Verlauf, **Hintergrund-Design** (PS3-Wellen, Nordlicht, Sternenhimmel, Tiefsee, Neon-Gitter, nur Farbverlauf), Animationen voll/reduziert/aus und Tempo. **Musik:** leise, atmosphärische Hintergrundmusik wie auf der PS4 in vier Stimmungen – erzeugt im Programm, pausiert bei Filmen und Spielen; Taste `M` schaltet alles stumm.

---

## 7. Häufige Probleme

| Symptom | Lösung |
| --- | --- |
| `jellystation: command not found` | Neues Terminal-Fenster öffnen (oder `source ~/.zshrc`). Fehlt der Befehl weiter: `bash ~/JellyStation/scripts/install-launcher.sh` |
| `command not found: npm` / `cargo` | Einrichtung (Abschnitt 1) erneut ausführen – installiert fehlende Werkzeuge |
| Update meldet „Aktualisieren nicht möglich“ | Internet prüfen; die App startet mit dem vorhandenen Stand weiter |
| Erster Start dauert ewig | Normal (5–15 Min., Rust wird kompiliert), nur beim ersten Mal |
| Port 1420 belegt | Eine andere `jellystation`-Instanz beenden (`Strg + C`) |
| Spiele-Ordner „nicht erlaubt“ im Check | Ordner im Schritt 2 **über den Dialog** wählen (nicht tippen) |
| Spiel startet nicht | *Einstellungen → Emulatoren* öffnen: Dort steht, was fehlt (Installieren / Pfad wählen). Das Startprotokoll liegt im App-Log-Ordner (`launch.log`) |
| Controller nicht erkannt | Erst eine Taste drücken; das App-Fenster muss im Vordergrund sein |
| „Vorschau-Modus · Demo-Spiele“ | Spiele-Ordner nicht gefunden → *Einstellungen → Einrichtung erneut ausführen* |
| Kein Ton | Mit `M` prüfen, ob „Ton aus“ in der Kopfzeile steht; ein erster Tastendruck oder Klick aktiviert die Audioausgabe |

---

## 8. Ist das Repo öffentlich oder privat?

Aktuell ist `dconair/jellystation` **öffentlich**; dann funktionieren Einrichtung und `jellystation` ohne Anmeldung.
Stellst du es auf **privat** (GitHub → Settings → General → Danger Zone → Change visibility), brauchst du einmalig:

```bash
brew install gh
gh auth login      # im Browser anmelden
gh auth setup-git
```

Danach laufen Updates wie gewohnt. Der Einrichtungsbefehl aus Abschnitt 1 (`curl …raw.githubusercontent.com…`) funktioniert bei einem
privaten Repo nicht mehr; dann einmal manuell klonen: `gh repo clone dconair/jellystation ~/JellyStation -- --branch claude/serene-ride-x8ll06`
und `bash ~/JellyStation/scripts/bootstrap.sh`.

---

## 9. Kann Claude (Claude Code) das lokal alles selbst erledigen?

**Größtenteils ja.** Startest du **Claude Code auf deinem Mac** im Ordner `~/JellyStation`, kann Claude dort selbst Befehle ausführen:
`jellystation`, Fehlermeldungen lesen, Code reparieren, neu bauen. Anleitung zur Installation: <https://code.claude.com/docs>.

```bash
cd ~/JellyStation
claude
```

Dann zum Beispiel: *„Aktualisiere das Projekt und starte die App. Wenn etwas fehlschlägt, behebe es.“*

Was trotzdem nicht ohne dich geht:

- **Den Start musst du selbst machen** (Terminal öffnen, `claude`, einmal anmelden). Die Cloud-Sitzung, in der der Code entsteht, erreicht deinen Mac nicht.
- **Freigaben:** Claude Code fragt standardmäßig vor jedem Befehl. Du kannst Befehle vorab erlauben oder einen großzügigeren Modus wählen.
- **Nur du kannst:** Xcode-Installationsfenster bestätigen, Mac-Passwort eingeben, macOS-Dateizugriffsfragen beantworten,
  im Assistenten den Ordner wählen, den Controller koppeln, RPCS3 samt Firmware und deine Spiele bereitstellen, den Jellyfin-API-Key erzeugen.
- **Der Mac-Start ist noch ungetestet:** Rust-Teil und Skripte wurden unter Linux geprüft, nicht auf macOS. Hakt es beim ersten Mal,
  ist genau das der Fall, in dem Claude Code lokal am meisten hilft.
