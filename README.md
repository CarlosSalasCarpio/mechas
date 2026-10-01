# Épocas — prototipo

RTS isométrico con simulación determinista (lockstep, 20 ticks/s).

```
npm install
npm run dev          # sandbox en http://localhost:5173  (?seed=7&n=100 para cambiar semilla y tamaño)
npm test             # determinismo, pathfinding y pureza de sim/
npm run headless -- --seed 42 --ticks 2000 --per-side 500
npm run headless -- --replay replay.json   # verifica un replay grabado en el navegador
npm run headless -- --ai --seed 7 --ticks 72000 [--mode 2v2]   # IA contra IA sin gráficos, informe cada 2 min
```

Al abrir el juego aparece el menú (nueva partida con modo y semilla). En la URL: `?mode=2v2&seed=7&play=1`, `?ai=0` desactiva la IA, `?n=20` añade 20 soldados de prueba por jugador.
Controles: doble clic = todas las del mismo tipo en pantalla (unidades o edificios) · Q W E / A S D = acciones del panel
(Shift+Q = 5 unidades) · Q con militares = avanzar atacando · Shift = encadenar órdenes · I = siguiente obrero ocioso ·
cámara con flechas, borde de pantalla, botón central o minimapa.
Trucos (Enter): `acero` = +10.000 metal · `turbo` = construcción y producción instantáneas · `poblacion` = tope de población 1000 · `energia` = tus mechas funcionan sin red · `marco` = revela el mapa · `polo` = quita la niebla (todos se apagan repitiéndolos).

## Paquetes

- `sim/` — el juego. TypeScript puro, sin dependencias, solo enteros. `step(state, commands)` avanza un tick.
- `render/` — PixiJS. Solo lee el estado y lo dibuja en isométrico.
- `client/` — navegador: une sim + render + input → comandos.
- `headless/` — Node: escenarios sin gráficos, benchmarks y verificación de replays.

Regla: `sim/` no importa nada del navegador ni del render, ni usa `Math.random`, `Date` o trigonometría (lo hace cumplir `test/purity.test.ts`).

## Arte del terreno

Todo el arte del terreno sale de material **CC0 de [Poly Haven](https://polyhaven.com)** (uso libre, sin atribución obligatoria):

- **Suelo** (`packages/client/public/terrain/`): texturas fotográficas (hierba, tierra, arena, roca) con sus mapas de relieve, mezcladas en un shader (`packages/render/src/terrain.ts`). Incluye agua animada y las grietas de energía brillantes alrededor de las vetas.
- **Decoración** (`packages/client/public/decor/`): árboles, arbustos, hierba, rocas, chatarra, vetas de metal y cristales de energía, prerenderizados en Blender como sprites isométricos y empaquetados en un atlas. Solo visual: no bloquea el paso; los mechas pesados derriban los árboles. Ver `packages/render/src/decor.ts`.

Para regenerar la decoración (necesita Blender e ImageMagick):

```sh
python3 art/fetch.py pine_tree_01 fir_tree_01 ...   # modelos → art/models/ (ver lista en art/render_decor.py)
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/render_decor.py
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/render_resources.py
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/render_buildings.py
python3 art/pack_atlas.py                           # → packages/client/public/decor/
```

**Edificios** (`art/render_buildings.py`): modelados por código a partir de un concepto (`art/concepts/`), con texturas CC0 de pintura, chapa y óxido (`art/textures/`). Cada edificio sale en dos sprites: el render en color y una máscara de las zonas de color de equipo, que el juego tiñe con el color de cada jugador. Hechos todos: cuartel general, barracas, hangar, cuna, torre, antena, depósito y central.

**Unidades** (`art/render_units.py`, `packages/render/src/units.ts`): modeladas por piezas rígidas con articulaciones y animadas por código (reposo, caminar, disparar o trabajar; el camión usa esos fotogramas para desplegarse) en 8 direcciones, con máscara de color de equipo. Se empaquetan a escala 1 del juego para no agotar la memoria de vídeo (`python3 art/pack_atlas.py units/<tipo> <tipo> 2048 2 1`; los colosos con `THIN=1` y escala de render 1,4).
