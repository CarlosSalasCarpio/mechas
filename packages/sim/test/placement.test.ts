import { describe, expect, it } from 'vitest';
import { addBuilding, BUILDINGS, canPlaceKnown, createGame, MODES, step, SUB } from '../src';

describe('cimientos al llegar', () => {
  it('dos jugadores marcan el mismo sitio: lo gana el obrero que llega primero y el otro no paga', () => {
    const st = createGame({ seed: 5, teams: MODES['2v2'] });
    st.players[0].metal = 1000;
    st.players[1].metal = 1000;
    const hq0 = st.buildings.find((b) => b.owner === 0 && b.type === 'hq')!;
    const near = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    const far = st.units.find((u) => u.owner === 1 && u.type === 'worker')!;
    const tx = hq0.tx + 6;
    const ty = hq0.ty;
    step(st, [
      { tick: 0, player: 1, kind: 'build', units: [far.id], building: 'depot', tx, ty },
      { tick: 0, player: 0, kind: 'build', units: [near.id], building: 'depot', tx, ty },
    ]);
    for (let i = 0; i < 3000 && (far.order.kind === 'place' || near.order.kind === 'place'); i++) step(st, []);
    const d = st.buildings.find((b) => b.type === 'depot')!;
    expect(d.owner).toBe(0);
    // Al perdedor se le cobró al dar la orden y se le devolvió al cancelarse.
    expect(st.players[1].metal).toBeGreaterThanOrEqual(1000);
    expect(st.reservations).toHaveLength(0);
    expect(far.order.kind).not.toBe('place');
  });

  it('destruir una obra sin empezar devuelve todo el metal; a medias, lo que faltaba', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 0;
    const a = addBuilding(st, 0, 'barracks', 30, 45, false)!;
    const b = addBuilding(st, 0, 'hangar', 35, 45, false)!;
    b.progress = BUILDINGS.hangar.buildTime / 2;
    step(st, [{ tick: 0, player: 0, kind: 'destroy', ids: [a.id, b.id] }]);
    expect(st.buildings.includes(a)).toBe(false);
    expect(st.players[0].metal).toBe(BUILDINGS.barracks.cost + BUILDINGS.hangar.cost / 2);
  });

  it('se cobra al dar la orden, aunque luego se gaste el metal; y se devuelve si se cancela', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 200;
    const hq = st.buildings[0];
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [{ tick: 0, player: 0, kind: 'build', units: [w.id], building: 'barracks', tx: hq.tx + 7, ty: hq.ty + 5 }]);
    expect(st.players[0].metal).toBe(200 - BUILDINGS.barracks.cost);
    // Se gasta el resto en un obrero mientras el constructor camina: la obra sigue adelante.
    step(st, [{ tick: 1, player: 0, kind: 'train', building: hq.id, unit: 'worker' }]);
    for (let i = 0; i < 400 && !st.buildings.some((b) => b.type === 'barracks'); i++) step(st, []);
    expect(st.buildings.some((b) => b.type === 'barracks')).toBe(true);

    // Otra obra cancelada con una orden de moverse: devuelve todo.
    const st2 = createGame({ seed: 3 });
    const w2 = st2.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    const before = st2.players[0].metal;
    step(st2, [{ tick: 0, player: 0, kind: 'build', units: [w2.id], building: 'barracks', tx: hq.tx + 7, ty: hq.ty + 5 }]);
    step(st2, [{ tick: 1, player: 0, kind: 'move', units: [w2.id], x: w2.x, y: w2.y - 2 * SUB }]);
    expect(st2.players[0].metal).toBe(before);
    expect(st2.reservations).toHaveLength(0);
  });

  it('un edificio enemigo oculto en la niebla no delata nada: se acepta la orden y se cancela al verlo', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 1000;
    // Unas barracas enemigas lejos, fuera de la vista del jugador 0.
    const hidden = addBuilding(st, 1, 'barracks', 60, 20)!;
    step(st, []);
    expect(st.vision[20 * st.map.w + 60] & 1).toBe(0);
    expect(canPlaceKnown(st, 'depot', 60, 20, 0)).toBe(true);
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [{ tick: 1, player: 0, kind: 'build', units: [w.id], building: 'depot', tx: 60, ty: 20 }]);
    expect(w.order.kind).toBe('place');
    expect(st.players[0].metal).toBe(1000 - BUILDINGS.depot.cost);
    for (let i = 0; i < 4000 && w.order.kind === 'place'; i++) step(st, []);
    expect(st.buildings.includes(hidden)).toBe(true);
    expect(st.buildings.some((b) => b.type === 'depot')).toBe(false);
    expect(st.players[0].metal).toBeGreaterThanOrEqual(1000);
  });
});

describe('trucos', () => {
  it('impacto: Gen-3 y todas las tecnologías', async () => {
    const { createGame, step, TECH_ORDER } = await import('../src');
    const st = createGame({ seed: 3 });
    step(st, [{ tick: 0, player: 0, kind: 'unlockAll' }]);
    expect(st.players[0].gen).toBe(3);
    expect(st.players[0].techs.length).toBe(TECH_ORDER.length);
    expect(st.players[1].gen).toBe(1);
  });
});
