import { settings } from './settings';

export type Sfx =
  | 'step'
  | 'jump'
  | 'land'
  | 'swordSwing'
  | 'axeSwing'
  | 'hit'
  | 'crit'
  | 'hurt'
  | 'death'
  | 'place'
  | 'break'
  | 'mine'
  | 'bed'
  | 'powerup'
  | 'victory'
  | 'defeat'
  | 'click';

/**
 * Procedural Web Audio engine — every sound is synthesized, so the game ships
 * with zero audio assets. Master / music / SFX volumes come from settings.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain!: GainNode;
  private sfxGain!: GainNode;
  private musicGain!: GainNode;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private started = false;
  private readonly lastPlayed = new Map<Sfx, number>();

  /** Must be called from a user gesture (pointer lock / click) to unlock audio. */
  resume(): void {
    if (!this.ctx) this.init();
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  private init(): void {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    this.masterGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    settings.subscribe((s) => this.applyVolumes(s.masterVolume, s.musicVolume, s.sfxVolume));
  }

  private applyVolumes(master: number, music: number, sfx: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(master, t, 0.05);
    this.musicGain.gain.setTargetAtTime(music * 0.5, t, 0.05);
    this.sfxGain.gain.setTargetAtTime(sfx, t, 0.05);
  }

  play(name: Sfx): void {
    if (!this.ctx) return;
    const nowMs = performance.now();
    const minGapMs = name === 'death' ? 500
      : name === 'hurt' ? 90
        : name === 'crit' ? 70
          : name === 'hit' ? 45
            : name === 'axeSwing' ? 90
              : name === 'swordSwing' ? 60
                : 0;
    if (nowMs - (this.lastPlayed.get(name) ?? -Infinity) < minGapMs) return;
    this.lastPlayed.set(name, nowMs);

    const c = this.ctx;
    const t = c.currentTime;
    switch (name) {
      case 'step':
        this.noise(0.05, 900, 0.08, t); break;
      case 'jump':
        this.tone('square', 320, 520, 0.10, 0.12, t); break;
      case 'land':
        this.noise(0.10, 400, 0.18, t); break;
      case 'swordSwing':
        this.noise(0.09, 1700, 0.13, t, 'highpass');
        this.tone('triangle', 420, 260, 0.08, 0.08, t); break;
      case 'axeSwing':
        this.noise(0.13, 900, 0.18, t, 'highpass');
        this.tone('sawtooth', 190, 105, 0.11, 0.09, t); break;
      case 'hit':
        this.tone('square', 180, 90, 0.12, 0.22, t); this.noise(0.06, 500, 0.12, t); break;
      case 'crit':
        this.tone('sawtooth', 240, 120, 0.14, 0.22, t); this.tone('square', 600, 900, 0.10, 0.14, t + 0.02); break;
      case 'hurt':
        this.tone('sawtooth', 155, 95, 0.16, 0.17, t); this.noise(0.08, 420, 0.08, t); break;
      case 'death':
        this.tone('sawtooth', 180, 45, 0.42, 0.22, t); this.noise(0.24, 320, 0.14, t + 0.04); break;
      case 'place':
        this.tone('triangle', 180, 220, 0.07, 0.14, t); break;
      case 'break':
        this.noise(0.16, 700, 0.24, t); this.tone('triangle', 160, 80, 0.12, 0.12, t); break;
      case 'mine':
        this.noise(0.05, 1200, 0.06, t); break;
      case 'bed':
        this.tone('sawtooth', 300, 60, 0.5, 0.3, t); this.noise(0.4, 500, 0.25, t); break;
      case 'powerup':
        this.arp([523, 659, 784, 1046], 0.08, 0.18, t); break;
      case 'victory':
        this.arp([523, 659, 784, 1046, 1318], 0.16, 0.28, t); break;
      case 'defeat':
        this.arp([523, 415, 349, 262], 0.18, 0.28, t); break;
      case 'click':
        this.tone('square', 660, 660, 0.03, 0.10, t); break;
    }
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, t: number): void {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxGain);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, cutoff: number, vol: number, t: number, filter: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx) return;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start(t);
  }

  private arp(freqs: number[], step: number, vol: number, t: number): void {
    freqs.forEach((f, i) => this.tone('triangle', f, f, step * 1.4, vol, t + i * step));
  }

  startMusic(): void {
    if (!this.ctx || this.started) return;
    this.started = true;
    // Gentle ambient pad arpeggio loop (very low, non-intrusive).
    const scale = [261.6, 329.6, 392.0, 523.2, 392.0, 329.6];
    const tick = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const f = scale[this.musicStep % scale.length];
      this.musicStep++;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g).connect(this.musicGain);
      o.start(t);
      o.stop(t + 1.7);
    };
    tick();
    this.musicTimer = window.setInterval(tick, 1400);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    this.started = false;
  }
}

export const audio = new AudioManager();
