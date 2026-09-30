import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, BUILDINGS, createGame, isPowered, step, SUB, UNITS, type State } from '../src';

function bare(): State {
  const st = createGame({ seed: 3 });
  for (const u of st.units) st.byId.delete(u.id);
  st.units = [];
  return st;
}

describe('mecha de artillería', () => {
  it('se entrena en el hangar, con más alcance que el coloso de asedio', () => {
    expect(BUILDINGS.hangar.trains).toEqual(['mech', 'artillery', 'truck']);
    expect(UNITS.artillery.range).toBeGreaterThan(UNITS.siege.range);
    expect(UNITS.artillery.vsBuilding).toBeLessThan(UNITS.artillery.damage);
  });

  it('desde dentro de la red castiga a tropas que están fuera de ella', () => {
    const st = bare();
    const hq = st.buildings.find((b) => b.owner === 0 && b.type === 'hq')!;
    // Borde de la cobertura del cuartel general en hq.tx + 20; el enemigo 12 casillas más allá.
    const a = addUnit(st, 0, (hq.tx + 18) * SUB, (hq.ty + 2) * SUB, 'artillery');
    const e = addUnit(st, 1, (hq.tx + 32) * SUB, (hq.ty + 2) * SUB, 'soldier');
    e.autoAttack = false;
    for (let i = 0; i < 400 && e.hp > 0; i++) step(st, []);
    expect(e.hp).toBeLessThanOrEqual(0);
    expect(isPowered(st, 0, a.x, a.y)).toBe(true);
  });

  it('apenas daña edificios', () => {
    const st = bare();
    for (const p of st.players) p.noPower = true;
    const d = addBuilding(st, 1, 'depot', 50, 40)!;
    const a = addUnit(st, 0, 38 * SUB, 41 * SUB, 'artillery');
    step(st, [{ tick: 0, player: 0, kind: 'attack', units: [a.id], target: d.id }]);
    for (let i = 0; i < 400; i++) step(st, []);
    expect(d.hp).toBeGreaterThanOrEqual(d.maxHp - 6 * UNITS.artillery.vsBuilding);
  });
});
