"""
Empaqueta art/sprites/*.png en un atlas para PixiJS (formato spritesheet JSON).

- Limpia el velo casi transparente que deja el shadow catcher y recorta cada sprite a su contenido.
- Conserva el punto de apoyo (base del objeto) como `anchor` de cada frame.
- Salida: packages/client/public/decor/decor.png + decor.json (escala 2: los sprites se renderizaron al doble).

Uso: python3 art/pack_atlas.py [origen] [nombre] [ancho] [escala_render] [escala_final]   (necesita ImageMagick)
     p. ej. python3 art/pack_atlas.py units/mech mech 2048 2 1  → packages/client/public/units/mech.png + .json
     escala_render: píxeles del render por píxel del juego (2 por defecto; 1,4 los colosos).
     escala_final: la del atlas (menos = menos memoria de vídeo; 1 = tamaño real en pantalla).
"""
import json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else 'sprites')
NAME = sys.argv[2] if len(sys.argv) > 2 else 'decor'
DST = os.path.join(ROOT, '..', 'packages', 'client', 'public', NAME if NAME in ('decor', 'fx') else 'units')
os.makedirs(DST, exist_ok=True)
manifest = json.load(open(os.path.join(SRC, 'manifest.json')))
if os.environ.get('THIN'):
    # Unidades lentas: solo los fotogramas pares de reposo y caminar (el juego usa el par anterior).
    import re
    manifest = {k: v for k, v in manifest.items() if not re.search(r'_(idle|walk)_\d+_[13579](_team)?$', k)}
tmp = tempfile.mkdtemp()
PAD = 2
WIDTH = int(sys.argv[3]) if len(sys.argv) > 3 else 2048
RSCALE = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
FSCALE = float(sys.argv[5]) if len(sys.argv) > 5 else RSCALE

TONE = {'grass': '150,115', 'weed': '150,110', 'nettle': '150,110', 'shrub': '145,110', 'fir': '135,110', 'pine': '135,110', 'tree_small': '130,110', 'fallen': '135,110', 'rock': '135', 'boulder': '135', 'stone': '130', 'ore': '115', 'dead_trunk': '125'}

def prep(entry):
    name, m = entry
    src = os.path.join(SRC, m['file'])
    out = os.path.join(tmp, m['file'])
    # Velo del shadow catcher: en los píxeles de pura sombra (negros) se resta un 12 % de alfa. Después, recorte guardando el desplazamiento.
    # (Los efectos no: su humo oscuro es legítimo.)
    veil = [] if NAME == 'fx' else ['-channel', 'A', '-fx', 'r + g + b < 0.03 ? max(0, (a - 0.12) * 1.25) : a', '+channel']
    geo = subprocess.run(['magick', src, *veil, '-trim', '-format', '%w %h %X %Y', '-write', out, 'info:'], capture_output=True, text=True, check=True).stdout.split()
    w, h, ox, oy = int(geo[0]), int(geo[1]), int(geo[2]), int(geo[3])
    subprocess.run(['magick', out, '+repage', out], check=True)
    # La vegetación y las rocas salen oscuras frente al terreno: aclarar (brillo, saturación).
    tone = next((v for k, v in TONE.items() if name.startswith(k)), None)
    if tone:
        subprocess.run(['magick', out, '-modulate', tone, out], check=True)
    ax = m['ax'] * m['w'] - ox
    ay = m['ay'] * m['h'] - oy
    if FSCALE != RSCALE:
        geo = subprocess.run(['magick', out, '-resize', f'{100 * FSCALE / RSCALE:.3f}%', '-format', '%w %h', '-write', out, 'info:'], capture_output=True, text=True, check=True).stdout.split()
        nw, nh = int(geo[0]), int(geo[1])
        ax, ay, w, h = ax * nw / w, ay * nh / h, nw, nh
    return {'name': name, 'path': out, 'w': w, 'h': h, 'ax': ax / w, 'ay': ay / h}


with ThreadPoolExecutor(8) as ex:
    items = list(ex.map(prep, sorted(manifest.items())))

# Estanterías por altura descendente.
items.sort(key=lambda i: -i['h'])
x = y = shelf = 0
for it in items:
    if x + it['w'] + PAD > WIDTH:
        x = 0
        y += shelf + PAD
        shelf = 0
    it['x'], it['y'] = x, y
    x += it['w'] + PAD
    shelf = max(shelf, it['h'])
height = y + shelf
H = 1
while H < height:
    H *= 2

cmd = ['magick', '-size', f'{WIDTH}x{H}', 'xc:none']
for it in items:
    cmd += [it['path'], '-geometry', f"+{it['x']}+{it['y']}", '-composite']
cmd += [os.path.join(DST, f'{NAME}.png')]
subprocess.run(cmd, check=True)

frames = {
    it['name']: {
        'frame': {'x': it['x'], 'y': it['y'], 'w': it['w'], 'h': it['h']},
        'sourceSize': {'w': it['w'], 'h': it['h']},
        'spriteSourceSize': {'x': 0, 'y': 0, 'w': it['w'], 'h': it['h']},
        'anchor': {'x': round(it['ax'], 4), 'y': round(it['ay'], 4)},
    }
    for it in items
}
json.dump({'frames': frames, 'meta': {'image': f'{NAME}.png', 'size': {'w': WIDTH, 'h': H}, 'scale': f'{FSCALE:g}'}}, open(os.path.join(DST, f'{NAME}.json'), 'w'), indent=1)
print(f'{len(items)} sprites → {WIDTH}x{H}')
