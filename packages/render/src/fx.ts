import { Assets, type Spritesheet, type Texture } from 'pixi.js';

/**
 * Biblioteca de efectos prerenderizados en Blender (art/render_fx.py): explosión volumétrica y fuego en
 * secuencia de fotogramas, humo, fogonazos, resplandor, trazadora, onda de polvo, anillo de energía,
 * restos, marcas de quemado y cohete.
 */
let sheet: Spritesheet | null = null;
const frameCache = new Map<string, Texture[]>();

export async function loadFx(url = 'fx/fx.json'): Promise<boolean> {
  try {
    sheet = await Assets.load(url);
    return true;
  } catch (e) {
    console.warn('Sin efectos:', e);
    return false;
  }
}

export function fxReady(): boolean {
  return sheet !== null;
}

/** Un frame del atlas de efectos (p. ej. 'glow'). */
export function fxTex(name: string): Texture | null {
  return sheet?.textures[name] ?? null;
}

/** Secuencia `<prefijo>_0 … _n-1` (explosion, fire) o variantes (smoke, muzzle, debris, scorch). */
export function fxFrames(prefix: string): Texture[] {
  let list = frameCache.get(prefix);
  if (list) return list;
  list = [];
  for (let i = 0; sheet?.textures[`${prefix}_${i}`]; i++) list.push(sheet.textures[`${prefix}_${i}`]);
  if (list.length) frameCache.set(prefix, list);
  return list;
}

/** Todas las texturas de efectos (para precargarlas en la GPU). */
export function fxAll(): Texture[] {
  const first = sheet && Object.values(sheet.textures)[0];
  return first ? [first] : [];
}
