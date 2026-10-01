import { describe, expect, it } from 'vitest';
import { addBuilding, BUILDINGS, createGame, MODES, step } from '../src';

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
    // (Los demás obreros pueden entregar algo de metal entretanto: se mira que el perdedor no pagó.)
    expect(st.players[1].metal).toBeGreaterThanOrEqual(1000);
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
});
