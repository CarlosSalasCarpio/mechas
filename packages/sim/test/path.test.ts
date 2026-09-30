import { describe, expect, it } from 'vitest';
import { findPath, GRASS, ROCK, type GameMap } from '../src';

function mapFrom(rows: string[]): GameMap {
  const h = rows.length;
  const w = rows[0].length;
  const tiles = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (tiles[y * w + x] = c === '#' ? ROCK : GRASS)));
  return { w, h, tiles, occ: new Int32Array(w * h) };
}

describe('findPath', () => {
  const m = mapFrom([
    '.....',
    '.###.',
    '.#...',
    '.#.#.',
    '...#.',
  ]);

  it('rodea obstáculos sin pisar roca', () => {
    const p = findPath(m, 0, 0, 2, 2);
    expect(p.at(-1)).toBe(2 * 5 + 2);
    for (const t of p) expect(m.tiles[t]).toBe(GRASS);
  });

  it('meta inalcanzable → llega a la casilla más cercana', () => {
    const walled = mapFrom(['..#.', '..#.', '..#.']);
    const p = findPath(walled, 0, 0, 3, 0);
    expect(p.at(-1)).toBe(1);
  });
});
