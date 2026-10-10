import { useEffect, useRef } from "react";
import { paletteFor } from "./background/palette";
import { createScene } from "./background/scene";
import { getUiPrefs, subscribeUiPrefs, themeHue } from "../prefs/uiPrefs";

// Animationszeit in Sekunden. Liegt außerhalb der Komponente, damit der Hintergrund beim
// Wechsel vom Setup ins Menü (neues Canvas) oder nach einer Spielpause nicht zurückspringt.
let animTime = 0;
// Eigene Zeit der Wellen: so ändert ein Tempowechsel die Phase nicht schlagartig.
let waveTime = 0;

/** Längste Zeit, die ein einzelner Frame vorrücken darf (z. B. nach dem Aufwachen aus dem Standby). */
const MAX_STEP = 0.1;
/**
 * Mindestabstand zwischen zwei gezeichneten Frames (ms), also höchstens ca. 30 Bilder pro Sekunde.
 * Alles hier bewegt sich nur wenige Pixel pro Sekunde; die Menü-Animationen laufen unabhängig davon
 * weiter mit voller Bildrate, der Hintergrund spart aber die Hälfte der Zeichenarbeit.
 */
const FRAME_MS = 28;
/** Alle so viele Animationssekunden wird geprüft, ob Monat/Tageszeit eine neue Farbe verlangen. */
const PALETTE_CHECK = 30;

/**
 * PS3-Hintergrund auf einem einzigen Canvas: Monatsfarbe, seidige Wellenbänder, Lichtpartikel
 * und langsam fliegende PlayStation-Symbole. Bei `paused`, ausgeblendetem Fenster oder
 * "Bewegung reduzieren" läuft keine Animation – dann bleibt ein Standbild mit allen Formen stehen.
 */
export function Background({ paused = false }: { paused?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Liegt eine Menü-Bühne (--stage-shift) um den Hintergrund, sitzt der Lichtschein dahinter.
    const parent = canvas.parentElement;
    const menuGlow = !!parent && getComputedStyle(parent).getPropertyValue("--stage-shift").trim() !== "";
    const currentPalette = () => {
      const p = getUiPrefs();
      return paletteFor(new Date(), { hue: themeHue(p), dayNight: p.dayNight });
    };
    const scene = createScene(canvas, ctx, currentPalette(), { menuGlow });
    const applyLayers = () => {
      const p = getUiPrefs();
      scene.setLayers({ ribbons: p.waves, dust: p.dust, floaters: p.shapes && p.animations !== "reduced" });
    };
    applyLayers();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = -1;
    let sincePalette = 0;

    const refreshPalette = () => scene.setPalette(currentPalette());
    const waveSpeed = () => {
      const p = getUiPrefs();
      return p.waveSpeed * (p.animations === "reduced" ? 0.4 : 1);
    };

    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      if (last >= 0 && ms - last < FRAME_MS) return;
      // Zeit kommt aus dem rAF-Zeitstempel, nicht aus Date.now().
      const dt = last < 0 ? 0 : Math.min((ms - last) / 1000, MAX_STEP);
      last = ms;
      animTime += dt;
      waveTime += dt * waveSpeed();
      sincePalette += dt;
      if (sincePalette > PALETTE_CHECK) {
        sincePalette = 0;
        refreshPalette();
      }
      scene.draw(animTime, waveTime);
    };

    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    // Entscheidet neu, ob animiert wird oder nur ein Standbild steht.
    const sync = () => {
      stop();
      last = -1;
      refreshPalette();
      if (document.hidden) return;
      // Auch das Standbild zeigt Bänder, Partikel und Formen – nur eben ohne Bewegung.
      scene.draw(animTime, waveTime);
      // Bei pausiertem Hintergrund (z. B. laufendes Spiel) keine GPU-Zeit verbrauchen.
      if (!paused && !reduce.matches && getUiPrefs().animations !== "off") raf = requestAnimationFrame(tick);
    };

    const onResize = () => {
      // Eine neue Canvas-Größe leert die Zeichenfläche. Sofort neu zeichnen – sonst würde der nächste
      // Frame (wegen der Bildraten-Begrenzung evtl. erst einer später) ohne Bänder und Formen erscheinen.
      scene.resize();
      if (!document.hidden) scene.draw(animTime, waveTime);
    };

    scene.resize();
    sync();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", sync);
    // Einstellungen wirken sofort: Farbthema, Ebenen und Animationsmodus.
    const unsubscribe = subscribeUiPrefs(() => {
      applyLayers();
      sync();
    });
    // Ältere WebKit-Versionen (macOS 10.x) kennen nur das veraltete addListener.
    if (reduce.addEventListener) reduce.addEventListener("change", sync);
    else reduce.addListener(sync);

    return () => {
      stop();
      unsubscribe();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", sync);
      if (reduce.removeEventListener) reduce.removeEventListener("change", sync);
      else reduce.removeListener(sync);
    };
  }, [paused]);

  return <canvas ref={ref} className="xmb-background" aria-hidden="true" />;
}
