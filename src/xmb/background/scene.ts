import { createDust } from "./dust";
import { createFloaters } from "./floaters";
import { type Palette, glowColor } from "./palette";
import { createRibbons } from "./ribbons";

export interface SceneOptions {
  /** true = Lichtschein sitzt hinter der Menü-Bühne (links oben), sonst mittig (z. B. Setup). */
  menuGlow: boolean;
}

export interface Scene {
  /** Größe aus dem Canvas lesen und alle zwischengespeicherten Verläufe neu aufbauen. */
  resize(): void;
  setPalette(pal: Palette): void;
  /** Welche Ebenen gezeichnet werden (Einstellungen → Anzeige). */
  setLayers(layers: { ribbons: boolean; dust: boolean; floaters: boolean }): void;
  /** `wt` = Zeit der Wellen (kann langsamer/schneller laufen als `t`). */
  draw(t: number, wt?: number): void;
}

/**
 * Aufbau: Der Farbverlauf samt Lichtschein und Dunst liegt als CSS-Hintergrund hinter dem
 * Canvas – der Browser rastert ihn einmal und danach kostet er nichts mehr. Der Canvas bleibt
 * transparent und zeigt nur, was sich bewegt: seidige Bänder, Lichtpartikel und die
 * fliegenden PlayStation-Formen. Farbwerte und Sprites entstehen nur bei resize()/Palettenwechsel.
 */
export function createScene(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  initial: Palette,
  options: SceneOptions,
): Scene {
  let pal = initial;
  let w = 0;
  let h = 0;
  let ribbons: (t: number) => void = () => {};
  let dust: (t: number) => void = () => {};
  let floaters: (t: number) => void = () => {};
  let layers = { ribbons: true, dust: true, floaters: true };

  const paintBackdrop = () => {
    const night = pal.night;
    const haze = 0.05 * (1 - 0.4 * night);
    const glow = 0.2 * (1 - 0.35 * night);
    // rem und --stage-shift wie in index.css/xmb.css: Die Menü-Bühne sitzt bei höheren Fenstern mittig.
    const at = options.menuGlow ? "26rem calc(var(--stage-shift, 0px) + 26rem)" : "50% 46%";
    const size = options.menuGlow ? "42rem 30rem" : "52rem 34rem";
    canvas.style.backgroundColor = pal.bottom;
    canvas.style.backgroundImage = [
      // Lichtschein hinter dem Menübereich
      `radial-gradient(ellipse ${size} at ${at}, ${glowColor(pal, glow, 6)} 0%, ${glowColor(pal, glow * 0.4, 6)} 45%, ${glowColor(pal, 0, 6)} 100%)`,
      // Dunst am unteren Rand: betont den Bereich, in dem die Bänder schweben.
      `linear-gradient(to bottom, ${glowColor(pal, 0)} 45%, ${glowColor(pal, haze)} 80%, ${glowColor(pal, haze * 1.8)} 100%)`,
      // Verlauf: oben satter und heller, unten dunkler
      `linear-gradient(to bottom, ${pal.top} 0%, ${pal.mid} 50%, ${pal.bottom} 100%)`,
    ].join(", ");
    canvas.style.backgroundBlendMode = "screen, screen, normal";
  };

  const rebuild = () => {
    if (!w || !h) return;
    // Größen skalieren wie die Oberfläche (1rem = min(100vh, 56.25vw) / 54).
    const ui = Math.min(h, w * 0.5625) / 1080;
    ribbons = createRibbons(ctx, w, h, Math.max(1, ui * 1.5), pal);
    dust = createDust(ctx, w, h, ui, pal);
    floaters = createFloaters(ctx, w, h, ui);
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuild();
  };

  paintBackdrop();

  return {
    resize,
    setPalette(next) {
      if (next.key === pal.key) return;
      pal = next;
      paintBackdrop();
      rebuild();
    },
    setLayers(next) {
      layers = next;
    },
    draw(t, wt = t) {
      if (!w || !h) return;
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);
      // Auf dem transparenten Canvas wirkt Alpha-Überlagerung wie additives Licht auf dem Verlauf –
      // und rastert deutlich billiger als "lighter".
      ctx.globalCompositeOperation = "source-over";
      if (layers.ribbons) ribbons(wt);
      ctx.globalCompositeOperation = "lighter";
      if (layers.dust) dust(t);
      ctx.globalCompositeOperation = "source-over";
      if (layers.floaters) floaters(t);
    },
  };
}
