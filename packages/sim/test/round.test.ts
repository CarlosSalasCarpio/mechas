import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, BATTERY_TICKS, createGame, isExplored, isPowered, isVisible, MODES, step, SUB } from '../src';

describe('niebla y obras', () => {
  it('colocar un edificio no da visión: solo deja explorada su huella', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 1000;
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    // Lejos de todo lo que ve el jugador.
    step(st, [{ tick: 0, player: 0, kind: 'build', units: [w.id], building: 'depot', tx: 60, ty: 20 }]);
    step(st, []);
    step(st, []);
    expect(st.buildings.some((b) => b.type === 'depot')).toBe(true);
    expect(isVisible(st, 0, 60.5 * SUB, 20.5 * SUB)).toBe(false);
    expect(isExplored(st, 0, 60.5 * SUB, 20.5 * SUB)).toBe(true);
    expect(isExplored(st, 0, 60.5 * SUB, 16 * SUB)).toBe(false);
  });
});

describe('red compartida con aliados', () => {
  it('un mecha se alimenta de la red de su aliado, pero las redes no se encadenan', () => {
    const st = createGame({ seed: 5, teams: MODES['2v2'] });
    const ally = st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!;
    const m = addUnit(st, 0, (ally.tx + 4) * SUB, (ally.ty + 2) * SUB, 'mech');
    m.autoAttack = false;
    for (let i = 0; i < BATTERY_TICKS + 20; i++) step(st, []);
    expect(isPowered(st, 0, m.x, m.y)).toBe(true);
    expect(m.battery).toBeGreaterThan(0);
    // Una antena del jugador 0 junto a la base aliada no recibe energía de ella.
    const r = addBuilding(st, 0, 'relay', ally.tx + 8, ally.ty)!;
    step(st, []);
    expect(r.powered).toBe(false);
  });
});

describe('antenas por generación y metal de centrales', () => {
  it('al subir de generación, las antenas ganan vida', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings.find((b) => b.owner === 0 && b.type === 'hq')!;
    const r = addBuilding(st, 0, 'relay', hq.tx + 8, hq.ty)!;
    expect(addBuilding(st, 0, 'barracks', 30, 45)).not.toBeNull();
    expect(addBuilding(st, 0, 'hangar', 35, 45)).not.toBeNull();
    st.players[0].metal = 5000;
    st.players[0].instant = true;
    step(st, [{ tick: 0, player: 0, kind: 'research', building: hq.id, tech: 'gen2' }]);
    step(st, []);
    expect(st.players[0].gen).toBe(2);
    expect(r.maxHp).toBe(450);
  });

  it('en Gen-3, cada central a partir de la segunda da metal', () => {
    const st = createGame({ seed: 3 });
    st.players[0].gen = 3;
    const [a, b] = st.vents.slice(2, 4);
    addBuilding(st, 0, 'plant', a.tx - 1, a.ty - 1);
    addBuilding(st, 0, 'plant', b.tx - 1, b.ty - 1);
    const before = st.players[0].metal;
    for (let i = 0; i < 205; i++) step(st, []);
    expect(st.players[0].metal).toBe(before + 5);
    st.players[0].gen = 2;
    for (let i = 0; i < 205; i++) step(st, []);
    expect(st.players[0].metal).toBe(before + 5);
  });
});
