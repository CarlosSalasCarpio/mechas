import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, BUILDINGS, createGame, step, SUB, UNITS, type State } from '../src';

function bare(): State {
  const st = createGame({ seed: 3 });
  for (const u of st.units) st.byId.delete(u.id);
  st.units = [];
  // Estas pruebas miden el arma, no la red de energía.
  for (const p of st.players) p.noPower = true;
  return st;
}

describe('coloso de asedio', () => {
  it('la cuna entrena los dos colosos', () => {
    expect(BUILDINGS.cradle.trains).toEqual(['colossus', 'siege']);
  });

  it('el cohete tarda en llegar y el daño se aplica al estallar', () => {
    const st = bare();
    const s = addUnit(st, 0, 30 * SUB, 40 * SUB, 'siege');
    const e = addUnit(st, 1, 40 * SUB, 40 * SUB, 'mech');
    e.autoAttack = false;
    step(st, [{ tick: 0, player: 0, kind: 'attack', units: [s.id], target: e.id }]);
    for (let i = 0; i < 5 && st.projectiles.length === 0; i++) step(st, []);
    expect(st.projectiles).toHaveLength(1);
    expect(e.hp).toBe(e.maxHp);
    const dur = st.projectiles[0].dur;
    for (let i = 0; i < dur; i++) step(st, []);
    expect(st.projectiles).toHaveLength(0);
    expect(e.hp).toBe(e.maxHp - UNITS.siege.damage);
  });

  it('destruye una torre desde fuera de su alcance sin recibir daño', () => {
    const st = bare();
    const t = addBuilding(st, 1, 'tower', 50, 40)!;
    const s = addUnit(st, 0, 38 * SUB, 41 * SUB, 'siege');
    step(st, [{ tick: 0, player: 0, kind: 'attack', units: [s.id], target: t.id }]);
    for (let i = 0; i < 1200 && t.hp > 0; i++) step(st, []);
    expect(st.buildingsById.has(t.id)).toBe(false);
    expect(s.hp).toBe(s.maxHp);
  });

  it('ociosa, prefiere disparar a edificios', () => {
    const st = bare();
    const t = addBuilding(st, 1, 'depot', 46, 40)!;
    const e = addUnit(st, 1, 44 * SUB, 44 * SUB, 'soldier');
    e.autoAttack = false;
    const s = addUnit(st, 0, 36 * SUB, 41 * SUB, 'siege');
    for (let i = 0; i < 8; i++) step(st, []);
    expect(s.order.kind === 'attack' && s.order.target).toBe(t.id);
  });
});
