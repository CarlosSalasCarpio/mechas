import { BUILDINGS, buildingCenter, MAX_QUEUE, nearestPoint, occupyRect, REPAIR_HP_PER_METAL, type Building } from './building';
import type { Command } from './commands';
import { SUB } from './constants';
import { isWalkable, isWalkableSub, tileOf, type GameMap } from './map';
import { clamp, idiv, isqrt } from './math';
import { descend, distanceField, findPath, INF, lineWalkable, toWaypoints } from './path';
import { CARRY, GATHER_TICKS, type MetalNode } from './resource';
import { addBuilding, addUnit, CHEAT_POP_CAP, hostile, POP_CAP, popUsed, type State } from './state';
import { BATTERY_RECHARGE, UNITS, type QueuedOrder, type Unit } from './unit';
import { attackDamage, batteryMax, BUILDING_GEN, carryCap, gatherTicks, refreshUnit, RELAY_HP, TECHS, towerDamage, UNIT_GEN } from './tech';
import { canPlaceBuilding, isPowered, nearestPoweredTile, updatePower } from './power';
import { updateVision } from './vision';

const REPATH_TICKS = 10;
const ACQUIRE_EVERY = 4;
const LEASH = 2 * SUB;
/** Distancia de trabajo de un obrero a la huella (recolectar, entregar, construir): alcanza desde una casilla vecina, también en diagonal. */
const WORK_RANGE = 160;
/** Radio en el que un obrero busca otro yacimiento o construcción cuando se acaba el suyo. */
const SEARCH_RADIUS = 10 * SUB;
const MAX_EVENTS = 20;
/** Ticks que tarda un camión repetidor en desplegarse. */
const DEPLOY_TICKS = 60;
const STUCK_TICKS = 30;
/** Vecindad de la rejilla (en casillas) que cubre dos colosos superpuestos. */
const NEAR = Math.ceil((2 * UNITS.colossus.radius) / SUB);
const PUSH_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const PUSH_DY = [0, 1, 1, 1, 0, -1, -1, -1];

/** Rejilla espacial: una lista enlazada de índices de unidad por casilla, en orden de id. */
interface Grid {
  head: Int32Array;
  next: Int32Array;
}

function buildGrid(st: State): Grid {
  const { w, h } = st.map;
  const head = new Int32Array(w * h).fill(-1);
  const next = new Int32Array(st.units.length).fill(-1);
  for (let i = st.units.length - 1; i >= 0; i--) {
    const u = st.units[i];
    if (u.hp <= 0) continue;
    const c = clamp(tileOf(u.y), 0, h - 1) * w + clamp(tileOf(u.x), 0, w - 1);
    next[i] = head[c];
    head[c] = i;
  }
  return { head, next };
}

/** Avanza exactamente un tick. */
export function step(st: State, cmds: readonly Command[]): void {
  st.fx.length = 0;
  const sorted = cmds.slice().sort((a, b) => a.player - b.player);
  for (const c of sorted) applyCommand(st, c);
  updatePower(st);

  for (const b of st.buildings) {
    if (b.hp <= 0) continue;
    if (!b.complete && st.players[b.owner].instant) finish(st, b);
    if (b.complete) produce(st, b);
  }

  plantIncome(st);
  const grid = buildGrid(st);
  for (const b of st.buildings) if (b.hp > 0 && b.complete && BUILDINGS[b.type].attack) towerThink(st, b, grid);
  for (const u of st.units) if (u.hp > 0) think(st, u, grid);
  flyProjectiles(st, grid);

  separate(st);
  removeDead(st);
  updateVision(st);
  eliminate(st);
  st.tick++;
}

/** Termina un edificio. El truco instantáneo lo deja con la vida completa; los obreros, con la que acumularon. */
/**
 * Quien se queda sin cuartel general queda eliminado: sus unidades y edificios desaparecen. Gana el
 * equipo que queda en pie.
 */
function eliminate(st: State): void {
  if (st.winner >= 0) return;
  let changed = false;
  st.players.forEach((pl, p) => {
    if (pl.defeated || st.buildings.some((b) => b.owner === p && b.type === 'hq')) return;
    pl.defeated = true;
    changed = true;
    for (const u of st.units) if (u.owner === p) st.byId.delete(u.id);
    st.units = st.units.filter((u) => u.owner !== p);
    for (const b of st.buildings) {
      if (b.owner !== p) continue;
      st.buildingsById.delete(b.id);
      occupyRect(st.map, b.tx, b.ty, b.size, 0);
    }
    st.buildings = st.buildings.filter((b) => b.owner !== p);
    st.projectiles = st.projectiles.filter((pr) => pr.owner !== p);
  });
  if (!changed) return;
  const teams = new Set(st.players.filter((pl) => !pl.defeated).map((pl) => pl.team));
  if (teams.size === 1) st.winner = [...teams][0];
}

/** Metal por central extra cada 10 s en Gen-3 (30 por minuto): poco, pero sostiene el final de la partida. */
const PLANT_INCOME = 5;
const PLANT_INCOME_TICKS = 200;

/** En Gen-3, cada central terminada y con energía, a partir de la segunda, produce un goteo de metal. */
function plantIncome(st: State): void {
  if (st.tick % PLANT_INCOME_TICKS !== 0 || st.tick === 0) return;
  st.players.forEach((pl, p) => {
    if (pl.gen < 3 || pl.defeated) return;
    const plants = st.buildings.filter((b) => b.owner === p && b.type === 'plant' && b.complete && b.powered);
    for (const b of plants.slice(1)) {
      pl.metal += PLANT_INCOME;
      const c = buildingCenter(b);
      st.fx.push({ kind: 'income', owner: p, x: c.x, y: c.y, amount: PLANT_INCOME });
    }
  });
}

function finish(st: State, b: Building, heal = true): void {
  b.complete = true;
  b.progress = BUILDINGS[b.type].buildTime;
  if (heal) b.hp = b.maxHp;
  const c = buildingCenter(b);
  st.fx.push({ kind: 'built', btype: b.type, owner: b.owner, x: c.x, y: c.y });
}

/** Radio y daño de la explosión del reactor de un coloso al morir. */
const REACTOR_RADIUS = 3 * SUB + SUB / 2;
const REACTOR_DAMAGE = 500;

function removeDead(st: State): void {
  // Reactores: cada coloso que cae estalla y daña todo lo que tiene cerca, propio o enemigo. Si la
  // explosión tumba a otro coloso, ese también estalla (reacción en cadena).
  const blasted = new Set<number>();
  for (let again = true; again; ) {
    again = false;
    for (const u of st.units) {
      if (u.hp > 0 || blasted.has(u.id) || (u.type !== 'colossus' && u.type !== 'siege')) continue;
      blasted.add(u.id);
      again = true;
      st.fx.push({ kind: 'reactor', owner: u.owner, x: u.x, y: u.y, radius: REACTOR_RADIUS });
      for (const o of st.units) {
        if (o.id === u.id || o.hp <= 0) continue;
        const reach = REACTOR_RADIUS + o.radius;
        if ((o.x - u.x) ** 2 + (o.y - u.y) ** 2 <= reach * reach) o.hp -= REACTOR_DAMAGE;
      }
      for (const b of st.buildings) {
        if (b.hp <= 0) continue;
        const x = clamp(u.x, b.tx * SUB, (b.tx + b.size) * SUB);
        const y = clamp(u.y, b.ty * SUB, (b.ty + b.size) * SUB);
        if ((x - u.x) ** 2 + (y - u.y) ** 2 <= REACTOR_RADIUS * REACTOR_RADIUS) b.hp -= REACTOR_DAMAGE;
      }
    }
  }
  if (st.units.some((u) => u.hp <= 0)) {
    for (const u of st.units) {
      if (u.hp > 0) continue;
      st.byId.delete(u.id);
      st.fx.push({ kind: 'death', utype: u.type, owner: u.owner, x: u.x, y: u.y });
    }
    st.units = st.units.filter((u) => u.hp > 0);
  }
  if (st.buildings.some((b) => b.hp <= 0)) {
    for (const b of st.buildings) {
      if (b.hp > 0) continue;
      st.buildingsById.delete(b.id);
      const c = buildingCenter(b);
      st.fx.push({ kind: 'destroyed', btype: b.type, owner: b.owner, x: c.x, y: c.y });
      occupyRect(st.map, b.tx, b.ty, b.size, 0);
    }
    st.buildings = st.buildings.filter((b) => b.hp > 0);
  }
  if (st.nodes.some((n) => n.amount <= 0)) {
    for (const n of st.nodes) {
      if (n.amount > 0) continue;
      st.nodesById.delete(n.id);
      occupyRect(st.map, n.tx, n.ty, 1, 0);
    }
    st.nodes = st.nodes.filter((n) => n.amount > 0);
  }
}

// ---------------------------------------------------------------- comandos

function ownedUnits(st: State, player: number, ids: readonly number[]): Unit[] {
  const out: Unit[] = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const u = st.byId.get(id);
    if (u && u.owner === player && u.hp > 0) out.push(u);
  }
  return out;
}

/** Orden directa del jugador: también olvida cualquier ataque en movimiento pendiente. */
function command(u: Unit, order: Unit['order']): void {
  setOrder(u, order);
  u.resumeX = -1;
  u.resumeY = -1;
  u.orderQueue = [];
}

/**
 * Orden con Shift: si la unidad está ociosa o recolectando (que nunca termina), se aplica ya;
 * si no, espera al final de su cola.
 */
function enqueue(st: State, u: Unit, q: QueuedOrder): void {
  if (u.orderQueue.length === 0 && (u.order.kind === 'idle' || u.order.kind === 'gather')) {
    u.resumeX = -1;
    u.resumeY = -1;
    applyQueued(st, u, q);
  } else u.orderQueue.push(q);
}

/** Ejecuta una orden encolada. Devuelve false si ya no tiene sentido (yacimiento agotado, edificio terminado). */
function applyQueued(st: State, u: Unit, q: QueuedOrder): boolean {
  switch (q.kind) {
    case 'move':
    case 'amove':
      commandMove(st, [u], q.x, q.y, q.kind);
      return true;
    case 'gather':
      if (!st.nodesById.has(q.node) || u.type !== 'worker') return false;
      setOrder(u, { kind: 'gather', node: q.node });
      return true;
    case 'build': {
      const b = st.buildingsById.get(q.target);
      if (!b || b.complete || b.hp <= 0 || u.type !== 'worker') return false;
      setOrder(u, { kind: 'build', target: b.id });
      return true;
    }
    case 'repair': {
      const b = st.buildingsById.get(q.target);
      if (!b || !b.complete || b.hp <= 0 || b.hp >= b.maxHp || u.type !== 'worker') return false;
      setOrder(u, { kind: 'repair', target: b.id });
      return true;
    }
  }
}

function setOrder(u: Unit, order: Unit['order']): void {
  u.order = order;
  u.stuck = 0;
  u.groupSpeed = 0;
  u.path = [];
  u.pathIdx = 0;
  u.repathAt = 0;
}

function applyCommand(st: State, c: Command): void {
  const pl = st.players[c.player];
  if (!pl) return;
  switch (c.kind) {
    case 'move':
    case 'amove': {
      const us = ownedUnits(st, c.player, c.units);
      const x = clamp(Math.trunc(c.x), 0, st.map.w * SUB - 1);
      const y = clamp(Math.trunc(c.y), 0, st.map.h * SUB - 1);
      if (c.queued) {
        for (const u of us) enqueue(st, u, { kind: c.kind, x, y });
        return;
      }
      for (const u of us) {
        command(u, { kind: 'idle' });
        // Mover un camión desplegado lo repliega.
        u.deployState = 0;
      }
      if (us.length > 0) commandMove(st, us, x, y, c.kind);
      return;
    }
    case 'attack': {
      const t = st.byId.get(c.target) ?? st.buildingsById.get(c.target);
      if (!t || !hostile(st, t.owner, c.player) || t.hp <= 0) return;
      for (const u of ownedUnits(st, c.player, c.units)) command(u, { kind: 'attack', target: t.id, explicit: true });
      return;
    }
    case 'stop':
      for (const u of ownedUnits(st, c.player, c.units)) command(u, { kind: 'idle' });
      return;
    case 'gather': {
      if (!st.nodesById.has(c.target)) return;
      for (const u of ownedUnits(st, c.player, c.units)) {
        if (u.type !== 'worker') continue;
        if (c.queued) enqueue(st, u, { kind: 'gather', node: c.target });
        else command(u, { kind: 'gather', node: c.target });
      }
      return;
    }
    case 'build': {
      const s = BUILDINGS[c.building];
      const workers = ownedUnits(st, c.player, c.units).filter((u) => u.type === 'worker');
      if (!s || c.building === 'hq' || workers.length === 0 || pl.metal < s.cost || (BUILDING_GEN[c.building] ?? 1) > pl.gen) return;
      if (!canPlaceBuilding(st, c.building, Math.trunc(c.tx), Math.trunc(c.ty))) return;
      const b = addBuilding(st, c.player, c.building, Math.trunc(c.tx), Math.trunc(c.ty), false);
      if (!b) return;
      if (b.type === 'relay') b.maxHp = RELAY_HP[pl.gen];
      pl.metal -= s.cost;
      if (pl.instant) finish(st, b);
      else if (c.queued) for (const u of workers) enqueue(st, u, { kind: 'build', target: b.id });
      else for (const u of workers) command(u, { kind: 'build', target: b.id });
      return;
    }
    case 'construct': {
      const b = st.buildingsById.get(c.target);
      if (!b || b.owner !== c.player || b.complete) return;
      for (const u of ownedUnits(st, c.player, c.units)) {
        if (u.type !== 'worker') continue;
        if (c.queued) enqueue(st, u, { kind: 'build', target: b.id });
        else command(u, { kind: 'build', target: b.id });
      }
      return;
    }
    case 'train': {
      const b = st.buildingsById.get(c.building);
      if (!b || b.owner !== c.player || !b.complete || !BUILDINGS[b.type].trains.includes(c.unit)) return;
      const cost = UNITS[c.unit].cost;
      if (b.queue.length >= MAX_QUEUE || pl.metal < cost || UNIT_GEN[c.unit] > pl.gen) return;
      pl.metal -= cost;
      b.queue.push(c.unit);
      if (c.unit === 'colossus' || c.unit === 'siege') {
        st.events.push({ tick: st.tick, player: c.player, kind: 'colossus' });
        if (st.events.length > MAX_EVENTS) st.events.shift();
      }
      return;
    }
    case 'repair': {
      const b = st.buildingsById.get(c.target);
      if (!b || b.owner !== c.player || !b.complete || b.hp >= b.maxHp) return;
      for (const u of ownedUnits(st, c.player, c.units)) {
        if (u.type !== 'worker') continue;
        if (c.queued) enqueue(st, u, { kind: 'repair', target: b.id });
        else command(u, { kind: 'repair', target: b.id });
      }
      return;
    }
    case 'cancel': {
      const b = st.buildingsById.get(c.building);
      if (!b || b.owner !== c.player) return;
      const i = b.queue.lastIndexOf(c.unit);
      if (i < 0) return;
      b.queue.splice(i, 1);
      if (i === 0) b.trainTicks = 0;
      pl.metal += UNITS[c.unit].cost;
      return;
    }
    case 'grant':
      pl.metal += Math.trunc(c.amount);
      return;
    case 'toggleInstant':
      pl.instant = !pl.instant;
      return;
    case 'toggleNoPower':
      pl.noPower = !pl.noPower;
      return;
    case 'toggleRevealMap':
      pl.revealMap = !pl.revealMap;
      return;
    case 'toggleNoFog':
      pl.noFog = !pl.noFog;
      return;
    case 'togglePopCap':
      pl.popCap = pl.popCap === POP_CAP ? CHEAT_POP_CAP : POP_CAP;
      return;
    case 'research': {
      const b = st.buildingsById.get(c.building);
      const t = TECHS[c.tech];
      if (!b || !t || b.owner !== c.player || !b.complete || b.type !== t.building || b.research) return;
      if (t.gen > pl.gen || pl.techs.includes(c.tech) || pl.metal < t.cost) return;
      // Una misma investigación no puede estar en marcha en dos edificios a la vez.
      if (st.buildings.some((o) => o.owner === c.player && o.research?.tech === c.tech)) return;
      if (!t.requires.every((r) => st.buildings.some((o) => o.owner === c.player && o.type === r && o.complete))) return;
      pl.metal -= t.cost;
      b.research = { tech: c.tech, ticks: 0 };
      return;
    }
    case 'cancelResearch': {
      const b = st.buildingsById.get(c.building);
      if (!b || b.owner !== c.player || !b.research) return;
      pl.metal += TECHS[b.research.tech].cost;
      b.research = null;
      return;
    }
    case 'deploy':
      for (const u of ownedUnits(st, c.player, c.units)) {
        if (u.type !== 'truck') continue;
        if (c.on && u.deployState === 0) {
          command(u, { kind: 'idle' });
          u.deployState = 1;
          u.deployTicks = DEPLOY_TICKS;
        } else if (!c.on && u.deployState !== 0) {
          u.deployState = 0;
          st.fx.push({ kind: 'deployed', unit: u.id, owner: u.owner, x: u.x, y: u.y, on: false });
        }
      }
      return;
    case 'rally': {
      const b = st.buildingsById.get(c.building);
      if (!b || b.owner !== c.player) return;
      b.rallyX = clamp(Math.trunc(c.x), 0, st.map.w * SUB - 1);
      b.rallyY = clamp(Math.trunc(c.y), 0, st.map.h * SUB - 1);
      return;
    }
  }
}

function commandMove(st: State, us: Unit[], x: number, y: number, kind: 'move' | 'amove'): void {
  const m = st.map;
  x = clamp(x, 0, m.w * SUB - 1);
  y = clamp(y, 0, m.h * SUB - 1);
  const field = distanceField(m, tileOf(x), tileOf(y));
  let ordered: Unit[];
  let slots: number[];
  if (us.length > 1 && us.every((u) => u.type !== 'worker')) {
    ({ ordered, slots } = battleFormation(m, field, us, x, y));
  } else {
    const maxR = us.reduce((r, u) => Math.max(r, u.radius), 0);
    slots = formationSlots(m, field, x, y, us.length, Math.max(SUB / 2, 2 * maxR + 32));
    // Las unidades más cercanas al destino toman los puestos centrales.
    ordered = us.slice().sort((a, b) => {
      const da = (a.x - x) ** 2 + (a.y - y) ** 2;
      const db = (b.x - x) ** 2 + (b.y - y) ** 2;
      return da - db || a.id - b.id;
    });
  }
  const groupSpeed = us.length > 1 && us.every((u) => u.type !== 'worker') ? Math.min(...us.map((u) => u.speed)) : 0;
  ordered.forEach((u, i) => {
    const sx = slots[2 * i];
    const sy = slots[2 * i + 1];
    setOrder(u, { kind, x: sx, y: sy });
    u.groupSpeed = groupSpeed;
    if (lineWalkable(m, u.x, u.y, sx, sy)) {
      u.path = [sx, sy];
      return;
    }
    const tiles = descend(m, field, tileOf(u.x), tileOf(u.y)) ?? findPath(m, tileOf(u.x), tileOf(u.y), tileOf(sx), tileOf(sy));
    u.path = toWaypoints(m, u.x, u.y, tiles, sx, sy);
  });
}

/** Orden de las filas de una formación, del frente hacia atrás. */
const RANK: Record<Unit['type'], number> = { soldier: 0, mech: 1, artillery: 2, colossus: 3, siege: 4, truck: 5, worker: 6 };

/**
 * Formación de combate: filas perpendiculares a la dirección de marcha, con los soldados al frente,
 * los mechas detrás y los colosos al fondo. Devuelve las unidades en el orden de sus puestos.
 */
function battleFormation(m: GameMap, field: Int32Array, us: Unit[], x: number, y: number): { ordered: Unit[]; slots: number[] } {
  // Dirección de marcha (vector unitario ×1024) desde el centro del grupo hacia el destino.
  const cx = idiv(us.reduce((s, u) => s + u.x, 0), us.length);
  const cy = idiv(us.reduce((s, u) => s + u.y, 0), us.length);
  let dx = x - cx;
  let dy = y - cy;
  let d = isqrt(dx * dx + dy * dy);
  if (d < SUB) {
    dx = SUB;
    dy = 0;
    d = SUB;
  }
  const fx = idiv(dx * 1024, d);
  const fy = idiv(dy * 1024, d);
  // Perpendicular: el eje de las filas.
  const lx = -fy;
  const ly = fx;

  const blocks = new Map<Unit['type'], Unit[]>();
  for (const u of us.slice().sort((a, b) => RANK[a.type] - RANK[b.type] || a.id - b.id)) {
    const b = blocks.get(u.type) ?? [];
    b.push(u);
    blocks.set(u.type, b);
  }

  // Puestos relativos (lateral, profundidad) de cada bloque, del frente hacia atrás.
  const rel: { u: Unit; lat: number; dep: number }[] = [];
  let depth = 0;
  for (const block of blocks.values()) {
    const r = block[0].radius;
    // La infantería marcha abierta (unas 0,8 casillas entre soldados) para no caer en bloque ante el daño en área.
    const open = block[0].type === 'soldier' ? 200 : 0;
    const gapLat = Math.max(2 * r + 40, open);
    const gapDep = Math.max(2 * r + 56, open);
    const cols = Math.min(block.length, Math.max(3, Math.ceil(Math.sqrt(block.length * 3))));
    // Dentro del bloque, cada unidad va a la columna que le queda más a mano para no cruzarse.
    const side = block.slice().sort((a, b) => a.x * lx + a.y * ly - (b.x * lx + b.y * ly) || a.id - b.id);
    const rows = Math.ceil(block.length / cols);
    for (let row = 0; row < rows; row++) {
      const inRow = side.slice(row * cols, (row + 1) * cols);
      inRow.forEach((u, c) => rel.push({ u, lat: (c * 2 - (inRow.length - 1)) * idiv(gapLat, 2), dep: depth - row * gapDep }));
    }
    depth -= rows * gapDep;
  }
  // Centrar la formación en el destino.
  const mid = idiv(rel.reduce((s, p) => s + p.dep, 0), rel.length);

  const ordered: Unit[] = [];
  const slots: number[] = [];
  for (const p of rel) {
    const dep = p.dep - mid;
    let sx = x + idiv(p.lat * lx + dep * fx, 1024);
    let sy = y + idiv(p.lat * ly + dep * fy, 1024);
    if (sx < 0 || sy < 0 || !isWalkableSub(m, sx, sy) || field[tileOf(sy) * m.w + tileOf(sx)] >= INF) {
      // Puesto sobre un obstáculo: el hueco libre más cercano.
      const alt = formationSlots(m, field, clamp(sx, 0, m.w * SUB - 1), clamp(sy, 0, m.h * SUB - 1), 1, SUB / 2, 12);
      if (alt[0] === clamp(sx, 0, m.w * SUB - 1) && alt[1] === clamp(sy, 0, m.h * SUB - 1)) {
        // Nada libre cerca: ir al destino común y dejar que la separación reparta.
        alt[0] = x;
        alt[1] = y;
      }
      sx = alt[0];
      sy = alt[1];
    }
    ordered.push(p.u);
    slots.push(sx, sy);
  }
  return { ordered, slots };
}

/** Puestos de formación en una rejilla de paso `spacing`, en espiral alrededor del destino. */
function formationSlots(m: GameMap, field: Int32Array, x: number, y: number, n: number, spacing: number, maxRings = Infinity): number[] {
  const hx = Math.floor(x / spacing);
  const hy = Math.floor(y / spacing);
  const out: number[] = [];
  const maxR = Math.min(maxRings, Math.ceil((2 * m.w * SUB) / spacing));
  for (let r = 0; out.length < 2 * n && r < maxR; r++) {
    for (let dy = -r; dy <= r && out.length < 2 * n; dy++) {
      for (let dx = -r; dx <= r && out.length < 2 * n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const sx = (hx + dx) * spacing + idiv(spacing, 2);
        const sy = (hy + dy) * spacing + idiv(spacing, 2);
        if (sx < 0 || sy < 0 || !isWalkableSub(m, sx, sy)) continue;
        if (field[tileOf(sy) * m.w + tileOf(sx)] >= INF) continue;
        out.push(sx, sy);
      }
    }
  }
  while (out.length < 2 * n) out.push(x, y);
  return out;
}

// ---------------------------------------------------------------- producción

function produce(st: State, b: Building): void {
  if (b.research) return advanceResearch(st, b);
  if (b.queue.length === 0) return;
  const type = b.queue[0];
  const s = UNITS[type];
  if (st.players[b.owner].instant) b.trainTicks = s.trainTime;
  if (b.trainTicks < s.trainTime) {
    b.trainTicks++;
    return;
  }
  // Lista para salir: espera si no hay población disponible.
  if (popUsed(st, b.owner) + s.pop > st.players[b.owner].popCap) return;
  const spot = spawnSpot(st.map, b);
  if (!spot) return;
  b.queue.shift();
  b.trainTicks = 0;
  const u = addUnit(st, b.owner, spot.x, spot.y, type);
  refreshUnit(st, u);
  u.battery = batteryMax(st, b.owner);
  st.fx.push({ kind: 'trained', utype: type, owner: b.owner, x: u.x, y: u.y });
  if (b.rallyX < 0) return;
  const occ = st.map.occ[tileOf(b.rallyY) * st.map.w + tileOf(b.rallyX)];
  if (u.type === 'worker' && st.nodesById.has(occ)) setOrder(u, { kind: 'gather', node: occ });
  else commandMove(st, [u], b.rallyX, b.rallyY, 'move');
}

/** Avanza la investigación de un edificio; al terminar aplica la tecnología (o sube de generación). */
function advanceResearch(st: State, b: Building): void {
  const r = b.research!;
  const t = TECHS[r.tech];
  const pl = st.players[b.owner];
  r.ticks = pl.instant ? t.time : r.ticks + 1;
  if (r.ticks < t.time) return;
  b.research = null;
  pl.techs.push(r.tech);
  if (r.tech === 'gen2' || r.tech === 'gen3') {
    pl.gen = r.tech === 'gen2' ? 2 : 3;
    // Las antenas existentes ganan resistencia con la nueva generación (conservan la proporción de vida).
    for (const o of st.buildings) {
      if (o.owner !== b.owner || o.type !== 'relay') continue;
      o.hp = Math.max(1, Math.trunc((o.hp * RELAY_HP[pl.gen]) / o.maxHp));
      o.maxHp = RELAY_HP[pl.gen];
    }
    st.events.push({ tick: st.tick, player: b.owner, kind: 'generation', gen: pl.gen });
    if (st.events.length > MAX_EVENTS) st.events.shift();
  }
  // Las mejoras de unidades se aplican también a las que ya existen.
  for (const u of st.units) if (u.owner === b.owner) refreshUnit(st, u);
  const c = buildingCenter(b);
  st.fx.push({ kind: 'researched', owner: b.owner, x: c.x, y: c.y, tech: r.tech });
}

/** Primera casilla libre en anillos alrededor de la huella, empezando por el lado frontal (abajo). */
function spawnSpot(m: GameMap, b: Building): { x: number; y: number } | null {
  for (let r = 1; r <= 6; r++) {
    const x0 = b.tx - r;
    const y0 = b.ty - r;
    const x1 = b.tx + b.size - 1 + r;
    const y1 = b.ty + b.size - 1 + r;
    for (let ty = y1; ty >= y0; ty--) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tx !== x0 && tx !== x1 && ty !== y0 && ty !== y1) continue;
        if (isWalkable(m, tx, ty)) return { x: tx * SUB + SUB / 2, y: ty * SUB + SUB / 2 };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- comportamiento

function think(st: State, u: Unit, grid: Grid): void {
  if (u.cd > 0) u.cd--;
  escape(st.map, u);
  if (u.deployState === 1 && --u.deployTicks <= 0) {
    u.deployState = 2;
    st.fx.push({ kind: 'deployed', unit: u.id, owner: u.owner, x: u.x, y: u.y, on: true });
  }
  if (u.deployState !== 0) {
    // Camión desplegándose o desplegado: no se mueve (su orden pendiente espera).
    u.path = [];
    return;
  }
  const bmax = batteryMax(st, u.owner);
  if (leashed(st, u)) {
    // Batería: se recarga dentro de la red y se gasta fuera; a cero, la unidad se apaga.
    if (isPowered(st, u.owner, u.x, u.y)) u.battery = Math.min(bmax, u.battery + BATTERY_RECHARGE);
    else if (u.battery > 0) {
      if (u.battery >= bmax) st.fx.push({ kind: 'powerLost', unit: u.id, owner: u.owner, x: u.x, y: u.y });
      if (--u.battery === 0) st.fx.push({ kind: 'shutdown', unit: u.id, owner: u.owner, x: u.x, y: u.y });
    }
    if (u.battery <= 0) {
      u.path = [];
      return;
    }
  } else u.battery = bmax;
  // Orden terminada: pasar a la siguiente de la cola que siga teniendo sentido.
  while (u.order.kind === 'idle' && u.orderQueue.length > 0) applyQueued(st, u, u.orderQueue.shift()!);

  switch (u.order.kind) {
    case 'idle': {
      // Nunca se queda fuera de la red por gusto: si una orden la dejó fuera, vuelve sola.
      if (leashed(st, u) && (st.tick + u.id) % 10 === 0 && !isPowered(st, u.owner, u.x, u.y)) {
        const p = nearestPoweredTile(st, u.owner, u.x, u.y);
        if (p) {
          commandMove(st, [u], p.x, p.y, 'move');
          return;
        }
      }
      if (!u.autoAttack || (st.tick + u.id) % ACQUIRE_EVERY !== 0) return;
      const id = acquire(st, u, grid);
      if (id !== 0) setOrder(u, { kind: 'attack', target: id, explicit: false });
      return;
    }
    case 'amove':
      if (u.autoAttack && (st.tick + u.id) % ACQUIRE_EVERY === 0) {
        const id = acquire(st, u, grid);
        if (id !== 0) {
          u.resumeX = u.order.x;
          u.resumeY = u.order.y;
          setOrder(u, { kind: 'attack', target: id, explicit: false });
          return;
        }
      }
    // falls through
    case 'move': {
      if (followPath(st.map, u)) return setOrder(u, { kind: 'idle' });
      // Si otras unidades ocupan el destino y la devuelven con empujones, darse por llegada.
      const d = isqrt((u.order.x - u.x) ** 2 + (u.order.y - u.y) ** 2);
      if (u.stuck === 0 || d < u.bestDist - idiv(u.speed, 2)) {
        u.bestDist = d;
        u.stuck = 1;
      } else if (++u.stuck >= STUCK_TICKS) setOrder(u, { kind: 'idle' });
      return;
    }
    case 'gather':
      return gather(st, u, u.order.node);
    case 'build':
      return build(st, u, u.order.target);
    case 'repair':
      return repair(st, u, u.order.target);
    case 'attack':
      return attack(st, u, grid);
  }
}

/** Una unidad que quedó dentro de una huella (edificio recién colocado) sale a la casilla libre más cercana. */
function escape(m: GameMap, u: Unit): void {
  if (isWalkableSub(m, u.x, u.y)) return;
  const cx = tileOf(u.x);
  const cy = tileOf(u.y);
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !isWalkable(m, cx + dx, cy + dy)) continue;
        u.x = (cx + dx) * SUB + SUB / 2;
        u.y = (cy + dy) * SUB + SUB / 2;
        u.path = [];
        u.pathIdx = 0;
        return;
      }
    }
  }
}

function attack(st: State, u: Unit, grid: Grid): void {
  if (u.order.kind !== 'attack') return;
  let target = u.order.target;
  let t = aim(st, u, target);
  if (!t) {
    // Objetivo destruido: buscar otro enseguida para no quedarse parado en medio de la batalla.
    target = u.autoAttack ? acquire(st, u, grid) : 0;
    t = target === 0 ? null : aim(st, u, target);
    if (!t) return resumeOrIdle(st, u);
    setOrder(u, { kind: 'attack', target, explicit: false });
  }
  if (u.order.kind === 'attack' && !u.order.explicit && t.gap > u.sight + LEASH) return resumeOrIdle(st, u);
  if (u.minRange && t.gap < u.minRange) {
    // Demasiado cerca para la artillería: si el blanco lo eligió ella, busca otro; si fue una orden, espera.
    if (u.order.kind === 'attack' && !u.order.explicit) return resumeOrIdle(st, u);
    u.path = [];
    return;
  }
  if (t.gap <= u.range) {
    u.path = [];
    u.pathIdx = 0;
    if (u.cd === 0) {
      st.fx.push({ kind: 'shot', unit: u.id, utype: u.type, owner: u.owner, x: u.x, y: u.y, target: t.ent.id, tx: t.x, ty: t.y, onBuilding: !st.byId.has(t.ent.id), splash: u.splash });
      hit(st, u, t, grid);
      u.cd = u.cooldown;
    }
    return;
  }
  // Un pequeño margen para quedar dentro del alcance y no a una subunidad de él.
  const x = u.x;
  const y = u.y;
  approach(st, u, t.x, t.y, t.gap - u.range + 8);
  // Por voluntad propia no sale de la red: una persecución automática se detiene en el borde.
  if (u.order.kind === 'attack' && !u.order.explicit && leashed(st, u) && isPowered(st, u.owner, x, y) && !isPowered(st, u.owner, u.x, u.y)) {
    u.x = x;
    u.y = y;
    u.path = [];
    u.pathIdx = 0;
    resumeOrIdle(st, u);
  }
}

/** ¿La unidad depende de la red de energía? */
function leashed(st: State, u: Unit): boolean {
  return u.needsPower && !st.players[u.owner].noPower;
}

/**
 * Para las unidades que dependen de la red, un blanco elegido por su cuenta tiene que estar ya a
 * tiro o dentro de su cobertura: nunca persiguen a nadie fuera de ella.
 */
function reachable(st: State, u: Unit, x: number, y: number, gap: number): boolean {
  if (u.minRange && gap < u.minRange) return false;
  return !leashed(st, u) || gap <= u.range || isPowered(st, u.owner, x, y);
}

/** Tras un combate: retoma el ataque en movimiento pendiente, si lo hay. */
function resumeOrIdle(st: State, u: Unit): void {
  if (u.resumeX < 0) return setOrder(u, { kind: 'idle' });
  const x = u.resumeX;
  const y = u.resumeY;
  u.resumeX = -1;
  u.resumeY = -1;
  commandMove(st, [u], x, y, 'amove');
}

/** Aplica el daño de un ataque: directo, o en área a todas las unidades enemigas alrededor del impacto. */
function hit(st: State, u: Unit, t: Aim, grid: Grid): void {
  if (u.projectile) {
    // Cohete: sale lento y tarda más cuanto más lejos va; el daño llega al estallar.
    const dist = isqrt((t.x - u.x) ** 2 + (t.y - u.y) ** 2);
    const fl = u.flight ?? { base: 24, perTile: 3 };
    const p = { id: st.nextId++, owner: u.owner, x0: u.x, y0: u.y, x1: t.x, y1: t.y, dur: fl.base + idiv(dist * fl.perTile, SUB), t: 0, damage: u.damage, vsBuilding: u.vsBuilding, splash: u.splash, utype: u.type };
    st.projectiles.push(p);
    st.fx.push({ kind: 'launch', unit: u.id, utype: u.type, owner: u.owner, x: u.x, y: u.y, projectile: p.id });
    return;
  }
  const onBuilding = !st.byId.has(t.ent.id);
  if (u.splash === 0 || onBuilding) {
    t.ent.hp -= onBuilding ? u.vsBuilding : attackDamage(st, u, st.byId.get(t.ent.id) ?? null);
    if (u.splash === 0) return;
  }
  const { w, h } = st.map;
  const r = Math.ceil((u.splash + UNITS.colossus.radius) / SUB);
  const cx = tileOf(t.x);
  const cy = tileOf(t.y);
  for (let ty = Math.max(0, cy - r); ty <= Math.min(h - 1, cy + r); ty++) {
    for (let tx = Math.max(0, cx - r); tx <= Math.min(w - 1, cx + r); tx++) {
      for (let i = grid.head[ty * w + tx]; i !== -1; i = grid.next[i]) {
        const o = st.units[i];
        if (!hostile(st, o.owner, u.owner) || o.hp <= 0) continue;
        const reach = u.splash + o.radius;
        if ((o.x - t.x) ** 2 + (o.y - t.y) ** 2 <= reach * reach) o.hp -= u.damage;
      }
    }
  }
}

/** Avanza los cohetes en vuelo; al llegar, daño en área a unidades y edificios enemigos. */
function flyProjectiles(st: State, grid: Grid): void {
  if (st.projectiles.length === 0) return;
  const { w, h } = st.map;
  for (const p of st.projectiles) {
    if (++p.t < p.dur) continue;
    const r = Math.ceil((p.splash + UNITS.colossus.radius) / SUB);
    const cx = tileOf(p.x1);
    const cy = tileOf(p.y1);
    for (let ty = Math.max(0, cy - r); ty <= Math.min(h - 1, cy + r); ty++) {
      for (let tx = Math.max(0, cx - r); tx <= Math.min(w - 1, cx + r); tx++) {
        for (let i = grid.head[ty * w + tx]; i !== -1; i = grid.next[i]) {
          const o = st.units[i];
          if (!hostile(st, o.owner, p.owner) || o.hp <= 0) continue;
          const reach = p.splash + o.radius;
          if ((o.x - p.x1) ** 2 + (o.y - p.y1) ** 2 <= reach * reach) o.hp -= p.damage;
        }
      }
    }
    for (const b of st.buildings) {
      if (!hostile(st, b.owner, p.owner) || b.hp <= 0) continue;
      const x = clamp(p.x1, b.tx * SUB, (b.tx + b.size) * SUB);
      const y = clamp(p.y1, b.ty * SUB, (b.ty + b.size) * SUB);
      if ((x - p.x1) ** 2 + (y - p.y1) ** 2 <= p.splash * p.splash) b.hp -= p.vsBuilding;
    }
    st.fx.push({ kind: 'explosion', owner: p.owner, x: p.x1, y: p.y1, splash: p.splash, utype: p.utype });
  }
  st.projectiles = st.projectiles.filter((p) => p.t < p.dur);
}

function gather(st: State, u: Unit, nodeId: number): void {
  if (u.carry >= carryCap(st, u.owner, CARRY)) return deliver(st, u);
  let n = st.nodesById.get(nodeId);
  if (!n || n.amount <= 0) {
    n = nearestNode(st, u, 0) ?? undefined;
    if (!n) {
      if (u.carry > 0) deliver(st, u);
      else setOrder(u, { kind: 'idle' });
      return;
    }
    setOrder(u, { kind: 'gather', node: n.id });
  }
  if (!goWork(st, u, n.tx, n.ty, 1)) {
    // Yacimiento rodeado por otros: probar con el accesible más cercano.
    const alt = nearestNode(st, u, n.id);
    if (alt) setOrder(u, { kind: 'gather', node: alt.id });
    return;
  }
  if (!inReach(u, n.tx, n.ty, 1)) return;
  u.path = [];
  u.pathIdx = 0;
  if ((st.tick + u.id) % gatherTicks(st, u.owner, GATHER_TICKS) === 0) {
    n.amount--;
    u.carry++;
    st.fx.push({ kind: 'gather', unit: u.id, owner: u.owner, x: u.x, y: u.y, nx: n.tx * SUB + SUB / 2, ny: n.ty * SUB + SUB / 2 });
  }
}

/** Lleva la carga al punto de entrega propio más cercano; al entregar, el obrero sigue con su orden. */
function deliver(st: State, u: Unit): void {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of st.buildings) {
    if (b.owner !== u.owner || !b.complete || b.hp <= 0 || !BUILDINGS[b.type].dropoff) continue;
    const p = nearestPoint(b, u.x, u.y);
    const d = (p.x - u.x) ** 2 + (p.y - u.y) ** 2;
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  if (!best) {
    setOrder(u, { kind: 'idle' });
    return;
  }
  if (!goWork(st, u, best.tx, best.ty, best.size) || !inReach(u, best.tx, best.ty, best.size)) return;
  st.players[u.owner].metal += u.carry;
  st.fx.push({ kind: 'deliver', unit: u.id, owner: u.owner, amount: u.carry, x: u.x, y: u.y });
  u.carry = 0;
  u.path = [];
  u.pathIdx = 0;
}

/** Yacimiento con al menos una casilla libre al lado más cercano, sin contar `skip`. */
function nearestNode(st: State, u: Unit, skip: number): MetalNode | null {
  let best: MetalNode | null = null;
  let bestD = SEARCH_RADIUS * SEARCH_RADIUS + 1;
  for (const n of st.nodes) {
    if (n.amount <= 0 || n.id === skip || !workSpot(st.map, n.tx, n.ty, 1, u.x, u.y)) continue;
    const d = (n.tx * SUB + SUB / 2 - u.x) ** 2 + (n.ty * SUB + SUB / 2 - u.y) ** 2;
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

function build(st: State, u: Unit, id: number): void {
  let b = st.buildingsById.get(id);
  if ((!b || b.hp <= 0 || b.complete) && u.orderQueue.length > 0) {
    // Hay más encargos en cola: seguir con ellos en el próximo tick.
    setOrder(u, { kind: 'idle' });
    return;
  }
  if (b && b.complete && b.type === 'depot') {
    // Depósito terminado: ponerse a minar el yacimiento más cercano, como en AoE.
    const n = nearestNode(st, u, 0);
    if (n) return setOrder(u, { kind: 'gather', node: n.id });
  }
  if (!b || b.hp <= 0 || b.complete) {
    // Terminado o destruido: ayudar con otra construcción propia cercana, si la hay.
    b = st.buildings.find((o) => {
      if (o.owner !== u.owner || o.complete || o.hp <= 0) return false;
      const p = nearestPoint(o, u.x, u.y);
      return (p.x - u.x) ** 2 + (p.y - u.y) ** 2 <= SEARCH_RADIUS * SEARCH_RADIUS;
    });
    if (!b) {
      setOrder(u, { kind: 'idle' });
      return;
    }
    setOrder(u, { kind: 'build', target: b.id });
  }
  if (!goWork(st, u, b.tx, b.ty, b.size)) {
    setOrder(u, { kind: 'idle' });
    return;
  }
  if (!inReach(u, b.tx, b.ty, b.size)) return;
  u.path = [];
  u.pathIdx = 0;
  const bt = BUILDINGS[b.type].buildTime;
  b.hp = Math.min(b.maxHp, b.hp + idiv(b.maxHp * (b.progress + 1), bt) - idiv(b.maxHp * b.progress, bt));
  b.progress++;
  if (b.progress >= bt) finish(st, b, false);
}

/** Reparar: los obreros devuelven vida al edificio y se cobra metal según lo reparado. */
function repair(st: State, u: Unit, id: number): void {
  const b = st.buildingsById.get(id);
  if (!b || b.hp <= 0 || !b.complete || b.hp >= b.maxHp) return setOrder(u, { kind: 'idle' });
  if (!goWork(st, u, b.tx, b.ty, b.size)) return setOrder(u, { kind: 'idle' });
  if (!inReach(u, b.tx, b.ty, b.size)) return;
  u.path = [];
  u.pathIdx = 0;
  const pl = st.players[u.owner];
  if (b.repairAcc >= REPAIR_HP_PER_METAL) {
    if (pl.metal <= 0) return setOrder(u, { kind: 'idle' });
    pl.metal--;
    b.repairAcc -= REPAIR_HP_PER_METAL;
  }
  // Un obrero solo repara el edificio entero en unos 30 s, sea cual sea su tamaño.
  const gain = Math.min(b.maxHp - b.hp, Math.max(1, idiv(b.maxHp, 600)));
  b.hp += gain;
  b.repairAcc += gain;
  if ((st.tick + u.id) % 10 === 0) {
    const c = buildingCenter(b);
    st.fx.push({ kind: 'repair', unit: u.id, owner: u.owner, x: u.x, y: u.y, bx: c.x, by: c.y });
  }
}

/** Torre: dispara a la unidad enemiga más cercana dentro de su alcance, midiendo desde el borde de la huella. */
function towerThink(st: State, b: Building, grid: Grid): void {
  const atk = BUILDINGS[b.type].attack!;
  if (b.cd > 0) b.cd--;
  const inRange = (u: Unit) => {
    const p = nearestPoint(b, u.x, u.y);
    return isqrt((p.x - u.x) ** 2 + (p.y - u.y) ** 2) - u.radius <= atk.range;
  };
  let t = st.byId.get(b.aim);
  if (!t || t.hp <= 0 || !inRange(t)) {
    t = undefined;
    b.aim = 0;
    const { w, h } = st.map;
    const r = Math.ceil(atk.range / SUB) + b.size;
    const c = buildingCenter(b);
    const cx = tileOf(c.x);
    const cy = tileOf(c.y);
    let bestD = Infinity;
    for (let ty = Math.max(0, cy - r); ty <= Math.min(h - 1, cy + r); ty++) {
      for (let tx = Math.max(0, cx - r); tx <= Math.min(w - 1, cx + r); tx++) {
        for (let i = grid.head[ty * w + tx]; i !== -1; i = grid.next[i]) {
          const o = st.units[i];
          if (!hostile(st, o.owner, b.owner) || o.hp <= 0 || !inRange(o)) continue;
          const d = (o.x - c.x) ** 2 + (o.y - c.y) ** 2;
          if (d < bestD || (d === bestD && t && o.id < t.id)) {
            t = o;
            bestD = d;
          }
        }
      }
    }
    if (!t) return;
    b.aim = t.id;
  }
  if (b.cd > 0) return;
  t.hp -= towerDamage(st, b.owner, atk.damage);
  b.cd = atk.cooldown;
  const c = buildingCenter(b);
  st.fx.push({ kind: 'towerShot', owner: b.owner, x: c.x, y: c.y, target: t.id, tx: t.x, ty: t.y });
}

/** ¿La unidad está a distancia de trabajo de la huella? */
function inReach(u: Unit, tx: number, ty: number, size: number): boolean {
  const x = clamp(u.x, tx * SUB, (tx + size) * SUB);
  const y = clamp(u.y, ty * SUB, (ty + size) * SUB);
  return isqrt((x - u.x) ** 2 + (y - u.y) ** 2) - u.radius <= WORK_RANGE;
}

/** Centro de la casilla libre vecina a la huella más cercana a (x, y), o null si está rodeada. */
function workSpot(m: GameMap, tx: number, ty: number, size: number, x: number, y: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let sy = ty - 1; sy <= ty + size; sy++) {
    for (let sx = tx - 1; sx <= tx + size; sx++) {
      if (sx >= tx && sx < tx + size && sy >= ty && sy < ty + size) continue;
      if (!isWalkable(m, sx, sy)) continue;
      const cx = sx * SUB + SUB / 2;
      const cy = sy * SUB + SUB / 2;
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bestD) {
        best = { x: cx, y: cy };
        bestD = d;
      }
    }
  }
  return best;
}

/**
 * Lleva a un obrero hacia una casilla libre junto a la huella hasta que quede a distancia de trabajo.
 * Devuelve false si la huella no tiene ninguna casilla libre al lado.
 */
function goWork(st: State, u: Unit, tx: number, ty: number, size: number): boolean {
  if (inReach(u, tx, ty, size)) return true;
  const spot = workSpot(st.map, tx, ty, size, u.x, u.y);
  if (!spot) return false;
  approach(st, u, spot.x, spot.y, Infinity);
  return true;
}

interface Aim {
  ent: Unit | Building;
  /** Punto al que apuntar: el centro de una unidad o el borde más cercano de un edificio. */
  x: number;
  y: number;
  /** Distancia de borde a borde. */
  gap: number;
}

function aim(st: State, u: Unit, id: number): Aim | null {
  const t = st.byId.get(id);
  if (t) {
    if (t.hp <= 0) return null;
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    return { ent: t, x: t.x, y: t.y, gap: isqrt(dx * dx + dy * dy) - u.radius - t.radius };
  }
  const b = st.buildingsById.get(id);
  if (!b || b.hp <= 0) return null;
  const p = nearestPoint(b, u.x, u.y);
  const dx = p.x - u.x;
  const dy = p.y - u.y;
  return { ent: b, x: p.x, y: p.y, gap: isqrt(dx * dx + dy * dy) - u.radius };
}

/** Id del enemigo más cercano a la vista: primero unidades, si no hay, edificios. 0 si nada. */
function acquire(st: State, u: Unit, grid: Grid): number {
  // El asedio prefiere edificios; el resto, unidades.
  const unit = u.vsBuilding > u.damage ? null : nearestEnemyUnit(st, u, grid);
  if (unit) return unit.id;
  let best = 0;
  let bestGap = u.sight + 1;
  for (const b of st.buildings) {
    if (!hostile(st, b.owner, u.owner) || b.hp <= 0) continue;
    const p = nearestPoint(b, u.x, u.y);
    const gap = isqrt((p.x - u.x) ** 2 + (p.y - u.y) ** 2);
    if (gap < bestGap && reachable(st, u, p.x, p.y, gap - u.radius)) {
      best = b.id;
      bestGap = gap;
    }
  }
  if (best === 0 && u.vsBuilding > u.damage) return nearestEnemyUnit(st, u, grid)?.id ?? 0;
  return best;
}

/** Unidad enemiga viva más cercana dentro del rango de visión. Empates por id. */
function nearestEnemyUnit(st: State, u: Unit, grid: Grid): Unit | null {
  const { w, h } = st.map;
  const r = Math.ceil(u.sight / SUB);
  const cx = tileOf(u.x);
  const cy = tileOf(u.y);
  let best: Unit | null = null;
  let bestD = u.sight * u.sight + 1;
  for (let ty = Math.max(0, cy - r); ty <= Math.min(h - 1, cy + r); ty++) {
    for (let tx = Math.max(0, cx - r); tx <= Math.min(w - 1, cx + r); tx++) {
      for (let i = grid.head[ty * w + tx]; i !== -1; i = grid.next[i]) {
        const o = st.units[i];
        if (!hostile(st, o.owner, u.owner) || o.hp <= 0) continue;
        const d = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
        if (d >= bestD && !(d === bestD && best && o.id < best.id)) continue;
        if (!reachable(st, u, o.x, o.y, isqrt(d) - u.radius - o.radius)) continue;
        {
          best = o;
          bestD = d;
        }
      }
    }
  }
  return best;
}

/** Acercarse a un punto: en línea recta si se ve, si no con A* recalculado cada pocos ticks. */
function approach(st: State, u: Unit, x: number, y: number, maxDist: number): void {
  if (lineWalkable(st.map, u.x, u.y, x, y)) {
    u.path = [x, y];
    u.pathIdx = 0;
  } else if (st.tick >= u.repathAt || u.pathIdx >= u.path.length) {
    const tiles = findPath(st.map, tileOf(u.x), tileOf(u.y), tileOf(x), tileOf(y));
    u.path = toWaypoints(st.map, u.x, u.y, tiles, x, y);
    u.pathIdx = 0;
    u.repathAt = st.tick + REPATH_TICKS;
  }
  followPath(st.map, u, maxDist);
}

/** Avanza por los waypoints. Devuelve true al llegar al final. */
function followPath(m: GameMap, u: Unit, maxDist = Infinity): boolean {
  let budget = Math.min(u.groupSpeed > 0 ? Math.min(u.groupSpeed, u.speed) : u.speed, maxDist);
  while (budget > 0 && u.pathIdx < u.path.length) {
    const wx = u.path[u.pathIdx];
    const wy = u.path[u.pathIdx + 1];
    const dx = wx - u.x;
    const dy = wy - u.y;
    const d = isqrt(dx * dx + dy * dy);
    if (d <= budget) {
      tryMove(m, u, wx, wy);
      budget -= d;
      u.pathIdx += 2;
    } else {
      let sx = idiv(dx * budget, d);
      let sy = idiv(dy * budget, d);
      // Nunca un paso nulo por redondeo: la unidad quedaría clavada.
      if (sx === 0 && sy === 0) {
        if (Math.abs(dx) >= Math.abs(dy)) sx = Math.sign(dx);
        else sy = Math.sign(dy);
      }
      tryMove(m, u, u.x + sx, u.y + sy);
      budget = 0;
    }
  }
  return u.pathIdx >= u.path.length;
}

/** Mueve si el destino es transitable; si no, intenta deslizarse por un eje. */
function tryMove(m: GameMap, u: Unit, nx: number, ny: number): void {
  if (isWalkableSub(m, nx, ny)) {
    u.x = nx;
    u.y = ny;
  } else if (isWalkableSub(m, nx, u.y)) {
    u.x = nx;
  } else if (isWalkableSub(m, u.x, ny)) {
    u.y = ny;
  }
}

/** Empuja a las unidades que se superponen para que no se amontonen en un punto. */
function separate(st: State): void {
  const grid = buildGrid(st);
  const { w, h } = st.map;
  const us = st.units;
  for (let i = 0; i < us.length; i++) {
    const a = us[i];
    if (a.hp <= 0) continue;
    const cx = tileOf(a.x);
    const cy = tileOf(a.y);
    for (let ty = Math.max(0, cy - NEAR); ty <= Math.min(h - 1, cy + NEAR); ty++) {
      for (let tx = Math.max(0, cx - NEAR); tx <= Math.min(w - 1, cx + NEAR); tx++) {
        for (let j = grid.head[ty * w + tx]; j !== -1; j = grid.next[j]) {
          if (j <= i) continue;
          const b = us[j];
          if (b.hp <= 0) continue;
          const min = a.radius + b.radius;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = isqrt(d2);
          if (d === 0) {
            const k = (a.id * 7 + b.id) % 8;
            dx = PUSH_DX[k];
            dy = PUSH_DY[k];
            d = 1;
          }
          // Cada una cede en proporción al tamaño de la otra: las grandes apenas se mueven.
          const push = idiv(min - d, 2) || 1;
          const pa = idiv(push * b.radius, min);
          const pb = push - pa;
          tryMove(st.map, a, a.x - idiv(dx * pa, d), a.y - idiv(dy * pa, d));
          tryMove(st.map, b, b.x + idiv(dx * pb, d), b.y + idiv(dy * pb, d));
        }
      }
    }
  }
}
