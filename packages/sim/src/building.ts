import { SUB } from './constants';
import { isWalkable, type GameMap } from './map';
import type { TechId } from './tech';
import type { UnitType } from './unit';

export type BuildingType = 'hq' | 'depot' | 'barracks' | 'hangar' | 'cradle' | 'tower' | 'plant' | 'relay';

export interface BuildingStats {
  /** Lado en casillas (los edificios son cuadrados). */
  size: number;
  maxHp: number;
  cost: number;
  /** Ticks de construcción con un solo obrero. */
  buildTime: number;
  /** Unidades que produce, en el orden de sus teclas (Q, W, …). */
  trains: UnitType[];
  /** Si los obreros pueden entregar metal aquí. */
  dropoff: boolean;
  /** Ataque propio (torres): daño, alcance desde el borde de la huella y ticks entre disparos. */
  attack?: { damage: number; range: number; cooldown: number };
  /**
   * Red de energía (centrales y antenas): radio de cobertura y alcance de enlace con otros nodos,
   * en casillas, medidos desde el centro.
   */
  power?: { cover: number; link: number; source: boolean };
}

export const BUILDINGS: Record<BuildingType, BuildingStats> = {
  // El cuartel general es la primera fuente de energía de la base, con más alcance que cualquier nodo.
  hq: { size: 4, maxHp: 2400, cost: 0, buildTime: 0, trains: ['worker'], dropoff: true, power: { cover: 18, link: 18, source: true } },
  depot: { size: 2, maxHp: 600, cost: 100, buildTime: 500, trains: [], dropoff: true },
  barracks: { size: 3, maxHp: 1200, cost: 150, buildTime: 600, trains: ['soldier'], dropoff: false },
  hangar: { size: 4, maxHp: 2000, cost: 300, buildTime: 900, trains: ['mech', 'artillery', 'truck'], dropoff: false },
  cradle: { size: 5, maxHp: 3000, cost: 1000, buildTime: 1200, trains: ['colossus', 'siege'], dropoff: false },
  tower: { size: 2, maxHp: 900, cost: 150, buildTime: 400, trains: [], dropoff: false, attack: { damage: 14, range: 7 * SUB, cooldown: 30 } },
  // Central: solo sobre una veta. Cubre tanto como el cuartel general y resiste mucho: tomar vetas importa.
  plant: { size: 3, maxHp: 4000, cost: 400, buildTime: 700, trains: [], dropoff: false, power: { cover: 18, link: 18, source: true } },
  // Antena repetidora: barata y frágil; extiende la red si enlaza con otro nodo con energía.
  relay: { size: 1, maxHp: 250, cost: 60, buildTime: 200, trains: [], dropoff: false, power: { cover: 6, link: 8, source: false } },
};

export const MAX_QUEUE = 10;

export interface Building {
  readonly id: number;
  readonly owner: number;
  readonly type: BuildingType;
  /** Casilla superior izquierda de la huella. */
  readonly tx: number;
  readonly ty: number;
  readonly size: number;
  hp: number;
  maxHp: number;
  complete: boolean;
  /** Ticks de obrero acumulados en la construcción. */
  progress: number;
  queue: UnitType[];
  /** Ticks acumulados de la unidad en cabeza de la cola. */
  trainTicks: number;
  /** Punto de reunión en subunidades (-1 = ninguno). */
  rallyX: number;
  rallyY: number;
  /** Ticks hasta el próximo disparo (torres). */
  cd: number;
  /** Unidad a la que apunta (torres; 0 = ninguna). */
  aim: number;
  /** Vida reparada aún sin cobrar (se cobra 1 de metal cada REPAIR_HP_PER_METAL). */
  repairAcc: number;
  /** Nodos de la red: si recibe energía este tick (derivado, no forma parte del hash). */
  powered: boolean;
  /** Investigación en curso (ocupa el edificio: mientras dura, no produce unidades). */
  research: { tech: TechId; ticks: number } | null;
}

/** Vida que se repara por cada unidad de metal. */
export const REPAIR_HP_PER_METAL = 20;

export function canPlace(m: GameMap, tx: number, ty: number, size: number): boolean {
  for (let y = ty; y < ty + size; y++) for (let x = tx; x < tx + size; x++) if (!isWalkable(m, x, y)) return false;
  return true;
}

/** Marca (o libera, con id 0) las casillas de una huella cuadrada. */
export function occupyRect(m: GameMap, tx: number, ty: number, size: number, id: number): void {
  for (let y = ty; y < ty + size; y++) for (let x = tx; x < tx + size; x++) m.occ[y * m.w + x] = id;
}

/**
 * Punto de una huella cuadrada más cercano a (x, y), desplazado un subpaso hacia afuera en los
 * bordes izquierdo y superior para que caiga en una casilla libre. Sirve para medir alcance y perseguir.
 */
export function nearestPointRect(tx: number, ty: number, size: number, x: number, y: number): { x: number; y: number } {
  const x0 = tx * SUB;
  const y0 = ty * SUB;
  const x1 = (tx + size) * SUB;
  const y1 = (ty + size) * SUB;
  return { x: x < x0 ? x0 - 1 : x > x1 ? x1 : x, y: y < y0 ? y0 - 1 : y > y1 ? y1 : y };
}

export function nearestPoint(b: Building, x: number, y: number): { x: number; y: number } {
  return nearestPointRect(b.tx, b.ty, b.size, x, y);
}

export function buildingCenter(b: Building): { x: number; y: number } {
  const c = (b.size * SUB) / 2;
  return { x: b.tx * SUB + c, y: b.ty * SUB + c };
}
