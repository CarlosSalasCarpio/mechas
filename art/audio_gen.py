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
    'artillery': ('cgSgspJ2msm6clMCkdW9', 'angel'),    # Jessica (dulce; español forzado: sin acento)
    'truck': ('iP95p4xoKVk53GoZ742B', 'radio'),        # Chris
    'announcer': ('pqHfZKP75CvOlQylNhV4', 'pa'),       # Bill (sabio, pausado)
    # --- Huestes: acólito masculino, ángeles femeninos, órdenes superiores en pseudolatín.
    # Voces nativas de la biblioteca (plan de pago): español latino neutro y, para el pseudolatín, italiano.
    'h_worker': ('94zOad0g7T7K4oa7zhDq', 'chapel'),     # Mauricio (es, neutro)
    'h_soldier': ('2rigMbVWLdqtBSCahJFX', 'chapel'),    # Tatiana (es, neutra)
    'h_mech': ('13Cuh3NuYvWOVQtLbRN8', 'cathedral'),    # Marco (it, grave)
    'h_artillery': ('CnVVMwhKmKZ6hKBAkL6Y', 'cathedral'),  # Giulia (it, dulce)
    'h_truck': ('BZc8d1MPTdZkyGbE9Sin', 'cathedral'),   # Luna (it)
    'h_colossus': ('fQmr8dTaOQq116mo2X7F', 'choir'),    # Samanta (it), doblada
    'h_siege': ('UlwxMDtxqMDYmG6pk2q6', 'choir'),       # Luca Brasi (it), doblada
    'h_announcer': ('qBvury71WUJfVeT1STkG', 'cathedral'),  # Samanta (es)
}

# Idioma forzado (modelo turbo v2.5): español sin acento; italiano para que el pseudolatín suene cantado.
LANG = {'artillery': 'es', 'announcer': 'es'}
# Las voces nativas no necesitan forzar idioma: se usa el modelo de más calidad, más pausado si es solemne.
NATIVE = {'h_worker', 'h_soldier', 'h_announcer', 'h_mech', 'h_artillery', 'h_truck', 'h_colossus', 'h_siege'}

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
    'h_worker': {
        'select': ['¿Sí, hermano?', 'Sirvo con gusto.', 'La luz provee.', 'Aquí estoy.'],
        'move': ['Voy.', 'Con humildad.'],
        'build': ['Alzaré los muros.', 'Piedra bendecida.', 'Que perdure.'],
        'gather': ['Recojo la ofrenda.', 'Lo que la tierra entrega.'],
    },
    'h_soldier': {
        'select': ['Te escuchamos.', 'Estamos contigo.', 'Nuestras alas son tuyas.', 'Ordena.'],
        'move': ['Volamos.', 'Vamos.', 'Como desees.'],
        'attack': ['¡Por la luz!', 'Caed.', 'Que ardan.'],
    },
    'h_mech': {
        'select': ['Lumina verae, adsum.', 'Oriens altae, domé.', 'Aeterna voxa, solae.'],
        'move': ['Vadem, lumine.', 'Ambulae.', 'Procedo, astaré.'],
        'attack': ['Ignis iudicae!', 'Fulgur aeterna!', 'Cadé, umbrae!'],
    },
    'h_artillery': {
        'select': ['Stellae audio.', 'Cantum paratae.', 'Vidé, lumena.'],
        'move': ['Migro, solae.', 'Ascendo.'],
        'attack': ['Caelum cadet!', 'Radiae, ferí!', 'Lux descendat!'],
    },
    'h_truck': {
        'select': ['Rota vigilae.', 'Oculi mille vident.', 'Orbis audit.'],
        'move': ['Volvor.', 'Rotae, migrate.'],
        'deploy': ['Terra consacrae.', 'Hic lumen manet.'],
        'undeploy': ['Recolligo orbem.'],
    },
    'h_colossus': {
        'select': ['Seraé, ignis aeterna.', 'Sex alae, una vox.', 'Ardeo pro te.'],
        'move': ['Ascendae, gloriae.', 'Volemus.'],
        'attack': ['Combure!', 'Flamma veritae!', 'Omnia ardent!'],
    },
    'h_siege': {
        'select': ['Custos portae, adsum.', 'Quattuor vultus, unum verbum.', 'Vigilo.'],
        'move': ['Gradior.', 'Custodia procedit.'],
        'attack': ['Iudicium!', 'Murus cadet!', 'Fulmen custodis!'],
    },
    'h_announcer': {
        'built': ['El santuario se alza.'],
        'trained': ['Un nuevo ser despierta.'],
        'attacked': ['Nos asedian.', 'La tierra santa es atacada.'],
        'powerlost': ['Un hijo de la luz ha perdido la gracia.'],
        'generation': ['Ascendemos de esfera. La luz nos llama.'],
        'enemycolossus': ['El enemigo invoca a un gigante.'],
        'colossus': ['Un serafín ha descendido.'],
        'reactor': ['Su luz se apaga.'],
        'enemydefeated': ['Un adversario ha caído en la sombra.', 'La luz prevalece sobre ellos.'],
        'victory': ['Victoria. La luz es eterna.'],
        'defeat': ['Derrota. Que la luz nos recuerde.'],
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
        'enemydefeated': ['Un enemigo ha caído. Que su alma encuentre reposo.', 'El adversario ha sido purgado. La luz prevalece.'],
        'victory': ['Victoria. El cielo es nuestro.'],
        'defeat': ['Derrota. Que el silencio nos perdone.'],
    },
}

# Colosos: sin voz, sonidos generados.
SFX = {
    'colossus_select': ('Soft ethereal angelic choir humming a gentle sustained chord, distant and airy, calm and holy, no percussion', 3.0),
    'colossus_move': ('Soft ethereal angelic choir breathing a gentle rising chord, airy and holy, with a faint muffled distant footstep', 2.5),
    'colossus_attack': ('Soft angelic choir swell ending in a deep muffled distant thud, holy and calm', 2.5),
    'siege_select': ('Fast metallic fan blades spinning with a low electric buzz, like a big drone hovering, mechanical', 2.5),
    'siege_move': ('Metallic fan blades spinning up with a low electric buzz, a big drone flying forward, mechanical', 2.5),
    'siege_attack': ('Big drone rotor buzz rising quickly followed by a short rocket launch whoosh, mechanical', 2.5),
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

# Efectos de las Huestes: mismos momentos, sonido místico (cristal, campanas, coro, luz).
H_GAME_SFX = {
    'shotSoldier': ('Short crystalline holy light bolt, bright shimmering energy zap with a tiny bell chime, magical', 0.6),
    'shotMech': ('Radiant beam of holy light firing, soaring shimmering energy burst with a faint choir note', 0.9),
    'shotColossus': ('Massive beam of divine light with a short angelic choir swell and deep resonant hum', 1.4),
    'hit': ('Soft crystal impact chime, small shimmering spark', 0.5),
    'shotTower': ('Deep temple bell struck once with an energy pulse, resonant', 0.8),
    'launch': ('Burning sword of light thrown through the air, fiery whoosh with a shimmering choir trail', 1.5),
    'mortar': ('Celestial thrum and rising shimmer, a sphere of holy light launched upward', 1.0),
    'explosionSmall': ('Small burst of holy light, sparkling crystalline shatter with a soft choir breath', 1.0),
    'explosion': ('Large explosion of divine light, glassy shimmering blast with a dramatic choir swell and rumble', 2.0),
    'repair': ('Gentle chime and soft stone grinding, a blessing being restored', 1.0),
    'gather': ('Single soft crystal chime, a pickaxe striking glowing ore', 0.5),
    'deliver': ('Coins of light dropped into a stone offering bowl, soft chimes', 0.6),
    'built': ('Stone temple completed: heavy stone settling followed by a warm angelic choir chord', 1.8),
    'trained': ('Ethereal angelic chime and soft wings flutter, a holy being awakens', 1.4),
    'death': ('Soft fading sigh with a dissolving shimmering chime, a spirit departing', 0.9),
    'deathBig': ('Giant holy construct shattering like crystal, collapsing with a fading mournful choir', 2.2),
    'destroyed': ('Sacred temple crumbling, stone collapse with a fading choir and breaking bells', 2.5),
    'warning': ('Single low ominous temple bell toll', 1.0),
    'genUp': ('Heavenly choir ascending chord with shimmering bells, divine ascension', 2.5),
    'powerDown': ('Holy light fading out, descending shimmering tone', 1.2),
    'alert': ('Urgent tolling of a large cathedral bell, two strikes', 1.6),
    'place': ('Stone foundation placed with a soft bell chime', 0.6),
    'victory': ('Short triumphant choral fanfare with bells, glorious and holy', 4.0),
    'defeat': ('Short somber choir lament with a single distant bell', 4.0),
}

# Ambiente musical con la API de efectos (la de música es solo de pago): bucles largos de coro y órgano.
AMBIENT = {
    'ambient_hymn1': ('Seamless loop of a slow melodic ethereal choir singing a beautiful wordless hymn melody, soft strings and warm pads underneath, mystical and epic, ambient strategy game background music, no percussion', 22.0),
    'ambient_hymn2': ('Seamless loop of a melodic female choir and soft male choir in harmony, gentle orchestral strings, distant timpani swells, majestic and hopeful, cinematic ambient background music for a strategy game', 22.0),
    'ambient_hymn3': ('Seamless loop of a calm melodic choir with a slow haunting melody over a soft synthesizer pad and light harp arpeggios, mysterious and sacred, ambient background music', 22.0),
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
    # Capilla: reverberación íntima de piedra.
    'chapel': 'highpass=f=120,aecho=0.8:0.55:45|90:0.25|0.12',
    # Catedral: reverberación larga y alta.
    'cathedral': 'highpass=f=100,aecho=0.85:0.75:110|230|390:0.38|0.26|0.16',
    # Coro: la voz doblada una octava más grave, todo en una nave de catedral (ver ffmpeg()).
    'choir': 'CHOIR',
    # Angelical: reverberación etérea suave.
    'angel': 'highpass=f=200,aecho=0.8:0.6:90|180:0.25|0.12',
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
    if af == 'CHOIR':
        fc = ('[0]asplit=3[a][b][c];[b]asetrate=44100*0.5,aresample=44100,volume=0.55[low];'
              '[c]asetrate=44100*0.75,aresample=44100,volume=0.35[mid];[a][low][mid]amix=inputs=3:normalize=0,'
              'highpass=f=70,aecho=0.85:0.8:140|300|520:0.42|0.3|0.2,loudnorm=I=-16:TP=-1.5')
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-filter_complex', fc, '-ac', '1', '-b:a', bitrate, dst]
    else:
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
                body = {'text': text, 'model_id': 'eleven_multilingual_v2', 'voice_settings': {'stability': 0.45, 'similarity_boost': 0.8, 'style': 0.35}}
                if unit in NATIVE:
                    solemn = unit not in ('h_worker', 'h_soldier')
                    body = {'text': text, 'model_id': 'eleven_multilingual_v2', 'voice_settings': {'stability': 0.6 if solemn else 0.5, 'similarity_boost': 0.8, 'style': 0.35 if solemn else 0.25, 'speed': 0.88 if solemn else 1.0}}
                elif unit in LANG:
                    solemn = unit.endswith('announcer') or LANG[unit] == 'it'
                    body = {'text': text, 'model_id': 'eleven_turbo_v2_5', 'language_code': LANG[unit], 'voice_settings': {'stability': 0.65 if solemn else 0.55, 'similarity_boost': 0.75, 'style': 0.25 if solemn else 0.2, 'speed': 0.85 if solemn else 1.0}}
                if post(f'/text-to-speech/{vid}?output_format=mp3_44100_128', body, raw):
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
            # Suavizado: sin agudos estridentes, comprimido y más bajo que las voces.
            af = 'lowpass=f=7000,acompressor=threshold=0.25:ratio=3,afade=t=in:d=0.15,afade=t=out:st=%.2f:d=0.5' % (dur - 0.5)
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', raw, '-af', af + ',loudnorm=I=-20:TP=-3', '-ac', '1', '-b:a', '80k', os.path.join(OUT, name + '.mp3')], check=True)
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


def h_game_sfx(manifest):
    out = {}
    for name, (prompt, dur) in H_GAME_SFX.items():
        file = f'hsfx_{name}'
        raw = os.path.join(RAW, file + '.mp3')
        if post('/sound-generation', {'text': prompt, 'duration_seconds': dur, 'prompt_influence': 0.6}, raw):
            print('efecto huestes', name)
        if os.path.exists(raw):
            fade = max(0.05, min(0.3, dur * 0.2))
            ffmpeg(raw, os.path.join(OUT, file + '.mp3'), f'afade=t=out:st={dur - fade:.2f}:d={fade:.2f}', bitrate='80k')
            out[name] = [file]
    manifest['h_sfx'] = out


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
if 'efectos_h' in what:
    h_game_sfx(manifest)
json.dump(manifest, open(path, 'w'), indent=1, ensure_ascii=False)
print('listo:', sum(len(v) if isinstance(v, list) else sum(len(x) for x in v.values()) for v in manifest.values()), 'archivos')
