import { BUILDINGS, buildingCenter, canPlace, type Building, type BuildingType } from './building';
import type { Command } from './commands';
import { SUB } from './constants';
import { isqrt } from './math';
import type { MetalNode } from './resource';
import { UNITS, type Unit, type UnitType } from './unit';
import { canPlaceBuilding, isPowered, nearestPoweredTile } from './power';
import { linkOf, TECHS, type TechId } from './tech';
import { hostile, type State } from './state';

/**
 * IA rival. Es una función pura del estado: decide cada segundo qué comandos enviar, igual que un
 * jugador. Sus comandos pasan por el mismo log que los del humano, así que los replays la reproducen.
 */
export const AI_EVERY = 20;

const MAX_WORKERS = 24;
/** Soldados que la IA mantiene aunque esté ahorrando para algo más caro. */
const MIN_SOLDIERS = 8;
const DEFEND_RADIUS = 14 * SUB;
const HOME_RADIUS = 20 * SUB;
/** Distancia de una zona de metal a un punto de entrega a partir de la cual conviene un depósito. */
const DEPOT_DISTANCE = 9 * SUB;
/** Población militar a partir de la cual la IA lanza el asalto final (y la más baja tras el minuto 30). */
const ASSAULT_POP = 100;
const ASSAULT_LATE_POP = 60;
const ASSAULT_LATE_TICK = 36000;
/** Radio de defensa alrededor de cada depósito. */
const EXPANSION_RADIUS = 10 * SUB;
/** Zonas de metal en las que mina la IA a la vez. */
const ZONES = 2;
/** Plan de investigación de la IA, por prioridad. */
const AI_RESEARCH: TechId[] = ['pneumatic', 'gen2', 'lithium', 'composite', 'carts', 'antimech', 'amplifiers', 'piercing', 'gen3', 'rangefinder'];
/** Antenas máximas que tiende la IA. */
const MAX_RELAYS = 14;
/** La cadena de antenas se detiene a esta distancia de un edificio enemigo (cobertura + alcance de mecha + margen). */
const STOP_CHAIN = 13 * SUB;
/** Minutos de juego (en ticks) tras los que las oleadas crecen. */
const WAVE_GROWTH_TICKS = 2400;

/** Un comando sin tick ni jugador (los pone `send`). */
type Plan = Command extends infer C ? (C extends Command ? Omit<C, 'tick' | 'player'> : never) : never;

export function aiCommands(st: State, p: number): Command[] {
  if (st.tick % AI_EVERY !== 0 || st.winner >= 0 || st.players[p].defeated) return [];
  const hq = st.buildings.find((b) => b.owner === p && b.type === 'hq');
  if (!hq) return [];

  const out: Command[] = [];
  const send = (c: Plan) => out.push({ ...c, tick: st.tick, player: p } as Command);
  let metal = st.players[p].metal;
  const home = buildingCenter(hq);
  const dist = (ax: number, ay: number, bx: number, by: number) => isqrt((ax - bx) ** 2 + (ay - by) ** 2);

  const mine = st.units.filter((u) => u.owner === p);
  const workers = mine.filter((u) => u.type === 'worker');
  // Los camiones repetidores van aparte: no pelean, extienden la red.
  const army = mine.filter((u) => u.type !== 'worker' && u.type !== 'truck');
  const trucks = mine.filter((u) => u.type === 'truck');
  const gen = st.players[p].gen;
  const mineB = st.buildings.filter((b) => b.owner === p);
  const count = (t: BuildingType) => mineB.filter((b) => b.type === t).length;
  const ready = (t: BuildingType) => mineB.filter((b) => b.type === t && b.complete);
  const busy = new Set<number>();
  // Asalto final: con un ejército grande, la IA decide forzar la salida de sus mechas de la red.
  const armyPop = army.reduce((s, u) => s + u.pop, 0);
  const strong = armyPop >= ASSAULT_POP || (st.tick > ASSAULT_LATE_TICK && armyPop >= ASSAULT_LATE_POP);

  // ---- economía: elegir las mejores zonas de metal (mucho metal, cerca y sin peligro) y minar ahí
  const drops = mineB.filter((b) => BUILDINGS[b.type].dropoff && b.complete);
  const zones = pickZones(st, p, home);
  const nodes = zones.flatMap((z) => z.nodes);
  if (nodes.length > 0) {
    const inZone = new Set(nodes.map((n) => n.id));
    // Reparto: cada obrero a un yacimiento de las zonas elegidas; cada 10 s se recoloca a los que
    // minan fuera de ellas (zona agotada, lejana o peligrosa) sin esperar a que se queden ociosos.
    const rebalance = st.tick % (AI_EVERY * 10) === 0;
    for (const w of workers) {
      const off = w.order.kind === 'gather' && !inZone.has(w.order.node);
      if (w.order.kind !== 'idle' && !(rebalance && off && w.carry === 0)) continue;
      send({ kind: 'gather', units: [w.id], target: nodes[w.id % nodes.length].id });
      busy.add(w.id);
    }
  }

  if (workers.length + hq.queue.length < MAX_WORKERS && hq.queue.length < 2 && metal >= UNITS.worker.cost) {
    send({ kind: 'train', building: hq.id, unit: 'worker' });
    metal -= UNITS.worker.cost;
  }

  // ---- construcción: un edificio nuevo por vez, en el orden del plan
  // La red (antenas y centrales) se construye aparte y no frena el resto del plan.
  const building = mineB.some((b) => !b.complete && !BUILDINGS[b.type].power);
  /** Metal apartado para el próximo edificio o unidad cara; los soldados solo gastan lo que sobra. */
  let reserve = 0;
  const tryBuild = (type: BuildingType): void => {
    const s = BUILDINGS[type];
    if (metal < s.cost) {
      reserve = s.cost;
      return;
    }
    const spot = findSpot(st, home, type);
    if (!spot) return;
    const cx = spot.tx * SUB + (s.size * SUB) / 2;
    const cy = spot.ty * SUB + (s.size * SUB) / 2;
    const builders = workers
      .filter((w) => !busy.has(w.id) && w.order.kind !== 'build')
      .sort((a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy) || a.id - b.id)
      .slice(0, 2);
    if (builders.length === 0) return;
    send({ kind: 'build', units: builders.map((w) => w.id), building: type, tx: spot.tx, ty: spot.ty });
    for (const w of builders) busy.add(w.id);
    metal -= s.cost;
  };
  const mechs = army.filter((u) => u.type === 'mech').length;
  // Zona elegida sin punto de entrega cerca: un depósito al lado, antes que cualquier otra obra.
  const building2 = mineB.some((b) => b.type === 'depot' && !b.complete);
  const target = zones.find((z) => drops.every((b) => dist(buildingCenter(b).x, buildingCenter(b).y, z.x, z.y) > DEPOT_DISTANCE));
  if (!building2 && target && workers.length >= 6) {
    const s = BUILDINGS.depot;
    const spot = metal >= s.cost ? findSpot(st, { x: target.x, y: target.y }, 'depot', 2, false) : null;
    const w = spot && workers.filter((x) => !busy.has(x.id) && x.order.kind !== 'build').sort((a, z) => a.id - z.id)[0];
    if (spot && w) {
      send({ kind: 'build', units: [w.id], building: 'depot', tx: spot.tx, ty: spot.ty });
      busy.add(w.id);
      metal -= s.cost;
    } else if (metal < s.cost) reserve = s.cost;
  }
  if (!building) {
    if (count('barracks') === 0 && workers.length >= 6) tryBuild('barracks');
    else if (count('hangar') === 0 && ready('barracks').length > 0 && workers.length >= 10) tryBuild('hangar');
    else if (count('barracks') < 2 && ready('hangar').length > 0) tryBuild('barracks');
    else if (count('tower') < 2 && ready('hangar').length > 0 && workers.length >= 14) tryBuild('tower');
    else if (gen >= 3 && count('cradle') === 0 && ready('hangar').length > 0 && mechs >= 3) tryBuild('cradle');
    else if (count('hangar') < 2 && ready('cradle').length > 0) tryBuild('hangar');
  }

  // ---- red de energía: tomar vetas libres y tender antenas hacia el enemigo
  // Rival principal: el cuartel general enemigo más cercano.
  const enemyHq = st.buildings
    .filter((b) => hostile(st, b.owner, p) && b.type === 'hq')
    .sort((a, z) => dist(buildingCenter(a).x, buildingCenter(a).y, home.x, home.y) - dist(buildingCenter(z).x, buildingCenter(z).y, home.x, home.y) || a.id - z.id)[0];
  // Solo cuenta la red a la que se puede llegar desde la base sin pisar zona sin energía: nodos cuya
  // cobertura se toca, empezando por los de casa. Así la IA nunca manda mechas a cruzar un hueco.
  const powered = mineB.filter((b) => BUILDINGS[b.type].power && b.powered);
  const nodes2 = powered.filter((b) => dist(buildingCenter(b).x, buildingCenter(b).y, home.x, home.y) <= HOME_RADIUS);
  for (let i = 0; i < nodes2.length; i++) {
    const a = nodes2[i];
    const ca = buildingCenter(a);
    for (const b of powered) {
      if (nodes2.includes(b)) continue;
      const cb = buildingCenter(b);
      const reach = (BUILDINGS[a.type].power!.cover + BUILDINGS[b.type].power!.cover) * SUB;
      if (dist(ca.x, ca.y, cb.x, cb.y) <= reach) nodes2.push(b);
    }
  }
  const frontier = enemyHq
    ? nodes2
        .map((b) => ({ b, c: buildingCenter(b) }))
        .sort((a, z) => dist(a.c.x, a.c.y, buildingCenter(enemyHq).x, buildingCenter(enemyHq).y) - dist(z.c.x, z.c.y, buildingCenter(enemyHq).x, buildingCenter(enemyHq).y) || a.b.id - z.b.id)[0]
    : undefined;
  const spare = () => workers.filter((x) => !busy.has(x.id) && x.order.kind !== 'build').sort((a, z) => a.id - z.id)[0];
  if (ready('hangar').length > 0 && !mineB.some((b) => b.type === 'plant' && !b.complete) && metal >= BUILDINGS.plant.cost) {
    // Una veta libre más cerca de mí que del enemigo.
    const v = st.vents
      .filter((v) => canPlaceBuilding(st, 'plant', v.tx - 1, v.ty - 1))
      .filter((v) => !enemyHq || dist(v.tx * SUB, v.ty * SUB, home.x, home.y) <= dist(v.tx * SUB, v.ty * SUB, buildingCenter(enemyHq).x, buildingCenter(enemyHq).y) + 4 * SUB)
      // A igual distancia, cada jugador prefiere una veta distinta (uno el norte, otro el sur) para no
      // pedir los dos la misma en el mismo tick, donde siempre ganaría el primero en procesarse.
      .sort((a, z) => dist(a.tx * SUB, a.ty * SUB, home.x, home.y) - dist(z.tx * SUB, z.ty * SUB, home.x, home.y) || (p % 2 === 0 ? a.ty - z.ty : z.ty - a.ty))[0];
    const w = v && spare();
    if (v && w) {
      send({ kind: 'build', units: [w.id], building: 'plant', tx: v.tx - 1, ty: v.ty - 1 });
      busy.add(w.id);
      metal -= BUILDINGS.plant.cost;
    }
  }
  const relays = mineB.filter((b) => b.type === 'relay').length;
  if (frontier && enemyHq && ready('hangar').length > 0 && relays < MAX_RELAYS && !mineB.some((b) => b.type === 'relay' && !b.complete) && metal >= BUILDINGS.relay.cost) {
    const e = buildingCenter(enemyHq);
    const d = dist(frontier.c.x, frontier.c.y, e.x, e.y);
    // Parar cuando el borde de la red ya pone a tiro los edificios enemigos (cobertura + alcance de un mecha).
    const enemyNear = st.buildings.some((b) => hostile(st, b.owner, p) && dist(buildingCenter(b).x, buildingCenter(b).y, frontier.c.x, frontier.c.y) <= STOP_CHAIN);
    if ((!enemyNear || strong) && d > 6 * SUB) {
      // Siguiente eslabón: 7 casillas hacia el cuartel general enemigo, en el primer hueco válido.
      const step = 7 * SUB;
      const gx = Math.floor((frontier.c.x + ((e.x - frontier.c.x) * step) / d) / SUB);
      const gy = Math.floor((frontier.c.y + ((e.y - frontier.c.y) * step) / d) / SUB);
      const spot = nearSpot(st, gx, gy, p, strong);
      const w = spot && spare();
      if (spot && w) {
        send({ kind: 'build', units: [w.id], building: 'relay', tx: spot.tx, ty: spot.ty });
        busy.add(w.id);
        metal -= BUILDINGS.relay.cost;
      }
    }
  }

  // Construcciones sin nadie trabajando (sus obreros murieron): mandar al más cercano.
  for (const b of mineB) {
    if (b.complete || workers.some((w) => w.order.kind === 'build' && w.order.target === b.id)) continue;
    const c = buildingCenter(b);
    const w = workers.filter((x) => !busy.has(x.id)).sort((a, z) => dist(a.x, a.y, c.x, c.y) - dist(z.x, z.y, c.x, c.y) || a.id - z.id)[0];
    if (!w) break;
    send({ kind: 'construct', units: [w.id], target: b.id });
    busy.add(w.id);
  }

  // ---- generaciones y tecnologías: un plan fijo por prioridad, en el edificio que toque si está libre.
  for (const tech of AI_RESEARCH) {
    const t = TECHS[tech];
    if (st.players[p].techs.includes(tech) || t.gen > gen) continue;
    if (mineB.some((b) => b.research?.tech === tech)) continue;
    if (tech === 'piercing' && count('tower') === 0) continue;
    if ((tech === 'gen2' || tech === 'gen3') && armyPop < (tech === 'gen2' ? 8 : 30)) continue;
    // El cuartel general solo investiga con la economía ya en marcha (mientras investiga, no entrena).
    if (t.building === 'hq' && workers.length < 16) continue;
    // En edificios de producción, investigar sin dejar de producir: con dos de ellos o un ejército ya hecho.
    if ((t.building === 'hangar' || t.building === 'barracks') && ready(t.building).length < 2 && armyPop < 25) continue;
    if (!t.requires.every((r) => ready(r).length > 0)) continue;
    const b = ready(t.building).find((x) => !x.research && x.queue.length === 0) ?? ready(t.building).find((x) => !x.research);
    if (!b) continue;
    if (metal < t.cost) {
      // Los saltos de generación se ahorran; el resto espera su turno.
      if (tech === 'gen2' || tech === 'gen3') reserve = Math.max(reserve, t.cost);
      continue;
    }
    send({ kind: 'research', building: b.id, tech });
    metal -= t.cost;
  }

  // ---- producción.
  // Con la cuna lista y algo de ejército para defenderse, ahorrar sin pausa hasta poder pagar un coloso
  // (salvo que estén atacando la base).
  const underAttack = st.units.some((u) => hostile(st, u.owner, p) && u.type !== 'worker' && dist(u.x, u.y, home.x, home.y) <= DEFEND_RADIUS);
  const saving = ready('cradle').some((b) => b.queue.length === 0) && armyPop >= 20 && !underAttack;
  const train = (b: Building, unit: UnitType, maxQueue: number, keep: number, holdIfShort = true) => {
    if (b.queue.length >= maxQueue) return;
    if (metal - UNITS[unit].cost < keep) {
      // No alcanza: apartar para esta unidad antes que para las más baratas.
      if (holdIfShort) reserve = Math.max(reserve, UNITS[unit].cost);
      return;
    }
    send({ kind: 'train', building: b.id, unit });
    metal -= UNITS[unit].cost;
  };
  // Alternar colosos de combate y de asedio.
  const bigs = army.filter((u) => u.type === 'colossus').length;
  const sieges = army.filter((u) => u.type === 'siege').length;
  const enemyTowers = st.buildings.some((b) => hostile(st, b.owner, p) && b.type === 'tower');
  for (const b of ready('cradle')) train(b, enemyTowers || sieges < bigs ? 'siege' : 'colossus', 1, 0, saving);
  if (!saving) {
    // Un mecha de artillería por cada dos mechas de línea.
    const arts = army.filter((u) => u.type === 'artillery').length;
    for (const b of ready('hangar')) {
      // Camiones repetidores (Gen-2): un par para empujar la red.
      if (gen >= 2 && trucks.length < 2 && !b.queue.includes('truck')) train(b, 'truck', 1, reserve);
      else train(b, gen >= 2 && arts * 2 < mechs ? 'artillery' : 'mech', 1, reserve);
    }
    const soldiers = army.filter((u) => u.type === 'soldier').length;
    for (const b of ready('barracks')) train(b, 'soldier', 2, soldiers < MIN_SOLDIERS ? 0 : reserve);
  }

  // Punto de reunión delante de la base, hacia el centro del mapa.
  const front = home.x < (st.map.w * SUB) / 2 ? 1 : -1;
  for (const b of mineB) {
    if (!b.complete || b.rallyX >= 0 || BUILDINGS[b.type].trains.length === 0 || b.type === 'hq') continue;
    send({ kind: 'rally', building: b.id, x: home.x + front * 7 * SUB, y: home.y });
  }

  // ---- ejército
  const enemyUnits = st.units.filter((u) => hostile(st, u.owner, p));
  // Amenaza: enemigos cerca del cuartel general o de cualquier depósito (las expansiones también se defienden).
  const guarded = [home, ...mineB.filter((b) => b.type === 'depot').map((b) => buildingCenter(b))];
  const threat = enemyUnits.find((u) => u.type !== 'worker' && guarded.some((g) => dist(u.x, u.y, g.x, g.y) <= (g === home ? DEFEND_RADIUS : EXPANSION_RADIUS)));
  const free = (u: Unit) => u.order.kind === 'idle' || u.order.kind === 'move';
  // Las unidades que dependen de la red nunca se mandan fuera de ella: van hasta su borde.
  const leashed = (u: Unit) => u.needsPower && !st.players[p].noPower;
  const edge = frontier && enemyHq ? edgeToward(frontier.c, buildingCenter(enemyHq), BUILDINGS[frontier.b.type].power!.cover - 1) : home;
  const sendArmy = (us: Unit[], x: number, y: number) => {
    const inside = us.filter((u) => !leashed(u) || isPowered(st, p, x, y));
    const outside = us.filter((u) => leashed(u) && !isPowered(st, p, x, y));
    if (inside.length) send({ kind: 'amove', units: inside.map((u) => u.id), x, y });
    if (outside.length) send({ kind: 'amove', units: outside.map((u) => u.id), x: edge.x, y: edge.y });
  };
  // Camiones: se encadenan uno detrás de otro desde el borde de la red hacia el enemigo, cada uno a
  // distancia de enlace del anterior (así cada camión extiende la red en vez de apilarse).
  if (frontier && enemyHq) {
    const step = (linkOf(st, p, BUILDINGS.relay.power!.link, true) - 1) * SUB;
    const e = buildingCenter(enemyHq);
    const linkR = linkOf(st, p, BUILDINGS.relay.power!.link, true) * SUB;
    const linked = (t: Unit) =>
      mineB.some((b) => b.powered && b.complete && BUILDINGS[b.type].power && dist(buildingCenter(b).x, buildingCenter(b).y, t.x, t.y) <= linkR) ||
      trucks.some((o) => o !== t && o.deployState === 2 && o.nodePowered && dist(o.x, o.y, t.x, t.y) <= linkR);
    let from = frontier.c;
    // Se despliegan por orden: el siguiente solo avanza cuando el anterior ya da energía.
    let ready = true;
    for (const t of trucks.slice().sort((a, z) => a.id - z.id)) {
      const d0 = dist(from.x, from.y, e.x, e.y) || 1;
      const spot = { x: from.x + Math.trunc(((e.x - from.x) * Math.min(step, d0)) / d0), y: from.y + Math.trunc(((e.y - from.y) * Math.min(step, d0)) / d0) };
      const d = dist(t.x, t.y, spot.x, spot.y);
      if (t.deployState === 2) {
        // nodePowered se calcula al inicio del tick siguiente: justo al terminar de desplegar aún es falso,
        // así que se comprueba el enlace a mano.
        if (!t.nodePowered && !linked(t)) {
          // Desplegado sin enlace: no sirve. Replegar y volver a colocarlo.
          send({ kind: 'deploy', units: [t.id], on: false });
          ready = false;
        } else if (d > 14 * SUB) {
          // El frente se alejó mucho: replegar para acompañarlo.
          send({ kind: 'deploy', units: [t.id], on: false });
          ready = false;
        } else from = { x: t.x, y: t.y };
        continue;
      }
      if (t.deployState === 1 || !ready) {
        ready = false;
        continue;
      }
      ready = false;
      if (t.order.kind !== 'idle') continue;
      if (d > 2 * SUB) send({ kind: 'move', units: [t.id], x: spot.x, y: spot.y });
      else send({ kind: 'deploy', units: [t.id], on: true });
    }
  }
  if (threat) {
    // Defensa: todo el ejército cercano a la base sale al encuentro.
    const defenders = army.filter((u) => free(u) && dist(u.x, u.y, home.x, home.y) <= HOME_RADIUS * 2);
    if (defenders.length) sendArmy(defenders, threat.x, threat.y);
    return out;
  }

  const enemyBuildings = st.buildings.filter((b) => hostile(st, b.owner, p));
  if (enemyBuildings.length === 0) return out;
  const nearestTarget = (x: number, y: number) =>
    enemyBuildings
      .map((b) => ({ b, c: buildingCenter(b) }))
      .sort((a, z) => dist(a.c.x, a.c.y, x, y) - dist(z.c.x, z.c.y, x, y) || a.b.id - z.b.id)[0].c;

  // El asalto solo se fuerza si el objetivo queda a pocas casillas del borde de la red: la batería
  // alcanza para llegar y pelear. Si no, se sigue empujando la red (con escolta) hacia él.
  const assaultTarget = frontier ? nearestTarget(frontier.c.x, frontier.c.y) : nearestTarget(home.x, home.y);
  const edgeNear = nearestPoweredTile(st, p, assaultTarget.x, assaultTarget.y, 10);
  if (strong && edgeNear) {
    // Asalto: todo el ejército libre contra el objetivo, sin esperar al borde de la red.
    const t = assaultTarget;
    const idle = army.filter((u) => u.order.kind === 'idle' || (u.order.kind === 'amove' && st.tick % (AI_EVERY * 15) === 0));
    if (idle.length) send({ kind: 'amove', units: idle.map((u) => u.id), x: t.x, y: t.y });
    return out;
  }
  const atHome = army.filter((u) => free(u) && dist(u.x, u.y, home.x, home.y) <= HOME_RADIUS);
  const pop = atHome.reduce((s, u) => s + u.pop, 0);
  const threshold = 14 + Math.min(30, Math.floor(st.tick / WAVE_GROWTH_TICKS) * 4);
  if (pop >= threshold) {
    const t = nearestTarget(home.x, home.y);
    sendArmy(atHome, t.x, t.y);
  }
  // Unidades de una oleada que quedaron ociosas lejos de casa: siguen con el edificio enemigo más
  // cercano (las que dependen de la red se quedan esperando en su borde hasta que avance).
  const stray = army.filter((u) => u.order.kind === 'idle' && dist(u.x, u.y, home.x, home.y) > HOME_RADIUS && !leashed(u));
  if (stray.length) {
    const t = nearestTarget(stray[0].x, stray[0].y);
    send({ kind: 'amove', units: stray.map((u) => u.id), x: t.x, y: t.y });
  }
  const waiting = army.filter((u) => u.order.kind === 'idle' && leashed(u) && dist(u.x, u.y, edge.x, edge.y) > 6 * SUB && dist(u.x, u.y, home.x, home.y) > HOME_RADIUS);
  if (waiting.length) sendArmy(waiting, edge.x, edge.y);
  return out;
}

/**
 * Sitio para un edificio en anillos alrededor de la base, dejando una casilla libre alrededor para
 * que no se cierren los caminos, y sin irse detrás del cuartel general (hacia el borde del mapa).
 */
interface Zone {
  x: number;
  y: number;
  amount: number;
  nodes: MetalNode[];
}

/**
 * Agrupa los yacimientos en zonas (vecinos a menos de 3 casillas) y devuelve las mejores para el
 * jugador: mucho metal, cerca de casa y sin torres ni tropas enemigas alrededor.
 */
function pickZones(st: State, p: number, home: { x: number; y: number }): Zone[] {
  const zones: Zone[] = [];
  const seen = new Set<number>();
  for (const n of st.nodes) {
    if (seen.has(n.id) || n.amount <= 0) continue;
    const group = [n];
    seen.add(n.id);
    for (let i = 0; i < group.length; i++) {
      for (const o of st.nodes) {
        if (seen.has(o.id) || o.amount <= 0) continue;
        if (Math.abs(o.tx - group[i].tx) <= 3 && Math.abs(o.ty - group[i].ty) <= 3) {
          seen.add(o.id);
          group.push(o);
        }
      }
    }
    const x = Math.trunc(group.reduce((s, g) => s + g.tx * SUB + SUB / 2, 0) / group.length);
    const y = Math.trunc(group.reduce((s, g) => s + g.ty * SUB + SUB / 2, 0) / group.length);
    zones.push({ x, y, amount: group.reduce((s, g) => s + g.amount, 0), nodes: group });
  }
  const danger = (z: Zone) =>
    st.buildings.some((b) => hostile(st, b.owner, p) && (BUILDINGS[b.type].attack || b.type === 'hq') && isqrt((buildingCenter(b).x - z.x) ** 2 + (buildingCenter(b).y - z.y) ** 2) <= 12 * SUB) ||
    st.units.filter((u) => hostile(st, u.owner, p) && u.type !== 'worker' && isqrt((u.x - z.x) ** 2 + (u.y - z.y) ** 2) <= 10 * SUB).length >= 3;
  const score = (z: Zone) => Math.trunc((Math.min(z.amount, 4000) * 100) / (Math.trunc(isqrt((z.x - home.x) ** 2 + (z.y - home.y) ** 2) / SUB) + 10));
  return zones
    .filter((z) => z.amount >= 200 && !danger(z))
    .sort((a, b) => score(b) - score(a) || a.nodes[0].id - b.nodes[0].id)
    .slice(0, ZONES)
    .map((z) => ({ ...z, nodes: z.nodes.slice().sort((a, b) => a.id - b.id) }));
}

/** Punto a `tiles` casillas de un nodo, en dirección a un objetivo: el borde de la red hacia él. */
function edgeToward(from: { x: number; y: number }, to: { x: number; y: number }, tiles: number): { x: number; y: number } {
  const d = isqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2) || 1;
  const r = Math.min(d, tiles * SUB);
  return { x: from.x + Math.trunc(((to.x - from.x) * r) / d), y: from.y + Math.trunc(((to.y - from.y) * r) / d) };
}

/** Primera casilla válida para una antena en anillos pequeños alrededor de (tx, ty). */
function nearSpot(st: State, tx: number, ty: number, owner: number, escorted = false): { tx: number; ty: number } | null {
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!canPlaceBuilding(st, 'relay', tx + dx, ty + dy) || !canPlace(st.map, tx + dx - 1, ty + dy - 1, 3)) continue;
        // Nunca al alcance de una torre enemiga: la derribaría en cuanto se termine.
        const x = (tx + dx) * SUB + SUB / 2;
        const y = (ty + dy) * SUB + SUB / 2;
        const guarded = st.buildings.some((b) => {
          const atk = BUILDINGS[b.type].attack;
          if (!hostile(st, b.owner, owner) || !atk) return false;
          const c = buildingCenter(b);
          return isqrt((c.x - x) ** 2 + (c.y - y) ** 2) <= atk.range + 2 * SUB;
        });
        // Ni junto a tropas enemigas: la cadena avanza por terreno despejado.
        const watched = st.units.some((u) => hostile(st, u.owner, owner) && u.type !== 'worker' && isqrt((u.x - x) ** 2 + (u.y - y) ** 2) <= 10 * SUB);
        // Con el ejército escoltando (asalto), las antenas avanzan igual detrás de las tropas.
        if (escorted || (!guarded && !watched)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return null;
}

function findSpot(st: State, home: { x: number; y: number }, type: BuildingType, minR = 5, forwardOnly = true): { tx: number; ty: number } | null {
  const size = BUILDINGS[type].size;
  const hx = Math.floor(home.x / SUB);
  const hy = Math.floor(home.y / SUB);
  const front = home.x < (st.map.w * SUB) / 2 ? 1 : -1;
  for (let r = minR; r <= 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || (forwardOnly && dx * front < -2)) continue;
        const tx = hx + dx - Math.floor(size / 2);
        const ty = hy + dy - Math.floor(size / 2);
        if (canPlace(st.map, tx - 1, ty - 1, size + 2) && canPlaceBuilding(st, type, tx, ty)) return { tx, ty };
      }
    }
  }
  return null;
}
