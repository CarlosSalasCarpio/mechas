"""
Retratos para la interfaz a partir de los renders del juego (los mismos modelos que se ven en el mapa):
edificios desde art/sprites/<tipo>_0.png y unidades desde art/units/<tipo>/<tipo>_idle_1_0.png, con la
máscara de color de equipo teñida de azul. Salida: packages/client/public/ui/portrait_<tipo>.png (128 px).
"""
import os, subprocess
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', 'packages', 'client', 'public', 'ui')
TEAM = '#3b82f6'

def make(name, body, team, zoom_top=None):
    out = os.path.join(OUT, f'portrait_{name}.png')
    cmd = ['magick', body]
    if team and os.path.exists(team):
        cmd += ['(', team, '-fill', TEAM, '-colorize', '100', ')', '-compose', 'over', '-composite']
    # Sin sombra proyectada (alfa bajo y oscuro) y recortado al contenido.
    cmd += ['-channel', 'A', '-fx', 'r+g+b < 0.12 ? 0 : a', '+channel', '-trim', '+repage']
    if zoom_top:
        # Unidades: medio cuerpo superior, como un retrato.
        cmd += ['-gravity', 'north', '-crop', f'100%x{zoom_top}%+0+0', '+repage']
    cmd += ['-resize', '112x112', '-background', 'none', '-gravity', 'center', '-extent', '128x128', out]
    subprocess.run(cmd, check=True)
    print('retrato', name)

for b in ('hq', 'barracks', 'hangar', 'cradle', 'tower', 'relay', 'depot', 'plant'):
    make(b, os.path.join(ROOT, 'sprites', f'{b}_0.png'), os.path.join(ROOT, 'sprites', f'{b}_0_team.png'))
for u in ('worker', 'soldier'):
    hi = os.path.join(ROOT, 'units', f'{u}_hi', f'{u}_hi_idle_1_0.png')
    if os.path.exists(hi):
        make(u, hi, hi.replace('.png', '_team.png'), 75)
for u, top in ( ('mech', 55), ('artillery', 60), ('truck', None), ('colossus', 55), ('siege', None)):
    make(u, os.path.join(ROOT, 'units', u, f'{u}_idle_1_0.png'), os.path.join(ROOT, 'units', u, f'{u}_idle_1_0_team.png'), top)
