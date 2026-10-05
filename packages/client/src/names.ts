import type { BuildingType, Faction, TechId, UnitType } from '@epocas/sim';

/**
 * Nombres de cada facción. Las dos comparten reglas y arte por ahora; las Huestes (ángeles bíblicos)
 * solo se distinguen por su nomenclatura: la jerarquía celestial en vez de la industria mecha.
 */
export interface FactionNames {
  name: string;
  units: Record<UnitType, [string, string]>;
  buildings: Record<BuildingType, string>;
  gens: [string, string, string, string];
  /** Prefijo de generación en la barra superior (Gen-2, Esfera II...). */
  genTag: (g: number) => string;
  techs: Record<TechId, [string, string]>;
}

export const FACTION_NAMES: Record<Faction, FactionNames> = {
  mechas: {
    name: 'Mechas',
    units: {
      worker: ['obrero', 'obreros'],
      soldier: ['soldado', 'soldados'],
      mech: ['mecha', 'mechas'],
      truck: ['camión repetidor', 'camiones repetidores'],
      artillery: ['mecha de artillería', 'mechas de artillería'],
      colossus: ['coloso', 'colosos'],
      siege: ['coloso de asedio', 'colosos de asedio'],
    },
    buildings: { hq: 'Cuartel general', depot: 'Depósito', barracks: 'Barracas', hangar: 'Hangar', cradle: 'Cuna', tower: 'Torre', plant: 'Central', relay: 'Antena' },
    gens: ['', 'Prototipos', 'Producción en serie', 'Reactor de núcleo'],
    genTag: (g) => `Gen-${g}`,
    techs: {
      gen2: ['Gen-2 · Producción en serie', 'Artillería, camión repetidor y nuevas tecnologías'],
      gen3: ['Gen-3 · Reactor de núcleo', 'Cuna y colosos con reactor propio'],
      pneumatic: ['Picos neumáticos', 'Obreros extraen un 25 % más rápido'],
      carts: ['Carretillas', 'Carga por obrero de 10 a 15'],
      antimech: ['Lanzacohetes antimecha', 'Soldados +150 % de daño a máquinas'],
      composite: ['Blindaje compuesto', 'Mechas y artillería +25 % de vida'],
      lithium: ['Baterías de litio', 'Batería fuera de la red de 12 a 20 s'],
      piercing: ['Munición perforante', 'Torres +50 % de daño'],
      amplifiers: ['Amplificadores', 'Antenas y camiones cubren y ven 2 casillas más'],
      rangefinder: ['Telémetro', 'Artillería +2 casillas de alcance y visión'],
    },
  },
  huestes: {
    name: 'Huestes',
    units: {
      worker: ['acólito', 'acólitos'],
      soldier: ['ángel', 'ángeles'],
      mech: ['arcángel', 'arcángeles'],
      truck: ['trono', 'tronos'],
      artillery: ['virtud', 'virtudes'],
      colossus: ['serafín', 'serafines'],
      siege: ['querubín', 'querubines'],
    },
    buildings: { hq: 'Santuario', depot: 'Relicario', barracks: 'Coro', hangar: 'Claustro', cradle: 'Empíreo', tower: 'Obelisco', plant: 'Fuente de Gracia', relay: 'Altar' },
    gens: ['', 'Tercera esfera', 'Segunda esfera', 'Primera esfera'],
    genTag: (g) => `Esfera ${['', 'III', 'II', 'I'][g]}`,
    techs: {
      gen2: ['Segunda esfera · Potestades', 'Virtudes, tronos y nuevos dones'],
      gen3: ['Primera esfera · Serafines', 'Empíreo y seres de luz propia'],
      pneumatic: ['Manos diligentes', 'Acólitos extraen un 25 % más rápido'],
      carts: ['Ofrendas', 'Carga por acólito de 10 a 15'],
      antimech: ['Lanzas de fuego', 'Ángeles +150 % de daño a seres mayores'],
      composite: ['Égida', 'Arcángeles y virtudes +25 % de vida'],
      lithium: ['Gracia perdurable', 'Fuera de tierra santa, de 12 a 20 s'],
      piercing: ['Juicio', 'Obeliscos +50 % de daño'],
      amplifiers: ['Coros resonantes', 'Altares y tronos cubren y ven 2 casillas más'],
      rangefinder: ['Visión profética', 'Virtudes +2 casillas de alcance y visión'],
    },
  },
};

/** Colores elegibles en el lobby (como en AoE2). */
export const COLOR_CHOICES: { name: string; hex: number }[] = [
  { name: 'Azul', hex: 0x3b82f6 },
  { name: 'Rojo', hex: 0xef4444 },
  { name: 'Verde', hex: 0x22c55e },
  { name: 'Amarillo', hex: 0xeab308 },
  { name: 'Turquesa', hex: 0x14b8a6 },
  { name: 'Morado', hex: 0xa855f7 },
  { name: 'Gris', hex: 0x9ca3af },
  { name: 'Naranja', hex: 0xf97316 },
];
