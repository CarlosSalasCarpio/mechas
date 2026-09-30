import { BUILDINGS, canPlace, occupyRect, type Building, type BuildingType } from './building';
import type { GameMap } from './map';
import type { MetalNode } from './resource';
import type { Rng } from './rng';
import { makeUnit, type Unit, type UnitType } from './unit';
import type { BuildingType as BT } from './building';
import type { Generation, TechId } from './tech';

/**
 * Efectos del último tick, para animaciones y sonido. Se vacían al empezar cada tick y no forman
 * parte del hash: son una consecuencia del estado, no estado.
 */
export type Fx =
  | { kind: 'shot'; unit: number; utype: UnitType; owner: number; x: number; y: number; target: number; tx: number; ty: number; onBuilding: boolean; splash: number }
  | { kind: 'death'; utype: UnitType; owner: number; x: number; y: number }
  | { kind: 'destroyed'; btype: BT; owner: number; x: number; y: number }
  | { kind: 'built'; btype: BT; owner: number; x: number; y: number }
  | { kind: 'trained'; utype: UnitType; owner: number; x: number; y: number }
  | { kind: 'launch'; unit: number; utype: UnitType; owner: number; x: number; y: number; projectile: number }
  | { kind: 'explosion'; owner: number; x: number; y: number; splash: number; utype: UnitType }
  | { kind: 'towerShot'; owner: number; x: number; y: number; target: number; tx: number; ty: number }
  | { kind: 'reactor'; owner: number; x: number; y: number; radius: number }
  | { kind: 'researched'; owner: number; x: number; y: number; tech: TechId }
  | { kind: 'deployed'; unit: number; owner: number; x: number; y: number; on: boolean }
  | { kind: 'powerLost'; unit: number; owner: number; x: number; y: number }
  | { kind: 'shutdown'; unit: number; owner: number; x: number; y: number }
  | { kind: 'repair'; unit: number; owner: number; x: number; y: number; bx: number; by: number }
  | { kind: 'gather'; unit: number; owner: number; x: number; y: number; nx: number; ny: number }
  | { kind: 'deliver'; unit: number; owner: number; amount: number; x: number; y: number };

export const POP_CAP = 200;
/** Tope de población con el truco de desarrollo. */
export const CHEAT_POP_CAP = 1000;

export interface PlayerState {
  metal: number;
  /** Truco de desarrollo: construcción y producción instantáneas. */
  instant: boolean;
  /** Tope de población (200; 1000 con el truco). */
  popCap: number;
  /** Truco de desarrollo: sus unidades no necesitan red de energía. */
  noPower: boolean;
  /** Generación actual (1 Prototipos, 2 Producción en serie, 3 Reactor de núcleo). */
  gen: Generation;
  /** Tecnologías investigadas, en el orden en que se terminaron. */
  techs: TechId[];
  /** Trucos de niebla (como en AoE2): `marco` revela el mapa, `polo` quita la niebla. */
  revealMap: boolean;
  noFog: boolean;
}

/** Algo que el cliente debe anunciar (no forma parte del hash). */
export type GameEvent = { tick: number; player: number; kind: 'colossus' } | { tick: number; player: number; kind: 'generation'; gen: Generation };

/** Cohete en vuelo. Sale de (x0,y0) hacia el punto (x1,y1) y estalla al cumplir `dur` ticks. */
export interface Projectile {
  readonly id: number;
  readonly owner: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly dur: number;
  t: number;
  readonly damage: number;
  readonly vsBuilding: number;
  readonly splash: number;
  /** Quién lo disparó (para dibujarlo: cohete de asedio u obús de artillería). */
  readonly utype: UnitType;
}

export interface State {
  tick: number;
  rng: Rng;
  map: GameMap;
  players: PlayerState[];
  /** Unidades, edificios y yacimientos comparten el espacio de ids y se guardan en orden de id. */
  units: Unit[];
  byId: Map<number, Unit>;
  buildings: Building[];
  buildingsById: Map<number, Building>;
  nodes: MetalNode[];
  nodesById: Map<number, MetalNode>;
  events: GameEvent[];
  fx: Fx[];
  projectiles: Projectile[];
  /** Jugador ganador, o -1 mientras la partida sigue. */
  winner: number;
  /** Vetas de energía: casilla central donde puede ir una central (fijas, no se agotan). */
  vents: { tx: number; ty: number }[];
  /**
   * Cobertura de la red por casilla: bit p = el jugador p tiene energía ahí. Se recalcula cada tick
   * a partir de los edificios, así que no forma parte del hash.
   */
  power: Uint8Array;
  /** Cambia cada vez que cambia la cobertura (para que el render solo redibuje entonces). */
  powerVersion: number;
  /** Niebla de guerra por casilla: bit p = el jugador p la ve ahora / la ha explorado alguna vez. */
  vision: Uint8Array;
  explored: Uint8Array;
  visionVersion: number;
  nextId: number;
}

export function addUnit(st: State, owner: number, x: number, y: number, type: UnitType = 'soldier'): Unit {
  const u = makeUnit(st.nextId++, owner, type, x, y);
  st.units.push(u);
  st.byId.set(u.id, u);
  return u;
}

/** Coloca un edificio si la huella está libre. Devuelve null si no cabe. */
export function addBuilding(st: State, owner: number, type: BuildingType, tx: number, ty: number, complete = true): Building | null {
  const s = BUILDINGS[type];
  if (!canPlace(st.map, tx, ty, s.size)) return null;
  const b: Building = {
    id: st.nextId++,
    owner,
    type,
    tx,
    ty,
    size: s.size,
    hp: complete ? s.maxHp : 1,
    maxHp: s.maxHp,
    complete,
    progress: complete ? s.buildTime : 0,
    queue: [],
    trainTicks: 0,
    rallyX: -1,
    rallyY: -1,
    cd: 0,
    aim: 0,
    repairAcc: 0,
    powered: false,
    research: null,
  };
  occupyRect(st.map, tx, ty, s.size, b.id);
  st.buildings.push(b);
  st.buildingsById.set(b.id, b);
  return b;
}

export function addNode(st: State, tx: number, ty: number, amount: number): MetalNode | null {
  if (!canPlace(st.map, tx, ty, 1)) return null;
  const n: MetalNode = { id: st.nextId++, tx, ty, amount };
  occupyRect(st.map, tx, ty, 1, n.id);
  st.nodes.push(n);
  st.nodesById.set(n.id, n);
  return n;
}

export function popUsed(st: State, player: number): number {
  let p = 0;
  for (const u of st.units) if (u.owner === player && u.hp > 0) p += u.pop;
  return p;
}

export type EntityRef =
  | { kind: 'building'; ent: import('./building').Building }
  | { kind: 'node'; ent: MetalNode };

/** Edificio o yacimiento que ocupa una casilla, si lo hay. */
export function entityAtTile(st: State, tx: number, ty: number): EntityRef | null {
  if (tx < 0 || ty < 0 || tx >= st.map.w || ty >= st.map.h) return null;
  const id = st.map.occ[ty * st.map.w + tx];
  if (id === 0) return null;
  const b = st.buildingsById.get(id);
  if (b) return { kind: 'building', ent: b };
  const n = st.nodesById.get(id);
  return n ? { kind: 'node', ent: n } : null;
}
