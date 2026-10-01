"""
Modela, anima y renderiza las unidades como sprites en 8 direcciones (por ahora, el mecha y su variante
de artillería), según art/concepts/mech.png.

Uso: Blender -b --factory-startup -P art/render_units.py -- [mech|artillery] [dir]

- Piezas rígidas (placas de blindaje) colgadas de una jerarquía de articulaciones (empties): se animan como
  un robot, sin deformar la malla.
- Animaciones: reposo (idle, 6 fotogramas en bucle), caminar (walk, 8) y disparar (fire, 4).
- Dirección d (0..7): la unidad mira hacia el ángulo d·45° de la pantalla (0 = derecha, 2 = abajo).
- Color de equipo: las franjas se pintan de azul puro y luego se separan por color en una máscara gris
  (<nombre>_team), que el juego tiñe con el color del jugador.
- Salida: art/units/<unidad>/<unidad>_<anim>_<d>_<f>.png (+ _team) y manifest.json con el anclaje (los pies).
"""
import json, math, os, sys

import bmesh, bpy
import numpy as np

os.environ['DECOR_LIB'] = '1'
os.environ['BUILDINGS_LIB'] = '1'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_buildings as rb  # noqa: E402  (materiales y utilidades)
import render_decor as rd  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ANIMS = {'idle': 6, 'walk': 8, 'fire': 4}
# Encuadre de cada unidad (se fija en render_unit): lado en casillas, píxeles por casilla y resolución.
FRAME = 3.4
SCALE = rd.K
RES = round(FRAME * SCALE)
CENTER_Z = 0.95


# ------------------------------------------------------------------ modelo

def tbox(name, bot, top, h, mat, parent, off=(0, 0, 0), down=True, bevel=0.008):
    """Caja troncocónica: base `bot` (x, y), tapa `top`, alto h. Cuelga hacia abajo desde la articulación si `down`."""
    bm = bmesh.new()
    z0, z1 = (-h, 0) if down else (0, h)
    zb, zt = (z0, z1)
    (bx, by), (tx, ty) = (bot, top) if not down else (bot, top)
    vb = [bm.verts.new((sx * bx / 2, sy * by / 2, zb)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    vt = [bm.verts.new((sx * tx / 2, sy * ty / 2, zt)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    bm.faces.new(list(reversed(vb)))
    bm.faces.new(vt)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([vb[i], vb[j], vt[j], vt[i]])
    o = rb.mesh_obj(name, bm, mat, bevel)
    o.parent = parent
    o.location = off
    return o


def joint(name, parent, loc):
    e = bpy.data.objects.new(name, None)
    rb.link(e)
    e.parent = parent
    e.location = loc
    e.rotation_mode = 'XYZ'
    return e


def build(weapon):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rb.TEAM.clear()
    M = {
        'armor': rb.painted('armor', (0.86, 0.78, 0.6), scale=3.0, wear=0.35),
        'frame': rb.painted('frame', (0.07, 0.075, 0.085), scale=3.0, wear=0.3),
        'team': rb.flat('team', (0.0, 0.12, 1.0), rough=0.45),
        'visor': rb.flat('visor', (0.5, 1.0, 0.6), emit=(0.6, 1.0, 0.65), strength=5.0),
        'glow': rb.flat('glow', (0.7, 1.0, 0.7), emit=(0.75, 1.0, 0.7), strength=3.0),
        'gun': rb.painted('gun', (0.2, 0.2, 0.22), scale=3.0, wear=0.5),
    }
    A, F, T = M['armor'], M['frame'], M['team']
    J = {}
    J['root'] = joint('root', None, (0, 0, 0))
    J['hips'] = joint('hips', J['root'], (0, 0, 1.0))
    J['chest'] = joint('chest', J['hips'], (0, 0, 0.12))
    J['neck'] = joint('neck', J['chest'], (0, 0, 0.38))
    J['head'] = joint('head', J['neck'], (0, 0, 0.05))
    # Pelvis, cintura y torso en V.
    tbox('pelvis', (0.2, 0.12), (0.17, 0.11), 0.12, F, J['hips'])
    tbox('belt', (0.22, 0.13), (0.22, 0.13), 0.04, A, J['hips'], (0, 0, -0.06))
    # Cintura y abdomen oscuros, segmentados, uniendo pelvis y pecho.
    tbox('waist', (0.1, 0.08), (0.12, 0.09), 0.16, F, J['chest'], (0, 0, 0.12))
    for k in range(2):
        tbox('abs', (0.12, 0.1), (0.13, 0.1), 0.035, F, J['chest'], (0, 0.005, 0.02 + k * 0.05), down=False)
    tbox('torso', (0.16, 0.13), (0.34, 0.17), 0.28, A, J['chest'], (0, 0, 0.1), down=False)
    tbox('chestplate', (0.1, 0.02), (0.26, 0.02), 0.16, A, J['chest'], (0, 0.09, 0.2), down=False)
    tbox('sternum', (0.03, 0.02), (0.05, 0.02), 0.14, F, J['chest'], (0, 0.1, 0.2), down=False)
    for sx in (-1, 1):
        o = tbox('chevron', (0.05, 0.015), (0.09, 0.015), 0.035, T, J['chest'], (sx * 0.075, 0.1, 0.3), down=False)
        o.rotation_euler = (0, sx * 0.5, 0)
    tbox('collar', (0.2, 0.15), (0.14, 0.12), 0.04, F, J['chest'], (0, 0, 0.38), down=False)
    # Espina con líneas de energía (el toque místico).
    tbox('spine', (0.05, 0.03), (0.05, 0.03), 0.32, F, J['chest'], (0, -0.09, 0.06), down=False)
    for k in range(4):
        tbox('spine_glow', (0.02, 0.012), (0.02, 0.012), 0.04, M['glow'], J['chest'], (0, -0.106, 0.1 + k * 0.07), down=False)
    # Cabeza pequeña con visor y cresta larga hacia atrás.
    tbox('neckpiece', (0.05, 0.05), (0.05, 0.05), 0.06, F, J['neck'], down=False)
    tbox('helmet', (0.08, 0.1), (0.07, 0.09), 0.1, A, J['head'], (0, 0, 0.02), down=False)
    tbox('jaw', (0.06, 0.05), (0.07, 0.06), 0.04, F, J['head'], (0, 0.025, 0.0), down=False)
    tbox('visor', (0.06, 0.01), (0.06, 0.01), 0.015, M['visor'], J['head'], (0, 0.052, 0.07), down=False)
    horn = tbox('horn', (0.03, 0.05), (0.004, 0.012), 0.34, A, J['head'], (0, 0.02, 0.1), down=False)
    horn.rotation_euler = (-0.38, 0, 0)
    for sx in (-1, 1):
        s = 'L' if sx > 0 else 'R'
        # Brazo: hombrera grande con franja, brazo y antebrazo largos, mano oscura.
        J['sh' + s] = joint('sh' + s, J['chest'], (sx * 0.21, 0, 0.32))
        tbox('pauldron', (0.15, 0.16), (0.13, 0.15), 0.13, A, J['sh' + s], (sx * 0.03, 0, 0.05))
        tbox('pauldron_stripe', (0.153, 0.163), (0.153, 0.163), 0.03, T, J['sh' + s], (sx * 0.03, 0, -0.01))
        tbox('upperarm', (0.07, 0.07), (0.08, 0.08), 0.3, A, J['sh' + s], (sx * 0.02, 0, -0.04))
        J['el' + s] = joint('el' + s, J['sh' + s], (sx * 0.02, 0, -0.34))
        tbox('elbow', (0.06, 0.06), (0.06, 0.06), 0.05, F, J['el' + s], (0, 0, 0.025))
        tbox('forearm', (0.065, 0.07), (0.085, 0.09), 0.3, A, J['el' + s], (0, 0, -0.02))
        J['hand' + s] = joint('hand' + s, J['el' + s], (0, 0, -0.34))
        tbox('hand', (0.05, 0.06), (0.055, 0.05), 0.08, F, J['hand' + s])
        # Pierna: muslo, rodilla oscura, espinillera con franja y pie.
        J['hip' + s] = joint('hip' + s, J['hips'], (sx * 0.075, 0, -0.04))
        tbox('thigh', (0.09, 0.1), (0.12, 0.12), 0.42, A, J['hip' + s])
        tbox('thigh_inner', (0.05, 0.06), (0.06, 0.07), 0.3, F, J['hip' + s], (-sx * 0.04, 0, -0.06))
        J['knee' + s] = joint('knee' + s, J['hip' + s], (0, 0, -0.44))
        tbox('kneepad', (0.07, 0.04), (0.07, 0.04), 0.07, F, J['knee' + s], (0, 0.05, 0.035))
        tbox('shin', (0.07, 0.08), (0.11, 0.12), 0.38, A, J['knee' + s], (0, 0, -0.01))
        tbox('calf', (0.06, 0.05), (0.08, 0.06), 0.22, F, J['knee' + s], (0, -0.05, -0.05))
        tbox('shin_stripe', (0.02, 0.012), (0.03, 0.012), 0.22, T, J['knee' + s], (0, 0.052, -0.06))
        J['ankle' + s] = joint('ankle' + s, J['knee' + s], (0, 0, -0.42))
        tbox('foot', (0.1, 0.2), (0.08, 0.14), 0.07, F, J['ankle' + s], (0, 0.03, -0.0))
        tbox('toecap', (0.1, 0.08), (0.08, 0.06), 0.05, A, J['ankle' + s], (0, 0.11, -0.02))
    if weapon == 'rifle':
        # Rifle largo y fino en la mano derecha, apuntando hacia delante.
        J['gun'] = joint('gun', J['handR'], (0, 0, -0.05))
        tbox('rifle', (0.035, 0.75), (0.035, 0.75), 0.05, M['gun'], J['gun'], (0, 0.18, 0.025))
        tbox('rifle_stock', (0.04, 0.12), (0.04, 0.12), 0.08, M['gun'], J['gun'], (0, -0.2, 0.0))
        tbox('rifle_stripe', (0.037, 0.1), (0.037, 0.1), 0.02, T, J['gun'], (0, 0.15, 0.03))
        J['muzzle'] = joint('muzzle', J['gun'], (0, 0.55, 0))
    else:
        # Mortero largo sobre el hombro derecho y cajón de munición a la espalda.
        J['gun'] = joint('gun', J['chest'], (-0.15, -0.02, 0.42))
        tbox('mortar', (0.075, 0.075), (0.065, 0.065), 0.62, M['gun'], J['gun'], down=False)
        tbox('mortar_band', (0.08, 0.08), (0.08, 0.08), 0.05, T, J['gun'], (0, 0, 0.3), down=False)
        tbox('mortar_base', (0.12, 0.12), (0.1, 0.1), 0.1, F, J['gun'], (0, 0, -0.04), down=False)
        tbox('ammo', (0.18, 0.1), (0.18, 0.1), 0.2, F, J['chest'], (0.06, -0.14, 0.12), down=False)
        J['gun'].rotation_euler = (0.35, 0, 0)
    return J


# ------------------------------------------------------------------ poses

def pose(J, anim, f, weapon, hz=1.0, amp=1.0):
    for k, e in J.items():
        if k not in ('root', 'gun'):
            e.rotation_euler = (0, 0, 0)
    J['hips'].location = (0, 0, hz)
    n = ANIMS[anim]
    p = 2 * math.pi * f / n
    # Postura base: brazos algo separados, hombros caídos, cabeza levemente inclinada (solemne).
    J['shL'].rotation_euler = (0.05, -0.12, 0)
    J['shR'].rotation_euler = (0.05, 0.12, 0)
    J['elL'].rotation_euler = (0.15, 0, 0)
    J['elR'].rotation_euler = (0.25, 0, 0)
    J['neck'].rotation_euler = (0.12, 0, 0)
    if weapon == 'rifle':
        J['gun'].rotation_euler = (-0.55, 0, 0)
    if weapon == 'claws':
        J['shL'].rotation_euler = (0.05, -0.22, 0)
        J['shR'].rotation_euler = (0.05, 0.22, 0)
    if anim == 'idle':
        J['chest'].rotation_euler = (0.03 * math.sin(p), 0, 0)
        J['head'].rotation_euler = (0, 0, 0.2 * math.sin(p))
        J['shL'].rotation_euler = (0.05 + 0.03 * math.sin(p), -0.12, 0)
        J['hips'].location = (0, 0, hz + 0.008 * amp * math.sin(p))
    elif anim == 'walk':
        s, c = math.sin(p), math.cos(p)
        J['hipL'].rotation_euler = (0.42 * s, 0, 0)
        J['hipR'].rotation_euler = (-0.42 * s, 0, 0)
        J['kneeL'].rotation_euler = (-(0.12 + 0.55 * max(0.0, -c)), 0, 0)
        J['kneeR'].rotation_euler = (-(0.12 + 0.55 * max(0.0, c)), 0, 0)
        J['ankleL'].rotation_euler = (0.2 * max(0.0, -c) - 0.1 * s, 0, 0)
        J['ankleR'].rotation_euler = (0.2 * max(0.0, c) + 0.1 * s, 0, 0)
        J['shL'].rotation_euler = (-0.32 * s, -0.12, 0)
        J['shR'].rotation_euler = (0.15 * s, 0.12, 0)
        J['chest'].rotation_euler = (0.06, 0, 0.08 * s)
        J['hips'].location = (0, 0, hz - 0.02 * amp + 0.03 * amp * abs(c))
    elif anim == 'fire':
        recoil = [0.0, 0.0, 1.0, 0.45][f]
        if weapon == 'claws':
            # Golpe aplastante: alza el brazo derecho y lo descarga.
            up_ = [1.0, 1.0, 0.0, 0.25][f]
            J['shR'].rotation_euler = (-2.6 * up_ + 0.9 * (1 - up_), 0.25, 0)
            J['elR'].rotation_euler = (0.6 * up_, 0, 0)
            J['chest'].rotation_euler = (-0.12 * up_ + 0.18 * (1 - up_), 0, -0.2 * up_)
            J['hips'].location = (0, 0, hz - 0.1 * (1 - up_))
            for s_ in ('L', 'R'):
                J['hip' + s_].rotation_euler = (0.2 * (1 - up_), 0, 0)
                J['knee' + s_].rotation_euler = (-0.3 * (1 - up_), 0, 0)
        elif weapon == 'rifle':
            # Apuntar: brazo derecho al frente, el izquierdo sujetando el cañón.
            J['shR'].rotation_euler = (1.35 - 0.15 * recoil, 0.25, 0)
            J['elR'].rotation_euler = (0.2, 0, 0)
            J['shL'].rotation_euler = (1.2, -0.55, 0)
            J['elL'].rotation_euler = (0.45, 0, 0)
            J['gun'].rotation_euler = (-1.55 + 0.15 * recoil, 0, 0)
            J['chest'].rotation_euler = (-0.06 * recoil, 0, -0.15)
            J['head'].rotation_euler = (0.1, 0, -0.1)
        else:
            # Mortero: se agacha y el tubo retrocede con el disparo.
            J['hips'].location = (0, 0, 0.95 - 0.04 * recoil)
            for s in ('L', 'R'):
                J['hip' + s].rotation_euler = (0.25, 0, 0)
                J['knee' + s].rotation_euler = (-0.45, 0, 0)
                J['ankle' + s].rotation_euler = (0.2, 0, 0)
            J['chest'].rotation_euler = (0.12 - 0.08 * recoil, 0, 0)
            J['gun'].rotation_euler = (0.35 - 0.1 * recoil, 0, 0)
    bpy.context.view_layer.update()


# ------------------------------------------------------------------ coloso: titán humanoide

def build_titan():
    """Titán (art/concepts/colossus.png): humanoide macizo, corona de tres cuernos, reactor en el pecho y garras."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rb.TEAM.clear()
    M = {
        'armor': rb.painted('armor', (0.82, 0.74, 0.56), scale=1.5, wear=0.6),
        'frame': rb.painted('frame', (0.07, 0.075, 0.085), scale=1.5, wear=0.3),
        'team': rb.flat('team', (0.0, 0.12, 1.0), rough=0.45),
        'core': rb.flat('core', (1.0, 0.85, 0.5), emit=(1.0, 0.8, 0.45), strength=12.0),
        'visor': rb.flat('visor', (1.0, 0.6, 0.3), emit=(1.0, 0.55, 0.2), strength=5.0),
        'claw': rb.painted('claw', (0.15, 0.15, 0.17), scale=2.0, wear=0.4),
    }
    A, F, T = M['armor'], M['frame'], M['team']
    J = {}
    J['root'] = joint('root', None, (0, 0, 0))
    J['hips'] = joint('hips', J['root'], (0, 0, 2.0))
    J['chest'] = joint('chest', J['hips'], (0, 0, 0.25))
    J['neck'] = joint('neck', J['chest'], (0, 0, 1.15))
    J['head'] = joint('head', J['neck'], (0, 0, 0.05))
    tbox('pelvis', (0.62, 0.4), (0.56, 0.36), 0.32, F, J['hips'])
    tbox('belt', (0.72, 0.46), (0.72, 0.46), 0.12, A, J['hips'], (0, 0, -0.1))
    tbox('codpiece', (0.22, 0.08), (0.3, 0.08), 0.3, A, J['hips'], (0, 0.22, -0.12))
    tbox('waist', (0.4, 0.3), (0.5, 0.34), 0.35, F, J['chest'], (0, 0, 0.32))
    tbox('torso', (0.7, 0.5), (1.25, 0.62), 0.85, A, J['chest'], (0, 0, 0.3), down=False)
    tbox('chestplate', (0.6, 0.05), (1.0, 0.05), 0.55, A, J['chest'], (0, 0.32, 0.55), down=False)
    tbox('core_ring', (0.36, 0.05), (0.36, 0.05), 0.36, F, J['chest'], (0, 0.35, 0.7), down=False)
    tbox('core', (0.24, 0.04), (0.24, 0.04), 0.24, M['core'], J['chest'], (0, 0.38, 0.76), down=False)
    for sx in (-1, 1):
        tbox('chest_stripe', (0.2, 0.03), (0.26, 0.03), 0.07, T, J['chest'], (sx * 0.34, 0.34, 0.95), down=False)
    tbox('backpack', (0.8, 0.3), (0.7, 0.3), 0.7, F, J['chest'], (0, -0.38, 0.45), down=False)
    tbox('collar', (0.6, 0.45), (0.4, 0.34), 0.12, F, J['chest'], (0, 0, 1.12), down=False)
    tbox('helmet', (0.26, 0.3), (0.22, 0.26), 0.3, A, J['head'], (0, 0.02, 0.0), down=False)
    tbox('visor', (0.2, 0.02), (0.2, 0.02), 0.04, M['visor'], J['head'], (0, 0.17, 0.13), down=False)
    for hx, tilt, h in ((0, -0.15, 0.85), (-0.14, -0.55, 0.65), (0.14, -0.55, 0.65)):
        o = tbox('horn', (0.12, 0.16), (0.015, 0.03), h, A, J['head'], (hx, 0.0, 0.26), down=False)
        o.rotation_euler = (-0.25, tilt * (1 if hx >= 0 else -1) if hx else 0, 0)
    for sx in (-1, 1):
        s = 'L' if sx > 0 else 'R'
        J['sh' + s] = joint('sh' + s, J['chest'], (sx * 0.78, 0, 0.95))
        tbox('pauldron', (0.55, 0.6), (0.5, 0.55), 0.45, A, J['sh' + s], (sx * 0.08, 0, 0.2))
        tbox('pauldron_stripe', (0.553, 0.603), (0.553, 0.603), 0.08, T, J['sh' + s], (sx * 0.08, 0, -0.1))
        tbox('upperarm', (0.28, 0.3), (0.32, 0.34), 0.7, F, J['sh' + s], (sx * 0.05, 0, -0.15))
        tbox('bicep_plate', (0.3, 0.32), (0.34, 0.36), 0.45, A, J['sh' + s], (sx * 0.06, 0.02, -0.25))
        J['el' + s] = joint('el' + s, J['sh' + s], (sx * 0.05, 0, -0.85))
        tbox('forearm', (0.32, 0.36), (0.42, 0.44), 0.75, A, J['el' + s], (0, 0, 0.0))
        tbox('forearm_stripe', (0.425, 0.445), (0.425, 0.445), 0.08, T, J['el' + s], (0, 0, -0.2))
        J['hand' + s] = joint('hand' + s, J['el' + s], (0, 0, -0.8))
        tbox('palm', (0.3, 0.3), (0.3, 0.3), 0.2, F, J['hand' + s])
        for k in range(4):
            o = tbox('claw', (0.06, 0.06), (0.02, 0.02), 0.35, M['claw'], J['hand' + s], (-0.11 + k * 0.075, 0.08, -0.18))
            o.rotation_euler = (0.35, 0, 0)
        J['hip' + s] = joint('hip' + s, J['hips'], (sx * 0.3, 0, -0.18))
        tbox('thigh', (0.36, 0.4), (0.46, 0.48), 0.85, A, J['hip' + s])
        J['knee' + s] = joint('knee' + s, J['hip' + s], (0, 0, -0.88))
        tbox('kneepad', (0.3, 0.12), (0.3, 0.12), 0.26, F, J['knee' + s], (0, 0.22, 0.12))
        tbox('shin', (0.36, 0.4), (0.5, 0.52), 0.82, A, J['knee' + s], (0, 0, -0.02))
        J['ankle' + s] = joint('ankle' + s, J['knee' + s], (0, 0, -0.88))
        tbox('foot', (0.45, 0.7), (0.38, 0.5), 0.18, F, J['ankle' + s], (0, 0.1, 0.06))
    return J


def pose_titan(J, anim, f):
    pose(J, anim, f, 'claws', hz=2.0, amp=3.0)


# ------------------------------------------------------------------ coloso de asedio: el Mosquito

def build_mosquito():
    """Mosquito (art/concepts/siege.png): cuerpo alto sobre cuatro patas larguísimas, cabeza sensora con
    probóscide, batería de cohetes, alas y reactor en el abdomen."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rb.TEAM.clear()
    M = {
        'armor': rb.painted('armor', (0.8, 0.72, 0.55), scale=1.5, wear=0.6),
        'frame': rb.painted('frame', (0.07, 0.075, 0.085), scale=1.5, wear=0.3),
        'team': rb.flat('team', (0.0, 0.12, 1.0), rough=0.45),
        'core': rb.flat('core', (1.0, 0.75, 0.35), emit=(1.0, 0.65, 0.25), strength=8.0),
        'eye': rb.flat('eye', (1.0, 0.1, 0.1), emit=(1.0, 0.15, 0.1), strength=6.0),
        'rocket': rb.painted('rocket', (0.85, 0.83, 0.78), scale=2.0, wear=0.3),
        'tip': rb.flat('tip', (0.7, 0.06, 0.04), rough=0.4),
    }
    wing = bpy.data.materials.new('wing')
    wing.use_nodes = True
    b = wing.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.85, 0.9, 0.95, 1)
    b.inputs['Alpha'].default_value = 0.3
    b.inputs['Roughness'].default_value = 0.2
    M['wing'] = wing
    A, F, T = M['armor'], M['frame'], M['team']
    J = {}
    J['root'] = joint('root', None, (0, 0, 0))
    J['hips'] = joint('hips', J['root'], (0, 0, 2.4))
    J['chest'] = joint('chest', J['hips'], (0, 0, 0))
    J['chest'].scale = (1.45, 1.45, 1.45)
    # Tórax, cabeza al frente (+y) y abdomen con el reactor detrás.
    tbox('thorax', (0.5, 0.9), (0.62, 1.0), 0.45, A, J['chest'], (0, 0, -0.2), down=False)
    tbox('thorax_belly', (0.4, 0.7), (0.5, 0.9), 0.2, F, J['chest'], (0, 0, -0.2))
    tbox('thorax_stripe', (0.625, 0.25), (0.625, 0.25), 0.06, T, J['chest'], (0, 0.15, 0.12), down=False)
    tbox('hazard', (0.5, 0.06), (0.5, 0.06), 0.1, F, J['chest'], (0, 0.5, 0.05), down=False)
    J['head'] = joint('head', J['chest'], (0, 0.55, 0.05))
    tbox('headbox', (0.3, 0.3), (0.26, 0.26), 0.26, A, J['head'], (0, 0.12, -0.1), down=False)
    for ex, ez in ((-0.07, 0.07), (0.07, 0.07), (0.0, -0.02)):
        tbox('eye', (0.07, 0.03), (0.07, 0.03), 0.07, M['eye'], J['head'], (ex, 0.27, ez), down=False)
    o = tbox('proboscis', (0.04, 0.04), (0.012, 0.012), 1.1, F, J['head'], (0, 0.3, -0.05), down=False)
    o.rotation_euler = (1.9, 0, 0)
    tbox('abdomen', (0.42, 0.7), (0.3, 0.5), 0.4, A, J['chest'], (0, -0.75, -0.25), down=False)
    tbox('core', (0.3, 0.42), (0.3, 0.42), 0.22, M['core'], J['chest'], (0, -0.72, -0.27))
    tbox('abdomen_stripe', (0.425, 0.12), (0.425, 0.12), 0.25, T, J['chest'], (0, -0.6, -0.2), down=False)
    # Batería de cohetes sobre el lomo, apuntando hacia delante y arriba.
    J['gun'] = joint('gun', J['chest'], (0, -0.05, 0.3))
    J['gun'].rotation_euler = (-0.25, 0, 0)
    tbox('rack', (0.62, 0.5), (0.62, 0.5), 0.1, F, J['gun'], (0, 0, 0), down=False)
    for k, rx in enumerate((-0.2, 0.0, 0.2)):
        o = tbox('rocket', (0.13, 0.13), (0.13, 0.13), 0.9, M['rocket'], J['gun'], (rx, -0.35, 0.18 + (0.05 if k == 1 else 0)), down=False)
        o.rotation_euler = (-math.pi / 2, 0, 0)
        o = tbox('rocket_band', (0.135, 0.135), (0.135, 0.135), 0.08, T, J['gun'], (rx, 0.25, 0.18 + (0.05 if k == 1 else 0)), down=False)
        o.rotation_euler = (-math.pi / 2, 0, 0)
        o = tbox('rocket_tip', (0.13, 0.13), (0.02, 0.02), 0.22, M['tip'], J['gun'], (rx, 0.55, 0.18 + (0.05 if k == 1 else 0)), down=False)
        o.rotation_euler = (-math.pi / 2, 0, 0)
    # Alas: dos pares de láminas translúcidas.
    J['wings'] = joint('wings', J['chest'], (0, -0.1, 0.25))
    for sx in (-1, 1):
        for k, (ang, ln) in enumerate(((0.25, 1.3), (-0.15, 1.0))):
            bm = bmesh.new()
            pts = [(0, 0), (sx * ln, 0.12), (sx * ln * 0.95, -0.12), (0, -0.08)]
            vs = [bm.verts.new((x, y, 0)) for x, y in pts]
            bm.faces.new(vs if sx > 0 else list(reversed(vs)))
            w_ = rb.mesh_obj('wing', bm, M['wing'])
            w_.parent = J['wings']
            w_.location = (sx * 0.25, -0.15 * k, 0.05 * k)
            w_.rotation_euler = (0.0, sx * -0.25, sx * ang)
    # Patas: marco por pata girado hacia fuera; cadera → rodilla alta → pie en el suelo.
    legs = {'FL': (0.4, 0.35, 50), 'FR': (-0.4, 0.35, 130), 'BL': (0.35, -0.45, -40), 'BR': (-0.35, -0.45, -140)}
    for k, (lx, ly, yaw) in legs.items():
        frame = joint('frame' + k, J['chest'], (lx * 0.6, ly, -0.15))
        frame.rotation_euler = (0, 0, math.radians(yaw))
        J['hip' + k] = joint('hip' + k, frame, (0, 0, 0))
        # El tórax está escalado ×1,45: las patas se definen en su espacio (alto de cadera 2,4/1,45).
        knee = Vector((0.6, 0, 0.55))
        foot = Vector((1.25, 0, -1.55))
        o = rb.strut('femur', (0, 0, 0), tuple(knee), 0.055, A, 8)
        o.parent = J['hip' + k]
        J['knee' + k] = joint('knee' + k, J['hip' + k], tuple(knee))
        tbox('kneejoint', (0.12, 0.12), (0.12, 0.12), 0.12, F, J['knee' + k], (0, 0, 0.06))
        o = rb.strut('shin', (0, 0, 0), tuple(foot - knee), 0.045, A, 8)
        o.parent = J['knee' + k]
        mid = (foot - knee) * 0.35
        o = rb.strut('shin_stripe', tuple(mid), tuple(mid + (foot - knee) * 0.1), 0.05, T, 8)
        o.parent = J['knee' + k]
        tbox('foot', (0.08, 0.08), (0.04, 0.04), 0.09, F, J['knee' + k], tuple(foot - knee + Vector((0, 0, 0.09))))
    return J


def pose_mosquito(J, anim, f):
    n = ANIMS[anim]
    p = 2 * math.pi * f / n
    for k in ('FL', 'FR', 'BL', 'BR'):
        J['hip' + k].rotation_euler = (0, 0, 0)
        J['knee' + k].rotation_euler = (0, 0, 0)
    J['hips'].location = (0, 0, 2.4)
    J['chest'].rotation_euler = (0, 0, 0)
    J['head'].rotation_euler = (0, 0, 0)
    J['wings'].rotation_euler = (0, 0, 0)
    J['gun'].rotation_euler = (-0.25, 0, 0)
    if anim == 'idle':
        J['hips'].location = (0, 0, 2.4 + 0.03 * math.sin(p))
        J['head'].rotation_euler = (0.08 * math.sin(p), 0, 0.15 * math.sin(p * 0.5 + 1))
        J['wings'].rotation_euler = (0, 0.06 * math.sin(p * 2), 0)
    elif anim == 'walk':
        # Patas en diagonal por pares: una pareja avanza levantada mientras la otra apoya.
        for k, ph in (('FL', 0), ('BR', 0), ('FR', math.pi), ('BL', math.pi)):
            s_ = math.sin(p + ph)
            lift = max(0.0, math.cos(p + ph))
            J['hip' + k].rotation_euler = (0, -0.18 * lift, 0.22 * s_)
            J['knee' + k].rotation_euler = (0, 0.12 * lift, 0)
        J['hips'].location = (0, 0, 2.4 + 0.05 * abs(math.sin(p)))
        J['chest'].rotation_euler = (0.03 * math.sin(p * 2), 0.04 * math.sin(p), 0)
    elif anim == 'fire':
        recoil = [0.0, 0.0, 1.0, 0.4][f]
        J['gun'].rotation_euler = (-0.45 + 0.2 * recoil, 0, 0)
        J['chest'].rotation_euler = (-0.08 + 0.1 * recoil, 0, 0)
        J['hips'].location = (0, 0, 2.35 - 0.08 * recoil)
    bpy.context.view_layer.update()


# ------------------------------------------------------------------ infantería: soldado y obrero

def build_human(kind):
    """Soldado (art/concepts/soldier.png) u obrero (art/concepts/worker.png). Se modela a la escala del mecha
    (~2 de alto) y se encoge con la raíz: así sirven las mismas poses."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rb.TEAM.clear()
    soldier = kind == 'soldier'
    M = {
        'frame': rb.painted('frame', (0.09, 0.09, 0.1), scale=3.0, wear=0.2),
        'team': rb.flat('team', (0.0, 0.12, 1.0), rough=0.5),
        'skin': rb.flat('skin', (0.62, 0.44, 0.33), rough=0.6),
        'gun': rb.painted('gun', (0.16, 0.16, 0.17), scale=3.0, wear=0.4),
    }
    if soldier:
        M['armor'] = rb.painted('armor', (0.84, 0.76, 0.58), scale=3.0, wear=0.4)
        M['suit'] = rb.painted('suit', (0.3, 0.29, 0.25), scale=3.0, wear=0.3)
        M['visor'] = rb.flat('visor', (1.0, 0.5, 0.1), emit=(1.0, 0.45, 0.1), strength=3.0)
    else:
        # El mono del obrero es del color del equipo (se le reconoce de lejos); casco naranja y arnés oscuro.
        M['armor'] = M['team']
        M['suit'] = M['team']
        M['helmet'] = rb.painted('helmet', (0.95, 0.45, 0.08), scale=3.0, wear=0.3)
        M['reflect'] = rb.flat('reflect', (0.85, 0.85, 0.8), rough=0.3)
    A, F, T, S = M['armor'], M['frame'], M['team'], M['suit']
    J = {}
    J['root'] = joint('root', None, (0, 0, 0))
    J['hips'] = joint('hips', J['root'], (0, 0, 1.0))
    J['chest'] = joint('chest', J['hips'], (0, 0, 0.1))
    J['neck'] = joint('neck', J['chest'], (0, 0, 0.62))
    J['head'] = joint('head', J['neck'], (0, 0, 0.04))
    tbox('pelvis', (0.36, 0.22), (0.34, 0.2), 0.2, S, J['hips'])
    tbox('belt', (0.4, 0.25), (0.4, 0.25), 0.07, F, J['hips'], (0, 0, -0.02))
    tbox('torso', (0.36, 0.22), (0.5, 0.28), 0.55, A, J['chest'], (0, 0, 0.05), down=False)
    if soldier:
        tbox('chest_plate', (0.3, 0.04), (0.42, 0.04), 0.28, A, J['chest'], (0, 0.14, 0.28), down=False)
        tbox('backpack', (0.34, 0.16), (0.34, 0.16), 0.4, F, J['chest'], (0, -0.2, 0.15), down=False)
        tbox('backpack_lid', (0.3, 0.02), (0.3, 0.02), 0.3, A, J['chest'], (0, -0.285, 0.18), down=False)
        tbox('helmet', (0.26, 0.3), (0.24, 0.28), 0.28, A, J['head'], (0, 0, 0.02), down=False)
        tbox('helmet_brim', (0.28, 0.32), (0.28, 0.32), 0.05, F, J['head'], (0, 0.01, 0.08), down=False)
        tbox('visor', (0.2, 0.02), (0.2, 0.02), 0.05, M['visor'], J['head'], (0, 0.15, 0.13), down=False)
        tbox('antenna', (0.012, 0.012), (0.006, 0.006), 0.25, F, J['head'], (0.1, -0.06, 0.25), down=False)
    else:
        for sx in (-1, 1):
            o = tbox('harness', (0.06, 0.29), (0.06, 0.29), 0.5, F, J['chest'], (sx * 0.1, 0, 0.08), down=False)
            o.rotation_euler = (0, sx * 0.25, 0)
        tbox('reflect', (0.52, 0.29), (0.52, 0.29), 0.04, M['reflect'], J['chest'], (0, 0, 0.42), down=False)
        tbox('face', (0.17, 0.2), (0.16, 0.19), 0.2, M['skin'], J['head'], (0, 0, 0.0), down=False)
        tbox('hardhat', (0.28, 0.32), (0.22, 0.26), 0.14, M['helmet'], J['head'], (0, -0.01, 0.17), down=False)
        tbox('brim', (0.34, 0.38), (0.34, 0.38), 0.03, M['helmet'], J['head'], (0, 0.02, 0.16), down=False)
    for sx in (-1, 1):
        s_ = 'L' if sx > 0 else 'R'
        J['sh' + s_] = joint('sh' + s_, J['chest'], (sx * 0.28, 0, 0.52))
        tbox('shoulder', (0.17, 0.2), (0.16, 0.19), 0.13, A if soldier else F, J['sh' + s_], (sx * 0.02, 0, 0.06))
        if soldier:
            tbox('shoulder_stripe', (0.173, 0.203), (0.173, 0.203), 0.04, T, J['sh' + s_], (sx * 0.02, 0, -0.02))
        tbox('upperarm', (0.11, 0.12), (0.12, 0.13), 0.3, S, J['sh' + s_], (sx * 0.02, 0, -0.04))
        J['el' + s_] = joint('el' + s_, J['sh' + s_], (sx * 0.02, 0, -0.34))
        tbox('forearm', (0.11, 0.12), (0.13, 0.14), 0.28, A if soldier else S, J['el' + s_])
        if soldier:
            tbox('gauntlet', (0.135, 0.145), (0.135, 0.145), 0.06, T, J['el' + s_], (0, 0, -0.1))
        else:
            tbox('cuff', (0.135, 0.145), (0.135, 0.145), 0.04, M['reflect'], J['el' + s_], (0, 0, -0.08))
        J['hand' + s_] = joint('hand' + s_, J['el' + s_], (0, 0, -0.3))
        tbox('glove', (0.09, 0.1), (0.1, 0.1), 0.1, F, J['hand' + s_])
        J['hip' + s_] = joint('hip' + s_, J['hips'], (sx * 0.1, 0, -0.08))
        tbox('thigh', (0.14, 0.16), (0.17, 0.19), 0.42, S, J['hip' + s_])
        if soldier:
            tbox('thigh_plate', (0.13, 0.04), (0.16, 0.04), 0.26, A, J['hip' + s_], (0, 0.09, -0.06))
        J['knee' + s_] = joint('knee' + s_, J['hip' + s_], (0, 0, -0.44))
        tbox('kneepad', (0.13, 0.06), (0.13, 0.06), 0.12, F, J['knee' + s_], (0, 0.08, 0.06))
        tbox('shin', (0.12, 0.14), (0.15, 0.17), 0.4, A if soldier else S, J['knee' + s_])
        J['ankle' + s_] = joint('ankle' + s_, J['knee' + s_], (0, 0, -0.42))
        tbox('boot', (0.15, 0.27), (0.13, 0.2), 0.12, F, J['ankle' + s_], (0, 0.04, 0.04))
    if soldier:
        # Fusil multiusos con las dos manos (sale de la mano derecha hacia delante).
        J['gun'] = joint('gun', J['handR'], (0, 0, -0.05))
        tbox('rifle', (0.06, 0.62), (0.06, 0.62), 0.09, M['gun'], J['gun'], (0, 0.14, 0.045))
        tbox('rifle_mag', (0.05, 0.08), (0.05, 0.08), 0.13, M['gun'], J['gun'], (0, 0.05, -0.03))
        tbox('rifle_stripe', (0.065, 0.1), (0.065, 0.1), 0.03, T, J['gun'], (0, 0.22, 0.05))
        J['muzzle'] = joint('muzzle', J['gun'], (0, 0.45, 0))
    else:
        # Garra multiherramienta en la mano derecha.
        J['gun'] = joint('gun', J['handR'], (0, 0, -0.08))
        tbox('tool_shaft', (0.04, 0.04), (0.04, 0.04), 0.32, M['gun'], J['gun'], (0, 0, 0))
        for sx in (-1, 1):
            o = tbox('tool_jaw', (0.03, 0.05), (0.02, 0.03), 0.16, M['helmet'], J['gun'], (sx * 0.05, 0, -0.3))
            o.rotation_euler = (0, sx * 0.35, 0)
    J['root'].scale = (0.27, 0.27, 0.27) if soldier else (0.24, 0.24, 0.24)
    return J


def pose_soldier(J, anim, f):
    pose(J, anim, f, 'rifle')
    if anim != 'fire':
        # Fusil bajo, apuntando al suelo por delante (como el mecha, pero más recogido).
        J['shR'].rotation_euler = (0.3, 0.12, 0)
        J['elR'].rotation_euler = (0.5, 0, 0)
        J['gun'].rotation_euler = (-0.9, 0, 0)
        bpy.context.view_layer.update()


def pose_worker(J, anim, f):
    pose(J, anim, f, 'tool')
    J['gun'].rotation_euler = (0, 0, 0)
    if anim == 'fire':
        # Trabajando: agachado, golpeando con la garra por delante.
        p = 2 * math.pi * f / ANIMS[anim]
        J['hips'].location = (0, 0, 0.9)
        for s_ in ('L', 'R'):
            J['hip' + s_].rotation_euler = (0.35, 0, 0)
            J['knee' + s_].rotation_euler = (-0.6, 0, 0)
            J['ankle' + s_].rotation_euler = (0.25, 0, 0)
        J['chest'].rotation_euler = (0.35, 0, 0)
        J['shR'].rotation_euler = (1.2 + 0.6 * math.sin(p), 0.1, 0)
        J['elR'].rotation_euler = (0.5 - 0.4 * math.sin(p), 0, 0)
        J['shL'].rotation_euler = (0.8, -0.2, 0)
        J['elL'].rotation_euler = (0.6, 0, 0)
    bpy.context.view_layer.update()


# ------------------------------------------------------------------ camión repetidor

def build_truck():
    """Camión de telecomunicaciones de seis ruedas (art/concepts/truck.png). Plegado en marcha; al desplegarse
    baja los gatos, sube el mástil telescópico y abre las parábolas."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rb.TEAM.clear()
    M = {
        'body': rb.painted('body', (0.84, 0.78, 0.64), scale=3.0, wear=0.5),
        'frame': rb.painted('frame', (0.08, 0.08, 0.09), scale=3.0, wear=0.3),
        'team': rb.flat('team', (0.0, 0.12, 1.0), rough=0.5),
        'glass': rb.flat('glass', (0.1, 0.14, 0.18), rough=0.15),
        'tire': rb.flat('tire', (0.03, 0.03, 0.03), rough=0.9),
        'dish': rb.painted('dish', (0.9, 0.88, 0.82), scale=4.0, wear=0.3),
        'light': rb.flat('light', (0.6, 1.0, 0.7), emit=(0.5, 1.0, 0.6), strength=6.0),
    }
    B, F, T = M['body'], M['frame'], M['team']
    J = {}
    J['root'] = joint('root', None, (0, 0, 0))
    J['hips'] = joint('body', J['root'], (0, 0, 0.0))
    # Chasis, cabina delante (+y) y caja de equipos detrás.
    tbox('chassis', (0.36, 0.95), (0.36, 0.95), 0.06, F, J['hips'], (0, 0, 0.1), down=False)
    tbox('cab', (0.38, 0.28), (0.36, 0.22), 0.26, B, J['hips'], (0, 0.33, 0.16), down=False)
    tbox('windshield', (0.32, 0.02), (0.3, 0.02), 0.1, M['glass'], J['hips'], (0, 0.445, 0.3), down=False)
    tbox('cab_stripe', (0.385, 0.285), (0.385, 0.285), 0.04, T, J['hips'], (0, 0.33, 0.22), down=False)
    tbox('grille', (0.3, 0.03), (0.3, 0.03), 0.08, F, J['hips'], (0, 0.47, 0.17), down=False)
    tbox('box', (0.4, 0.62), (0.4, 0.62), 0.32, B, J['hips'], (0, -0.14, 0.16), down=False)
    tbox('box_stripe', (0.405, 0.625), (0.405, 0.625), 0.05, T, J['hips'], (0, -0.14, 0.27), down=False)
    tbox('box_roof', (0.36, 0.58), (0.36, 0.58), 0.03, F, J['hips'], (0, -0.14, 0.48), down=False)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=(0.09, 0.05, 0.53), segments=16, ring_count=8)
    o = bpy.context.active_object
    o.data.materials.append(M['dish'])
    o.parent = J['hips']
    J['wheels'] = []
    for y in (0.3, -0.12, -0.3):
        for sx in (-1, 1):
            w = joint('wheel', J['hips'], (sx * 0.19, y, 0.09))
            o = rb.cyl('tire', (0, 0, 0), 0.09, 0.08, M['tire'], (0, math.pi / 2, 0), 14)
            o.parent = w
            o = rb.cyl('hub', (sx * 0.045, 0, 0), 0.04, 0.01, F, (0, math.pi / 2, 0), 8)
            o.parent = w
            J['wheels'].append(w)
    # Gatos estabilizadores en las cuatro esquinas de la caja.
    J['jacks'] = []
    for (x, y) in [(-0.21, 0.08), (0.21, 0.08), (-0.21, -0.42), (0.21, -0.42)]:
        j = joint('jack', J['hips'], (x, y, 0.16))
        tbox('jack_leg', (0.03, 0.03), (0.03, 0.03), 0.12, F, j)
        tbox('jack_pad', (0.07, 0.07), (0.07, 0.07), 0.015, F, j, (0, 0, -0.12))
        J['jacks'].append(j)
    # Mástil telescópico (tres tramos) con parábolas y antenas.
    J['mast'] = []
    parent, z = J['hips'], 0.48
    for k, (r, h) in enumerate([(0.05, 0.3), (0.04, 0.28), (0.03, 0.26)]):
        seg = joint('mast', parent, (-0.06, -0.3, z) if k == 0 else (0, 0, 0))
        tbox('mast_seg', (r * 2, r * 2), (r * 2, r * 2), h, F, seg, (0, 0, 0), down=False)
        J['mast'].append(seg)
        parent, z = seg, h
    top = J['mast'][-1]
    J['dishes'] = []
    for k, (z_, ang) in enumerate([(0.22, 0.0), (0.12, 2.1), (0.02, 4.2)]):
        d = joint('dish', top, (0, 0, z_))
        d.rotation_euler = (0, 0, ang)
        o = rb.cyl('dish_plate', (0.12, 0, 0), 0.11, 0.02, M['dish'], (0, math.pi / 2, 0), 16)
        o.parent = d
        J['dishes'].append(d)
    o = tbox('yagi', (0.25, 0.015), (0.25, 0.015), 0.015, F, top, (0, 0, 0.27), down=False)
    tbox('beacon', (0.05, 0.05), (0.05, 0.05), 0.05, M['light'], top, (0, 0, 0.29), down=False)
    return J


def pose_truck(J, anim, f):
    n = ANIMS[anim]
    p = 2 * math.pi * f / n
    deploy = (f + 1) / 4 if anim == 'fire' else 0.0
    J['hips'].location = (0, 0, 0.0)
    J['hips'].rotation_euler = (0, 0, 0)
    for w in J['wheels']:
        w.rotation_euler = ((p if anim == 'walk' else 0), 0, 0)
    if anim == 'walk':
        J['hips'].location = (0, 0, 0.006 * math.sin(p * 2))
        J['hips'].rotation_euler = (0.01 * math.sin(p), 0, 0)
    # Gatos: bajan en la primera mitad del despliegue.
    for j in J['jacks']:
        j.location.z = 0.16 - 0.05 * min(1.0, deploy * 2)
        j.scale = (1, 1, 0.4 + 0.6 * min(1.0, deploy * 2))
    # Mástil: plegado dentro (tramos encajados) y extendido al desplegar.
    ext = max(0.0, deploy * 1.4 - 0.4)
    J['mast'][0].rotation_euler = (0, 0, 0)
    J['mast'][0].scale = (1, 1, 0.35 + 0.65 * min(1.0, ext + 0.2))
    J['mast'][1].location.z = 0.3 * min(1.0, ext) + 0.02
    J['mast'][2].location.z = 0.28 * min(1.0, ext) + 0.02
    J['mast'][1].scale = J['mast'][2].scale = (1, 1, 1)
    for k, d in enumerate(J['dishes']):
        d.scale = [max(0.01, min(1.0, ext * 1.2))] * 3
    bpy.context.view_layer.update()


# ------------------------------------------------------------------ render

def ground_dir(d):
    """Dirección en el suelo (Blender) de la pantalla a d·45° (0 = derecha, en sentido horario)."""
    th = d * math.pi / 4
    R = Vector((0.7071, 0.7071, 0))
    D = Vector((0.7071, -0.7071, 0))
    return R * math.cos(th) + D * math.sin(th)


def setup_scene(cam_rot, sun_dir):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    rd.setup_devices()
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 6.5
    sun.data.angle = math.radians(3)
    sun.data.color = (1.0, 0.95, 0.86)
    sun.rotation_euler = sun_dir.to_track_quat('-Z', 'Y').to_euler()
    rb.link(sun)
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)
    bg.inputs['Strength'].default_value = 0.45
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    bpy.context.active_object.is_shadow_catcher = True
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = RES / SCALE
    cam.rotation_euler = cam_rot
    fwd = cam_rot.to_matrix() @ Vector((0, 0, -1))
    up = cam_rot.to_matrix() @ Vector((0, 1, 0))
    right = cam_rot.to_matrix() @ Vector((1, 0, 0))
    # Encuadre fijo: el centro del cuadro, algo por encima de los pies y desplazado hacia la sombra.
    center = Vector((0, 0, CENTER_Z)) + right * (0.25 * FRAME / 3.4) - up * 0.1
    cam.location = center - fwd * 60
    rb.link(cam)
    scene.camera = cam
    # Contorno entintado fino, como en los edificios.
    scene.render.use_freestyle = True
    vl = bpy.context.view_layer
    vl.use_freestyle = True
    scene.render.line_thickness_mode = 'ABSOLUTE'
    scene.render.line_thickness = 1.0
    ls = vl.freestyle_settings.linesets[0] if vl.freestyle_settings.linesets else vl.freestyle_settings.linesets.new('lines')
    ls.select_by_visibility = True
    ls.select_silhouette = True
    ls.select_border = True
    ls.select_crease = False
    if ls.linestyle is None:
        ls.linestyle = bpy.data.linestyles.new('ink')
    ls.linestyle.color = (0.1, 0.08, 0.07)
    ls.linestyle.alpha = 0.8
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    o = Vector((0, 0, 0)) - cam.location
    ax = RES / 2 + o.dot(right) * SCALE
    ay = RES / 2 - o.dot(up) * SCALE
    return ax / RES, ay / RES


def split_team(path):
    """Separa las zonas azules (color de equipo) en <path>_team.png (gris iluminado) y las desatura en el original."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    r, g, b, a = px[..., 0], px[..., 1], px[..., 2], px[..., 3]
    mask = np.clip((b - np.maximum(r, g) * 1.25) * 5.0, 0, 1) * (b > 0.12)
    lum = np.clip(b * 1.15, 0, 1)
    team = np.zeros_like(px)
    team[..., 0] = team[..., 1] = team[..., 2] = lum
    team[..., 3] = a * mask
    grey = (r * 0.3 + g * 0.59 + b * 0.11)[..., None]
    px[..., :3] = px[..., :3] * (1 - mask[..., None]) + grey * mask[..., None]
    img.pixels.foreach_set(px.ravel())
    img.save()
    t = bpy.data.images.new('team', w, h, alpha=True)
    t.pixels.foreach_set(team.ravel())
    t.filepath_raw = path.replace('.png', '_team.png')
    t.file_format = 'PNG'
    t.save()
    bpy.data.images.remove(img)
    bpy.data.images.remove(t)


def render_unit(name, spec, dirs):
    global FRAME, SCALE, RES, CENTER_Z
    FRAME, CENTER_Z = spec['frame'], spec['cz']
    SCALE = rd.K * spec.get('scale', 1.0)
    RES = round(FRAME * SCALE)
    out = os.path.join(rd.ROOT, 'units', name)
    os.makedirs(out, exist_ok=True)
    cam_rot = Euler((math.radians(60), 0, math.radians(45)))
    rm = cam_rot.to_matrix()
    right = rm @ Vector((1, 0, 0))
    ground_up = Vector((rm[0][1], rm[1][1], 0)).normalized()
    hor = (ground_up * 0.45 - Vector((right.x, right.y, 0)).normalized() * 0.2).normalized()
    sun_dir = -(hor * 0.65 + Vector((0, 0, 0.75))).normalized()
    J = spec['build']()
    ax, ay = setup_scene(cam_rot, sun_dir)
    path = os.path.join(out, 'manifest.json')
    manifest = json.load(open(path)) if os.path.exists(path) else {}
    scene = bpy.context.scene
    for d in dirs:
        g = ground_dir(d)
        # El modelo mira hacia +y local: girarlo hacia la dirección de pantalla d.
        J['root'].rotation_euler = (0, 0, math.atan2(g.y, g.x) - math.pi / 2)
        for anim, n in ANIMS.items():
            for f in range(n):
                spec['pose'](J, anim, f)
                fname = f'{name}_{anim}_{d}_{f}.png'
                scene.render.filepath = os.path.join(out, fname)
                bpy.ops.render.render(write_still=True)
                split_team(os.path.join(out, fname))
                for key, file in ((fname[:-4], fname), (fname[:-4] + '_team', fname[:-4] + '_team.png')):
                    manifest[key] = {'file': file, 'w': RES, 'h': RES, 'ax': round(ax, 4), 'ay': round(ay, 4)}
        json.dump(manifest, open(path, 'w'), indent=1)
        print('DIR', name, d)


SPECS = {
    'mech': {'build': lambda: build('rifle'), 'pose': lambda J, a, f: pose(J, a, f, 'rifle'), 'frame': 3.4, 'cz': 0.95},
    'artillery': {'build': lambda: build('mortar'), 'pose': lambda J, a, f: pose(J, a, f, 'mortar'), 'frame': 3.4, 'cz': 0.95},
    # Los colosos se renderizan a algo menos de resolución (son enormes: el atlas no cabría).
    'colossus': {'build': build_titan, 'pose': pose_titan, 'frame': 6.4, 'cz': 2.1, 'scale': 0.7},
    'soldier': {'build': lambda: build_human('soldier'), 'pose': pose_soldier, 'frame': 1.1, 'cz': 0.3},
    'worker': {'build': lambda: build_human('worker'), 'pose': pose_worker, 'frame': 1.0, 'cz': 0.26},
    'truck': {'build': build_truck, 'pose': pose_truck, 'frame': 2.2, 'cz': 0.65},
    'siege': {'build': build_mosquito, 'pose': pose_mosquito, 'frame': 7.2, 'cz': 1.9, 'scale': 0.7},
}
which = [a for a in ARGS if a in SPECS] or ['mech', 'artillery']
dirs = [int(a) for a in ARGS if a.isdigit()] or list(range(8))
for u in which:
    render_unit(u, SPECS[u], dirs)
