import { Assets, Container, Sprite, type Spritesheet, type Texture } from 'pixi.js';
import { buildingCenter, GRASS, ROCK, SUB, WATER, type Building, type State, type Unit } from '@epocas/sim';

/**
 * Decoración del terreno: hierba, arbustos, árboles, rocas y chatarra, prerenderizados en Blender a partir
 * de modelos CC0 de Poly Haven (ver `art/`). Es solo visual: no bloquea el paso ni toca la simulación.
 * Se reparte con una semilla derivada del mapa, así que el mismo mapa siempre se decora igual.
 * Los mechas pesados derriban los árboles al pasar.
 */

let sheet: Spritesheet | null = null;

export async function loadDecor(url = 'decor/decor.json'): Promise<boolean> {
  try {
    sheet = await Assets.load(url);
    return true;
  } catch (e) {
    console.warn('Sin decoración:', e);
    return false;
  }
}

export function decorReady(): boolean {
  return sheet !== null;
}

/** Un frame concreto del atlas (p. ej. `ore_0_0`), o null si no hay atlas. */
export function decorTexture(name: string): Texture | null {
  return sheet?.textures[name] ?? null;
}

/** Nombres de los frames del atlas que empiezan por alguno de los prefijos. */
function pick(prefixes: string[]): Texture[] {
  const out: Texture[] = [];
  for (const [k, t] of Object.entries(sheet!.textures)) if (prefixes.some((p) => k.startsWith(p))) out.push(t);
  return out;
}

interface Tree {
  s: Sprite;
  x: number;
  y: number;
  alive: boolean;
}

export class Decor {
  /** Capa plana bajo las unidades (hierba, arbustos, piedras, chatarra baja), en trozos para recortar por vista. */
  readonly ground = new Container();
  private chunks: { c: Container; x0: number; y0: number; x1: number; y1: number }[] = [];
  /** Árboles y peñascos: se ordenan en profundidad con unidades y edificios. */
  private tall: { s: Sprite; x: number; y: number }[] = [];
  private trees: Tree[] = [];
  private treeGrid = new Map<number, Tree[]>();
  private fallen: Texture[] = [];
  /** Todo lo colocado, por casilla: se oculta bajo los edificios que se construyan encima. */
  private byTile = new Map<number, Sprite[]>();
  private cleared = new Set<number>();
  private readonly w: number;

  constructor(
    st: State,
    private readonly entityLayer: Container,
    private readonly isoX: (x: number, y: number) => number,
    private readonly isoY: (x: number, y: number) => number,
  ) {
    const { w, h, tiles } = st.map;
    this.w = w;
    let seed = (w * 2654435761 + h * 40503 + st.vents.length * 97) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const choose = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

    const grass = pick(['grass']);
    const weeds = pick(['weed', 'nettle']);
    const shrubs = pick(['shrub']);
    const stones = pick(['stone', 'rock_3', 'rock_2']);
    const rocks = pick(['rock_', 'boulder']);
    const scrap = pick(['barrel', 'wheel_rim', 'barrier', 'propane', 'crate', 'trash_can']);
    const trees = pick(['fir', 'pine', 'tree_small']);
    const dead = pick(['dead_trunk']);
    const conifers = pick(['fir', 'pine']);
    this.fallen = pick(['fallen']);

    // Zonas prohibidas para lo alto: alrededor de bases, vetas y metal.
    const hqs = st.buildings.filter((b) => b.type === 'hq').map((b) => buildingCenter(b));
    const far = (tx: number, ty: number, dHq: number, dRes: number) =>
      hqs.every((c) => Math.hypot(c.x / SUB - tx, c.y / SUB - ty) > dHq) &&
      st.vents.every((v) => Math.hypot(v.tx + 0.5 - tx, v.ty + 0.5 - ty) > dRes) &&
      st.nodes.every((n) => Math.hypot(n.tx + 0.5 - tx, n.ty + 0.5 - ty) > dRes);
    const tileAt = (tx: number, ty: number) => (tx < 0 || ty < 0 || tx >= w || ty >= h ? -1 : tiles[Math.floor(ty) * w + Math.floor(tx)]);

    // Trozos de 16×16 casillas para la capa plana.
    const CH = 16;
    const chunkOf = new Map<number, Container>();
    const chunk = (tx: number, ty: number) => {
      const k = Math.floor(ty / CH) * 1000 + Math.floor(tx / CH);
      let c = chunkOf.get(k);
      if (!c) {
        c = new Container();
        chunkOf.set(k, c);
        this.ground.addChild(c);
        const cx0 = Math.floor(tx / CH) * CH;
        const cy0 = Math.floor(ty / CH) * CH;
        const xs = [
          [cx0, cy0],
          [cx0 + CH, cy0],
          [cx0, cy0 + CH],
          [cx0 + CH, cy0 + CH],
        ].map(([x, y]) => isoX(x * SUB, y * SUB));
        const ys = [
          [cx0, cy0],
          [cx0 + CH, cy0 + CH],
        ].map(([x, y]) => isoY(x * SUB, y * SUB));
        this.chunks.push({ c, x0: Math.min(...xs) - 80, x1: Math.max(...xs) + 80, y0: ys[0] - 160, y1: ys[1] + 40 });
      }
      return c;
    };
    const place = (tex: Texture, tx: number, ty: number, scale: number, flat: boolean) => {
      const s = new Sprite(tex);
      s.anchor.set(tex.defaultAnchor?.x ?? 0.5, tex.defaultAnchor?.y ?? 1);
      const x = isoX(tx * SUB, ty * SUB);
      const y = isoY(tx * SUB, ty * SUB);
      s.position.set(x, y);
      s.scale.set(rnd() < 0.5 ? -scale : scale, scale);
      const key = Math.floor(ty) * w + Math.floor(tx);
      const list = this.byTile.get(key) ?? [];
      list.push(s);
      this.byTile.set(key, list);
      if (flat) chunk(tx, ty).addChild(s);
      else {
        s.zIndex = y;
        this.entityLayer.addChild(s);
        this.tall.push({ s, x, y });
      }
      return s;
    };

    // 1) Hierba y malas hierbas por todo lo verde, más densa en zonas (ruido de manchas).
    if (grass.length) {
      const n = Math.trunc(w * h * 0.55);
      for (let i = 0; i < n; i++) {
        const tx = rnd() * w;
        const ty = rnd() * h;
        if (tileAt(tx, ty) !== GRASS || !far(tx, ty, 7, 1.5)) continue;
        const clump = Math.sin(tx * 0.21) + Math.cos(ty * 0.17) + Math.sin((tx + ty) * 0.09);
        if (clump < -0.4 && rnd() < 0.7) continue;
        place(rnd() < 0.12 && weeds.length ? choose(weeds) : choose(grass), tx, ty, 0.9 + rnd() * 0.6, true);
      }
    }
    // 2) Arbustos sueltos y en grupos.
    if (shrubs.length) {
      const n = Math.trunc(w * h * 0.04);
      for (let i = 0; i < n; i++) {
        const cx = rnd() * w;
        const cy = rnd() * h;
        const k = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < k; j++) {
          const tx = cx + (rnd() - 0.5) * 2.2;
          const ty = cy + (rnd() - 0.5) * 2.2;
          if (tileAt(tx, ty) !== GRASS || !far(tx, ty, 8, 2)) continue;
          place(choose(shrubs), tx, ty, 0.8 + rnd() * 0.4, true);
        }
      }
    }
    // 3) Piedras sueltas y, en las casillas de roca, peñascos que la hacen leer como obstáculo.
    for (let i = 0; i < Math.trunc(w * h * 0.012); i++) {
      const tx = rnd() * w;
      const ty = rnd() * h;
      if (tileAt(tx, ty) === GRASS && far(tx, ty, 6, 1.5) && stones.length) place(choose(stones), tx, ty, 0.8 + rnd() * 0.6, true);
    }
    if (rocks.length) {
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          if (tiles[ty * w + tx] !== ROCK) continue;
          const k = 1 + Math.floor(rnd() * 2);
          for (let j = 0; j < k; j++) place(choose(rocks), tx + 0.2 + rnd() * 0.6, ty + 0.2 + rnd() * 0.6, 1 + rnd() * 0.6, false);
        }
      }
    }
    // 4) Bosquecillos lejos de las bases, y algún árbol suelto o seco.
    const plant = (tx: number, ty: number, tex: Texture, scale: number) => {
      const s = place(tex, tx, ty, scale, false);
      const t: Tree = { s, x: tx * SUB, y: ty * SUB, alive: true };
      this.trees.push(t);
      const key = Math.floor(ty) * w + Math.floor(tx);
      const list = this.treeGrid.get(key) ?? [];
      list.push(t);
      this.treeGrid.set(key, list);
    };
    if (trees.length) {
      const groves = Math.trunc((w * h) / 900);
      for (let g = 0; g < groves; g++) {
        const cx = rnd() * w;
        const cy = rnd() * h;
        if (tileAt(cx, cy) !== GRASS || !far(cx, cy, 16, 5)) continue;
        const r = 1.5 + rnd() * 3;
        const k = Math.trunc(r * r * 1.3);
        const kind = rnd();
        const pool = kind < 0.5 ? conifers : trees;
        for (let j = 0; j < k; j++) {
          const a = rnd() * Math.PI * 2;
          const d = Math.sqrt(rnd()) * r;
          const tx = cx + Math.cos(a) * d;
          const ty = cy + Math.sin(a) * d;
          if (tileAt(tx, ty) !== GRASS || !far(tx, ty, 14, 3.5)) continue;
          plant(tx, ty, choose(pool.length ? pool : trees), 0.8 + rnd() * 0.35);
        }
      }
      for (let i = 0; i < Math.trunc((w * h) / 250); i++) {
        const tx = rnd() * w;
        const ty = rnd() * h;
        if (tileAt(tx, ty) !== GRASS || !far(tx, ty, 12, 3)) continue;
        plant(tx, ty, rnd() < 0.3 && dead.length ? choose(dead) : choose(trees), 0.75 + rnd() * 0.35);
      }
    }
    // 5) Chatarra: restos de batallas en grupos, más en el centro del mapa, y algo junto al agua.
    if (scrap.length) {
      const piles = Math.trunc((w * h) / 260);
      for (let i = 0; i < piles; i++) {
        const cx = w / 2 + (rnd() - 0.5) * w * (rnd() < 0.6 ? 0.6 : 1);
        const cy = h / 2 + (rnd() - 0.5) * h * (rnd() < 0.6 ? 0.6 : 1);
        if (tileAt(cx, cy) === WATER || tileAt(cx, cy) === -1 || !far(cx, cy, 9, 2.5)) continue;
        const k = 1 + Math.floor(rnd() * 4);
        for (let j = 0; j < k; j++) {
          const tx = cx + (rnd() - 0.5) * 2.5;
          const ty = cy + (rnd() - 0.5) * 2.5;
          const t = tileAt(tx, ty);
          if (t !== GRASS || !far(tx, ty, 9, 2)) continue;
          place(choose(scrap), tx, ty, 1.4 + rnd() * 0.4, true);
        }
      }
    }
  }

  /** Recorte por vista, aplastado de árboles bajo los mechas pesados y limpieza bajo edificios. Cada frame. */
  update(view: { x0: number; y0: number; x1: number; y1: number }, units: readonly Unit[], buildings: readonly Building[]): void {
    for (const b of buildings) {
      if (this.cleared.has(b.id)) continue;
      this.cleared.add(b.id);
      for (let y = b.ty; y < b.ty + b.size; y++) for (let x = b.tx; x < b.tx + b.size; x++) for (const s of this.byTile.get(y * this.w + x) ?? []) s.renderable = false;
    }
    for (const ch of this.chunks) ch.c.visible = ch.x1 >= view.x0 && ch.x0 <= view.x1 && ch.y1 >= view.y0 && ch.y0 <= view.y1;
    for (const t of this.tall) t.s.visible = t.x >= view.x0 - 100 && t.x <= view.x1 + 100 && t.y >= view.y0 && t.y <= view.y1 + 300;
    if (!this.fallen.length) return;
    for (const u of units) {
      if (u.hp <= 0 || !(u.type === 'mech' || u.type === 'artillery' || u.type === 'colossus' || u.type === 'siege' || u.type === 'truck')) continue;
      const tx = Math.floor(u.x / SUB);
      const ty = Math.floor(u.y / SUB);
      const r = u.radius + 40;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = this.treeGrid.get((ty + dy) * this.w + (tx + dx));
          if (!list) continue;
          for (const t of list) {
            if (!t.alive || (t.x - u.x) ** 2 + (t.y - u.y) ** 2 > r * r) continue;
            t.alive = false;
            // Derribado: el mismo árbol, tumbado (conserva su tamaño y orientación).
            const down = this.fallen[Math.floor(t.x + t.y) % this.fallen.length];
            t.s.texture = down;
            t.s.anchor.set(down.defaultAnchor?.x ?? 0.5, down.defaultAnchor?.y ?? 1);
          }
        }
      }
    }
  }
}
