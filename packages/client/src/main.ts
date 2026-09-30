import { Application, Graphics } from 'pixi.js';
import {
  aiCommands,
  BUILDING_GEN,
  TECH_ORDER,
  TECHS,
  UNIT_GEN,
  type TechId,
  isExplored,
  isVisible,
  BATTERY_TICKS,
  canPlaceBuilding,
  isPowered,
  BUILDINGS,
  canPlace,
  createGame,
  entityAtTile,
  hashState,
  popUsed,
  step,
  SUB,
  TICK_MS,
  UNITS,
  type Building,
  type BuildingType,
  type Command,
  type Unit,
  type UnitType,
} from '@epocas/sim';
import { BUILDING_NAMES, GameView, isoX, isoY, screenToWorld, UNIT_BOX, type Pos } from '@epocas/render';
import { Sfx } from './audio';
import { Minimap } from './minimap';

const PLAYER = 0;
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 42);
const perSide = Number(params.get('n') ?? 0);
const AI_PLAYER = 1;
const aiOn = params.get('ai') !== '0';

const UNIT_NAMES: Record<UnitType, [string, string]> = {
  worker: ['obrero', 'obreros'],
  soldier: ['soldado', 'soldados'],
  mech: ['mecha', 'mechas'],
  truck: ['camión repetidor', 'camiones repetidores'],
  artillery: ['mecha de artillería', 'mechas de artillería'],
  colossus: ['coloso', 'colosos'],
  siege: ['coloso de asedio', 'colosos de asedio'],
};
const GEN_NAMES = ['', 'Prototipos', 'Producción en serie', 'Reactor de núcleo'];
const TECH_INFO: Record<TechId, [string, string]> = {
  gen2: ['Gen-2 · Producción en serie', 'Artillería, camión repetidor y nuevas tecnologías'],
  gen3: ['Gen-3 · Reactor de núcleo', 'Cuna y colosos con reactor propio'],
  pneumatic: ['Picos neumáticos', 'Obreros extraen un 25 % más rápido'],
  carts: ['Carretillas', 'Carga por obrero de 10 a 15'],
  antimech: ['Lanzacohetes antimecha', 'Soldados +150 % de daño a máquinas'],
  composite: ['Blindaje compuesto', 'Mechas y artillería +25 % de vida'],
  lithium: ['Baterías de litio', 'Batería fuera de la red de 12 a 20 s'],
  piercing: ['Munición perforante', 'Torres +50 % de daño'],
  amplifiers: ['Amplificadores', 'Antenas y camiones cubren y ven 8 casillas'],
  rangefinder: ['Telémetro', 'Artillería +2 casillas de alcance y visión'],
};
const BUILDABLE: BuildingType[] = ['depot', 'barracks', 'hangar', 'cradle', 'tower', 'plant', 'relay'];

const st = createGame({ seed, perSide });
const app = new Application();
await app.init({ resizeTo: window, background: '#14170f', antialias: true });
document.body.prepend(app.canvas);

const view = new GameView(st.map, PLAYER);
// Acceso para pruebas automatizadas del navegador.
(window as unknown as { __game: unknown }).__game = { st, world: null as unknown, pending: null as unknown };
const dragGfx = new Graphics();
app.stage.addChild(view.world, dragGfx);

// ------------------------------------------------------------ cámara
const world = view.world;
Object.assign((window as unknown as { __game: object }).__game, { world });
function centerOn(x: number, y: number): void {
  world.position.set(app.screen.width / 2 - isoX(x, y) * world.scale.x, app.screen.height / 2 - isoY(x, y) * world.scale.y);
}
const myHq = st.buildings.find((b) => b.owner === PLAYER)!;
centerOn((myHq.tx + 6) * SUB, (myHq.ty + 2) * SUB);

const sfx = new Sfx();
// El audio del navegador solo arranca tras un gesto del usuario.
addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
addEventListener('keydown', () => sfx.unlock(), { capture: true });

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    toggleChat();
    return;
  }
  if (document.activeElement === chat) {
    if (e.key === 'Escape') closeChat();
    return;
  }
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'p') setPaused(!paused);
  if (k === 'f') toggleFullscreen();
  if (k === 'i') nextIdleWorker();
  if (k === ' ') {
    // Espacio: centrar la cámara en el cuartel general propio.
    e.preventDefault();
    const hq = st.buildings.find((b) => b.owner === PLAYER && b.type === 'hq');
    if (hq) centerOn((hq.tx + hq.size / 2) * SUB, (hq.ty + hq.size / 2) * SUB);
  }
  const action = HOTKEYS.includes(k) && !e.ctrlKey && !e.metaKey ? currentActions().find((a) => a.key === k) : undefined;
  if (action) {
    if (action.enabled) action.run(e.shiftKey);
    else sfx.play('error');
    renderPanel();
  }
  if (e.key === 'Escape') {
    if (placing) placing = null;
    else if (targeting) targeting = false;
    else setPaused(!paused);
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

app.canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const before = world.toLocal({ x: e.clientX, y: e.clientY });
    const s = Math.min(2.5, Math.max(0.3, world.scale.x * Math.exp(-e.deltaY * 0.0015)));
    world.scale.set(s);
    world.position.set(e.clientX - before.x * s, e.clientY - before.y * s);
  },
  { passive: false },
);

// ------------------------------------------------------------ selección, órdenes y cursor
const selected = new Set<number>();
const pending: Command[] = [];
Object.assign((window as unknown as { __game: object }).__game, { pending });
const log: Command[] = [];

// Continuar una partida desde un replay: se reproducen sus comandos (incluidos los de la IA) hasta su último tick.
let loadedReplay = '';
if (params.has('load')) {
  const text = sessionStorage.getItem('replay');
  sessionStorage.removeItem('replay');
  if (text) {
    const r = JSON.parse(text) as { commands: Command[]; finalTick: number; finalHash: number };
    const byTick = new Map<number, Command[]>();
    for (const c of r.commands) byTick.set(c.tick, [...(byTick.get(c.tick) ?? []), c]);
    while (st.tick < r.finalTick) {
      const cmds = byTick.get(st.tick) ?? [];
      step(st, cmds);
      log.push(...cmds);
    }
    loadedReplay = hashState(st) === r.finalHash ? 'Partida restaurada desde el replay' : 'Replay cargado, pero el estado no coincide (¿cambió el código?)';
  }
}
let dragStart: Pos | null = null;
let panFrom: Pos | null = null;
let mouse: Pos = { x: 0, y: 0 };
let mouseInside = false;
// Al salir el cursor de la ventana, `mouseout` llega sin destino: dejar de desplazar la cámara.
addEventListener('mouseout', (e) => {
  if (!e.relatedTarget) mouseInside = false;
});
addEventListener('blur', () => (mouseInside = false));
/** Último clic sobre una unidad propia, para detectar el doble clic. */
let lastClick = { time: 0, kind: '', x: 0, y: 0 };
/** Modo "avanzar atacando": el próximo clic izquierdo elige el destino. */
let targeting = false;
/** Edificio que se está colocando (modo fantasma). */
let placing: BuildingType | null = null;

function selectedUnits(): Unit[] {
  return [...selected].map((id) => st.byId.get(id)).filter((u): u is Unit => !!u && u.owner === PLAYER);
}

/** Edificios propios seleccionados (vacío si también hay unidades). */
function selectedBuildings(): Building[] {
  if (selectedUnits().length > 0) return [];
  return [...selected].map((id) => st.buildingsById.get(id)).filter((b): b is Building => !!b && b.owner === PLAYER);
}

/** Unidades seleccionadas que pueden avanzar atacando (todas menos los obreros). */
function selectedMilitary(): Unit[] {
  return selectedUnits().filter((u) => u.type !== 'worker');
}

/** Manda la selección militar a avanzar atacando hacia un punto del mundo. */
function attackMove(x: number, y: number, queued = false): void {
  const ids = selectedMilitary().map((u) => u.id);
  if (ids.length === 0) return;
  pending.push({ tick: st.tick, player: PLAYER, kind: 'amove', units: ids, x, y, queued });
  view.flash(x, y, 0xef4444);
  sfx.play('ackAttack');
}

function worldAt(px: number, py: number): Pos {
  const local = world.toLocal({ x: px, y: py });
  return screenToWorld(local.x, local.y);
}

function tileAt(px: number, py: number): { tx: number; ty: number } {
  const w = worldAt(px, py);
  return { tx: Math.floor(w.x / SUB), ty: Math.floor(w.y / SUB) };
}

/** Unidad bajo el cursor, usando la silueta alta de cada tipo. */
function unitAt(px: number, py: number, pred: (u: Unit) => boolean): Unit | null {
  const s = world.scale.x;
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const u of st.units) {
    if (!pred(u)) continue;
    const box = UNIT_BOX[u.type];
    const feet = world.toGlobal({ x: isoX(u.x, u.y), y: isoY(u.x, u.y) });
    const dx = Math.abs(px - feet.x);
    const up = feet.y - py;
    if (dx > (box.w / 2 + 3) * s || up < -4 * s || up > (box.h + 3) * s) continue;
    if (dx < bestD) {
      best = u;
      bestD = dx;
    }
  }
  return best;
}

/** Placement del fantasma: la huella se centra en el cursor. */
function ghostTile(px: number, py: number, type: BuildingType): { tx: number; ty: number } {
  const w = worldAt(px, py);
  const size = BUILDINGS[type].size;
  if (type === 'plant') {
    // La central se engancha a la veta más cercana al cursor.
    const v = st.vents
      .map((v) => ({ v, d: (v.tx * SUB + SUB / 2 - w.x) ** 2 + (v.ty * SUB + SUB / 2 - w.y) ** 2 }))
      .sort((a, b) => a.d - b.d)[0];
    if (v && v.d <= (5 * SUB) ** 2) return { tx: v.v.tx - 1, ty: v.v.ty - 1 };
  }
  return { tx: Math.round(w.x / SUB - size / 2), ty: Math.round(w.y / SUB - size / 2) };
}

type Intent = 'attack' | 'gather' | 'construct' | 'repair' | 'none';

/** Qué haría un clic derecho en este punto con la selección actual. */
function intentAt(px: number, py: number): { kind: Intent; target: number } {
  const us = selectedUnits();
  if (us.length === 0) return { kind: 'none', target: 0 };
  const enemy = unitAt(px, py, (u) => u.owner !== PLAYER && isVisible(st, PLAYER, u.x, u.y));
  if (enemy) return { kind: 'attack', target: enemy.id };
  const { tx, ty } = tileAt(px, py);
  const e = entityAtTile(st, tx, ty);
  const hasWorkers = us.some((u) => u.type === 'worker');
  // Edificio enemigo: atacable si está a la vista o recordado (zona explorada).
  if (e?.kind === 'building' && e.ent.owner !== PLAYER && isExplored(st, PLAYER, (tx + 0.5) * SUB, (ty + 0.5) * SUB)) return { kind: 'attack', target: e.ent.id };
  if (e?.kind === 'node' && !isExplored(st, PLAYER, (tx + 0.5) * SUB, (ty + 0.5) * SUB)) return { kind: 'none', target: 0 };
  if (e?.kind === 'building' && !e.ent.complete && hasWorkers) return { kind: 'construct', target: e.ent.id };
  if (e?.kind === 'building' && e.ent.hp < e.ent.maxHp && hasWorkers) return { kind: 'repair', target: e.ent.id };
  if (e?.kind === 'node' && hasWorkers) return { kind: 'gather', target: e.ent.id };
  return { kind: 'none', target: 0 };
}

function cursorUrl(svg: string, hx: number, hy: number, fallback: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}
const CURSORS: Record<Intent, string> = {
  attack: cursorUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><g stroke-linecap='round'><path d='M3 3L18 18' stroke='#111' stroke-width='6'/><path d='M3 3L18 18' stroke='#e5e7eb' stroke-width='3'/><path d='M13 21L21 13' stroke='#111' stroke-width='6'/><path d='M13 21L21 13' stroke='#c9a44a' stroke-width='3'/><path d='M19 19L25 25' stroke='#111' stroke-width='6'/><path d='M19 19L25 25' stroke='#7c4a1e' stroke-width='3'/></g></svg>",
    3,
    3,
    'crosshair',
  ),
  gather: cursorUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><g stroke-linecap='round' fill='none'><path d='M4 9Q14 1 24 9' stroke='#111' stroke-width='6'/><path d='M4 9Q14 1 24 9' stroke='#9ca3af' stroke-width='3'/><path d='M14 6L14 26' stroke='#111' stroke-width='6'/><path d='M14 6L14 26' stroke='#7c4a1e' stroke-width='3'/></g></svg>",
    4,
    9,
    'pointer',
  ),
  construct: cursorUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><g stroke-linecap='round'><path d='M8 12L24 26' stroke='#111' stroke-width='6'/><path d='M8 12L24 26' stroke='#7c4a1e' stroke-width='3'/><path d='M3 10L12 3L16 8L8 14Z' fill='#9ca3af' stroke='#111' stroke-width='2'/></g></svg>",
    4,
    4,
    'pointer',
  ),
  repair: '',
  none: 'default',
};
CURSORS.repair = CURSORS.construct;

app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
app.canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) panFrom = { x: e.clientX, y: e.clientY };

  if (placing) {
    if (e.button === 0) {
      const { tx, ty } = ghostTile(e.clientX, e.clientY, placing);
      const workers = selectedUnits().filter((u) => u.type === 'worker').map((u) => u.id);
      if (!canPlaceBuilding(st, placing, tx, ty) || st.players[PLAYER].metal < BUILDINGS[placing].cost) {
        sfx.play('error');
        return;
      }
      pending.push({ tick: st.tick, player: PLAYER, kind: 'build', units: workers, building: placing, tx, ty, queued: e.shiftKey });
      sfx.play('place');
      if (!e.shiftKey) placing = null;
    } else if (e.button === 2) placing = null;
    return;
  }

  if (targeting) {
    if (e.button === 0) {
      const w = worldAt(e.clientX, e.clientY);
      attackMove(Math.round(w.x), Math.round(w.y), e.shiftKey);
      if (!e.shiftKey) targeting = false;
    } else if (e.button === 2) targeting = false;
    return;
  }

  if (e.button === 0) dragStart = { x: e.clientX, y: e.clientY };
  if (e.button !== 2) return;
  const us = selectedUnits();
  const w = worldAt(e.clientX, e.clientY);
  const x = Math.round(w.x);
  const y = Math.round(w.y);
  const bs = selectedBuildings();
  if (us.length === 0 && bs.length) {
    for (const b of bs) pending.push({ tick: st.tick, player: PLAYER, kind: 'rally', building: b.id, x, y });
    view.flash(x, y, 0xf3e9d8);
    sfx.play('ack');
    return;
  }
  if (us.length === 0) return;
  const ids = us.map((u) => u.id);
  const intent = intentAt(e.clientX, e.clientY);
  const workers = us.filter((u) => u.type === 'worker').map((u) => u.id);
  const others = us.filter((u) => u.type !== 'worker').map((u) => u.id);
  switch (intent.kind) {
    case 'attack':
      pending.push({ tick: st.tick, player: PLAYER, kind: 'attack', units: ids, target: intent.target });
      view.flash(x, y, 0xef4444);
      sfx.play('ackAttack');
      return;
    case 'gather':
    case 'construct':
    case 'repair':
      pending.push({ tick: st.tick, player: PLAYER, kind: intent.kind, units: workers, target: intent.target, queued: e.shiftKey });
      if (others.length) pending.push({ tick: st.tick, player: PLAYER, kind: 'move', units: others, x, y, queued: e.shiftKey });
      view.flash(x, y, 0xfacc15);
      sfx.play('ack');
      return;
    case 'none':
      pending.push({ tick: st.tick, player: PLAYER, kind: 'move', units: ids, x, y, queued: e.shiftKey });
      view.flash(x, y, 0x86efac);
      sfx.play('ack');
  }
});

/** Animaciones y sonidos de los efectos del último tick. El sonido baja y se panea según la pantalla. */
function playFx(): void {
  view.addFx(st.fx, st, PLAYER);
  const w = app.screen.width;
  const h = app.screen.height;
  for (const f of st.fx) {
    const mine = f.owner === PLAYER;
    if (f.kind === 'built' && mine) {
      sfx.play('built');
      continue;
    }
    if (f.kind === 'powerLost' && mine) {
      sfx.play('warning');
      continue;
    }
    if (f.kind === 'shutdown' && mine) {
      sfx.play('powerDown');
      continue;
    }
    if (f.kind === 'researched' && mine) {
      sfx.play('built');
      continue;
    }
    if (f.kind === 'trained' && mine) {
      sfx.play('trained');
      continue;
    }
    const p = world.toGlobal({ x: isoX(f.x, f.y), y: isoY(f.x, f.y) });
    if (!mine && !isVisible(st, PLAYER, f.x, f.y)) continue;
    const off = Math.max(0, -p.x, p.x - w, -p.y, p.y - h);
    if (off > w / 2) continue;
    const vol = off === 0 ? 1 : 0.35;
    const pan = ((p.x / w) * 2 - 1) * 0.7;
    switch (f.kind) {
      case 'shot':
        if (!UNITS[f.utype].projectile) sfx.play(f.utype === 'worker' ? 'hit' : f.utype === 'soldier' ? 'shotSoldier' : f.utype === 'mech' ? 'shotMech' : 'shotColossus', pan, vol);
        break;
      case 'gather':
        if (mine) sfx.play('gather', pan, vol * 0.8);
        break;
      case 'reactor':
        sfx.play('destroyed', pan, vol);
        sfx.play('explosion', pan, vol);
        break;
      case 'deployed':
        if (mine) sfx.play('place', pan, vol);
        break;
      case 'launch':
        sfx.play(f.utype === 'artillery' ? 'mortar' : 'launch', pan, vol);
        break;
      case 'explosion':
        sfx.play(f.utype === 'artillery' ? 'explosionSmall' : 'explosion', pan, vol);
        break;
      case 'towerShot':
        sfx.play('shotTower', pan, vol);
        break;
      case 'repair':
        if (mine) sfx.play('repair', pan, vol);
        break;
      case 'deliver':
        if (mine) sfx.play('deliver', pan, vol);
        break;
      case 'death':
        sfx.play(f.utype === 'worker' || f.utype === 'soldier' ? 'death' : 'deathBig', pan, vol);
        break;
      case 'destroyed':
        sfx.play('destroyed', pan, vol);
        break;
    }
  }
}
addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  mouseInside = true;
  if (panFrom) {
    world.x += e.clientX - panFrom.x;
    world.y += e.clientY - panFrom.y;
    panFrom = { x: e.clientX, y: e.clientY };
  }
  dragGfx.clear();
  if (dragStart) {
    dragGfx
      .rect(Math.min(dragStart.x, e.clientX), Math.min(dragStart.y, e.clientY), Math.abs(e.clientX - dragStart.x), Math.abs(e.clientY - dragStart.y))
      .fill({ color: 0xffffff, alpha: 0.08 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
  }
});
addEventListener('pointerup', (e) => {
  if (e.button === 1) panFrom = null;
  if (e.button !== 0 || !dragStart) return;
  if (!e.shiftKey) selected.clear();
  const x0 = Math.min(dragStart.x, e.clientX);
  const x1 = Math.max(dragStart.x, e.clientX);
  const y0 = Math.min(dragStart.y, e.clientY);
  const y1 = Math.max(dragStart.y, e.clientY);
  if (x1 - x0 < 5 && y1 - y0 < 5) {
    const u = unitAt(e.clientX, e.clientY, (u) => u.owner === PLAYER);
    const { tx, ty } = tileAt(e.clientX, e.clientY);
    const ent = u ? null : entityAtTile(st, tx, ty);
    const now = performance.now();
    const onScreen = (p: Pos) => p.x >= 0 && p.y >= 0 && p.x <= app.screen.width && p.y <= app.screen.height;
    const b = ent?.kind === 'building' && ent.ent.owner === PLAYER ? ent.ent : null;
    const kind = u ? `u:${u.type}` : b ? `b:${b.type}` : '';
    const double = kind !== '' && kind === lastClick.kind && now - lastClick.time < 350 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8;
    if (u && double) {
      // Doble clic: todas las unidades propias de ese tipo que estén en pantalla.
      for (const o of st.units) {
        if (o.owner !== PLAYER || o.type !== u.type) continue;
        if (onScreen(world.toGlobal({ x: isoX(o.x, o.y), y: isoY(o.x, o.y) - UNIT_BOX[o.type].h / 2 }))) selected.add(o.id);
      }
    } else if (b && double) {
      // Doble clic en un edificio: todos los propios del mismo tipo en pantalla.
      selected.clear();
      for (const o of st.buildings) {
        if (o.owner !== PLAYER || o.type !== b.type) continue;
        const half = (o.size * SUB) / 2;
        if (onScreen(world.toGlobal({ x: isoX(o.tx * SUB + half, o.ty * SUB + half), y: isoY(o.tx * SUB + half, o.ty * SUB + half) }))) selected.add(o.id);
      }
    } else if (u) selected.add(u.id);
    else if (b) {
      selected.clear();
      selected.add(b.id);
    }
    lastClick = double ? { time: 0, kind: '', x: 0, y: 0 } : { time: now, kind, x: e.clientX, y: e.clientY };
  } else {
    for (const u of st.units) {
      if (u.owner !== PLAYER) continue;
      const box = UNIT_BOX[u.type];
      const p = world.toGlobal({ x: isoX(u.x, u.y), y: isoY(u.x, u.y) - box.h / 2 });
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(u.id);
    }
  }
  dragStart = null;
  dragGfx.clear();
});

// ------------------------------------------------------------ bucle: simulación a 20 Hz, render a los FPS del monitor
let paused = false;
let speed = 1;
let acc = 0;
let prev = new Map<number, Pos>();
let simMs = 0;
let hash = hashState(st);

app.ticker.add((t) => {
  if (!paused) {
    acc += t.deltaMS * speed;
    let n = 0;
    const maxSteps = Math.ceil(5 * speed);
    while (acc >= TICK_MS && n < maxSteps) {
      prev = new Map(st.units.map((u) => [u.id, { x: u.x, y: u.y }]));
      const cmds = pending.splice(0);
      if (aiOn) cmds.push(...aiCommands(st, AI_PLAYER));
      const t0 = performance.now();
      step(st, cmds);
      playFx();
      simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
      log.push(...cmds);
      if (st.tick % 20 === 0) hash = hashState(st);
      acc -= TICK_MS;
      n++;
    }
    if (n === maxSteps) acc = 0;
  }

  const pan = 12 * t.deltaTime;
  // Cámara: flechas o ratón en el borde de la ventana (como en AoE).
  // Zona de desplazamiento dentro de la página (no hace falta tocar el borde de la ventana): más cerca
  // del borde, más rápido. Así el cursor no llega a las pestañas, la barra del sistema ni otro monitor.
  const EDGE = 40;
  const inside = mouseInside && !dragStart && !panFrom && !miniDrag && document.hasFocus();
  const push = (d: number) => (inside && d < EDGE ? 0.35 + 0.9 * (1 - Math.max(0, d) / EDGE) : 0);
  const left = Math.max(keys.has('arrowleft') ? 1 : 0, push(mouse.x));
  const right = Math.max(keys.has('arrowright') ? 1 : 0, push(app.screen.width - mouse.x));
  const up = Math.max(keys.has('arrowup') ? 1 : 0, push(mouse.y));
  const down = Math.max(keys.has('arrowdown') ? 1 : 0, push(app.screen.height - mouse.y));
  world.x += pan * (left - right);
  world.y += pan * (up - down);

  for (const id of selected) if (!st.byId.has(id) && !st.buildingsById.has(id)) selected.delete(id);
  if (placing && !selectedUnits().some((u) => u.type === 'worker')) placing = null;
  if (targeting && selectedMilitary().length === 0) targeting = false;
  if (targeting) {
    view.setGhost(null, 0, 0, false);
    app.canvas.style.cursor = CURSORS.attack;
  } else if (placing) {
    const { tx, ty } = ghostTile(mouse.x, mouse.y, placing);
    view.setGhost(placing, tx, ty, canPlaceBuilding(st, placing, tx, ty));
    app.canvas.style.cursor = 'default';
  } else {
    view.setGhost(null, 0, 0, false);
    app.canvas.style.cursor = CURSORS[intentAt(mouse.x, mouse.y).kind];
  }
  // La red se ve solo cuando importa: con mechas o nodos seleccionados, al colocar red o con Alt.
  view.setPowerOverlay(
    keys.has('alt') ||
      placing === 'plant' ||
      placing === 'relay' ||
      [...selected].some((id) => st.byId.get(id)?.needsPower || BUILDINGS[st.buildingsById.get(id)?.type ?? 'hq'].power),
  );
  view.sync(st, prev, paused ? 1 : acc / TICK_MS, selected);
  view.updateMarkers(t.deltaMS / 1000);
  view.updateFx(paused ? 0 : t.deltaMS / 1000);
});

// ------------------------------------------------------------ HUD
const $ = (id: string) => document.getElementById(id)!;
const panel = $('panel');
const info = $('info');
const actions = $('actions');
const alertBox = $('alert');
let actionsKey = '';
let alertUntil = 0;
let lastEvent: (typeof st.events)[number] | undefined;

/** Rejilla de atajos al estilo AoE: la posición del botón en el panel decide su tecla. */
const HOTKEYS = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];

interface Action {
  key: string;
  label: string;
  sub: string;
  enabled: boolean;
  /** `shift`: variante en tanda (5 unidades) o encolada. */
  run: (shift: boolean) => void;
}

/** Acciones disponibles para la selección actual, en orden de tecla. */
function currentActions(): Action[] {
  const metal = st.players[PLAYER].metal;
  const us = selectedUnits();
  const bs = selectedBuildings().filter((b) => b.complete);
  const out: Omit<Action, 'key'>[] = [];
  const trucks = us.filter((u) => u.type === 'truck');
  if (trucks.length > 0 && trucks.length === us.length) {
    // Solo camiones: desplegar o replegar.
    const anyMobile = trucks.some((u) => u.deployState === 0);
    out.push({
      label: anyMobile ? 'Desplegar antena' : 'Replegar',
      sub: anyMobile ? 'funciona como antena; no se mueve' : 'vuelve a poder moverse',
      enabled: true,
      run: () => {
        pending.push({ tick: st.tick, player: PLAYER, kind: 'deploy', units: trucks.map((u) => u.id), on: anyMobile });
        sfx.play('ack');
      },
    });
  } else if (selectedMilitary().length > 0) {
    out.push({
      label: `Avanzar atacando${targeting ? ' ◂' : ''}`,
      sub: 'luego clic en el mapa',
      enabled: true,
      run: () => {
        targeting = true;
        placing = null;
        sfx.play('ack');
      },
    });
    out.push({
      label: 'Detener',
      sub: 'olvidan su orden',
      enabled: true,
      run: () => {
        pending.push({ tick: st.tick, player: PLAYER, kind: 'stop', units: us.map((u) => u.id) });
        targeting = false;
        sfx.play('ack');
      },
    });
  } else if (us.some((u) => u.type === 'worker')) {
    for (const t of BUILDABLE) {
      const s = BUILDINGS[t];
      const needGen = BUILDING_GEN[t] ?? 1;
      const locked = needGen > st.players[PLAYER].gen;
      out.push({
        label: `${BUILDING_NAMES[t]}${placing === t ? ' ◂' : ''}`,
        sub: locked ? `Requiere Gen-${needGen}` : `${s.cost} metal`,
        enabled: !locked && metal >= s.cost,
        run: () => {
          placing = t;
          sfx.play('ack');
        },
      });
    }
  } else if (bs.length > 0) {
    for (const unit of BUILDINGS[bs[0].type].trains) {
      const u = UNITS[unit];
      const locked = UNIT_GEN[unit] > st.players[PLAYER].gen;
      out.push({
        label: `Entrenar ${UNIT_NAMES[unit][0]}${bs.length > 1 ? ` ×${bs.length}` : ''}`,
        sub: locked ? `Requiere Gen-${UNIT_GEN[unit]}` : `${u.cost} metal c/u · ${u.trainTime / 20} s · Shift: 5`,
        enabled: !locked && metal >= u.cost && bs.some((b) => b.queue.length < 10),
        run: (shift) => {
          // Una por edificio (cinco con Shift), primero los de cola más corta, hasta donde alcance el metal.
          let budget = st.players[PLAYER].metal;
          const order = bs.slice().sort((a, z) => a.queue.length - z.queue.length || a.id - z.id);
          const queued = new Map(order.map((b) => [b.id, b.queue.length]));
          for (let round = 0; round < (shift ? 5 : 1); round++) {
            for (const b of order) {
              if (budget < u.cost || queued.get(b.id)! >= 10) continue;
              pending.push({ tick: st.tick, player: PLAYER, kind: 'train', building: b.id, unit });
              queued.set(b.id, queued.get(b.id)! + 1);
              budget -= u.cost;
            }
          }
          sfx.play('ack');
        },
      });
    }
    // Investigaciones de este tipo de edificio (en el primero libre de los seleccionados).
    const pl = st.players[PLAYER];
    for (const tech of TECH_ORDER) {
      const t = TECHS[tech];
      if (t.building !== bs[0].type || pl.techs.includes(tech)) continue;
      if ((tech === 'gen3' && pl.gen < 2) || st.buildings.some((b) => b.owner === PLAYER && b.research?.tech === tech)) continue;
      const missing = t.requires.filter((r) => !st.buildings.some((b) => b.owner === PLAYER && b.type === r && b.complete));
      const free = bs.find((b) => !b.research);
      const why = t.gen > pl.gen ? `Requiere Gen-${t.gen}` : missing.length ? `Requiere ${missing.map((r) => BUILDING_NAMES[r].toLowerCase()).join(' y ')}` : !free ? 'Edificio ocupado' : `${t.cost} metal · ${t.time / 20} s`;
      out.push({
        label: TECH_INFO[tech][0],
        sub: why === `${t.cost} metal · ${t.time / 20} s` ? `${TECH_INFO[tech][1]} · ${why}` : why,
        enabled: t.gen <= pl.gen && missing.length === 0 && !!free && metal >= t.cost,
        run: () => {
          if (!free) return;
          pending.push({ tick: st.tick, player: PLAYER, kind: 'research', building: free.id, tech });
          sfx.play('ack');
        },
      });
    }
  }
  return out.map((a, i) => ({ ...a, key: HOTKEYS[i] ?? '' }));
}

/** Stats de un tipo de unidad, en unidades legibles (casillas, segundos). */
function statsLine(t: UnitType): string {
  const u = UNITS[t];
  if (u.damage === 0) return `Sin armas · Velocidad ${(u.speed * 20 / SUB).toLocaleString('es', { maximumFractionDigits: 1 })} cas./s · Visión ${u.sight / SUB} cas. · desplegado cubre y ve ${BUILDINGS.relay.power!.cover} cas.`;
  const tiles = (v: number) => (v / SUB).toLocaleString('es', { maximumFractionDigits: 1 });
  const parts = [
    `Ataque ${u.damage}${u.vsBuilding !== u.damage ? ` (${u.vsBuilding} a edificios)` : ''}${u.splash ? ` en área de ${tiles(u.splash)} cas.` : ''}`,
    `Alcance ${u.range < SUB ? 'cuerpo a cuerpo' : `${tiles(u.range)} cas.`}`,
    `Cadencia ${(u.cooldown / 20).toLocaleString('es', { maximumFractionDigits: 2 })} s`,
    `Velocidad ${tiles(u.speed * 20)} cas./s`,
    `Visión ${tiles(u.sight)} cas.`,
  ];
  return parts.join(' · ');
}

function renderPanel(): void {
  const us = selectedUnits();
  const bs = selectedBuildings();
  const b = bs.length === 1 ? bs[0] : undefined;
  const lines: string[] = [];

  if (us.length > 0) {
    const groups = new Map<UnitType, Unit[]>();
    for (const u of us) groups.set(u.type, [...(groups.get(u.type) ?? []), u]);
    for (const [t, g] of groups) {
      const hp = g.reduce((s, u) => s + Math.max(0, u.hp), 0);
      const max = g.reduce((s, u) => s + u.maxHp, 0);
      const head = g.length === 1 ? UNIT_NAMES[t][0] : `${g.length} ${UNIT_NAMES[t][1]}`;
      const queued = g.length === 1 && g[0].orderQueue.length ? ` · ${g[0].orderQueue.length} órdenes en cola` : '';
      lines.push(`${head.toUpperCase()} · vida ${hp}/${max}${g.length === 1 && g[0].carry ? ` · carga ${g[0].carry} de metal` : ''}${queued}`);
      lines.push(`  ${statsLine(t)}`);
      if (UNITS[t].needsPower && !st.players[PLAYER].noPower) {
        const off = g.filter((u) => u.battery <= 0).length;
        const out = g.filter((u) => u.battery > 0 && !isPowered(st, PLAYER, u.x, u.y));
        const parts = [];
        if (g.length - off - out.length > 0) parts.push(g.length === 1 ? 'conectado a la red' : `${g.length - off - out.length} conectados`);
        if (out.length) parts.push(`fuera de la red: batería ${Math.ceil(Math.min(...out.map((u) => u.battery)) / 20)} s`);
        if (off) parts.push(g.length === 1 ? 'APAGADO: sin energía' : `${off} apagados`);
        lines.push(`  Energía: ${parts.join(' · ')} (batería máx. ${BATTERY_TICKS / 20} s)`);
      }
    }
  } else if (b) {
    const s = BUILDINGS[b.type];
    lines.push(`${BUILDING_NAMES[b.type].toUpperCase()} · vida ${Math.max(0, b.hp)}/${b.maxHp}`);
    if (s.power && b.complete) lines.push(b.powered ? `Con energía · cubre ${s.power.cover} cas. · enlaza a ${s.power.link} cas.` : 'SIN ENERGÍA: no enlaza con ninguna central');
    if (!b.complete) lines.push(`En construcción: ${Math.floor((100 * b.progress) / s.buildTime)}%`);
    else if (s.trains.length) {
      const q = b.queue.length;
      let l = q ? `Entrenando ${UNIT_NAMES[b.queue[0]][0]}: ${Math.floor((100 * b.trainTicks) / UNITS[b.queue[0]].trainTime)}% · en cola ${q}` : 'Cola vacía';
      if (q && b.trainTicks >= UNITS[b.queue[0]].trainTime) l += ' · esperando población';
      lines.push(l);
      for (const t of s.trains) lines.push(`  ${UNIT_NAMES[t][0]}: ${statsLine(t)}`);
    }
  } else if (bs.length > 1) {
    const s = BUILDINGS[bs[0].type];
    const hp = bs.reduce((a, x) => a + Math.max(0, x.hp), 0);
    const max = bs.reduce((a, x) => a + x.maxHp, 0);
    lines.push(`${bs.length} × ${BUILDING_NAMES[bs[0].type].toUpperCase()} · vida ${hp}/${max}`);
    if (s.trains.length) {
      lines.push(`En cola: ${bs.map((x) => x.queue.length).join(' · ')}`);
      for (const t of s.trains) lines.push(`  ${UNIT_NAMES[t][0]}: ${statsLine(t)}`);
    }
  }

  renderQueue(bs.filter((x) => x.complete && (x.queue.length > 0 || x.research)));

  const list = currentActions();
  panel.style.display = lines.length ? 'flex' : 'none';
  info.textContent = lines.join('\n');
  const key = list.map((a) => `${a.key}${a.label}${a.enabled}`).join('|');
  if (key !== actionsKey) {
    actionsKey = key;
    actions.replaceChildren(
      ...list.map((a) => {
        const el = document.createElement('button');
        el.innerHTML = `<span><kbd>${a.key.toUpperCase()}</kbd> ${a.label}</span><small>${a.sub}</small>`;
        el.disabled = !a.enabled;
        el.addEventListener('click', (ev) => {
          a.run(ev.shiftKey);
          el.blur();
        });
        return el;
      }),
    );
  }
}

setInterval(() => {
  $('metal').textContent = String(st.players[PLAYER].metal);
  $('pop').textContent = `${popUsed(st, PLAYER)} / ${st.players[PLAYER].popCap}`;
  $('gen').textContent = `GEN-${st.players[PLAYER].gen} · ${GEN_NAMES[st.players[PLAYER].gen]}`;
  $('debug').textContent = `tick ${st.tick} · ${app.ticker.FPS.toFixed(0)} fps · sim ${simMs.toFixed(2)} ms · hash ${hash.toString(16).padStart(8, '0')}${paused ? ' · PAUSA' : ''}`;
  renderPanel();

  const last = st.events[st.events.length - 1];
  if (last && last !== lastEvent) {
    if (last.kind === 'generation') {
      alertBox.textContent = last.player === PLAYER ? `Has alcanzado la GEN-${last.gen} · ${GEN_NAMES[last.gen]}` : `El enemigo ha alcanzado la GEN-${last.gen} · ${GEN_NAMES[last.gen]}`;
      sfx.play(last.player === PLAYER ? 'genUp' : 'alert');
    } else {
      alertBox.textContent = last.player === PLAYER ? 'Tu Cuna ha empezado a construir un COLOSO' : 'ALERTA · El enemigo está construyendo un COLOSO';
      sfx.play('alert');
    }
    alertBox.style.display = 'block';
    alertUntil = performance.now() + 6000;
  }
  lastEvent = last;
  if (performance.now() > alertUntil) alertBox.style.display = 'none';
}, 150);

$('replay').addEventListener('click', () => {
  const data = { version: 1, seed, perSide, commands: log, finalTick: st.tick, finalHash: hashState(st) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `replay-seed${seed}-t${st.tick}.json`;
  a.click();
});

// ------------------------------------------------------------ velocidad, trucos, fin de partida y carga de replays
for (const b of document.querySelectorAll<HTMLButtonElement>('.speed button')) {
  b.addEventListener('click', () => {
    speed = Number(b.dataset.speed);
    for (const o of document.querySelectorAll('.speed button')) o.classList.toggle('on', o === b);
    b.blur();
  });
}

const chat = $('chat') as HTMLInputElement;
const toast = $('toast');
let toastTimer = 0;

function showToast(text: string, color = '#7dffb0'): void {
  toast.textContent = text;
  toast.style.color = color;
  toast.style.borderColor = color;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.style.display = 'none'), 3500);
}

function closeChat(): void {
  chat.value = '';
  chat.style.display = 'none';
  chat.blur();
}

/** Enter abre la caja de trucos; un segundo Enter envía el código. */
function toggleChat(): void {
  if (chat.style.display !== 'block') {
    keys.clear();
    chat.style.display = 'block';
    chat.focus();
    return;
  }
  const code = chat.value.trim().toLowerCase();
  closeChat();
  if (!code) return;
  if (code === 'acero') {
    pending.push({ tick: st.tick, player: PLAYER, kind: 'grant', amount: 10000 });
    showToast('Truco: +10.000 de metal');
  } else if (code === 'poblacion' || code === 'población') {
    pending.push({ tick: st.tick, player: PLAYER, kind: 'togglePopCap' });
    showToast(st.players[PLAYER].popCap === 200 ? 'Truco: población máxima 1000' : 'Truco: población máxima 200');
  } else if (code === 'marco') {
    pending.push({ tick: st.tick, player: PLAYER, kind: 'toggleRevealMap' });
    showToast(st.players[PLAYER].revealMap ? 'Truco: mapa sin revelar' : 'Truco: mapa revelado');
  } else if (code === 'polo') {
    pending.push({ tick: st.tick, player: PLAYER, kind: 'toggleNoFog' });
    showToast(st.players[PLAYER].noFog ? 'Truco: niebla de guerra activada' : 'Truco: sin niebla de guerra');
  } else if (code === 'energia' || code === 'energía') {
    pending.push({ tick: st.tick, player: PLAYER, kind: 'toggleNoPower' });
    showToast(st.players[PLAYER].noPower ? 'Truco: tus mechas vuelven a necesitar la red' : 'Truco: tus mechas funcionan sin red');
  } else if (code === 'turbo') {
    pending.push({ tick: st.tick, player: PLAYER, kind: 'toggleInstant' });
    showToast(st.players[PLAYER].instant ? 'Truco: construcción y producción normales' : 'Truco: construcción y producción instantáneas');
  } else showToast(`Código desconocido: ${code}`, '#ff4d6d');
}

const end = $('end');
setInterval(() => {
  if (st.winner < 0 || end.style.display === 'flex') return;
  $('endText').textContent = st.winner === PLAYER ? 'VICTORIA' : 'DERROTA';
  end.style.display = 'flex';
  sfx.play(st.winner === PLAYER ? 'victory' : 'defeat');
}, 500);

const muteBtn = $('mute');
muteBtn.addEventListener('click', () => {
  sfx.muted = !sfx.muted;
  muteBtn.textContent = sfx.muted ? 'Sonido: no' : 'Sonido: sí';
  muteBtn.blur();
});

const loadFile = $('loadFile') as HTMLInputElement;
$('load').addEventListener('click', () => loadFile.click());
loadFile.addEventListener('change', async () => {
  const file = loadFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  const r = JSON.parse(text) as { seed: number; perSide: number };
  try {
    sessionStorage.setItem('replay', text);
  } catch {
    showToast('No se pudo guardar el replay en el navegador', '#ff4d6d');
    return;
  }
  const q = new URLSearchParams(location.search);
  q.set('seed', String(r.seed));
  q.set('n', String(r.perSide ?? 0));
  q.set('load', '1');
  location.search = q.toString();
});

if (loadedReplay) showToast(loadedReplay, loadedReplay.startsWith('Partida') ? '#7dffb0' : '#ff4d6d');

// ------------------------------------------------------------ minimapa
const minimap = new Minimap($('minimap') as HTMLCanvasElement, st, PLAYER);
let miniDrag = false;

function minimapWorld(e: MouseEvent): Pos {
  const r = minimap.canvas.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * minimap.canvas.width;
  const py = ((e.clientY - r.top) / r.height) * minimap.canvas.height;
  const w = minimap.toWorld(px, py);
  const max = st.map.w * SUB - 1;
  return { x: Math.min(max, Math.max(0, Math.round(w.x))), y: Math.min(max, Math.max(0, Math.round(w.y))) };
}

minimap.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
minimap.canvas.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  const w = minimapWorld(e);
  if (e.button === 0 && targeting) {
    attackMove(w.x, w.y);
    if (!e.shiftKey) targeting = false;
  } else if (e.button === 0) {
    miniDrag = true;
    centerOn(w.x, w.y);
  } else if (e.button === 2) {
    // Clic derecho: mandar la selección a ese punto del mapa.
    const ids = selectedUnits().map((u) => u.id);
    if (ids.length) {
      pending.push({ tick: st.tick, player: PLAYER, kind: 'move', units: ids, x: w.x, y: w.y });
      view.flash(w.x, w.y, 0x86efac);
      sfx.play('ack');
    }
  }
});
addEventListener('pointermove', (e) => {
  if (miniDrag) centerOn(minimapWorld(e).x, minimapWorld(e).y);
});
addEventListener('pointerup', () => (miniDrag = false));

setInterval(() => {
  const W = app.screen.width;
  const H = app.screen.height;
  minimap.draw([worldAt(0, 0), worldAt(W, 0), worldAt(W, H), worldAt(0, H)]);
}, 100);

// ------------------------------------------------------------ obreros ociosos
let idleCursor = 0;

function idleWorkers(): Unit[] {
  return st.units.filter((u) => u.owner === PLAYER && u.type === 'worker' && u.order.kind === 'idle' && u.orderQueue.length === 0);
}

/** Selecciona el siguiente obrero ocioso (en ciclo) y centra la cámara en él. */
function nextIdleWorker(): void {
  const list = idleWorkers();
  if (list.length === 0) {
    sfx.play('error');
    return;
  }
  const u = list[idleCursor++ % list.length];
  selected.clear();
  selected.add(u.id);
  placing = null;
  targeting = false;
  centerOn(u.x, u.y);
  sfx.play('ack');
}

const idleBtn = $('idle');
idleBtn.addEventListener('click', () => {
  nextIdleWorker();
  idleBtn.blur();
});
setInterval(() => {
  const n = idleWorkers().length;
  $('idleCount').textContent = String(n);
  idleBtn.classList.toggle('has', n > 0);
}, 200);

// ------------------------------------------------------------ cola de producción: un cuadro por tipo; clic = cancelar una
const queueBox = $('queue');
let queueKey = '';

function renderQueue(bs: Building[]): void {
  const counts = new Map<UnitType, number>();
  for (const b of bs) for (const t of b.queue) counts.set(t, (counts.get(t) ?? 0) + 1);
  const researching = bs.filter((b) => b.research);
  const key = bs.map((b) => b.id).join(',') + '|' + [...counts].map(([t, n]) => `${t}${n}`).join(',') + '|' + researching.map((b) => b.research!.tech).join(',');
  if (key !== queueKey) {
    queueKey = key;
    queueBox.replaceChildren(
      ...researching.map((b) => {
        const el = document.createElement('button');
        el.className = 'qbox research';
        el.dataset.building = String(b.id);
        el.title = 'Clic: cancelar la investigación (se devuelve el metal)';
        el.innerHTML = `<b>⚙</b><span>${TECH_INFO[b.research!.tech][0]}</span><i></i>`;
        el.addEventListener('click', () => {
          pending.push({ tick: st.tick, player: PLAYER, kind: 'cancelResearch', building: b.id });
          sfx.play('ack');
          el.blur();
        });
        return el;
      }),
      ...[...counts].map(([t, n]) => {
        const el = document.createElement('button');
        el.className = 'qbox';
        el.dataset.unit = t;
        el.title = 'Clic: cancelar una (se devuelve el metal)';
        el.innerHTML = `<b>${n}</b><span>${UNIT_NAMES[t][n === 1 ? 0 : 1]}</span><i></i>`;
        el.addEventListener('click', () => {
          // Cancela en el edificio con más unidades de ese tipo en cola.
          const b = bs
            .filter((x) => x.queue.includes(t) && st.buildingsById.has(x.id))
            .sort((a, z) => z.queue.length - a.queue.length || z.id - a.id)[0];
          if (!b) return;
          pending.push({ tick: st.tick, player: PLAYER, kind: 'cancel', building: b.id, unit: t });
          sfx.play('ack');
          el.blur();
        });
        return el;
      }),
    );
  }
  // Barra de avance: la unidad más adelantada de ese tipo.
  for (const el of queueBox.querySelectorAll<HTMLElement>('.qbox.research')) {
    const b = st.buildingsById.get(Number(el.dataset.building));
    const r = b?.research;
    (el.querySelector('i') as HTMLElement).style.width = r ? `${Math.min(100, (100 * r.ticks) / TECHS[r.tech].time)}%` : '0%';
  }
  for (const el of queueBox.querySelectorAll<HTMLElement>('.qbox:not(.research)')) {
    const t = el.dataset.unit as UnitType;
    const best = Math.max(0, ...bs.filter((b) => b.queue[0] === t).map((b) => b.trainTicks / UNITS[t].trainTime));
    (el.querySelector('i') as HTMLElement).style.width = `${Math.min(100, best * 100)}%`;
  }
}

// ------------------------------------------------------------ pausa y pantalla completa
const pauseScreen = $('pauseScreen');

function setPaused(v: boolean): void {
  paused = v;
  pauseScreen.style.display = v ? 'flex' : 'none';
}
$('resume').addEventListener('click', () => setPaused(false));

/** Pantalla completa: el borde de la pantalla pasa a ser el borde del juego. */
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  void document.documentElement.requestFullscreen().then(() => {
    // En pantalla completa el navegador usa Esc para salir; pedir la tecla para que Esc siga pausando
    // (para salir de pantalla completa: mantener Esc pulsado o la tecla F).
    const kb = (navigator as unknown as { keyboard?: { lock?: (keys: string[]) => Promise<void> } }).keyboard;
    void kb?.lock?.(['Escape']).catch(() => undefined);
  });
}
$('fullscreen').addEventListener('click', (e) => {
  toggleFullscreen();
  (e.currentTarget as HTMLElement).blur();
});
