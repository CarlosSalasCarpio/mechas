/**
 * Efectos de sonido sintetizados con Web Audio: no hay archivos, cada sonido se arma con osciladores
 * y ruido filtrado. Son provisionales, igual que las siluetas; más adelante se reemplazan por audio real.
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

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private readonly last = new Map<SoundName, number>();
  muted = false;

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
