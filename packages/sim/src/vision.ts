import { BUILDINGS, buildingCenter } from './building';
import { SUB } from './constants';
import type { State } from './state';
import { coverOf } from './tech';

/** Cada cuántos ticks se recalcula la visión (suficiente para la vista y barato). */
const VISION_EVERY = 2;

/** Radio de visión de un edificio, en casillas. La red ve hasta donde llega su energía. */
export function buildingSight(type: keyof typeof BUILDINGS): number {
  const s = BUILDINGS[type];
  if (s.power) return s.power.cover;
  if (s.attack) return Math.ceil(s.attack.range / SUB) + 1;
  return Math.ceil(s.size / 2) + 3;
}

/**
 * Niebla de guerra, al estilo AoE2. Se deriva del estado (unidades y edificios), así que es
 * determinista; no afecta a la simulación (la IA, por ahora, ve todo), solo a lo que se muestra.
 */
export function updateVision(st: State): void {
  if (st.tick % VISION_EVERY !== 0 && st.tick !== 0) return;
  const { w, h } = st.map;
  const next = new Uint8Array(w * h);
  const mark = (bit: number, x: number, y: number, r: number) => {
    const cx = Math.floor(x / SUB);
    const cy = Math.floor(y / SUB);
    const rr = r * r + r;
    for (let ty = Math.max(0, cy - r); ty <= Math.min(h - 1, cy + r); ty++) {
      const dy = ty - cy;
      for (let tx = Math.max(0, cx - r); tx <= Math.min(w - 1, cx + r); tx++) {
        const dx = tx - cx;
        if (dx * dx + dy * dy <= rr) next[ty * w + tx] |= bit;
      }
    }
  };
  for (const u of st.units) {
    if (u.hp <= 0) continue;
    // Un camión desplegado con energía ve como una antena.
    const r = u.type === 'truck' && u.deployState === 2 && u.nodePowered ? Math.max(Math.ceil(u.sight / SUB), coverOf(st, u.owner, BUILDINGS.relay.power!.cover, true)) : Math.ceil(u.sight / SUB);
    mark(1 << u.owner, u.x, u.y, r);
  }
  const teamOf = (p: number) => st.players.reduce((m, o, q) => (o.team === st.players[p].team ? m | (1 << q) : m), 0);
  for (const b of st.buildings) {
    if (b.hp <= 0) continue;
    if (!b.complete) {
      // Una obra no da visión: solo deja explorado (primera capa de niebla) el terreno de su huella.
      const m = teamOf(b.owner);
      for (let y = b.ty; y < b.ty + b.size; y++) for (let x = b.tx; x < b.tx + b.size; x++) st.explored[y * w + x] |= m;
      continue;
    }
    const c = buildingCenter(b);
    // La red solo ve si tiene energía; el resto de edificios, siempre.
    const r = BUILDINGS[b.type].power && !b.powered ? Math.ceil(b.size / 2) + 2 : b.type === 'relay' ? coverOf(st, b.owner, buildingSight(b.type), true) : buildingSight(b.type);
    mark(1 << b.owner, c.x, c.y, r);
  }
  for (let p = 0; p < st.players.length; p++) {
    const bit = 1 << p;
    if (st.players[p].noFog) for (let i = 0; i < next.length; i++) next[i] |= bit;
    if (st.players[p].revealMap) for (let i = 0; i < next.length; i++) st.explored[i] |= bit;
  }
  // Los aliados comparten visión: cada jugador ve lo que ve cualquiera de su equipo.
  const teamMask = st.players.map((pl) => st.players.reduce((m, o, q) => (o.team === pl.team ? m | (1 << q) : m), 0));
  for (let i = 0; i < next.length; i++) {
    const v = next[i];
    if (v === 0) continue;
    let out = 0;
    for (let p = 0; p < teamMask.length; p++) if (v & teamMask[p]) out |= 1 << p;
    next[i] = out;
  }
  for (let i = 0; i < next.length; i++) st.explored[i] |= next[i];
  st.vision = next;
  st.visionVersion++;
}

export function isVisible(st: State, player: number, x: number, y: number): boolean {
  const tx = Math.floor(x / SUB);
  const ty = Math.floor(y / SUB);
  if (tx < 0 || ty < 0 || tx >= st.map.w || ty >= st.map.h) return false;
  return (st.vision[ty * st.map.w + tx] & (1 << player)) !== 0;
}

export function isExplored(st: State, player: number, x: number, y: number): boolean {
  const tx = Math.floor(x / SUB);
  const ty = Math.floor(y / SUB);
  if (tx < 0 || ty < 0 || tx >= st.map.w || ty >= st.map.h) return false;
  return (st.explored[ty * st.map.w + tx] & (1 << player)) !== 0;
}

/** ¿Se ve alguna casilla de esta huella? */
export function footprintVisible(st: State, player: number, tx: number, ty: number, size: number): boolean {
  const bit = 1 << player;
  for (let y = ty; y < ty + size; y++) for (let x = tx; x < tx + size; x++) if (x >= 0 && y >= 0 && x < st.map.w && y < st.map.h && st.vision[y * st.map.w + x] & bit) return true;
  return false;
}
