import { describe, expect, it } from 'vitest';
import { BUILDINGS, createGame, POP_CAP, step, SUB, UNITS, addUnit, type Command, type State } from '../src';

const workers = (st: State, p: number) => st.units.filter((u) => u.owner === p && u.type === 'worker');

function run(st: State, ticks: number, first: Command[] = []): void {
  for (let i = 0; i < ticks; i++) step(st, i === 0 ? first : []);
}

describe('economía', () => {
  it('empieza con cuartel general, obreros, metal y yacimientos', () => {
    const st = createGame({ seed: 3 });
    expect(workers(st, 0)).toHaveLength(4);
    expect(st.players[0].metal).toBe(300);
    expect(st.nodes.length).toBeGreaterThan(20);
  });

  it('los obreros recolectan y entregan metal', () => {
    const st = createGame({ seed: 3 });
    const node = st.nodes[0];
    run(st, 1200, [{ tick: 0, player: 0, kind: 'gather', units: workers(st, 0).map((u) => u.id), target: node.id }]);
    expect(st.players[0].metal).toBeGreaterThan(300 + 100);
  });

  it('un obrero coloca y construye unas barracas', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    const w = workers(st, 0)[0];
    const cmd: Command = { tick: 0, player: 0, kind: 'build', units: [w.id], building: 'barracks', tx: hq.tx + 7, ty: hq.ty + 5 };
    step(st, [cmd]);
    const b = st.buildings.find((x) => x.type === 'barracks')!;
    expect(b.complete).toBe(false);
    expect(st.players[0].metal).toBe(300 - BUILDINGS.barracks.cost);
    run(st, BUILDINGS.barracks.buildTime + 200);
    expect(b.complete).toBe(true);
    expect(b.hp).toBe(b.maxHp);
  });

  it('no se puede construir sin metal suficiente', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    step(st, [{ tick: 0, player: 0, kind: 'build', units: [workers(st, 0)[0].id], building: 'cradle', tx: hq.tx, ty: hq.ty + 6 }]);
    expect(st.buildings.some((b) => b.type === 'cradle')).toBe(false);
  });

  it('el cuartel general entrena obreros y cobra al encolar', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    run(st, UNITS.worker.trainTime + 2, [{ tick: 0, player: 0, kind: 'train', building: hq.id, unit: 'worker' }]);
    expect(workers(st, 0)).toHaveLength(5);
    expect(st.players[0].metal).toBe(300 - UNITS.worker.cost);
  });

  it('cada edificio solo entrena su unidad', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    step(st, [{ tick: 0, player: 0, kind: 'train', building: hq.id, unit: 'mech' }]);
    expect(hq.queue).toHaveLength(0);
  });

  it('la producción espera si se llega al tope de población', () => {
    const st = createGame({ seed: 3 });
    const hq = st.buildings[0];
    st.players[0].metal = 1000;
    for (let i = workers(st, 0).length; i < POP_CAP; i++) addUnit(st, 0, 30 * SUB, 30 * SUB, 'worker');
    run(st, UNITS.worker.trainTime + 50, [{ tick: 0, player: 0, kind: 'train', building: hq.id, unit: 'worker' }]);
    expect(hq.queue).toHaveLength(1);
  });

  it('empezar un coloso genera una alerta', () => {
    const st = createGame({ seed: 3 });
    st.players[1].metal = 5000;
    st.players[1].gen = 3;
    const hq = st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!;
    step(st, [{ tick: 0, player: 1, kind: 'build', units: [workers(st, 1)[0].id], building: 'cradle', tx: hq.tx - 8, ty: hq.ty - 2 }]);
    const cradle = st.buildings.find((b) => b.type === 'cradle')!;
    cradle.complete = true;
    step(st, [{ tick: 1, player: 1, kind: 'train', building: cradle.id, unit: 'colossus' }]);
    expect(st.events).toEqual([{ tick: 1, player: 1, kind: 'colossus' }]);
  });
});

describe('combate', () => {
  it('el mecha hace daño en área a varios soldados', () => {
    const st = createGame({ seed: 3 });
    const m = addUnit(st, 0, 40 * SUB, 40 * SUB, 'mech');
    const soldiers = [0, 1, 2].map((i) => addUnit(st, 1, 44 * SUB + i * 90, 40 * SUB, 'soldier'));
    for (const s of soldiers) s.autoAttack = false;
    step(st, [{ tick: 0, player: 0, kind: 'attack', units: [m.id], target: soldiers[1].id }]);
    run(st, 60);
    expect(soldiers.filter((s) => s.hp < s.maxHp).length).toBeGreaterThanOrEqual(2);
  });
});
