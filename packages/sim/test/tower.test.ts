import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, BUILDINGS, createGame, step, SUB, UNITS, type State } from '../src';

function bare(): State {
  const st = createGame({ seed: 3 });
  for (const u of st.units) st.byId.delete(u.id);
  st.units = [];
  return st;
}

describe('torre', () => {
  it('dispara sola a enemigos dentro de su alcance y no a los que están lejos', () => {
    const st = bare();
    const t = addBuilding(st, 0, 'tower', 40, 40)!;
    const near = addUnit(st, 1, 46 * SUB, 41 * SUB, 'soldier');
    const far = addUnit(st, 1, 60 * SUB, 41 * SUB, 'soldier');
    near.autoAttack = far.autoAttack = false;
    for (let i = 0; i < 40; i++) step(st, []);
    expect(near.hp).toBeLessThan(near.maxHp);
    expect(far.hp).toBe(far.maxHp);
    expect(t.aim).toBe(near.id);
  });

  it('una torre sin terminar no dispara', () => {
    const st = bare();
    addBuilding(st, 0, 'tower', 40, 40, false);
    const e = addUnit(st, 1, 44 * SUB, 41 * SUB, 'soldier');
    e.autoAttack = false;
    for (let i = 0; i < 40; i++) step(st, []);
    expect(e.hp).toBe(e.maxHp);
  });
});

describe('reparar', () => {
  it('los obreros devuelven vida a un edificio y cuesta metal', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    hq.hp = 1000;
    const ws = st.units.filter((u) => u.owner === 0 && u.type === 'worker');
    step(st, [{ tick: 0, player: 0, kind: 'repair', units: ws.map((w) => w.id), target: hq.id }]);
    for (let i = 0; i < 400 && hq.hp < hq.maxHp; i++) step(st, []);
    expect(hq.hp).toBe(hq.maxHp);
    step(st, []);
    // 1400 de vida reparada → unos 70 de metal.
    expect(st.players[0].metal).toBeLessThan(300 - 60);
    expect(st.players[0].metal).toBeGreaterThan(300 - 80);
    expect(ws.every((w) => w.order.kind === 'idle')).toBe(true);
  });

  it('no se puede reparar un edificio intacto ni uno sin terminar', () => {
    const st = createGame({ seed: 3 });
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [{ tick: 0, player: 0, kind: 'repair', units: [w.id], target: st.buildings[0].id }]);
    expect(w.order.kind).toBe('idle');
  });
});

describe('cancelar producción', () => {
  it('quita una unidad de la cola y devuelve su coste', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    step(st, [
      { tick: 0, player: 0, kind: 'train', building: hq.id, unit: 'worker' },
      { tick: 0, player: 0, kind: 'train', building: hq.id, unit: 'worker' },
    ]);
    expect(st.players[0].metal).toBe(300 - 2 * UNITS.worker.cost);
    step(st, [{ tick: 1, player: 0, kind: 'cancel', building: hq.id, unit: 'worker' }]);
    expect(hq.queue).toHaveLength(1);
    expect(st.players[0].metal).toBe(300 - UNITS.worker.cost);
    expect(hq.trainTicks).toBeGreaterThan(0);
    step(st, [{ tick: 2, player: 0, kind: 'cancel', building: hq.id, unit: 'worker' }]);
    expect(hq.queue).toHaveLength(0);
    expect(hq.trainTicks).toBe(0);
    expect(st.players[0].metal).toBe(300);
    expect(BUILDINGS.tower.attack).toBeDefined();
  });
});
