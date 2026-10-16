## JellyStation 0.3.2

Nicht signierte App: Mac beim ersten Öffnen Rechtsklick → „Öffnen“, Windows-SmartScreen → „Weitere Informationen“ → „Trotzdem ausführen“.
Spiele, BIOS und Firmware bringst du selbst mit.

### Neu

- **ffmpeg eingebaut**: Windows-Installer und Mac-DMG bringen ffmpeg mit. Streams, die das WebView nicht abspielt, werden lokal zu HLS umgewandelt (Stremio).
- **Einstellungen → Verbindungen**: Jellyfin und Stremio mit Status und Prüfung an einer Stelle.
- **Liquid-Glass-Stil** (wählbar) und überarbeitete Bedienkonsole im Player.
- **PS3-Spiele reparieren sich selbst**: Disc-Schlüssel ablegen, Firmware einspielen oder laden, einmal neu starten.
- **PS3-Firmware** (Version 4.93) direkt von Sonys Update-Server laden.

### Verbessert

- **Player**: weniger Puffern (Bandbreitentest für „Automatisch“, großzügigere Puffer), Ladekreisel nur bei echtem Stocken, Vorschau-Video erst beim Spulen. Formatfehler im Stream lösen automatisch die Umwandlungsstufen aus.
- **Windows/RPCS3**: .exe-Suche, Firmware-Prüfung neben der rpcs3.exe, RPCS3-Protokoll in der Diagnose.
- **Jellyfin-Verbindung**: technischer Fehlergrund, Tailscale-Hinweis bei Zeitüberschreitung.
- **Stremio**: klare Netzfehler und tolerantere Addon-Adressen.
- **Design**: lesbarere Zweittexte, eigene Symbole in den Einstellungen, saubereres Gamepad-Icon, Film-Seite bündig, Systemnamen nicht mehr dauerhaft unter den Controller-Icons.

### Download

Mac (Apple Silicon und Intel) und Windows findest du unten unter „Assets“ bzw. über die Links in der README.
