import type { BuildingType } from './building';
import { SUB } from './constants';
import type { State } from './state';
import { BATTERY_TICKS, UNITS, type Unit, type UnitType } from './unit';

/**
 * Generaciones y tecnologías. Cada generación rompe una regla de la energía:
 * Gen-1 Prototipos (todo depende de la red), Gen-2 Producción en serie (camión repetidor: la red se
 * mueve), Gen-3 Reactor de núcleo (los colosos llevan reactor propio y estallan al morir).
 */
export type Generation = 1 | 2 | 3;

export type TechId = 'gen2' | 'gen3' | 'pneumatic' | 'carts' | 'antimech' | 'composite' | 'lithium' | 'piercing' | 'amplifiers' | 'rangefinder';

export interface TechDef {
  /** Edificio donde se investiga. */
  building: BuildingType;
  /** Generación mínima para investigarla. */
  gen: Generation;
  cost: number;
  /** Ticks de investigación. */
  time: number;
  /** Edificios propios terminados que hacen falta. */
  requires: BuildingType[];
}

export const TECHS: Record<TechId, TechDef> = {
  gen2: { building: 'hq', gen: 1, cost: 800, time: 900, requires: ['barracks', 'hangar'] },
  gen3: { building: 'hq', gen: 2, cost: 2000, time: 1200, requires: ['plant'] },
  pneumatic: { building: 'hq', gen: 1, cost: 150, time: 600, requires: [] },
  carts: { building: 'hq', gen: 2, cost: 200, time: 600, requires: [] },
  antimech: { building: 'barracks', gen: 2, cost: 300, time: 800, requires: [] },
  composite: { building: 'hangar', gen: 2, cost: 400, time: 900, requires: [] },
  lithium: { building: 'hangar', gen: 2, cost: 300, time: 800, requires: [] },
  piercing: { building: 'tower', gen: 2, cost: 250, time: 700, requires: [] },
  amplifiers: { building: 'plant', gen: 2, cost: 300, time: 800, requires: [] },
  rangefinder: { building: 'hangar', gen: 3, cost: 350, time: 900, requires: [] },
};

/** Orden de las investigaciones en cada edificio (el de sus teclas en el panel). */
export const TECH_ORDER: TechId[] = ['gen2', 'gen3', 'pneumatic', 'carts', 'antimech', 'composite', 'lithium', 'rangefinder', 'piercing', 'amplifiers'];

/** Generación a partir de la cual se puede producir cada unidad. */
export const UNIT_GEN: Record<UnitType, Generation> = { worker: 1, soldier: 1, mech: 1, artillery: 2, truck: 2, colossus: 3, siege: 3 };
/** Generación a partir de la cual se puede construir cada edificio. */
export const BUILDING_GEN: Partial<Record<BuildingType, Generation>> = { cradle: 3 };

export function hasTech(st: State, player: number, t: TechId): boolean {
  return st.players[player].techs.includes(t);
}

// ---------------------------------------------------------------- efectos de las tecnologías

/** Ticks por unidad de metal extraída (Picos neumáticos: un 25 % más rápido). */
export function gatherTicks(st: State, player: number, base: number): number {
  return hasTech(st, player, 'pneumatic') ? Math.trunc((base * 4) / 5) : base;
}

/** Metal que carga un obrero (Carretillas: 15 en vez de 10). */
export function carryCap(st: State, player: number, base: number): number {
  return hasTech(st, player, 'carts') ? base + 5 : base;
}

/** Batería fuera de la red (Baterías de litio: 20 s en vez de 12). */
export function batteryMax(st: State, player: number): number {
  return hasTech(st, player, 'lithium') ? 400 : BATTERY_TICKS;
}

/** Radio de cobertura de un nodo de la red (Amplificadores: antenas y camiones de 6 a 8). */
export function coverOf(st: State, player: number, base: number, isRelay: boolean): number {
  return isRelay && hasTech(st, player, 'amplifiers') ? base + 2 : base;
}

/** Daño de una torre (Munición perforante: +50 %). */
export function towerDamage(st: State, player: number, base: number): number {
  return hasTech(st, player, 'piercing') ? base + (base >> 1) : base;
}

/** Daño de un ataque según el blanco (Lanzacohetes antimecha: soldados +150 % contra máquinas grandes). */
export function attackDamage(st: State, u: Unit, target: Unit | null): number {
  if (u.type === 'soldier' && target && target.type !== 'soldier' && target.type !== 'worker' && hasTech(st, u.owner, 'antimech')) return Math.trunc((u.damage * 5) / 2);
  return u.damage;
}

/**
 * Ajusta las estadísticas de una unidad a las tecnologías de su dueño: al salir de fábrica y cuando se
 * termina una investigación (conserva la proporción de vida).
 */
export function refreshUnit(st: State, u: Unit): void {
  const base = UNITS[u.type];
  const tough = (u.type === 'mech' || u.type === 'artillery') && hasTech(st, u.owner, 'composite');
  const maxHp = tough ? base.maxHp + (base.maxHp >> 2) : base.maxHp;
  if (maxHp !== u.maxHp) {
    u.hp = Math.max(1, Math.trunc((u.hp * maxHp) / u.maxHp));
    u.maxHp = maxHp;
  }
  const far = u.type === 'artillery' && hasTech(st, u.owner, 'rangefinder');
  u.range = base.range + (far ? 2 * SUB : 0);
  u.sight = base.sight + (far ? 2 * SUB : 0);
}
