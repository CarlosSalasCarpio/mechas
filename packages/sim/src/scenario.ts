import { SUB, MAP_SIZE } from './constants';
import { GRASS, generateMap } from './map';
import { createRng } from './rng';
import { updatePower } from './power';
import { updateVision } from './vision';
import { addBuilding, addNode, addUnit, POP_CAP, type State } from './state';
import type { UnitType } from './unit';

export interface GameSetup {
  seed: number;
  /** Equipo de cada jugador (el jugador 0 es el humano). Por defecto, 1 contra 1: [0, 1]. */
  teams?: number[];
  /** Ejército de prueba por jugador, además de la base inicial (0 = partida normal). */
  perSide?: number;
  armyType?: UnitType;
}

export const MAX_PLAYERS = 6;

/** Modos de partida del menú: el equipo de cada jugador, siempre con el humano en el primero. */
export const MODES: Record<string, number[]> = {
  '1v1': [0, 1],
  '1v2': [0, 1, 1],
  '2v2': [0, 0, 1, 1],
  '1v3': [0, 1, 1, 1],
  '2v2v2': [0, 0, 1, 1, 2, 2],
  '3v3': [0, 0, 0, 1, 1, 1],
  '1v5': [0, 1, 1, 1, 1, 1],
  'todos contra todos (4)': [0, 1, 2, 3],
};

export const START_METAL = 300;
export const START_WORKERS = 4;

// Yacimientos: forma de cada grupo (casillas relativas).
const CLUSTER = [
  [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [-1, 1],
];
const BIG_CLUSTER = [...CLUSTER, [1, 2], [0, 2]];

/** Disposición de un mapa: bases, yacimientos y vetas. Todo en casillas. */
interface Layout {
  size: number;
  /** Por jugador: cuartel general (esquina), zona despejada, grupos de metal de la base, veta y obreros. */
  bases: { hq: { tx: number; ty: number }; clear: { tx: number; ty: number }; clusters: { tx: number; ty: number }[]; vent: { tx: number; ty: number }; workers: { tx: number; ty: number }[] }[];
  clusters: { tx: number; ty: number }[];
  vents: { tx: number; ty: number }[];
}

/** 1 contra 1: el mapa clásico, a izquierda y derecha. */
function duelLayout(): Layout {
  const bases = [0, 1].map((owner) => {
    const hq = owner === 0 ? { tx: 13, ty: 58 } : { tx: 103, ty: 58 };
    const dir = owner === 0 ? 1 : -1;
    const cx = hq.tx + 2;
    const cy = hq.ty + 2;
    const wx = owner === 0 ? hq.tx + 4 : hq.tx - 1;
    return {
      hq,
      clear: owner === 0 ? { tx: 25, ty: 60 } : { tx: 95, ty: 60 },
      clusters: [
        { tx: cx + dir * 2, ty: cy - 6, mirror: dir },
        { tx: cx + dir * 2, ty: cy + 7, mirror: dir },
      ],
      vent: owner === 0 ? { tx: 12, ty: 64 } : { tx: 107, ty: 64 },
      workers: [0, 1, 2, 3].map((i) => ({ tx: wx, ty: hq.ty + i })),
    };
  });
  return {
    size: MAP_SIZE,
    bases,
    clusters: [
      { tx: 60, ty: 36 },
      { tx: 59, ty: 59 },
      { tx: 60, ty: 84 },
      // Zonas de expansión, una por cuadrante.
      { tx: 34, ty: 30 },
      { tx: 85, ty: 30 },
      { tx: 34, ty: 90 },
      { tx: 85, ty: 90 },
    ],
    vents: [
      { tx: 60, ty: 46 },
      { tx: 60, ty: 74 },
    ],
  };
}

// Coseno ×1000 cada 3 grados (la simulación no usa trigonometría en coma flotante: es determinista).
const COS = [
  1000, 999, 995, 988, 978, 966, 951, 934, 914, 891, 866, 839, 809, 777, 743, 707, 669, 629, 588, 545, 500, 454, 407, 358, 309, 259, 208, 156, 105, 52, 0, -52, -105, -156, -208, -259, -309, -358, -407, -454,
  -500, -545, -588, -629, -669, -707, -743, -777, -809, -839, -866, -891, -914, -934, -951, -966, -978, -988, -995, -999, -1000, -999, -995, -988, -978, -966, -951, -934, -914, -891, -866, -839, -809, -777, -743,
  -707, -669, -629, -588, -545, -500, -454, -407, -358, -309, -259, -208, -156, -105, -52, 0, 52, 105, 156, 208, 259, 309, 358, 407, 454, 500, 545, 588, 629, 669, 707, 743, 777, 809, 839, 866, 891, 914, 934,
  951, 966, 978, 988, 995, 999,
];
const cosDeg = (d: number) => COS[Math.trunc((((d % 360) + 360) % 360) / 3)];
const sinDeg = (d: number) => cosDeg(d - 90);

/**
 * 3 a 6 jugadores: bases en círculo alrededor del centro (los compañeros de equipo, contiguos), metal
 * delante de cada base y entre bases vecinas, y una veta disputada entre cada par de vecinos.
 */
function ringLayout(n: number): Layout {
  const size = n <= 4 ? 160 : 190;
  const c = size / 2;
  const R = Math.trunc((size * 38) / 100);
  const at = (deg: number, r: number) => ({ tx: c + Math.trunc((cosDeg(deg) * r) / 1000), ty: c + Math.trunc((sinDeg(deg) * r) / 1000) });
  const step = 360 / n;
  const bases = [];
  for (let i = 0; i < n; i++) {
    const a = 180 + step * i;
    const h = at(a, R);
    // Hacia el centro (u) y de lado (v), en casillas ×1000.
    const ux = -cosDeg(a);
    const uy = -sinDeg(a);
    const vx = -uy;
    const vy = ux;
    const off = (du: number, dv: number) => ({ tx: h.tx + Math.trunc((ux * du + vx * dv) / 1000), ty: h.ty + Math.trunc((uy * du + vy * dv) / 1000) });
    const front = off(4, 0);
    bases.push({
      hq: { tx: h.tx - 2, ty: h.ty - 2 },
      clear: off(6, 0),
      clusters: [off(3, 8), off(3, -9)],
      vent: off(-6, 3),
      workers: [-2, -1, 1, 2].map((k) => ({ tx: front.tx + Math.trunc((vx * k) / 1000), ty: front.ty + Math.trunc((vy * k) / 1000) })),
    });
  }
  const clusters = [{ tx: c - 1, ty: c - 1 }];
  const vents = [];
  for (let i = 0; i < n; i++) {
    const a = 180 + step * i;
    clusters.push(at(a, Math.trunc((R * 45) / 100)));
    clusters.push(at(a + step / 2, Math.trunc((R * 85) / 100)));
    vents.push(at(a + step / 2, Math.trunc((R * 55) / 100)));
  }
  return { size, bases, clusters, vents };
}

export function createGame(setup: GameSetup): State {
  const teams = (setup.teams ?? [0, 1]).slice(0, MAX_PLAYERS);
  const n = teams.length;
  const layout = n === 2 ? duelLayout() : ringLayout(n);
  const rng = createRng(setup.seed);
  const map = generateMap(rng, layout.size, layout.size, layout.bases.map((b) => ({ ...b.clear, r: 15 })));
  const st: State = {
    tick: 0,
    rng,
    map,
    players: teams.map((team) => ({ team, defeated: false, metal: START_METAL, instant: false, popCap: POP_CAP, noPower: false, revealMap: false, noFog: false, gen: 1 as const, techs: [] })),
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
    vents: [...layout.bases.map((b) => b.vent), ...layout.vents],
    power: new Uint8Array(map.w * map.h),
    powerVersion: 0,
    vision: new Uint8Array(map.w * map.h),
    explored: new Uint8Array(map.w * map.h),
    visionVersion: 0,
    nextId: 1,
    reservations: [],
  };
  // Las vetas y los cuarteles generales siempre quedan en terreno limpio, sea cual sea el mapa generado.
  const clearAround = (tx: number, ty: number, r: number) => {
    for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) if (x >= 0 && y >= 0 && x < map.w && y < map.h) map.tiles[y * map.w + x] = GRASS;
  };
  for (const v of st.vents) clearAround(v.tx, v.ty, 2);
  for (const b of layout.bases) clearAround(b.hq.tx + 2, b.hq.ty + 2, 5);

  layout.bases.forEach((b, owner) => {
    // El cuartel general ya da energía a la base; la veta de al lado queda libre para una central.
    addBuilding(st, owner, 'hq', b.hq.tx, b.hq.ty);
    for (const c of b.clusters) {
      const mirror = (c as { mirror?: number }).mirror ?? 1;
      for (const [ox, oy] of CLUSTER) addNode(st, c.tx + mirror * ox, c.ty + oy, 1000);
    }
    for (const w of b.workers) addUnit(st, owner, w.tx * SUB + SUB / 2, w.ty * SUB + SUB / 2, 'worker');
  });
  for (const c of layout.clusters) for (const [ox, oy] of BIG_CLUSTER) addNode(st, c.tx + ox, c.ty + oy, 1200);

  const army = setup.perSide ?? 0;
  const cols = Math.ceil(Math.sqrt(army));
  const spacing = SUB / 2;
  layout.bases.forEach((b, owner) => {
    const ox = b.clear.tx * SUB + SUB / 2 - Math.trunc(((cols - 1) * spacing) / 2);
    const oy = b.clear.ty * SUB + SUB / 2 - Math.trunc(((cols - 1) * spacing) / 2);
    for (let i = 0; i < army; i++) addUnit(st, owner, ox + (i % cols) * spacing, oy + Math.trunc(i / cols) * spacing, setup.armyType ?? 'soldier');
  });
  updatePower(st);
  updateVision(st);
  return st;
}
