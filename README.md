# Épocas — prototipo

RTS isométrico con simulación determinista (lockstep, 20 ticks/s).

```
npm install
npm run dev          # sandbox en http://localhost:5173  (?seed=7&n=100 para cambiar semilla y tamaño)
npm test             # determinismo, pathfinding y pureza de sim/
npm run headless -- --seed 42 --ticks 2000 --per-side 500
npm run headless -- --replay replay.json   # verifica un replay grabado en el navegador
npm run headless -- --ai --seed 7 --ticks 72000   # IA contra IA sin gráficos, informe cada 2 min
```

En el navegador: `?ai=0` desactiva la IA rival, `?n=20` añade 20 soldados de prueba por bando.
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
