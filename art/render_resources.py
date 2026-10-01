"""
Renderiza los recursos del mapa como sprites: vetas de metal (rocas con trozos de metal brillante) y
grietas de energía (anillo de piedras oscuras con cristales cian emisivos).

Uso: Blender -b --factory-startup -P art/render_resources.py
Reutiliza cámara, luz y sombra de render_decor.py; escribe en art/sprites/ y actualiza el manifest.
"""
import bmesh, bpy, json, math, os, random, sys

os.environ['DECOR_LIB'] = '1'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_decor as rd  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def append(blend, name):
    path = os.path.join(rd.ROOT, 'models', blend, f'{blend}.blend')
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = [name]
    o = dst.objects[0]
    bpy.context.scene.collection.objects.link(o)
    o.parent = None
    return o


def material(name, color, metallic=0.0, rough=0.5, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = strength
    return m


def chunk(rng, mat, size, stretch, faceted=True):
    """Trozo irregular: icosfera deformada al azar, alargada en z."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1 if faceted else 2, radius=1)
    o = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for v in bm.verts:
        v.co *= 0.75 + rng.random() * 0.5
    bm.to_mesh(o.data)
    bm.free()
    o.scale = (size, size * (0.7 + rng.random() * 0.4), size * stretch)
    o.data.materials.append(mat)
    for p in o.data.polygons:
        p.use_smooth = not faceted
    return o


def crystal(rng, mat, radius, height):
    """Prisma hexagonal con punta."""
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=radius, radius2=radius * 0.9, depth=height * 0.75, location=(0, 0, height * 0.375))
    body = bpy.context.active_object
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=radius * 0.9, radius2=0, depth=height * 0.25, location=(0, 0, height * 0.875))
    tip = bpy.context.active_object
    for o in (body, tip):
        o.data.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    tip.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    return body


def group(objs):
    root = bpy.data.objects.new('group', None)
    bpy.context.scene.collection.objects.link(root)
    for o in objs:
        o.parent = root
    return root


def ore(seed):
    rng = random.Random(seed)
    fresh()
    steel = material('steel', (0.42, 0.43, 0.46), metallic=1.0, rough=0.38)
    blue = material('mechanite', (0.22, 0.3, 0.42), metallic=1.0, rough=0.3)
    copper = material('copper', (0.55, 0.3, 0.16), metallic=1.0, rough=0.35)
    rust = material('rust', (0.3, 0.13, 0.06), metallic=0.2, rough=0.85)
    objs = []
    for i in range(3):
        r = append('boulder_01', 'boulder_01_LOD0')
        s = 0.14 + rng.random() * 0.1
        r.scale = (s, s, s * 0.8)
        r.location = (rng.uniform(-0.25, 0.25), rng.uniform(-0.25, 0.25), 0)
        r.rotation_euler = (0, 0, rng.uniform(0, 6.28))
        objs.append(r)
    for i in range(6):
        m = [steel, steel, blue, copper, rust][rng.randrange(5)]
        c = chunk(rng, m, 0.05 + rng.random() * 0.05, 1.4 + rng.random() * 1.2)
        a = rng.uniform(0, 6.28)
        d = rng.uniform(0, 0.28)
        c.location = (math.cos(a) * d, math.sin(a) * d, 0.05)
        c.rotation_euler = (rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), rng.uniform(0, 6.28))
        objs.append(c)
    return group(objs)


def vent(seed):
    rng = random.Random(seed)
    fresh()
    glow = material('energy', (0.1, 0.55, 0.7), rough=0.15, emit=(0.15, 0.75, 1.0), strength=1.4)
    dark = material('basalt', (0.07, 0.06, 0.08), rough=0.9)
    objs = []
    for i in range(7):
        a = i / 7 * 6.28 + rng.uniform(-0.3, 0.3)
        c = chunk(rng, dark, 0.09 + rng.random() * 0.05, 0.7 + rng.random() * 0.6)
        c.location = (math.cos(a) * 0.42, math.sin(a) * 0.42, 0.02)
        c.rotation_euler = (0, 0, rng.uniform(0, 6.28))
        objs.append(c)
    for i in range(6):
        h = 0.3 + rng.random() * 0.45
        c = crystal(rng, glow, 0.04 + rng.random() * 0.03, h)
        a = rng.uniform(0, 6.28)
        d = rng.uniform(0, 0.22)
        c.location = (math.cos(a) * d, math.sin(a) * d, 0)
        c.rotation_euler = (rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), rng.uniform(0, 6.28))
        objs.append(c)
    return group(objs)


def main():
    cam_rot = Euler((math.radians(60), 0, math.radians(45)))
    rm = cam_rot.to_matrix()
    right = rm @ Vector((1, 0, 0))
    ground_up = Vector((rm[0][1], rm[1][1], 0)).normalized()
    hor = (ground_up * 0.45 - Vector((right.x, right.y, 0)).normalized() * 0.2).normalized()
    sun_dir = -(hor * 0.65 + Vector((0, 0, 0.75))).normalized()
    path = os.path.join(rd.OUT, 'manifest.json')
    manifest = json.load(open(path)) if os.path.exists(path) else {}
    for i in range(3):
        rd.shoot(ore(100 + i), f'ore_{i}', 0.55, 1, cam_rot, sun_dir, manifest, wide=1.0)
        json.dump(manifest, open(path, 'w'), indent=1)
    for i in range(2):
        rd.shoot(vent(200 + i), f'vent_{i}', 0.75, 1, cam_rot, sun_dir, manifest, wide=1.0)
        json.dump(manifest, open(path, 'w'), indent=1)


main()
