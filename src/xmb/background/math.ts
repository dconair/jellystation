export const TAU = Math.PI * 2;

/** Modulo, das auch für negative Werte im Bereich [0, m) bleibt. */
export const mod = (v: number, m: number) => ((v % m) + m) % m;

export const frac = (v: number) => v - Math.floor(v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Kleiner, deterministischer Zufallsgenerator – gleiche Verteilung bei jedem Start. */
export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gleichmäßig verteilte 2D-Punkte (R2-Folge): Auch bei wenigen Punkten entstehen weder
 * Klumpen noch Löcher – wichtig, damit die Formen zu Beginn nicht zusammenhängen.
 */
export function spread2(i: number): [number, number] {
  return [frac(0.5 + i * 0.7548776662466927), frac(0.5 + i * 0.5698402909980532)];
}
