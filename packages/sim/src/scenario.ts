import { SUB, MAP_SIZE } from './constants';
import { GRASS, generateMap } from './map';
import { createRng } from './rng';
import { updatePower } from './power';
import { updateVision } from './vision';
import { addBuilding, addNode, addUnit, POP_CAP, type State } from './state';
import type { UnitType } from './unit';

export interface GameSetup {
  seed: number;
  /** Ejército de prueba por jugador, además de la base inicial (0 = partida normal). */
  perSide?: number;
  armyType?: UnitType;
}

export const SPAWNS = [
  { tx: 25, ty: 60 },
  { tx: 95, ty: 60 },
];

/** Cuartel general de cada jugador, detrás de su ejército (casilla superior izquierda). */
export const HQ_TILES = [
  { tx: 13, ty: 58 },
  { tx: 103, ty: 58 },
];

/** Vetas de energía: una junto a cada base y dos disputadas en el centro. */
export const HOME_VENTS = [
  { tx: 12, ty: 64 },
  { tx: 107, ty: 64 },
];
export const MID_VENTS = [
  { tx: 60, ty: 46 },
  { tx: 60, ty: 74 },
];

export const START_METAL = 300;
export const START_WORKERS = 4;

// Yacimientos: forma de cada grupo (casillas relativas) y centros relativos al cuartel general del jugador 0.
const CLUSTER = [
  [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [-1, 1],
];
const BASE_CLUSTERS = [
  { dx: 2, dy: -6 },
  { dx: 2, dy: 7 },
];
const MID_CLUSTERS = [
  { tx: 60, ty: 36 },
  { tx: 59, ty: 59 },
  { tx: 60, ty: 84 },
  // Zonas de expansión, una por cuadrante.
  { tx: 34, ty: 30 },
  { tx: 85, ty: 30 },
  { tx: 34, ty: 90 },
  { tx: 85, ty: 90 },
];

export function createGame(setup: GameSetup): State {
  const rng = createRng(setup.seed);
  const map = generateMap(rng, MAP_SIZE, MAP_SIZE, SPAWNS.map((s) => ({ ...s, r: 15 })));
  const st: State = {
    tick: 0,
    rng,
    map,
    players: SPAWNS.map(() => ({ metal: START_METAL, instant: false, popCap: POP_CAP, noPower: false, revealMap: false, noFog: false, gen: 1 as const, techs: [] })),
    units: [],
    byId: new Map(),
    buildings: [],
    buildingsById: new Map(),
    nodes: [],
    nodesById: new Map(),
    events: [],
    fx: [],
    projectiles: [],
    winner: -1,
    vents: [...HOME_VENTS, ...MID_VENTS],
    power: new Uint8Array(map.w * map.h),
    powerVersion: 0,
    vision: new Uint8Array(map.w * map.h),
    explored: new Uint8Array(map.w * map.h),
    visionVersion: 0,
    nextId: 1,
  };
  // Las vetas siempre quedan en terreno limpio (con margen), sea cual sea el mapa generado.
  for (const v of st.vents) {
    for (let y = v.ty - 2; y <= v.ty + 2; y++) for (let x = v.tx - 2; x <= v.tx + 2; x++) map.tiles[y * map.w + x] = GRASS;
  }

  HQ_TILES.forEach((h, owner) => {
    // El cuartel general ya da energía a la base; la veta de al lado queda libre para una central.
    addBuilding(st, owner, 'hq', h.tx, h.ty);
    // El jugador 1 es el espejo del 0: sus yacimientos y obreros quedan hacia el centro del mapa.
    const dir = owner === 0 ? 1 : -1;
    const cx = h.tx + 2;
    const cy = h.ty + 2;
    for (const c of BASE_CLUSTERS) for (const [ox, oy] of CLUSTER) addNode(st, cx + dir * (c.dx + ox), cy + c.dy + oy, 1000);
    const wx = owner === 0 ? h.tx + 4 : h.tx - 1;
    for (let i = 0; i < START_WORKERS; i++) addUnit(st, owner, wx * SUB + SUB / 2, (h.ty + i) * SUB + SUB / 2, 'worker');
  });
  for (const c of MID_CLUSTERS) for (const [ox, oy] of [...CLUSTER, [1, 2], [0, 2]]) addNode(st, c.tx + ox, c.ty + oy, 1200);

  const n = setup.perSide ?? 0;
  const cols = Math.ceil(Math.sqrt(n));
  const spacing = SUB / 2;
  SPAWNS.forEach((s, owner) => {
    const ox = s.tx * SUB + SUB / 2 - Math.trunc(((cols - 1) * spacing) / 2);
    const oy = s.ty * SUB + SUB / 2 - Math.trunc(((cols - 1) * spacing) / 2);
    for (let i = 0; i < n; i++) addUnit(st, owner, ox + (i % cols) * spacing, oy + Math.trunc(i / cols) * spacing, setup.armyType ?? 'soldier');
  });
  updatePower(st);
  updateVision(st);
  return st;
}
