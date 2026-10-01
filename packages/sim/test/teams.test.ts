import { describe, expect, it } from 'vitest';
import { addUnit, createGame, GRASS, hostile, isVisible, MODES, step, SUB } from '../src';

describe('varios jugadores y equipos', () => {
  for (const [mode, teams] of Object.entries(MODES)) {
    it(`${mode}: cada jugador tiene su base, en terreno limpio y separada de las demás`, () => {
      const st = createGame({ seed: 5, teams });
      expect(st.players).toHaveLength(teams.length);
      const hqs = st.buildings.filter((b) => b.type === 'hq');
      expect(hqs.map((b) => b.owner)).toEqual(teams.map((_, i) => i));
      for (const h of hqs) {
        expect(st.map.tiles[(h.ty + 1) * st.map.w + h.tx + 1]).toBe(GRASS);
        expect(st.units.filter((u) => u.owner === h.owner && u.type === 'worker')).toHaveLength(4);
      }
      for (let i = 0; i < hqs.length; i++) for (let j = i + 1; j < hqs.length; j++) expect(Math.hypot(hqs[i].tx - hqs[j].tx, hqs[i].ty - hqs[j].ty)).toBeGreaterThan(30);
    });
  }

  it('los aliados no son enemigos y comparten visión', () => {
    const st = createGame({ seed: 5, teams: MODES['2v2'] });
    expect(hostile(st, 0, 1)).toBe(false);
    expect(hostile(st, 0, 2)).toBe(true);
    const ally = st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!;
    expect(isVisible(st, 0, (ally.tx + 2) * SUB, (ally.ty + 2) * SUB)).toBe(true);
  });

  it('un soldado no ataca a un aliado', () => {
    const st = createGame({ seed: 5, teams: MODES['2v2'] });
    const a = addUnit(st, 0, 80 * SUB, 80 * SUB, 'soldier');
    const b = addUnit(st, 1, 81 * SUB, 80 * SUB, 'soldier');
    for (let i = 0; i < 100; i++) step(st, []);
    expect(a.hp).toBe(a.maxHp);
    expect(b.hp).toBe(b.maxHp);
  });

  it('quien pierde su cuartel general queda eliminado; gana el último equipo en pie', () => {
    const st = createGame({ seed: 5, teams: MODES['1v2'] });
    st.buildings.find((b) => b.owner === 1 && b.type === 'hq')!.hp = 0;
    step(st, []);
    expect(st.players[1].defeated).toBe(true);
    expect(st.units.some((u) => u.owner === 1)).toBe(false);
    expect(st.winner).toBe(-1);
    st.buildings.find((b) => b.owner === 2 && b.type === 'hq')!.hp = 0;
    step(st, []);
    expect(st.winner).toBe(0);
  });
});
