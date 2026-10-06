import { useEffect, useRef } from "react";

// Hintergrundfarbe wechselt wie auf der PS3 mit dem Monat.
const monthHues = [215, 265, 130, 330, 100, 190, 20, 160, 285, 35, 230, 0];

interface Ribbon {
  amp: number;
  freq: number;
  speed: number;
  phase: number;
  y: number;
  alpha: number;
}

const ribbons: Ribbon[] = [
  { amp: 0.09, freq: 1.3, speed: 0.11, phase: 0.0, y: 0.62, alpha: 0.1 },
  { amp: 0.07, freq: 1.9, speed: -0.08, phase: 1.7, y: 0.68, alpha: 0.08 },
  { amp: 0.11, freq: 0.9, speed: 0.06, phase: 3.1, y: 0.74, alpha: 0.12 },
  { amp: 0.05, freq: 2.6, speed: -0.13, phase: 4.6, y: 0.8, alpha: 0.07 },
];

export function Background({ paused = false }: { paused?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const hue = monthHues[new Date().getMonth()];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let w = 0;
    let h = 0;
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (ms: number) => {
      const t = ms / 1000;
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, `hsl(${hue} 70% 24%)`);
      bg.addColorStop(0.55, `hsl(${hue} 65% 12%)`);
      bg.addColorStop(1, `hsl(${hue} 60% 5%)`);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      for (const r of ribbons) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 12) {
          const u = x / w;
          const y =
            h * r.y +
            Math.sin(u * Math.PI * 2 * r.freq + t * r.speed * 6 + r.phase) * h * r.amp +
            Math.sin(u * Math.PI * 2 * r.freq * 0.5 - t * r.speed * 3) * h * r.amp * 0.6;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, h * (r.y - r.amp * 2), 0, h);
        g.addColorStop(0, `hsl(${hue} 90% 80% / ${r.alpha})`);
        g.addColorStop(1, `hsl(${hue} 90% 60% / 0)`);
        ctx.fillStyle = g;
        ctx.fill();
      }
    };

    const loop = (ms: number) => {
      draw(ms);
      raf = requestAnimationFrame(loop);
    };

    const still = reduce.matches || paused;
    const onResize = () => {
      resize();
      if (still) draw(0);
    };

    resize();
    window.addEventListener("resize", onResize);
    // Bei pausiertem Hintergrund (z. B. laufendes Spiel) keine GPU-Zeit verbrauchen.
    if (still) draw(0);
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [paused]);

  return <canvas ref={ref} className="xmb-background" aria-hidden="true" />;
}
