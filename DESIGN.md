# Diseño — RTS de mechas (nombre provisional: [TÍTULO])

RTS isométrico 2D al estilo AoE2. Estética retrofuturista de los 80 (anime mecha, CRT, industria pesada),
con Evangelion como inspiración, sin copiar diseños. Estética sobre lógica: el mundo es humano e industrial.

Concept art (blockout vectorial): https://claude.ai/artifact/Rk1JgqGUYvPyzie7PSEZTj

## Primera versión jugable

Un solo recurso, **Metal**, extraído de yacimientos que se agotan: dos grupos junto a cada base (1.000 por
yacimiento) y siete en el mapa (1.200), tres en el eje central y uno por cuadrante, para expandirse. Tope de población fijo: 200 (sin casas).
Se empieza con Cuartel general + 4 obreros. Gana quien destruye el Cuartel general enemigo.

| Unidad | Coste | Pob. | Rol |
|---|---|---|---|
| Obrero | 50 | 1 | Recolecta metal, construye |
| Soldado | 60 | 1 | Infantería barata (80 de vida, 8 de daño a 5 casillas), en formación abierta. 10 soldados derriban un mecha |
| Mecha | 400 | 5 | Caro, fuerte, aplasta infantería. Unos 20 por jugador |
| Mecha de artillería | 450 | 5 | Hangar (W). Alcance 16 (mínimo 4), 35 de daño en área a unidades, 15 a edificios. Frágil: necesita escolta |
| Coloso | 3000 | 25 | ≈ 8 mechas. Lento, blanco enorme. 5+ contra 0 debe ser aplastante |

| Edificio | Coste | Función |
|---|---|---|
| Cuartel general | inicial | Produce obreros, recibe metal. Primera fuente de energía: cubre 18 casillas y enlaza a 18 |
| Depósito | 100 | Punto de entrega de metal |
| Barracas | 150 | Produce soldados |
| Hangar | 300 | Produce mechas |
| Cuna | 1000 | Produce colosos (~2 min). Alerta global al empezar uno |
| Torre | 150 | Defensa: 14 de daño cada 1,5 s a 7 casillas, solo contra unidades |
| Central | 400 | Solo sobre una veta. Fuente de energía: cubre 18 casillas y enlaza a 18 (como el cuartel general). 4.000 de vida: objetivo a disputar |
| Antena | 60 | Repetidora. Crece con cada generación: cubre 6/8/10 casillas, enlaza a 8/10/12 y aguanta 250/450/700 de vida (las ya construidas también mejoran) |

## Energía (red inalámbrica)

- El cuartel general es la primera fuente de energía (el mayor alcance). Vetas fijas (una junto a cada base y
  dos en el centro); la central solo va sobre una veta. Las vetas no se agotan.
- Una antena tiene energía si enlaza, directa o encadenada, con una central. Si cae un eslabón, todo lo que
  colgaba de él se apaga.
- **Mechas, colosos y colosos de asedio** necesitan la red. Fuera tienen 12 s de batería; a cero se apagan
  (ni se mueven ni disparan) hasta que la red vuelva a cubrirlos. Obreros, soldados, torres y edificios no
  necesitan red.
- **Voluntad propia:** por su cuenta nunca salen de la red (no persiguen fuera; disparan desde el borde a lo
  que tengan a tiro). Solo salen si el jugador lo ordena, y al terminar esa orden vuelven solos.
- **Red aliada:** la cobertura de un aliado da energía a tus mechas, pero tus antenas no se encadenan a su red
  (cada jugador sostiene la suya).
- Cobertura visible solo cuando importa (mechas, camiones o nodos seleccionados, colocando red, o Alt) como una
  mancha con un único borde: verde la propia, azul la aliada, turquesa donde se solapan. El minimapa usa los
  mismos colores. Líneas discontinuas marcan los enlaces entre tus nodos (camiones desplegados incluidos).
- **Goteo de las centrales (Gen-3):** cada central con energía a partir de la segunda da 5 de metal cada 10 s.

Todos los números son una primera propuesta: se ajustan jugando y con partidas headless.

## Orden de trabajo

1. ~~Edificios en la grilla (el cuartel general bloquea casillas)~~
2. ~~Obreros recolectando metal~~
3. ~~Producción (colas en cuartel general, barracas, hangar, cuna)~~
4. ~~Construcción de edificios por obreros~~
5. ~~Soldado, mecha y coloso con estadísticas y combate a distancia (mecha y coloso con daño en área)~~
6. ~~Condición de victoria e IA rival~~ (IA en `sim/src/ai.ts`; juega también IA contra IA sin gráficos)
7. HUD funcional (hay uno básico: recursos, selección, construir, entrenar)

Balance medido con duelos headless: 10 soldados derriban un mecha (quedan 6); 20 soldados pierden contra 3
mechas, pero con Lanzacohetes antimecha los aplastan; 1 coloso ≈ 8–10 mechas;
5 colosos aplastan a 20 mechas; 20 mechas vencen a 2 colosos.

## Generaciones (cada una rompe una regla de la energía)

| Generación | Cómo se llega | Desbloquea | Regla que cambia |
|---|---|---|---|
| **Gen-1 · Prototipos** | inicio | obrero, soldado, mecha, torre, antena, central, depósito, barracas, hangar | los mechas dependen de la red (batería 12 s) |
| **Gen-2 · Producción en serie** | CG, 800 metal, 45 s, con barracas y hangar | mecha de artillería, **camión repetidor**, tecnologías Gen-2 | la red se mueve: el camión desplegado es una antena móvil (patas, franjas de aviso, mástil alto con baliza). La IA los encadena hacia el enemigo |
| **Gen-3 · Reactor de núcleo** | CG, 2000 metal, 60 s, con una central | Cuna, coloso, coloso de asedio | los colosos llevan reactor propio (no necesitan red) y **estallan al morir** (500 de daño en 3,5 casillas a todos) |

Reskin de edificios por generación: hormigón gris (Gen-1), chapa con nervaduras y franjas de peligro (Gen-2),
paneles oscuros con juntas cian (Gen-3). Cada salto se anuncia a ambos jugadores.

## Tecnologías (una vez cada una; ocupan el edificio mientras se investigan)

| Edificio | Tecnología | Efecto | Gen | Coste |
|---|---|---|---|---|
| CG | Picos neumáticos | extracción +25 % | 1 | 150 |
| CG | Carretillas | carga 10 → 15 | 2 | 200 |
| Barracas | Lanzacohetes antimecha | soldados +150 % contra máquinas | 2 | 300 |
| Hangar | Blindaje compuesto | mechas y artillería +25 % vida | 2 | 400 |
| Hangar | Baterías de litio | batería 12 → 20 s | 2 | 300 |
| Torre | Munición perforante | torres +50 % daño | 2 | 250 |
| Central | Amplificadores | antenas y camiones cubren y ven 2 casillas más | 2 | 300 |
| Hangar | Telémetro | artillería +2 alcance y visión | 3 | 350 |

Doctrinas (elegir una de dos al subir de generación): **siguiente iteración**.

## Partidas y equipos

Menú principal con los modos 1v1, 1v2, 2v2, 1v3, 2v2v2, 3v3, 1v5 y todos contra todos (4); hasta 6 jugadores.
El humano es siempre el jugador 1 del primer equipo; el resto, IA. Los aliados no se atacan y comparten visión
y la cobertura de energía (sin encadenar redes). Quien pierde su cuartel general queda eliminado; gana el último equipo en pie.
Mapa: 120×120 en 1v1 (el clásico, a izquierda y derecha); 160 (3–4 jugadores) o 190 (5–6) con las bases en
círculo, metal delante de cada base y entre vecinos, y una veta disputada entre cada par de vecinos.
Colores por bando: fríos para tu equipo, cálidos para los enemigos.

## Niebla de guerra (como AoE2)

- Sin explorar: negro. Explorado sin vista: penumbra, con los edificios enemigos como se vieron por última vez.
- Visión: unidades por su radio (siempre algo mayor que su alcance: la artillería ve 17 y dispara a 16);
  la red (cuartel general, centrales, antenas, camiones desplegados) ve hasta donde llega su energía; torres,
  su alcance + 1. Una obra no da visión: solo deja explorado (penumbra) el terreno bajo su huella.
- Se calcula en el motor (determinista) pero no afecta a la simulación: **la IA todavía lo ve todo**
  (limitación conocida; pendiente que explore y recuerde).
- Trucos: `marco` revela el mapa, `polo` quita la niebla.

## Para después (fuera de la primera versión)

- **Chatarra** de los mechas y edificios destruidos, recolectable.
- **Materia exótica** en cráteres fijos del mapa, necesaria para colosos.
- **Pilotos** entrenados como recurso escaso; se eyectan al caer su mecha y se pueden rescatar.
- **Colosos neutrales** (inspirados en los Ángeles) que atacan a ambos jugadores.
- Más clases de mecha (Explorador, Bastión) e infantería antimecha.

## Arte (al final)

Mechas: concepto con IA de imágenes → imagen a 3D → rig rígido en Blender → render isométrico por script a
spritesheets (8–16 direcciones). Edificios: blockout 3D + IA pintando encima guiada por profundidad.
Terreno: texturas tileables generadas por IA. Una sola luz de atardecer para todo.
