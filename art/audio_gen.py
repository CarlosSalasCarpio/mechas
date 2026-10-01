"""
Genera voces, sonidos de colosos y música con la API de ElevenLabs y los deja listos para el juego.

Uso: python3 art/audio_gen.py [voces|sfx|musica]   (lee ELEVENLABS_API_KEY de .env; necesita ffmpeg)

- Las respuestas originales se guardan en art/audio/raw/ (caché: no se vuelven a pedir).
- ffmpeg las normaliza y les aplica un filtro por personaje (cabina de piloto, radio, megafonía).
- Salida: packages/client/public/audio/<nombre>.mp3 y audio/manifest.json (frases por unidad y momento).
"""
import json, os, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, 'audio', 'raw')
OUT = os.path.join(ROOT, '..', 'packages', 'client', 'public', 'audio')
os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
for line in open(os.path.join(ROOT, '..', '.env')):
    if line.startswith('ELEVENLABS_API_KEY='):
        KEY = line.split('=', 1)[1].strip()
API = 'https://api.elevenlabs.io/v1'

# Voz y filtro por personaje.
VOICES = {
    'soldier': ('SOYHLrjzK2X1ezoPC6cr', 'radio'),      # Harry
    'worker': ('N2lVS1w4EtoT3dr4eOWO', 'plain'),       # Callum
    'mech': ('nPczCjzI2devNBz1zQrb', 'cockpit'),       # Brian
    'artillery': ('EXAVITQu4vr4xnSDxMaL', 'cockpit'),  # Sarah
    'truck': ('iP95p4xoKVk53GoZ742B', 'radio'),        # Chris
    'announcer': ('pNInz6obpgDQGcFmaJgB', 'pa'),       # Adam
}

LINES = {
    'soldier': {
        'select': ['¿Órdenes?', 'Escuadra lista.', 'A la espera, señor.', 'Que el Reactor nos guarde.'],
        'move': ['En marcha.', 'Recibido.', 'Avanzando.'],
        'attack': ['¡Fuego!', '¡Contacto, abran fuego!', '¡Por la Ciudadela!'],
    },
    'worker': {
        'select': ['¿Qué hace falta?', 'Aquí, jefe.', 'Manos a la obra.'],
        'move': ['Voy para allá.', 'Entendido.'],
        'build': ['A construir.', 'Piedra sobre piedra.', 'Lo dejo como nuevo.'],
        'gather': ['Al metal.', 'Lo que la tierra da.'],
    },
    'mech': {
        'select': ['Unidad en línea.', 'Sincronización estable.', 'Estoy contigo.', 'El cuerpo responde.'],
        'move': ['Desplazándome.', 'Confirmado.', 'En camino.'],
        'attack': ['Objetivo fijado.', 'Abriendo fuego.', 'Que sea rápido.'],
        'nopower': ['Pierdo la conexión...', 'Batería... agotándose.'],
    },
    'artillery': {
        'select': ['Artillería lista.', 'Te escucho.', 'Dime dónde.', 'Calculando trayectoria.'],
        'move': ['Reposicionando.', 'Voy.', 'Entendido, cambio de posición.'],
        'attack': ['Disparo en camino.', 'Impacto en tres... dos...', 'Que caiga del cielo.'],
    },
    'truck': {
        'select': ['Enlace activo.', 'Repetidor a la escucha.', '¿Dónde extiendo la red?'],
        'move': ['En ruta.', 'Copiado.'],
        'deploy': ['Desplegando repetidor.', 'Mástil arriba, señal estable.'],
        'undeploy': ['Recogiendo equipo.'],
    },
    'announcer': {
        'built': ['Construcción completada.'],
        'trained': ['Unidad lista.'],
        'attacked': ['Nos atacan.', 'La base está bajo ataque.'],
        'powerlost': ['Una unidad ha perdido la energía.'],
        'generation': ['Nueva generación alcanzada. Que la evolución nos guíe.'],
        'enemycolossus': ['El enemigo está forjando un coloso.'],
        'colossus': ['Un coloso ha despertado.'],
        'reactor': ['Reactor crítico.'],
        'victory': ['Victoria. El cielo es nuestro.'],
        'defeat': ['Derrota. Que el silencio nos perdone.'],
    },
}

# Colosos: sin voz, sonidos generados.
SFX = {
    'colossus_select': ('Deep angelic choir holding a sacred chord, distant cathedral organ, ethereal and mystical, with a slow mechanical heartbeat underneath', 3.0),
    'colossus_move': ('Ethereal angelic choir swell with heavy giant mechanical footstep, sacred and ominous', 2.5),
    'colossus_attack': ('Massive metallic impact of a giant robot fist with a reverberating holy choir echo', 2.5),
    'siege_select': ('Robotic metallic insect wings buzzing, mechanical drone hum with electronic chirps and clicks', 2.5),
    'siege_move': ('Giant mechanical mosquito wings buzzing and servo motors whirring, metallic', 2.5),
    'siege_attack': ('Rocket launcher charging up with an electric hiss followed by a rocket whoosh', 2.5),
}

# Efectos del juego (sustituyen a los sintetizados de packages/client/src/audio.ts; mismo nombre).
GAME_SFX = {
    'shotSoldier': ('Single assault rifle shot, short sharp crack, game sound effect', 0.5),
    'shotMech': ('Heavy mecha energy rifle blast, punchy plasma shot with a metallic ring', 0.8),
    'shotColossus': ('Giant robot fist slamming the ground, deep heavy boom with debris', 1.2),
    'hit': ('Bullet impact on metal armor, short ping and thud', 0.5),
    'shotTower': ('Defense turret autocannon firing a single heavy shot, thump', 0.6),
    'warning': ('Short electronic warning beep, sci-fi interface alert tone', 0.8),
    'genUp': ('Triumphant sci-fi power-up chime with an angelic choir swell, upgrade complete', 2.5),
    'powerDown': ('Electric machine powering down, descending electric whine', 1.2),
    'launch': ('Missile launch, rocket ignition and whoosh', 1.5),
    'mortar': ('Mortar cannon firing, deep thump with a whistle', 1.0),
    'explosionSmall': ('Small explosion, short sharp burst', 1.0),
    'explosion': ('Large explosion with flying debris and a deep rumble', 2.0),
    'repair': ('Wrench ratcheting and a welding torch hiss, repair work', 1.0),
    'gather': ('Pickaxe striking metal ore, single clink', 0.5),
    'deliver': ('Chunks of metal ore dropped into a metal container, clank', 0.6),
    'built': ('Construction complete, heavy steel structure settling with a clunk and a short positive chime', 1.5),
    'trained': ('Heavy hangar door opening with a hydraulic hiss, unit ready', 1.2),
    'death': ('Armored soldier falling, short body armor thud with a burst of radio static', 0.8),
    'deathBig': ('Giant mech collapsing, crashing metal and sparks', 2.0),
    'destroyed': ('Building collapsing, concrete and steel crumbling', 2.5),
    'ack': ('Short sci-fi user interface confirm click', 0.5),
    'ackAttack': ('Short aggressive sci-fi user interface confirm beep, low pitch', 0.5),
    'place': ('Placing a heavy building foundation on the ground, solid thunk', 0.5),
    'error': ('Short negative error buzzer, user interface', 0.5),
    'alert': ('Military alarm klaxon, short siren burst', 1.5),
    'victory': ('Short victorious orchestral fanfare with choir', 4.0),
    'defeat': ('Short somber descending orchestral chord with choir, defeat', 4.0),
}

# Ambiente musical con la API de efectos (la de música es solo de pago): bucles largos de coro y órgano.
AMBIENT = {
    'ambient_choir': ('Seamless loop of a solemn Gregorian choir and cathedral organ drone, mystical, sacred, slow, epic, ambient music, no percussion', 22.0),
    'ambient_war': ('Seamless loop of epic mystical orchestral music, low choir, deep war drums, dark synthesizer pads, ominous and majestic', 22.0),
}

MUSIC = ('Epic mystical orchestral soundtrack for a mecha strategy game in the style of 1990s anime like Neon Genesis Evangelion: '
         'solemn Gregorian choir and cathedral organ over low strings, slowly building with orchestral war drums, '
         'brass and 1980s analog synthesizers, sacred, ominous and majestic, instrumental, no lyrics', 150000)

FILTERS = {
    # Cabina de piloto: algo de banda estrecha y un eco corto metálico.
    'cockpit': 'highpass=f=180,lowpass=f=6000,aecho=0.8:0.4:18:0.25',
    # Radio: banda telefónica con algo de saturación.
    'radio': 'highpass=f=350,lowpass=f=3600,acompressor=threshold=0.2:ratio=4,volume=1.4',
    # Megafonía del centro de mando: reverberación de sala grande.
    'pa': 'highpass=f=120,aecho=0.8:0.5:60|120:0.3|0.15',
    'plain': 'highpass=f=80',
}


def post(path, body, out):
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        return False
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), headers={'xi-api-key': KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            open(out, 'wb').write(r.read())
    except urllib.error.HTTPError as e:
        print('ERROR', path, e.code, e.read()[:300])
        return False
    return True


def ffmpeg(src, dst, af, stereo=False, bitrate='64k'):
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-af', f'{af},loudnorm=I=-16:TP=-1.5', '-ac', '2' if stereo else '1', '-b:a', bitrate, dst]
    subprocess.run(cmd, check=True)


def voices(manifest):
    for unit, cats in LINES.items():
        vid, filt = VOICES[unit]
        for cat, lines in cats.items():
            files = []
            for i, text in enumerate(lines):
                name = f'vo_{unit}_{cat}_{i}'
                raw = os.path.join(RAW, name + '.mp3')
                if post(f'/text-to-speech/{vid}?output_format=mp3_44100_128', {'text': text, 'model_id': 'eleven_multilingual_v2', 'voice_settings': {'stability': 0.45, 'similarity_boost': 0.8, 'style': 0.35}}, raw):
                    print('voz', name, text)
                if os.path.exists(raw):
                    ffmpeg(raw, os.path.join(OUT, name + '.mp3'), FILTERS[filt])
                    files.append(name)
            manifest.setdefault(unit, {})[cat] = files


def sfx(manifest):
    for name, (prompt, dur) in SFX.items():
        raw = os.path.join(RAW, name + '.mp3')
        if post('/sound-generation', {'text': prompt, 'duration_seconds': dur, 'prompt_influence': 0.5}, raw):
            print('sonido', name)
        if os.path.exists(raw):
            ffmpeg(raw, os.path.join(OUT, name + '.mp3'), 'afade=t=out:st=%.2f:d=0.4' % (dur - 0.4), bitrate='80k')
            unit, cat = name.split('_', 1)
            manifest.setdefault(unit, {})[cat] = [name]


def game_sfx(manifest):
    out = {}
    for name, (prompt, dur) in GAME_SFX.items():
        file = f'sfx_{name}'
        raw = os.path.join(RAW, file + '.mp3')
        if post('/sound-generation', {'text': prompt, 'duration_seconds': dur, 'prompt_influence': 0.6}, raw):
            print('efecto', name)
        if os.path.exists(raw):
            fade = max(0.05, min(0.3, dur * 0.2))
            ffmpeg(raw, os.path.join(OUT, file + '.mp3'), f'afade=t=out:st={dur - fade:.2f}:d={fade:.2f}', bitrate='80k')
            out[name] = [file]
    manifest['sfx'] = out


def ambient(manifest):
    names = []
    for name, (prompt, dur) in AMBIENT.items():
        raw = os.path.join(RAW, name + '.mp3')
        if post('/sound-generation', {'text': prompt, 'duration_seconds': dur, 'prompt_influence': 0.4}, raw):
            print('ambiente', name)
        if os.path.exists(raw):
            # Bucle sin corte: fundido cruzado del final con el principio (1,5 s).
            d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw], capture_output=True, text=True).stdout)
            x = 1.5
            af = (f'[0]atrim=0:{x},asetpts=PTS-STARTPTS[head];[0]atrim={x}:{d - x},asetpts=PTS-STARTPTS[body];'
                  f'[0]atrim={d - x}:{d},asetpts=PTS-STARTPTS[tail];[tail][head]acrossfade=d={x}:c1=tri:c2=tri[seam];'
                  f'[body][seam]concat=n=2:v=0:a=1,loudnorm=I=-20:TP=-2')
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', raw, '-filter_complex', af, '-ac', '2', '-b:a', '112k', os.path.join(OUT, name + '.mp3')], check=True)
            names.append(name)
    manifest['music'] = names


def music(manifest):
    prompt, ms = MUSIC
    raw = os.path.join(RAW, 'music_main.mp3')
    if post('/music', {'prompt': prompt, 'music_length_ms': ms, 'force_instrumental': True}, raw):
        print('música generada')
    if os.path.exists(raw):
        dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw], capture_output=True, text=True).stdout)
        ffmpeg(raw, os.path.join(OUT, 'music_main.mp3'), f'afade=t=in:d=2,afade=t=out:st={dur - 4:.2f}:d=4', stereo=True, bitrate='112k')
        manifest['music'] = ['music_main']


path = os.path.join(OUT, 'manifest.json')
manifest = json.load(open(path)) if os.path.exists(path) else {}
what = sys.argv[1:] or ['voces', 'sfx', 'musica']
if 'voces' in what:
    voices(manifest)
if 'sfx' in what:
    sfx(manifest)
if 'musica' in what:
    music(manifest)
if 'ambiente' in what:
    ambient(manifest)
if 'efectos' in what:
    game_sfx(manifest)
json.dump(manifest, open(path, 'w'), indent=1, ensure_ascii=False)
print('listo:', sum(len(v) if isinstance(v, list) else sum(len(x) for x in v.values()) for v in manifest.values()), 'archivos')
