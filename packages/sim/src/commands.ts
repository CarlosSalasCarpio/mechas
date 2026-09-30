import type { BuildingType } from './building';
import type { TechId } from './tech';
import type { UnitType } from './unit';

/** Toda entrada de un jugador a la simulación. Las coordenadas van en subunidades enteras. */
export type Command =
  /** `queued` (Shift): la orden se añade al final de la cola de cada unidad en vez de reemplazar la actual. */
  | { tick: number; player: number; kind: 'move'; units: number[]; x: number; y: number; queued?: boolean }
  | { tick: number; player: number; kind: 'attack'; units: number[]; target: number }
  | { tick: number; player: number; kind: 'stop'; units: number[] }
  | { tick: number; player: number; kind: 'amove'; units: number[]; x: number; y: number; queued?: boolean }
  /** Obreros a recolectar de un yacimiento. */
  | { tick: number; player: number; kind: 'gather'; units: number[]; target: number; queued?: boolean }
  /** Colocar un edificio nuevo (se cobra al colocarlo) y mandar obreros a construirlo. */
  | { tick: number; player: number; kind: 'build'; units: number[]; building: BuildingType; tx: number; ty: number; queued?: boolean }
  /** Obreros a ayudar a construir un edificio propio sin terminar. */
  | { tick: number; player: number; kind: 'construct'; units: number[]; target: number; queued?: boolean }
  | { tick: number; player: number; kind: 'train'; building: number; unit: UnitType }
  /** Investigar una tecnología (o avanzar de generación) en un edificio propio. */
  | { tick: number; player: number; kind: 'research'; building: number; tech: TechId }
  | { tick: number; player: number; kind: 'cancelResearch'; building: number }
  /** Camiones repetidores: desplegar (antena móvil) o replegar para moverse. */
  | { tick: number; player: number; kind: 'deploy'; units: number[]; on: boolean }
  /** Obreros a reparar un edificio propio dañado. Cuesta metal según la vida reparada. */
  | { tick: number; player: number; kind: 'repair'; units: number[]; target: number; queued?: boolean }
  /** Quitar de la cola la última unidad de ese tipo y devolver su coste. */
  | { tick: number; player: number; kind: 'cancel'; building: number; unit: UnitType }
  | { tick: number; player: number; kind: 'rally'; building: number; x: number; y: number }
  /** Solo para desarrollo: suma metal. Pasa por el log de comandos para que los replays sigan cuadrando. */
  | { tick: number; player: number; kind: 'grant'; amount: number }
  /** Solo para desarrollo: activa o desactiva construcción y producción instantáneas. */
  | { tick: number; player: number; kind: 'toggleInstant' }
  /** Solo para desarrollo: alterna el tope de población entre 200 y 1000. */
  | { tick: number; player: number; kind: 'togglePopCap' }
  /** Solo para desarrollo: las unidades del jugador no necesitan red de energía. */
  | { tick: number; player: number; kind: 'toggleNoPower' }
  /** Trucos de niebla (AoE2): revelar el mapa / quitar la niebla. */
  | { tick: number; player: number; kind: 'toggleRevealMap' }
  | { tick: number; player: number; kind: 'toggleNoFog' };
