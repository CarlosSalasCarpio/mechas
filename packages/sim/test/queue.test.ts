import { describe, expect, it } from 'vitest';
import { BUILDINGS, createGame, step, SUB, type Command } from '../src';

describe('cola de órdenes (Shift)', () => {
  it('un obrero construye dos edificios seguidos y luego se va a recolectar', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 1000;
    const hq = st.buildings[0];
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    const node = st.nodes[0];
    const cmds: Command[] = [
      { tick: 0, player: 0, queued: true, kind: 'build', units: [w.id], building: 'depot', tx: hq.tx + 6, ty: hq.ty },
      { tick: 0, player: 0, queued: true, kind: 'build', units: [w.id], building: 'barracks', tx: hq.tx + 8, ty: hq.ty + 3 },
      { tick: 0, player: 0, queued: true, kind: 'gather', units: [w.id], target: node.id },
    ];
    step(st, cmds);
    // Los dos edificios se colocan y cobran al momento.
    expect(st.buildings.filter((b) => !b.complete)).toHaveLength(2);
    expect(st.players[0].metal).toBe(1000 - BUILDINGS.depot.cost - BUILDINGS.barracks.cost);
    expect(w.order.kind).toBe('build');
    expect(w.orderQueue).toHaveLength(2);

    const total = BUILDINGS.depot.buildTime + BUILDINGS.barracks.buildTime + 400;
    for (let i = 0; i < total && w.order.kind !== 'gather'; i++) step(st, []);
    expect(st.buildings.filter((b) => b.owner === 0).every((b) => b.complete)).toBe(true);
    expect(w.order.kind).toBe('gather');
  });

  it('una orden sin Shift borra la cola', () => {
    const st = createGame({ seed: 3 });
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [
      { tick: 0, player: 0, kind: 'move', units: [w.id], x: 30 * SUB, y: 60 * SUB, queued: true },
      { tick: 0, player: 0, kind: 'move', units: [w.id], x: 30 * SUB, y: 50 * SUB, queued: true },
    ]);
    expect(w.orderQueue).toHaveLength(1);
    step(st, [{ tick: 1, player: 0, kind: 'move', units: [w.id], x: 20 * SUB, y: 60 * SUB }]);
    expect(w.orderQueue).toHaveLength(0);
  });
});

describe('depósito', () => {
  it('al terminar un depósito, el obrero se pone a minar', () => {
    const st = createGame({ seed: 3 });
    const node = st.nodes[0];
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [{ tick: 0, player: 0, kind: 'build', units: [w.id], building: 'depot', tx: node.tx - 1, ty: node.ty - 4 }]);
    expect(st.buildings.some((b) => b.type === 'depot')).toBe(true);
    for (let i = 0; i < BUILDINGS.depot.buildTime + 400 && w.order.kind !== 'gather'; i++) step(st, []);
    expect(w.order.kind).toBe('gather');
  });
});
