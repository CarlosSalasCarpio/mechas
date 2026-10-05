"""
Renderiza la biblioteca de efectos del juego como sprites (todo raster, nada vectorial).

Uso: Blender -b --factory-startup -P art/render_fx.py -- [filtro]

- Explosión: bola de fuego volumétrica (ruido 4D animado dentro de una esfera) que se expande, se enfría
  y se vuelve humo; 16 fotogramas.
- Fuego en bucle (edificios dañados), 12 fotogramas con fundido cruzado para que no salte.
- Humo (4 variantes), fogonazos (3), resplandor, trazadora, onda de polvo, anillo de energía, restos (6),
  marcas de quemado (2), cohete.
- Misma cámara isométrica que el resto del arte. Salida: art/fx/<nombre>.png + manifest.json.
"""
import json, math, os, random, subprocess, sys

import bmesh, bpy
from mathutils import Euler, Vector

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'fx')
os.makedirs(OUT, exist_ok=True)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PX = 64 / math.sqrt(2) * 2  # px por casilla al doble de la escala del juego
CAM = Euler((math.radians(60), 0, math.radians(45)))
MANIFEST = os.path.join(OUT, 'manifest.json')
manifest = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {}


def reset(samples=48):
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
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.volume_bounces = 1
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.5, 0.55, 0.65, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.35
    sc.world = w
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4.0
    sun.rotation_euler = Euler((math.radians(40), math.radians(-25), math.radians(20)))
    sc.collection.objects.link(sun)
    return sc


def camera(sc, size_tiles, res, center_z=0.0):
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = size_tiles
    cam.rotation_euler = CAM
    fwd = CAM.to_matrix() @ Vector((0, 0, -1))
    cam.location = Vector((0, 0, center_z)) - fwd * 50
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    up = CAM.to_matrix() @ Vector((0, 1, 0))
    o = Vector((0, 0, 0)) - cam.location
    ay = 0.5 - o.dot(up) / size_tiles
    return 0.5, ay


def save(sc, name, anchor, scale):
    path = os.path.join(OUT, name + '.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    manifest[name] = {'file': name + '.png', 'w': sc.render.resolution_x, 'h': sc.render.resolution_y, 'ax': anchor[0], 'ay': round(anchor[1], 4)}
    print('FX', name)


# ------------------------------------------------------------------ nodos

class N:
    """Atajos para construir árboles de nodos."""

    def __init__(self, nt):
        self.nt = nt

    def node(self, kind, **inputs):
        n = self.nt.nodes.new(kind)
        for k, v in inputs.items():
            if k.startswith('_'):
                setattr(n, k[1:], v)
            else:
                self.set(n.inputs[k], v)
        return n

    def set(self, sock, v):
        if hasattr(v, 'is_output') or hasattr(v, 'links'):
            self.nt.links.new(v, sock)
        else:
            sock.default_value = v

    def math(self, op, a, b=0.0, clamp=False):
        n = self.nt.nodes.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        self.set(n.inputs[0], a)
        self.set(n.inputs[1], b)
        return n.outputs[0]


def volume_material(name, t, seed, fire=1.0, smoke_color=(0.07, 0.065, 0.06), rise=1.0, grow=1.15, base=0.2, density_k=8.0):
    """Bola de fuego/humo volumétrica en el instante t (0..1): lóbulos en coliflor, fuego en bolsas
    calientes del interior que se enfrían, y humo oscuro que sube."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    out = nt.nodes['Material Output']
    n = N(nt)
    co = n.node('ShaderNodeTexCoord').outputs['Object']
    shift = n.node('ShaderNodeVectorMath', _operation='SUBTRACT')
    n.set(shift.inputs[0], co)
    shift.inputs[1].default_value = (0, 0, rise * t * t)
    p = shift.outputs[0]
    big = n.node('ShaderNodeTexNoise', _noise_dimensions='4D', Scale=1.0, Detail=3.0, Roughness=0.55, W=seed * 7.3 + t * 0.9)
    n.set(big.inputs['Vector'], p)
    fine = n.node('ShaderNodeTexNoise', _noise_dimensions='4D', Scale=4.5, Detail=8.0, Roughness=0.65, W=seed * 3.1 + t * 2.2)
    n.set(fine.inputs['Vector'], p)
    rlen = n.node('ShaderNodeVectorMath', _operation='LENGTH')
    n.set(rlen.inputs[0], p)
    r = rlen.outputs['Value']
    R = base + grow * math.sqrt(t)
    # Borde en coliflor: lóbulos grandes + detalle fino.
    disp = n.math('ADD', n.math('MULTIPLY', n.math('SUBTRACT', big.outputs['Fac'], 0.5), 2.1), n.math('MULTIPLY', n.math('SUBTRACT', fine.outputs['Fac'], 0.5), 0.45))
    edge = n.math('ADD', r, disp)
    mask = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', n.math('SUBTRACT', edge, R - 0.12), 1 / 0.12), clamp=True)
    dens = n.math('MULTIPLY', mask, density_k * (1.2 - 0.55 * t))
    vol = n.node('ShaderNodeVolumePrincipled')
    n.set(vol.inputs['Density'], dens)
    # El hollín oscuro del principio se vuelve humo gris al enfriarse.
    g = min(1.0, t * 1.3) * 0.22 if fire > 0 else 0.0
    vol.inputs['Color'].default_value = (smoke_color[0] + g, smoke_color[1] + g, smoke_color[2] + g, 1)
    vol.inputs['Anisotropy'].default_value = 0.3
    if fire > 0:
        # Calor: en el interior (lejos del borde) y en las bolsas donde el ruido fino es alto.
        inner = n.math('SUBTRACT', 1.0, n.math('DIVIDE', r, max(0.05, R * 1.05)), clamp=True)
        pockets = n.math('POWER', fine.outputs['Fac'], 1.6)
        heat = n.math('MULTIPLY', n.math('MULTIPLY', n.math('MULTIPLY', mask, inner), pockets), fire * max(0.0, 1.0 - t * 1.45) * 6.0)
        n.set(vol.inputs['Emission Strength'], n.math('MULTIPLY', heat, 7.0))
        bb = n.node('ShaderNodeBlackbody')
        n.set(bb.inputs['Temperature'], n.math('ADD', 1000.0, n.math('MULTIPLY', heat, 650.0)))
        n.set(vol.inputs['Emission Color'], bb.outputs[0])
    nt.links.new(vol.outputs[0], out.inputs['Volume'])
    return m


def domain(mat, radius=1.0, z=1.0, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=(0, 0, z), segments=24, ring_count=12)
    o = bpy.context.active_object
    o.scale = scale
    o.data.materials.append(mat)
    return o


def emission_plane(name, build, size=(1, 1), loc=(0, 0, 0), rot=(0, 0, 0)):
    """Plano con un material emisivo y transparencia construido por `build(n, uv) -> (color, strength, alpha)`."""
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = (size[0], size[1], 1)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    n = N(nt)
    uv = n.node('ShaderNodeTexCoord').outputs['UV']
    color, strength, alpha = build(n, uv)
    em = n.node('ShaderNodeEmission')
    n.set(em.inputs['Color'], color)
    n.set(em.inputs['Strength'], strength)
    tr = n.node('ShaderNodeBsdfTransparent')
    mix = n.node('ShaderNodeMixShader')
    n.set(mix.inputs['Fac'], alpha)
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
    o.data.materials.append(m)
    return o


def facing_camera(o):
    """Orienta un plano (normal +z) hacia la cámara isométrica."""
    o.rotation_euler = CAM


def radial(n, uv, cx=0.5, cy=0.5):
    sep = n.node('ShaderNodeSeparateXYZ')
    n.set(sep.inputs[0], uv)
    dx = n.math('SUBTRACT', sep.outputs['X'], cx)
    dy = n.math('SUBTRACT', sep.outputs['Y'], cy)
    return n.math('SQRT', n.math('ADD', n.math('MULTIPLY', dx, dx), n.math('MULTIPLY', dy, dy))), dx, dy


def ramp(n, fac, stops):
    r = n.node('ShaderNodeValToRGB')
    n.set(r.inputs['Fac'], fac)
    els = r.color_ramp.elements
    while len(els) < len(stops):
        els.new(0.5)
    for e, (pos, col) in zip(els, stops):
        e.position = pos
        e.color = col
    return r


# ------------------------------------------------------------------ efectos

def explosion(name='explosion', frames=16, res=192, size=4.2, only=None):
    for f in (only or range(frames)):
        sc = reset(40)
        anchor = camera(sc, size, res, center_z=1.1)
        t = (f + 0.6) / frames
        # Dominio holgado: si no, su borde recorta los lóbulos y la explosión queda redonda.
        domain(volume_material('fire', t, seed=1), radius=1.9, z=1.0)
        save(sc, f'{name}_{f}', anchor, 1)


def smoke(variants=4, res=96, size=2.0):
    for v in range(variants):
        sc = reset(32)
        anchor = camera(sc, size, res, center_z=0.8)
        domain(volume_material('smoke', 0.55, seed=10 + v, fire=0, smoke_color=(0.55, 0.53, 0.5), rise=0.0, grow=0.45, base=0.25, density_k=6.0), radius=0.9, z=0.8)
        save(sc, f'smoke_{v}', (0.5, 0.5), 1)


def fire_loop(frames=12, res=96, size=1.6):
    total = frames + 4
    for f in range(total):
        sc = reset(32)
        anchor = camera(sc, size, res, center_z=0.55)
        m = bpy.data.materials.new('flame')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.remove(nt.nodes['Principled BSDF'])
        n = N(nt)
        co = n.node('ShaderNodeTexCoord').outputs['Object']
        sep = n.node('ShaderNodeSeparateXYZ')
        n.set(sep.inputs[0], co)
        # Llama: se estrecha hacia arriba; el ruido sube (W y desplazamiento en z).
        up = n.node('ShaderNodeVectorMath', _operation='SUBTRACT')
        n.set(up.inputs[0], co)
        up.inputs[1].default_value = (0, 0, f * 0.18)
        noise = n.node('ShaderNodeTexNoise', _noise_dimensions='4D', Scale=3.0, Detail=6.0, Roughness=0.6, W=f * 0.23)
        n.set(noise.inputs['Vector'], up.outputs[0])
        z = sep.outputs['Z']
        rr = n.math('SQRT', n.math('ADD', n.math('MULTIPLY', sep.outputs['X'], sep.outputs['X']), n.math('MULTIPLY', sep.outputs['Y'], sep.outputs['Y'])))
        width = n.math('MULTIPLY', n.math('SUBTRACT', 1.0, z, clamp=True), 0.45)
        body = n.math('SUBTRACT', width, n.math('ADD', rr, n.math('MULTIPLY', n.math('SUBTRACT', noise.outputs['Fac'], 0.5), 0.5)))
        mask = n.math('MULTIPLY', body, 8.0, clamp=True)
        heat = n.math('MULTIPLY', mask, n.math('SUBTRACT', 1.2, z))
        vol = n.node('ShaderNodeVolumePrincipled')
        n.set(vol.inputs['Density'], n.math('MULTIPLY', mask, 2.0))
        vol.inputs['Color'].default_value = (0.1, 0.08, 0.06, 1)
        n.set(vol.inputs['Emission Strength'], n.math('MULTIPLY', heat, 0.45))
        bb = n.node('ShaderNodeBlackbody')
        n.set(bb.inputs['Temperature'], n.math('ADD', 900.0, n.math('MULTIPLY', heat, 800.0)))
        n.set(vol.inputs['Emission Color'], bb.outputs[0])
        nt.links.new(vol.outputs[0], nt.nodes['Material Output'].inputs['Volume'])
        bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1.2, location=(0, 0, 0.6))
        bpy.context.active_object.data.materials.append(m)
        save(sc, f'fireraw_{f}', anchor, 1)
    # Bucle: los primeros 4 fotogramas se funden con los 4 extra del final.
    for f in range(frames):
        src = os.path.join(OUT, f'fireraw_{f}.png')
        dst = os.path.join(OUT, f'fire_{f}.png')
        if f < 4:
            w = f / 4
            subprocess.run(['magick', os.path.join(OUT, f'fireraw_{f + frames}.png'), src, '-compose', 'blend', '-define', f'compose:args={int(w * 100)}', '-composite', dst], check=True)
        else:
            os.replace(src, dst) if os.path.exists(src) else None
        manifest[f'fire_{f}'] = {**manifest[f'fireraw_{f}'], 'file': f'fire_{f}.png'}
    for f in range(total):
        manifest.pop(f'fireraw_{f}', None)
        p = os.path.join(OUT, f'fireraw_{f}.png')
        if os.path.exists(p):
            os.remove(p)


def muzzle(variants=3, res=64):
    for v in range(variants):
        sc = reset(16)
        camera(sc, 1.0, res)
        rng = random.Random(v)

        def build(n, uv):
            d, dx, dy = radial(n, uv)
            ang = n.node('ShaderNodeMath', _operation='ARCTAN2')
            n.set(ang.inputs[0], dy)
            n.set(ang.inputs[1], dx)
            spikes = n.math('POWER', n.math('ABSOLUTE', n.math('SINE', n.math('MULTIPLY', ang.outputs[0], rng.choice((3, 4, 5))))), 6.0)
            reach = n.math('ADD', 0.12, n.math('MULTIPLY', spikes, 0.33))
            a = n.math('SUBTRACT', 1.0, n.math('DIVIDE', d, reach), clamp=True)
            col = ramp(n, a, [(0.0, (1.0, 0.35, 0.05, 1)), (0.6, (1.0, 0.75, 0.3, 1)), (1.0, (1.0, 0.98, 0.9, 1))])
            return col.outputs[0], 1.6, n.math('POWER', a, 0.7)

        o = emission_plane('muzzle', build, size=(1, 1))
        facing_camera(o)
        save(sc, f'muzzle_{v}', (0.5, 0.5), 1)


def glow(res=64):
    sc = reset(16)
    camera(sc, 1.0, res)

    def build(n, uv):
        d, _, _ = radial(n, uv)
        a = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', d, 2.0), clamp=True)
        col = ramp(n, a, [(0.0, (1.0, 0.5, 0.15, 1)), (0.7, (1.0, 0.85, 0.55, 1)), (1.0, (1, 1, 1, 1))])
        return col.outputs[0], 1.3, n.math('POWER', a, 2.2)

    facing_camera(emission_plane('glow', build))
    save(sc, 'glow', (0.5, 0.5), 1)


def tracer(res=64):
    sc = reset(16)
    camera(sc, 1.0, res)

    def build(n, uv):
        sep = n.node('ShaderNodeSeparateXYZ')
        n.set(sep.inputs[0], uv)
        across = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', n.math('ABSOLUTE', n.math('SUBTRACT', sep.outputs['Y'], 0.5)), 2.0), clamp=True)
        along = n.math('POWER', sep.outputs['X'], 0.6)
        a = n.math('MULTIPLY', n.math('POWER', across, 3.0), along)
        col = ramp(n, a, [(0.0, (1.0, 0.55, 0.15, 1)), (1.0, (1.0, 0.97, 0.85, 1))])
        return col.outputs[0], 1.4, a

    facing_camera(emission_plane('tracer', build))
    save(sc, 'tracer', (0.5, 0.5), 1)


def ground_decal(name, build, res=128, size=2.0):
    """Algo pintado sobre el suelo (se ve en isométrico): marcas de quemado y ondas."""
    sc = reset(16)
    anchor = camera(sc, size, res)
    bpy.ops.mesh.primitive_plane_add(size=1.9, location=(0, 0, 0.001))
    o = bpy.context.active_object
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    n = N(nt)
    uv = n.node('ShaderNodeTexCoord').outputs['UV']
    shader, alpha = build(n, uv)
    tr = n.node('ShaderNodeBsdfTransparent')
    mix = n.node('ShaderNodeMixShader')
    n.set(mix.inputs['Fac'], alpha)
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(shader, mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
    o.data.materials.append(m)
    save(sc, name, anchor, 1)


def scorch(variants=2):
    for v in range(variants):
        def build(n, uv, v=v):
            d, _, _ = radial(n, uv)
            noise = n.node('ShaderNodeTexNoise', _noise_dimensions='4D', Scale=6.0, Detail=8.0, Roughness=0.7, W=v * 3.1)
            n.set(noise.inputs['Vector'], uv)
            edge = n.math('ADD', d, n.math('MULTIPLY', n.math('SUBTRACT', noise.outputs['Fac'], 0.5), 0.35))
            a = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', n.math('SUBTRACT', edge, 0.22), 3.0), clamp=True)
            bs = n.node('ShaderNodeBsdfDiffuse')
            col = ramp(n, n.math('MULTIPLY', noise.outputs['Fac'], 1.0), [(0.3, (0.02, 0.018, 0.015, 1)), (0.7, (0.09, 0.07, 0.05, 1))])
            n.set(bs.inputs['Color'], col.outputs[0])
            return bs.outputs[0], n.math('POWER', a, 0.6)
        ground_decal(f'scorch_{v}', build)


def shockwave():
    def build(n, uv):
        d, _, _ = radial(n, uv)
        noise = n.node('ShaderNodeTexNoise', Scale=10.0, Detail=6.0, Roughness=0.6)
        n.set(noise.inputs['Vector'], uv)
        band = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', n.math('ABSOLUTE', n.math('SUBTRACT', d, 0.4)), 9.0), clamp=True)
        a = n.math('MULTIPLY', band, n.math('ADD', 0.35, noise.outputs['Fac']), clamp=True)
        bs = n.node('ShaderNodeBsdfDiffuse')
        bs.inputs['Color'].default_value = (0.55, 0.47, 0.36, 1)
        return bs.outputs[0], a
    ground_decal('shockwave', build, res=192, size=2.0)


def energy_ring():
    def build(n, uv):
        d, _, _ = radial(n, uv)
        band = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', n.math('ABSOLUTE', n.math('SUBTRACT', d, 0.42)), 14.0), clamp=True)
        em = n.node('ShaderNodeEmission')
        em.inputs['Color'].default_value = (1, 1, 1, 1)
        em.inputs['Strength'].default_value = 3.0
        return em.outputs[0], n.math('POWER', band, 1.5)
    ground_decal('energyring', build, res=160, size=2.0)


def debris(variants=6, res=32):
    for v in range(variants):
        sc = reset(24)
        anchor = camera(sc, 0.3, res, center_z=0.05)
        rng = random.Random(v)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.08, location=(0, 0, 0.06))
        o = bpy.context.active_object
        for vert in o.data.vertices:
            vert.co *= 0.6 + rng.random() * 0.8
        o.rotation_euler = (rng.random() * 3, rng.random() * 3, rng.random() * 3)
        m = bpy.data.materials.new('chunk')
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        metal = v % 2 == 0
        b.inputs['Base Color'].default_value = (0.35, 0.33, 0.32, 1) if metal else (0.3, 0.24, 0.17, 1)
        b.inputs['Metallic'].default_value = 0.8 if metal else 0.0
        b.inputs['Roughness'].default_value = 0.4 if metal else 0.9
        o.data.materials.append(m)
        save(sc, f'debris_{v}', (0.5, 0.5), 1)


def rocket(res=128):
    """Misil esbelto: ojiva ojival roja, cuerpo de acero oscuro con franja de aviso, aletas en flecha y tobera."""
    sc = reset(48)
    camera(sc, 0.75, res)

    def pmat(name, color, metallic=0.3, rough=0.4):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*color, 1)
        b.inputs['Metallic'].default_value = metallic
        b.inputs['Roughness'].default_value = rough
        return m

    body = pmat('body', (0.22, 0.23, 0.25), 0.6, 0.35)
    tip = pmat('tip', (0.75, 0.08, 0.05), 0.2, 0.3)
    band = pmat('band', (0.95, 0.7, 0.1), 0.1, 0.4)
    fin = pmat('fin', (0.12, 0.12, 0.13), 0.5, 0.4)
    noz = pmat('nozzle', (0.08, 0.07, 0.07), 0.8, 0.5)
    parts = []
    R = 0.022
    # Cuerpo a lo largo de +x (luego se gira para que apunte a la derecha de la pantalla).
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=R, depth=0.34, location=(0.0, 0, 0), rotation=(0, math.pi / 2, 0))
    parts.append((bpy.context.active_object, body))
    # Ojiva: cono con perfil curvo (anillos de radio decreciente).
    prev = 0.17
    for k in range(6):
        r0 = R * math.cos(math.pi / 2 * k / 6)
        r1 = R * math.cos(math.pi / 2 * (k + 1) / 6)
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=r0, radius2=r1, depth=0.022, location=(prev + 0.011, 0, 0), rotation=(0, math.pi / 2, 0))
        parts.append((bpy.context.active_object, tip))
        prev += 0.022
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=R * 1.04, depth=0.03, location=(0.09, 0, 0), rotation=(0, math.pi / 2, 0))
    parts.append((bpy.context.active_object, band))
    # Tobera.
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=R * 0.75, radius2=R * 1.05, depth=0.035, location=(-0.187, 0, 0), rotation=(0, math.pi / 2, 0))
    parts.append((bpy.context.active_object, noz))
    # Cuatro aletas en flecha.
    for k in range(4):
        bm = bmesh.new()
        pts = [(-0.165, 0.0), (-0.1, 0.0), (-0.14, 0.055), (-0.17, 0.055)]
        vs = [bm.verts.new((x, y + R * 0.9, 0)) for x, y in pts]
        bm.faces.new(vs)
        me = bpy.data.meshes.new('fin')
        bm.to_mesh(me)
        o = bpy.data.objects.new('fin', me)
        sc.collection.objects.link(o)
        o.modifiers.new('s', 'SOLIDIFY').thickness = 0.004
        o.rotation_euler = (k * math.pi / 2 + math.pi / 4, 0, 0)
        parts.append((o, fin))
    root = bpy.data.objects.new('root', None)
    sc.collection.objects.link(root)
    for o, m in parts:
        o.data.materials.append(m)
        o.parent = root
    root.rotation_euler = (0, 0, math.pi / 4)
    save(sc, 'rocket', (0.5, 0.5), 1)


JOBS = {'explosion': explosion, 'smoke': smoke, 'fire': fire_loop, 'muzzle': muzzle, 'glow': glow, 'tracer': tracer,
        'scorch': scorch, 'shockwave': shockwave, 'energyring': energy_ring, 'debris': debris, 'rocket': rocket}
for name, job in JOBS.items():
    if ARGS and name not in ARGS:
        continue
    job()
    json.dump(manifest, open(MANIFEST, 'w'), indent=1)
