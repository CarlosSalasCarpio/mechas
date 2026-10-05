import { defineConfig } from 'vitest/config';

// Las pruebas largas (partidas de IA, determinismo) se acercan a 5 s en una máquina cargada.
export default defineConfig({ test: { testTimeout: 20000 } });
