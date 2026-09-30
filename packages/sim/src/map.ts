import { SUB } from './constants';
import { randInt, type Rng } from './rng';

export const GRASS = 0;
export const ROCK = 1;
export const WATER = 2;

export interface GameMap {
  readonly w: number;
  readonly h: number;
  readonly tiles: Uint8Array;
  /** Casillas ocupadas por edificios (id del edificio, 0 = libre). */
  readonly occ: Int32Array;
}

export function isWalkable(m: GameMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
  const i = ty * m.w + tx;
  return m.tiles[i] === GRASS && m.occ[i] === 0;
}

export function tileOf(v: number): number {
  return Math.floor(v / SUB);
}

export function isWalkableSub(m: GameMap, x: number, y: number): boolean {
  return isWalkable(m, tileOf(x), tileOf(y));
}

export interface ClearZone {
  tx: number;
  ty: number;
  r: number;
}

export function generateMap(rng: Rng, w: number, h: number, clear: readonly ClearZone[]): GameMap {
  const tiles = new Uint8Array(w * h);

  const blobs = (type: number, count: number, rMin: number, rMax: number) => {
    for (let i = 0; i < count; i++) {
      const cx = randInt(rng, w);
      const cy = randInt(rng, h);
      const r = rMin + randInt(rng, rMax - rMin + 1);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (dx * dx + dy * dy <= r * r - randInt(rng, r + 1)) tiles[y * w + x] = type;
        }
      }
    }
  };
  blobs(WATER, 5, 3, 6);
  blobs(ROCK, 14, 1, 3);

  for (const z of clear) {
    for (let dy = -z.r; dy <= z.r; dy++) {
      for (let dx = -z.r; dx <= z.r; dx++) {
        const x = z.tx + dx;
        const y = z.ty + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (dx * dx + dy * dy <= z.r * z.r) tiles[y * w + x] = GRASS;
      }
    }
  }
  return { w, h, tiles, occ: new Int32Array(w * h) };
}
