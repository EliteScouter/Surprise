// Generative ambience: every world type has its own chord, its own wind, its own breath.
const CHORDS = {
  terran: [0, 7, 14, 16, 21], ocean: [0, 9, 14, 19, 26], desert: [0, 5, 10, 15, 22], ice: [0, 7, 11, 18, 23],
  lava: [0, 3, 7, 10, 13], gas: [0, 7, 12, 19, 24], barren: [0, 5, 12, 17, 19], toxic: [0, 6, 11, 13, 18], galaxy: [0, 7, 12, 16, 23],
};
const ROOT = { terran: 48, ocean: 46, desert: 45, ice: 52, lava: 40, gas: 38, barren: 43, toxic: 47, galaxy: 41 };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class Ambience {
  constructor() { this.ctx = null; this.on = false; this.voices = []; this.mood = 'galaxy'; }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    // simple feedback-delay "space" reverb
    const delay = ctx.createDelay(2); delay.delayTime.value = 0.43;
    const fb = ctx.createGain(); fb.gain.value = 0.42;
    const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2200;
    delay.connect(damp); damp.connect(fb); fb.connect(delay);
    this.bus = ctx.createGain();
    this.bus.connect(comp); this.bus.connect(delay); delay.connect(comp);
    comp.connect(this.master); this.master.connect(ctx.destination);

    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 700; this.filter.Q.value = 2;
    this.filter.connect(this.bus);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 380;
    lfo.connect(lfoGain); lfoGain.connect(this.filter.frequency); lfo.start();

    // wind
    const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995; d[i] = last * 6; }
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    this.wind = ctx.createBiquadFilter(); this.wind.type = 'bandpass'; this.wind.frequency.value = 500; this.wind.Q.value = 0.7;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.25;
    noise.connect(this.wind); this.wind.connect(this.windGain); this.windGain.connect(this.bus); noise.start();
    const wl = ctx.createOscillator(); wl.frequency.value = 0.07; const wg = ctx.createGain(); wg.gain.value = 300;
    wl.connect(wg); wg.connect(this.wind.frequency); wl.start();
  }

  setMood(type, civ = 0) {
    this.mood = type;
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, now = ctx.currentTime;
    for (const v of this.voices) { v.g.gain.cancelScheduledValues(now); v.g.gain.setTargetAtTime(0, now, 1.2); v.o.stop(now + 6); }
    this.voices = [];
    const chord = CHORDS[type] || CHORDS.galaxy, root = ROOT[type] || 41;
    chord.forEach((iv, i) => {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'sine' : (type === 'lava' || type === 'toxic') ? 'sawtooth' : 'triangle';
        o.frequency.value = mtof(root + iv); o.detune.value = det + (Math.random() - 0.5) * 4;
        const g = ctx.createGain(); g.gain.value = 0;
        g.gain.setTargetAtTime((i === 0 ? 0.09 : 0.045) / (1 + i * 0.25), now + i * 0.6, 2.2);
        o.connect(g); g.connect(this.filter); o.start();
        this.voices.push({ o, g });
      }
    });
    this.windGain.gain.setTargetAtTime({ desert: 0.55, ice: 0.5, barren: 0.35, gas: 0.45, lava: 0.3 }[type] ?? 0.22, now, 2);
    this.filter.frequency.setTargetAtTime({ lava: 420, gas: 520, ice: 1100, ocean: 900 }[type] ?? 760 + civ * 400, now, 2);
  }

  chime(kind = 'form') {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const notes = kind === 'claim' ? [72, 76, 79, 84, 88] : kind === 'star' ? [84, 91] : [60, 67, 72, 79];
    notes.forEach((n, i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(n);
      const g = ctx.createGain(); g.gain.value = 0;
      const t = now + i * (kind === 'claim' ? 0.09 : 0.16);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
      o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + 2.6);
    });
    if (kind === 'form') {                 // low impact boom
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(90, now); o.frequency.exponentialRampToValueAtTime(28, now + 2);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.35, now); g.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
      o.connect(g); g.connect(this.bus); o.start(now); o.stop(now + 2.5);
    }
  }

  whoosh() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2.5, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(200, now); f.frequency.exponentialRampToValueAtTime(3000, now + 2.0);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(0.18, now + 1.6); g.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
    src.connect(f); f.connect(g); g.connect(this.bus); src.start(now);
  }

  async toggle(force) {
    this.ensure();
    if (!this.ctx) return false;
    this.on = force ?? !this.on;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.on ? 0.9 : 0, now, 0.6);
    if (this.on) this.setMood(this.mood);
    return this.on;
  }
}
