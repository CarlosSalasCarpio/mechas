"""
Renderiza la decoración del terreno (árboles, arbustos, hierba, rocas, chatarra) como sprites isométricos.

Uso: Blender -b --factory-startup -P art/render_decor.py -- [filtro]

- Cámara ortográfica con la proyección del juego (2:1: 30° de elevación, girada 45°).
- 1 unidad de Blender = 1 casilla. Se renderiza al doble de la escala del juego (nitidez al acercar).
- Sol desde arriba a la izquierda de la pantalla, como la luz del shader del terreno.
- Plano "shadow catcher": la sombra sobre el suelo queda en el sprite como negro semitransparente.
- Salida: art/sprites/<nombre>.png y art/sprites/manifest.json (tamaño y punto de apoyo de cada sprite).
"""
import bpy, json, math, os, random, sys
from mathutils import Vector, Matrix, Euler

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'sprites')
os.makedirs(OUT, exist_ok=True)
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FILTER = ARGV[0] if ARGV else ''

PX_PER_TILE = 64 / math.sqrt(2)  # px por unidad en el juego (el rombo de una casilla mide 64 px)
RENDER_SCALE = 2
K = PX_PER_TILE * RENDER_SCALE
SAMPLES = 64

# (blend, objeto raíz, nombre del sprite, altura objetivo en casillas, variantes de giro)
ASSETS = [
    ('pine_tree_01', 'pine_tree_01_a_LOD0', 'pine_a', 2.6, 2),
    ('pine_tree_01', 'pine_tree_01_b_LOD0', 'pine_b', 2.3, 2),
    ('pine_tree_01', 'pine_tree_01_c_LOD0', 'pine_c', 2.0, 2),
    ('fir_tree_01', 'fir_tree_01_a_LOD0', 'fir_a', 2.4, 2),
    ('fir_tree_01', 'fir_tree_01_b_LOD0', 'fir_b', 2.1, 2),
    ('fir_tree_01', 'fir_tree_01_c_LOD0', 'fir_c', 1.8, 2),
    ('tree_small_02', 'tree_small_02_LOD0', 'tree_small', 1.5, 3),
    ('dead_tree_trunk_02', 'dead_tree_trunk_02_LOD0', 'dead_trunk', 0.3, 2),
    # Árboles derribados (los mechas los aplastan): el mismo modelo, tumbado.
    ('fir_tree_01', 'fir_tree_01_b_LOD0', 'fallen_fir', 2.1, 2, math.radians(84)),
    ('pine_tree_01', 'pine_tree_01_b_LOD0', 'fallen_pine', 2.3, 2, math.radians(84)),
    ('tree_small_02', 'tree_small_02_LOD0', 'fallen_small', 1.5, 2, math.radians(84)),
    ('shrub_01', 'shrub_01_a_LOD0', 'shrub_1a', 0.45, 2),
    ('shrub_01', 'shrub_01_d_LOD0', 'shrub_1d', 0.4, 2),
    ('shrub_01', 'shrub_01_g_LOD0', 'shrub_1g', 0.5, 2),
    ('shrub_02', 'shrub_02_a_LOD0', 'shrub_2a', 0.5, 2),
    ('shrub_02', 'shrub_02_c_LOD0', 'shrub_2c', 0.45, 2),
    ('shrub_03', 'shrub_03_a_LOD0', 'shrub_3a', 0.45, 2),
    ('shrub_04', 'shrub_04_a_LOD0', 'shrub_4a', 0.4, 2),
    ('shrub_04', 'shrub_04_c_LOD0', 'shrub_4c', 0.35, 2),
    ('grass_medium_01', 'grass_medium_01_large_a_LOD0', 'grass_large_a', 0.22, 2),
    ('grass_medium_01', 'grass_medium_01_large_b_LOD0', 'grass_large_b', 0.22, 2),
    ('grass_medium_01', 'grass_medium_01_tall_a_LOD0', 'grass_tall_a', 0.28, 2),
    ('grass_medium_01', 'grass_medium_01_mid_a_LOD0', 'grass_mid_a', 0.18, 2),
    ('grass_medium_01', 'grass_medium_01_small_a_LOD0', 'grass_small_a', 0.13, 2),
    ('grass_medium_02', 'grass_medium_02_a', 'grass2_a', 0.2, 2),
    ('grass_medium_02', 'grass_medium_02_c', 'grass2_c', 0.2, 2),
    ('weed_plant_02', 'weed_plant_02_a_LOD0', 'weed_a', 0.25, 2),
    ('weed_plant_02', 'weed_plant_02_c_LOD0', 'weed_c', 0.22, 2),
    ('nettle_plant', 'nettle_plant_medium_a_LOD0', 'nettle', 0.3, 2),
    ('rock_moss_set_01', 'rock_moss_set_01_rock01', 'rock_1', 0.35, 2),
    ('rock_moss_set_01', 'rock_moss_set_01_rock02', 'rock_2', 0.3, 2),
    ('rock_moss_set_01', 'rock_moss_set_01_rock03', 'rock_3', 0.25, 2),
    ('rock_moss_set_01', 'rock_moss_set_01_rock04', 'rock_4', 0.3, 2),
    ('boulder_01', 'boulder_01_LOD0', 'boulder', 0.6, 3),
    ('stone_01', 'stone_01_LOD0', 'stone', 0.15, 2),
    # Chatarra: escala real × 0,25 casillas por metro (algo exagerada para que se lea).
    ('Barrel_01', 'Barrel_01', 'barrel_a', None, 2),
    ('barrel_03', 'barrel_03', 'barrel_b', None, 2),
    ('rusted_wheel_rim_01', 'rusted_wheel_rim_01', 'wheel_rim', None, 2),
    ('concrete_road_barrier', 'concrete_road_barrier_LOD0', 'barrier', None, 2),
    ('propane_tank', 'propane_tank', 'propane', None, 2),
    ('old_military_crate', 'old_military_crate_a', 'crate', None, 2),
    ('metal_trash_can', 'metal_trash_can_rust', 'trash_can', None, 2),
]
PROP_SCALE = 0.25


def setup_devices():
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        bpy.context.scene.cycles.device = 'GPU'
    except Exception as e:  # sin GPU: CPU
        print('GPU no disponible:', e)


def family(obj):
    out = [obj]
    for c in obj.children:
        out += family(c)
    return out


def world_bbox(objs):
    """Caja del objeto evaluado (con geometry nodes e instancias)."""
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    names = {o.name for o in objs}
    for inst in dg.object_instances:
        src = inst.instance_object if inst.is_instance else inst.object
        parent = inst.parent.original.name if inst.is_instance and inst.parent else None
        owner = (parent if parent else src.original.name)
        if owner not in names:
            continue
        m = inst.matrix_world
        for c in src.bound_box:
            pts.append(m @ Vector(c))
    return pts


def render_asset(blend, root, name, height, variants, *rest):
    tilt = rest[0] if len(rest) == 4 else 0.0
    cam_rot, sun_dir, manifest = rest[-3:]
    bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT, 'models', blend, f'{blend}.blend'))
    scene = bpy.context.scene
    if root not in bpy.data.objects:
        print('FALTA', root)
        return
    obj = bpy.data.objects[root]
    keep = set(o.name for o in family(obj))
    # Ocultar todo lo que no sea este objeto (las fuentes de instancias ya estaban ocultas y siguen así).
    for o in scene.objects:
        if o.name not in keep and o.type in {'MESH', 'CURVE', 'EMPTY'} and not o.hide_render:
            o.hide_render = True
    for o in family(obj):
        o.hide_render = False
    shoot(obj, name, height, variants, cam_rot, sun_dir, manifest, tilt=tilt)


def shoot(obj, name, height, variants, cam_rot, sun_dir, manifest, wide=None, tilt=0.0, spin=None, scale=None, passes=(), freestyle=False):
    """`spin` fija el giro (edificios), `scale` fija la escala, `passes` son renders extra con el mismo encuadre:
    (sufijo, preparar, restaurar). `freestyle` añade contorno entintado."""
    """Coloca `obj` (y sus hijos) en el origen a la altura objetivo y lo renderiza en `variants` giros."""
    scene = bpy.context.scene
    # Llevar al origen con la base en z=0 y escalar a la altura objetivo.
    obj.parent = None
    obj.rotation_euler = Euler((0, 0, 0))
    obj.location = (0, 0, 0)
    obj.scale = (1, 1, 1)
    bpy.context.view_layer.update()
    pts = world_bbox(family(obj))
    if not pts:
        print('SIN GEOMETRIA', root)
        return
    zmin = min(p.z for p in pts)
    zmax = max(p.z for p in pts)
    cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
    cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
    s = scale if scale else (height / (zmax - zmin)) if height else PROP_SCALE
    # Pivote: vacío en el centro de la base, para girar y escalar alrededor de él.
    piv = bpy.data.objects.new('pivot', None)
    scene.collection.objects.link(piv)
    # Los edificios ya vienen modelados alrededor del centro de su huella; la decoración se centra en su caja.
    obj.location = (0, 0, -zmin) if scale else (-cx, -cy, -zmin)
    obj.parent = piv
    # Árboles algo más anchos que en la realidad: a escala RTS se leen mejor (como en AoE2).
    if wide is None:
        wide = 1.35 if height and height > 1 else 1.0
    piv.scale = (s * wide, s * wide, s)

    # Render
    scene.render.engine = 'CYCLES'
    setup_devices()
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    # Luz: sol + cielo tenue azulado
    for o in list(scene.objects):
        if o.type in {'LIGHT', 'CAMERA'}:
            bpy.data.objects.remove(o)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 6.5
    sun.data.angle = math.radians(3)
    sun.data.color = (1.0, 0.95, 0.86)
    sun.rotation_euler = sun_dir.to_track_quat('-Z', 'Y').to_euler()  # el sol emite a lo largo de su -Z
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)
    bg.inputs['Strength'].default_value = 0.45
    scene.world = world
    # Suelo que solo recibe sombras
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.is_shadow_catcher = True
    # Cámara
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.rotation_euler = cam_rot
    scene.collection.objects.link(cam)
    scene.camera = cam
    fwd = cam_rot.to_matrix() @ Vector((0, 0, -1))
    right = cam_rot.to_matrix() @ Vector((1, 0, 0))
    up = cam_rot.to_matrix() @ Vector((0, 1, 0))

    rng = random.Random(name)
    for v in range(variants):
        piv.rotation_euler = (tilt, 0, spin if spin is not None else rng.uniform(0, 2 * math.pi))
        piv.location = (0, 0, 0)
        bpy.context.view_layer.update()
        if tilt:
            # Tumbado: apoyarlo sobre el suelo.
            piv.location.z = -min(p.z for p in world_bbox(family(obj)))
            bpy.context.view_layer.update()
        pts = world_bbox(family(obj))
        h = max(p.z for p in pts)
        # Incluir la sombra: cada punto proyectado al suelo en la dirección del sol.
        shadow = [Vector((p.x - sun_dir.x / sun_dir.z * p.z, p.y - sun_dir.y / sun_dir.z * p.z, 0)) for p in pts]
        allp = pts + shadow
        xs = [p.dot(right) for p in allp]
        ys = [p.dot(up) for p in allp]
        m = 0.06
        x0, x1 = min(xs) - m, max(xs) + m
        y0, y1 = min(ys) - m, max(ys) + m
        w, hgt = x1 - x0, y1 - y0
        cam.data.ortho_scale = max(w, hgt)
        c = right * ((x0 + x1) / 2) + up * ((y0 + y1) / 2)
        cam.location = c - fwd * 60
        scene.render.resolution_x = max(4, math.ceil(w * K))
        scene.render.resolution_y = max(4, math.ceil(hgt * K))
        scene.render.resolution_percentage = 100
        # Ajuste fino: la escala ortográfica cubre el lado mayor; recalcular el otro con los píxeles enteros.
        if w >= hgt:
            cam.data.ortho_scale = scene.render.resolution_x / K
        else:
            cam.data.ortho_scale = scene.render.resolution_y / K
        fname = f'{name}_{v}.png'
        scene.render.filepath = os.path.join(OUT, fname)
        scene.render.use_freestyle = freestyle
        if freestyle:
            vl = bpy.context.view_layer
            vl.use_freestyle = True
            scene.render.line_thickness_mode = 'ABSOLUTE'
            scene.render.line_thickness = 1.3
            ls = vl.freestyle_settings.linesets[0] if vl.freestyle_settings.linesets else vl.freestyle_settings.linesets.new('lines')
            ls.select_by_visibility = True
            ls.select_by_edge_types = True
            ls.select_silhouette = True
            ls.select_border = True
            ls.select_crease = True
            if ls.linestyle is None:
                ls.linestyle = bpy.data.linestyles.new('ink')
            ls.linestyle.color = (0.12, 0.09, 0.08)
            ls.linestyle.alpha = 0.75
        bpy.ops.render.render(write_still=True)
        for suffix, prep, restore in passes:
            prep()
            scene.render.use_freestyle = False
            scene.render.filepath = os.path.join(OUT, f'{name}_{v}{suffix}.png')
            bpy.ops.render.render(write_still=True)
            restore()
        # Punto de apoyo: el origen (base del objeto) en píxeles de la imagen.
        rx, ry = scene.render.resolution_x, scene.render.resolution_y
        ox = (Vector((0, 0, 0)) - cam.location).dot(right)
        oy = (Vector((0, 0, 0)) - cam.location).dot(up)
        ax = rx / 2 + ox * K
        ay = ry / 2 - oy * K
        manifest[f'{name}_{v}'] = {'file': fname, 'w': rx, 'h': ry, 'ax': round(ax / rx, 4), 'ay': round(ay / ry, 4), 'height': round(h, 3)}
        for suffix, _, _ in passes:
            manifest[f'{name}_{v}{suffix}'] = {**manifest[f'{name}_{v}'], 'file': f'{name}_{v}{suffix}.png'}
        print('RENDER', fname, rx, ry)


def main():
    # Proyección del juego: elevación de 30° (arcsin 0,5 → rombos 2:1), girada 45°.
    cam_rot = Euler((math.radians(60), 0, math.radians(45)))
    rm = cam_rot.to_matrix()
    right = rm @ Vector((1, 0, 0))
    ground_up = Vector((rm[0][1], rm[1][1], 0)).normalized()  # "arriba" de la pantalla sobre el suelo
    # Hacia el sol: arriba y algo a la izquierda en pantalla, 49° sobre el horizonte (como el terreno).
    hor = (ground_up * 0.45 - Vector((right.x, right.y, 0)).normalized() * 0.2).normalized()
    to_sun = (hor * 0.65 + Vector((0, 0, 0.75))).normalized()
    sun_dir = -to_sun  # dirección en la que viaja la luz
    path = os.path.join(OUT, 'manifest.json')
    manifest = json.load(open(path)) if os.path.exists(path) else {}
    for a in ASSETS:
        if FILTER and FILTER not in a[2]:
            continue
        render_asset(*a, cam_rot, sun_dir, manifest)
        json.dump(manifest, open(path, 'w'), indent=1)


if not os.environ.get('DECOR_LIB'):
    main()
