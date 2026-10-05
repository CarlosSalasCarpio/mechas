import { BUILDINGS, buildingCenter, canPlace, type BuildingType } from './building';
import { SUB } from './constants';
import { isqrt } from './math';
import { GRASS } from './map';
import { hostile, type State } from './state';
import { coverOf, linkOf } from './tech';

/**
 * Red de energía. Las centrales (sobre una veta) son las fuentes; una antena recibe energía si enlaza,
 * directa o encadenada, con una central. Cada nodo con energía cubre un radio de casillas.
 * Todo se deriva de los edificios en cada tick, así que es determinista y no hace falta guardarlo.
 */
/** Nodo de la red: un edificio (cuartel general, central, antena) o un camión repetidor desplegado. */
interface PowerNode {
  x: number;
  y: number;
  cover: number;
  link: number;
  source: boolean;
  complete: boolean;
  setPowered: (v: boolean) => void;
  powered: boolean;
}

/** Nodos de la red de un jugador, en orden de id (determinista). */
export function powerNodes(st: State, p: number): PowerNode[] {
  const out: PowerNode[] = [];
  for (const b of st.buildings) {
    const pw = BUILDINGS[b.type].power;
    if (b.owner !== p || b.hp <= 0 || !pw) continue;
    const c = buildingCenter(b);
    out.push({ x: c.x, y: c.y, cover: coverOf(st, p, pw.cover, b.type === 'relay'), link: linkOf(st, p, pw.link, b.type === 'relay'), source: pw.source, complete: b.complete, powered: false, setPowered: (v) => (b.powered = v) });
  }
  const relay = BUILDINGS.relay.power!;
  for (const u of st.units) {
    if (u.owner !== p || u.hp <= 0 || u.type !== 'truck') continue;
    if (u.deployState !== 2) {
      u.nodePowered = false;
      continue;
    }
    out.push({ x: u.x, y: u.y, cover: coverOf(st, p, relay.cover, true), link: linkOf(st, p, relay.link, true), source: false, complete: true, powered: false, setPowered: (v) => (u.nodePowered = v) });
  }
  return out;
}

export function updatePower(st: State): void {
  const { w, h } = st.map;
  const next = new Uint8Array(w * h);
  for (let p = 0; p < st.players.length; p++) {
    const nodes = powerNodes(st, p);
    for (const n of nodes) n.powered = n.complete && n.source;
    // Propagar desde las fuentes por los enlaces (en orden: determinista).
    const frontier = nodes.filter((n) => n.powered);
    while (frontier.length > 0) {
      const a = frontier.shift()!;
      for (const b of nodes) {
        if (b.powered || !b.complete) continue;
        const link = Math.max(a.link, b.link) * SUB;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= link * link) {
          b.powered = true;
          frontier.push(b);
        }
      }
    }
    const bit = 1 << p;
    for (const n of nodes) {
      n.setPowered(n.powered);
      if (!n.powered) continue;
      const r = n.cover;
      const cx = Math.floor(n.x / SUB);
      const cy = Math.floor(n.y / SUB);
      const rr = r * SUB;
      for (let ty = Math.max(0, cy - r - 1); ty <= Math.min(h - 1, cy + r + 1); ty++) {
        for (let tx = Math.max(0, cx - r - 1); tx <= Math.min(w - 1, cx + r + 1); tx++) {
          const dx = tx * SUB + SUB / 2 - n.x;
          const dy = ty * SUB + SUB / 2 - n.y;
          if (dx * dx + dy * dy <= rr * rr) next[ty * w + tx] |= bit;
        }
      }
    }
  }
  if (!sameMask(next, st.power)) {
    st.power = next;
    st.powerVersion++;
  }
}

function sameMask(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Bits de la red de todo el equipo de un jugador: las unidades se alimentan también de la red aliada. */
export function teamPowerMask(st: State, player: number): number {
  const team = st.players[player].team;
  let m = 0;
  st.players.forEach((pl, q) => {
    if (pl.team === team) m |= 1 << q;
  });
  return m;
}

/**
 * ¿Tiene energía este punto para las unidades de `player`? Cuenta la red propia y la de sus aliados
 * (las redes no se encadenan entre aliados, pero la cobertura se comparte).
 */
export function isPowered(st: State, player: number, x: number, y: number): boolean {
  const tx = Math.floor(x / SUB);
  const ty = Math.floor(y / SUB);
  if (tx < 0 || ty < 0 || tx >= st.map.w || ty >= st.map.h) return false;
  return (st.power[ty * st.map.w + tx] & teamPowerMask(st, player)) !== 0;
}

/** Centro de la casilla con energía más cercana a (x, y) en un radio, o null. */
export function nearestPoweredTile(st: State, player: number, x: number, y: number, maxR = 24): { x: number; y: number } | null {
  const { w, h } = st.map;
  const cx = Math.floor(x / SUB);
  const cy = Math.floor(y / SUB);
  const bit = teamPowerMask(st, player);
  for (let r = 1; r <= maxR; r++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h || (st.power[ty * w + tx] & bit) === 0) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: tx * SUB + SUB / 2, y: ty * SUB + SUB / 2 };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Veta cuya casilla central queda en el centro de una huella de central en (tx, ty). */
export function ventAt(st: State, tx: number, ty: number): { tx: number; ty: number } | undefined {
  const half = Math.floor(BUILDINGS.plant.size / 2);
  return st.vents.find((v) => v.tx === tx + half && v.ty === ty + half);
}

/**
 * ¿Se puede colocar este edificio aquí? Además de la huella libre: las centrales solo van centradas
 * sobre una veta y ningún otro edificio puede tapar una veta.
 */
export function canPlaceBuilding(st: State, type: BuildingType, tx: number, ty: number): boolean {
  const size = BUILDINGS[type].size;
  if (!canPlace(st.map, tx, ty, size)) return false;
  if (type === 'plant') return !!ventAt(st, tx, ty);
  return !st.vents.some((v) => v.tx >= tx - 1 && v.tx <= tx + size && v.ty >= ty - 1 && v.ty <= ty + size);
}

/**
 * ¿Puede `player` intentar poner aquí unos cimientos, con lo que sabe? Igual que `canPlaceBuilding`, pero
 * los edificios enemigos que su equipo no ve ahora mismo no cuentan (si no, la orden delataría que están).
 */
export function canPlaceKnown(st: State, type: BuildingType, tx: number, ty: number, player: number): boolean {
  if (canPlaceBuilding(st, type, tx, ty)) return true;
  const size = BUILDINGS[type].size;
  const { w, h } = st.map;
  if (tx < 0 || ty < 0 || tx + size > w || ty + size > h) return false;
  for (let y = ty; y < ty + size; y++) {
    for (let x = tx; x < tx + size; x++) {
      const i = y * w + x;
      if (st.map.tiles[i] !== GRASS) return false;
      const occ = st.map.occ[i];
      if (!occ) continue;
      const b = st.buildingsById.get(occ);
      if (!b || !hostile(st, b.owner, player) || (st.vision[i] & teamPowerMask(st, player)) !== 0) return false;
    }
  }
  if (type === 'plant') return !!ventAt(st, tx, ty);
  return !st.vents.some((v) => v.tx >= tx - 1 && v.tx <= tx + size && v.ty >= ty - 1 && v.ty <= ty + size);
}

/** ¿Algún edificio enemigo, visible ahora para `player`, ocupa esta huella? */
export function visibleBlocker(st: State, type: BuildingType, tx: number, ty: number, player: number): boolean {
  const size = BUILDINGS[type].size;
  const { w } = st.map;
  for (let y = ty; y < ty + size; y++) {
    for (let x = tx; x < tx + size; x++) {
      const i = y * w + x;
      const occ = st.map.occ[i];
      if (occ && st.buildingsById.get(occ)?.owner !== player && (st.vision[i] & teamPowerMask(st, player)) !== 0) return true;
    }
  }
  return false;
}

/** Distancia (subunidades) de un punto a la casilla con energía más cercana; 0 si ya tiene. */
export function distToPower(st: State, player: number, x: number, y: number): number {
  if (isPowered(st, player, x, y)) return 0;
  const p = nearestPoweredTile(st, player, x, y);
  return p ? isqrt((p.x - x) ** 2 + (p.y - y) ** 2) : Infinity;
}

