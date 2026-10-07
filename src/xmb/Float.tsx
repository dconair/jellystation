import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface FloatProps {
  /** true = das Element schwebt sanft auf und ab; false = es setzt sich weich auf Ruhelage zurück. */
  active: boolean;
  /** Dauer eines Auf-und-ab in Millisekunden. */
  period: number;
  className?: string;
  children: ReactNode;
}

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Schwebe-Bewegung des fokussierten Icons. Per CSS-Animation würde das Icon beim Verlassen des
 * Fokus sichtbar auf seine Ruhelage springen; hier wird der aktuelle Versatz übernommen und
 * in einer kurzen Animation sanft zurückgeführt.
 */
export function Float({ active, period, className, children }: FloatProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof el.animate !== "function" || prefersReducedMotion()) return;
    const bob = el.animate(
      [
        { transform: "translateY(0)" },
        { transform: "translateY(-0.3rem)" },
        { transform: "translateY(0)" },
      ],
      { duration: period, iterations: Infinity, easing: "ease-in-out" },
    );
    return () => {
      const current = el.isConnected ? getComputedStyle(el).transform : "none";
      bob.cancel();
      if (current && current !== "none") {
        el.animate([{ transform: current }, { transform: "translateY(0)" }], {
          duration: 450,
          easing: "ease-out",
        });
      }
    };
  }, [active, period]);

  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}
