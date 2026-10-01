import { Assets, BufferImageSource, Mesh, MeshGeometry, Shader, Texture, type TextureSource } from 'pixi.js';
import { buildingCenter, GRASS, ROCK, SUB, WATER, type State } from '@epocas/sim';

/**
 * Terreno con texturas fotográficas (CC0 de Poly Haven) mezcladas en un shader. Un solo quad cubre el
 * mapa en isométrico; el shader recibe las coordenadas de casilla y decide por píxel qué capa se ve
 * (hierba, tierra, arena de orilla, roca, agua) a partir de un "splat map" de 1 píxel por casilla con los
 * bordes deformados por ruido. Los mapas normales dan relieve con una luz fija desde arriba a la izquierda.
 * Todo se calcula en la GPU: el coste por frame no depende del tamaño del mapa.
 */

const LAYERS = ['sparse_grass', 'leafy_grass', 'brown_mud_dry', 'coast_sand_01', 'aerial_rocks_02'] as const;
type Layer = (typeof LAYERS)[number];

let loaded: Record<string, Texture> | null = null;
const MAX_VENTS = 32;

/** Descarga las texturas del terreno. Si falla (o no se llama), se usa el terreno plano de siempre. */
export async function loadTerrainTextures(base = 'terrain/'): Promise<boolean> {
  try {
    const out: Record<string, Texture> = {};
    await Promise.all(
      LAYERS.flatMap((l) =>
        [l, `${l}_nor`].map(async (name) => {
          out[name] = await Assets.load({ src: `${base}${name}.jpg`, data: { autoGenerateMipmaps: true, addressMode: 'repeat', scaleMode: 'linear', mipmapFilter: 'linear', maxAnisotropy: 4 } });
        }),
      ),
    );
    loaded = out;
    return true;
  } catch (e) {
    console.warn('Terreno sin texturas:', e);
    return false;
  }
}

export function terrainTexturesReady(): boolean {
  return loaded !== null;
}

const vertex = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vTile;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vTile = aUV;
}
`;

const fragment = /* glsl */ `
precision highp float;
in vec2 vTile;
out vec4 finalColor;
uniform sampler2D uSplat;
uniform sampler2D uGrassA;
uniform sampler2D uGrassB;
uniform sampler2D uDirt;
uniform sampler2D uSand;
uniform sampler2D uRock;
uniform sampler2D uGrassAN;
uniform sampler2D uGrassBN;
uniform sampler2D uDirtN;
uniform sampler2D uSandN;
uniform sampler2D uRockN;
uniform sampler2D uNoise;
uniform vec2 uSize;
uniform float uTime;
uniform vec2 uVents[MAX_VENTS];
uniform float uVentCount;

// Ruido precalculado (4 canales independientes, tileable): mucho más barato que calcularlo por píxel.
vec4 nz(vec2 p) { return texture(uNoise, p / 16.0); }
float fbm(vec2 p) { return nz(p).r; }
float noise(vec2 p) { return nz(p * 0.5 + 7.3).g; }
vec4 splat(vec2 p) { return texture(uSplat, p / uSize); }
// Muestra una textura dos veces (escala y giro distintos) y mezcla con ruido grande: rompe la repetición.
vec3 tex2(sampler2D t, vec2 p, float s, float m) {
  vec3 a = texture(t, p / s).rgb;
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p / (s * 1.7) + 0.37;
  vec3 b = texture(t, q).rgb;
  return mix(a, b, m);
}
vec3 nrm(sampler2D t, vec2 p, float s) { return texture(t, p / s).rgb * 2.0 - 1.0; }

void main() {
  vec2 p = vTile;
  float macro = smoothstep(0.3, 0.7, nz(p * 0.06).b);
  vec4 n1 = nz(p * 0.5);
  float mid = n1.r;
  // Bordes irregulares: el splat se lee desplazado por ruido.
  vec2 warp = n1.ga - 0.5;
  vec4 w = splat(p + warp * 0.9);
  float rock = smoothstep(0.42, 0.58, w.b + (mid - 0.5) * 0.35);
  float water = smoothstep(0.44, 0.56, w.a + (mid - 0.5) * 0.25);
  float sand = smoothstep(0.06, 0.3, w.a + (mid - 0.5) * 0.2) * (1.0 - water);
  float dirt = smoothstep(0.3, 0.6, w.g + (nz(p * 1.1).a - 0.5) * 0.6);

  // Capas de color
  float gm = smoothstep(0.3, 0.7, macro);
  // Hierba: el detalle (luminancia) sale de las fotos y el color de una paleta propia, verde algo seco,
  // con zonas más amarillas según ruido grande.
  vec3 ga = tex2(uGrassA, p, 8.0, 0.4);
  vec3 gb = tex2(uGrassB, p, 6.5, 0.4);
  // La foto tal cual, con más saturación y empujada hacia un verde algo seco.
  // Igualar el brillo medio de las dos fotos (medido: 0,24 y 0,52) para que alternarlas cambie el tono,
  // no la luz.
  ga *= 1.45;
  gb *= 0.7;
  vec3 gbase = mix(ga, gb, gm * 0.8);
  float gl = dot(gbase, vec3(0.299, 0.587, 0.114));
  vec3 grass = mix(vec3(gl), gbase, 1.35) * vec3(0.84, 1.04, 0.68) * 1.1;
  // Zonas de hierba más oscura y fresca y otras más secas, a gran escala.
  float lushZone = smoothstep(0.35, 0.75, nz(p * 0.09 + 5.0).g);
  grass = mix(grass, grass * vec3(0.72, 0.9, 0.7), lushZone * 0.8);
  vec3 col = grass;
  col = mix(col, tex2(uDirt, p, 6.0, 0.3) * vec3(1.05, 0.95, 0.85), dirt);
  col = mix(col, tex2(uSand, p, 7.0, 0.3) * vec3(1.05, 1.0, 0.9), sand);
  col = mix(col, tex2(uRock, p, 5.0, 0.25) * 1.1, rock);

  // Relieve: normales mezcladas igual que el color, luz desde arriba a la izquierda de la pantalla.
  vec3 n = mix(nrm(uGrassAN, p, 8.0), nrm(uGrassBN, p, 6.5), gm);
  n = mix(n, nrm(uDirtN, p, 6.0), dirt);
  n = mix(n, nrm(uSandN, p, 7.0), sand);
  n = mix(n, nrm(uRockN, p, 5.0) * vec3(1.6, 1.6, 1.0), rock);
  n = normalize(n);
  vec3 L = normalize(vec3(-0.55, -0.35, 0.75));
  float lit = dot(n, L) / L.z;
  col *= mix(1.0, clamp(lit, 0.35, 1.5), 0.75);

  // Sombra que proyectan las rocas hacia abajo a la derecha, y oscurecido en la base de las rocas.
  vec2 back = p - L.xy * 0.9;
  vec4 wb = splat(back + warp * 0.9);
  float rockBack = smoothstep(0.42, 0.58, wb.b + (mid - 0.5) * 0.35);
  col *= 1.0 - 0.45 * max(rockBack - rock, 0.0);
  col *= 1.0 - 0.25 * rock * (1.0 - smoothstep(0.55, 0.9, w.b));

  // Agua: profundidad, ondas animadas, reflejos y espuma en la orilla.
  float depth = smoothstep(0.5, 1.0, w.a);
  vec3 wc = mix(vec3(0.20, 0.36, 0.40), vec3(0.07, 0.17, 0.24), depth);
  float wave = fbm(p * 1.3 + vec2(uTime * 0.05, uTime * 0.03)) - fbm(p * 1.3 - vec2(uTime * 0.04, -uTime * 0.02));
  wc += wave * 0.10;
  wc += pow(max(0.0, noise(p * 3.0 + uTime * 0.15) - 0.62), 2.0) * 1.6 * vec3(0.8, 0.9, 1.0);
  float foam = (1.0 - smoothstep(0.0, 0.14, abs(w.a + (mid - 0.5) * 0.25 - 0.5))) * (0.55 + 0.45 * sin(uTime * 1.4 + mid * 12.0));
  wc = mix(wc, vec3(0.82, 0.86, 0.82), foam * 0.55);
  col = mix(col, wc, water);
  col = mix(col, col * 0.75, (1.0 - water) * smoothstep(0.3, 0.5, w.a));

  // Grietas de energía: suelo quemado y grietas que brillan en cian al ritmo del pulso de la veta.
  float vd = 99.0;
  for (int i = 0; i < MAX_VENTS; i++) {
    if (float(i) >= uVentCount) break;
    vd = min(vd, length(p - uVents[i]));
  }
  if (vd < 3.2) {
    float burn = 1.0 - smoothstep(0.6, 3.0 + (mid - 0.5) * 1.2, vd);
    col = mix(col, col * 0.3 + vec3(0.03, 0.025, 0.05), burn * 0.9);
    float ridge = 1.0 - abs(nz(p * 1.7 + 11.0).r * 2.0 - 1.0);
    float ridge2 = 1.0 - abs(nz(p * 3.1 + 4.0).b * 2.0 - 1.0);
    float crack = max(smoothstep(0.93, 0.985, ridge), smoothstep(0.95, 0.99, ridge2) * 0.7);
    float pulse = 0.55 + 0.45 * sin(uTime * 2.4);
    float reach = 1.0 - smoothstep(0.4, 2.4, vd);
    col += vec3(0.2, 0.85, 1.0) * crack * reach * (0.55 + 0.6 * pulse);
    col += vec3(0.1, 0.45, 0.6) * (1.0 - smoothstep(0.0, 1.2, vd)) * 0.35 * pulse;
  }

  // Variación a gran escala y etalonado: algo desaturado y cálido, polvoriento.
  col *= 0.9 + 0.2 * nz(p * 0.2).a;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.9) * vec3(1.04, 1.0, 0.92);
  // Viñeta suave en el borde del mapa.
  vec2 e = min(p, uSize - p);
  col *= mix(0.55, 1.0, smoothstep(0.0, 3.0, min(e.x, e.y)));
  finalColor = vec4(col, 1.0);
}
`;

/** Textura de ruido fbm tileable de 256×256, un campo distinto por canal. */
function noiseTexture(): Texture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let ch = 0; ch < 4; ch++) {
    const field = new Float32Array(N * N);
    let amp = 0.5;
    let total = 0;
    for (let period = 4; period <= 64; period *= 2) {
      const lat = Array.from({ length: period * period }, rnd);
      const cell = N / period;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const fx = x / cell;
          const fy = y / cell;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const ux = (fx - ix) * (fx - ix) * (3 - 2 * (fx - ix));
          const uy = (fy - iy) * (fy - iy) * (3 - 2 * (fy - iy));
          const at = (i: number, j: number) => lat[(j % period) * period + (i % period)];
          const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * ux;
          const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * ux;
          field[y * N + x] += amp * (a + (b - a) * uy);
        }
      }
      total += amp;
      amp *= 0.5;
    }
    // Estirar el contraste: el fbm se concentra alrededor de 0,5.
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < N * N; i++) {
      lo = Math.min(lo, field[i] / total);
      hi = Math.max(hi, field[i] / total);
    }
    for (let i = 0; i < N * N; i++) data[i * 4 + ch] = Math.round(((field[i] / total - lo) / (hi - lo)) * 255);
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: N, height: N, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear', addressMode: 'repeat' }) });
}

/** Casillas marcadas como tierra: alrededor de cada cuartel general, de las vetas y del metal, y parches sueltos. */
function dirtField(st: State): Float32Array {
  const { w, h } = st.map;
  const d = new Float32Array(w * h);
  const blob = (cx: number, cy: number, r: number, k = 1) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const q = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (q < 1) d[y * w + x] = Math.max(d[y * w + x], k * Math.min(1, (1 - q) * 1.8));
      }
    }
  };
  for (const b of st.buildings) {
    if (b.type !== 'hq') continue;
    const c = buildingCenter(b);
    blob(c.x / SUB, c.y / SUB, 9);
  }
  for (const v of st.vents) blob(v.tx + 0.5, v.ty + 0.5, 3.5);
  for (const n of st.nodes) blob(n.tx + 0.5, n.ty + 0.5, 2.2, 0.8);
  // Parches sueltos, deterministas por mapa.
  let s = (w * 7919 + h * 104729) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < Math.trunc((w * h) / 700); i++) blob(rnd() * w, rnd() * h, 1.5 + rnd() * 3, 0.9);
  return d;
}

/** Splat map de 1 píxel por casilla: R hierba, G tierra, B roca, A agua (suavizados con un desenfoque 3×3). */
function splatTexture(st: State): Texture {
  const { w, h, tiles } = st.map;
  const dirt = dirtField(st);
  const raw = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const t = tiles[i];
    raw[i * 4 + 2] = t === ROCK ? 1 : 0;
    raw[i * 4 + 3] = t === WATER ? 1 : 0;
    raw[i * 4 + 1] = t === GRASS ? dirt[i] : 0;
    raw[i * 4] = t === GRASS ? 1 - dirt[i] : 0;
  }
  // Buffer crudo y no un canvas: el canvas premultiplica por alfa y borraría los otros canales donde no hay agua.
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 4; k++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            const wt = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
            sum += raw[(yy * w + xx) * 4 + k] * wt;
            n += wt;
          }
        }
        data[(y * w + x) * 4 + k] = Math.round((sum / n) * 255);
      }
    }
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: w, height: h, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear' }) });
}

export interface TerrainMesh {
  mesh: Mesh<MeshGeometry, Shader>;
  setTime(seconds: number): void;
}

/** Quad del mapa con el shader de terreno. `iso` proyecta coordenadas de subcasilla a píxeles. */
export function createTerrain(st: State, isoX: (x: number, y: number) => number, isoY: (x: number, y: number) => number): TerrainMesh {
  const t = loaded!;
  const { w, h } = st.map;
  const corners = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const geometry = new MeshGeometry({
    positions: new Float32Array(corners.flatMap(([x, y]) => [isoX(x * SUB, y * SUB), isoY(x * SUB, y * SUB)])),
    uvs: new Float32Array(corners.flat()),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const vents = new Float32Array(MAX_VENTS * 2);
  st.vents.slice(0, MAX_VENTS).forEach((v, i) => {
    vents[i * 2] = v.tx + 0.5;
    vents[i * 2 + 1] = v.ty + 0.5;
  });
  const src = (l: Layer, n = false): TextureSource => t[n ? `${l}_nor` : l].source;
  const shader = Shader.from({
    gl: { vertex, fragment: `#define MAX_VENTS ${MAX_VENTS}\n${fragment}` },
    resources: {
      uSplat: splatTexture(st).source,
      uNoise: noiseTexture().source,
      uGrassA: src('sparse_grass'),
      uGrassB: src('leafy_grass'),
      uDirt: src('brown_mud_dry'),
      uSand: src('coast_sand_01'),
      uRock: src('aerial_rocks_02'),
      uGrassAN: src('sparse_grass', true),
      uGrassBN: src('leafy_grass', true),
      uDirtN: src('brown_mud_dry', true),
      uSandN: src('coast_sand_01', true),
      uRockN: src('aerial_rocks_02', true),
      terrainUniforms: {
        uSize: { value: new Float32Array([w, h]), type: 'vec2<f32>' },
        uTime: { value: 0, type: 'f32' },
        uVents: { value: vents, type: 'vec2<f32>', size: MAX_VENTS },
        uVentCount: { value: Math.min(MAX_VENTS, st.vents.length), type: 'f32' },
      },
    },
  });
  const mesh = new Mesh({ geometry, shader });
  return {
    mesh,
    setTime(seconds: number) {
      (shader.resources.terrainUniforms as { uniforms: { uTime: number } }).uniforms.uTime = seconds % 1000;
    },
  };
}
