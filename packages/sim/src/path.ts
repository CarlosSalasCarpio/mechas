import { SUB } from './constants';
import { isWalkable, isWalkableSub, type GameMap } from './map';

// 8 direcciones: primero ortogonales, luego diagonales. El orden importa para el determinismo.
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [10, 10, 10, 10, 14, 14, 14, 14];

export const INF = 0x3fffffff;

// Buffers reutilizables. Se reinician en cada búsqueda, así que no filtran estado entre llamadas.
let cap = 0;
let gScore = new Int32Array(0);
let parent = new Int32Array(0);
let closed = new Uint8Array(0);

function ensure(n: number): void {
  if (cap >= n) return;
  cap = n;
  gScore = new Int32Array(n);
  parent = new Int32Array(n);
  closed = new Uint8Array(n);
}

// Min-heap binario de (prioridad, nodo). Empates se resuelven por índice de nodo.
const heapP: number[] = [];
const heapN: number[] = [];

function less(i: number, j: number): boolean {
  return heapP[i] < heapP[j] || (heapP[i] === heapP[j] && heapN[i] < heapN[j]);
}

function swap(i: number, j: number): void {
  const p = heapP[i];
  heapP[i] = heapP[j];
  heapP[j] = p;
  const n = heapN[i];
  heapN[i] = heapN[j];
  heapN[j] = n;
}

function heapPush(p: number, n: number): void {
  heapP.push(p);
  heapN.push(n);
  let i = heapP.length - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (!less(i, up)) break;
    swap(i, up);
    i = up;
  }
}

function heapPop(): number {
  const top = heapN[0];
  const lastP = heapP.pop()!;
  const lastN = heapN.pop()!;
  if (heapP.length > 0) {
    heapP[0] = lastP;
    heapN[0] = lastN;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heapP.length && less(l, m)) m = l;
      if (r < heapP.length && less(r, m)) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  }
  return top;
}

function heapClear(): void {
  heapP.length = 0;
  heapN.length = 0;
}

/** ¿Se puede pasar de (x,y) en la dirección d? Las diagonales no pueden cortar esquinas. */
function canStep(m: GameMap, x: number, y: number, d: number): boolean {
  const nx = x + DX[d];
  const ny = y + DY[d];
  if (!isWalkable(m, nx, ny)) return false;
  if (d >= 4) return isWalkable(m, nx, y) && isWalkable(m, x, ny);
  return true;
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
}

/**
 * A* sobre casillas. Devuelve índices de casilla desde la siguiente al origen hasta la meta.
 * Si la meta es inalcanzable, devuelve el camino a la casilla alcanzable más cercana.
 */
export function findPath(m: GameMap, sx: number, sy: number, gx: number, gy: number): number[] {
  const n = m.w * m.h;
  ensure(n);
  gScore.fill(INF, 0, n);
  closed.fill(0, 0, n);
  heapClear();

  const start = sy * m.w + sx;
  const goal = gy * m.w + gx;
  gScore[start] = 0;
  parent[start] = -1;
  heapPush(octile(sx, sy, gx, gy), start);

  let best = start;
  let bestH = octile(sx, sy, gx, gy);

  while (heapP.length > 0) {
    const cur = heapPop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      best = cur;
      break;
    }
    const cx = cur % m.w;
    const cy = (cur - cx) / m.w;
    const h = octile(cx, cy, gx, gy);
    if (h < bestH) {
      bestH = h;
      best = cur;
    }
    for (let d = 0; d < 8; d++) {
      if (!canStep(m, cx, cy, d)) continue;
      const nb = cur + DY[d] * m.w + DX[d];
      if (closed[nb]) continue;
      const g = gScore[cur] + COST[d];
      if (g < gScore[nb]) {
        gScore[nb] = g;
        parent[nb] = cur;
        heapPush(g + octile(cx + DX[d], cy + DY[d], gx, gy), nb);
      }
    }
  }

  const out: number[] = [];
  for (let c = best; c !== start; c = parent[c]) out.push(c);
  out.reverse();
  return out;
}

/** Dijkstra desde la meta: distancia de cada casilla a ella. Un solo cálculo sirve a todo un grupo. */
export function distanceField(m: GameMap, gx: number, gy: number): Int32Array {
  const n = m.w * m.h;
  const field = new Int32Array(n).fill(INF);
  heapClear();
  const goal = gy * m.w + gx;
  field[goal] = 0;
  heapPush(0, goal);
  while (heapP.length > 0) {
    const cur = heapPop();
    const cx = cur % m.w;
    const cy = (cur - cx) / m.w;
    const base = field[cur];
    for (let d = 0; d < 8; d++) {
      if (!canStep(m, cx, cy, d)) continue;
      const nb = cur + DY[d] * m.w + DX[d];
      const g = base + COST[d];
      if (g < field[nb]) {
        field[nb] = g;
        heapPush(g, nb);
      }
    }
  }
  return field;
}

/** Baja por el campo de distancias desde (sx,sy). Devuelve null si el origen no está conectado. */
export function descend(m: GameMap, field: Int32Array, sx: number, sy: number): number[] | null {
  let cur = sy * m.w + sx;
  if (field[cur] >= INF) return null;
  const out: number[] = [];
  while (field[cur] > 0) {
    const cx = cur % m.w;
    const cy = (cur - cx) / m.w;
    let next = -1;
    let bestV = field[cur];
    for (let d = 0; d < 8; d++) {
      if (!canStep(m, cx, cy, d)) continue;
      const nb = cur + DY[d] * m.w + DX[d];
      if (field[nb] < bestV) {
        bestV = field[nb];
        next = nb;
      }
    }
    if (next < 0) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** ¿El segmento entre dos puntos (en subunidades) cruza solo casillas transitables? */
export function lineWalkable(m: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.trunc(Math.max(Math.abs(dx), Math.abs(dy)) / 32) + 1;
  for (let i = 0; i <= steps; i++) {
    if (!isWalkableSub(m, x0 + Math.trunc((dx * i) / steps), y0 + Math.trunc((dy * i) / steps))) return false;
  }
  return true;
}

/**
 * Convierte casillas en waypoints (centros, en subunidades), reemplaza la última por el destino
 * exacto y recorta los puntos intermedios que se pueden saltar en línea recta.
 */
export function toWaypoints(m: GameMap, sx: number, sy: number, tiles: readonly number[], ex: number, ey: number): number[] {
  const pts: number[] = [];
  for (const t of tiles) {
    const tx = t % m.w;
    pts.push(tx * SUB + SUB / 2, ((t - tx) / m.w) * SUB + SUB / 2);
  }
  if (isWalkableSub(m, ex, ey)) {
    if (pts.length > 0) pts.length -= 2;
    pts.push(ex, ey);
  }
  const out: number[] = [];
  let ax = sx;
  let ay = sy;
  const n = pts.length / 2;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && lineWalkable(m, ax, ay, pts[2 * (j + 1)], pts[2 * (j + 1) + 1])) j++;
    ax = pts[2 * j];
    ay = pts[2 * j + 1];
    out.push(ax, ay);
    i = j + 1;
  }
  return out;
}
