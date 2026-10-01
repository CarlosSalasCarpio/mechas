import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { aiCommands, createGame, hashState, MODES, step, SUB, type Command } from '@epocas/sim';

export interface Replay {
  version: 1;
  seed: number;
  perSide: number;
  commands: Command[];
  finalTick: number;
  finalHash: number;
}

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '42' },
    ticks: { type: 'string', default: '2000' },
    'per-side': { type: 'string', default: '50' },
    replay: { type: 'string' },
    ai: { type: 'boolean', default: false },
    mode: { type: 'string', default: '1v1' },
  },
});

const hex = (h: number) => '0x' + h.toString(16).padStart(8, '0');

if (values.replay) {
  const r = JSON.parse(readFileSync(values.replay, 'utf8')) as Replay;
  const st = createGame({ seed: r.seed, perSide: r.perSide });
  const byTick = new Map<number, Command[]>();
  for (const c of r.commands) byTick.set(c.tick, [...(byTick.get(c.tick) ?? []), c]);
  while (st.tick < r.finalTick) step(st, byTick.get(st.tick) ?? []);
  const h = hashState(st);
  const ok = h === r.finalHash;
  console.log(`replay · tick ${st.tick} · hash ${hex(h)} · esperado ${hex(r.finalHash)} · ${ok ? 'OK' : 'NO COINCIDE'}`);
  process.exit(ok ? 0 : 1);
}

if (values.ai) {
  // IA contra IA desde la base inicial, hasta que alguien gane o se acabe el tiempo.
  const teams = MODES[values.mode!];
  if (!teams) throw new Error(`modo desconocido: ${values.mode} (${Object.keys(MODES).join(', ')})`);
  const st = createGame({ seed: Number(values.seed), teams });
  const limit = Number(values.ticks);
  let total = 0;
  const t0 = performance.now();
  while (st.tick < limit && st.winner < 0) {
    const cmds = st.players.flatMap((_, p) => aiCommands(st, p));
    const t = performance.now();
    step(st, cmds);
    total += performance.now() - t;
    if (st.tick % 2400 === 0) {
      const line = st.players.map((pl, p) => {
        if (pl.defeated) return `J${p}(e${pl.team}): eliminado`;
        const us = st.units.filter((u) => u.owner === p);
        const n = (t: string) => us.filter((u) => u.type === t).length;
        const bs = st.buildings.filter((b) => b.owner === p).map((b) => ({ hq: 'C', depot: 'd', barracks: 'b', hangar: 'h', cradle: 'K', tower: 't', plant: 'P', relay: 'r' })[b.type]).join('');
        return `J${p}: metal ${st.players[p].metal} · obr ${n('worker')} sol ${n('soldier')} mec ${n('mech')} art ${n('artillery')} col ${n('colossus')} ase ${n('siege')} cam ${n('truck')} · G${st.players[p].gen} t${st.players[p].techs.length} · [${bs}]`;
      });
      console.log(`${(st.tick / 1200).toFixed(0).padStart(2)} min  ${line.join('   ')}`);
    }
  }
  const who = st.winner < 0 ? 'nadie (tiempo agotado)' : `el equipo ${st.winner} (${st.players.map((pl, p) => (pl.team === st.winner ? `J${p}` : '')).filter(Boolean).join(', ')})`;
  console.log(`gana ${who} en ${(st.tick / 1200).toFixed(1)} min · hash ${hex(hashState(st))} · ${(total / st.tick).toFixed(3)} ms/tick · ${((performance.now() - t0) / 1000).toFixed(1)} s reales`);
  process.exit(0);
}

// Escenario por defecto: ambos ejércitos marchan al centro y pelean.
const seed = Number(values.seed);
const ticks = Number(values.ticks);
const perSide = Number(values['per-side']);
const st = createGame({ seed, perSide });
const opening: Command[] = [0, 1].map((p) => ({
  tick: 0,
  player: p,
  kind: 'move',
  units: st.units.filter((u) => u.owner === p).map((u) => u.id),
  x: 60 * SUB,
  y: 60 * SUB,
}));

let total = 0;
let worst = 0;
for (let t = 0; t < ticks; t++) {
  const t0 = performance.now();
  step(st, t === 0 ? opening : []);
  const dt = performance.now() - t0;
  total += dt;
  if (dt > worst) worst = dt;
}
const alive = [0, 1].map((p) => st.units.filter((u) => u.owner === p).length);
console.log(
  `seed ${seed} · tick ${st.tick} · hash ${hex(hashState(st))} · vivos ${alive.join(' vs ')} · ` +
    `${(total / ticks).toFixed(3)} ms/tick (peor ${worst.toFixed(1)} ms)`,
);
