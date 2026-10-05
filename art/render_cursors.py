"""
Cursores del ratón modelados y renderizados en Blender (32 px y 64 px para pantallas retina).

Uso: Blender -b --factory-startup -P art/render_cursors.py
Salida: packages/client/public/cursors/<nombre>_32.png, <nombre>_64.png y hotspots.json (punto activo en px de 32).

- pointer: flecha de acero con filo dorado.
- attack: espada.         - construct: martillo.     - repair: llave inglesa.
- gather: pico.           - target: mira (avanzar atacando).
Todos con un contorno oscuro para leerse sobre cualquier terreno.
"""
import json, math, os, subprocess

import bmesh, bpy
from mathutils import Euler, Vector

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', 'packages', 'client', 'public', 'cursors')
os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 48
    sc.cycles.use_denoising = True
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x = sc.render.resolution_y = 128
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.85, 0.85, 0.9, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.4
    sc.world = w
    key = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
    key.data.energy = 6.0
    key.rotation_euler = Euler((math.radians(35), math.radians(-30), math.radians(30)))
    sc.collection.objects.link(key)
    rim = bpy.data.objects.new('rim', bpy.data.lights.new('rim', 'SUN'))
    rim.data.energy = 2.0
    rim.rotation_euler = Euler((math.radians(-50), math.radians(40), 0))
    sc.collection.objects.link(rim)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 2.0
    cam.location = (0, 0, 10)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.use_freestyle = True
    vl = bpy.context.view_layer
    vl.use_freestyle = True
    sc.render.line_thickness_mode = 'ABSOLUTE'
    sc.render.line_thickness = 2.2
    ls = vl.freestyle_settings.linesets[0] if vl.freestyle_settings.linesets else vl.freestyle_settings.linesets.new('l')
    ls.select_silhouette = True
    ls.select_border = True
    ls.select_crease = False
    if ls.linestyle is None:
        ls.linestyle = bpy.data.linestyles.new('ink')
    ls.linestyle.color = (0.03, 0.02, 0.02)
    return sc


def mat(name, color, metallic=0.0, rough=0.4, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = 2.0
    return m


def poly(name, pts, depth, m, z=0.0, bevel=0.03):
    """Prisma a partir de un contorno 2D (x, y) en el plano de la pantalla."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y, z)) for x, y in pts]
    b = [bm.verts.new((x, y, z + depth)) for x, y in pts]
    bm.faces.new(list(reversed(a)))
    bm.faces.new(b)
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        bm.faces.new([a[i], a[j], b[j], b[i]])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(m)
    if bevel:
        mod = o.modifiers.new('b', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
    return o


def rot(o, deg):
    o.rotation_euler = (0, 0, math.radians(deg))
    return o


STEEL = lambda: mat('steel', (0.82, 0.84, 0.88), metallic=0.55, rough=0.3)
GOLD = lambda: mat('gold', (0.95, 0.68, 0.22), metallic=0.6, rough=0.3)
DARK = lambda: mat('dark', (0.08, 0.08, 0.09), metallic=0.5, rough=0.5)
GRIP = lambda: mat('grip', (0.45, 0.24, 0.1), rough=0.7)


def pointer():
    s, g = STEEL(), GOLD()
    poly('arrow', [(-0.9, 0.9), (0.55, -0.2), (0.05, -0.25), (0.35, -0.9), (0.1, -1.0), (-0.2, -0.35), (-0.6, -0.05)], 0.2, s)
    poly('edge', [(-0.82, 0.78), (-0.6, -0.0), (-0.55, 0.0)], 0.22, g, bevel=0.0)
    return (2, 2)  # punta, en px de 32


def sword():
    s, g, d = STEEL(), GOLD(), GRIP()
    blade = poly('blade', [(-0.08, 0.0), (0.08, 0.0), (0.08, 1.3), (0.0, 1.5), (-0.08, 1.3)], 0.08, s)
    guard = poly('guard', [(-0.35, -0.05), (0.35, -0.05), (0.35, 0.07), (-0.35, 0.07)], 0.14, g)
    grip = poly('grip', [(-0.06, -0.45), (0.06, -0.45), (0.06, -0.05), (-0.06, -0.05)], 0.12, d)
    pommel = poly('pommel', [(-0.11, -0.58), (0.11, -0.58), (0.11, -0.44), (-0.11, -0.44)], 0.15, g)
    root = bpy.data.objects.new('r', None)
    bpy.context.scene.collection.objects.link(root)
    for o in (blade, guard, grip, pommel):
        o.parent = root
    root.location = (0.1, -0.2, 0)
    rot(root, 45)
    return (2, 2)


def hammer():
    s, d = STEEL(), GRIP()
    handle = poly('handle', [(-0.07, -1.0), (0.07, -1.0), (0.07, 0.55), (-0.07, 0.55)], 0.1, d)
    head = poly('head', [(-0.45, 0.45), (0.5, 0.45), (0.5, 0.82), (-0.45, 0.82), (-0.55, 0.7), (-0.55, 0.57)], 0.22, s)
    root = bpy.data.objects.new('r', None)
    bpy.context.scene.collection.objects.link(root)
    handle.parent = head.parent = root
    root.location = (0.15, 0.05, 0)
    rot(root, 40)
    return (4, 4)


def wrench():
    s = STEEL()
    shaft = poly('shaft', [(-0.08, -0.85), (0.08, -0.85), (0.08, 0.5), (-0.08, 0.5)], 0.1, s)
    jaw = poly('jaw', [(-0.32, 0.45), (-0.05, 0.45), (-0.05, 0.75), (0.05, 0.75), (0.05, 0.45), (0.32, 0.45), (0.32, 1.0), (0.15, 1.0), (0.15, 0.85), (-0.15, 0.85), (-0.15, 1.0), (-0.32, 1.0)], 0.12, s)
    ring = poly('ring', [(-0.2, -1.05), (0.2, -1.05), (0.2, -0.75), (-0.2, -0.75)], 0.12, s)
    root = bpy.data.objects.new('r', None)
    bpy.context.scene.collection.objects.link(root)
    for o in (shaft, jaw, ring):
        o.parent = root
    root.location = (0.1, 0.0, 0)
    rot(root, 40)
    return (4, 4)


def pickaxe():
    s, d = STEEL(), GRIP()
    handle = poly('handle', [(-0.07, -1.0), (0.07, -1.0), (0.07, 0.65), (-0.07, 0.65)], 0.1, d)
    pts = [(-0.95, 0.35), (-0.45, 0.62), (0.0, 0.72), (0.45, 0.62), (0.95, 0.35), (0.45, 0.78), (0.0, 0.88), (-0.45, 0.78)]
    head = poly('head', pts, 0.16, s)
    root = bpy.data.objects.new('r', None)
    bpy.context.scene.collection.objects.link(root)
    handle.parent = head.parent = root
    root.location = (0.15, 0.0, 0)
    rot(root, 40)
    return (4, 4)


def target():
    r = mat('red', (0.9, 0.15, 0.1), rough=0.3, emit=(1.0, 0.2, 0.1))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.6, minor_radius=0.07, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(r)
    for a in range(4):
        o = poly('tick', [(-0.06, 0.45), (0.06, 0.45), (0.06, 0.95), (-0.06, 0.95)], 0.1, r)
        rot(o, a * 90)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08)
    bpy.context.active_object.data.materials.append(r)
    return (16, 16)


JOBS = {'pointer': pointer, 'attack': sword, 'construct': hammer, 'repair': wrench, 'gather': pickaxe, 'target': target}
hotspots = {}
for name, job in JOBS.items():
    sc = reset()
    hotspots[name] = job()
    raw = os.path.join(OUT, f'{name}_raw.png')
    sc.render.filepath = raw
    bpy.ops.render.render(write_still=True)
    for size in (32, 64):
        subprocess.run(['magick', raw, '-resize', f'{size}x{size}', os.path.join(OUT, f'{name}_{size}.png')], check=True)
    os.remove(raw)
    print('CURSOR', name)
json.dump(hotspots, open(os.path.join(OUT, 'hotspots.json'), 'w'), indent=1)
