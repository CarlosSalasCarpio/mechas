import { describe, expect, it } from 'vitest';
import { addUnit, BUILDINGS, buildingSight, createGame, isExplored, isVisible, step, SUB, UNITS } from '../src';

describe('niebla de guerra', () => {
  it('al empezar solo se ve y se ha explorado la zona de la base', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings.find((b) => b.owner === 0 && b.type === 'hq')!;
    expect(isVisible(st, 0, (hq.tx + 2) * SUB, (hq.ty + 2) * SUB)).toBe(true);
    expect(isExplored(st, 0, 100 * SUB, 60 * SUB)).toBe(false);
    expect(isVisible(st, 1, (hq.tx + 2) * SUB, (hq.ty + 2) * SUB)).toBe(false);
  });

  it('la red ve hasta donde llega su energía', () => {
    expect(buildingSight('hq')).toBe(BUILDINGS.hq.power!.cover);
    expect(buildingSight('relay')).toBe(BUILDINGS.relay.power!.cover);
    expect(buildingSight('plant')).toBe(BUILDINGS.plant.power!.cover);
  });

  it('la artillería y el asedio ven un poco más de lo que disparan', () => {
    for (const t of ['artillery', 'siege', 'mech', 'soldier'] as const) expect(UNITS[t].sight).toBeGreaterThan(UNITS[t].range);
  });

  it('lo explorado se recuerda cuando la unidad se va', () => {
    const st = createGame({ seed: 3 });
    const u = addUnit(st, 0, 60 * SUB, 30 * SUB, 'soldier');
    step(st, []);
    step(st, []);
    expect(isVisible(st, 0, 60 * SUB, 30 * SUB)).toBe(true);
    u.hp = 0;
    for (let i = 0; i < 4; i++) step(st, []);
    expect(isVisible(st, 0, 60 * SUB, 30 * SUB)).toBe(false);
    expect(isExplored(st, 0, 60 * SUB, 30 * SUB)).toBe(true);
  });

  it('marco revela el mapa y polo quita la niebla', () => {
    const st = createGame({ seed: 3 });
    step(st, [{ tick: 0, player: 0, kind: 'toggleRevealMap' }]);
    step(st, []);
    expect(isExplored(st, 0, 110 * SUB, 10 * SUB)).toBe(true);
    expect(isVisible(st, 0, 110 * SUB, 10 * SUB)).toBe(false);
    step(st, [{ tick: 2, player: 0, kind: 'toggleNoFog' }]);
    step(st, []);
    expect(isVisible(st, 0, 110 * SUB, 10 * SUB)).toBe(true);
  });
});
