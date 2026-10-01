import type { BuildingType } from './building';
import { SUB } from './constants';

export type UnitType = 'worker' | 'soldier' | 'mech' | 'artillery' | 'truck' | 'colossus' | 'siege';

export type Order =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; y: number }
  /** Ataque en movimiento: avanza hacia el destino y pelea con lo que encuentre por el camino. */
  | { kind: 'amove'; x: number; y: number }
  | { kind: 'attack'; target: number; explicit: boolean }
  | { kind: 'gather'; node: number }
  | { kind: 'build'; target: number }
  /** Ir a colocar unos cimientos: se ponen (y se cobran) al llegar, si el sitio sigue libre. */
  | { kind: 'place'; building: BuildingType; tx: number; ty: number }
  | { kind: 'repair'; target: number };

/** Orden en espera (Shift): se ejecuta cuando la actual termina. */
export type QueuedOrder =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'amove'; x: number; y: number }
  | { kind: 'gather'; node: number }
  | { kind: 'build'; target: number }
  | { kind: 'place'; building: BuildingType; tx: number; ty: number }
  | { kind: 'repair'; target: number };

export interface UnitStats {
  maxHp: number;
  /** Subunidades por tick. */
  speed: number;
  radius: number;
  damage: number;
  /** Radio de daño en área alrededor del impacto (0 = sin área). */
  splash: number;
  /** Alcance de borde a borde, en subunidades. */
  range: number;
  sight: number;
  /** Ticks entre ataques. */
  cooldown: number;
  cost: number;
  pop: number;
  /** Ticks de producción. */
  trainTime: number;
  /** Si ataca sola a enemigos a la vista cuando está ociosa. */
  autoAttack: boolean;
  /** Daño contra edificios (para casi todas, igual que `damage`). */
  vsBuilding: number;
  /** Dispara un proyectil que tarda en llegar: el daño se aplica al impactar, en el punto apuntado. */
  projectile: boolean;
  /** Necesita estar dentro de la red de energía (fuera gasta batería y luego se apaga). */
  needsPower: boolean;
  /** Proyectiles: ticks de vuelo base y por casilla de distancia. */
  flight?: { base: number; perTile: number };
  /** Alcance mínimo (artillería): no puede disparar a lo que tiene más cerca. */
  minRange?: number;
}

/** Ticks de batería fuera de la red antes de apagarse (12 s). */
export const BATTERY_TICKS = 240;
/** Batería recuperada por tick dentro de la red. */
export const BATTERY_RECHARGE = 4;

export const UNITS: Record<UnitType, UnitStats> = {
  worker: { maxHp: 40, speed: 12, radius: 40, damage: 3, splash: 0, range: 20, sight: 5 * SUB, cooldown: 30, cost: 50, pop: 1, trainTime: 240, autoAttack: false, vsBuilding: 3, projectile: false, needsPower: false },
  soldier: { maxHp: 80, speed: 13, radius: 56, damage: 8, splash: 0, range: 5 * SUB, sight: 7 * SUB, cooldown: 25, cost: 60, pop: 1, trainTime: 200, autoAttack: true, vsBuilding: 5, projectile: false, needsPower: false },
  mech: { maxHp: 450, speed: 11, radius: 110, damage: 30, splash: 110, range: 6 * SUB, sight: 9 * SUB, cooldown: 40, cost: 400, pop: 5, trainTime: 600, autoAttack: true, vsBuilding: 30, projectile: false, needsPower: true },
  // Camión repetidor (Gen-2): desarmado; desplegado funciona como una antena móvil.
  truck: { maxHp: 400, speed: 10, radius: 90, damage: 0, splash: 0, range: 0, sight: 7 * SUB, cooldown: 30, cost: 150, pop: 3, trainTime: 400, autoAttack: false, vsBuilding: 0, projectile: false, needsPower: false },
  // Los colosos (Gen-3) llevan reactor propio: no necesitan la red, pero estallan al morir.
  colossus: { maxHp: 4500, speed: 7, radius: 220, damage: 120, splash: 220, range: 8 * SUB, sight: 11 * SUB, cooldown: 50, cost: 3000, pop: 25, trainTime: 2400, autoAttack: true, vsBuilding: 120, projectile: false, needsPower: false },
  // Coloso de asedio: frágil para su tamaño, alcance enorme y cohetes que arrasan edificios.
  // Mecha de artillería: frágil, lento al disparar, alcance enorme; castiga tropas, apenas edificios.
  artillery: { maxHp: 300, speed: 10, radius: 100, damage: 35, splash: 160, range: 16 * SUB, sight: 17 * SUB, cooldown: 80, cost: 450, pop: 5, trainTime: 700, autoAttack: true, vsBuilding: 15, projectile: true, needsPower: true, flight: { base: 12, perTile: 2 }, minRange: 4 * SUB },
  siege: { maxHp: 1600, speed: 6, radius: 190, damage: 60, splash: 320, range: 14 * SUB, sight: 15 * SUB, cooldown: 110, cost: 2500, pop: 20, trainTime: 1800, autoAttack: true, vsBuilding: 700, projectile: true, needsPower: false, flight: { base: 24, perTile: 3 } },
};

export interface Unit extends UnitStats {
  readonly id: number;
  readonly owner: number;
  readonly type: UnitType;
  x: number;
  y: number;
  hp: number;
  /** Ticks que faltan para poder atacar otra vez. */
  cd: number;
  order: Order;
  /** Waypoints planos [x0, y0, x1, y1, ...] en subunidades. */
  path: number[];
  pathIdx: number;
  repathAt: number;
  /** Metal que lleva encima (obreros). */
  carry: number;
  /** Ticks seguidos sin acercarse al destino mientras se mueve. */
  stuck: number;
  /** Menor distancia al destino alcanzada en la orden de movimiento actual. */
  bestDist: number;
  /** Ticks de batería que le quedan (solo unidades que necesitan red). 0 = apagada. */
  battery: number;
  /** Camión repetidor: 0 = en marcha, 1 = desplegándose, 2 = desplegado (funciona como antena). */
  deployState: number;
  deployTicks: number;
  /** Camión desplegado: si recibe energía de la red este tick (derivado, fuera del hash). */
  nodePowered: boolean;
  /** Órdenes encadenadas con Shift, en orden. */
  orderQueue: QueuedOrder[];
  /** Velocidad de marcha del grupo (la de su unidad más lenta) mientras va en formación; 0 = la suya. */
  groupSpeed: number;
  /** Destino de un ataque en movimiento interrumpido por un combate (-1 = ninguno). */
  resumeX: number;
  resumeY: number;
}

export function makeUnit(id: number, owner: number, type: UnitType, x: number, y: number): Unit {
  const stats = UNITS[type];
  return { ...stats, id, owner, type, x, y, hp: stats.maxHp, cd: 0, order: { kind: 'idle' }, path: [], pathIdx: 0, repathAt: 0, carry: 0, stuck: 0, bestDist: 0, battery: BATTERY_TICKS, deployState: 0, deployTicks: 0, nodePowered: false, orderQueue: [], groupSpeed: 0, resumeX: -1, resumeY: -1 };
}
