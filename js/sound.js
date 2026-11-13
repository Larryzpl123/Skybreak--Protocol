// js/sound.js: every sound in the game, made in the browser with Web Audio (oscillators and noise): nothing to
// download. Browsers only allow sound after the player has clicked, tapped or pressed a key, so the audio starts on
// the first of those (unlock). Without Web Audio (or before that first input) every call does nothing.

import { Save } from './save.js';

const VOL = 0.55;                 // master volume
let ctx = null, master = null, noise = null, eng = null, nextWarn = 0;

export const Sound = {
  on() { return Save.data.sound !== false; },
  toggle() {
    Save.data.sound = !this.on();
    Save.write();
    if (master) master.gain.setTargetAtTime(this.on() ? VOL : 0, ctx.currentTime, 0.02);
    return this.on();
  },
  // call from a user input (click / tap / key): creates the audio the first time, wakes it up after that
  unlock() {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC(); } catch { ctx = null; return; }
      master = ctx.createGain();
      master.gain.value = this.on() ? VOL : 0;
      master.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  },
  ready() { return !!ctx && ctx.state === 'running'; },

  // the cannon: a short crack (n = how many cannons fired, a little louder for more)
  shot(n = 1) {
    if (!this.ready()) return;
    const t = ctx.currentTime, k = Math.min(1.6, 0.8 + n * 0.2);
    const src = noiseSrc(t, 0.08), bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.9;
    src.connect(bp).connect(env(t, 0.002, 0.11 * k, 0.05));
    tone('square', 170, 60, t, 0.04, 0.05 * k);
  },
  // a missile leaving the rail: a rising whoosh
  launch() {
    if (!this.ready()) return;
    const t = ctx.currentTime, src = noiseSrc(t, 0.7), bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(2400, t + 0.45);
    src.connect(bp).connect(env(t, 0.02, 0.2, 0.55));
  },
  // an explosion: size 1 (fighter) to 3 (boss); far ones are quieter; pan -1 (left) .. 1 (right)
  boom(size = 1, dist = 0, pan = 0) {
    if (!this.ready()) return;
    const att = 1 / (1 + dist / 450);
    if (att < 0.04) return;
    const t = ctx.currentTime, len = 0.5 + 0.35 * size;
    const src = noiseSrc(t, len + 0.1), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(140, t + len);
    src.connect(lp).connect(env(t, 0.004, Math.min(0.9, 0.28 * size) * att, len, pan));
    tone('sine', 85, 32, t, 0.5 + 0.1 * size, Math.min(0.8, 0.3 * size) * att, pan);
  },
  // the local plane took a hit: a dull thump with a metallic edge
  hurt() {
    if (!this.ready()) return;
    const t = ctx.currentTime, src = noiseSrc(t, 0.15), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    src.connect(lp).connect(env(t, 0.003, 0.22, 0.1));
    tone('square', 240, 110, t, 0.1, 0.06);
  },
  // a power-up picked up: two rising notes
  pickup() {
    if (!this.ready()) return;
    const t = ctx.currentTime;
    tone('sine', 660, 660, t, 0.09, 0.12);
    tone('sine', 990, 990, t + 0.08, 0.14, 0.12);
  },
  // a new wave: a soft two-note chime
  wave() {
    if (!this.ready()) return;
    const t = ctx.currentTime;
    tone('sine', 523, 523, t, 0.45, 0.06);
    tone('sine', 784, 784, t + 0.05, 0.45, 0.05);
  },
  // versus: a missile homing on you, dist metres away: beeps that come faster as it closes in (call every frame)
  warn(dist) {
    if (!this.ready()) return;
    const t = ctx.currentTime;
    if (t < nextWarn) return;
    nextWarn = t + Math.max(0.12, Math.min(0.5, dist / 1400 * 0.5));
    tone('square', 1250, 1250, t, 0.06, 0.05);
  },
  // the engine, every frame while flying: on = flying (not paused, not down), speed in m/s, throttle -1..1,
  // jet = share of thrust from jets (0 = all propellers)
  engine(on, speed = 0, throttle = 0, jet = 0) {
    if (!this.ready()) return;
    const t = ctx.currentTime;
    if (!eng) {
      if (!on) return;
      eng = {};
      eng.lp = ctx.createBiquadFilter(); eng.lp.type = 'lowpass'; eng.lp.frequency.value = 700;
      eng.out = ctx.createGain(); eng.out.gain.value = 0;
      eng.lp.connect(eng.out).connect(master);
      // propeller: two buzzing saws, slightly apart
      eng.prop = ctx.createGain(); eng.prop.connect(eng.lp);
      eng.o1 = ctx.createOscillator(); eng.o1.type = 'sawtooth'; eng.o1.connect(eng.prop); eng.o1.start();
      eng.o2 = ctx.createOscillator(); eng.o2.type = 'sawtooth'; eng.o2.connect(eng.prop); eng.o2.start();
      // jet: a band of noise
      eng.jet = ctx.createGain(); eng.bp = ctx.createBiquadFilter(); eng.bp.type = 'bandpass'; eng.bp.Q.value = 0.7;
      eng.src = ctx.createBufferSource(); eng.src.buffer = noise; eng.src.loop = true;
      eng.src.connect(eng.bp).connect(eng.jet).connect(master); eng.src.start();
    }
    const v = Math.max(0, speed), push = Math.max(0, Math.min(1, 0.5 + throttle * 0.5));
    const f = 48 + v * 0.22 + push * 18;
    eng.o1.frequency.setTargetAtTime(f, t, 0.08);
    eng.o2.frequency.setTargetAtTime(f * 1.012, t, 0.08);
    eng.bp.frequency.setTargetAtTime(350 + v * 3.2 + push * 400, t, 0.1);
    eng.prop.gain.setTargetAtTime(1 - jet, t, 0.1);
    eng.jet.gain.setTargetAtTime(on ? (0.02 + 0.03 * push) * jet : 0, t, 0.08);
    eng.out.gain.setTargetAtTime(on ? 0.035 + 0.035 * push : 0, t, 0.08);
  },
};

// helpers
function noiseSrc(t, dur) {
  const s = ctx.createBufferSource();
  s.buffer = noise; s.loop = true;
  s.start(t, Math.random() * 0.8);
  s.stop(t + dur + 0.05);
  return s;
}
// a gain node with an attack/decay envelope, wired (through a panner if pan) to the master; returns its input
function env(t, attack, peak, decay, pan = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(master);
  } else g.connect(master);
  return g;
}
// an oscillator sliding from f0 to f1 over dur, with its own envelope
function tone(type, f0, f1, t, dur, peak, pan = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  o.connect(env(t, 0.004, peak, dur, pan));
  o.start(t); o.stop(t + dur + 0.05);
}
