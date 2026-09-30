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
        t.fillStyle = tile === GRASS ? '#4c7c3c' : tile === ROCK ? '#76726a' : '#2f6490';
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

  /** `view` son las 4 esquinas de la pantalla en subunidades del mundo. */
  draw(view: Pos[]): void {
    const { ctx, st } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.terrain, 0, 0);

    // Red propia: tinte verde sobre las casillas con energía.
    const bit = 1 << this.me;
    ctx.fillStyle = 'rgba(125, 255, 176, 0.22)';
    const s = Minimap.SCALE;
    for (let ty = 0; ty < st.map.h; ty++) {
      for (let tx = 0; tx < st.map.w; tx++) {
        if ((st.power[ty * st.map.w + tx] & bit) === 0) continue;
        const p = this.toMini(tx * SUB, ty * SUB);
        ctx.fillRect(p.x - s / 2, p.y, s, s / 2 + 1);
      }
    }
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

    // Niebla: negro sin explorar, penumbra lo explorado que no se ve ahora.
    for (let ty = 0; ty < st.map.h; ty++) {
      for (let tx = 0; tx < st.map.w; tx++) {
        const i = ty * st.map.w + tx;
        if (st.vision[i] & bit) continue;
        ctx.fillStyle = st.explored[i] & bit ? 'rgba(7, 5, 11, 0.55)' : '#07050b';
        const p = this.toMini(tx * SUB, ty * SUB);
        ctx.fillRect(p.x - s / 2, p.y, s, s / 2 + 1);
      }
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
