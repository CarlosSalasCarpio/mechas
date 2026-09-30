/** Raíz cuadrada entera. Math.sqrt es IEEE-754 correctamente redondeado, así que es determinista. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** División entera truncada hacia cero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}
