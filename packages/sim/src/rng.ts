/** RNG determinista (mulberry32). Su estado vive dentro del State de la partida. */
export interface Rng {
  s: number;
}

export function createRng(seed: number): Rng {
  return { s: seed | 0 };
}

export function nextU32(r: Rng): number {
  let t = (r.s = (r.s + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Entero en [0, n). */
export function randInt(r: Rng, n: number): number {
  return nextU32(r) % n;
}
