import { Assets, Container, RenderTexture, Sprite, type Renderer, type Spritesheet, type Texture } from 'pixi.js';

/**
 * Unidades prerenderizadas en Blender (art/render_units.py): 8 direcciones × animaciones, cada fotograma con
 * su máscara de color de equipo. Frames: `<tipo>_<anim>_<dir>_<f>` y `..._team`.
 * Dirección d: la unidad mira hacia d·45° de la pantalla (0 = derecha, 2 = abajo, sentido horario).
 */
export const UNIT_ANIMS = { idle: 6, walk: 8, fire: 4 } as const;
export type UnitAnim = keyof typeof UNIT_ANIMS;

/** Atlas por clave: el tipo de unidad, o `h_<tipo>` para el arte propio de las Huestes. */
const sheets: Record<string, Spritesheet> = {};

export async function loadUnitArt(types: string[] = ['mech', 'artillery', 'colossus', 'siege', 'soldier', 'worker', 'truck', 'h_soldier', 'h_colossus', 'h_siege']): Promise<void> {
  await Promise.all(
    types.map(async (t) => {
      try {
        sheets[t] = await Assets.load(`units/${t}.json`);
      } catch (e) {
        console.warn(`Sin arte para ${t}:`, e);
      }
    }),
  );
}

export function hasUnitArt(t: string): boolean {
  return sheets[t] !== undefined;
}

export function unitFrame(t: string, anim: UnitAnim, dir: number, f: number): { body: Texture; team: Texture | undefined } | null {
  const s = sheets[t];
  if (!s) return null;
  const n = f % UNIT_ANIMS[anim];
  let k = `${t}_${anim}_${dir}_${n}`;
  // Atlas reducidos (colosos): solo hay fotogramas pares de reposo y caminar.
  if (!s.textures[k]) k = `${t}_${anim}_${dir}_${n & ~1}`;
  const body = s.textures[k];
  return body ? { body, team: s.textures[`${k}_team`] } : null;
}

/** Dirección de pantalla (0..7) de un desplazamiento en píxeles de pantalla. */
export function screenDir(dx: number, dy: number): number {
  return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
}

/**
 * Sube a la GPU los atlas de unidades (y los que se pasen) durante la carga, dibujándolos una vez en una
 * textura diminuta. Si no, la primera vez que aparece un coloso el navegador sube decenas de MB de golpe y
 * la partida se congela.
 */
export function prewarmTextures(renderer: Renderer, extra: Texture[] = []): void {
  const c = new Container();
  for (const s of Object.values(sheets)) {
    const first = s && Object.values(s.textures)[0];
    if (first) c.addChild(new Sprite(first));
  }
  for (const t of extra) c.addChild(new Sprite(t));
  const rt = RenderTexture.create({ width: 4, height: 4 });
  renderer.render({ container: c, target: rt });
  rt.destroy(true);
  c.destroy({ children: true });
}
