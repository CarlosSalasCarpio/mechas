import { describe, expect, it } from 'vitest';
import { createGame, createRng, hashState, nextU32, step, SUB, type Command, type State } from '../src';

function runBattle(seed: number, ticks: number, perSide = 50): State {
  const st = createGame({ seed, perSide });
  const mid = 60 * SUB;
  const cmds: Command[] = [0, 1].map((p) => ({
    tick: 0,
    player: p,
    kind: 'move',
    units: st.units.filter((u) => u.owner === p).map((u) => u.id),
    x: mid,
    y: mid,
  }));
  for (let t = 0; t < ticks; t++) step(st, t === 0 ? cmds : []);
  return st;
}

describe('rng', () => {
  it('misma semilla → misma secuencia', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 1000; i++) expect(nextU32(a)).toBe(nextU32(b));
  });
  it('semillas distintas → secuencias distintas', () => {
    expect(nextU32(createRng(1))).not.toBe(nextU32(createRng(2)));
  });
});

describe('simulación', () => {
  it('dos corridas con la misma semilla dan el mismo hash en cada tick', () => {
    const a = createGame({ seed: 7, perSide: 30 });
    const b = createGame({ seed: 7, perSide: 30 });
    const move = (st: State): Command[] => [
      { tick: 0, player: 0, kind: 'move', units: st.units.filter((u) => u.owner === 0).map((u) => u.id), x: 60 * SUB, y: 60 * SUB },
    ];
    for (let t = 0; t < 1000; t++) {
      step(a, t === 0 ? move(a) : []);
      step(b, t === 0 ? move(b) : []);
      expect(hashState(a)).toBe(hashState(b));
    }
  });

  it('semillas distintas dan partidas distintas', () => {
    expect(hashState(runBattle(1, 200))).not.toBe(hashState(runBattle(2, 200)));
  });

  it('todo el estado queda en enteros', () => {
    const st = runBattle(3, 1500);
    for (const u of st.units) {
      for (const v of [u.x, u.y, u.hp, u.cd, ...u.path]) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('los ejércitos se encuentran y pelean', () => {
    const st = runBattle(5, 2400);
    expect(st.units.length).toBeLessThan(100);
  });
});
