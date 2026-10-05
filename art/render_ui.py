"""
Piezas de la interfaz renderizadas en Blender: marcos blindados (9-slice), cresta gótica con vitral,
losa de icono, emblemas de generación e iconos (tecnologías, órdenes, estadísticas, recursos).

Uso: Blender -b --factory-startup -P art/render_ui.py -- [filtro]
Salida: packages/client/public/ui/<nombre>.png

Estilo: blindaje de mecha (esmalte blanco, acero oscuro) con toques sacros sobrios (vitral azul y ámbar,
filo dorado). Sin recargar.
"""
import math, os, subprocess, sys

import bmesh, bpy
from mathutils import Euler, Vector

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', 'packages', 'client', 'public', 'ui')
os.makedirs(OUT, exist_ok=True)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def reset(res=(256, 256), ortho=2.0, outline=True, tilt=0.0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    except Exception:
        pass
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.58, 0.66, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45
    sc.world = w
    for rot, e in (((35, -30, 30), 3.2), ((-50, 40, 0), 1.0)):
        l = bpy.data.objects.new('l', bpy.data.lights.new('l', 'SUN'))
        l.data.energy = e
        l.rotation_euler = Euler([math.radians(a) for a in rot])
        sc.collection.objects.link(l)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = ortho
    cam.location = (0, -10 * math.sin(tilt), 10 * math.cos(tilt))
    cam.rotation_euler = (tilt, 0, 0)
    sc.collection.objects.link(cam)
    sc.camera = cam
    if outline:
        sc.render.use_freestyle = True
        vl = bpy.context.view_layer
        vl.use_freestyle = True
        sc.render.line_thickness_mode = 'ABSOLUTE'
        sc.render.line_thickness = 1.6 * res[0] / 256
        ls = vl.freestyle_settings.linesets[0] if vl.freestyle_settings.linesets else vl.freestyle_settings.linesets.new('l')
        ls.select_silhouette = True
        ls.select_border = True
        ls.select_crease = False
        if ls.linestyle is None:
            ls.linestyle = bpy.data.linestyles.new('ink')
        ls.linestyle.color = (0.04, 0.035, 0.04)
    return sc


def mat(name, color, metallic=0.0, rough=0.45, emit=None, strength=1.5):
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


ENAMEL = lambda: mat('enamel', (0.72, 0.7, 0.65), metallic=0.15, rough=0.4)
STEEL = lambda: mat('steel', (0.2, 0.21, 0.24), metallic=0.75, rough=0.4)
DARK = lambda: mat('dark', (0.06, 0.065, 0.08), metallic=0.5, rough=0.55)
GOLD = lambda: mat('gold', (0.9, 0.62, 0.22), metallic=1.0, rough=0.3)
SILVER = lambda: mat('silver', (0.8, 0.82, 0.86), metallic=0.8, rough=0.3)
GLASS_BLUE = lambda: mat('glassb', (0.04, 0.12, 0.35), rough=0.2, emit=(0.1, 0.3, 0.9), strength=0.7)
GLASS_AMBER = lambda: mat('glassa', (0.5, 0.28, 0.04), rough=0.2, emit=(1.0, 0.55, 0.12), strength=0.8)
RED = lambda: mat('red', (0.65, 0.07, 0.05), metallic=0.3, rough=0.35)
WOOD = lambda: mat('wood', (0.4, 0.22, 0.1), rough=0.7)


def poly(name, pts, depth, m, z=0.0, bevel=0.02, segments=2):
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
        mod.segments = segments
        mod.limit_method = 'ANGLE'
    return o


def ring_poly(name, outer, inner, depth, m, z=0.0, bevel=0.015):
    """Marco: contorno exterior menos contorno interior (mismo número de vértices)."""
    bm = bmesh.new()
    oa = [bm.verts.new((x, y, z)) for x, y in outer]
    ob = [bm.verts.new((x, y, z + depth)) for x, y in outer]
    ia = [bm.verts.new((x, y, z)) for x, y in inner]
    ib = [bm.verts.new((x, y, z + depth)) for x, y in inner]
    n = len(outer)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([ob[i], ob[j], ib[j], ib[i]])
        bm.faces.new([oa[j], oa[i], ia[i], ia[j]])
        bm.faces.new([oa[i], oa[j], ob[j], ob[i]])
        bm.faces.new([ia[j], ia[i], ib[i], ib[j]])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(m)
    if bevel:
        mod = o.modifiers.new('b', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
    return o


def chamfer_rect(w, h, c):
    return [(-w + c, -h), (w - c, -h), (w, -h + c), (w, h - c), (w - c, h), (-w + c, h), (-w, h - c), (-w, -h + c)]


def cyl(r, depth, m, loc=(0, 0, 0), rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.data.materials.append(m)
    return o


def save(sc, name, size=None):
    path = os.path.join(OUT, name + '.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    if size:
        subprocess.run(['magick', path, '-resize', f'{size}x{size}', path], check=True)
    print('UI', name)


def group(*objs, rot=(0, 0, 0), loc=(0, 0, 0), scale=1.0):
    root = bpy.data.objects.new('g', None)
    bpy.context.scene.collection.objects.link(root)
    for o in objs:
        o.parent = root
    root.rotation_euler = rot
    root.location = loc
    root.scale = (scale, scale, scale)
    return root


# ------------------------------------------------------------------ marcos

def frame():
    """Marco blindado para 9-slice (256 px, borde de 40 px): canto blanco en chaflán, panel oscuro empotrado,
    esquineras doradas y una línea ámbar fina."""
    sc = reset((256, 256), ortho=2.0, outline=False)
    e, s, d, g = ENAMEL(), STEEL(), DARK(), GOLD()
    ring_poly('rim', chamfer_rect(1.0, 1.0, 0.16), chamfer_rect(0.78, 0.78, 0.08), 0.12, e)
    ring_poly('inner', chamfer_rect(0.78, 0.78, 0.08), chamfer_rect(0.72, 0.72, 0.06), 0.06, s)
    poly('panel', chamfer_rect(0.72, 0.72, 0.06), 0.02, mat('panel', (0.025, 0.03, 0.045), rough=0.7), bevel=0)
    amber = GLASS_AMBER()
    ring_poly('line', chamfer_rect(0.745, 0.745, 0.07), chamfer_rect(0.735, 0.735, 0.068), 0.07, amber, bevel=0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            pts = [(0, 0), (0.3, 0), (0.3, 0.06), (0.06, 0.06), (0.06, 0.3), (0, 0.3)]
            o = poly('corner', [(sx * (0.8 - x), sy * (0.8 - y)) for x, y in pts] if sx * sy > 0 else [(sx * (0.8 - x), sy * (0.8 - y)) for x, y in reversed(pts)], 0.15, g, bevel=0.01)
    save(sc, 'frame')


def tile():
    """Losa de icono (128 px, borde 22 px): acero oscuro con esquineras doradas."""
    sc = reset((256, 256), ortho=2.0, outline=False)
    s, d, g = STEEL(), DARK(), GOLD()
    ring_poly('rim', chamfer_rect(1.0, 1.0, 0.12), chamfer_rect(0.86, 0.86, 0.08), 0.1, s)
    poly('face', chamfer_rect(0.86, 0.86, 0.08), 0.03, mat('face', (0.06, 0.07, 0.1), metallic=0.3, rough=0.6), bevel=0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            pts = [(0, 0), (0.34, 0), (0.34, 0.08), (0.08, 0.08), (0.08, 0.34), (0, 0.34)]
            ptsw = [(sx * (0.98 - x), sy * (0.98 - y)) for x, y in pts]
            poly('corner', ptsw if sx * sy > 0 else list(reversed(ptsw)), 0.14, g, bevel=0.01)
    save(sc, 'tile', 128)


def arch():
    """Cresta gótica (320×128): arco apuntado de esmalte con vitral azul y ámbar en el centro."""
    sc = reset((320, 128), ortho=2.5, outline=False)
    e, g = ENAMEL(), GOLD()
    pts_o, pts_i = [], []
    for k in range(17):
        t = k / 16
        a = math.pi * t
        # Arco apuntado: dos arcos de circunferencia que se cortan arriba.
        x = -0.55 + 1.1 * t
        y = 0.42 * math.sin(a) ** 0.75
        pts_o.append((x * 1.0, y - 0.35))
        pts_i.append((x * 0.82, y * 0.78 - 0.32))
    outer = pts_o + [(0.55, -0.48), (-0.55, -0.48)]
    inner = pts_i + [(0.45, -0.42), (-0.45, -0.42)]
    poly('base', [(-1.2, -0.48), (1.2, -0.48), (1.1, -0.38), (-1.1, -0.38)], 0.08, e, bevel=0.01)
    ring_poly('archframe', outer, inner, 0.12, e)
    poly('glass', inner, 0.03, GLASS_BLUE(), bevel=0)
    poly('glass2', [(-0.12, -0.42), (0.12, -0.42), (0.12, -0.05), (0, 0.02), (-0.12, -0.05)], 0.05, GLASS_AMBER(), bevel=0)
    for x in (-0.25, 0.25):
        poly('lead', [(x - 0.012, -0.42), (x + 0.012, -0.42), (x + 0.012, -0.12), (x - 0.012, -0.12)], 0.06, mat('lead', (0.05, 0.05, 0.06)), bevel=0)
    poly('trim', [(-1.2, -0.39), (1.2, -0.39), (1.2, -0.37), (-1.2, -0.37)], 0.1, g, bevel=0)
    save(sc, 'arch')


def emblem(n):
    """Emblema de generación: medallón de acero con filo dorado, vitral azul y numeral romano."""
    sc = reset((256, 256), ortho=2.2, outline=True)
    g, s = GOLD(), STEEL()
    cyl(0.95, 0.12, s)
    cyl(1.0, 0.08, g, loc=(0, 0, -0.02))
    cyl(0.72, 0.16, GLASS_BLUE(), loc=(0, 0, 0.02))
    for k in range(8):
        a = k * math.pi / 4
        o = poly('ray', [(-0.05, 0.74), (0.05, 0.74), (0.0, 0.94)], 0.14, g, bevel=0.005)
        o.rotation_euler = (0, 0, a)
    cu = bpy.data.curves.new('t', 'FONT')
    cu.body = ['I', 'II', 'III'][n - 1]
    cu.size = 0.75
    cu.extrude = 0.04
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    for f in ('/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf', '/System/Library/Fonts/Times.ttc'):
        if os.path.exists(f):
            cu.font = bpy.data.fonts.load(f)
            break
    t = bpy.data.objects.new('t', cu)
    bpy.context.scene.collection.objects.link(t)
    t.data.materials.append(g)
    t.location = (0, -0.02, 0.12)
    save(sc, f'gen{n}', 128)


# ------------------------------------------------------------------ iconos (128 px, fondo transparente)

def icon(name, build, ortho=2.0):
    sc = reset((256, 256), ortho=ortho, outline=True, tilt=math.radians(18))
    build()
    save(sc, f'icon_{name}', 128)


def pickaxe_obj(s, w):
    h = poly('handle', [(-0.06, -0.9), (0.06, -0.9), (0.06, 0.6), (-0.06, 0.6)], 0.1, w)
    head = poly('head', [(-0.85, 0.32), (-0.4, 0.58), (0.0, 0.68), (0.4, 0.58), (0.85, 0.32), (0.4, 0.74), (0.0, 0.84), (-0.4, 0.74)], 0.14, s)
    return h, head


def i_pneumatic():
    s, w, g = SILVER(), WOOD(), GOLD()
    group(*pickaxe_obj(s, w), cyl(0.12, 0.6, g, loc=(0.0, -0.1, 0.12), rot=(math.pi / 2, 0, 0)), rot=(0, 0, math.radians(35)))


def i_carts():
    s, w, d = SILVER(), WOOD(), DARK()
    tray = poly('tray', [(-0.7, 0.0), (0.5, 0.0), (0.7, 0.45), (-0.8, 0.45)], 0.4, s)
    wheel = cyl(0.25, 0.12, d, loc=(0.35, -0.2, 0.2), rot=(math.pi / 2, 0, 0))
    h1 = poly('h', [(-0.8, 0.35), (-1.0, 0.35), (-1.0, 0.42), (-0.8, 0.42)], 0.1, w, bevel=0)
    ore = [poly('ore', [(x - 0.15, 0.45), (x + 0.15, 0.45), (x + 0.1, 0.65), (x - 0.12, 0.62)], 0.3, mat('ore', (0.45, 0.48, 0.55), metallic=1, rough=0.3)) for x in (-0.35, 0.0, 0.3)]
    group(tray, wheel, h1, *ore, loc=(0.1, -0.1, 0))


def i_antimech():
    s, d, r = STEEL(), DARK(), RED()
    tube = cyl(0.18, 1.6, s, rot=(0, math.pi / 2, 0))
    grip = poly('grip', [(-0.1, -0.15), (0.05, -0.15), (0.05, -0.55), (-0.1, -0.55)], 0.12, d)
    tip = cyl(0.22, 0.2, r, loc=(0.8, 0, 0), rot=(0, math.pi / 2, 0))
    sight = poly('sight', [(-0.2, 0.18), (0.1, 0.18), (0.1, 0.32), (-0.2, 0.32)], 0.08, d)
    group(tube, grip, tip, sight, rot=(0, 0, math.radians(30)))


def i_composite():
    e, s, g = ENAMEL(), STEEL(), GOLD()
    shield = [(0, -0.95), (0.75, -0.4), (0.75, 0.7), (0, 0.9), (-0.75, 0.7), (-0.75, -0.4)]
    poly('back', shield, 0.15, s)
    poly('front', [(x * 0.8, y * 0.8 + 0.02) for x, y in shield], 0.25, e)
    poly('band', [(-0.6, 0.1), (0.6, 0.1), (0.6, 0.25), (-0.6, 0.25)], 0.3, mat('blue', (0.1, 0.3, 0.9)), bevel=0)


def i_lithium():
    s, g = SILVER(), GOLD()
    cell = cyl(0.42, 1.4, mat('cell', (0.1, 0.45, 0.25), metallic=0.4, rough=0.35), rot=(math.pi / 2, 0, 0))
    cap = cyl(0.18, 0.2, s, loc=(0, 0.78, 0), rot=(math.pi / 2, 0, 0))
    bolt = poly('bolt', [(0.05, 0.45), (-0.2, -0.05), (0.0, -0.05), (-0.08, -0.45), (0.22, 0.08), (0.02, 0.08)], 0.5, mat('bolt', (1, 0.85, 0.2), emit=(1, 0.8, 0.2), strength=1.5), z=0.0, bevel=0.005)
    group(cell, cap, bolt, rot=(0, 0, math.radians(-25)))


def i_piercing():
    g, s = GOLD(), SILVER()
    body = cyl(0.25, 1.0, g, rot=(0, math.pi / 2, 0))
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.25, radius2=0.0, depth=0.6, location=(0.8, 0, 0), rotation=(0, math.pi / 2, 0))
    tipo = bpy.context.active_object
    tipo.data.materials.append(s)
    group(body, tipo, rot=(0, 0, math.radians(35)), loc=(-0.1, 0, 0))


def i_amplifiers():
    g, d, b = GOLD(), DARK(), GLASS_BLUE()
    core = cyl(0.22, 1.2, d)
    coils = [cyl(0.36, 0.08, g, loc=(0, 0, -0.45 + k * 0.15)) for k in range(7)]
    top = cyl(0.12, 0.2, b, loc=(0, 0, 0.7))
    group(core, *coils, top, rot=(math.radians(-70), 0, 0))


def i_rangefinder():
    d, s, b = DARK(), SILVER(), GLASS_BLUE()
    tube = cyl(0.25, 1.5, d, rot=(0, math.pi / 2, 0))
    lens = cyl(0.3, 0.12, s, loc=(0.75, 0, 0), rot=(0, math.pi / 2, 0))
    glass = cyl(0.22, 0.14, b, loc=(0.8, 0, 0), rot=(0, math.pi / 2, 0))
    mount = poly('mount', [(-0.25, -0.25), (0.25, -0.25), (0.15, -0.5), (-0.15, -0.5)], 0.2, s)
    group(tube, lens, glass, mount, rot=(0, 0, math.radians(20)))


def i_attack():
    s, g, w = SILVER(), GOLD(), WOOD()
    blade = poly('blade', [(-0.07, 0.0), (0.07, 0.0), (0.07, 1.25), (0.0, 1.45), (-0.07, 1.25)], 0.08, s)
    guard = poly('guard', [(-0.35, -0.05), (0.35, -0.05), (0.35, 0.07), (-0.35, 0.07)], 0.14, g)
    grip = poly('grip', [(-0.06, -0.45), (0.06, -0.45), (0.06, -0.05), (-0.06, -0.05)], 0.12, w)
    group(blade, guard, grip, rot=(0, 0, math.radians(-40)), loc=(0, -0.3, 0))


def i_amove():
    r = mat('red', (0.9, 0.2, 0.1), rough=0.3, emit=(1.0, 0.25, 0.1), strength=1.2)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.6, minor_radius=0.07)
    bpy.context.active_object.data.materials.append(r)
    for a in range(4):
        o = poly('tick', [(-0.06, 0.4), (0.06, 0.4), (0.06, 0.9), (-0.06, 0.9)], 0.1, r)
        o.rotation_euler = (0, 0, a * math.pi / 2)
    i_attack_small = poly('blade', [(-0.05, -0.5), (0.05, -0.5), (0.05, 0.4), (0.0, 0.55), (-0.05, 0.4)], 0.06, SILVER())
    i_attack_small.rotation_euler = (0, 0, math.radians(-40))


def i_stop():
    r = mat('stop', (0.6, 0.06, 0.05), metallic=0.4, rough=0.35)
    pts = [(math.cos(math.pi / 8 + k * math.pi / 4) * 0.85, math.sin(math.pi / 8 + k * math.pi / 4) * 0.85) for k in range(8)]
    poly('oct', pts, 0.15, r)
    ring_poly('rim', pts, [(x * 0.86, y * 0.86) for x, y in pts], 0.18, SILVER())
    poly('bar', [(-0.45, -0.1), (0.45, -0.1), (0.45, 0.1), (-0.45, 0.1)], 0.22, ENAMEL(), bevel=0.01)


def i_deploy(up=True):
    s, d, e = SILVER(), DARK(), ENAMEL()
    mast = poly('mast', [(-0.06, -0.8), (0.06, -0.8), (0.06, 0.4 if up else -0.3), (-0.06, 0.4 if up else -0.3)], 0.1, d)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.55, segments=32, ring_count=16)
    dish = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(dish.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > -0.25], context='VERTS')
    bm.to_mesh(dish.data)
    bm.free()
    dish.data.materials.append(e)
    dish.modifiers.new('s', 'SOLIDIFY').thickness = 0.04
    dish.location = (0.1, 0.55 if up else -0.2, 0.3)
    dish.rotation_euler = (math.radians(-60 if up else -150), math.radians(20), 0)
    arrow = poly('arrow', [(0.55, -0.2), (0.85, 0.15 if up else -0.55), (0.65, 0.15 if up else -0.55)], 0.1, GOLD()) if False else None


def i_hp():
    r = mat('heart', (0.6, 0.05, 0.06), metallic=0.3, rough=0.35)
    poly('cross_v', [(-0.22, -0.8), (0.22, -0.8), (0.22, 0.8), (-0.22, 0.8)], 0.2, r)
    poly('cross_h', [(-0.8, -0.22), (0.8, -0.22), (0.8, 0.22), (-0.8, 0.22)], 0.2, r)


def i_range():
    i_amove()


def i_speed():
    g = GOLD()
    for k in range(3):
        x = -0.55 + k * 0.45
        poly('chev', [(x, -0.6), (x + 0.25, -0.6), (x + 0.6, 0.0), (x + 0.25, 0.6), (x, 0.6), (x + 0.35, 0.0)], 0.15, g)


def i_sight():
    e = ENAMEL()
    pts = [(math.cos(a) * 0.9, math.sin(a) * 0.5 * (1 if a < math.pi else 1)) for a in [k * math.pi / 16 for k in range(32)]]
    ring_poly('eye', pts, [(x * 0.85, y * 0.75) for x, y in pts], 0.12, e)
    cyl(0.32, 0.15, GLASS_BLUE())
    cyl(0.13, 0.2, DARK())


def i_cooldown():
    s, g = SILVER(), GOLD()
    cyl(0.85, 0.12, ENAMEL())
    bpy.ops.mesh.primitive_torus_add(major_radius=0.85, minor_radius=0.07)
    bpy.context.active_object.data.materials.append(g)
    poly('h1', [(-0.05, 0), (0.05, 0), (0.05, 0.55), (-0.05, 0.55)], 0.2, DARK(), z=0.06, bevel=0)
    o = poly('h2', [(-0.05, 0), (0.05, 0), (0.05, 0.4), (-0.05, 0.4)], 0.2, DARK(), z=0.06, bevel=0)
    o.rotation_euler = (0, 0, math.radians(-110))


def i_energy():
    poly('bolt', [(0.15, 0.9), (-0.45, -0.1), (-0.02, -0.1), (-0.2, -0.9), (0.45, 0.15), (0.03, 0.15)], 0.2, mat('bolt', (1, 0.8, 0.15), emit=(1, 0.75, 0.15), strength=1.2))


def i_metal():
    s = mat('ingot', (0.6, 0.63, 0.7), metallic=1.0, rough=0.25)
    for (x, y, z) in ((-0.35, -0.2, 0), (0.35, -0.2, 0), (0.0, 0.25, 0.3)):
        o = poly('ingot', [(-0.35, -0.2), (0.35, -0.2), (0.25, 0.2), (-0.25, 0.2)], 0.3, s, z=z)
        o.location = (x, y, 0)


def i_population():
    e, b, d = ENAMEL(), GLASS_BLUE(), DARK()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.7, segments=32, ring_count=16)
    h = bpy.context.active_object
    h.scale = (1, 0.9, 1)
    h.data.materials.append(e)
    poly('visor', [(-0.45, -0.05), (0.45, -0.05), (0.4, 0.15), (-0.4, 0.15)], 0.1, b, z=0.62, bevel=0.01)
    poly('crest', [(-0.06, 0.4), (0.06, 0.4), (0.03, 1.0), (-0.03, 1.0)], 0.12, mat('blue', (0.1, 0.3, 0.9)), z=0.3)


ICONS = {
    'pneumatic': i_pneumatic, 'carts': i_carts, 'antimech': i_antimech, 'composite': i_composite, 'lithium': i_lithium,
    'piercing': i_piercing, 'amplifiers': i_amplifiers, 'rangefinder': i_rangefinder,
    'attack': i_attack, 'amove': i_amove, 'stop': i_stop, 'deploy': lambda: i_deploy(True), 'undeploy': lambda: i_deploy(False),
    'hp': i_hp, 'range': i_range, 'speed': i_speed, 'sight': i_sight, 'cooldown': i_cooldown, 'energy': i_energy,
    'metal': i_metal, 'population': i_population,
}

JOBS = [('frame', frame), ('tile', tile), ('arch', arch)] + [(f'gen{n}', (lambda n=n: emblem(n))) for n in (1, 2, 3)] + [(f'icon_{k}', (lambda k=k, f=f: icon(k, f))) for k, f in ICONS.items()]
for name, job in JOBS:
    if ARGS and not any(a in name for a in ARGS):
        continue
    job()
