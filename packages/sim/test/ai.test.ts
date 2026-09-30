import { describe, expect, it } from 'vitest';
import { addUnit, aiCommands, createGame, hashState, step, SUB, type State } from '../src';

function aiGame(seed: number, ticks: number): State {
  const st = createGame({ seed });
  while (st.tick < ticks && st.winner < 0) step(st, [...aiCommands(st, 0), ...aiCommands(st, 1)]);
  return st;
}

describe('IA', () => {
  it('a los 5 minutos tiene economía, barracas y soldados', () => {
    const st = aiGame(42, 6000);
    for (const p of [0, 1]) {
      expect(st.units.filter((u) => u.owner === p && u.type === 'worker').length).toBeGreaterThan(10);
      expect(st.buildings.some((b) => b.owner === p && b.type === 'barracks' && b.complete)).toBe(true);
      expect(st.units.some((u) => u.owner === p && u.type === 'soldier')).toBe(true);
    }
  });

  it('es determinista', () => {
    expect(hashState(aiGame(9, 3000))).toBe(hashState(aiGame(9, 3000)));
  });
});

describe('victoria y trucos', () => {
  it('gana quien destruye el cuartel general enemigo', () => {
    const st = createGame({ seed: 1 });
    st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!.hp = 0;
    step(st, []);
    expect(st.winner).toBe(0);
  });

  it('el modo instantáneo construye y entrena al momento, y se apaga repitiéndolo', () => {
    const st = createGame({ seed: 1 });
    const hq = st.buildings[0];
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [{ tick: 0, player: 0, kind: 'toggleInstant' }]);
    step(st, [{ tick: 1, player: 0, kind: 'build', units: [w.id], building: 'barracks', tx: hq.tx + 7, ty: hq.ty + 5 }]);
    const b = st.buildings.find((x) => x.type === 'barracks')!;
    expect(b.complete).toBe(true);
    step(st, [{ tick: 2, player: 0, kind: 'train', building: b.id, unit: 'soldier' }]);
    step(st, []);
    expect(st.units.some((u) => u.owner === 0 && u.type === 'soldier')).toBe(true);
    step(st, [{ tick: 4, player: 0, kind: 'toggleInstant' }]);
    expect(st.players[0].instant).toBe(false);
  });
});

describe('ataque en movimiento', () => {
  it('pelea con lo que encuentra y después sigue hacia el destino', () => {
    const st = createGame({ seed: 1 });
    const s = addUnit(st, 0, 40 * SUB, 40 * SUB, 'soldier');
    const e = addUnit(st, 1, 46 * SUB, 40 * SUB, 'worker');
    step(st, [{ tick: 0, player: 0, kind: 'amove', units: [s.id], x: 56 * SUB, y: 40 * SUB }]);
    for (let i = 0; i < 1200 && st.byId.has(e.id); i++) step(st, []);
    expect(st.byId.has(e.id)).toBe(false);
    for (let i = 0; i < 600 && s.order.kind !== 'idle'; i++) step(st, []);
    expect(Math.abs(s.x - 56 * SUB)).toBeLessThan(2 * SUB);
  });
});

describe('truco de población', () => {
  it('sube el tope a 1000 y lo devuelve a 200 al repetirlo', () => {
    const st = createGame({ seed: 1 });
    step(st, [{ tick: 0, player: 0, kind: 'togglePopCap' }]);
    expect(st.players[0].popCap).toBe(1000);
    expect(st.players[1].popCap).toBe(200);
    step(st, [{ tick: 1, player: 0, kind: 'togglePopCap' }]);
    expect(st.players[0].popCap).toBe(200);
  });

  it('con el tope en 1000 se puede producir por encima de 200', () => {
    const st = createGame({ seed: 1 });
    for (let i = 0; i < 200; i++) addUnit(st, 0, 30 * SUB, 30 * SUB, 'worker');
    st.players[0].metal = 1000;
    const hq = st.buildings[0];
    step(st, [
      { tick: 0, player: 0, kind: 'togglePopCap' },
      { tick: 0, player: 0, kind: 'toggleInstant' },
      { tick: 0, player: 0, kind: 'train', building: hq.id, unit: 'worker' },
    ]);
    step(st, []);
    expect(st.units.filter((u) => u.owner === 0).length).toBeGreaterThan(204);
  });
});
