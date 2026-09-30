import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, createGame, findPath, isWalkable, step, SUB, type State } from '../src';

/** Partida sin obreros, para aislar lo que se prueba. */
function bare(): State {
  const st = createGame({ seed: 1 });
  for (const u of st.units) st.byId.delete(u.id);
  st.units = [];
  return st;
}

describe('edificios', () => {
  it('cada jugador empieza con su cuartel general', () => {
    const st = createGame({ seed: 1 });
    expect(st.buildings.map((b) => [b.owner, b.type])).toEqual([
      [0, 'hq'],
      [1, 'hq'],
    ]);
  });

  it('la huella bloquea el paso y no se puede construir encima', () => {
    const st = bare();
    const hq = st.buildings[0];
    expect(isWalkable(st.map, hq.tx + 1, hq.ty + 1)).toBe(false);
    expect(addBuilding(st, 0, 'hq', hq.tx + 2, hq.ty + 2)).toBeNull();
  });

  it('el camino rodea el edificio', () => {
    const st = bare();
    const hq = st.buildings[0];
    const y = hq.ty + 1;
    const path = findPath(st.map, hq.tx - 2, y, hq.tx + hq.size + 1, y);
    expect(path.length).toBeGreaterThan(0);
    for (const t of path) expect(st.map.occ[t]).toBe(0);
  });

  it('las unidades destruyen un edificio y la casilla se libera', () => {
    const st = bare();
    const hq = st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!;
    hq.hp = 30;
    const u = addUnit(st, 0, (hq.tx - 1) * SUB, (hq.ty + 1) * SUB);
    step(st, [{ tick: 0, player: 0, kind: 'attack', units: [u.id], target: hq.id }]);
    for (let i = 0; i < 400 && st.buildingsById.has(hq.id); i++) step(st, []);
    expect(st.buildingsById.has(hq.id)).toBe(false);
    expect(isWalkable(st.map, hq.tx + 1, hq.ty + 1)).toBe(true);
  });

  it('una unidad ociosa ataca sola un edificio enemigo a la vista', () => {
    const st = bare();
    const hq = st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!;
    const u = addUnit(st, 0, (hq.tx - 3) * SUB, (hq.ty + 2) * SUB);
    for (let i = 0; i < 200; i++) step(st, []);
    expect(u.order.kind).toBe('attack');
    // El más cercano puede ser el cuartel general o la antena de delante: cualquiera vale.
    expect(st.buildings.some((b) => b.owner === 1 && b.hp < b.maxHp)).toBe(true);
  });
});
