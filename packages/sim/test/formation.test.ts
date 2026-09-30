import { describe, expect, it } from 'vitest';
import { addUnit, createGame, step, SUB, UNITS, type State, type Unit } from '../src';

function open(): State {
  const st = createGame({ seed: 1 });
  for (const u of st.units) st.byId.delete(u.id);
  st.units = [];
  // Estas pruebas miden el movimiento: sin depender de la red de energía.
  for (const p of st.players) p.noPower = true;
  return st;
}

describe('formaciones', () => {
  it('el grupo militar marcha al ritmo del más lento y llega con soldados delante y mechas detrás', () => {
    const st = open();
    const us: Unit[] = [];
    for (let i = 0; i < 6; i++) us.push(addUnit(st, 0, 30 * SUB + i * 100, 50 * SUB, 'soldier'));
    for (let i = 0; i < 2; i++) us.push(addUnit(st, 0, 30 * SUB + i * 250, 51 * SUB, 'mech'));
    for (const u of us) u.autoAttack = false;
    step(st, [{ tick: 0, player: 0, kind: 'move', units: us.map((u) => u.id), x: 50 * SUB, y: 50 * SUB }]);

    const before = us.map((u) => [u.x, u.y]);
    for (let i = 0; i < 20; i++) step(st, []);
    // Nadie avanza más rápido que el mecha (con margen por los empujones de separación).
    us.forEach((u, i) => expect(Math.hypot(u.x - before[i][0], u.y - before[i][1])).toBeLessThanOrEqual(21 * UNITS.mech.speed + 60));

    for (let i = 0; i < 1500 && us.some((u) => u.order.kind !== 'idle'); i++) step(st, []);
    const avg = (t: string) => {
      const g = us.filter((u) => u.type === t);
      return g.reduce((s, u) => s + u.x, 0) / g.length;
    };
    // Marcharon hacia +x: los soldados deben quedar por delante (x mayor) de los mechas.
    expect(avg('soldier')).toBeGreaterThan(avg('mech'));
    for (const u of us) expect(Math.abs(u.x - 50 * SUB)).toBeLessThan(5 * SUB);
  });

  it('los obreros no van en formación ni frenan', () => {
    const st = open();
    const w = [0, 1].map((i) => addUnit(st, 0, 30 * SUB, (50 + i) * SUB, 'worker'));
    step(st, [{ tick: 0, player: 0, kind: 'move', units: w.map((u) => u.id), x: 45 * SUB, y: 50 * SUB }]);
    expect(w.every((u) => u.groupSpeed === 0)).toBe(true);
  });
});
