/**
 * Efectos de sonido: grabados con ElevenLabs (art/audio_gen.py, `efectos`) cuando están cargados; si no
 * (o mientras cargan), sintetizados con osciladores y ruido filtrado.
 */
export type SoundName =
  | 'shotSoldier'
  | 'shotMech'
  | 'shotColossus'
  | 'hit'
  | 'shotTower'
  | 'warning'
  | 'genUp'
  | 'powerDown'
  | 'launch'
  | 'mortar'
  | 'explosionSmall'
  | 'explosion'
  | 'repair'
  | 'gather'
  | 'deliver'
  | 'built'
  | 'trained'
  | 'death'
  | 'deathBig'
  | 'destroyed'
  | 'ack'
  | 'ackAttack'
  | 'place'
  | 'error'
  | 'alert'
  | 'victory'
  | 'defeat';

/** Separación mínima (ms) entre dos reproducciones del mismo sonido, para que una batalla no sature. */
const THROTTLE: Partial<Record<SoundName, number>> = {
  shotSoldier: 45,
  shotMech: 80,
  shotColossus: 140,
  hit: 70,
  shotTower: 60,
  warning: 700,
  powerDown: 300,
  launch: 120,
  mortar: 90,
  explosionSmall: 90,
  explosion: 120,
  repair: 150,
  gather: 110,
  deliver: 120,
  death: 60,
  deathBig: 120,
  ack: 60,
  ackAttack: 60,
};

/** Volumen relativo de los efectos grabados (los de batalla, más bajos: suenan muchas veces a la vez). */
const SAMPLE_GAIN: Partial<Record<SoundName, number>> = {
  shotSoldier: 0.45,
  hit: 0.45,
  gather: 0.5,
  shotMech: 0.6,
  shotTower: 0.6,
  ack: 0.5,
  ackAttack: 0.5,
  repair: 0.5,
  deliver: 0.6,
  death: 0.6,
  victory: 1.1,
  defeat: 1.1,
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private readonly last = new Map<SoundName, number>();
  muted = false;
  /** Busca el efecto grabado de un sonido (lo provee Voices cuando termina de cargar los audios). */
  samples?: (name: SoundName, prefix: string) => AudioBuffer | null;
  /** Facción del sonido en curso: 'h_' usa los efectos de las Huestes si existen. */
  prefix = '';

  /** El AudioContext (existe tras el primer gesto del usuario). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Los navegadores solo permiten audio tras un gesto del usuario: llamar desde un clic o tecla. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** `pan` de -1 (izquierda) a 1 (derecha); `vol` multiplica el volumen del sonido. */
  play(name: SoundName, pan = 0, vol = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || ctx.state !== 'running') return;
    const now = performance.now();
    const gap = THROTTLE[name] ?? 0;
    if (gap && now - (this.last.get(name) ?? -Infinity) < gap) return;
    this.last.set(name, now);

    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    const g = ctx.createGain();
    g.gain.value = vol;
    out.connect(g).connect(this.master);
    const t = ctx.currentTime;
    // Efecto grabado (ElevenLabs) si está cargado, con una leve variación de tono para que no se repita igual.
    const sample = this.samples?.(name, this.prefix);
    if (sample) {
      const src = ctx.createBufferSource();
      src.buffer = sample;
      src.playbackRate.value = 0.93 + Math.random() * 0.14;
      g.gain.value = vol * (SAMPLE_GAIN[name] ?? 0.9);
      src.connect(out);
      src.start(t);
      return;
    }
    const tone = (f0: number, f1: number, type: OscillatorType, start: number, dur: number, gain: number) => {
      const o = ctx.createOscillator();
      const e = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t + start);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + start + dur);
      e.gain.setValueAtTime(0.0001, t + start);
      e.gain.exponentialRampToValueAtTime(gain, t + start + 0.005);
      e.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(e).connect(out);
      o.start(t + start);
      o.stop(t + start + dur + 0.02);
    };
    const noise = (filter: BiquadFilterType, f0: number, f1: number, start: number, dur: number, gain: number, q = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      const fl = ctx.createBiquadFilter();
      fl.type = filter;
      fl.Q.value = q;
      fl.frequency.setValueAtTime(f0, t + start);
      if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(f1, t + start + dur);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t + start);
      e.gain.exponentialRampToValueAtTime(gain, t + start + 0.004);
      e.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      s.connect(fl).connect(e).connect(out);
      s.start(t + start, Math.random() * 0.5);
      s.stop(t + start + dur + 0.02);
    };

    switch (name) {
      case 'shotSoldier':
        noise('bandpass', 2200, 1200, 0, 0.07, 0.5, 1.2);
        tone(190, 120, 'square', 0, 0.03, 0.08);
        break;
      case 'shotMech':
        noise('lowpass', 1400, 300, 0, 0.22, 0.8);
        tone(140, 50, 'sawtooth', 0, 0.22, 0.22);
        break;
      case 'shotColossus':
        tone(900, 180, 'sine', 0, 0.5, 0.18);
        tone(220, 40, 'sawtooth', 0.02, 0.7, 0.3);
        noise('lowpass', 800, 90, 0.02, 0.7, 0.6);
        break;
      case 'mortar':
        // Mortero: golpe grave y seco con un silbido que se aleja.
        tone(120, 45, 'sine', 0, 0.25, 0.4);
        noise('lowpass', 900, 200, 0, 0.18, 0.7);
        tone(1800, 900, 'sine', 0.05, 0.5, 0.03);
        break;
      case 'explosionSmall':
        noise('lowpass', 2200, 120, 0, 0.6, 0.8);
        tone(160, 50, 'sawtooth', 0, 0.4, 0.25);
        break;
      case 'launch':
        // Encendido del cohete: soplido que sube de tono mientras gana velocidad.
        noise('bandpass', 400, 2400, 0, 1.1, 0.5, 0.8);
        noise('lowpass', 700, 200, 0, 0.35, 0.8);
        tone(90, 60, 'sawtooth', 0, 0.3, 0.15);
        break;
      case 'explosion':
        noise('lowpass', 1600, 60, 0, 1.3, 1);
        tone(110, 28, 'sawtooth', 0, 1.1, 0.4);
        noise('bandpass', 3000, 900, 0.05, 0.5, 0.3, 1.5);
        break;
      case 'genUp':
        // Subida de generación: acorde ascendente y un brillo agudo.
        [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, f, 'triangle', i * 0.08, 0.5, 0.12));
        tone(1568, 1568, 'sine', 0.5, 0.6, 0.06);
        break;
      case 'warning':
        // Aviso de "fuera de la red": dos pitidos agudos.
        tone(1400, 1400, 'square', 0, 0.08, 0.07);
        tone(1400, 1400, 'square', 0.14, 0.08, 0.07);
        break;
      case 'powerDown':
        // Apagado: un tono que cae, como un motor que se detiene.
        tone(600, 60, 'sawtooth', 0, 0.9, 0.12);
        noise('lowpass', 800, 100, 0, 0.5, 0.2);
        break;
      case 'shotTower':
        noise('bandpass', 1600, 700, 0, 0.12, 0.6, 1);
        tone(320, 140, 'square', 0, 0.06, 0.1);
        break;
      case 'repair':
        tone(1200, 900, 'square', 0, 0.03, 0.05);
        noise('highpass', 2500, 2500, 0, 0.05, 0.25);
        break;
      case 'hit':
        tone(950, 700, 'triangle', 0, 0.05, 0.15);
        noise('highpass', 3000, 3000, 0, 0.04, 0.2);
        break;
      case 'gather':
        tone(1760, 1760, 'sine', 0, 0.14, 0.12);
        tone(4850, 4850, 'sine', 0, 0.07, 0.04);
        break;
      case 'deliver':
        tone(880, 880, 'triangle', 0, 0.07, 0.12);
        tone(1320, 1320, 'triangle', 0.07, 0.1, 0.12);
        break;
      case 'built':
        [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 'triangle', i * 0.09, 0.22, 0.16));
        break;
      case 'trained':
        tone(660, 990, 'square', 0, 0.08, 0.06);
        tone(990, 990, 'triangle', 0.08, 0.08, 0.1);
        break;
      case 'death':
        noise('bandpass', 700, 300, 0, 0.16, 0.3, 0.8);
        tone(220, 80, 'triangle', 0, 0.14, 0.1);
        break;
      case 'deathBig':
        noise('lowpass', 900, 60, 0, 0.9, 1);
        tone(90, 30, 'sawtooth', 0, 0.8, 0.35);
        break;
      case 'destroyed':
        noise('lowpass', 1200, 50, 0, 1.4, 1);
        tone(70, 25, 'sawtooth', 0, 1.2, 0.35);
        noise('bandpass', 2500, 800, 0.15, 0.6, 0.25, 2);
        break;
      case 'ack':
        tone(720, 820, 'sine', 0, 0.06, 0.12);
        break;
      case 'ackAttack':
        tone(440, 330, 'square', 0, 0.08, 0.07);
        break;
      case 'place':
        tone(300, 300, 'square', 0, 0.05, 0.06);
        noise('lowpass', 600, 200, 0, 0.12, 0.35);
        break;
      case 'error':
        tone(160, 140, 'square', 0, 0.15, 0.08);
        break;
      case 'alert': {
        // Sirena: dos subidas y bajadas.
        const o = ctx.createOscillator();
        const e = ctx.createGain();
        o.type = 'sawtooth';
        for (let i = 0; i < 2; i++) {
          o.frequency.setValueAtTime(420, t + i * 0.9);
          o.frequency.linearRampToValueAtTime(880, t + i * 0.9 + 0.45);
          o.frequency.linearRampToValueAtTime(420, t + i * 0.9 + 0.9);
        }
        e.gain.setValueAtTime(0.0001, t);
        e.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
        e.gain.setValueAtTime(0.12, t + 1.7);
        e.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
        o.connect(e).connect(out);
        o.start(t);
        o.stop(t + 1.85);
        break;
      }
      case 'victory':
        [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, f, 'triangle', i * 0.14, i === 4 ? 1.2 : 0.3, 0.2));
        break;
      case 'defeat':
        [392, 349, 311, 262].forEach((f, i) => tone(f, f * (i === 3 ? 0.97 : 1), 'sawtooth', i * 0.28, i === 3 ? 1.4 : 0.35, 0.1));
        break;
    }
  }
}

/**
 * Voces de las unidades, avisos de la base y música ambiente (generados con ElevenLabs: art/audio_gen.py).
 * Una sola voz de unidad a la vez (la nueva corta a la anterior, como en AoE2); los avisos van por su
 * propio canal y cada uno tiene un tiempo mínimo entre repeticiones.
 */
export class Voices {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private manifest: Record<string, Record<string, string[]> | string[]> = {};
  private readonly buffers = new Map<string, AudioBuffer>();
  private unitVoice: AudioBufferSourceNode | null = null;
  private announcerBusy = 0;
  private readonly lastCat = new Map<string, number>();
  private readonly turn = new Map<string, number>();
  private musicStarted = false;
  muted = false;
  /** Prefijo de las voces de la facción del jugador ('h_' para las Huestes); si falta, la voz común. */
  prefix = '';

  /** Carga el índice y decodifica los audios (tras el primer gesto del usuario, que crea el AudioContext). */
  async init(ctx: AudioContext, dest: AudioNode): Promise<void> {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1.4;
    this.out.connect(dest);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.32;
    this.musicGain.connect(dest);
    try {
      this.manifest = await (await fetch('audio/manifest.json')).json();
    } catch {
      return;
    }
    const names = Object.values(this.manifest).flatMap((v) => (Array.isArray(v) ? v : Object.values(v).flat()));
    await Promise.all(
      names.map(async (n) => {
        try {
          const data = await (await fetch(`audio/${n}.mp3`)).arrayBuffer();
          this.buffers.set(n, await ctx.decodeAudioData(data));
        } catch {
          /* sin ese audio */
        }
      }),
    );
    this.startMusic();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(m ? 0 : 0.32, this.ctx.currentTime, 0.3);
  }

  /** Efecto grabado del juego por nombre (`sfx` del manifest), o null. */
  effect(name: string, prefix = ''): AudioBuffer | null {
    const own = prefix ? this.manifest[`${prefix}sfx`] : undefined;
    const file0 = own && !Array.isArray(own) ? own[name]?.[0] : undefined;
    if (file0 && this.buffers.has(file0)) return this.buffers.get(file0)!;
    const group = this.manifest.sfx;
    const file = group && !Array.isArray(group) ? group[name]?.[0] : undefined;
    return file ? (this.buffers.get(file) ?? null) : null;
  }

  private pick(unit: string, cat: string): AudioBuffer | null {
    const own = this.manifest[this.prefix + unit];
    if (this.prefix && own && !Array.isArray(own) && own[cat]?.length) unit = this.prefix + unit;
    const group = this.manifest[unit];
    const list = group && !Array.isArray(group) ? group[cat] : undefined;
    if (!list?.length) return null;
    const key = `${unit}.${cat}`;
    const i = this.turn.get(key) ?? Math.floor(Math.random() * list.length);
    this.turn.set(key, (i + 1) % list.length);
    return this.buffers.get(list[i]) ?? null;
  }

  private play(buf: AudioBuffer, vol = 1): AudioBufferSourceNode | null {
    if (!this.ctx || !this.out) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.out);
    src.start();
    return src;
  }

  /** Respuesta de una unidad propia (seleccionar, mover, atacar...). `gap` evita repetirla en ráfaga. */
  unit(unit: string, cat: string, gap = 350): void {
    if (this.muted || !this.ctx) return;
    const now = performance.now();
    if (now - (this.lastCat.get('unit') ?? 0) < gap) return;
    const buf = this.pick(unit, cat);
    if (!buf) return;
    this.lastCat.set('unit', now);
    try {
      this.unitVoice?.stop();
    } catch {
      /* ya terminó */
    }
    this.unitVoice = this.play(buf);
  }

  /** Aviso de la voz de mando. `gap` (ms) es el tiempo mínimo entre dos avisos de ese tipo. */
  announce(cat: string, gap = 8000): void {
    if (this.muted || !this.ctx) return;
    const now = performance.now();
    // Los avisos sin tiempo mínimo (gap 0) son los importantes: no esperan a que termine otro.
    if (now - (this.lastCat.get(cat) ?? -1e9) < gap || (gap > 0 && now < this.announcerBusy)) return;
    const buf = this.pick('announcer', cat);
    if (!buf) return;
    this.lastCat.set(cat, now);
    this.announcerBusy = now + buf.duration * 1000;
    this.play(buf, 0.9);
  }

  /** Música: alterna los bucles de ambiente (cada uno suena dos vueltas) con un fundido entre ellos. */
  private startMusic(): void {
    const tracks = (Array.isArray(this.manifest.music) ? this.manifest.music : []).map((n) => this.buffers.get(n)).filter((b): b is AudioBuffer => !!b);
    if (!tracks.length || this.musicStarted || !this.ctx || !this.musicGain) return;
    this.musicStarted = true;
    let i = 0;
    const next = () => {
      const ctx = this.ctx!;
      const buf = tracks[i++ % tracks.length];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 3);
      const dur = buf.duration * 2;
      g.gain.setValueAtTime(1, t + dur - 3);
      g.gain.linearRampToValueAtTime(0, t + dur);
      src.connect(g).connect(this.musicGain!);
      src.start(t);
      src.stop(t + dur + 0.1);
      setTimeout(next, (dur - 3) * 1000);
    };
    next();
  }
}
