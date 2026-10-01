import type { State } from './state';

/** Checksum FNV-1a del estado. Si dos corridas dan el mismo hash en cada tick, son idénticas. */
export function hashState(st: State): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    v |= 0;
    h = Math.imul(h ^ (v & 0xffff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xffff), 0x01000193);
  };
  mix(st.tick);
  mix(st.rng.s);
  for (const p of st.players) {
    mix(p.metal);
    mix(p.team);
    mix(p.defeated ? 1 : 0);
    mix(p.instant ? 1 : 0);
    mix(p.popCap);
    mix(p.noPower ? 1 : 0);
    mix(p.revealMap ? 1 : 0);
    mix(p.noFog ? 1 : 0);
    mix(p.gen);
    mix(p.techs.length);
    for (const t of p.techs) mix(t.length * 131 + t.charCodeAt(0) * 7 + t.charCodeAt(t.length - 1));
  }
  mix(st.winner);
  mix(st.units.length);
  for (const u of st.units) {
    mix(u.id);
    mix(u.owner);
    mix(u.x);
    mix(u.y);
    mix(u.hp);
    mix(u.cd);
    mix(u.pathIdx);
    mix(u.carry);
    mix(u.battery);
    mix(u.deployState);
    mix(u.deployTicks);
    mix(u.maxHp);
    mix(u.range);
    mix(u.stuck);
    mix(u.bestDist);
    mix(u.groupSpeed);
    mix(u.orderQueue.length);
    for (const q of u.orderQueue) {
      if (q.kind === 'move' || q.kind === 'amove') {
        mix(q.x);
        mix(q.y);
      } else if (q.kind === 'place') {
        mix(7);
        mix(q.tx * 4096 + q.ty);
        mix(q.building.charCodeAt(0) * 31 + q.building.length);
      } else mix(q.kind === 'gather' ? q.node : q.target + (q.kind === 'repair' ? 1 << 24 : 0));
    }
    mix(u.resumeX);
    mix(u.resumeY);
    const o = u.order;
    if (o.kind === 'idle') mix(0);
    else if (o.kind === 'move' || o.kind === 'amove') {
      mix(o.kind === 'move' ? 1 : 5);
      mix(o.x);
      mix(o.y);
    } else if (o.kind === 'attack') {
      mix(2);
      mix(o.target);
    } else if (o.kind === 'gather') {
      mix(3);
      mix(o.node);
    } else if (o.kind === 'place') {
      mix(7);
      mix(o.tx * 4096 + o.ty);
      mix(o.building.charCodeAt(0) * 31 + o.building.length);
    } else {
      mix(o.kind === 'build' ? 4 : 6);
      mix(o.target);
    }
  }
  mix(st.buildings.length);
  for (const b of st.buildings) {
    mix(b.id);
    mix(b.owner);
    mix(b.tx);
    mix(b.ty);
    mix(b.hp);
    mix(b.progress);
    mix(b.trainTicks);
    mix(b.queue.length);
    mix(b.rallyX);
    mix(b.rallyY);
    mix(b.cd);
    mix(b.aim);
    mix(b.repairAcc);
    mix(b.research ? b.research.ticks + 1 : 0);
  }
  mix(st.projectiles.length);
  for (const p of st.projectiles) {
    mix(p.id);
    mix(p.t);
    mix(p.x1);
    mix(p.y1);
  }
  mix(st.nodes.length);
  for (const n of st.nodes) {
    mix(n.id);
    mix(n.amount);
  }
  return h >>> 0;
}
