import { footprintVisible, GRASS, isExplored, isVisible, ROCK, SUB, type State } from '@epocas/sim';
import { PLAYER_COLORS, type Pos } from '@epocas/render';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * Minimapa isométrico (un rombo, igual que el mapa). Cada casilla ocupa `SCALE` px de ancho;
 * el terreno se pinta una sola vez y encima se redibujan entidades y el recuadro de la cámara.
 */
export class Minimap {
  static readonly SCALE = 2;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrain: HTMLCanvasElement;
  private readonly w: number;
  private readonly h: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly st: State,
    private readonly me = 0,
  ) {
    const m = st.map;
    const s = Minimap.SCALE;
    this.w = (m.w + m.h) * s;
    this.h = ((m.w + m.h) * s) / 2;
    canvas.width = this.w;
    canvas.height = this.h;
    this.ctx = canvas.getContext('2d')!;

    this.terrain = document.createElement('canvas');
    this.terrain.width = this.w;
    this.terrain.height = this.h;
    const t = this.terrain.getContext('2d')!;
    for (let ty = 0; ty < m.h; ty++) {
      for (let tx = 0; tx < m.w; tx++) {
        const tile = m.tiles[ty * m.w + tx];
        t.fillStyle = tile === GRASS ? '#5b6a2c' : tile === ROCK ? '#6f6650' : '#1f4a5c';
        const p = this.toMini(tx * SUB, ty * SUB);
        t.fillRect(p.x - s / 2, p.y, s, s / 2 + 1);
      }
    }
  }

  /** Subunidades del mundo → px del minimapa. */
  toMini(x: number, y: number): Pos {
    const s = Minimap.SCALE;
    const tx = x / SUB;
    const ty = y / SUB;
    return { x: this.w / 2 + (tx - ty) * s, y: ((tx + ty) * s) / 2 };
  }

  /** Px del minimapa → subunidades del mundo. */
  toWorld(px: number, py: number): Pos {
    const s = Minimap.SCALE;
    const a = (px - this.w / 2) / s;
    const b = (py * 2) / s;
    return { x: ((a + b) / 2) * SUB, y: ((b - a) / 2) * SUB };
  }

  /** Capa base (terreno + red + niebla) como imagen, rehecha solo cuando cambian la red o la visión. */
  private base = document.createElement('canvas');
  private baseKey = '';

  private drawBase(): void {
    const { st } = this;
    const key = `${st.powerVersion}|${st.visionVersion}`;
    if (key === this.baseKey) return;
    this.baseKey = key;
    this.base.width = this.w;
    this.base.height = this.h;
    const b = this.base.getContext('2d')!;
    b.drawImage(this.terrain, 0, 0);
    // Red propia y niebla, casilla a casilla sobre un ImageData (mucho más barato que miles de rectángulos).
    const img = b.getImageData(0, 0, this.w, this.h);
    const d = img.data;
    const bit = 1 << this.me;
    let allies = 0;
    st.players.forEach((pl, q) => {
      if (q !== this.me && pl.team === st.players[this.me].team) allies |= 1 << q;
    });
    const s = Minimap.SCALE;
    const { w: mw, h: mh } = st.map;
    for (let ty = 0; ty < mh; ty++) {
      for (let tx = 0; tx < mw; tx++) {
        const i = ty * mw + tx;
        const own = (st.power[i] & bit) !== 0;
        const ally = (st.power[i] & allies) !== 0;
        const powered = own || ally;
        // Verde la red propia, azul la aliada, turquesa donde se solapan.
        const [pr, pg, pb] = own && ally ? [79, 227, 227] : own ? [125, 255, 176] : [106, 168, 255];
        const visible = (st.vision[i] & bit) !== 0;
        const explored = (st.explored[i] & bit) !== 0;
        if (!powered && visible) continue;
        const p = this.toMini(tx * SUB, ty * SUB);
        const x0 = Math.round(p.x - s / 2);
        const y0 = Math.round(p.y);
        for (let yy = y0; yy < y0 + s / 2 + 1; yy++) {
          for (let xx = x0; xx < x0 + s; xx++) {
            if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
            const o = (yy * this.w + xx) * 4;
            if (powered) {
              d[o] = (d[o] * 3 + pr) >> 2;
              d[o + 1] = (d[o + 1] * 3 + pg) >> 2;
              d[o + 2] = (d[o + 2] * 3 + pb) >> 2;
            }
            if (!visible) {
              const k = explored ? 0.45 : 0;
              d[o] = 7 + (d[o] - 7) * k;
              d[o + 1] = 5 + (d[o + 1] - 5) * k;
              d[o + 2] = 11 + (d[o + 2] - 11) * k;
              d[o + 3] = 255;
            }
          }
        }
      }
    }
    b.putImageData(img, 0, 0);
  }

  /** `view` son las 4 esquinas de la pantalla en subunidades del mundo. */
  draw(view: Pos[]): void {
    const { ctx, st } = this;
    this.drawBase();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.base, 0, 0);
    const bit = 1 << this.me;
    const s = Minimap.SCALE;
    void bit;
    void s;
    ctx.fillStyle = '#3ee6ff';
    for (const v of st.vents) {
      if (!isExplored(st, this.me, v.tx * SUB, v.ty * SUB)) continue;
      const p = this.toMini(v.tx * SUB + SUB / 2, v.ty * SUB + SUB / 2);
      ctx.fillRect(p.x - 2, p.y - 1, 4, 3);
    }

    ctx.fillStyle = '#b8c4d4';
    for (const n of st.nodes) {
      if (!isExplored(st, this.me, n.tx * SUB, n.ty * SUB)) continue;
      const p = this.toMini(n.tx * SUB + SUB / 2, n.ty * SUB + SUB / 2);
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }
    for (const b of st.buildings) {
      // Edificios enemigos: solo los que están a la vista o en zona explorada (último recuerdo).
      if (b.owner !== this.me && !footprintVisible(st, this.me, b.tx, b.ty, b.size) && !isExplored(st, this.me, (b.tx + b.size / 2) * SUB, (b.ty + b.size / 2) * SUB)) continue;
      const half = (b.size * SUB) / 2;
      const p = this.toMini(b.tx * SUB + half, b.ty * SUB + half);
      const r = b.size * Minimap.SCALE * 0.7;
      ctx.fillStyle = hex(PLAYER_COLORS[b.owner] ?? 0xcccccc);
      ctx.fillRect(p.x - r, p.y - r / 2, r * 2, r);
      ctx.strokeStyle = '#0e0b16';
      ctx.strokeRect(p.x - r, p.y - r / 2, r * 2, r);
    }
    for (const u of st.units) {
      if (u.owner !== this.me && !isVisible(st, this.me, u.x, u.y)) continue;
      const p = this.toMini(u.x, u.y);
      const r = u.type === 'colossus' || u.type === 'siege' ? 3 : u.type === 'mech' || u.type === 'artillery' ? 2 : 1;
      ctx.fillStyle = hex(PLAYER_COLORS[u.owner] ?? 0xcccccc);
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }

    ctx.strokeStyle = '#f3e9d8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    view.forEach((c, i) => {
      const p = this.toMini(c.x, c.y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}
