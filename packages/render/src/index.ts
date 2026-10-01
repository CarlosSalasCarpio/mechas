import { Decor, decorReady, decorTexture } from './decor';
import { hasUnitArt, screenDir, unitFrame, type UnitAnim } from './units';
import { createTerrain, terrainTexturesReady, type TerrainMesh } from './terrain';
import { Container, Graphics, Matrix, Sprite as PixiSprite, Text, Texture, type Renderer } from 'pixi.js';
import {
  BATTERY_TICKS,
  BUILDINGS,
  buildingCenter,
  footprintVisible,
  isExplored,
  isPowered,
  linkOf,
  isVisible,
  batteryMax,
  TECHS,
  GRASS,
  ROCK,
  SUB,
  UNITS,
  type Building,
  type BuildingType,
  type Fx,
  type GameMap,
  type MetalNode,
  type State,
  type Unit,
  type UnitType,
} from '@epocas/sim';

// Proyección isométrica 2:1. La simulación no sabe nada de esto: solo el render.
export const TW = 64;
export const TH = 32;

export function isoX(x: number, y: number): number {
  return ((x - y) * TW) / (2 * SUB);
}

export function isoY(x: number, y: number): number {
  return ((x + y) * TH) / (2 * SUB);
}

/** Inversa de la proyección: píxel del mundo → subunidades (con decimales; el cliente redondea). */
export function screenToWorld(px: number, py: number): { x: number; y: number } {
  const a = (px * 2) / TW;
  const b = (py * 2) / TH;
  return { x: ((a + b) / 2) * SUB, y: ((b - a) / 2) * SUB };
}

/** Colores de jugador (hasta 6): azul, rojo, verde, amarillo, violeta y naranja. */
export const PLAYER_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308, 0xa855f7, 0xf97316];

/**
 * Colores por bando desde el punto de vista de `me`: fríos para su equipo (azul, verde, turquesa) y
 * cálidos para los enemigos (rojo, naranja, amarillo, violeta, rosa). Así nunca hay un aliado rojo.
 */
export function assignPlayerColors(teams: readonly number[], me: number): void {
  const allies = [0x3b82f6, 0x22c55e, 0x14b8a6, 0x6366f1, 0x84cc16, 0x0ea5e9];
  const enemies = [0xef4444, 0xf97316, 0xeab308, 0xa855f7, 0xec4899, 0xb91c1c];
  let a = 0;
  let e = 0;
  const colors = teams.map((t) => (t === teams[me] ? allies[a++] : enemies[e++]));
  PLAYER_COLORS.splice(0, PLAYER_COLORS.length, ...colors);
}

/** Mezcla dos colores (t = 0 → a, t = 1 → b). */
function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Silueta en pantalla de cada unidad (px a zoom 1): alta y delgada, a escala entre tipos. */
export const UNIT_BOX: Record<UnitType, { w: number; h: number }> = {
  worker: { w: 8, h: 17 },
  soldier: { w: 8, h: 21 },
  mech: { w: 22, h: 80 },
  colossus: { w: 44, h: 175 },
  siege: { w: 64, h: 150 },
  artillery: { w: 26, h: 96 },
  truck: { w: 34, h: 30 },
};

const BUILDING_HEIGHT: Record<BuildingType, number> = { hq: 70, depot: 30, barracks: 48, hangar: 84, cradle: 120, tower: 96, plant: 58, relay: 74 };
export const BUILDING_NAMES: Record<BuildingType, string> = {
  hq: 'Cuartel general',
  depot: 'Depósito',
  barracks: 'Barracas',
  hangar: 'Hangar',
  cradle: 'Cuna',
  tower: 'Torre',
  plant: 'Central',
  relay: 'Antena',
};

export interface Pos {
  x: number;
  y: number;
}

interface Sprite {
  /** Edificios enemigos: su huella, para saber cuándo se ve el sitio y olvidar el fantasma. */
  foot?: { tx: number; ty: number; size: number };
  c: Container;
  g: Graphics;
  key: string;
}

/** Altura (px) desde los pies a la que dispara cada unidad. */
const MUZZLE: Record<UnitType, number> = { worker: 8, soldier: 15, mech: 52, artillery: 92, truck: 10, colossus: 122, siege: 140 };

type Effect =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: number; width: number; alpha: number; age: number; dur: number; spr?: PixiSprite[] }
  | { kind: 'flash'; x: number; y: number; r: number; color: number; age: number; dur: number; spr?: PixiSprite[] }
  | { kind: 'ring'; x: number; y: number; r0: number; r1: number; color: number; width: number; age: number; dur: number; spr?: PixiSprite[] }
  | { kind: 'debris'; x: number; y: number; parts: { vx: number; vy: number; s: number }[]; color: number; age: number; dur: number; spr?: PixiSprite[] }
  | { kind: 'text'; t: Text; age: number; dur: number; spr?: PixiSprite[] }
  /** Bocanada de humo que crece, sube y se desvanece. */
  | { kind: 'puff'; x: number; y: number; r0: number; r1: number; rise: number; color: number; alpha: number; age: number; dur: number; spr?: PixiSprite[] };

/** Unidad en pantalla: cuerpo (textura horneada), sombra, anillo de selección y barras como sprites. */
interface UnitSprite {
  c: Container;
  body: PixiSprite;
  shadow: PixiSprite;
  ring: PixiSprite;
  bars: PixiSprite[];
  bodyKey: string;
  /** Máscara de color de equipo (solo unidades con arte prerenderizado). */
  team?: PixiSprite;
}

/** Estado de animación de una unidad con arte: dirección, desfase y último disparo. */
interface UnitAnimState {
  dir: number;
  phase: number;
  fired: number;
  sx: number;
  sy: number;
}

/** Máximo de efectos vivos a la vez: en batallas enormes se descartan los más viejos. */
const MAX_EFFECTS = 900;

interface Kick {
  dx: number;
  dy: number;
  age: number;
  dur: number;
}

interface Marker {
  x: number;
  y: number;
  color: number;
  ttl: number;
}

export class GameView {
  readonly world = new Container();
  private readonly entityLayer = new Container();
  private readonly groundFx = new Graphics();
  private readonly ghost = new Graphics();
  private readonly sprites = new Map<number, Sprite>();
  private markers: Marker[] = [];
  private readonly fxGfx = new Graphics();
  private readonly fxLayer = new Container();
  private readonly projGfx = new Graphics();
  /** Colas de los cohetes en este frame, para soltar humo en updateFx. */
  private rocketTails: (Pos & { small: boolean })[] = [];
  private effects: Effect[] = [];
  private readonly kicks = new Map<number, Kick>();
  /** Semilla propia para la dispersión de escombros: el render no toca el azar de la simulación. */
  private seed = 1;

  private readonly fogCanvas = document.createElement('canvas');
  private readonly fogTex: Texture;
  private readonly fog: PixiSprite;
  private fogDrawn = -1;
  private readonly ventGfx = new Graphics();
  private readonly powerGfx = new Graphics();
  private powerDrawn = -1;
  private showPower = false;
  private time = 0;
  /** Terreno: se construye en el primer `sync` (necesita el estado para las bases y las vetas). */
  private readonly terrainLayer = new Container();
  private terrain: TerrainMesh | null = null;
  private terrainBuilt = false;
  private decor: Decor | null = null;
  private readonly anim = new Map<number, UnitAnimState>();
  private readonly ventSprites: PixiSprite[] = [];
  private readonly ghostArt = new PixiSprite(Texture.EMPTY);
  /** Hologramas de los cimientos que tus obreros van a poner (aún no existen en el mapa). */
  private readonly pendingArt: PixiSprite[] = [];

  private readonly unitSprites = new Map<number, UnitSprite>();
  private readonly bodyCache = new Map<string, { tex: Texture; ax: number; ay: number }>();
  private readonly circleTex: Texture;
  private readonly ringTex: Texture;
  private readonly pool: PixiSprite[] = [];
  private readonly textPool: Text[] = [];
  private frame = 0;
  /** Zona visible del mundo (px del mundo, con margen): lo de fuera no se actualiza ni se dibuja. */
  private view = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };

  /** `me`: jugador local, el único cuya red se dibuja. `renderer`: para hornear las texturas de las unidades. */
  constructor(
    map: GameMap,
    private readonly me = 0,
    private readonly renderer?: Renderer,
  ) {
    this.circleTex = canvasTexture(64, (x, n) => {
      x.fillStyle = '#fff';
      x.beginPath();
      x.arc(n / 2, n / 2, n / 2 - 1, 0, Math.PI * 2);
      x.fill();
    });
    this.ringTex = canvasTexture(128, (x, n) => {
      x.strokeStyle = '#fff';
      x.lineWidth = 6;
      x.beginPath();
      x.arc(n / 2, n / 2, n / 2 - 4, 0, Math.PI * 2);
      x.stroke();
    });
    // Niebla: una textura de 1 píxel por casilla, proyectada en isométrico con suavizado (bordes suaves).
    this.fogCanvas.width = map.w;
    this.fogCanvas.height = map.h;
    this.fogTex = Texture.from(this.fogCanvas);
    this.fogTex.source.scaleMode = 'linear';
    this.fog = new PixiSprite(this.fogTex);
    this.fog.setFromMatrix(new Matrix(TW / 2, TH / 2, -TW / 2, TH / 2, 0, 0));
    this.world.addChild(this.terrainLayer, this.ventGfx, this.powerGfx, this.groundFx, this.entityLayer, this.fxGfx, this.projGfx, this.fxLayer, this.fog, this.ghost, this.ghostArt);
    this.ghostArt.blendMode = 'add';
    this.ghostArt.visible = false;
    this.entityLayer.sortableChildren = true;
  }

  /** Zona visible, en coordenadas del mundo (px antes del zoom). Se llama cada frame desde el cliente. */
  setViewport(x0: number, y0: number, x1: number, y1: number): void {
    const m = 250;
    this.view = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  }

  private inView(x: number, y: number): boolean {
    return x >= this.view.x0 && x <= this.view.x1 && y >= this.view.y0 && y <= this.view.y1;
  }

  /** Textura horneada del cuerpo de una unidad (una por tipo, color y estado), con su punto de anclaje en los pies. */
  private bodyTexture(b: BodyState): { tex: Texture; ax: number; ay: number } {
    const key = `${b.type}|${b.color}|${b.light}|${b.carry}|${b.deployState}|${b.nodePowered}`;
    let t = this.bodyCache.get(key);
    if (t) return t;
    const g = new Graphics();
    drawUnitBody(g, b);
    const bounds = g.getLocalBounds();
    const tex = this.renderer ? this.renderer.generateTexture({ target: g, resolution: 3, antialias: true }) : Texture.EMPTY;
    t = { tex, ax: -bounds.x / Math.max(1, bounds.width), ay: -bounds.y / Math.max(1, bounds.height) };
    g.destroy();
    this.bodyCache.set(key, t);
    return t;
  }

  /** Hologramas de cimientos pendientes: órdenes 'place' (actuales y en cola) de los obreros propios. */
  private drawPending(st: State): void {
    const seen = new Set<string>();
    let n = 0;
    for (const u of st.units) {
      if (u.owner !== this.me || u.type !== 'worker') continue;
      for (const o of [u.order, ...u.orderQueue]) {
        if (o.kind !== 'place') continue;
        const key = `${o.building}|${o.tx}|${o.ty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const frame = BUILDING_ART[o.building];
        const tex = frame ? decorTexture(frame) : null;
        if (!tex) continue;
        let spr = this.pendingArt[n];
        if (!spr) {
          spr = new PixiSprite(tex);
          spr.blendMode = 'add';
          this.pendingArt.push(spr);
          this.entityLayer.addChild(spr);
        }
        if (spr.texture !== tex) spr.texture = tex;
        spr.anchor.copyFrom(tex.defaultAnchor ?? { x: 0.5, y: 1 });
        const half = (BUILDINGS[o.building].size * SUB) / 2;
        spr.position.set(isoX(o.tx * SUB + half, o.ty * SUB + half), isoY(o.tx * SUB + half, o.ty * SUB + half));
        spr.zIndex = spr.position.y;
        spr.tint = 0x7fd4ff;
        spr.alpha = 0.3 + 0.1 * Math.sin(this.time * 4 + n);
        spr.visible = true;
        n++;
      }
    }
    for (let i = n; i < this.pendingArt.length; i++) this.pendingArt[i].visible = false;
  }

  /**
   * Unidad prerenderizada: elige dirección (hacia donde se mueve o hacia su objetivo) y fotograma
   * (disparo reciente, apuntando, caminando o en reposo).
   */
  private animateUnit(st: State, u: Unit, s: UnitSprite, sx: number, sy: number, color: number): void {
    let a = this.anim.get(u.id);
    if (!a) {
      a = { dir: 2, phase: (u.id * 0.37) % 1, fired: -9, sx, sy };
      this.anim.set(u.id, a);
    }
    const dx = sx - a.sx;
    const dy = sy - a.sy;
    a.sx = sx;
    a.sy = sy;
    const moving = dx * dx + dy * dy > 0.0004;
    const o = u.order;
    const target = o.kind === 'attack' ? (st.byId.get(o.target) ?? st.buildingsById.get(o.target)) : undefined;
    if (moving) a.dir = screenDir(dx, dy);
    else if (target) {
      const t = 'tx' in target ? buildingCenter(target) : target;
      a.dir = screenDir(isoX(t.x, t.y) - sx, isoY(t.x, t.y) - sy);
    }
    const since = this.time - a.fired;
    let anim: UnitAnim = 'idle';
    let f = Math.floor((this.time * 3 + a.phase * 6) % 6);
    const working = u.type === 'worker' && !moving && (o.kind === 'gather' || o.kind === 'build' || o.kind === 'repair');
    if (u.type === 'truck') {
      // Camión: los fotogramas de "fire" son el despliegue (gatos, mástil y parábolas); el último, desplegado.
      if (u.deployState === 2) {
        anim = 'fire';
        f = 3;
      } else if (u.deployState === 1) {
        anim = 'fire';
        f = Math.min(3, Math.floor((1 - u.deployTicks / 60) * 4));
      } else if (moving) {
        anim = 'walk';
        f = Math.floor((this.time * 8 + a.phase * 8) % 8);
      }
    } else if (working) {
      anim = 'fire';
      f = Math.floor((this.time * 6 + a.phase * 4) % 4);
    } else if (since < 0.36) {
      anim = 'fire';
      f = Math.min(3, Math.floor(since / 0.09));
    } else if (target && !moving) {
      anim = 'fire';
      f = 0;
    } else if (moving) {
      anim = 'walk';
      f = Math.floor((this.time * 7 + a.phase * 8) % 8);
    }
    const fr = unitFrame(u.type, anim, a.dir, f);
    if (!fr) return;
    if (s.body.texture !== fr.body) {
      s.body.texture = fr.body;
      s.body.anchor.copyFrom(fr.body.defaultAnchor ?? { x: 0.5, y: 1 });
    }
    if (s.team) {
      s.team.visible = !!fr.team;
      if (fr.team && s.team.texture !== fr.team) {
        s.team.texture = fr.team;
        s.team.anchor.copyFrom(fr.team.defaultAnchor ?? { x: 0.5, y: 1 });
      }
      s.team.tint = color;
    }
    if (s.bodyKey !== 'art') {
      // La sombra va horneada en el sprite; el anillo de selección conserva su tamaño.
      s.bodyKey = 'art';
      s.shadow.visible = false;
      const r = (u.radius * TW) / (SUB * Math.SQRT2) + 2;
      s.ring.width = (r + 3) * 2;
      s.ring.height = r + 3;
    }
  }

  private unitSprite(id: number): UnitSprite {
    let s = this.unitSprites.get(id);
    if (s) return s;
    const c = new Container();
    const shadow = new PixiSprite(this.circleTex);
    shadow.anchor.set(0.5);
    shadow.tint = 0x000000;
    shadow.alpha = 0.3;
    const ring = new PixiSprite(this.ringTex);
    ring.anchor.set(0.5);
    const body = new PixiSprite(Texture.EMPTY);
    const bars = [0, 1, 2, 3].map(() => new PixiSprite(Texture.WHITE));
    const team = new PixiSprite(Texture.EMPTY);
    c.addChild(shadow, ring, body, team, ...bars);
    s = { c, body, shadow, ring, bars, bodyKey: '', team };
    this.unitSprites.set(id, s);
    this.entityLayer.addChild(c);
    return s;
  }

  /** Muestra u oculta la zona de cobertura propia (con mechas seleccionados, al colocar red o con Alt). */
  setPowerOverlay(on: boolean): void {
    this.showPower = on;
  }

  /**
   * Cobertura como una sola mancha por red: tinte muy suave por casilla y un único borde donde la
   * casilla vecina queda fuera. Verde la propia, azul la de los aliados y turquesa donde se solapan.
   */
  private drawPower(st: State): void {
    this.powerGfx.visible = this.showPower;
    if (!this.showPower || this.powerDrawn === st.powerVersion) return;
    this.powerDrawn = st.powerVersion;
    const g = this.powerGfx;
    g.clear();
    const { w, h } = st.map;
    const mine = 1 << this.me;
    let allies = 0;
    st.players.forEach((pl, q) => {
      if (q !== this.me && pl.team === st.players[this.me].team) allies |= 1 << q;
    });
    const has = (tx: number, ty: number, m: number) => tx >= 0 && ty >= 0 && tx < w && ty < h && (st.power[ty * w + tx] & m) !== 0;
    const corner = (tx: number, ty: number) => [isoX(tx * SUB, ty * SUB), isoY(tx * SUB, ty * SUB)] as const;
    // Tinte de cada casilla según a qué redes pertenece.
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const own = has(tx, ty, mine);
        const ally = has(tx, ty, allies);
        if (!own && !ally) continue;
        const [ax, ay] = corner(tx, ty);
        const [bx, by] = corner(tx + 1, ty);
        const [cx, cy] = corner(tx + 1, ty + 1);
        const [dx, dy] = corner(tx, ty + 1);
        g.poly([ax, ay, bx, by, cx, cy, dx, dy]).fill({ color: own && ally ? POWER_BOTH : own ? POWER_OWN : POWER_ALLY, alpha: own && ally ? 0.16 : 0.08 });
      }
    }
    // Borde exterior de cada red como un solo trazo.
    const border = (m: number, color: number) => {
      if (!m) return;
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          if (!has(tx, ty, m)) continue;
          const [ax, ay] = corner(tx, ty);
          const [bx, by] = corner(tx + 1, ty);
          const [cx, cy] = corner(tx + 1, ty + 1);
          const [dx, dy] = corner(tx, ty + 1);
          if (!has(tx, ty - 1, m)) g.moveTo(ax, ay).lineTo(bx, by);
          if (!has(tx + 1, ty, m)) g.moveTo(bx, by).lineTo(cx, cy);
          if (!has(tx, ty + 1, m)) g.moveTo(cx, cy).lineTo(dx, dy);
          if (!has(tx - 1, ty, m)) g.moveTo(dx, dy).lineTo(ax, ay);
        }
      }
      g.stroke({ width: 2, color, alpha: 0.6 });
    };
    border(allies, POWER_ALLY);
    border(mine, POWER_OWN);
    // Enlaces entre nodos propios con energía (edificios y camiones desplegados).
    const nodes: { x: number; y: number; lift: number; link: number }[] = [];
    for (const b of st.buildings) {
      const pw = BUILDINGS[b.type].power;
      if (b.owner !== this.me || !b.powered || !pw) continue;
      const c = buildingCenter(b);
      nodes.push({ x: c.x, y: c.y, lift: 40, link: linkOf(st, this.me, pw.link, b.type === 'relay') });
    }
    for (const u of st.units) {
      if (u.owner !== this.me || u.type !== 'truck' || u.deployState !== 2 || !u.nodePowered) continue;
      nodes.push({ x: u.x, y: u.y, lift: 50, link: linkOf(st, this.me, BUILDINGS.relay.power!.link, true) });
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const link = Math.max(a.link, b.link) * SUB;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > link * link) continue;
        dashed(g, isoX(a.x, a.y), isoY(a.x, a.y) - a.lift, isoX(b.x, b.y), isoY(b.x, b.y) - b.lift, POWER_OWN, 0.35);
      }
    }
  }

  /** Niebla: negro sin explorar, penumbra lo explorado sin vista, transparente lo que se ve. */
  private drawFog(st: State): void {
    if (this.fogDrawn === st.visionVersion) return;
    this.fogDrawn = st.visionVersion;
    const { w, h } = st.map;
    const ctx = this.fogCanvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const bit = 1 << this.me;
    for (let i = 0; i < w * h; i++) {
      const a = st.vision[i] & bit ? 0 : st.explored[i] & bit ? 150 : 255;
      img.data[i * 4] = 7;
      img.data[i * 4 + 1] = 5;
      img.data[i * 4 + 2] = 11;
      img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    this.fogTex.source.update();
  }

  /** Vetas: grietas con cristales de energía que laten suavemente. */
  private drawVents(st: State): void {
    const g = this.ventGfx;
    g.clear();
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 2.4);
    const tex = [decorTexture('vent_0_0'), decorTexture('vent_1_0')];
    if (tex[0] && tex[1] && this.ventSprites.length === 0) {
      // Cristales prerenderizados, ordenados en profundidad con unidades y edificios.
      st.vents.forEach((v, i) => {
        const spr = new PixiSprite(tex[i % 2]!);
        spr.position.set(isoX(v.tx * SUB + SUB / 2, v.ty * SUB + SUB / 2), isoY(v.tx * SUB + SUB / 2, v.ty * SUB + SUB / 2));
        spr.zIndex = spr.position.y;
        this.entityLayer.addChild(spr);
        this.ventSprites.push(spr);
      });
    }
    // Una central terminada encima tapa los cristales de su veta.
    st.vents.forEach((v, i) => {
      const spr = this.ventSprites[i];
      if (spr) spr.visible = !st.buildings.some((b) => b.type === 'plant' && b.complete && b.hp > 0 && v.tx >= b.tx && v.tx < b.tx + b.size && v.ty >= b.ty && v.ty < b.ty + b.size);
    });
    for (const v of st.vents) {
      if (!isExplored(st, this.me, v.tx * SUB, v.ty * SUB)) continue;
      const x = isoX(v.tx * SUB + SUB / 2, v.ty * SUB + SUB / 2);
      const y = isoY(v.tx * SUB + SUB / 2, v.ty * SUB + SUB / 2);
      if (this.ventSprites.length) {
        // Solo el halo que late; las grietas brillantes las pinta el shader del terreno.
        g.ellipse(x, y, 34 + 6 * pulse, 17 + 3 * pulse).fill({ color: 0x3ee6ff, alpha: 0.1 * pulse });
        continue;
      }
      g.ellipse(x, y, 58, 29).fill({ color: 0x1c1428, alpha: 0.55 });
      g.ellipse(x, y, 40 + 6 * pulse, 20 + 3 * pulse).fill({ color: 0x3ee6ff, alpha: 0.12 * pulse });
      g.moveTo(x - 44, y + 4).lineTo(x - 18, y - 6).lineTo(x + 6, y + 6).lineTo(x + 40, y - 4).stroke({ width: 3, color: 0x3ee6ff, alpha: 0.5 + 0.4 * pulse });
      for (const [ox, oy, hgt] of [
        [-16, 0, 22],
        [0, 4, 30],
        [16, -2, 18],
        [-4, -8, 14],
      ]) {
        g.poly([x + ox - 5, y + oy, x + ox, y + oy - hgt, x + ox + 5, y + oy]).fill({ color: 0x8ff3ff, alpha: 0.85 });
        g.poly([x + ox, y + oy - hgt, x + ox + 5, y + oy, x + ox + 1, y + oy + 1]).fill({ color: 0x2aa9c8, alpha: 0.9 });
      }
    }
  }

  /** Dibuja el estado interpolando entre la posición del tick anterior y la actual. */
  sync(st: State, prev: ReadonlyMap<number, Pos>, alpha: number, selected: ReadonlySet<number>): void {
    const seen = new Set<number>();
    if (!this.terrainBuilt) {
      this.terrainBuilt = true;
      if (terrainTexturesReady()) {
        this.terrain = createTerrain(st, isoX, isoY);
        this.terrainLayer.addChild(this.terrain.mesh);
      } else this.terrainLayer.addChild(drawTerrain(st.map));
      if (decorReady()) {
        this.decor = new Decor(st, this.entityLayer, isoX, isoY);
        this.terrainLayer.addChild(this.decor.ground);
      }
    }
    this.decor?.update(this.view, st.units, st.buildings);
    this.terrain?.setTime(this.time);
    this.drawVents(st);
    this.drawPower(st);
    this.drawFog(st);
    const me = this.me;
    for (const n of st.nodes) {
      if (!isExplored(st, me, n.tx * SUB, n.ty * SUB)) continue;
      seen.add(n.id);
      const c = n.tx * SUB + SUB / 2;
      const d = n.ty * SUB + SUB / 2;
      const nx = isoX(c, d);
      const ny = isoY(c, d);
      const known = this.sprites.get(n.id);
      if (!this.inView(nx, ny)) {
        if (known) known.c.visible = false;
        continue;
      }
      const ore = decorTexture(`ore_${n.id % 3}_0`);
      const s = this.sprite(n.id, `${Math.ceil(n.amount / 100)}`, (g, c) => {
        if (!ore) return drawNode(g, n);
        // Veta prerenderizada: encoge a medida que se agota.
        let spr = c.children.find((ch) => ch.label === 'ore') as PixiSprite | undefined;
        if (!spr) {
          spr = new PixiSprite(ore);
          spr.label = 'ore';
          if (n.id % 2) spr.scale.x = -1;
          c.addChild(spr);
        }
        const k = 1.5 * (0.55 + 0.45 * Math.min(1, n.amount / 400));
        spr.scale.set(Math.sign(spr.scale.x) * k, k);
      });
      s.c.visible = true;
      s.c.position.set(nx, ny);
      s.c.zIndex = s.c.position.y;
    }
    for (const b of st.buildings) {
      // Edificios enemigos en la niebla: se quedan como se vieron por última vez, en gris.
      const shown = b.owner === me || footprintVisible(st, me, b.tx, b.ty, b.size);
      const known = this.sprites.get(b.id);
      if (!shown) {
        if (known) {
          seen.add(b.id);
          known.c.tint = 0x8a8a8a;
        }
        continue;
      }
      seen.add(b.id);
      const sel = selected.has(b.id);
      const prog = b.complete ? 100 : Math.floor((100 * b.progress) / BUILDINGS[b.type].buildTime);
      const train = b.queue.length ? Math.floor((100 * b.trainTicks) / UNITS[b.queue[0]].trainTime) : -1;
      const gen = st.players[b.owner].gen;
      const res = b.research ? Math.floor((100 * b.research.ticks) / TECHS[b.research.tech].time) : -1;
      const half = (b.size * SUB) / 2;
      const px = isoX(b.tx * SUB + half, b.ty * SUB + half);
      const py = isoY(b.tx * SUB + half, b.ty * SUB + half);
      if (!this.inView(px, py) && !known) continue;
      // Solo se redibuja cuando cambia su forma (no con cada golpe): la vida va en barras aparte.
      const s = this.sprite(b.id, `${sel}|${prog}|${b.powered}|${gen}|${b.complete}`, (g, c) => drawBuilding(g, c, b, sel, prog, -1, gen));
      s.c.position.set(px, py);
      s.c.zIndex = s.c.position.y;
      s.c.tint = 0xffffff;
      s.c.visible = this.inView(px, py);
      if (s.c.visible) this.buildingBars(s.c, sel || b.hp < b.maxHp ? b.hp / b.maxHp : -1, !b.complete ? prog / 100 : res >= 0 ? res / 100 : train >= 0 ? train / 100 : -1);
      if (!b.complete) {
        const holo = s.c.children.find((ch) => ch.label === 'holo');
        if (holo) holo.alpha = 0.38 + 0.12 * Math.sin(this.time * 4 + b.id);
      }
      if (b.owner !== me) s.foot = { tx: b.tx, ty: b.ty, size: b.size };
    }
    const alive = new Set<number>();
    for (const u of st.units) {
      alive.add(u.id);
      const p = prev.get(u.id) ?? u;
      const x = p.x + (u.x - p.x) * alpha;
      const y = p.y + (u.y - p.y) * alpha;
      const sx = isoX(x, y);
      const sy = isoY(x, y);
      const shown = (u.owner === me || isVisible(st, me, u.x, u.y)) && this.inView(sx, sy);
      const existing = this.unitSprites.get(u.id);
      if (!shown) {
        if (existing) existing.c.visible = false;
        continue;
      }
      const s = this.unitSprite(u.id);
      s.c.visible = true;
      const sel = selected.has(u.id);
      // Estado de energía: conectada, fuera de la red (con batería) o apagada.
      const bmax = batteryMax(st, u.owner);
      const power = u.needsPower && !st.players[u.owner].noPower ? (u.battery <= 0 ? 'off' : isPowered(st, u.owner, u.x, u.y) ? (u.battery < bmax ? 'charge' : 'on') : 'out') : '';
      const body: BodyState = { type: u.type, color: PLAYER_COLORS[u.owner] ?? 0xcccccc, carry: u.carry > 0, deployState: u.deployState, nodePowered: u.nodePowered, light: power === 'charge' ? 'on' : power };
      const bodyKey = `${body.type}|${body.color}|${body.light}|${body.carry}|${body.deployState}|${body.nodePowered}`;
      if (hasUnitArt(u.type)) {
        this.animateUnit(st, u, s, sx, sy, body.color);
      } else if (bodyKey !== s.bodyKey) {
        const t = this.bodyTexture(body);
        s.body.texture = t.tex;
        s.body.anchor.set(t.ax, t.ay);
        s.bodyKey = bodyKey;
        const r = (u.radius * TW) / (SUB * Math.SQRT2) + 2;
        s.shadow.width = r * 2;
        s.shadow.height = r;
        s.ring.width = (r + 3) * 2;
        s.ring.height = r + 3;
      }
      s.ring.visible = sel;
      s.c.alpha = power === 'off' ? 0.6 : 1;
      const box = UNIT_BOX[u.type];
      const bw = Math.max(20, box.w + 10);
      setBar(s.bars[0], s.bars[1], -box.h - 8, bw, sel || u.hp < u.maxHp ? u.hp / u.maxHp : -1, hpColor(u.hp / u.maxHp));
      setBar(s.bars[2], s.bars[3], -box.h - 14, bw, power === 'out' || power === 'charge' ? u.battery / bmax : -1, power === 'out' ? 0xff8a3c : 0x7dffb0);
      s.c.position.set(sx, sy);
      s.c.zIndex = s.c.position.y;
      const k = this.kicks.get(u.id);
      if (k) {
        const f = 1 - k.age / k.dur;
        s.c.x += k.dx * f;
        s.c.y += k.dy * f;
      }
    }
    for (const id of this.anim.keys()) if (!alive.has(id)) this.anim.delete(id);
    this.drawPending(st);
    for (const [id, s] of this.unitSprites) {
      if (alive.has(id)) continue;
      s.c.destroy({ children: true });
      this.unitSprites.delete(id);
    }
    for (const [id, s] of this.sprites) {
      // Un edificio enemigo destruido sin que lo veas sigue ahí como fantasma hasta que vuelvas a mirar.
      if (!seen.has(id) && s.foot && !footprintVisible(st, me, s.foot.tx, s.foot.ty, s.foot.size)) {
        s.c.tint = 0x8a8a8a;
        continue;
      }
      if (!seen.has(id)) {
        s.c.destroy({ children: true });
        this.sprites.delete(id);
      }
    }

    this.drawRockets(st, alpha);

    // Puntos de reunión de los edificios seleccionados.
    const g = this.groundFx;
    g.clear();
    // Recorrido pendiente (órdenes con Shift) de las unidades seleccionadas.
    for (const u of st.units) {
      if (!selected.has(u.id) || u.orderQueue.length === 0) continue;
      const pts: Pos[] = [{ x: u.x, y: u.y }];
      const point = (o: Unit['order'] | Unit['orderQueue'][number]): Pos | null => {
        if (o.kind === 'move' || o.kind === 'amove') return { x: o.x, y: o.y };
        if (o.kind === 'gather') {
          const n = st.nodesById.get(o.node);
          return n ? { x: n.tx * SUB + SUB / 2, y: n.ty * SUB + SUB / 2 } : null;
        }
        if (o.kind === 'build') {
          const b = st.buildingsById.get(o.target);
          return b ? { x: (b.tx + b.size / 2) * SUB, y: (b.ty + b.size / 2) * SUB } : null;
        }
        return null;
      };
      for (const o of [u.order, ...u.orderQueue]) {
        const p = point(o);
        if (p) pts.push(p);
      }
      for (let i = 1; i < pts.length; i++) {
        dashed(g, isoX(pts[i - 1].x, pts[i - 1].y), isoY(pts[i - 1].x, pts[i - 1].y), isoX(pts[i].x, pts[i].y), isoY(pts[i].x, pts[i].y));
        g.circle(isoX(pts[i].x, pts[i].y), isoY(pts[i].x, pts[i].y), 3).fill({ color: 0xfacc15, alpha: 0.8 });
      }
    }
    for (const b of st.buildings) {
      if (!selected.has(b.id) || b.rallyX < 0) continue;
      const x = isoX(b.rallyX, b.rallyY);
      const y = isoY(b.rallyX, b.rallyY);
      g.moveTo(x, y).lineTo(x, y - 22).stroke({ width: 2, color: 0xf3e9d8 });
      g.poly([x, y - 22, x + 12, y - 18, x, y - 14]).fill(PLAYER_COLORS[b.owner]);
    }
    for (const m of this.markers) {
      const r = 6 + (1 - m.ttl) * 10;
      g.ellipse(isoX(m.x, m.y), isoY(m.x, m.y), r, r / 2).stroke({ width: 2, color: m.color, alpha: m.ttl });
    }
  }

  private sprite(id: number, key: string, draw: (g: Graphics, c: Container) => void): Sprite {
    let s = this.sprites.get(id);
    if (!s) {
      const c = new Container();
      const g = new Graphics();
      c.addChild(g);
      s = { c, g, key: '' };
      this.sprites.set(id, s);
      this.entityLayer.addChild(c);
    }
    if (s.key !== key) {
      s.g.clear();
      draw(s.g, s.c);
      s.key = key;
    }
    return s;
  }

  /** Barras de un edificio (vida y producción) como sprites, sin redibujar su forma. */
  private buildingBars(c: Container, hp: number, work: number): void {
    const spec = BAR_SPEC.get(c);
    if (!spec) return;
    let bars = c.children.filter((ch) => ch.label === 'bar') as PixiSprite[];
    if (bars.length === 0) {
      bars = [0, 1, 2, 3].map(() => {
        const b = new PixiSprite(Texture.WHITE);
        b.label = 'bar';
        c.addChild(b);
        return b;
      });
    }
    setBar(bars[0], bars[1], spec.y, spec.w, hp, hpColor(hp));
    setBar(bars[2], bars[3], spec.y + 7, spec.w, work, 0xf3e9d8);
  }

  /** Marca breve en el suelo para confirmar una orden (x, y en subunidades). */
  flash(x: number, y: number, color: number): void {
    this.markers.push({ x, y, color, ttl: 1 });
  }

  updateMarkers(dtSeconds: number): void {
    this.markers = this.markers.filter((m) => (m.ttl -= dtSeconds * 2) > 0);
  }

  /** Convierte los efectos de un tick en animaciones. `me` es el jugador local (para el "+metal"). */
  addFx(fx: readonly Fx[], st: State, me: number): void {
    for (const f of fx) {
      // Disparo de una unidad con arte: arranca su animación de fuego.
      if (f.kind === 'shot' || f.kind === 'launch') {
        const a = this.anim.get(f.unit);
        if (a) a.fired = this.time;
      }
      // Lo que pasa en la niebla no se ve (salvo lo propio).
      if (f.owner !== me && !isVisible(st, me, f.x, f.y)) continue;
      switch (f.kind) {
        case 'shot':
          this.shot(f, st);
          break;
        case 'gather': {
          this.kick(f.unit, f.x, f.y, f.nx, f.ny, 2.5, 0.18);
          this.effects.push({ kind: 'flash', x: isoX(f.nx, f.ny), y: isoY(f.nx, f.ny) - 8, r: 3, color: 0xd6e2f0, age: 0, dur: 0.15 });
          break;
        }
        case 'income':
        case 'deliver': {
          // Metal entregado (verde) o goteo de una central extra en Gen-3 (dorado, más alto).
          if (f.owner !== me) break;
          const t = this.textPool.pop() ?? new Text({ text: '', style: { fontFamily: 'Menlo, monospace', fontSize: 12, fill: 0x7dffb0, stroke: { color: 0x111111, width: 3 } } });
          if (t.text !== `+${f.amount}`) t.text = `+${f.amount}`;
          t.style.fill = f.kind === 'income' ? 0xffd166 : 0x7dffb0;
          t.anchor.set(0.5);
          t.alpha = 1;
          t.visible = true;
          t.position.set(isoX(f.x, f.y), isoY(f.x, f.y) - (f.kind === 'income' ? 60 : 24));
          if (!t.parent) this.fxLayer.addChild(t);
          this.effects.push({ kind: 'text', t, age: 0, dur: 1 });
          break;
        }
        case 'death': {
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          const big = f.utype === 'colossus' ? 3 : f.utype === 'mech' ? 2 : 1;
          if (big > 1) this.effects.push({ kind: 'flash', x, y: y - 20 * big, r: 12 * big, color: 0xff8a3c, age: 0, dur: 0.35 + 0.15 * big });
          this.effects.push({ kind: 'flash', x, y: y - 6, r: 6 * big, color: 0x6b6570, age: 0, dur: 0.6 });
          this.debris(x, y - 8 * big, 4 + 5 * big, big === 1 ? (PLAYER_COLORS[f.owner] ?? 0xcccccc) : 0xe6dccb, big);
          if (big === 3) this.effects.push({ kind: 'ring', x, y, r0: 10, r1: 90, color: 0xffd08a, width: 3, age: 0, dur: 0.6 });
          break;
        }
        case 'destroyed': {
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          for (let i = 0; i < 4; i++) this.effects.push({ kind: 'flash', x: x + (i - 1.5) * 18, y: y - 10 - i * 6, r: 22, color: i % 2 ? 0x77736b : 0xff8a3c, age: -i * 0.08, dur: 0.8 });
          this.debris(x, y - 20, 18, 0x8a8494, 3);
          break;
        }
        case 'built': {
          const r = (BUILDINGS[f.btype].size * TW) / 2 + 10;
          this.effects.push({ kind: 'ring', x: isoX(f.x, f.y), y: isoY(f.x, f.y), r0: r * 0.6, r1: r * 1.2, color: 0xf5d68a, width: 3, age: 0, dur: 0.8 });
          break;
        }
        case 'towerShot': {
          // Boca del cañón del sprite de la torre (art/render_buildings.py): 0,64 / 0,40 casillas y 2,19 de alto.
          const mx = f.x + 0.64 * SUB;
          const my = f.y + 0.4 * SUB;
          const x1 = isoX(mx, my);
          const y1 = isoY(mx, my) - 2.19 * TILE_HEIGHT_PX;
          const target = st.byId.get(f.target);
          const x2 = isoX(f.tx, f.ty);
          const y2 = isoY(f.tx, f.ty) - (target ? UNIT_BOX[target.type].h * 0.5 : 10);
          this.effects.push({ kind: 'line', x1, y1, x2, y2, color: 0xffd08a, width: 2, alpha: 1, age: 0, dur: 0.1 });
          this.effects.push({ kind: 'flash', x: x1, y: y1, r: 4, color: 0xfff2c8, age: 0, dur: 0.08 });
          this.effects.push({ kind: 'flash', x: x2, y: y2, r: 4, color: 0xffb347, age: 0, dur: 0.14 });
          break;
        }
        case 'repair': {
          this.kick(f.unit, f.x, f.y, f.bx, f.by, 2.5, 0.2);
          const p = { x: isoX(f.x, f.y), y: isoY(f.x, f.y) };
          this.effects.push({ kind: 'flash', x: p.x + 4, y: p.y - 10, r: 3, color: 0xfff2c8, age: 0, dur: 0.15 });
          break;
        }
        case 'launch': {
          if (f.utype === 'artillery') {
            // Mortero: fogonazo en la boca del cañón, retroceso corto y una bocanada de humo.
            this.kick(f.unit, f.x, f.y, f.x - 64, f.y - 64, 3, 0.2);
            const x = isoX(f.x, f.y) + 16;
            const y = isoY(f.x, f.y) - MUZZLE.artillery;
            this.effects.push({ kind: 'flash', x, y, r: 7, color: 0xfff2c8, age: 0, dur: 0.12 });
            this.effects.push({ kind: 'flash', x, y, r: 12, color: 0xffb347, age: 0, dur: 0.2 });
            for (let i = 0; i < 4; i++) this.effects.push({ kind: 'puff', x: x + (this.rand() - 0.5) * 10, y: y - 4, r0: 3, r1: 11, rise: 14, color: 0xb9b2a4, alpha: 0.55, age: i * 0.04, dur: 0.9 });
            break;
          }
          // Contragolpe: fogonazo en la batería y humo que se abre alrededor del lanzador.
          this.kick(f.unit, f.x, f.y, f.x - 64, f.y - 64, 4, 0.35);
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          this.effects.push({ kind: 'flash', x: x - 4, y: y - MUZZLE.siege, r: 12, color: 0xfff2c8, age: 0, dur: 0.18 });
          this.effects.push({ kind: 'flash', x: x - 4, y: y - MUZZLE.siege + 4, r: 20, color: 0xff8a3c, age: 0, dur: 0.3 });
          for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2;
            this.effects.push({ kind: 'puff', x: x + Math.cos(ang) * 14, y: y - MUZZLE.siege + 10 + Math.sin(ang) * 7, r0: 5, r1: 16 + this.rand() * 8, rise: 10, color: 0xb9b2a4, alpha: 0.6, age: -i * 0.02, dur: 1.2 });
          }
          for (let i = 0; i < 5; i++) this.effects.push({ kind: 'puff', x: x + (this.rand() - 0.5) * 40, y: y - 2, r0: 6, r1: 20, rise: 4, color: 0x8a8494, alpha: 0.5, age: 0, dur: 1.4 });
          break;
        }
        case 'explosion': {
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          const r = (f.splash * TW) / (SUB * Math.SQRT2);
          if (f.utype === 'artillery') {
            // Obús: estallido seco y más pequeño que el del cohete de asedio.
            this.effects.push({ kind: 'flash', x, y: y - 6, r: r * 0.8, color: 0xffb347, age: 0, dur: 0.3 });
            this.effects.push({ kind: 'flash', x, y: y - 8, r: r * 0.35, color: 0xfff2c8, age: 0, dur: 0.15 });
            this.effects.push({ kind: 'ring', x, y, r0: r * 0.3, r1: r * 1.1, color: 0xffd08a, width: 2, age: 0, dur: 0.35 });
            this.debris(x, y - 6, 8, 0x3a3039, 2);
            for (let i = 0; i < 4; i++) this.effects.push({ kind: 'puff', x: x + (this.rand() - 0.5) * r, y: y - 4, r0: 5, r1: 16, rise: 20, color: 0x4b4555, alpha: 0.6, age: 0.05 + i * 0.03, dur: 1.2 });
            break;
          }
          this.effects.push({ kind: 'flash', x, y: y - 10, r: r * 0.9, color: 0xff8a3c, age: 0, dur: 0.45 });
          this.effects.push({ kind: 'flash', x, y: y - 14, r: r * 0.45, color: 0xfff2c8, age: 0, dur: 0.22 });
          this.effects.push({ kind: 'ring', x, y, r0: r * 0.3, r1: r * 1.25, color: 0xffd08a, width: 3, age: 0, dur: 0.5 });
          this.effects.push({ kind: 'ring', x, y, r0: r * 0.2, r1: r, color: 0xff4d6d, width: 2, age: 0.05, dur: 0.45 });
          this.debris(x, y - 12, 18, 0x3a3039, 3);
          for (let i = 0; i < 9; i++) {
            const ang = (i / 9) * Math.PI * 2;
            this.effects.push({ kind: 'puff', x: x + Math.cos(ang) * r * 0.5, y: y - 8 + Math.sin(ang) * r * 0.25, r0: 8, r1: 26 + this.rand() * 12, rise: 30, color: i % 3 ? 0x4b4555 : 0x77736b, alpha: 0.7, age: 0.1 + i * 0.03, dur: 1.8 });
          }
          break;
        }
        case 'powerLost': {
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          this.effects.push({ kind: 'flash', x, y: y - 60, r: 6, color: 0xff4d6d, age: 0, dur: 0.4 });
          break;
        }
        case 'shutdown': {
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          this.effects.push({ kind: 'ring', x, y, r0: 30, r1: 6, color: 0x888888, width: 2, age: 0, dur: 0.6 });
          for (let i = 0; i < 3; i++) this.effects.push({ kind: 'puff', x: x + (i - 1) * 8, y: y - 50, r0: 3, r1: 10, rise: 18, color: 0x6f6878, alpha: 0.5, age: i * 0.1, dur: 1.2 });
          break;
        }
        case 'reactor': {
          // Estallido del reactor: destello cian, doble onda, fuego y una columna de humo.
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          const r = (f.radius * TW) / (SUB * Math.SQRT2);
          this.effects.push({ kind: 'flash', x, y: y - 40, r: r * 0.7, color: 0xe0fbff, age: 0, dur: 0.25 });
          this.effects.push({ kind: 'flash', x, y: y - 30, r: r, color: 0x3ee6ff, age: 0.05, dur: 0.6 });
          this.effects.push({ kind: 'flash', x, y: y - 20, r: r * 0.8, color: 0xff8a3c, age: 0.15, dur: 0.8 });
          this.effects.push({ kind: 'ring', x, y, r0: r * 0.2, r1: r * 1.4, color: 0x3ee6ff, width: 4, age: 0, dur: 0.7 });
          this.effects.push({ kind: 'ring', x, y, r0: r * 0.1, r1: r * 1.1, color: 0xffffff, width: 2, age: 0.1, dur: 0.6 });
          this.debris(x, y - 30, 26, 0xe9e4d8, 4);
          for (let i = 0; i < 14; i++) {
            const ang = (i / 14) * Math.PI * 2;
            this.effects.push({ kind: 'puff', x: x + Math.cos(ang) * r * 0.6, y: y - 10 + Math.sin(ang) * r * 0.3, r0: 12, r1: 40 + this.rand() * 20, rise: 60, color: i % 3 ? 0x3a3039 : 0x6f6878, alpha: 0.75, age: 0.2 + i * 0.03, dur: 2.6 });
          }
          break;
        }
        case 'researched': {
          const x = isoX(f.x, f.y);
          const y = isoY(f.x, f.y);
          this.effects.push({ kind: 'ring', x, y: y - 20, r0: 10, r1: 60, color: 0x7dffb0, width: 3, age: 0, dur: 0.9 });
          this.effects.push({ kind: 'ring', x, y: y - 40, r0: 6, r1: 40, color: 0xfff2c8, width: 2, age: 0.15, dur: 0.8 });
          break;
        }
        case 'deployed':
          this.effects.push({ kind: 'ring', x: isoX(f.x, f.y), y: isoY(f.x, f.y), r0: f.on ? 4 : 20, r1: f.on ? 24 : 4, color: f.on ? 0x7dffb0 : 0xc9a44a, width: 2, age: 0, dur: 0.5 });
          break;
        case 'trained':
          this.effects.push({ kind: 'ring', x: isoX(f.x, f.y), y: isoY(f.x, f.y), r0: 4, r1: 22, color: PLAYER_COLORS[f.owner] ?? 0xffffff, width: 2, age: 0, dur: 0.5 });
          break;
      }
    }
  }

  /**
   * Cohetes en vuelo: avanzan con aceleración (lento al salir, rápido al final) sobre un arco que
   * parte de la batería del lanzador y cae sobre el punto apuntado.
   */
  private rocketPos(p: State['projectiles'][number], prog: number): Pos {
    // Cohete: sale lento y acelera. Obús: trayectoria balística a velocidad constante, con más arco.
    const shell = p.utype === 'artillery';
    const e = shell ? prog : prog * prog;
    const gx = p.x0 + (p.x1 - p.x0) * e;
    const gy = p.y0 + (p.y1 - p.y0) * e;
    const dist = Math.hypot(isoX(p.x1, p.y1) - isoX(p.x0, p.y0), isoY(p.x1, p.y1) - isoY(p.x0, p.y0));
    const lift = shell ? Math.min(260, dist * 0.6) : Math.min(180, dist * 0.4);
    const h = MUZZLE[p.utype] * (1 - e) + Math.sin(Math.PI * e) * lift;
    return { x: isoX(gx, gy), y: isoY(gx, gy) - h };
  }

  private drawRockets(st: State, alpha: number): void {
    const g = this.projGfx;
    g.clear();
    this.rocketTails = [];
    for (const p of st.projectiles) {
      const prog = Math.min(1, (p.t + alpha) / p.dur);
      const e = p.utype === 'artillery' ? prog : prog * prog;
      if (p.owner !== this.me && !isVisible(st, this.me, p.x0 + (p.x1 - p.x0) * e, p.y0 + (p.y1 - p.y0) * e)) continue;
      const a = this.rocketPos(p, prog);
      if (p.utype === 'artillery') {
        // Obús: una bola incandescente con halo.
        g.circle(a.x, a.y, 7).fill({ color: 0xffb347, alpha: 0.3 });
        g.circle(a.x, a.y, 3.2).fill(0xfff2c8).stroke({ width: 1, color: 0xff8a3c });
        this.rocketTails.push({ x: a.x, y: a.y, small: true });
        continue;
      }
      const b = this.rocketPos(p, Math.min(1, prog + 0.02));
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const nx = -dy;
      const ny = dx;
      const L = 16;
      const W = 2.6;
      const tail = { x: a.x - dx * L * 0.5, y: a.y - dy * L * 0.5 };
      const nose = { x: a.x + dx * L * 0.5, y: a.y + dy * L * 0.5 };
      // Llama: más larga a medida que acelera.
      const flame = 6 + 16 * prog + this.rand() * 5;
      g.poly([tail.x + nx * W, tail.y + ny * W, tail.x - dx * flame, tail.y - dy * flame, tail.x - nx * W, tail.y - ny * W]).fill({ color: 0xffb347, alpha: 0.9 });
      g.poly([tail.x + nx * W * 0.5, tail.y + ny * W * 0.5, tail.x - dx * flame * 0.55, tail.y - dy * flame * 0.55, tail.x - nx * W * 0.5, tail.y - ny * W * 0.5]).fill(0xfff2c8);
      g.circle(tail.x, tail.y, 5 + 3 * prog).fill({ color: 0xff8a3c, alpha: 0.35 });
      // Cuerpo, aletas y ojiva.
      g.poly([tail.x + nx * W, tail.y + ny * W, nose.x - dx * 3 + nx * W, nose.y - dy * 3 + ny * W, nose.x, nose.y, nose.x - dx * 3 - nx * W, nose.y - dy * 3 - ny * W, tail.x - nx * W, tail.y - ny * W]).fill(0xe6dccb).stroke({ width: 1, color: 0x2a2630 });
      g.poly([nose.x - dx * 4 + nx * W, nose.y - dy * 4 + ny * W, nose.x, nose.y, nose.x - dx * 4 - nx * W, nose.y - dy * 4 - ny * W]).fill(PLAYER_COLORS[p.owner] ?? 0xef4444);
      for (const s of [1, -1]) g.poly([tail.x + nx * W * s, tail.y + ny * W * s, tail.x + nx * W * 2.6 * s - dx * 3, tail.y + ny * W * 2.6 * s - dy * 3, tail.x + dx * 4 + nx * W * s, tail.y + dy * 4 + ny * W * s]).fill(0x5b5f6a);
      this.rocketTails.push({ x: tail.x - dx * 4, y: tail.y - dy * 4, small: false });
    }
  }

  private shot(f: Extract<Fx, { kind: 'shot' }>, st: State): void {
    if (UNITS[f.utype].projectile) return; // su disparo se anima como proyectil (fx 'launch')
    const x1 = isoX(f.x, f.y);
    const y1 = isoY(f.x, f.y) - MUZZLE[f.utype];
    const target = st.byId.get(f.target);
    const x2 = isoX(f.tx, f.ty);
    const y2 = isoY(f.tx, f.ty) - (f.onBuilding ? 22 : target ? UNIT_BOX[target.type].h * 0.5 : 8);
    const push = (e: Effect) => this.effects.push(e);
    switch (f.utype) {
      case 'worker':
        this.kick(f.unit, f.x, f.y, f.tx, f.ty, 3, 0.15);
        push({ kind: 'flash', x: x2, y: y2, r: 3, color: 0xfff2c8, age: 0, dur: 0.12 });
        break;
      case 'soldier':
        this.kick(f.unit, f.tx, f.ty, f.x, f.y, 1.5, 0.1);
        push({ kind: 'line', x1, y1, x2, y2, color: 0xffe28a, width: 1.5, alpha: 0.9, age: 0, dur: 0.08 });
        push({ kind: 'flash', x: x1, y: y1, r: 3, color: 0xfff2c8, age: 0, dur: 0.06 });
        push({ kind: 'flash', x: x2, y: y2, r: 2.5, color: 0xffb347, age: 0, dur: 0.1 });
        break;
      case 'mech':
        this.kick(f.unit, f.tx, f.ty, f.x, f.y, 3, 0.15);
        push({ kind: 'line', x1, y1, x2, y2, color: 0xffb347, width: 7, alpha: 0.35, age: 0, dur: 0.18 });
        push({ kind: 'line', x1, y1, x2, y2, color: 0xfff2c8, width: 2, alpha: 1, age: 0, dur: 0.14 });
        push({ kind: 'flash', x: x1, y: y1, r: 6, color: 0xfff2c8, age: 0, dur: 0.1 });
        push({ kind: 'flash', x: x2, y: y2, r: 11, color: 0xff8a3c, age: 0, dur: 0.25 });
        break;
      case 'colossus':
        push({ kind: 'line', x1, y1, x2, y2, color: 0xff4d6d, width: 12, alpha: 0.35, age: 0, dur: 0.4 });
        push({ kind: 'line', x1, y1, x2, y2, color: 0xffd0da, width: 3, alpha: 1, age: 0, dur: 0.35 });
        push({ kind: 'flash', x: x1, y: y1, r: 10, color: 0xff4d6d, age: 0, dur: 0.2 });
        push({ kind: 'flash', x: x2, y: y2, r: 20, color: 0xffd0da, age: 0, dur: 0.35 });
        break;
    }
    if (f.splash > 0) {
      const r1 = (f.splash * TW) / (SUB * Math.SQRT2);
      push({ kind: 'ring', x: isoX(f.tx, f.ty), y: isoY(f.tx, f.ty), r0: r1 * 0.3, r1, color: f.utype === 'colossus' ? 0xff4d6d : 0xffb347, width: 2, age: 0, dur: 0.3 });
    }
  }

  /** Empujón breve del sprite de (x1,y1) hacia (x2,y2): golpe, retroceso o picar. */
  private kick(id: number, x1: number, y1: number, x2: number, y2: number, px: number, dur: number): void {
    const dx = isoX(x2, y2) - isoX(x1, y1);
    const dy = isoY(x2, y2) - isoY(x1, y1);
    const d = Math.hypot(dx, dy) || 1;
    this.kicks.set(id, { dx: (dx / d) * px, dy: (dy / d) * px, age: 0, dur });
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  private debris(x: number, y: number, n: number, color: number, big: number): void {
    const parts = Array.from({ length: n }, () => ({ vx: (this.rand() - 0.5) * 120 * big, vy: -(40 + this.rand() * 90) * big, s: 1.5 + this.rand() * 1.5 * big }));
    this.effects.push({ kind: 'debris', x, y, parts, color, age: 0, dur: 0.7 });
  }

  /** Avanza y dibuja las animaciones. Llamar una vez por frame con el tiempo real transcurrido. */
  private take(tex: Texture): PixiSprite {
    const sp = this.pool.pop() ?? new PixiSprite();
    sp.texture = tex;
    sp.visible = true;
    sp.rotation = 0;
    sp.anchor.set(0.5);
    if (!sp.parent) this.fxLayer.addChild(sp);
    return sp;
  }

  private release(e: Effect): void {
    if (e.kind === 'text') {
      e.t.visible = false;
      this.textPool.push(e.t);
      return;
    }
    for (const sp of e.spr ?? []) {
      sp.visible = false;
      this.pool.push(sp);
    }
    e.spr = undefined;
  }

  /**
   * Avanza y dibuja las animaciones. Cada efecto usa sprites reutilizados (un círculo, un anillo o un
   * rectángulo blanco teñido) en vez de redibujar formas vectoriales en cada frame.
   */
  updateFx(dt: number): void {
    this.time += dt;
    this.frame++;
    for (const [id, k] of this.kicks) if ((k.age += dt) >= k.dur) this.kicks.delete(id);
    // En batallas enormes, descartar los efectos más viejos antes que dejar caer el rendimiento.
    if (this.effects.length > MAX_EFFECTS) for (const e of this.effects.splice(0, this.effects.length - MAX_EFFECTS)) this.release(e);
    this.effects = this.effects.filter((e) => {
      e.age += dt;
      if (e.age >= e.dur) {
        this.release(e);
        return false;
      }
      if (e.age < 0) return true;
      const p = e.age / e.dur;
      switch (e.kind) {
        case 'line': {
          const sp = (e.spr ??= [this.take(Texture.WHITE)])[0];
          sp.anchor.set(0, 0.5);
          sp.position.set(e.x1, e.y1);
          sp.width = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
          sp.height = e.width;
          sp.rotation = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
          sp.tint = e.color;
          sp.alpha = e.alpha * (1 - p);
          break;
        }
        case 'flash': {
          const sp = (e.spr ??= [this.take(this.circleTex)])[0];
          const r = e.r * (0.6 + 0.6 * p);
          sp.position.set(e.x, e.y);
          sp.width = r * 2;
          sp.height = r * 2;
          sp.tint = e.color;
          sp.alpha = 0.85 * (1 - p);
          break;
        }
        case 'ring': {
          const sp = (e.spr ??= [this.take(this.ringTex)])[0];
          const r = e.r0 + (e.r1 - e.r0) * p;
          sp.position.set(e.x, e.y);
          sp.width = r * 2;
          sp.height = r;
          sp.tint = e.color;
          sp.alpha = 1 - p;
          break;
        }
        case 'debris': {
          const parts = (e.spr ??= e.parts.map(() => this.take(Texture.WHITE)));
          const t = e.age;
          e.parts.forEach((q, k) => {
            const sp = parts[k];
            sp.position.set(e.x + q.vx * t, e.y + q.vy * t + 220 * t * t);
            sp.width = q.s;
            sp.height = q.s;
            sp.tint = e.color;
            sp.alpha = 1 - p;
          });
          break;
        }
        case 'text':
          e.t.y -= 22 * dt;
          e.t.alpha = 1 - p;
          break;
        case 'puff': {
          const sp = (e.spr ??= [this.take(this.circleTex)])[0];
          const r = e.r0 + (e.r1 - e.r0) * Math.sqrt(p);
          sp.position.set(e.x, e.y - e.rise * p);
          sp.width = r * 2;
          sp.height = r * 2;
          sp.tint = e.color;
          sp.alpha = e.alpha * (1 - p);
          break;
        }
      }
      return true;
    });
    // Estela de humo de los cohetes en vuelo (un frame sí y otro no: suficiente para verse continua).
    if (dt > 0 && this.frame % 2 === 0) for (const t of this.rocketTails) this.effects.push(t.small ? { kind: 'puff', x: t.x, y: t.y, r0: 1.5, r1: 4, rise: 2, color: 0xffd08a, alpha: 0.45, age: 0, dur: 0.35 } : { kind: 'puff', x: t.x, y: t.y, r0: 2.5, r1: 9, rise: 6, color: 0xc9c2b4, alpha: 0.55, age: 0, dur: 0.9 });
  }

  /** Huella fantasma del edificio a colocar (null la oculta). */
  setGhost(type: BuildingType | null, tx: number, ty: number, valid: boolean): void {
    const g = this.ghost;
    g.clear();
    this.ghostArt.visible = false;
    if (!type) return;
    const size = BUILDINGS[type].size;
    const x0 = tx * SUB;
    const y0 = ty * SUB;
    const x1 = x0 + size * SUB;
    const y1 = y0 + size * SUB;
    const color = valid ? 0x4ade80 : 0xef4444;
    g.poly([isoX(x0, y0), isoY(x0, y0), isoX(x1, y0), isoY(x1, y0), isoX(x1, y1), isoY(x1, y1), isoX(x0, y1), isoY(x0, y1)])
      .fill({ color, alpha: 0.18 })
      .stroke({ width: 2, color, alpha: 0.9 });
    // Holograma del edificio real, verde si cabe y rojo si no, con un leve parpadeo.
    const art = BUILDING_ART[type] ? decorTexture(BUILDING_ART[type]!) : null;
    this.ghostArt.visible = !!art;
    if (art) {
      if (this.ghostArt.texture !== art) {
        this.ghostArt.texture = art;
        this.ghostArt.anchor.copyFrom(art.defaultAnchor ?? { x: 0.5, y: 1 });
      }
      this.ghostArt.position.set(isoX((x0 + x1) / 2, (y0 + y1) / 2), isoY((x0 + x1) / 2, (y0 + y1) / 2));
      this.ghostArt.tint = valid ? 0x9dffc8 : 0xff8080;
      this.ghostArt.alpha = 0.45 + 0.12 * Math.sin(this.time * 5);
    }
  }
}

/** Colores de la red: propia, aliada y la zona donde se solapan. */
const POWER_OWN = 0x7dffb0;
const POWER_ALLY = 0x6aa8ff;
const POWER_BOTH = 0x4fe3e3;

function dashed(g: Graphics, x1: number, y1: number, x2: number, y2: number, color = 0xfacc15, alpha = 0.6): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(1, Math.floor(len / 10));
  for (let i = 0; i < n; i += 2) {
    const a = i / n;
    const b = Math.min(1, (i + 1) / n);
    g.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a).lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
  }
  g.stroke({ width: 1.5, color, alpha });
}

function drawTerrain(map: GameMap): Graphics {
  const g = new Graphics();
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const t = map.tiles[ty * map.w + tx];
      const v = ((tx * 73856093) ^ (ty * 19349663)) & 3;
      const color =
        t === GRASS ? [0x4a7a3a, 0x4f8040, 0x477536, 0x52843f][v] : t === ROCK ? [0x77736b, 0x6e6a62, 0x7c786f, 0x726e66][v] : [0x2f6490, 0x2d6089, 0x316894, 0x2e628c][v];
      const x0 = tx * SUB;
      const y0 = ty * SUB;
      const x1 = x0 + SUB;
      const y1 = y0 + SUB;
      g.poly([isoX(x0, y0), isoY(x0, y0), isoX(x1, y0), isoY(x1, y0), isoX(x1, y1), isoY(x1, y1), isoX(x0, y1), isoY(x0, y1)]).fill(color);
    }
  }
  return g;
}

/** Textura a partir de un lienzo 2D (círculos y anillos para efectos y sombras). */
function canvasTexture(n: number, draw: (x: CanvasRenderingContext2D, n: number) => void): Texture {
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  draw(c.getContext('2d')!, n);
  const t = Texture.from(c);
  t.source.scaleMode = 'linear';
  return t;
}

/** Barra (fondo + relleno) hecha con dos sprites. `frac` < 0 la oculta. */
function setBar(bg: PixiSprite, fg: PixiSprite, y: number, w: number, frac: number, color: number): void {
  const on = frac >= 0;
  bg.visible = on;
  fg.visible = on;
  if (!on) return;
  bg.position.set(-w / 2, y);
  bg.width = w;
  bg.height = 4;
  bg.tint = 0x111111;
  fg.position.set(-w / 2, y);
  fg.width = Math.max(0, w * Math.min(1, frac));
  fg.height = 4;
  fg.tint = color;
}

function hpColor(frac: number): number {
  return frac > 0.6 ? 0x4ade80 : frac > 0.3 ? 0xfacc15 : 0xef4444;
}

function bar(g: Graphics, y: number, w: number, frac: number, color: number): void {
  g.rect(-w / 2, y, w, 4).fill(0x111111);
  g.rect(-w / 2, y, w * Math.max(0, Math.min(1, frac)), 4).fill(color);
}

function drawNode(g: Graphics, n: MetalNode): void {
  const s = 0.6 + 0.4 * Math.min(1, n.amount / 400);
  g.poly([0, -12, 24, 0, 0, 12, -24, 0]).fill({ color: 0x3a3f47, alpha: 0.6 });
  const shards: [number, number, number][] = [
    [-9, 10, 22],
    [2, 8, 30],
    [11, 7, 18],
  ];
  for (const [x, w, h] of shards) {
    const hh = h * s;
    g.poly([x - w / 2, 2, x, -hh, x + w / 2, 2]).fill(0x8d9aab);
    g.poly([x, -hh, x + w / 2, 2, x + 1, 3]).fill(0x5f6b7a);
    g.moveTo(x - 1, -hh + 4).lineTo(x - w / 4, -2).stroke({ width: 1, color: 0xd6e2f0, alpha: 0.8 });
  }
}

/** Barras (vida y producción) de un edificio: posición y ancho, calculados al dibujarlo. */
const BAR_SPEC = new WeakMap<Container, { y: number; w: number }>();

/**
 * Etiqueta de un edificio: un único Text por edificio que se reutiliza (crear textos es caro y cada uno
 * es una textura en la GPU; recrearlos con cada golpe llegaba a agotar la memoria de vídeo).
 */
function setLabel(c: Container, text: string, y: number, size: number): void {
  let t = c.children.find((ch) => ch.label === 'label') as Text | undefined;
  if (!t) {
    t = new Text({ text, style: { fontFamily: 'Menlo, monospace', fontSize: size, fill: 0xf3e9d8, stroke: { color: 0x111111, width: 3 } } });
    t.label = 'label';
    t.anchor.set(0.5);
    c.addChild(t);
  } else if (t.text !== text) t.text = text;
  t.position.set(0, y);
}

/** Paleta de los edificios según la generación de su dueño (reskin al avanzar). */
interface Palette {
  left: number;
  right: number;
  roof: number;
}
const GEN_PAL: Record<number, Palette> = {
  1: { left: 0x6f6878, right: 0x4b4555, roof: 0x8a8494 }, // Prototipos: hormigón gris
  2: { left: 0x6c7786, right: 0x444f5d, roof: 0x8e99a8 }, // Producción en serie: chapa de acero
  3: { left: 0x3b3649, right: 0x25212f, roof: 0x4b4559 }, // Reactor de núcleo: paneles oscuros
};
let PAL = GEN_PAL[1];

/**
 * Detalles de la generación sobre las caras de un edificio: nervaduras y franja de peligro (Gen-2),
 * juntas que brillan en cian (Gen-3).
 */
function genDetails(g: Graphics, hw: number, hh: number, h: number, gen: number): void {
  if (gen === 2) {
    for (let k = 1; k <= 3; k++) {
      const y = -(h * k) / 4;
      g.moveTo(-hw, y).lineTo(0, hh + y).lineTo(hw, y).stroke({ width: 1, color: 0x2f3844, alpha: 0.8 });
    }
    for (let k = 0; k < 6; k++) {
      const t0 = k / 6;
      const t1 = (k + 0.5) / 6;
      g.poly([hw * t0, hh * (1 - t0) - 2, hw * t1, hh * (1 - t1) - 2, hw * t1, hh * (1 - t1) - 7, hw * t0, hh * (1 - t0) - 7]).fill(0xe8a33a);
    }
  } else if (gen === 3) {
    const glow = 0x3ee6ff;
    g.moveTo(-hw, -h).lineTo(0, hh - h).lineTo(hw, -h).stroke({ width: 1.5, color: glow, alpha: 0.85 });
    g.moveTo(0, hh).lineTo(0, hh - h).stroke({ width: 1.5, color: glow, alpha: 0.6 });
    g.moveTo(-hw, -h / 2).lineTo(0, hh - h / 2).lineTo(hw, -h / 2).stroke({ width: 1, color: glow, alpha: 0.4 });
    for (let k = 1; k <= 3; k++) g.rect(-hw + (hw * k) / 4 - 2, (hh * k) / 4 - h * 0.7, 4, 3).fill({ color: glow, alpha: 0.9 });
  }
}

/** Píxeles de pantalla por casilla de altura en los renders (elevación de 30°: 64/√2 · cos 30°). */
const TILE_HEIGHT_PX = (64 / Math.SQRT2) * Math.cos(Math.PI / 6);

/** Edificios con arte prerenderizado en Blender (ver art/render_buildings.py): frame del atlas. */
const BUILDING_ART: Partial<Record<BuildingType, string>> = { hq: 'hq_0', barracks: 'barracks_0', hangar: 'hangar_0', cradle: 'cradle_0', tower: 'tower_0', relay: 'relay_0', depot: 'depot_0', plant: 'plant_0' };

/**
 * Edificio como sprite: el render en color y encima la máscara de color de equipo teñida con el color del
 * jugador. Devuelve false si el atlas no está cargado (se dibuja la versión vectorial).
 */
function drawBuildingArt(g: Graphics, c: Container, b: Building, selected: boolean, frame: string, prog: number): boolean {
  const tex = decorTexture(frame);
  if (!tex) return false;
  const team = decorTexture(`${frame}_team`);
  let base = c.children.find((ch) => ch.label === 'art') as PixiSprite | undefined;
  if (!base) {
    // Holograma (obra): el edificio entero, translúcido y azulado, detrás de la parte ya levantada.
    const holo = new PixiSprite(tex);
    holo.label = 'holo';
    holo.tint = 0x7fd4ff;
    c.addChildAt(holo, 1);
    base = new PixiSprite(tex);
    base.label = 'art';
    c.addChildAt(base, 2);
    if (team) {
      const t = new PixiSprite(team);
      t.label = 'art-team';
      t.tint = PLAYER_COLORS[b.owner] ?? 0xcccccc;
      c.addChildAt(t, 3);
    }
    const mask = new Graphics();
    mask.label = 'art-mask';
    c.addChild(mask);
    const scan = new Graphics();
    scan.label = 'scan';
    c.addChild(scan);
  }
  const holo = c.children.find((ch) => ch.label === 'holo') as PixiSprite;
  const teamSpr = c.children.find((ch) => ch.label === 'art-team') as PixiSprite | undefined;
  const mask = c.children.find((ch) => ch.label === 'art-mask') as Graphics;
  const scan = c.children.find((ch) => ch.label === 'scan') as Graphics;
  const done = prog >= 100;
  holo.visible = !done;
  scan.clear();
  mask.clear();
  if (done) {
    base.mask = null;
    if (teamSpr) teamSpr.mask = null;
    mask.visible = false;
  } else {
    // La parte construida sube en altura real (eje vertical del mundo): se muestra lo que cae dentro del
    // prisma de la huella hasta la altura de la obra, y el plano de corte es un rombo de luz.
    const hw = (b.size * TW) / 2;
    const hh = (b.size * TH) / 2;
    const full = tex.height * (tex.defaultAnchor?.y ?? 1) - hh + 6;
    const H = full * Math.max(0.03, prog / 100);
    const m = 1.12; // un poco más ancho que la huella: aleros y antenas que sobresalen
    mask.visible = true;
    mask.poly([-hw * m, 0, 0, hh * m, hw * m, 0, hw * m, -H, 0, -hh * m - H, -hw * m, -H]).fill(0xffffff);
    base.mask = mask;
    // Dos máscaras no pueden compartir el mismo Graphics: el color de equipo aparece al terminar.
    if (teamSpr) teamSpr.visible = false;
    const top = [0, -hh - H, hw, -H, 0, hh - H, -hw, -H];
    scan.poly(top).fill({ color: 0x8fdcff, alpha: 0.14 });
    scan.poly(top).stroke({ width: 2, color: 0xbff4ff, alpha: 0.9 });
    // Aristas verticales del andamio de luz, desde el suelo hasta el plano de corte.
    for (const [x, y] of [[-hw, 0], [0, hh], [hw, 0]]) scan.moveTo(x, y).lineTo(x, y - H);
    scan.stroke({ width: 1, color: 0x8fdcff, alpha: 0.45 });
  }
  if (done && teamSpr) teamSpr.visible = true;
  const hw2 = (b.size * TW) / 2;
  const hh2 = (b.size * TH) / 2;
  if (selected) g.poly([0, -hh2 - 4, hw2 + 8, 0, 0, hh2 + 4, -hw2 - 8, 0]).stroke({ width: 2, color: 0xffffff });
  if (b.type === 'relay') {
    // Luz de estado en lo alto de la antena: verde con red, roja sin ella.
    let light = c.children.find((ch) => ch.label === 'art-light') as Graphics | undefined;
    if (!light) {
      light = new Graphics();
      light.label = 'art-light';
      c.addChild(light);
    }
    light.clear();
    const col = b.powered ? 0x7dffb0 : 0xff4d6d;
    const ly = -1.62 * TILE_HEIGHT_PX - 4;
    light.circle(0, ly, 6).fill({ color: col, alpha: 0.3 });
    light.circle(0, ly, 2.8).fill(col);
  }
  const label = c.children.find((ch) => ch.label === 'label');
  if (label) label.visible = false;
  BAR_SPEC.set(c, { y: -tex.height * (tex.defaultAnchor?.y ?? 1) - 8, w: 80 });
  return true;
}

function drawBuilding(g: Graphics, c: Container, b: Building, selected: boolean, prog: number, train: number, gen = 1): void {
  if (BUILDING_ART[b.type] && drawBuildingArt(g, c, b, selected, BUILDING_ART[b.type]!, b.complete ? 100 : prog)) return;
  PAL = GEN_PAL[gen] ?? GEN_PAL[1];
  const hw = (b.size * TW) / 2;
  const hh = (b.size * TH) / 2;
  const full = BUILDING_HEIGHT[b.type];
  const h = b.complete ? full : Math.max(6, (full * prog) / 100);
  const color = PLAYER_COLORS[b.owner] ?? 0xcccccc;
  const alpha = b.complete ? 1 : 0.55;
  if (b.type === 'tower') return drawTower(g, c, b, selected, prog, hw, hh, h, full, color, alpha);
  if (b.type === 'relay') return drawRelay(g, c, b, selected, prog, hw, hh, full, color, alpha);
  if (b.type === 'plant') return drawPlant(g, c, b, selected, prog, hw, hh, h, full, color, alpha);

  g.poly([0, -hh, hw, 0, 0, hh, -hw, 0]).fill({ color: 0x000000, alpha: 0.25 });
  if (selected) g.poly([0, -hh - 4, hw + 8, 0, 0, hh + 4, -hw - 8, 0]).stroke({ width: 2, color: 0xffffff });
  g.poly([-hw, 0, 0, hh, 0, hh - h, -hw, -h]).fill({ color: PAL.left, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([0, hh, hw, 0, hw, -h, 0, hh - h]).fill({ color: PAL.right, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([0, -hh - h, hw, -h, 0, hh - h, -hw, -h]).fill({ color: PAL.roof, alpha }).stroke({ width: 1, color: 0x2a2630 });
  if (b.complete) genDetails(g, hw, hh, h, gen);
  if (b.complete) {
    g.poly([0, -hh / 2 - h, hw / 2, -h, 0, hh / 2 - h, -hw / 2, -h]).fill(color);
    g.poly([-hw, -10, 0, hh - 10, 0, hh - 16, -hw, -16]).fill(color);
    if (b.type === 'hq') {
      // Antena en el tejado: el cuartel general es la primera fuente de energía de la base.
      const ax = hw * 0.4;
      const ay = -h - hh * 0.2;
      g.moveTo(ax - 5, ay).lineTo(ax, ay - 34).lineTo(ax + 5, ay).stroke({ width: 2, color: 0x2a2630 });
      g.moveTo(ax - 3, ay - 12).lineTo(ax + 3, ay - 12).moveTo(ax - 2, ay - 22).lineTo(ax + 2, ay - 22).stroke({ width: 1, color: 0x2a2630 });
      g.ellipse(ax + 6, ay - 26, 6, 8).fill(0xd8d2c4).stroke({ width: 1, color: 0x2a2630 });
      g.circle(ax, ay - 36, 5).fill({ color: 0x7dffb0, alpha: 0.3 });
      g.circle(ax, ay - 36, 2.5).fill(0x7dffb0);
    }
    if (b.type === 'cradle') {
      // Grúas de la cuna: dos pórticos altos que la distinguen a lo lejos.
      for (const x of [-hw * 0.55, hw * 0.55]) {
        g.rect(x - 3, -h - 70, 6, 70).fill(0x2a2630);
        g.rect(x - 14, -h - 70, 28, 5).fill(color);
      }
    }
  } else {
    // Andamios: líneas verticales sobre las caras mientras se construye.
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      g.moveTo(-hw * (1 - t), hh * t).lineTo(-hw * (1 - t), hh * t - full).stroke({ width: 1, color: 0xc9a44a, alpha: 0.7 });
      g.moveTo(hw * t, hh * (1 - t)).lineTo(hw * t, hh * (1 - t) - full).stroke({ width: 1, color: 0xc9a44a, alpha: 0.7 });
    }
  }

  setLabel(c, b.complete ? BUILDING_NAMES[b.type].toUpperCase() : `${BUILDING_NAMES[b.type].toUpperCase()} ${prog}%`, -h, 11);
  BAR_SPEC.set(c, { y: -hh - Math.max(h, full) - 16, w: 80 });
  void train;
}

/** Torre: base baja, fuste esbelto y torreta con cañón en lo alto. */
function drawTower(g: Graphics, c: Container, b: Building, selected: boolean, prog: number, hw: number, hh: number, h: number, full: number, color: number, alpha: number): void {
  g.poly([0, -hh, hw, 0, 0, hh, -hw, 0]).fill({ color: 0x000000, alpha: 0.25 });
  if (selected) g.poly([0, -hh - 4, hw + 8, 0, 0, hh + 4, -hw - 8, 0]).stroke({ width: 2, color: 0xffffff });
  const base = Math.min(h, 16);
  // Base
  g.poly([-hw, 0, 0, hh, 0, hh - base, -hw, -base]).fill({ color: PAL.left, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([0, hh, hw, 0, hw, -base, 0, hh - base]).fill({ color: PAL.right, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([0, -hh - base, hw, -base, 0, hh - base, -hw, -base]).fill({ color: PAL.roof, alpha });
  if (h > base) {
    // Fuste
    const sw = hw * 0.32;
    const top = -h + 18;
    g.poly([-sw, -base + 4, 0, -base + 10, 0, top + 6, -sw, top]).fill({ color: PAL.left, alpha }).stroke({ width: 1, color: 0x2a2630 });
    g.poly([0, -base + 10, sw, -base + 4, sw, top, 0, top + 6]).fill({ color: PAL.right, alpha }).stroke({ width: 1, color: 0x2a2630 });
    g.rect(-sw, (top - base) / 2 - 2, sw * 2, 4).fill({ color, alpha });
  }
  if (b.complete) {
    // Torreta y cañón
    const ty = -h + 8;
    g.poly([-14, ty, 0, ty + 7, 14, ty, 14, ty - 10, 0, ty - 3, -14, ty - 10]).fill(PAL.roof).stroke({ width: 1, color: 0x2a2630 });
    g.poly([-14, ty - 10, 0, ty - 17, 14, ty - 10, 0, ty - 3]).fill(0xa39cab).stroke({ width: 1, color: 0x2a2630 });
    g.moveTo(4, ty - 8).lineTo(22, ty - 16).stroke({ width: 3, color: 0x2a2630 });
    g.circle(0, ty - 10, 2.5).fill(color);
  } else {
    g.moveTo(-hw * 0.3, 0).lineTo(-hw * 0.3, -full).moveTo(hw * 0.3, 0).lineTo(hw * 0.3, -full).stroke({ width: 1, color: 0xc9a44a, alpha: 0.7 });
  }
  setLabel(c, b.complete ? 'TORRE' : `TORRE ${prog}%`, hh + 8, 10);
  BAR_SPEC.set(c, { y: -full - 26, w: 40 });
}

/** Antena repetidora: mástil de celosía, parábola y una luz verde (con energía) o roja (sin ella). */
function drawRelay(g: Graphics, c: Container, b: Building, selected: boolean, prog: number, hw: number, hh: number, full: number, color: number, alpha: number): void {
  g.poly([0, -hh, hw, 0, 0, hh, -hw, 0]).fill({ color: 0x000000, alpha: 0.25 });
  if (selected) g.poly([0, -hh - 4, hw + 8, 0, 0, hh + 4, -hw - 8, 0]).stroke({ width: 2, color: 0xffffff });
  const h = b.complete ? full : Math.max(8, (full * prog) / 100);
  // Patas y celosía
  g.moveTo(-10, 2).lineTo(-2, -h).moveTo(10, 2).lineTo(2, -h).stroke({ width: 2, color: PAL.right, alpha });
  for (let y = 0; y > -h + 8; y -= 10) {
    const t = -y / h;
    const wx = 10 - 8 * t;
    g.moveTo(-wx, y).lineTo(wx - 1.5, y - 10).stroke({ width: 1, color: PAL.left, alpha });
  }
  if (b.complete) {
    // Parábola y luz de estado
    g.ellipse(7, -h + 10, 8, 10).fill(0xd8d2c4).stroke({ width: 1, color: 0x2a2630 });
    g.moveTo(7, -h + 10).lineTo(14, -h + 6).stroke({ width: 1.5, color: 0x2a2630 });
    g.rect(-2, -h + 16, 4, 3).fill(color);
    const light = b.powered ? 0x7dffb0 : 0xff4d6d;
    g.circle(0, -h - 2, 5).fill({ color: light, alpha: 0.3 });
    g.circle(0, -h - 2, 2.5).fill(light);
  }
  setLabel(c, b.complete ? (b.powered ? 'ANTENA' : 'ANTENA · SIN RED') : `ANTENA ${prog}%`, hh + 7, 9);
  BAR_SPEC.set(c, { y: -full - 14, w: 30 });
}

/** Central: nave baja con una torre de refrigeración y un núcleo de cristal encendido. */
function drawPlant(g: Graphics, c: Container, b: Building, selected: boolean, prog: number, hw: number, hh: number, h: number, full: number, color: number, alpha: number): void {
  g.poly([0, -hh, hw, 0, 0, hh, -hw, 0]).fill({ color: 0x000000, alpha: 0.25 });
  if (selected) g.poly([0, -hh - 4, hw + 8, 0, 0, hh + 4, -hw - 8, 0]).stroke({ width: 2, color: 0xffffff });
  const base = Math.min(h, 28);
  g.poly([-hw, 0, 0, hh, 0, hh - base, -hw, -base]).fill({ color: PAL.left, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([0, hh, hw, 0, hw, -base, 0, hh - base]).fill({ color: PAL.right, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([0, -hh - base, hw, -base, 0, hh - base, -hw, -base]).fill({ color: PAL.roof, alpha }).stroke({ width: 1, color: 0x2a2630 });
  g.poly([-hw, -10, 0, hh - 10, 0, hh - 15, -hw, -15]).fill({ color, alpha });
  if (b.complete) genDetails(g, hw, hh, base, PAL === GEN_PAL[3] ? 3 : PAL === GEN_PAL[2] ? 2 : 1);
  if (b.complete) {
    // Torre de refrigeración (hiperboloide aproximado) detrás, a la izquierda
    const tx = -hw * 0.45;
    const ty = -base - 4;
    g.poly([tx - 16, ty, tx - 11, ty - 26, tx - 14, ty - 44, tx + 14, ty - 44, tx + 11, ty - 26, tx + 16, ty]).fill(0xb9b2a4).stroke({ width: 1, color: 0x2a2630 });
    g.ellipse(tx, ty - 44, 14, 5).fill(PAL.left);
    // Núcleo de cristal encendido
    const cx = hw * 0.3;
    const cy = -base - 2;
    g.circle(cx, cy - 12, 16).fill({ color: 0x3ee6ff, alpha: 0.18 });
    g.poly([cx - 7, cy, cx, cy - 26, cx + 7, cy]).fill(0x8ff3ff).stroke({ width: 1, color: 0x2aa9c8 });
    g.poly([cx, cy - 26, cx + 7, cy, cx + 1, cy + 1]).fill(0x2aa9c8);
  }
  setLabel(c, b.complete ? 'CENTRAL' : `CENTRAL ${prog}%`, hh + 10, 11);
  BAR_SPEC.set(c, { y: -hh - full - 16, w: 60 });
}

/** Estado visual de una unidad, lo que decide su textura (no su posición ni su vida). */
interface BodyState {
  type: UnitType;
  color: number;
  carry: boolean;
  deployState: number;
  nodePowered: boolean;
  /** Luz de energía: '' (no depende de la red), 'on', 'out' u 'off'. */
  light: string;
}

/** Dibuja el cuerpo de una unidad (sin sombra, anillo ni barras): se hornea una vez en una textura. */
function drawUnitBody(g: Graphics, u: BodyState): void {
  const color = u.color;
  const box = UNIT_BOX[u.type];
  switch (u.type) {
    case 'worker': {
      // Obrero: bajo y robusto, overol del color de su jugador con bandas reflectantes, casco amarillo y pico al hombro.
      const overall = mix(color, 0xffffff, 0.2);
      g.moveTo(-1.6, 0).lineTo(-1.6, -6).moveTo(1.6, 0).lineTo(1.6, -6).stroke({ width: 2, color: mix(color, 0x000000, 0.35) });
      g.rect(-3.4, -13, 6.8, 7.5).fill(overall).stroke({ width: 1, color: 0x1a1a1a });
      g.rect(-3.4, -11, 6.8, 1).fill(0xf8f4e0);
      g.rect(-3.4, -8.5, 6.8, 1).fill(0xf8f4e0);
      g.circle(0, -14.8, 2.2).fill(0xe0c09a);
      g.ellipse(0, -16.4, 3.4, 2).fill(0xfacc15).stroke({ width: 0.8, color: 0x7a5a00 });
      g.rect(-3.8, -16.2, 7.6, 0.9).fill(0xfacc15);
      // Pico al hombro
      g.moveTo(2, -12).lineTo(-4, -19).stroke({ width: 1.2, color: 0x7c4a1e });
      g.moveTo(-6.5, -17.5).quadraticCurveTo(-4.5, -20.5, -1.5, -20).stroke({ width: 1.4, color: 0x9ca3af });
      if (u.carry) g.rect(3, -11, 5, 4).fill(0x8d9aab).stroke({ width: 1, color: 0x3a3f47 });
      break;
    }
    case 'soldier': {
      // Soldado: más alto y delgado, uniforme oliva con el torso del color de su jugador, casco y mochila oliva, rifle largo.
      const olive = 0x4b5a36;
      g.moveTo(-1.5, 0).lineTo(-1.5, -8).moveTo(1.5, 0).lineTo(1.5, -8).stroke({ width: 1.5, color: 0x2e3326 });
      g.rect(-4.2, -16, 2.2, 6).fill(olive);
      g.rect(-2.8, -16, 5.6, 8).fill(mix(color, 0x000000, 0.15)).stroke({ width: 1, color: 0x111111 });
      g.moveTo(-2.4, -16).lineTo(2.4, -9).stroke({ width: 1, color: olive });
      g.circle(0, -18.5, 2.2).fill(0xe0c09a);
      g.ellipse(0, -20.2, 3, 1.8).fill(olive).stroke({ width: 0.8, color: 0x2e3326 });
      g.moveTo(-3, -9).lineTo(7, -18).stroke({ width: 1.6, color: 0x1a1a1a });
      break;
    }
    case 'mech':
      drawMech(g, color);
      break;
    case 'artillery':
      drawArtillery(g, color);
      break;
    case 'truck':
      drawTruck(g, color, u.deployState, u.nodePowered);
      break;
    case 'colossus':
      drawColossus(g, color);
      break;
    case 'siege':
      drawSiege(g, color);
      break;
  }

  if (u.light) {
    // Luz de estado sobre la cabeza: verde conectada, roja fuera de la red, gris apagada.
    const light = u.light === 'on' ? 0x7dffb0 : u.light === 'out' ? 0xff4d6d : 0x555555;
    g.circle(box.w / 2 + 3, -box.h + 4, 3).fill(light).stroke({ width: 1, color: 0x111111 });
  }
}

/** Mecha: piernas y brazos largos, torso estrecho, cabeza pequeña con visor. */
function drawMech(g: Graphics, color: number): void {
  const frame = 0x23202b;
  const armor = 0xe6dccb;
  // Piernas
  g.poly([-7, 0, -3, 0, -3, -38, -7, -38]).fill(armor).stroke({ width: 1, color: frame });
  g.poly([3, 0, 7, 0, 7, -38, 3, -38]).fill(armor).stroke({ width: 1, color: frame });
  g.rect(-8, -24, 6, 4).fill(color);
  g.rect(2, -24, 6, 4).fill(color);
  // Cadera y torso
  g.poly([-7, -42, 7, -42, 5, -36, -5, -36]).fill(frame);
  g.poly([-9, -62, 9, -62, 5, -43, -5, -43]).fill(armor).stroke({ width: 1, color: frame });
  g.rect(-2, -60, 4, 14).fill(color);
  // Brazos largos
  g.poly([-13, -60, -9, -60, -10, -30, -13, -30]).fill(armor).stroke({ width: 1, color: frame });
  g.poly([9, -60, 13, -60, 13, -30, 10, -30]).fill(armor).stroke({ width: 1, color: frame });
  g.poly([-16, -66, -8, -64, -9, -58, -16, -58]).fill(color);
  g.poly([16, -66, 8, -64, 9, -58, 16, -58]).fill(color);
  // Cabeza, visor y antenas
  g.poly([-3, -63, 3, -63, 3.5, -70, 0, -72, -3.5, -70]).fill(armor).stroke({ width: 1, color: frame });
  g.rect(-2.5, -68.5, 5, 1.5).fill(0x7dffb0);
  g.moveTo(-1, -71).lineTo(-6, -80).moveTo(1, -71).lineTo(6, -80).stroke({ width: 1.2, color: color });
}

/**
 * Camión repetidor. En marcha: caja cerrada con el mástil plegado. Desplegado: se reconoce de lejos por
 * las patas apoyadas con zapatas, las franjas de aviso, el mástil de celosía alto, la parábola grande y
 * la baliza con el color del jugador (verde o rojo arriba según tenga enlace).
 */
function drawTruck(g: Graphics, color: number, state: number, powered: boolean): void {
  const frame = 0x23202b;
  const body = 0xb9b2a4;
  if (state !== 0) {
    // Estabilizadores con zapatas
    for (const [x, y] of [[-24, 4], [24, 4], [-18, -10], [18, -10]]) {
      g.moveTo(x * 0.5, y - 8).lineTo(x, y).stroke({ width: 2.5, color: frame });
      if (state === 2) g.ellipse(x, y, 4, 2).fill(0x5b5f6a).stroke({ width: 1, color: frame });
    }
  }
  for (const x of [-11, -3, 9]) g.ellipse(x, 0, 4, 2.5).fill(frame);
  g.poly([-16, -3, 12, -3, 16, -8, 16, -16, -16, -16]).fill(body).stroke({ width: 1, color: frame });
  g.poly([8, -16, 16, -16, 16, -24, 10, -24]).fill(0x8a8494).stroke({ width: 1, color: frame });
  g.rect(10, -22, 5, 3).fill(0x7dd3fc);
  if (state === 2) {
    // Franjas de aviso amarillas y negras en la caja
    for (let i = 0; i < 7; i++) g.poly([-15 + i * 4, -4, -13 + i * 4, -4, -9 + i * 4, -15, -11 + i * 4, -15]).fill(i % 2 ? frame : 0xf2c14e);
    g.rect(-14, -12, 20, 3).fill(color);
    // Mástil de celosía alto
    g.moveTo(-9, -16).lineTo(-5, -70).moveTo(-1, -16).lineTo(-5, -70).stroke({ width: 1.8, color: frame });
    for (let y = -24; y > -66; y -= 8) {
      const k = (y + 16) / -54;
      g.moveTo(-9 + 4 * k, y).lineTo(-1 - 4 * k, y - 4).stroke({ width: 1, color: frame });
    }
    // Parábola grande orientada hacia fuera
    g.ellipse(6, -60, 9, 12).fill(0xe9e4d8).stroke({ width: 1.2, color: frame });
    g.ellipse(7, -60, 5, 8).fill({ color: 0xb9b2a4, alpha: 0.7 });
    g.moveTo(6, -60).lineTo(14, -62).stroke({ width: 1.2, color: frame });
    // Banderín del jugador y baliza de estado
    g.poly([-5, -70, 7, -74, -5, -78]).fill(color).stroke({ width: 1, color: frame });
    const light = powered ? 0x7dffb0 : 0xff4d6d;
    g.circle(-5, -82, 7).fill({ color: light, alpha: 0.25 });
    g.circle(-5, -82, 3).fill(light);
  } else if (state === 1) {
    g.rect(-14, -12, 20, 3).fill(color);
    g.moveTo(-6, -16).lineTo(2, -40).stroke({ width: 2.5, color: frame });
  } else {
    g.rect(-14, -12, 20, 3).fill(color);
    // Mástil plegado sobre la caja
    g.moveTo(-15, -18).lineTo(7, -18).stroke({ width: 2.5, color: frame });
    g.ellipse(-12, -20, 4, 2).fill(0xd8d2c4);
  }
}

/** Mecha de artillería: el mismo chasis esbelto, con un mortero largo sobre el hombro y munición a la espalda. */
function drawArtillery(g: Graphics, color: number): void {
  drawMech(g, color);
  const frame = 0x23202b;
  // Cajón de munición a la espalda
  g.poly([-14, -70, -4, -72, -4, -56, -14, -54]).fill(0x5b5f6a).stroke({ width: 1, color: frame });
  g.rect(-13, -66, 8, 2).fill(color);
  // Mortero: tubo largo que sube desde el hombro derecho
  g.poly([8, -60, 13, -62, 20, -94, 15, -93]).fill(0x4b4555).stroke({ width: 1, color: frame });
  g.poly([14, -92, 21, -95, 22, -99, 15, -97]).fill(frame);
  g.rect(9, -70, 8, 3).fill(color);
}

/** Coloso de asedio: zancudo de cuatro patas larguísimas con una batería de cohetes a la espalda. */
function drawSiege(g: Graphics, color: number): void {
  const armor = 0xd8d2c4;
  const dark = 0x3a3440;
  const frame = 0x23202b;
  // Patas traseras (detrás del cuerpo, más oscuras)
  for (const [hip, knee, foot] of [
    [[-12, -96], [-30, -60], [-20, -4]],
    [[12, -96], [30, -60], [22, -6]],
  ]) {
    g.moveTo(hip[0], hip[1]).lineTo(knee[0], knee[1]).lineTo(foot[0], foot[1]).stroke({ width: 3, color: 0x6f6878 });
    g.circle(knee[0], knee[1], 2.5).fill(frame);
  }
  // Cuerpo alargado
  g.poly([-26, -104, 22, -108, 30, -96, 24, -86, -24, -84, -30, -94]).fill(armor).stroke({ width: 1.5, color: frame });
  g.poly([-24, -84, 24, -86, 30, -96, 26, -92, -26, -90]).fill({ color: 0xa39c8e, alpha: 0.8 });
  g.rect(-20, -98, 36, 4).fill(color);
  // Cabeza sensora al frente
  g.poly([24, -104, 38, -100, 38, -92, 26, -90]).fill(armor).stroke({ width: 1, color: frame });
  g.circle(34, -96, 2.2).fill(0xff4d6d);
  // Batería de cohetes inclinada sobre el lomo
  g.poly([-22, -104, -4, -106, 6, -146, -12, -144]).fill(dark).stroke({ width: 1.5, color: frame });
  for (let i = 0; i < 3; i++) {
    g.poly([-12 + i * 6, -144, -8 + i * 6, -145, -4 + i * 6, -152, -8 + i * 6, -152]).fill(0xe6dccb);
    g.poly([-8 + i * 6, -152, -4 + i * 6, -152, -6 + i * 6, -156]).fill(color);
  }
  g.rect(-14, -126, 16, 3).fill(color);
  // Patas delanteras (delante del cuerpo)
  for (const [hip, knee, foot] of [
    [[-18, -88], [-44, -48], [-30, 0]],
    [[18, -88], [44, -48], [32, 0]],
  ]) {
    g.moveTo(hip[0], hip[1]).lineTo(knee[0], knee[1]).lineTo(foot[0], foot[1]).stroke({ width: 3.5, color: armor });
    g.moveTo(hip[0], hip[1]).lineTo(knee[0], knee[1]).lineTo(foot[0], foot[1]).stroke({ width: 1, color: frame, alpha: 0.4 });
    g.circle(knee[0], knee[1], 3).fill(frame);
    g.poly([foot[0] - 5, foot[1], foot[0] + 5, foot[1], foot[0], foot[1] - 6]).fill(frame);
  }
}

/** Coloso: figura de hueso inspirada en los Ángeles, piernas finísimas, núcleo brillante y halo. */
function drawColossus(g: Graphics, color: number): void {
  const bone = 0xe9e4d8;
  const shade = 0xb9b2a4;
  // Piernas que convergen
  g.poly([-16, 0, -12, 0, -3, -92, -6, -92]).fill(bone).stroke({ width: 1, color: shade });
  g.poly([12, 0, 16, 0, 6, -92, 3, -92]).fill(bone).stroke({ width: 1, color: shade });
  // Brazos muy largos colgando
  g.poly([-14, -140, -10, -140, -20, -40, -23, -42]).fill(bone).stroke({ width: 1, color: shade });
  g.poly([10, -140, 14, -140, 23, -42, 20, -40]).fill(bone).stroke({ width: 1, color: shade });
  // Cuerpo en rombo alargado con núcleo
  g.poly([0, -154, 14, -124, 0, -90, -14, -124]).fill(bone).stroke({ width: 1.5, color: shade });
  g.poly([0, -154, 14, -124, 0, -90]).fill({ color: shade, alpha: 0.6 });
  g.circle(0, -122, 6).fill({ color: 0xff4d6d, alpha: 0.35 });
  g.circle(0, -122, 3.5).fill(0xff4d6d);
  // Cabeza sin rostro y halo del color del jugador
  g.ellipse(0, -162, 4, 7).fill(bone).stroke({ width: 1, color: shade });
  g.ellipse(0, -171, 17, 4.5).stroke({ width: 2.5, color });
}

export { loadTerrainTextures } from './terrain';
export { loadDecor } from './decor';
export { loadUnitArt, prewarmTextures } from './units';
