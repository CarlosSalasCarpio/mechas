import { describe, expect, it } from 'vitest';
import { addBuilding, addUnit, BATTERY_TICKS, createGame, isPowered, step, SUB, TECHS, UNITS, type State } from '../src';

const hqOf = (st: State, p: number) => st.buildings.find((b) => b.owner === p && b.type === 'hq')!;
function run(st: State, n: number): void {
  for (let i = 0; i < n; i++) step(st, []);
}

describe('generaciones', () => {
  it('en Gen-1 no se entrena artillería ni se construye la cuna', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 5000;
    const h = addBuilding(st, 0, 'hangar', 20, 50)!;
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [
      { tick: 0, player: 0, kind: 'train', building: h.id, unit: 'artillery' },
      { tick: 0, player: 0, kind: 'build', units: [w.id], building: 'cradle', tx: 22, ty: 64 },
    ]);
    expect(h.queue).toHaveLength(0);
    expect(st.buildings.some((b) => b.type === 'cradle')).toBe(false);
  });

  it('avanzar a Gen-2 exige barracas y hangar, cuesta y tarda; al terminar desbloquea la artillería', () => {
    const st = createGame({ seed: 3 });
    st.players[0].metal = 5000;
    const hq = hqOf(st, 0);
    step(st, [{ tick: 0, player: 0, kind: 'research', building: hq.id, tech: 'gen2' }]);
    expect(hq.research).toBeNull();
    addBuilding(st, 0, 'barracks', 20, 50);
    const h = addBuilding(st, 0, 'hangar', 24, 50)!;
    step(st, [{ tick: 1, player: 0, kind: 'research', building: hq.id, tech: 'gen2' }]);
    expect(hq.research?.tech).toBe('gen2');
    expect(st.players[0].metal).toBe(5000 - TECHS.gen2.cost);
    run(st, TECHS.gen2.time + 1);
    expect(st.players[0].gen).toBe(2);
    expect(st.events.some((e) => e.kind === 'generation' && e.gen === 2)).toBe(true);
    step(st, [{ tick: st.tick, player: 0, kind: 'train', building: h.id, unit: 'artillery' }]);
    expect(h.queue).toEqual(['artillery']);
  });

  it('cancelar una investigación devuelve el metal', () => {
    const st = createGame({ seed: 3 });
    const hq = hqOf(st, 0);
    step(st, [{ tick: 0, player: 0, kind: 'research', building: hq.id, tech: 'pneumatic' }]);
    expect(st.players[0].metal).toBe(300 - TECHS.pneumatic.cost);
    step(st, [{ tick: 1, player: 0, kind: 'cancelResearch', building: hq.id }]);
    expect(hq.research).toBeNull();
    expect(st.players[0].metal).toBe(300);
  });
});

describe('tecnologías', () => {
  it('Blindaje compuesto sube la vida de los mechas que ya existen', () => {
    const st = createGame({ seed: 3 });
    const m = addUnit(st, 0, 20 * SUB, 60 * SUB, 'mech');
    st.players[0].gen = 2;
    st.players[0].metal = 1000;
    const h = addBuilding(st, 0, 'hangar', 20, 50)!;
    step(st, [{ tick: 0, player: 0, kind: 'research', building: h.id, tech: 'composite' }]);
    run(st, TECHS.composite.time + 1);
    expect(m.maxHp).toBe(Math.trunc(UNITS.mech.maxHp * 1.25));
  });

  it('Baterías de litio alargan la batería y Carretillas la carga', () => {
    const st = createGame({ seed: 3 });
    st.players[0].techs.push('lithium', 'carts');
    const hq = hqOf(st, 0);
    // Dentro de la red se recarga hasta la nueva capacidad; luego, fuera, dura más de 12 s.
    const m = addUnit(st, 0, (hq.tx + 6) * SUB, (hq.ty + 2) * SUB, 'mech');
    m.autoAttack = false;
    run(st, 60);
    m.x = 60 * SUB;
    m.y = 30 * SUB;
    run(st, BATTERY_TICKS + 20);
    expect(m.battery).toBeGreaterThan(0);
    const w = st.units.find((u) => u.owner === 0 && u.type === 'worker')!;
    step(st, [{ tick: st.tick, player: 0, kind: 'gather', units: [w.id], target: st.nodes[0].id }]);
    let maxCarry = 0;
    for (let i = 0; i < 600; i++) {
      step(st, []);
      maxCarry = Math.max(maxCarry, w.carry);
    }
    expect(maxCarry).toBe(15);
  });
});

describe('camión repetidor', () => {
  it('desplegado extiende la red; replegado, no', () => {
    const st = createGame({ seed: 3 });
    const hq = hqOf(st, 0);
    // Justo más allá del borde de la cobertura del cuartel general, pero a distancia de enlace.
    const t = addUnit(st, 0, (hq.tx + 2 + 16) * SUB, (hq.ty + 2) * SUB, 'truck');
    const probe = { x: (hq.tx + 2 + 21) * SUB, y: (hq.ty + 2) * SUB };
    step(st, []);
    expect(isPowered(st, 0, probe.x, probe.y)).toBe(false);
    step(st, [{ tick: st.tick, player: 0, kind: 'deploy', units: [t.id], on: true }]);
    run(st, 70);
    expect(t.deployState).toBe(2);
    expect(isPowered(st, 0, probe.x, probe.y)).toBe(true);
    // Moverlo lo repliega y la red se retrae.
    step(st, [{ tick: st.tick, player: 0, kind: 'move', units: [t.id], x: t.x - 4 * SUB, y: t.y }]);
    step(st, []);
    expect(t.deployState).toBe(0);
    expect(isPowered(st, 0, probe.x, probe.y)).toBe(false);
  });
});

describe('reactor de los colosos', () => {
  it('no necesitan la red, y al morir estallan dañando a propios y enemigos', () => {
    const st = createGame({ seed: 3 });
    const c = addUnit(st, 0, 60 * SUB, 30 * SUB, 'colossus');
    const friend = addUnit(st, 0, 61 * SUB, 30 * SUB, 'soldier');
    const foe = addUnit(st, 1, 62 * SUB, 31 * SUB, 'soldier');
    const far = addUnit(st, 1, 70 * SUB, 30 * SUB, 'soldier');
    friend.autoAttack = foe.autoAttack = far.autoAttack = c.autoAttack = false;
    run(st, BATTERY_TICKS + 10);
    expect(c.battery).toBeGreaterThan(0);
    c.hp = 0;
    step(st, []);
    expect(st.byId.has(friend.id)).toBe(false);
    expect(st.byId.has(foe.id)).toBe(false);
    expect(st.byId.has(far.id)).toBe(true);
    expect(st.fx.some((f) => f.kind === 'reactor')).toBe(true);
  });
});
