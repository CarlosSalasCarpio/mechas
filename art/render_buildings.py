"""
Modela por código y renderiza los edificios como sprites (por ahora, el cuartel general).

Uso: Blender -b --factory-startup -P art/render_buildings.py
Basado en el concepto art/concepts/hq.png: bloque octogonal de chapa crema desgastada, costillas de acero
oscuro, franja de color de equipo, parábola grande, torre de antenas, focos y anexos con puertas.

Unidades: 1 = una casilla. El cuartel general ocupa 4×4, centrado en el origen. La cámara mira desde +x/−y:
las caras visibles son −y (abajo a la izquierda en pantalla) y +x (abajo a la derecha); la esquina en
chaflán entre ambas mira de frente.

Salidas (art/sprites/): hq_0.png (color) y hq_0_team.png (solo las zonas de color de equipo, en gris
iluminado, para teñirlas en el juego).
"""
import bmesh, bpy, json, math, os, sys

os.environ['DECOR_LIB'] = '1'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_decor as rd  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

TEX = os.path.join(rd.ROOT, 'textures')
FONT_CJK = '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc'
TEAM = []  # materiales de color de equipo


# ------------------------------------------------------------------ materiales

def img(name, kind, colorspace='sRGB'):
    i = bpy.data.images.load(os.path.join(TEX, f'{name}_{kind}.jpg'), check_existing=True)
    i.colorspace_settings.name = colorspace
    return i


def sock(sockets, name, kind='RGBA'):
    """Socket por nombre y tipo (el nodo Mix repite nombres para número, vector y color)."""
    return next(x for x in sockets if x.name == name and x.type == kind)


def tex_node(nt, image, scale):
    """Textura de imagen con proyección en caja sobre coordenadas de objeto (sin UVs)."""
    co = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = image
    t.projection = 'BOX'
    t.projection_blend = 0.25
    nt.links.new(co.outputs['Object'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], t.inputs['Vector'])
    return t


def painted(name, color, scale=0.9, wear=1.0):
    """Chapa pintada con churretes de óxido y suciedad abajo (máscara sacada de una foto de pintura oxidada)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    grime = tex_node(nt, img('rusty_painted_metal', 'Diffuse'), scale)
    rust = tex_node(nt, img('rust_coarse_01', 'Diffuse'), scale * 1.3)
    plate_n = tex_node(nt, img('metal_plate_02', 'nor_gl', 'Non-Color'), scale * 0.8)
    # Máscara: las zonas oscuras de la foto (churretes, desconchones) → óxido.
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(grime.outputs['Color'], bw.inputs['Color'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.035
    ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    ramp.color_ramp.elements[1].position = 0.09
    ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    nt.links.new(bw.outputs['Val'], ramp.inputs['Fac'])
    wearm = nt.nodes.new('ShaderNodeMath')
    wearm.operation = 'MULTIPLY'
    wearm.inputs[1].default_value = 0.45 * wear
    nt.links.new(ramp.outputs['Color'], wearm.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    sock(mix.inputs, 'A').default_value = (*color, 1)
    nt.links.new(wearm.outputs['Value'], mix.inputs['Factor'])
    nt.links.new(rust.outputs['Color'], sock(mix.inputs, 'B'))
    # Suciedad en la parte baja.
    co = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(co.outputs['Object'], sep.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = 0.0
    mr.inputs['From Max'].default_value = 0.45
    mr.inputs['To Min'].default_value = 0.7
    mr.inputs['To Max'].default_value = 1.0
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    dirt = nt.nodes.new('ShaderNodeMix')
    dirt.data_type = 'RGBA'
    dirt.blend_type = 'MULTIPLY'
    dirt.inputs['Factor'].default_value = 1.0
    nt.links.new(sock(mix.outputs, 'Result'), sock(dirt.inputs, 'A'))
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for k in ('Red', 'Green', 'Blue'):
        nt.links.new(mr.outputs['Result'], comb.inputs[k])
    nt.links.new(comb.outputs['Color'], sock(dirt.inputs, 'B'))
    nt.links.new(sock(dirt.outputs, 'Result'), bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.55
    bsdf.inputs['Metallic'].default_value = 0.15
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.inputs['Strength'].default_value = 0.6
    nt.links.new(plate_n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def flat(name, color, metallic=0.0, rough=0.5, emit=None, strength=0.0):
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


def hazard(name, width=0.09, dark=(0.05, 0.05, 0.05), light=(0.86, 0.82, 0.72)):
    """Franjas en diagonal (por defecto, de peligro: negras y crema)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    co = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(co.outputs['Object'], sep.inputs['Vector'])
    add = nt.nodes.new('ShaderNodeMath')
    add.operation = 'ADD'
    nt.links.new(sep.outputs['X'], add.inputs[0])
    nt.links.new(sep.outputs['Y'], add.inputs[1])
    add2 = nt.nodes.new('ShaderNodeMath')
    add2.operation = 'ADD'
    nt.links.new(add.outputs[0], add2.inputs[0])
    nt.links.new(sep.outputs['Z'], add2.inputs[1])
    wave = nt.nodes.new('ShaderNodeMath')
    wave.operation = 'PINGPONG'
    wave.inputs[1].default_value = width
    nt.links.new(add2.outputs[0], wave.inputs[0])
    step = nt.nodes.new('ShaderNodeMath')
    step.operation = 'GREATER_THAN'
    step.inputs[1].default_value = width / 2
    nt.links.new(wave.outputs[0], step.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    sock(mix.inputs, 'A').default_value = (*dark, 1)
    sock(mix.inputs, 'B').default_value = (*light, 1)
    nt.links.new(step.outputs[0], mix.inputs['Factor'])
    nt.links.new(sock(mix.outputs, 'Result'), b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.6
    return m


# ------------------------------------------------------------------ geometría

def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def mesh_obj(name, bm, mat, bevel=0.0):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(mat)
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
    return o


def octa_pts(size, ch):
    h = size / 2
    return [(-h + ch, -h), (h - ch, -h), (h, -h + ch), (h, h - ch), (h - ch, h), (-h + ch, h), (-h, h - ch), (-h, -h + ch)]


def prism(name, pts, z0, z1, mat, bevel=0.0):
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, z0)) for x, y in pts]
    top = [bm.verts.new((x, y, z1)) for x, y in pts]
    bm.faces.new(list(reversed(bot)))
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([bot[i], bot[j], top[j], top[i]])
    return mesh_obj(name, bm, mat, bevel)


def box(name, c, size, mat, rot=0.0, bevel=0.012):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    o = mesh_obj(name, bm, mat, bevel)
    o.location = c
    o.rotation_euler = (0, 0, rot)
    return o


def cyl(name, c, r, depth, mat, rot=(0, 0, 0), verts=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=c, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o


def text(body, c, rot, size, mat, font=None):
    cu = bpy.data.curves.new('t', 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = 0.004
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    if font and os.path.exists(font):
        cu.font = bpy.data.fonts.load(font)
    o = link(bpy.data.objects.new('t', cu))
    o.data.materials.append(mat)
    o.location = c
    o.rotation_euler = rot
    return o


def face_rot(nx, ny):
    """Giro para un texto plano que mira hacia fuera según la normal (nx, ny) de una pared."""
    return Euler((math.pi / 2, 0, math.atan2(ny, nx) + math.pi / 2))


def hq():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cream = painted('cream', (0.9, 0.82, 0.63), wear=0.55)
    cream2 = painted('cream2', (0.84, 0.77, 0.6), scale=1.2, wear=0.55)
    steel = painted('gunmetal', (0.08, 0.085, 0.1), scale=1.1, wear=0.4)
    team = painted('team', (0.92, 0.92, 0.92), wear=0.4)
    TEAM.append(team)
    haz = hazard('hazard')
    black = flat('ink', (0.03, 0.03, 0.03), rough=0.7)
    dark = flat('doorway', (0.02, 0.02, 0.025), rough=0.9)
    lamp = flat('lamp', (0.9, 0.95, 1.0), emit=(1.0, 0.97, 0.9), strength=6.0)
    window = flat('window', (0.2, 0.15, 0.08), emit=(1.0, 0.72, 0.35), strength=2.5)
    dish_m = painted('dish', (0.9, 0.88, 0.82), scale=1.5, wear=0.6)
    parts = []
    P = parts.append

    # Cuerpo octogonal en tres niveles: zócalo oscuro, pared baja con franja, pared alta retranqueada.
    P(prism('plinth', octa_pts(3.75, 0.8), 0.0, 0.18, steel, 0.02))
    P(prism('wall_low', octa_pts(3.45, 0.72), 0.18, 1.12, cream, 0.015))
    P(prism('stripe', octa_pts(3.47, 0.73), 0.66, 0.84, team))
    P(prism('ledge', octa_pts(3.55, 0.76), 1.1, 1.16, steel, 0.01))
    P(prism('wall_high', octa_pts(3.3, 0.7), 1.16, 1.58, cream2, 0.015))
    P(prism('roof_rim', octa_pts(3.36, 0.71), 1.56, 1.61, steel, 0.008))

    # Costillas de acero oscuro en cada arista del octógono: suben por la pared y doblan sobre el tejado.
    for x, y in octa_pts(3.45, 0.72):
        n = Vector((x, y, 0)).normalized()
        ang = math.atan2(n.y, n.x)
        base = Vector((x, y, 0)) + n * 0.06
        P(box('rib', (base.x, base.y, 0.86), (0.2, 0.13, 1.72), steel, ang))
        top = Vector((x, y, 0)) - n * 0.12
        P(box('rib_cap', (top.x, top.y, 1.68), (0.42, 0.13, 0.12), steel, ang))
        foot = Vector((x, y, 0)) + n * 0.16
        P(box('rib_foot', (foot.x, foot.y, 0.12), (0.18, 0.18, 0.24), steel, ang))

    # Espina central en diagonal (de la esquina trasera a la delantera) con bloque de entrada al frente.
    d = Vector((1, -1, 0)).normalized()
    P(box('spine', (0, 0, 1.72), (0.62, 3.2, 0.3), cream, math.radians(45)))
    for i in range(-3, 4):
        c = d * (i * 0.42)
        P(box('spine_vent', (c.x, c.y, 1.88), (0.5, 0.08, 0.03), steel, math.radians(45)))
    front = d * 1.72
    P(box('entry', (front.x, front.y, 0.75), (1.0, 0.5, 1.5), cream, math.radians(45)))
    P(box('entry_band', (front.x + d.x * 0.01, front.y + d.y * 0.01, 0.75), (1.02, 0.5, 0.18), team, math.radians(45)))
    door = d * 1.98
    P(box('entry_door', (door.x, door.y, 0.22), (0.5, 0.04, 0.36), dark, math.radians(45), 0.0))
    P(box('entry_frame', (door.x, door.y, 0.42), (0.62, 0.05, 0.05), haz, math.radians(45), 0.0))
    P(box('entry_sill', (door.x, door.y, 0.05), (0.62, 0.08, 0.04), haz, math.radians(45), 0.0))
    P(text('司令部', (door.x + d.x * 0.02, door.y + d.y * 0.02, 1.08), face_rot(d.x, d.y), 0.2, black, FONT_CJK))

    # Mitad izquierda del tejado: torreta con la parábola grande.
    tx, ty = -0.95, -0.25
    P(cyl('turret', (tx, ty, 1.72), 0.42, 0.28, steel, verts=24))
    P(cyl('turret_top', (tx, ty, 1.9), 0.3, 0.1, cream, verts=24))
    # Parábola: casquete de esfera poco profundo, inclinado hacia arriba a la derecha.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.7, location=(0, 0, 0), segments=40, ring_count=20)
    dish = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(dish.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > -0.48], context='VERTS')
    bmesh.ops.translate(bm, vec=(0, 0, 0.7), verts=bm.verts)
    bm.to_mesh(dish.data)
    bm.free()
    sol = dish.modifiers.new('s', 'SOLIDIFY')
    sol.thickness = 0.025
    dish.data.materials.append(dish_m)
    tilt = Euler((math.radians(-50), 0, math.radians(-120)))
    dish.rotation_euler = tilt
    dish.location = (tx, ty, 2.1)
    P(dish)
    P(cyl('dish_mast', (tx, ty, 2.0), 0.07, 0.25, steel))
    axis = tilt.to_matrix() @ Vector((0, 0, 1))
    for k in range(3):
        a = k * 2.094
        rim = tilt.to_matrix() @ Vector((math.cos(a) * 0.45, math.sin(a) * 0.45, 0.2))
        tip = axis * 0.55
        mid = (rim + tip) / 2
        dvec = tip - rim
        st = cyl('feed_strut', (tx + mid.x, ty + mid.y, 2.1 + mid.z), 0.008, dvec.length, steel, (0, 0, 0), 6)
        st.rotation_euler = dvec.to_track_quat('Z', 'Y').to_euler()
        P(st)
    P(cyl('feed', (tx + axis.x * 0.55, ty + axis.y * 0.55, 2.1 + axis.z * 0.55), 0.03, 0.08, steel, tilt, 10))

    # Mitad derecha: cubierta con borde de franjas y el emblema del equipo.
    for (cx, cy, sx, sy) in [(0.85, 1.55, 1.9, 0.08), (1.55, 0.85, 0.08, 1.9)]:
        P(box('deck_border', (cx, cy, 1.63), (sx, sy, 0.05), haz, 0, 0.0))
    emb = [(0.0, 0.0), (0.45, 0.32), (0.9, 0.0), (0.9, 0.2), (0.45, 0.52), (0.0, 0.2)]
    for k, dy in enumerate((0.0, 0.32)):
        bm = bmesh.new()
        vs = [bm.verts.new((x - 0.45, y - 0.26 + dy, 0)) for x, y in emb]
        f = bm.faces.new(vs)
        bmesh.ops.extrude_face_region(bm, geom=[f])
        for v in bm.verts:
            if v.co.z == 0 and v not in vs:
                pass
        bmesh.ops.translate(bm, vec=(0, 0, 0.01), verts=[v for v in bm.verts if v not in vs])
        o = mesh_obj('emblem', bm, team)
        o.location = (0.78, 0.78, 1.611)
        o.rotation_euler = (0, 0, math.radians(-45))
        P(o)

    # Torre de antenas al fondo.
    ax, ay = -0.55, 1.05
    for dx, dy in [(-0.09, -0.09), (0.09, -0.09), (0.09, 0.09), (-0.09, 0.09)]:
        P(cyl('mast_leg', (ax + dx, ay + dy, 2.15), 0.014, 1.15, steel, verts=6))
    for z in (1.8, 2.1, 2.4, 2.65):
        P(box('mast_ring', (ax, ay, z), (0.2, 0.2, 0.02), steel, 0, 0.0))
    for z, w in ((2.5, 0.36), (2.68, 0.26)):
        P(box('mast_bar', (ax, ay, z), (w, 0.02, 0.02), steel, math.radians(45), 0.0))
    P(cyl('mast_tip', (ax, ay, 2.9), 0.01, 0.4, steel, verts=6))
    for k, (dx, dy, z) in enumerate([(0.16, 0.0, 2.3), (-0.14, 0.06, 2.05)]):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.09, depth=0.02, location=(ax + dx, ay + dy, z), rotation=(math.radians(80), 0, math.radians(20 + 140 * k)))
        o = bpy.context.active_object
        o.data.materials.append(dish_m)
        P(o)

    # Anexos con puerta: a la izquierda (cara −y) y a la derecha (cara +x).
    for (c, size, rot, n) in [((-0.75, -1.88, 0.3), (0.95, 0.42, 0.6), 0.0, (0, -1)), ((1.88, 0.55, 0.26), (0.42, 0.8, 0.52), 0.0, (1, 0))]:
        P(box('annex', c, size, cream2, rot))
        P(box('annex_roof', (c[0], c[1], c[2] * 2 + 0.02), (size[0] + 0.06, size[1] + 0.06, 0.05), steel, rot))
        dx = c[0] + n[0] * (size[0] / 2 + 0.005)
        dy = c[1] + n[1] * (size[1] / 2 + 0.005)
        w = 0.32
        P(box('annex_door', (dx, dy, 0.17), (w if n[0] == 0 else 0.02, 0.02 if n[0] == 0 else w, 0.32), dark, 0, 0.0))
        P(box('annex_frame', (dx + n[0] * 0.01, dy + n[1] * 0.01, 0.36), (w + 0.1 if n[0] == 0 else 0.02, 0.02 if n[0] == 0 else w + 0.1, 0.05), haz, 0, 0.0))

    # Ventanas iluminadas en la pared alta y rótulos con números.
    for (x, y, nx, ny) in [(0.45, -1.651, 0, -1), (1.651, -0.45, 1, 0), (1.651, 0.25, 1, 0)]:
        P(box('window', (x, y, 1.38), (0.42 if nx == 0 else 0.01, 0.01 if nx == 0 else 0.42, 0.1), window, 0, 0.0))
    P(text('08', (-0.2, -1.736, 1.0), face_rot(0, -1), 0.26, black))
    P(text('013', (1.736, 0.95, 1.0), face_rot(1, 0), 0.26, black))

    # Tuberías horizontales por las paredes visibles, con bajantes.
    for (a, b, z) in [((-1.6, -1.79), (0.1, -1.79), 0.34), ((1.79, -0.2), (1.79, 1.5), 0.36)]:
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z)
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        rot = (0, math.pi / 2, 0) if a[1] == b[1] else (math.pi / 2, 0, 0)
        P(cyl('pipe', mid, 0.035, ln, steel, rot, 10))
        for t in (0.15, 0.85):
            px, py = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            P(cyl('pipe_drop', (px, py, z / 2), 0.03, z, steel, (0, 0, 0), 10))

    # Focos en las esquinas del tejado.
    for (x, y) in [(-1.25, -1.25), (1.25, -1.25), (1.25, 1.25), (-1.4, 0.9)]:
        P(cyl('lamp_pole', (x, y, 1.8), 0.015, 0.4, steel, verts=6))
        P(box('lamp_head', (x, y, 2.02), (0.12, 0.1, 0.08), steel, math.radians(45)))
        n = Vector((1, -1, 0)).normalized()
        P(box('lamp_face', (x + n.x * 0.052, y + n.y * 0.052, 2.02), (0.08, 0.01, 0.055), lamp, math.radians(45), 0.0))

    root = link(bpy.data.objects.new('hq', None))
    for o in parts:
        o.parent = root
    return root


def palette():
    """Materiales comunes de los edificios (se crean tras reiniciar la escena)."""
    team = painted('team', (0.92, 0.92, 0.92), wear=0.4)
    TEAM.append(team)
    return {
        'cream': painted('cream', (0.9, 0.82, 0.63), wear=0.55),
        'cream2': painted('cream2', (0.84, 0.77, 0.6), scale=1.2, wear=0.55),
        'steel': painted('gunmetal', (0.08, 0.085, 0.1), scale=1.1, wear=0.4),
        'team': team,
        'haz': hazard('hazard'),
        'ink': flat('ink', (0.03, 0.03, 0.03), rough=0.7),
        'dark': flat('doorway', (0.02, 0.02, 0.025), rough=0.9),
        'lamp': flat('lamp', (0.9, 0.95, 1.0), emit=(1.0, 0.97, 0.9), strength=6.0),
        'window': flat('window', (0.12, 0.16, 0.2), emit=(0.55, 0.75, 0.9), strength=0.6),
        'dish': painted('dish', (0.9, 0.88, 0.82), scale=1.5, wear=0.6),
        'grate': hazard('grate', width=0.04, dark=(0.03, 0.03, 0.035), light=(0.2, 0.2, 0.22)),
        'olive': painted('olive', (0.25, 0.28, 0.16), scale=1.4, wear=0.5),
        'rust_red': painted('rust_red', (0.45, 0.14, 0.08), scale=1.4, wear=1.0),
    }


def module(name, M, c, length, width, height, axis, ribs, ch=0.18):
    """Módulo alargado de techo achaflanado (barracón), con costillas oscuras que lo abrazan y zócalo.
    `axis` 'x' o 'y': dirección del lado largo. Devuelve (partes, función local→mundo)."""
    parts = []
    hw = width / 2

    def profile(w, h, chf, z0=0.0):
        return [(-w, z0), (w, z0), (w, h - chf), (w - chf, h), (-w + chf, h), (-w, h - chf)]

    def extrude(nm, prof, y0, y1, mat, bevel=0.01):
        bm = bmesh.new()
        a = [bm.verts.new((u, y0, z)) for u, z in prof]
        b = [bm.verts.new((u, y1, z)) for u, z in prof]
        bm.faces.new(list(reversed(a)))
        bm.faces.new(b)
        n = len(prof)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([a[i], a[j], b[j], b[i]])
        o = mesh_obj(nm, bm, mat, bevel)
        o.rotation_euler = (0, 0, 0 if axis == 'y' else -math.pi / 2)
        o.location = c
        return o

    L = length / 2
    parts.append(extrude(name + '_plinth', profile(hw + 0.05, 0.08, 0.0), -L - 0.05, L + 0.05, M['steel']))
    parts.append(extrude(name + '_body', profile(hw, height, ch), -L, L, M['cream']))
    # Franja de equipo a media altura, por los dos lados largos.
    for sgn in (-1, 1):
        prof = [(sgn * hw, height * 0.5), (sgn * (hw + 0.012), height * 0.5), (sgn * (hw + 0.012), height * 0.64), (sgn * hw, height * 0.64)]
        if sgn < 0:
            prof = list(reversed(prof))
        parts.append(extrude(name + '_stripe', prof, -L + 0.02, L - 0.02, M['team'], 0.0))
    # Costillas: el perfil un poco más grande, delgado a lo largo.
    for k in range(ribs):
        t = -L + 0.12 + (length - 0.24) * k / max(1, ribs - 1)
        parts.append(extrude(name + '_rib', profile(hw + 0.045, height + 0.045, ch + 0.02, 0.0), t - 0.06, t + 0.06, M['steel']))
    return parts


def local(c, axis, u, v, z):
    """Punto en coordenadas del módulo (u: a lo ancho, v: a lo largo) → mundo."""
    if axis == 'y':
        return (c[0] + u, c[1] + v, z)
    return (c[0] + v, c[1] - u, z)


def barracks():
    """Barracas (3×3): dos barracones y un almacén pequeño, unidos por pasarelas de rejilla (art/concepts/barracks.png)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = palette()
    parts = []
    P = parts.append

    # Pasarelas de rejilla entre módulos (por debajo).
    for (cx, cy, sx, sy) in [(-0.15, 0.2, 0.32, 1.9), (0.55, -0.15, 1.3, 0.28), (0.4, -0.45, 0.24, 0.5)]:
        P(box('walk', (cx, cy, 0.02), (sx, sy, 0.03), M['steel'], 0, 0.0))
        P(box('walk_grate', (cx, cy, 0.04), (sx - 0.06, sy - 0.06, 0.005), M['grate'], 0, 0.0))

    # Barracón A: largo, a lo largo de y, a la izquierda.
    A = (-0.78, 0.05, 0.0)
    parts += module('A', M, A, 2.5, 0.92, 0.82, 'y', 5)
    # Puertas en el lado largo visible (+x) y en el extremo (−y).
    for v in (-0.55, 0.45):
        P(box('A_door', local(A, 'y', 0.465, v, 0.2), (0.012, 0.22, 0.34), M['dark'], 0, 0.0))
        P(box('A_doorframe', local(A, 'y', 0.47, v, 0.39), (0.012, 0.3, 0.04), M['haz'], 0, 0.0))
    P(box('A_enddoor', local(A, 'y', 0.0, -1.252, 0.2), (0.26, 0.012, 0.34), M['dark'], 0, 0.0))
    for v in (-0.95, -0.05, 0.85):
        P(box('A_win', local(A, 'y', 0.463, v, 0.56), (0.012, 0.16, 0.08), M['window'], 0, 0.0))
    P(text('兵舎A', local(A, 'y', 0.475, -0.12, 0.64), face_rot(1, 0), 0.14, M['ink'], FONT_CJK))
    P(text('04', local(A, 'y', 0.475, 0.95, 0.64), face_rot(1, 0), 0.16, M['ink']))
    P(text('兵舎A', local(A, 'y', -0.2, -1.258, 0.62), face_rot(0, -1), 0.12, M['ink'], FONT_CJK))
    # Emblemas en el tejado y parábola en el extremo trasero.
    emb = [(0.0, 0.0), (0.45, 0.32), (0.9, 0.0), (0.9, 0.2), (0.45, 0.52), (0.0, 0.2)]
    for v in (-0.35, 0.45):
        for dy in (0.0, 0.32):
            bm = bmesh.new()
            vs = [bm.verts.new(((x - 0.45) * 0.45, (y - 0.26 + dy) * 0.45, 0)) for x, y in emb]
            f = bm.faces.new(vs)
            bmesh.ops.extrude_face_region(bm, geom=[f])
            bmesh.ops.translate(bm, vec=(0, 0, 0.008), verts=[v2 for v2 in bm.verts if v2 not in vs])
            o = mesh_obj('A_emblem', bm, M['team'])
            o.location = local(A, 'y', 0.0, v, 0.823)
            o.rotation_euler = (0, 0, math.radians(90))
            P(o)
    dpos = local(A, 'y', 0.0, 1.0, 0.82)
    P(cyl('A_dishbase', (dpos[0], dpos[1], 0.88), 0.07, 0.12, M['steel']))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.3, segments=32, ring_count=16)
    dish = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(dish.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > -0.2], context='VERTS')
    bmesh.ops.translate(bm, vec=(0, 0, 0.3), verts=bm.verts)
    bm.to_mesh(dish.data)
    bm.free()
    dish.modifiers.new('s', 'SOLIDIFY').thickness = 0.015
    dish.data.materials.append(M['dish'])
    dish.rotation_euler = (math.radians(-50), 0, math.radians(-135))
    dish.location = (dpos[0], dpos[1], 0.95)
    P(dish)

    # Barracón B: a lo largo de x, a la derecha, con portón enrollable en el lado largo visible (−y).
    B = (0.62, 0.68, 0.0)
    parts += module('B', M, B, 1.65, 0.82, 0.76, 'x', 4)
    P(box('B_shutter', local(B, 'x', 0.413, -0.1, 0.26), (0.5, 0.012, 0.44), M['steel'], 0, 0.0))
    for z in (0.1, 0.18, 0.26, 0.34, 0.42):
        P(box('B_slat', local(B, 'x', 0.42, -0.1, z), (0.48, 0.006, 0.012), M['cream2'], 0, 0.0))
    P(box('B_shutterframe', local(B, 'x', 0.418, -0.1, 0.5), (0.58, 0.012, 0.05), M['haz'], 0, 0.0))
    P(box('B_ramp', local(B, 'x', 0.52, -0.1, 0.015), (0.55, 0.2, 0.03), M['steel'], 0, 0.0))
    P(box('B_enddoor', (B[0] + 0.828, B[1] - 0.05, 0.2), (0.012, 0.22, 0.34), M['dark'], 0, 0.0))
    P(text('09', local(B, 'x', 0.42, -0.62, 0.62), face_rot(0, -1), 0.15, M['ink']))
    P(text('兵舎B', local(B, 'x', 0.42, 0.5, 0.62), face_rot(0, -1), 0.12, M['ink'], FONT_CJK))
    P(text('11', (B[0] + 0.836, B[1] - 0.05, 0.5), face_rot(1, 0), 0.12, M['ink']))
    # Aire acondicionado y antenas en el tejado.
    ac = local(B, 'x', 0.0, 0.55, 0.8)
    P(box('B_ac', (ac[0], ac[1], 0.84), (0.22, 0.16, 0.12), M['cream2']))
    P(cyl('B_fan', (ac[0], ac[1] - 0.081, 0.84), 0.045, 0.01, M['steel'], (math.pi / 2, 0, 0)))
    for du in (-0.1, 0.12):
        a2 = local(B, 'x', du, -0.5, 0.0)
        P(cyl('B_antenna', (a2[0], a2[1], 0.98), 0.008, 0.45, M['steel'], (0, 0, 0), 6))

    # Almacén C: pequeño, a lo largo de y, delante; puerta en el extremo (−y).
    C = (0.42, -0.88, 0.0)
    parts += module('C', M, C, 0.95, 0.72, 0.6, 'y', 3, ch=0.14)
    P(box('C_door', local(C, 'y', 0.0, -0.477, 0.17), (0.24, 0.012, 0.3), M['dark'], 0, 0.0))
    P(box('C_doorframe', local(C, 'y', 0.0, -0.48, 0.34), (0.32, 0.012, 0.04), M['haz'], 0, 0.0))
    P(text('資材A', local(C, 'y', 0.0, -0.482, 0.47), face_rot(0, -1), 0.1, M['ink'], FONT_CJK))

    # Cajas militares y bidones junto a los módulos.
    for (x, y) in [(-1.32, -1.05), (-1.32, -0.82), (-0.05, -1.25)]:
        P(box('crate', (x, y, 0.07), (0.18, 0.18, 0.14), M['olive']))
    for (x, y) in [(-0.2, -0.55), (-0.08, -0.5), (0.95, -1.15), (1.08, -1.08)]:
        P(cyl('barrel', (x, y, 0.08), 0.055, 0.16, M['rust_red'], verts=14))

    root = link(bpy.data.objects.new('barracks', None))
    for o in parts:
        o.parent = root
    return root


def wall_run(name, p0, p1, n, prof, mat, bevel=0.01):
    """Extruye un perfil (a: hacia fuera según la normal n, z) a lo largo del tramo p0→p1 (en el suelo)."""
    bm = bmesh.new()
    ring = []
    for p in (p0, p1):
        ring.append([bm.verts.new((p[0] + n[0] * a, p[1] + n[1] * a, z)) for a, z in prof])
    a, b = ring
    bm.faces.new(list(reversed(a)))
    bm.faces.new(b)
    k = len(prof)
    for i in range(k):
        j = (i + 1) % k
        bm.faces.new([a[i], a[j], b[j], b[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, mat, bevel)


def mech_figure(M, c, h, bulk=1.6, visor='visor'):
    """Mecha esbelto de pie (cuerpo de cajas y cilindros), para verlo dentro del hangar."""
    armor = M['cream']
    joint = M['steel']
    x, y = c
    k = h / 1.3

    def part(nm, pos, size, mat):
        # Más ancho que en la realidad: a esta escala, un mecha esbelto no se lee.
        return box(nm, pos, (size[0] * bulk, size[1] * bulk, size[2]), mat)
    parts = []
    for sx in (-1, 1):
        parts.append(part('leg', (x + sx * 0.09 * k, y, 0.28 * k), (0.09 * k, 0.11 * k, 0.56 * k), armor))
        parts.append(part('knee', (x + sx * 0.09 * k, y - 0.06 * k, 0.4 * k), (0.07 * k, 0.04 * k, 0.08 * k), joint))
        parts.append(part('foot', (x + sx * 0.09 * k, y - 0.04 * k, 0.03 * k), (0.1 * k, 0.18 * k, 0.06 * k), joint))
    parts.append(part('pelvis', (x, y, 0.62 * k), (0.26 * k, 0.14 * k, 0.12 * k), joint))
    parts.append(part('torso', (x, y, 0.84 * k), (0.3 * k, 0.17 * k, 0.32 * k), armor))
    parts.append(part('chest', (x, y - 0.09 * k, 0.9 * k), (0.2 * k, 0.03 * k, 0.12 * k), M['team']))
    for sx in (-1, 1):
        parts.append(part('shoulder', (x + sx * 0.22 * k, y, 1.0 * k), (0.14 * k, 0.16 * k, 0.1 * k), armor))
        parts.append(part('arm', (x + sx * 0.24 * k, y, 0.72 * k), (0.07 * k, 0.08 * k, 0.42 * k), armor))
        parts.append(part('hand', (x + sx * 0.24 * k, y, 0.48 * k), (0.06 * k, 0.06 * k, 0.07 * k), joint))
    parts.append(part('head', (x, y, 1.1 * k), (0.09 * k, 0.11 * k, 0.12 * k), armor))
    parts.append(part('visor', (x, y - 0.056 * k * bulk / 1.6 - 0.005, 1.11 * k), (0.07 * k, 0.01 * k, 0.025 * k), M[visor]))
    parts.append(cyl('horn', (x, y - 0.02 * k, 1.22 * k), 0.008 * k, 0.12 * k, armor, (math.radians(-20), 0, 0), 6))
    return parts


def hangar():
    """Hangar (4×4): muro perimetral alto con la esquina delantera abierta y un mecha en su grúa (art/concepts/hangar.png)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = palette()
    M['yellow'] = painted('crane', (0.85, 0.58, 0.12), scale=1.5, wear=0.6)
    M['visor'] = flat('visor', (0.1, 0.3, 0.2), emit=(0.4, 1.0, 0.6), strength=3.0)
    M['floor'] = painted('floor', (0.22, 0.22, 0.24), scale=0.8, wear=0.8)
    parts = []
    P = parts.append
    R = 1.8   # medio lado exterior
    T = 0.42  # grosor del muro
    H = 1.3   # altura
    C = 0.16  # chaflán superior exterior
    G = 0.05  # donde termina cada muro antes de la esquina abierta (+x, −y)
    wall = [(-T, 0), (0, 0), (0, H - C), (-C, H), (-T, H)]  # a=0 cara exterior, a=−T cara interior
    runs = [  # (desde, hasta, normal exterior)
        ((-R, -R), (G, -R), (0, -1)),
        ((R, -G), (R, R), (1, 0)),
        ((R, R), (-R, R), (0, 1)),
        ((-R, R), (-R, -R), (-1, 0)),
    ]
    for i, (a, b, n) in enumerate(runs):
        P(wall_run(f'wall{i}', a, b, n, wall, M['cream']))
        P(wall_run(f'plinth{i}', a, b, n, [(-T - 0.02, 0), (0.06, 0), (0.06, 0.1), (-T - 0.02, 0.1)], M['steel']))
        for lo, hi in ((0.52, 0.575), (0.61, 0.64)):
            P(wall_run(f'stripe{i}', a, b, n, [(0, H * lo), (0.012, H * lo), (0.012, H * hi), (0, H * hi)], M['team'], 0.0))
    # Pilares en los extremos de la abertura.
    P(box('pillar', (G + 0.12, -R + T / 2 - 0.02, H / 2 + 0.03), (0.3, T + 0.1, H + 0.06), M['cream2']))
    P(box('pillar', (R - T / 2 + 0.02, -G - 0.12, H / 2 + 0.03), (T + 0.1, 0.3, H + 0.06), M['cream2']))
    # Costillas en A: losa vertical, pie en diagonal y remate que dobla sobre el muro.
    rib = [(0, 0), (0.42, 0), (0.13, 0.62), (0.13, H + 0.05), (-T - 0.02, H + 0.05), (-T - 0.02, H - 0.07), (0, H - 0.07)]
    def ribs_on(a, b, n, ts):
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy)
        ux, uy = dx / ln, dy / ln
        for t in ts:
            cx, cy = a[0] + dx * t, a[1] + dy * t
            p0 = (cx - ux * 0.06, cy - uy * 0.06)
            p1 = (cx + ux * 0.06, cy + uy * 0.06)
            P(wall_run('rib', p0, p1, n, rib, M['steel']))
    ribs_on(*runs[0], (0.12, 0.55, 0.93))
    ribs_on(*runs[1], (0.07, 0.45, 0.88))
    ribs_on(*runs[2], (0.5,))
    ribs_on(*runs[3], (0.5,))
    # Suelo interior y explanada delante de la abertura.
    P(box('floor', (0, 0, 0.02), (2 * (R - T), 2 * (R - T), 0.04), M['floor'], 0, 0.0))
    P(box('apron', (1.15, -1.15, 0.015), (1.3, 1.1, 0.03), M['steel'], math.radians(45), 0.0))
    P(box('apron_haz', (1.55, -1.55, 0.035), (1.35, 0.12, 0.01), M['haz'], math.radians(45), 0.0))
    # Cerchas del techo abierto.
    for t in (-1.0, 1.0):
        P(box('truss', (t, 0.0, H - 0.06), (0.07, 2 * R - 0.5, 0.1), M['steel'], 0, 0.005))
    # Esquinas cerradas: un poste macizo tapa la junta entre muros.
    for (x, y) in [(-R, -R), (R, R), (-R, R)]:
        P(box('corner', (x - math.copysign(T / 2, x), y - math.copysign(T / 2, y), H / 2), (T, T, H), M['cream2']))
    # Mecha en su grúa amarilla.
    mx, my = -0.05, 0.3
    parts += mech_figure(M, (mx, my), 1.55)
    for sx in (-1, 1):
        P(box('gantry_post', (mx + sx * 0.45, my + 0.18, 0.85), (0.07, 0.07, 1.7), M['yellow']))
    P(box('gantry_beam', (mx, my + 0.18, 1.66), (1.0, 0.08, 0.08), M['yellow']))
    for sx in (-1, 1):
        P(box('gantry_arm', (mx + sx * 0.3, my, 1.5), (0.06, 0.36, 0.05), M['yellow']))
        P(cyl('gantry_cable', (mx + sx * 0.3, my - 0.14, 1.38), 0.006, 0.22, M['steel'], (0, 0, 0), 6))
    # Aires acondicionados sobre los muros del fondo.
    for (x, y) in [(-R + T / 2, 0.75), (-R + T / 2, -0.15), (-0.5, R - T / 2), (0.55, R - T / 2)]:
        P(box('ac', (x, y, H + 0.09), (0.36, 0.32, 0.16), M['cream2']))
        P(cyl('ac_fan', (x, y, H + 0.175), 0.11, 0.01, M['steel'], (0, 0, 0), 20))
    # Tuberías en el muro derecho.
    for dy in (0.0, 0.08):
        P(cyl('pipe', (R + 0.05, 0.25 + dy, 0.45), 0.03, 0.9, M['steel'], (0, 0, 0), 10))
    # Rótulos.
    P(text('メカ製造施設', (-0.85, -R - 0.006, 1.0), face_rot(0, -1), 0.12, M['ink'], FONT_CJK))
    P(text('第1ドック', (-0.85, -R - 0.006, 0.45), face_rot(0, -1), 0.1, M['ink'], FONT_CJK))
    P(text('01', (-0.2, -R - 0.006, 0.45), face_rot(0, -1), 0.26, M['ink']))
    P(text('メカ製造施設', (R + 0.006, 0.75, 1.0), face_rot(1, 0), 0.12, M['ink'], FONT_CJK))
    P(text('01', (R + 0.006, 1.25, 0.45), face_rot(1, 0), 0.28, M['ink']))
    root = link(bpy.data.objects.new('hangar', None))
    for o in parts:
        o.parent = root
    return root


def ribs_along(P, M, a, b, n, ts, H, T):
    """Costillas en A sobre el tramo de muro a→b (normal exterior n), en las fracciones ts."""
    rib = [(0, 0), (0.42, 0), (0.13, 0.62), (0.13, H + 0.05), (-T - 0.02, H + 0.05), (-T - 0.02, H - 0.07), (0, H - 0.07)]
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy)
    ux, uy = dx / ln, dy / ln
    for t in ts:
        cx, cy = a[0] + dx * t, a[1] + dy * t
        P(wall_run('rib', (cx - ux * 0.06, cy - uy * 0.06), (cx + ux * 0.06, cy + uy * 0.06), n, rib, M['steel']))


def cradle():
    """Cuna (5×5): recinto cerrado donde se ensambla un coloso entre grúas, con anexos delante (art/concepts/cradle.png)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = palette()
    M['yellow'] = painted('crane', (0.72, 0.5, 0.16), scale=1.5, wear=0.7)
    M['visor'] = flat('visor', (0.3, 0.05, 0.05), emit=(1.0, 0.25, 0.15), strength=4.0)
    M['floor'] = painted('floor', (0.22, 0.22, 0.24), scale=0.8, wear=0.8)
    parts = []
    P = parts.append
    R, T, H, C = 1.95, 0.42, 1.45, 0.16
    wall = [(-T, 0), (0, 0), (0, H - C), (-C, H), (-T, H)]
    corners = [(-R, -R), (R, -R), (R, R), (-R, R)]
    normals = [(0, -1), (1, 0), (0, 1), (-1, 0)]
    for i in range(4):
        a, b, n = corners[i], corners[(i + 1) % 4], normals[i]
        P(wall_run(f'wall{i}', a, b, n, wall, M['cream']))
        P(wall_run(f'plinth{i}', a, b, n, [(-T - 0.02, 0), (0.06, 0), (0.06, 0.1), (-T - 0.02, 0.1)], M['steel']))
        for lo, hi in ((0.5, 0.56), (0.6, 0.63)):
            P(wall_run(f'stripe{i}', a, b, n, [(0, H * lo), (0.012, H * lo), (0.012, H * hi), (0, H * hi)], M['team'], 0.0))
        ribs_along(P, M, a, b, n, (0.08, 0.36, 0.64, 0.92), H, T)
        x, y = a
        P(box('corner', (x - math.copysign(T / 2, x), y - math.copysign(T / 2, y), H / 2), (T, T, H), M['cream2']))
    P(box('floor', (0, 0, 0.02), (2 * (R - T), 2 * (R - T), 0.04), M['floor'], 0, 0.0))
    # Coloso en ensamblaje: asoma por encima de los muros, entre dos pórticos amarillos.
    cx, cy = 0.0, 0.25
    parts += mech_figure(M, (cx, cy), 2.6, bulk=2.4)
    for gy in (cy - 0.55, cy + 0.6):
        for sx in (-1, 1):
            P(box('gantry_post', (cx + sx * 0.95, gy, 1.2), (0.09, 0.09, 2.4), M['yellow']))
        P(box('gantry_beam', (cx, gy, 2.36), (2.0, 0.1, 0.1), M['yellow']))
    for sx in (-1, 1):
        P(box('gantry_arm', (cx + sx * 0.55, cy - 0.55, 2.0), (0.07, 0.4, 0.07), M['yellow']))
    # Pasarelas sobre los muros (cerchas de lado a lado).
    for t in (-1.2, 1.25):
        P(box('truss', (t, 0.0, H - 0.05), (0.08, 2 * R - 0.4, 0.1), M['steel'], 0, 0.005))
    # Filas de aires acondicionados sobre los muros del fondo y laterales.
    for i in range(6):
        t = -R + 0.45 + i * (2 * R - 0.9) / 5
        for (x, y) in [(-R + T / 2, t), (t, R - T / 2)]:
            P(box('ac', (x, y, H + 0.09), (0.34, 0.3, 0.16), M['cream2']))
            P(cyl('ac_fan', (x, y, H + 0.175), 0.1, 0.01, M['steel'], (0, 0, 0), 20))
    # Anexos delante: un barracón pequeño a la izquierda y un bloque de servicios con tuberías a la derecha.
    parts += module('annexA', M, (-1.15, -2.22, 0.0), 1.15, 0.5, 0.55, 'x', 3, ch=0.11)
    P(text('01', (-0.85, -2.476, 0.25), face_rot(0, -1), 0.13, M['ink']))
    P(box('annexB', (2.22, -1.0, 0.32), (0.5, 0.7, 0.64), M['cream2']))
    P(box('annexB_roof', (2.22, -1.0, 0.66), (0.56, 0.76, 0.05), M['steel']))
    P(box('annexB_door', (2.476, -1.1, 0.18), (0.012, 0.22, 0.32), M['dark'], 0, 0.0))
    for k in range(3):
        P(cyl('pipe', (2.0 + k * 0.09, -1.45, 0.45), 0.035, 0.9, M['steel'], (0, 0, 0), 10))
    P(cyl('pipe_run', (2.2, -1.85, 0.06), 0.04, 1.2, M['steel'], (math.pi / 2, 0, 0), 10))
    # Rótulos.
    P(text('コロッサス製造', (0.9, -R - 0.006, 1.12), face_rot(0, -1), 0.12, M['ink'], FONT_CJK))
    P(text('03', (0.9, -R - 0.006, 0.42), face_rot(0, -1), 0.32, M['ink']))
    P(text('メカ製造施設', (-1.05, -R - 0.006, 1.12), face_rot(0, -1), 0.12, M['ink'], FONT_CJK))
    P(text('Cuna', (-1.05, -R - 0.006, 0.95), face_rot(0, -1), 0.13, M['ink']))
    P(text('コロッサス製造', (R + 0.006, 0.6, 1.12), face_rot(1, 0), 0.12, M['ink'], FONT_CJK))
    P(text('03', (R + 0.006, 0.6, 0.42), face_rot(1, 0), 0.32, M['ink']))
    root = link(bpy.data.objects.new('cradle', None))
    for o in parts:
        o.parent = root
    return root


def strut(name, p, q, r, mat, verts=6):
    """Cilindro fino entre dos puntos (celosías, tirantes)."""
    p, q = Vector(p), Vector(q)
    d = q - p
    o = cyl(name, tuple((p + q) / 2), r, d.length, mat, (0, 0, 0), verts)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return o


def lattice(P, M, z0, z1, w0, w1, levels, r=0.018):
    """Torre de celosía de 4 patas (de ancho w0 abajo a w1 arriba) con aspas en X en cada cara."""
    corner = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for sx, sy in corner:
        P(strut('leg', (sx * w0, sy * w0, z0), (sx * w1, sy * w1, z1), r * 1.6, M['steel']))
    for k in range(levels):
        za, zb = z0 + (z1 - z0) * k / levels, z0 + (z1 - z0) * (k + 1) / levels
        wa, wb = w0 + (w1 - w0) * k / levels, w0 + (w1 - w0) * (k + 1) / levels
        for i in range(4):
            (ax, ay), (bx, by) = corner[i], corner[(i + 1) % 4]
            P(strut('brace', (ax * wa, ay * wa, za), (bx * wb, by * wb, zb), r, M['steel']))
            P(strut('brace', (bx * wa, by * wa, za), (ax * wb, ay * wb, zb), r, M['steel']))
            P(strut('ring', (ax * wb, ay * wb, zb), (bx * wb, by * wb, zb), r, M['steel']))


def dish_bowl(M, r, depth_cut, loc, rot, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=40, ring_count=20)
    d = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(d.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > -r + depth_cut], context='VERTS')
    bmesh.ops.translate(bm, vec=(0, 0, r), verts=bm.verts)
    bm.to_mesh(d.data)
    bm.free()
    d.modifiers.new('s', 'SOLIDIFY').thickness = 0.02
    d.data.materials.append(mat)
    d.rotation_euler = rot
    d.location = loc
    return d


def tower():
    """Torre de defensa (2×2): base de hormigón, celosía, plataforma con cañón y remate con radar y misiles."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = palette()
    M['radar'] = painted('radar', (0.85, 0.85, 0.82), scale=2.0, wear=0.4)
    parts = []
    P = parts.append
    # Base octogonal con costillas y franja.
    P(prism('plinth', octa_pts(1.7, 0.4), 0.0, 0.1, M['steel'], 0.01))
    P(prism('base', octa_pts(1.55, 0.36), 0.1, 0.78, M['cream'], 0.012))
    P(prism('stripe', octa_pts(1.56, 0.362), 0.42, 0.5, M['team']))
    P(prism('base_cap', octa_pts(1.6, 0.37), 0.78, 0.84, M['steel'], 0.008))
    for x, y in octa_pts(1.55, 0.36):
        n = Vector((x, y, 0)).normalized()
        b = Vector((x, y, 0)) + n * 0.03
        P(box('rib', (b.x, b.y, 0.42), (0.1, 0.08, 0.84), M['steel'], math.atan2(n.y, n.x)))
    d = Vector((1, -1, 0)).normalized()
    door = d * 0.73
    P(box('door', (door.x, door.y, 0.22), (0.26, 0.03, 0.34), M['dark'], math.radians(45), 0.0))
    P(box('door_frame', (door.x, door.y, 0.41), (0.32, 0.035, 0.04), M['haz'], math.radians(45), 0.0))
    P(text('03', (0.32, -0.776, 0.62), face_rot(0, -1), 0.14, M['ink']))
    # Celosía hasta la plataforma del cañón.
    lattice(P, M, 0.84, 1.9, 0.42, 0.3, 3)
    P(prism('deck', octa_pts(1.05, 0.25), 1.9, 1.98, M['steel'], 0.008))
    P(prism('deck_rim', octa_pts(1.0, 0.24), 1.98, 2.08, M['cream2'], 0.008))
    # Cañón apuntando hacia la derecha de la pantalla.
    P(box('turret', (0.12, -0.12, 2.17), (0.3, 0.3, 0.18), M['cream'], math.radians(45)))
    P(box('turret_side', (0.12, -0.12, 2.17), (0.32, 0.18, 0.1), M['team'], math.radians(45)))
    # Boca del cañón en (0,64, 0,40, 2,19): el juego saca de ahí el disparo (towerShot).
    P(cyl('barrel', (0.39, 0.15, 2.19), 0.048, 0.7, M['steel'], (0, math.radians(90), math.radians(45)), 12))
    P(cyl('muzzle', (0.64, 0.40, 2.19), 0.065, 0.1, M['steel'], (0, math.radians(90), math.radians(45)), 12))
    # Fuste y remate con radar, lanzamisiles y antenas.
    P(prism('neck', octa_pts(0.5, 0.12), 2.08, 2.5, M['cream2'], 0.01))
    P(prism('top', octa_pts(0.95, 0.22), 2.5, 2.62, M['cream'], 0.01))
    P(prism('top_stripe', octa_pts(0.955, 0.221), 2.54, 2.58, M['team']))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.2, location=(-0.05, 0.08, 2.76), segments=24, ring_count=12)
    dome = bpy.context.active_object
    dome.data.materials.append(M['radar'])
    P(dome)
    for sx in (-1, 1):
        c = Vector((sx * 0.3, sx * 0.3, 0)) @ Euler((0, 0, 0)).to_matrix()
        pod = box('pod', (0.3 * sx + 0.1, -0.3 * sx + 0.1, 2.72), (0.18, 0.14, 0.14), M['steel'], math.radians(45))
        P(pod)
        P(box('pod_face', (0.3 * sx + 0.1 + 0.06, -0.3 * sx + 0.1 - 0.06, 2.72), (0.14, 0.01, 0.1), M['dark'], math.radians(45), 0.0))
    P(cyl('antenna', (-0.25, 0.25, 2.95), 0.008, 0.6, M['steel'], (0, 0, 0), 6))
    P(cyl('antenna', (-0.05, 0.35, 2.85), 0.006, 0.4, M['steel'], (0, 0, 0), 6))
    root = link(bpy.data.objects.new('tower', None))
    for o in parts:
        o.parent = root
    return root


def relay():
    """Antena repetidora (1×1): base de hormigón, celosía alta y parábola grande arriba."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = palette()
    parts = []
    P = parts.append
    P(prism('plinth', octa_pts(0.86, 0.2), 0.0, 0.06, M['steel'], 0.008))
    P(prism('base', octa_pts(0.76, 0.18), 0.06, 0.3, M['cream'], 0.01))
    P(prism('base_band', octa_pts(0.765, 0.181), 0.17, 0.22, M['team']))
    P(prism('base_cap', octa_pts(0.7, 0.17), 0.3, 0.34, M['steel'], 0.006))
    lattice(P, M, 0.34, 1.65, 0.24, 0.1, 5, r=0.012)
    P(prism('landing', octa_pts(0.42, 0.1), 0.9, 0.93, M['steel'], 0.004))
    # Parábola mirando arriba, algo inclinada hacia la cámara, con su trípode y el foco.
    tilt = Euler((math.radians(-28), 0, math.radians(-135)))
    P(dish_bowl(M, 0.62, 0.22, (0, 0, 1.62), tilt, M['dish']))
    axis = tilt.to_matrix() @ Vector((0, 0, 1))
    for k in range(3):
        a = k * 2.094
        rim = tilt.to_matrix() @ Vector((math.cos(a) * 0.4, math.sin(a) * 0.4, 0.16))
        P(strut('feed_leg', tuple(Vector((0, 0, 1.62)) + rim), tuple(Vector((0, 0, 1.62)) + axis * 0.5), 0.006, M['steel']))
    tip = Vector((0, 0, 1.62)) + axis * 0.5
    P(cyl('feed', tuple(tip), 0.035, 0.1, M['steel'], tilt, 10))
    root = link(bpy.data.objects.new('relay', None))
    for o in parts:
        o.parent = root
    return root


def industrial():
    """Paleta de los edificios industriales (depósito, central): hormigón gris y chapa con más óxido."""
    M = palette()
    M['cream'] = painted('concrete', (0.58, 0.56, 0.52), scale=1.0, wear=0.9)
    M['cream2'] = painted('concrete2', (0.5, 0.49, 0.46), scale=1.2, wear=0.9)
    M['tank'] = painted('tank', (0.62, 0.6, 0.55), scale=1.5, wear=1.1)
    return M


def hyperboloid(name, c, r_waist, z_waist, height, r_base, mat, segs=32, rings=14):
    """Torre de refrigeración: hiperboloide de revolución, abierta por arriba."""
    a = z_waist / math.sqrt(max((r_base / r_waist) ** 2 - 1, 1e-6))
    bm = bmesh.new()
    loops = []
    for k in range(rings + 1):
        z = height * k / rings
        r = r_waist * math.sqrt(1 + ((z - z_waist) / a) ** 2)
        loops.append([bm.verts.new((c[0] + r * math.cos(2 * math.pi * i / segs), c[1] + r * math.sin(2 * math.pi * i / segs), z)) for i in range(segs)])
    for k in range(rings):
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new([loops[k][i], loops[k][j], loops[k + 1][j], loops[k + 1][i]])
    o = mesh_obj(name, bm, mat)
    o.modifiers.new('s', 'SOLIDIFY').thickness = 0.03
    return o


def silo(P, M, x, y, r, h):
    P(cyl('silo', (x, y, h / 2), r, h, M['tank'], (0, 0, 0), 28))
    bpy.ops.mesh.primitive_cone_add(vertices=28, radius1=r, radius2=r * 0.25, depth=r * 0.45, location=(x, y, h + r * 0.225))
    o = bpy.context.active_object
    o.data.materials.append(M['tank'])
    P(o)
    P(cyl('silo_band', (x, y, h * 0.62), r + 0.006, h * 0.08, M['team'], (0, 0, 0), 28))
    for z in (h * 0.25, h * 0.85):
        P(cyl('silo_ring', (x, y, z), r + 0.01, 0.02, M['steel'], (0, 0, 0), 28))


def depot():
    """Depósito de metal (2×2): silos, nave de almacén, torre de procesado con cintas y vigas apiladas."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = industrial()
    parts = []
    P = parts.append
    P(box('slab', (0, 0, 0.025), (1.92, 1.92, 0.05), M['cream2'], 0, 0.01))
    for y in (-0.42, 0.06, 0.54):
        silo(P, M, -0.66, y, 0.21, 0.82)
    P(box('silo_walk', (-0.66, 0.06, 0.93), (0.1, 1.3, 0.03), M['steel'], 0, 0.0))
    # Nave de almacén delante, con el rótulo en la fachada larga.
    parts += module('shed', M, (0.2, -0.6, 0.0), 1.15, 0.6, 0.58, 'x', 4, ch=0.15)
    P(box('shed_door', (0.0, -0.902, 0.17), (0.3, 0.012, 0.3), M['dark'], 0, 0.0))
    P(box('shed_door2', (0.48, -0.902, 0.17), (0.24, 0.012, 0.3), M['dark'], 0, 0.0))
    P(text('A-セクター02', (0.22, -0.906, 0.43), face_rot(0, -1), 0.085, M['ink'], FONT_CJK))
    # Torre de procesado con dos cintas inclinadas (desde los silos y hacia la nave).
    P(box('mill', (0.08, 0.22, 0.45), (0.38, 0.38, 0.9), M['cream'], 0, 0.015))
    P(box('mill_top', (0.08, 0.22, 0.93), (0.42, 0.42, 0.06), M['steel'], 0, 0.01))
    P(box('mill_band', (0.08, 0.22, 0.6), (0.385, 0.385, 0.06), M['team'], 0, 0.0))
    for (p0, p1) in [((-0.5, 0.2, 0.75), (-0.12, 0.22, 0.6)), ((0.12, -0.02, 0.6), (0.2, -0.35, 0.45))]:
        a, b = Vector(p0), Vector(p1)
        d = b - a
        cv = box('conveyor', tuple((a + b) / 2), (0.1, d.length, 0.06), M['steel'], 0, 0.0)
        cv.rotation_euler = d.to_track_quat('Y', 'Z').to_euler()
        P(cv)
    # Patio a la derecha: vigas de acero apiladas bajo una marquesina.
    for (x, y) in [(0.55, 0.15), (0.75, 0.15), (0.55, 0.45), (0.75, 0.45)]:
        for k in range(3):
            P(box('beam', (x, y, 0.07 + k * 0.045), (0.14, 0.26, 0.04), M['rust_red'], 0, 0.003))
    for (x, y) in [(0.42, 0.0), (0.88, 0.0), (0.42, 0.62), (0.88, 0.62)]:
        P(cyl('post', (x, y, 0.3), 0.015, 0.6, M['steel'], (0, 0, 0), 6))
    P(box('canopy', (0.65, 0.31, 0.61), (0.56, 0.72, 0.025), M['steel'], 0, 0.004))
    root = link(bpy.data.objects.new('depot', None))
    for o in parts:
        o.parent = root
    return root


def plant():
    """Central (3×3, sobre una veta): dos torres de refrigeración, nave principal, bloques técnicos, chimeneas y tuberías."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = industrial()
    M['inside'] = flat('inside', (0.05, 0.05, 0.05), rough=0.9)
    parts = []
    P = parts.append
    P(box('slab', (0, 0, 0.03), (2.9, 2.9, 0.06), M['cream2'], 0, 0.01))
    # Torres de refrigeración al fondo.
    for (x, y, h) in [(-0.6, 0.55, 1.75), (0.45, 0.95, 1.6)]:
        P(hyperboloid('cooling', (x, y), 0.36, h * 0.72, h, 0.55, M['cream']))
        P(cyl('cooling_top', (x, y, h - 0.01), 0.37, 0.02, M['inside'], (0, 0, 0), 32))
        P(cyl('cooling_band', (x, y, h * 0.8), 0.385, 0.06, M['team'], (0, 0, 0), 32))
    # Nave principal delante, con su rótulo.
    parts += module('hall', M, (0.35, -0.85, 0.0), 1.7, 0.75, 0.72, 'x', 5, ch=0.2)
    for x in (-0.15, 0.3, 0.75):
        P(box('hall_door', (x, -1.231, 0.16), (0.22, 0.012, 0.28), M['dark'], 0, 0.0))
    P(text('中央電力センター', (0.35, -1.236, 0.52), face_rot(0, -1), 0.1, M['ink'], FONT_CJK))
    P(text('A-セクター01号炉', (0.35, -1.236, 0.4), face_rot(0, -1), 0.07, M['ink'], FONT_CJK))
    # Bloque técnico a la izquierda, transformadores y depósito esférico.
    P(box('block', (-0.95, -0.55, 0.42), (0.75, 0.7, 0.84), M['cream'], 0, 0.015))
    P(box('block_roof', (-0.95, -0.55, 0.86), (0.8, 0.75, 0.05), M['steel'], 0, 0.01))
    P(box('block_band', (-0.95, -0.55, 0.62), (0.755, 0.705, 0.06), M['team'], 0, 0.0))
    for k in range(3):
        P(box('vent', (-1.12 + k * 0.17, -0.55, 0.92), (0.12, 0.5, 0.06), M['steel'], 0, 0.004))
    for (x, y) in [(-1.2, 0.35), (-0.95, 0.35)]:
        P(box('transformer', (x, y, 0.17), (0.2, 0.26, 0.34), M['steel'], 0, 0.01))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.17, location=(1.15, -0.05, 0.3), segments=20, ring_count=10)
    o = bpy.context.active_object
    o.data.materials.append(M['tank'])
    P(o)
    P(cyl('sphere_leg', (1.15, -0.05, 0.08), 0.06, 0.16, M['steel'], (0, 0, 0), 10))
    # Chimeneas y planta de proceso a la derecha.
    for (x, y, h) in [(1.15, 0.65, 1.5), (1.0, 0.8, 1.3), (1.25, 0.95, 1.15)]:
        P(cyl('stack', (x, y, h / 2), 0.05, h, M['tank'], (0, 0, 0), 14))
        P(cyl('stack_band', (x, y, h - 0.08), 0.055, 0.06, M['team'], (0, 0, 0), 14))
    P(box('process', (0.95, 0.4, 0.3), (0.5, 0.45, 0.6), M['cream2'], 0, 0.01))
    # Tuberías que lo unen todo.
    for (p0, p1, r) in [((-0.6, 0.15, 0.35), (-0.6, -0.4, 0.35), 0.045), ((-0.55, -0.45, 0.5), (0.7, 0.4, 0.5), 0.04), ((0.45, 0.55, 0.3), (0.95, 0.4, 0.3), 0.04), ((-1.3, -1.0, 0.1), (1.3, -1.3, 0.1), 0.035)]:
        P(strut('pipe', p0, p1, r, M['steel'], 12))
    root = link(bpy.data.objects.new('plant', None))
    for o in parts:
        o.parent = root
    return root


BUILDERS = {'depot': depot, 'plant': plant, 'hq': hq, 'barracks': barracks, 'hangar': hangar, 'cradle': cradle, 'tower': tower, 'relay': relay}


def main():
    cam_rot = Euler((math.radians(60), 0, math.radians(45)))
    rm = cam_rot.to_matrix()
    right = rm @ Vector((1, 0, 0))
    ground_up = Vector((rm[0][1], rm[1][1], 0)).normalized()
    hor = (ground_up * 0.45 - Vector((right.x, right.y, 0)).normalized() * 0.2).normalized()
    sun_dir = -(hor * 0.65 + Vector((0, 0, 0.75))).normalized()
    path = os.path.join(rd.OUT, 'manifest.json')
    manifest = json.load(open(path)) if os.path.exists(path) else {}

    only = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for name, build in BUILDERS.items():
        if only and name not in only:
            continue
        TEAM.clear()
        root = build()
        saved = {}

        def team_prep():
            # Solo las zonas de equipo, en gris claro iluminado; el resto recorta (holdout) pero sigue tapando.
            hold = bpy.data.materials.new('holdout')
            hold.use_nodes = True
            nt = hold.node_tree
            nt.nodes.remove(nt.nodes['Principled BSDF'])
            h = nt.nodes.new('ShaderNodeHoldout')
            nt.links.new(h.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
            for o in bpy.context.scene.objects:
                if o.type in {'MESH', 'FONT'}:
                    saved[o.name] = [sl.material for sl in o.material_slots]
                    for sl in o.material_slots:
                        if sl.material not in TEAM:
                            sl.material = hold
                    if o.is_shadow_catcher:
                        o.hide_render = True

        def team_restore():
            for o in bpy.context.scene.objects:
                if o.name in saved:
                    for sl, m in zip(o.material_slots, saved[o.name]):
                        sl.material = m
                if o.is_shadow_catcher:
                    o.hide_render = False

        rd.shoot(root, name, None, 1, cam_rot, sun_dir, manifest, wide=1.0, spin=0.0, scale=1.0, passes=[('_team', team_prep, team_restore)], freestyle=True)
        json.dump(manifest, open(path, 'w'), indent=1)

if not os.environ.get('BUILDINGS_LIB'):
    main()
