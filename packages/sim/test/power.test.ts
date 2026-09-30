import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, BATTERY_TICKS, BUILDINGS, canPlaceBuilding, createGame, isPowered, step, SUB, type State } from '../src';

function bare(): State {
  const st = createGame({ seed: 3 });
  for (const u of st.units) st.byId.delete(u.id);
  st.units = [];
  return st;
}
const hqOf = (st: State, p: number) => st.buildings.find((b) => b.owner === p && b.type === 'hq')!;

describe('red de energía', () => {
  it('el cuartel general es la primera fuente: la base empieza cubierta', () => {
    const st = createGame({ seed: 3 });
    for (const p of [0, 1]) {
      const hq = hqOf(st, p);
      expect(hq.powered).toBe(true);
      expect(isPowered(st, p, (hq.tx + 2 + 8) * SUB, (hq.ty + 2) * SUB)).toBe(true);
    }
  });

  it('alcances: la central cubre como el cuartel general, mucho más que una antena, y resiste más', () => {
    expect(BUILDINGS.plant.power!.cover).toBe(BUILDINGS.hq.power!.cover);
    expect(BUILDINGS.plant.power!.cover).toBeGreaterThan(2 * BUILDINGS.relay.power!.cover);
    expect(BUILDINGS.plant.maxHp).toBeGreaterThan(BUILDINGS.hq.maxHp);
  });

  it('la central solo se construye sobre una veta y nada más puede taparla', () => {
    const st = createGame({ seed: 3 });
    const v = st.vents[2];
    expect(canPlaceBuilding(st, 'plant', v.tx - 1, v.ty - 1)).toBe(true);
    expect(canPlaceBuilding(st, 'plant', v.tx + 3, v.ty)).toBe(false);
    expect(canPlaceBuilding(st, 'barracks', v.tx - 1, v.ty - 1)).toBe(false);
  });

  it('una antena encadenada lleva la red; al destruir el eslabón, lo que cuelga se apaga', () => {
    const st = bare();
    const hq = hqOf(st, 0);
    // Centro del cuartel general en hq.tx + 2: la primera antena a 17,5 casillas (enlaza con él), la segunda
    // 7 más allá (solo enlaza con la primera).
    const a = addBuilding(st, 0, 'relay', hq.tx + 19, hq.ty + 2)!;
    const b = addBuilding(st, 0, 'relay', hq.tx + 26, hq.ty + 2)!;
    step(st, []);
    expect(a.powered && b.powered).toBe(true);
    expect(isPowered(st, 0, (b.tx + 3) * SUB, b.ty * SUB)).toBe(true);
    a.hp = 0;
    step(st, []);
    step(st, []);
    expect(b.powered).toBe(false);
    expect(isPowered(st, 0, (b.tx + 3) * SUB, b.ty * SUB)).toBe(false);
  });

  it('fuera de la red, el mecha gasta batería, se apaga y revive al volver la red', () => {
    const st = bare();
    const m = addUnit(st, 0, 45 * SUB, 40 * SUB, 'mech');
    m.autoAttack = false;
    for (let i = 0; i < BATTERY_TICKS - 1; i++) step(st, []);
    // Mientras tiene batería vuelve sola hacia la red; aquí la dejamos lejos para que no llegue.
    m.x = 45 * SUB;
    m.y = 40 * SUB;
    m.order = { kind: 'idle' };
    m.path = [];
    step(st, []);
    step(st, []);
    expect(m.battery).toBe(0);
    const x = m.x;
    step(st, [{ tick: st.tick, player: 0, kind: 'move', units: [m.id], x: 50 * SUB, y: 40 * SUB }]);
    for (let i = 0; i < 20; i++) step(st, []);
    expect(m.x).toBe(x);
    // Una central nueva sobre una veta cercana la vuelve a cubrir.
    addBuilding(st, 0, 'relay', 44, 41);
    addBuilding(st, 0, 'plant', 40, 40);
    for (let i = 0; i < 20; i++) step(st, []);
    expect(m.battery).toBeGreaterThan(0);
  });

  it('por su cuenta no persigue fuera de la red; con una orden directa sí', () => {
    const st = bare();
    const hq = hqOf(st, 0);
    // El borde de la cobertura queda en hq.tx + 20; el enemigo, 8 casillas más allá (fuera del alcance de 6).
    const m = addUnit(st, 0, (hq.tx + 14) * SUB, (hq.ty + 2) * SUB, 'mech');
    const e = addUnit(st, 1, (hq.tx + 28) * SUB, (hq.ty + 2) * SUB, 'soldier');
    e.autoAttack = false;
    for (let i = 0; i < 200; i++) step(st, []);
    expect(isPowered(st, 0, m.x, m.y)).toBe(true);
    expect(e.hp).toBe(e.maxHp);
    step(st, [{ tick: st.tick, player: 0, kind: 'attack', units: [m.id], target: e.id }]);
    for (let i = 0; i < 200 && e.hp > 0; i++) step(st, []);
    expect(e.hp).toBeLessThan(e.maxHp);
  });

  it('si una orden la dejó fuera de la red, vuelve sola', () => {
    const st = bare();
    const hq = hqOf(st, 0);
    const m = addUnit(st, 0, (hq.tx + 17) * SUB, (hq.ty + 2) * SUB, 'mech');
    // Una salida corta: 2 casillas más allá del borde (la batería da para unas 10 de ida y vuelta).
    step(st, [{ tick: 0, player: 0, kind: 'move', units: [m.id], x: (hq.tx + 22) * SUB, y: (hq.ty + 2) * SUB }]);
    for (let i = 0; i < 200 && m.order.kind !== 'idle'; i++) step(st, []);
    expect(isPowered(st, 0, m.x, m.y)).toBe(false);
    for (let i = 0; i < 200 && !isPowered(st, 0, m.x, m.y); i++) step(st, []);
    expect(isPowered(st, 0, m.x, m.y)).toBe(true);
    expect(m.battery).toBeGreaterThan(0);
  });
});
