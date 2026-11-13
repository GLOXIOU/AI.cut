// Built-in procedural sound-effect generator. Every sound is synthesized from scratch → 100% original, CC0.
const SR = 48000;

// ---------------------------------------------------------------- primitives
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}
const buf = (sec) => new Float32Array(Math.max(1, Math.round(sec * SR)));
const lerp = (a, b, p) => a + (b - a) * p;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function noise(sec, color = 'white', seed = 1) {
  const r = rng(seed), out = buf(sec);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
  for (let i = 0; i < out.length; i++) {
    const w = r();
    if (color === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    } else if (color === 'brown') {
      brown = (brown + 0.02 * w) / 1.02; out[i] = brown * 3.5;
    } else out[i] = w;
  }
  return out;
}

/** Oscillator with frequency function f(t) (Hz). shape: sine|square|saw|tri */
function osc(sec, f, shape = 'sine', phase0 = 0) {
  const out = buf(sec);
  let ph = phase0;
  const fn = typeof f === 'function' ? f : () => f;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += fn(t, i / out.length) / SR;
    const x = ph - Math.floor(ph);
    out[i] = shape === 'square' ? (x < 0.5 ? 1 : -1) : shape === 'saw' ? 2 * x - 1 : shape === 'tri' ? 1 - 4 * Math.abs(x - 0.5) : Math.sin(2 * Math.PI * x);
  }
  return out;
}

/** FM bell: carrier c, modulator ratio, index decaying */
function fm(sec, c, ratio, index, decay = 3) {
  const out = buf(sec);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const idx = index * Math.exp(-decay * t);
    out[i] = Math.sin(2 * Math.PI * c * t + idx * Math.sin(2 * Math.PI * c * ratio * t));
  }
  return out;
}

/** Time-varying biquad. type: lp|hp|bp; cutoff(tNorm)→Hz, q */
function filter(x, type, cutoff, q = 0.707) {
  const out = new Float32Array(x.length);
  const fn = typeof cutoff === 'function' ? cutoff : () => cutoff;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % 32 === 0) {
      const f0 = clamp(fn(i / x.length), 20, SR / 2.2);
      const w0 = (2 * Math.PI * f0) / SR, cs = Math.cos(w0), al = Math.sin(w0) / (2 * q);
      let n0, n1, n2;
      if (type === 'hp') { n0 = (1 + cs) / 2; n1 = -(1 + cs); n2 = (1 + cs) / 2; }
      else if (type === 'bp') { n0 = al; n1 = 0; n2 = -al; }
      else { n0 = (1 - cs) / 2; n1 = 1 - cs; n2 = (1 - cs) / 2; }
      const a0 = 1 + al;
      b0 = n0 / a0; b1 = n1 / a0; b2 = n2 / a0; a1 = (-2 * cs) / a0; a2 = (1 - al) / a0;
    }
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/** Multiply by envelope function e(tNorm, tSec). */
function env(x, e) {
  for (let i = 0; i < x.length; i++) x[i] *= e(i / x.length, i / SR);
  return x;
}
const expDecay = (k) => (p, t) => Math.exp(-k * t);
const adsr = (a, d, s, r, total) => (p, t) => {
  if (t < a) return t / a;
  if (t < a + d) return lerp(1, s, (t - a) / d);
  if (t < total - r) return s;
  return Math.max(0, s * (1 - (t - (total - r)) / r));
};
const swell = (peak = 0.5, sharp = 1.5) => (p) => (p < peak ? Math.pow(p / peak, sharp) : Math.pow(1 - (p - peak) / (1 - peak), 1.2));

function mix(len, ...parts) {
  const out = new Float32Array(Math.max(len ? Math.round(len * SR) : 0, ...parts.map(([x, off = 0]) => x.length + Math.round(off * SR))));
  for (const [x, off = 0, gain = 1] of parts) {
    const o = Math.round(off * SR);
    for (let i = 0; i < x.length && i + o < out.length; i++) out[i + o] += x[i] * gain;
  }
  return out;
}
function drive(x, amt = 2) { for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * amt); return x; }
function crush(x, bits = 6, hold = 4) {
  const q = Math.pow(2, bits - 1);
  let v = 0;
  for (let i = 0; i < x.length; i++) { if (i % hold === 0) v = Math.round(x[i] * q) / q; x[i] = v; }
  return x;
}
/** Schroeder reverb (mono) */
function reverb(x, sec = 1.5, wet = 0.3) {
  const tail = Math.round(sec * SR);
  const out = new Float32Array(x.length + tail);
  out.set(x);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, b: new Float32Array(d), i: 0, fb: Math.pow(0.001, d / (sec * SR)) }));
  const aps = [225, 556].map((d) => ({ d, b: new Float32Array(d), i: 0 }));
  for (let n = 0; n < out.length; n++) {
    const inp = n < x.length ? x[n] : 0;
    let s = 0;
    for (const c of combs) { const y = c.b[c.i]; c.b[c.i] = inp + y * c.fb; c.i = (c.i + 1) % c.d; s += y; }
    s *= 0.25;
    for (const a of aps) { const y = a.b[a.i]; const v = s + y * 0.5; a.b[a.i] = v; a.i = (a.i + 1) % a.d; s = y - v * 0.5; }
    out[n] = (n < x.length ? x[n] * (1 - wet) : 0) + s * wet;
  }
  return out;
}
function seq(len, events) { // events: [[offsetSec, Float32Array, gain]]
  return mix(len, ...events.map(([o, x, g]) => [x, o, g ?? 1]));
}
function normalize(x, peakDb = -1) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  const target = Math.pow(10, peakDb / 20);
  const k = m > 0 ? target / m : 1;
  const fadeIn = Math.min(x.length, Math.round(0.0005 * SR));
  const fade = Math.min(x.length, Math.round(0.004 * SR));
  for (let i = 0; i < x.length; i++) {
    let g = k;
    if (i < fadeIn) g *= i / fadeIn;
    if (i > x.length - fade) g *= (x.length - i) / fade;
    x[i] *= g;
  }
  return x;
}

// ---------------------------------------------------------------- sound recipes
const kick = (seed = 1) => mix(0, [env(osc(0.45, (t) => 50 + 110 * Math.exp(-28 * t)), expDecay(7)), 0, 1], [env(filter(noise(0.02, 'white', seed), 'hp', 3000), expDecay(200)), 0, 0.3]);
const snare = (seed = 2) => mix(0, [env(filter(noise(0.25, 'white', seed), 'bp', 2500, 0.6), expDecay(18)), 0, 0.8], [env(osc(0.15, 190), expDecay(30)), 0, 0.5]);
const hat = (seed = 3, open = false) => env(filter(noise(open ? 0.35 : 0.08, 'white', seed), 'hp', 7500), expDecay(open ? 10 : 55));
const clap = (seed = 4) => seq(0.3, [0, 0.011, 0.022, 0.034].map((o, i) => [o, env(filter(noise(0.18, 'white', seed + i), 'bp', 1600, 0.8), expDecay(i === 3 ? 22 : 70)), 0.8]));
const keyClick = (seed) => mix(0, [env(filter(noise(0.03, 'white', seed), 'bp', 3200 + (seed % 7) * 300, 1.2), expDecay(160)), 0, 1], [env(osc(0.05, 160 + (seed % 5) * 20), expDecay(80)), 0.004, 0.35]);
const blip = (f0, f1, sec, shape = 'sine', dk = 25) => env(osc(sec, (t, p) => lerp(f0, f1, Math.min(1, p * 1.6)), shape), expDecay(dk));
const crash = (sec = 1.6, seed = 5) => {
  const n = filter(noise(sec, 'white', seed), 'hp', 4200);
  const metal = filter(mix(0, [fm(sec, 520, 2.76, 4, 1.5), 0, 0.5], [fm(sec, 780, 3.17, 3, 1.8), 0, 0.4]), 'hp', 2500);
  return env(mix(0, [n, 0, 0.8], [metal, 0, 0.5]), (p, t) => Math.exp(-2.4 * t) * Math.min(1, t * 400));
};
const tom = (f0, f1, sec = 0.35) => env(osc(sec, (t) => f1 + (f0 - f1) * Math.exp(-18 * t)), expDecay(9));
/** Brass-like tone: 3 detuned saws through an opening low-pass. */
const brass = (sec, f, { vib = 5, det = 0.004, bright = 2600 } = {}) => {
  const sig = mix(0, ...[-1, 0, 1].map((d) => [osc(sec, (t) => f * (1 + d * det) * (1 + 0.006 * Math.sin(2 * Math.PI * vib * t)), 'saw'), 0, 0.33]));
  return filter(sig, 'lp', (p) => 400 + bright * Math.min(1, p * 6), 0.9);
};
const hornBlast = (sec) => env(drive(mix(0, ...[466.16, 587.33, 698.46].map((f, i) => [filter(osc(sec, (t) => f * (1 + 0.003 * Math.sin(2 * Math.PI * 6 * t + i)), 'saw'), 'lp', 3200, 0.8), 0, 0.34])), 1.8), adsr(0.015, 0.05, 0.85, 0.05, sec));
const buzz = (sec) => env(filter(osc(sec, 160, 'square'), 'lp', 600), (p, t) => (0.6 + 0.4 * Math.sin(2 * Math.PI * 23 * t)) * Math.min(1, t * 80, (sec - t) * 80));
const whistleGlide = (sec, f) => {
  const tone = osc(sec, (t, p) => f(p) * (1 + 0.012 * Math.sin(2 * Math.PI * 7 * t)));
  const breath = filter(noise(sec, 'white', 77), 'bp', (p) => f(p), 8);
  return env(mix(0, [tone, 0, 0.7], [breath, 0, 0.25]), adsr(0.03, 0.05, 0.9, 0.1, sec));
};
const stab = (sec, f, bright) => env(brass(sec, f, { bright }), adsr(0.01, 0.05, 0.8, 0.08, sec));

export const SFX = [
  // Whooshes & transitions
  { id: 'whoosh-soft', name: 'Whoosh soft', cat: 'transition', tags: ['whoosh', 'swish', 'transition', 'air'], gen: () => env(filter(noise(0.9, 'pink', 11), 'bp', (p) => 300 + 2600 * Math.sin(Math.PI * p), 1.1), swell(0.5, 1.6)) },
  { id: 'whoosh-fast', name: 'Whoosh fast', cat: 'transition', tags: ['whoosh', 'fast', 'swipe', 'transition'], gen: () => env(filter(noise(0.38, 'pink', 12), 'bp', (p) => 600 + 4200 * Math.sin(Math.PI * p), 1.4), swell(0.55, 1.4)) },
  { id: 'whoosh-deep', name: 'Whoosh deep', cat: 'transition', tags: ['whoosh', 'deep', 'bass', 'transition'], gen: () => mix(0, [env(filter(noise(1.3, 'brown', 13), 'lp', (p) => 200 + 1600 * Math.sin(Math.PI * p), 0.9), swell(0.55, 1.8)), 0, 1], [env(osc(1.3, (t, p) => 90 - 50 * p), swell(0.6, 2)), 0, 0.5]) },
  { id: 'swoosh-rise', name: 'Swoosh rise', cat: 'transition', tags: ['swoosh', 'rise', 'transition', 'sweep'], gen: () => env(filter(noise(0.7, 'white', 14), 'bp', (p) => 300 + 7000 * p * p, 2), swell(0.85, 2.4)) },
  { id: 'swipe', name: 'Swipe', cat: 'transition', tags: ['swipe', 'ui', 'slide', 'whoosh'], gen: () => env(filter(noise(0.22, 'white', 15), 'hp', (p) => 2000 + 6000 * p), swell(0.4, 1)) },
  { id: 'riser-2s', name: 'Riser 2s', cat: 'build', tags: ['riser', 'build', 'tension', 'uplifter', 'transition'], gen: () => mix(0, [env(filter(noise(2.1, 'white', 16), 'hp', (p) => 150 + 7000 * p * p, 1.2), (p) => Math.pow(p, 2.2) * (p > 0.97 ? (1 - p) / 0.03 : 1)), 0, 0.7], [env(osc(2.1, (t, p) => 180 + 1100 * p * p + 6 * Math.sin(2 * Math.PI * 7 * t), 'saw'), (p) => 0.35 * Math.pow(p, 2.5) * (p > 0.97 ? (1 - p) / 0.03 : 1)), 0, 0.5]) },
  { id: 'riser-4s', name: 'Riser 4s', cat: 'build', tags: ['riser', 'build', 'long', 'tension', 'uplifter'], gen: () => mix(0, [env(filter(noise(4.1, 'pink', 17), 'hp', (p) => 100 + 9000 * Math.pow(p, 2.5), 1.4), (p) => Math.pow(p, 2.5) * (p > 0.98 ? (1 - p) / 0.02 : 1)), 0, 0.8], [env(osc(4.1, (t, p) => 110 + 880 * Math.pow(p, 2) , 'saw'), (p) => 0.3 * Math.pow(p, 2.8) * (p > 0.98 ? (1 - p) / 0.02 : 1)), 0, 0.4]) },
  { id: 'downlifter', name: 'Downlifter', cat: 'build', tags: ['downlifter', 'fall', 'drop', 'transition'], gen: () => env(filter(noise(2, 'pink', 18), 'lp', (p) => 9000 * Math.pow(1 - p, 2.2) + 120, 1.1), (p) => Math.pow(1 - p, 1.5) * Math.min(1, p * 40)) },
  // Impacts
  { id: 'impact-boom', name: 'Impact boom', cat: 'impact', tags: ['impact', 'boom', 'hit', 'cinematic', 'bass'], gen: () => reverb(drive(mix(0, [env(osc(1.6, (t) => 32 + 60 * Math.exp(-6 * t)), expDecay(2.6)), 0, 1], [env(filter(noise(0.25, 'white', 19), 'lp', 1800), expDecay(16)), 0, 0.7]), 1.8), 1.6, 0.25) },
  { id: 'hit-punch', name: 'Punch hit', cat: 'impact', tags: ['punch', 'hit', 'impact', 'short'], gen: () => drive(mix(0, [kick(20), 0, 1], [env(filter(noise(0.08, 'white', 21), 'bp', 1200, 0.7), expDecay(45)), 0, 0.6]), 2.2) },
  { id: 'cinematic-hit', name: 'Cinematic hit', cat: 'impact', tags: ['cinematic', 'trailer', 'impact', 'metal', 'braam'], gen: () => reverb(mix(0, [env(osc(2.4, (t) => 40 + 40 * Math.exp(-4 * t)), expDecay(1.5)), 0, 1], [env(fm(2.4, 110, 1.41, 6, 2), expDecay(1.8)), 0, 0.45], [env(filter(noise(0.4, 'pink', 22), 'lp', 2500), expDecay(9)), 0, 0.5]), 2.4, 0.35) },
  { id: 'bass-drop', name: 'Bass drop', cat: 'impact', tags: ['bass', 'drop', 'sub', '808', 'boom'], gen: () => drive(env(osc(2.2, (t, p) => 125 * Math.pow(0.27, p)), (p) => Math.min(1, p * 60) * Math.pow(1 - p, 0.6)), 1.6) },
  { id: 'thud', name: 'Thud', cat: 'impact', tags: ['thud', 'drop', 'body', 'fall'], gen: () => mix(0, [env(osc(0.5, (t) => 60 + 50 * Math.exp(-20 * t)), expDecay(9)), 0, 1], [env(filter(noise(0.12, 'brown', 23), 'lp', 600), expDecay(25)), 0, 0.8]) },
  // UI & pops
  { id: 'pop', name: 'Pop', cat: 'ui', tags: ['pop', 'ui', 'appear', 'bubble', 'click'], gen: () => blip(700, 260, 0.14, 'sine', 30) },
  { id: 'pop-high', name: 'Pop high', cat: 'ui', tags: ['pop', 'ui', 'notification', 'appear'], gen: () => blip(1100, 520, 0.11, 'sine', 38) },
  { id: 'bubble', name: 'Bubble', cat: 'ui', tags: ['bubble', 'pop', 'water', 'cute'], gen: () => blip(280, 1300, 0.13, 'sine', 22) },
  { id: 'click', name: 'Click', cat: 'ui', tags: ['click', 'ui', 'tap', 'button'], gen: () => env(filter(noise(0.04, 'white', 31), 'bp', 4200, 2), expDecay(220)) },
  { id: 'tick', name: 'Tick (woodblock)', cat: 'ui', tags: ['tick', 'clock', 'wood', 'counter'], gen: () => mix(0, [env(osc(0.08, 1850), expDecay(70)), 0, 1], [env(filter(noise(0.02, 'white', 32), 'bp', 3000), expDecay(300)), 0, 0.4]) },
  { id: 'ding', name: 'Ding (bell)', cat: 'ui', tags: ['ding', 'bell', 'correct', 'notification'], gen: () => env(fm(1.6, 880, 3.5, 2.5, 2.5), expDecay(2.8)) },
  { id: 'notification', name: 'Notification', cat: 'ui', tags: ['notification', 'message', 'alert', 'chime'], gen: () => seq(0.6, [[0, env(fm(0.4, 988, 2, 1.2, 6), expDecay(9)), 0.8], [0.12, env(fm(0.45, 1319, 2, 1.2, 6), expDecay(7)), 0.8]]) },
  { id: 'success', name: 'Success jingle', cat: 'ui', tags: ['success', 'win', 'achievement', 'level up', 'correct'], gen: () => seq(0.9, [523, 659, 784, 1047].map((f, i) => [i * 0.09, env(osc(0.35, f, 'tri'), expDecay(7)), 0.6])) },
  { id: 'error', name: 'Error buzz', cat: 'ui', tags: ['error', 'wrong', 'fail', 'buzz'], gen: () => env(filter(osc(0.42, 140, 'square'), 'lp', 1800), (p, t) => (0.6 + 0.4 * Math.sin(2 * Math.PI * 18 * t)) * Math.min(1, (1 - p) * 8)) },
  { id: 'camera-shutter', name: 'Camera shutter', cat: 'foley', tags: ['camera', 'shutter', 'photo', 'snap'], gen: () => seq(0.25, [[0, env(filter(noise(0.04, 'white', 33), 'bp', 2500, 1.5), expDecay(120)), 1], [0.012, env(filter(noise(0.08, 'white', 34), 'hp', 1500), expDecay(60)), 0.4], [0.11, env(filter(noise(0.05, 'white', 35), 'bp', 1800, 1.5), expDecay(110)), 0.9]]) },
  { id: 'typewriter-key', name: 'Typewriter key', cat: 'foley', tags: ['typewriter', 'key', 'type'], gen: () => mix(0, [keyClick(41), 0, 1], [env(osc(0.06, 95), expDecay(60)), 0.005, 0.5]) },
  { id: 'keyboard-typing', name: 'Keyboard typing', cat: 'foley', tags: ['keyboard', 'typing', 'computer', 'hacker'], gen: () => { const r = rng(42); const ev = []; let t = 0; while (t < 2.2) { ev.push([t, keyClick(Math.floor((r() + 1) * 1000)), 0.6 + 0.3 * r()]); t += 0.06 + 0.09 * Math.abs(r()); } return seq(2.4, ev); } },
  // Digital / glitch
  { id: 'glitch', name: 'Glitch', cat: 'digital', tags: ['glitch', 'digital', 'error', 'cyber', 'transition'], gen: () => { const r = rng(51); const ev = []; let t = 0; while (t < 0.5) { const d = 0.02 + 0.05 * Math.abs(r()); ev.push([t, crush(r() > 0 ? osc(d, 200 + 2000 * Math.abs(r()), 'square') : noise(d, 'white', Math.floor(t * 999)), 3 + Math.floor(Math.abs(r()) * 4), 2 + Math.floor(Math.abs(r()) * 12)), 0.7]); t += d + 0.01 * Math.abs(r()); } return seq(0.6, ev); } },
  { id: 'static', name: 'Digital static', cat: 'digital', tags: ['static', 'noise', 'tv', 'glitch'], gen: () => env(crush(noise(1, 'white', 52), 5, 3), (p, t) => 0.5 + 0.5 * Math.sign(Math.sin(2 * Math.PI * 11 * t))) },
  { id: 'laser', name: 'Laser', cat: 'digital', tags: ['laser', 'zap', 'sci-fi', 'shoot'], gen: () => env(osc(0.4, (t, p) => 2200 * Math.pow(0.08, p)), expDecay(6)) },
  { id: 'power-up', name: 'Power up (8-bit)', cat: 'retro', tags: ['power up', '8bit', 'retro', 'game', 'level'], gen: () => seq(0.8, [262, 330, 392, 523, 659, 784, 1047].map((f, i) => [i * 0.08, env(osc(0.1, f, 'square'), expDecay(12)), 0.35])) },
  { id: 'coin', name: 'Coin (8-bit)', cat: 'retro', tags: ['coin', '8bit', 'retro', 'game', 'money'], gen: () => seq(0.4, [[0, env(osc(0.08, 988, 'square'), () => 1), 0.35], [0.08, env(osc(0.3, 1319, 'square'), expDecay(9)), 0.35]]) },
  { id: 'jump', name: 'Jump (8-bit)', cat: 'retro', tags: ['jump', '8bit', 'retro', 'game', 'boing'], gen: () => env(osc(0.25, (t, p) => 300 + 700 * p, 'square'), (p) => 0.4 * (1 - p)) },
  // Musical / percussion
  { id: 'kick', name: 'Kick drum', cat: 'drums', tags: ['kick', 'drum', 'beat', 'bass'], gen: () => kick(61) },
  { id: 'snare', name: 'Snare', cat: 'drums', tags: ['snare', 'drum', 'beat'], gen: () => snare(62) },
  { id: 'hihat', name: 'Hi-hat', cat: 'drums', tags: ['hihat', 'hat', 'drum', 'beat'], gen: () => hat(63) },
  { id: 'clap', name: 'Clap', cat: 'drums', tags: ['clap', 'drum', 'beat', 'hand'], gen: () => clap(64) },
  { id: 'drumroll', name: 'Drum roll', cat: 'drums', tags: ['drumroll', 'suspense', 'reveal', 'snare'], gen: () => { const ev = []; let t = 0, i = 0; while (t < 2.4) { ev.push([t, snare(100 + i), 0.25 + 0.7 * (t / 2.4)]); t += 0.055; i++; } ev.push([2.45, mix(0, [kick(7), 0, 1], [hat(8, true), 0, 0.6]), 1]); return seq(3, ev); } },
  { id: 'sparkle', name: 'Sparkle', cat: 'magic', tags: ['sparkle', 'magic', 'shine', 'twinkle', 'fairy'], gen: () => { const r = rng(71); const ev = []; for (let i = 0; i < 14; i++) ev.push([i * 0.07 + 0.02 * r(), env(osc(0.5, 2000 + 2500 * Math.abs(r())), expDecay(9)), 0.25]); return reverb(seq(1.3, ev), 1.2, 0.3); } },
  { id: 'magic-chime', name: 'Magic chime', cat: 'magic', tags: ['magic', 'chime', 'reveal', 'wonder'], gen: () => reverb(seq(1.6, [1047, 1319, 1568, 2093, 2637].map((f, i) => [i * 0.07, env(fm(1, f, 2, 1.5, 4), expDecay(4)), 0.4])), 1.8, 0.35) },
  { id: 'boing', name: 'Boing', cat: 'cartoon', tags: ['boing', 'spring', 'cartoon', 'funny', 'bounce'], gen: () => env(osc(0.7, (t) => 180 + 120 * Math.sin(2 * Math.PI * 14 * t) * Math.exp(-4 * t) + 60 * t), expDecay(4)) },
  { id: 'record-scratch', name: 'Record scratch', cat: 'cartoon', tags: ['record scratch', 'stop', 'funny', 'dj'], gen: () => env(filter(noise(0.5, 'white', 81), 'bp', (p) => 900 + 2400 * Math.abs(Math.sin(p * Math.PI * 5)), 3), (p) => Math.min(1, p * 30) * (1 - p)) },
  { id: 'heartbeat', name: 'Heartbeat', cat: 'ambience', tags: ['heartbeat', 'tension', 'suspense', 'pulse'], gen: () => seq(1.0, [[0, env(osc(0.18, 55), expDecay(18)), 1], [0.22, env(osc(0.18, 50), expDecay(20)), 0.7]]) },
  { id: 'applause', name: 'Applause', cat: 'crowd', tags: ['applause', 'clapping', 'crowd', 'audience', 'bravo'], gen: () => { const r = rng(91); const ev = []; for (let i = 0; i < 260; i++) { const t = Math.abs(r()) * 3.6; ev.push([t, clap(200 + i), 0.12 * (0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, t / 3.6)))]); } return seq(4, ev); } },
  { id: 'wind', name: 'Wind ambience', cat: 'ambience', tags: ['wind', 'ambience', 'outdoor', 'air', 'loop'], gen: () => env(filter(noise(8, 'pink', 92), 'bp', (p) => 400 + 300 * Math.sin(2 * Math.PI * p * 2.3) + 200 * Math.sin(2 * Math.PI * p * 5.1), 0.8), (p) => Math.min(1, p * 8, (1 - p) * 8)) },
  { id: 'vinyl-crackle', name: 'Vinyl crackle', cat: 'ambience', tags: ['vinyl', 'crackle', 'lofi', 'retro', 'loop'], gen: () => { const r = rng(93); const base = env(filter(noise(6, 'brown', 94), 'lp', 900), () => 0.15); const ev = [[0, base, 1]]; for (let i = 0; i < 180; i++) ev.push([Math.abs(r()) * 6, env(filter(noise(0.006, 'white', 300 + i), 'hp', 2000), expDecay(500)), 0.3 + 0.5 * Math.abs(r())]); return seq(6, ev); } },
  { id: 'tension-drone', name: 'Tension drone', cat: 'ambience', tags: ['drone', 'tension', 'dark', 'suspense', 'horror', 'bed'], gen: () => env(filter(mix(0, [osc(8, 55, 'saw'), 0, 0.5], [osc(8, 55.6, 'saw'), 0, 0.5], [osc(8, 82.4, 'saw'), 0, 0.3]), 'lp', (p) => 300 + 250 * Math.sin(2 * Math.PI * p * 1.5), 1.2), (p) => Math.min(1, p * 5, (1 - p) * 5)) },
  { id: 'countdown-beep', name: 'Countdown beep', cat: 'ui', tags: ['beep', 'countdown', 'timer', 'tick'], gen: () => env(osc(0.16, 1000), (p) => Math.min(1, (1 - p) * 10)) },
  { id: 'countdown-final', name: 'Countdown final beep', cat: 'ui', tags: ['beep', 'countdown', 'go', 'start'], gen: () => env(osc(0.55, 1500), (p) => Math.min(1, (1 - p) * 4)) },

  // YouTube / meme classics (re-created from scratch → CC0)
  { id: 'meme-boom', name: 'Boom (mème)', cat: 'meme', tags: ['boom', 'vine', 'meme', 'bass', 'reveal', 'youtube'], gen: () => reverb(drive(mix(0, [env(osc(1.8, (t) => 38 + 95 * Math.exp(-7 * t)), (p, t) => Math.exp(-2.2 * t) * Math.min(1, t * 300)), 0, 1], [env(filter(noise(0.05, 'white', 101), 'lp', 2500), expDecay(60)), 0, 0.5]), 3), 1.4, 0.22) },
  { id: 'airhorn', name: 'Klaxon (airhorn)', cat: 'meme', tags: ['airhorn', 'horn', 'klaxon', 'meme', 'party', 'mlg'], gen: () => seq(1.6, [[0, hornBlast(0.42), 1], [0.5, hornBlast(0.16), 1], [0.72, hornBlast(0.75), 1]]) },
  { id: 'rimshot', name: 'Ba-dum-tss', cat: 'meme', tags: ['rimshot', 'ba dum tss', 'joke', 'blague', 'drum', 'meme'], gen: () => seq(1.9, [[0, tom(260, 180, 0.3), 0.9], [0.16, tom(190, 120, 0.35), 0.9], [0.42, mix(0, [kick(102), 0, 0.6], [crash(1.4, 103), 0, 0.8]), 1]]) },
  { id: 'sad-trombone', name: 'Trombone triste', cat: 'meme', tags: ['sad trombone', 'fail', 'wah wah', 'echec', 'raté', 'meme'], gen: () => { const notes = [[0, 233.08, 0.32], [0.38, 220, 0.32], [0.76, 207.65, 0.32], [1.14, 196, 1.1]]; return seq(2.4, notes.map(([o, f, d], i) => [o, env(filter(osc(d, (t) => f * (1 + (i === 3 ? 0.02 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 2) : 0)), 'saw'), 'lp', (p) => 300 + 1400 * Math.sin(Math.PI * Math.min(1, p * (i === 3 ? 1 : 1.2))), 1.4), adsr(0.03, 0.05, 0.9, 0.08, d)), 0.7])); } },
  { id: 'slide-whistle-up', name: 'Sifflet glissé ↑', cat: 'meme', tags: ['slide whistle', 'sifflet', 'up', 'cartoon', 'jump'], gen: () => whistleGlide(0.8, (p) => 420 * Math.pow(4, p)) },
  { id: 'slide-whistle-down', name: 'Sifflet glissé ↓', cat: 'meme', tags: ['slide whistle', 'sifflet', 'down', 'cartoon', 'fall', 'chute'], gen: () => whistleGlide(0.9, (p) => 1700 * Math.pow(0.25, p)) },
  { id: 'bonk', name: 'Bonk', cat: 'meme', tags: ['bonk', 'hit', 'head', 'cartoon', 'meme', 'tap'], gen: () => mix(0, [env(fm(0.3, 520, 1.5, 2, 18), expDecay(18)), 0, 0.8], [env(osc(0.25, (t) => 300 * Math.exp(-6 * t) + 150), expDecay(16)), 0, 0.6], [env(filter(noise(0.01, 'white', 121), 'bp', 3000), expDecay(400)), 0, 0.5]) },
  { id: 'crickets', name: 'Criquets (silence gênant)', cat: 'meme', tags: ['crickets', 'criquets', 'awkward', 'silence', 'gene', 'meme'], gen: () => { const ev = []; for (let k = 0; k < 9; k++) ev.push([k * 0.42 + (k % 3) * 0.05, env(osc(0.16, 4600 + (k % 2) * 300), (p, t) => Math.pow(Math.max(0, Math.sin(2 * Math.PI * 32 * t)), 2) * Math.sin(Math.PI * p)), 0.35]); return seq(4, ev); } },
  { id: 'tada', name: 'Tadaa !', cat: 'meme', tags: ['tada', 'fanfare', 'reveal', 'victory', 'win', 'presentation'], gen: () => reverb(seq(1.9, [[0, stab(0.14, 392, 2600), 0.45], [0.12, stab(0.14, 523.25, 2600), 0.45], [0.26, env(mix(0, [brass(1.2, 523.25), 0, 0.4], [brass(1.2, 659.25), 0, 0.35], [brass(1.2, 783.99), 0, 0.35]), adsr(0.02, 0.1, 0.8, 0.5, 1.2)), 0.85]]), 1.2, 0.25) },
  { id: 'dun-dun-dun', name: 'Dun dun dunnn', cat: 'meme', tags: ['dun dun', 'suspense', 'dramatic', 'drama', 'reveal', 'choc'], gen: () => reverb(seq(3, [[0, stab(0.28, 146.83, 1400), 0.8], [0.4, stab(0.28, 146.83, 1400), 0.8], [0.8, env(mix(0, [brass(1.8, 138.59, { bright: 1600 }), 0, 0.5], [brass(1.8, 207.65), 0, 0.3], [brass(1.8, 69.3), 0, 0.4]), adsr(0.02, 0.1, 0.8, 0.6, 1.8)), 1]]), 1.6, 0.3) },
  { id: 'cash-register', name: 'Ka-ching (caisse)', cat: 'meme', tags: ['cash', 'ka-ching', 'money', 'argent', 'register', 'sale', 'vente'], gen: () => seq(1.6, [[0, mix(0, [env(filter(noise(0.12, 'white', 111), 'bp', 1800, 1), expDecay(35)), 0, 0.7], [env(osc(0.2, 90), expDecay(25)), 0, 0.5]), 1], [0.09, env(fm(1.4, 2093, 2.01, 3, 3), expDecay(3.2)), 0.6], [0.11, env(fm(1.4, 2637, 2.01, 2.5, 3), expDecay(3.5)), 0.5]]) },
  { id: 'boxing-bell', name: 'Cloche de ring', cat: 'meme', tags: ['bell', 'boxing', 'ring', 'fight', 'round', 'cloche'], gen: () => seq(2.4, [0, 0.32, 0.64].map((o) => [o, env(fm(1.7, 1180, 1.41, 3.5, 1.6), expDecay(2.2)), 0.5])) },
  { id: 'game-over', name: 'Game over (8-bit)', cat: 'meme', tags: ['game over', '8bit', 'retro', 'lose', 'perdu', 'fail'], gen: () => seq(1.6, [784, 740, 698, 659, 622, 587, 554].map((f, i) => [i * 0.11, env(osc(0.14, f, 'square'), expDecay(10)), 0.3]).concat([[0.8, env(osc(0.6, (t, p) => 523 * Math.pow(0.5, p), 'square'), (p) => 1 - p), 0.3]])) },
  { id: 'tape-stop', name: 'Arrêt de bande', cat: 'meme', tags: ['tape stop', 'stop', 'slow down', 'pause', 'freeze', 'turntable'], gen: () => filter(env(mix(0, [osc(0.9, (t, p) => 220 * Math.pow(1 - p, 1.8) + 8, 'saw'), 0, 0.4], [osc(0.9, (t, p) => 330 * Math.pow(1 - p, 1.8) + 8, 'saw'), 0, 0.3], [osc(0.9, (t, p) => 110 * Math.pow(1 - p, 1.8) + 4), 0, 0.6]), (p) => Math.pow(1 - p, 0.7)), 'lp', (p) => 4000 * (1 - p) + 100) },
  { id: 'rewind', name: 'Rembobinage', cat: 'meme', tags: ['rewind', 'rembobiner', 'back', 'flashback', 'retour'], gen: () => env(filter(mix(0, [noise(1.2, 'white', 141), 0, 0.4], [osc(1.2, (t) => 600 + 500 * Math.sin(2 * Math.PI * 9 * t) + 1200 * t, 'saw'), 0, 0.2]), 'bp', (p) => 800 + 2500 * Math.abs(Math.sin(p * Math.PI * 9)), 1.5), (p) => Math.min(1, p * 10) * (1 - p * 0.6)) },

  // transitions for B-roll / zooms
  { id: 'zoom-in-whoosh', name: 'Zoom avant (whoosh)', cat: 'transition', tags: ['zoom', 'punch in', 'whoosh', 'rise', 'broll', 'transition'], gen: () => mix(0, [env(filter(noise(0.6, 'pink', 211), 'bp', (p) => 300 + 5000 * p * p, 1.4), swell(0.85, 2.2)), 0, 0.8], [env(osc(0.6, (t, p) => 200 + 900 * p * p), swell(0.85, 2.5)), 0, 0.25]) },
  { id: 'zoom-out-whoosh', name: 'Zoom arrière (whoosh)', cat: 'transition', tags: ['zoom', 'out', 'whoosh', 'fall', 'transition'], gen: () => mix(0, [env(filter(noise(0.6, 'pink', 212), 'bp', (p) => 5300 - 5000 * Math.sqrt(p), 1.4), swell(0.2, 1.2)), 0, 0.8], [env(osc(0.6, (t, p) => 1100 - 900 * Math.sqrt(p)), swell(0.2, 1.4)), 0, 0.2]) },
  { id: 'transition-hit', name: 'Whoosh + impact', cat: 'transition', tags: ['whoosh', 'impact', 'hit', 'transition', 'broll', 'intro'], gen: () => seq(1.6, [[0, env(filter(noise(0.45, 'pink', 251), 'bp', (p) => 400 + 4000 * p, 1.3), swell(0.92, 2.4)), 0.9], [0.43, drive(mix(0, [kick(252), 0, 1], [env(filter(noise(0.3, 'white', 253), 'lp', 2200), expDecay(14)), 0, 0.5]), 2), 1]]) },
  { id: 'reverse-cymbal', name: 'Cymbale inversée', cat: 'transition', tags: ['reverse', 'cymbal', 'swell', 'build', 'transition', 'riser'], gen: () => { const c = crash(1.6, 151); c.reverse(); return env(c, (p) => (p > 0.97 ? (1 - p) / 0.03 : 1)); } },
  { id: 'sword-swing', name: 'Swing rapide', cat: 'transition', tags: ['swing', 'swish', 'sword', 'fast', 'whoosh', 'swipe'], gen: () => env(filter(noise(0.35, 'white', 191), 'bp', (p) => 1200 + 5000 * Math.sin(Math.PI * p), 3), swell(0.45, 2)) },
  { id: 'message-sent', name: 'Message envoyé', cat: 'ui', tags: ['message', 'sent', 'send', 'sms', 'chat', 'notification'], gen: () => seq(0.6, [[0, env(filter(noise(0.25, 'white', 171), 'bp', (p) => 1500 + 5000 * p, 2), swell(0.5, 1.2)), 0.5], [0.18, blip(880, 1320, 0.16, 'sine', 20), 0.7]]) },

  // impacts
  { id: 'explosion', name: 'Explosion', cat: 'impact', tags: ['explosion', 'boom', 'blast', 'bomb', 'kaboom'], gen: () => reverb(drive(mix(0, [env(filter(noise(2.5, 'brown', 131), 'lp', (p) => 4000 * Math.exp(-3 * p) + 150, 0.8), (p, t) => Math.exp(-1.6 * t) * Math.min(1, t * 200)), 0, 1], [env(osc(1.5, (t) => 30 + 60 * Math.exp(-5 * t)), expDecay(2.2)), 0, 0.9], [env(filter(noise(0.08, 'white', 132), 'hp', 1500), expDecay(30)), 0, 0.6]), 2), 1.8, 0.2) },
  { id: 'punch-heavy', name: 'Coup de poing lourd', cat: 'impact', tags: ['punch', 'heavy', 'hit', 'fight', 'kick', 'impact'], gen: () => drive(mix(0, [env(osc(0.5, (t) => 45 + 120 * Math.exp(-35 * t)), expDecay(8)), 0, 1], [env(filter(noise(0.15, 'white', 201), 'bp', 900, 0.6), expDecay(28)), 0, 0.8], [env(filter(noise(0.02, 'white', 202), 'hp', 4000), expDecay(250)), 0, 0.5]), 3) },
  { id: 'thunder', name: 'Tonnerre', cat: 'impact', tags: ['thunder', 'tonnerre', 'storm', 'orage', 'rumble'], gen: () => { const r = rng(241); const ev = [[0, env(filter(noise(5, 'brown', 242), 'lp', (p) => 900 * Math.exp(-p * 1.5) + 80, 0.7), (p, t) => Math.min(1, t * 6) * Math.exp(-0.7 * t)), 1]]; for (let i = 0; i < 25; i++) ev.push([0.05 + Math.abs(r()) * 1.2, env(filter(noise(0.08, 'white', 300 + i), 'lp', 2500), expDecay(25)), 0.25]); return reverb(seq(5.5, ev), 2.2, 0.3); } },
  { id: 'cymbal-crash', name: 'Cymbale crash', cat: 'drums', tags: ['cymbal', 'crash', 'drum', 'hit', 'accent'], gen: () => crash(2.2, 271) },

  // UI & foley
  { id: 'camera-flash', name: 'Flash photo (charge)', cat: 'foley', tags: ['camera', 'flash', 'photo', 'charge', 'paparazzi'], gen: () => seq(1.3, [[0, env(osc(0.9, (t, p) => 1800 + 5200 * p * p), (p) => 0.15 * Math.pow(p, 0.8)), 1], [0.92, mix(0, [env(filter(noise(0.06, 'white', 161), 'bp', 3000, 1.2), expDecay(80)), 0, 1], [blip(900, 300, 0.12, 'sine', 30), 0, 0.5]), 1]]) },
  { id: 'phone-vibrate', name: 'Téléphone vibre', cat: 'ui', tags: ['phone', 'vibrate', 'buzz', 'notification', 'telephone', 'call'], gen: () => seq(1.5, [[0, buzz(0.42), 0.8], [0.62, buzz(0.42), 0.8]]) },
  { id: 'alarm', name: 'Alarme', cat: 'ui', tags: ['alarm', 'alarme', 'alert', 'warning', 'siren'], gen: () => seq(2.2, Array.from({ length: 8 }, (_, i) => [i * 0.26, env(filter(osc(0.2, i % 2 ? 880 : 1175, 'square'), 'lp', 3000), (p) => Math.min(1, (1 - p) * 8, p * 30)), 0.35])) },
  { id: 'ui-hover', name: 'UI survol', cat: 'ui', tags: ['ui', 'hover', 'soft', 'menu', 'interface'], gen: () => blip(1800, 2200, 0.06, 'sine', 70) },
  { id: 'toggle', name: 'Interrupteur', cat: 'ui', tags: ['toggle', 'switch', 'on', 'off', 'click', 'interface'], gen: () => seq(0.16, [[0, env(filter(noise(0.03, 'white', 281), 'bp', 2600, 2), expDecay(200)), 0.9], [0.05, env(filter(noise(0.03, 'white', 282), 'bp', 3600, 2), expDecay(220)), 0.7]]) },
  { id: 'digital-beep', name: 'Bip digital', cat: 'digital', tags: ['beep', 'bip', 'digital', 'scan', 'robot', 'tech'], gen: () => seq(0.5, [[0, env(filter(osc(0.08, 1760, 'square'), 'lp', 5000), expDecay(30)), 0.4], [0.12, env(filter(osc(0.08, 2349, 'square'), 'lp', 5000), expDecay(30)), 0.4]]) },
  { id: 'snap', name: 'Claquement de doigts', cat: 'foley', tags: ['snap', 'finger', 'doigts', 'claquement', 'magic', 'transition'], gen: () => mix(0, [env(filter(noise(0.05, 'white', 261), 'bp', 2400, 1.6), expDecay(90)), 0, 1], [env(filter(noise(0.01, 'white', 262), 'hp', 5000), expDecay(500)), 0, 0.6]) },
  { id: 'page-turn', name: 'Page tournée', cat: 'foley', tags: ['page', 'paper', 'papier', 'book', 'livre', 'flip'], gen: () => env(filter(noise(0.45, 'white', 231), 'bp', (p) => 1200 + 3000 * p, 0.7), (p) => Math.pow(Math.sin(Math.PI * p), 1.5) * (0.6 + 0.4 * Math.sin(p * 40))) },
  { id: 'water-drop', name: 'Goutte d\'eau', cat: 'foley', tags: ['water', 'drop', 'goutte', 'bloop', 'liquid'], gen: () => env(osc(0.18, (t, p) => 400 + 1400 * Math.pow(p, 0.6)), (p, t) => Math.exp(-22 * t) * Math.min(1, t * 400)) },
  { id: 'pop-cork', name: 'Bouchon', cat: 'foley', tags: ['cork', 'pop', 'bouchon', 'champagne', 'celebration'], gen: () => mix(0, [blip(500, 120, 0.12, 'sine', 35), 0, 0.9], [env(filter(noise(0.03, 'white', 221), 'bp', 2500, 1), expDecay(150)), 0, 0.6]) },
  { id: 'clock-ticking', name: 'Horloge tic-tac', cat: 'foley', tags: ['clock', 'tick', 'tock', 'horloge', 'time', 'temps', 'suspense'], gen: () => seq(4.2, Array.from({ length: 8 }, (_, i) => [i * 0.5, mix(0, [env(osc(0.06, i % 2 ? 1500 : 1900), expDecay(90)), 0, 0.6], [env(filter(noise(0.02, 'white', 290 + i), 'bp', 3500), expDecay(300)), 0, 0.4]), 1])) },
  { id: 'whistle', name: 'Sifflet d\'arbitre', cat: 'foley', tags: ['whistle', 'sifflet', 'referee', 'sport', 'stop'], gen: () => env(mix(0, [osc(0.9, (t) => 2850 + 120 * Math.sin(2 * Math.PI * 28 * t)), 0, 0.6], [filter(noise(0.9, 'white', 181), 'bp', 2900, 3), 0, 0.5]), adsr(0.02, 0.05, 0.9, 0.08, 0.9)) },
  { id: 'sword-unsheath', name: 'Lame dégainée', cat: 'foley', tags: ['sword', 'blade', 'schwing', 'epee', 'metal', 'unsheath'], gen: () => mix(0, [env(filter(noise(0.6, 'white', 192), 'hp', (p) => 2000 + 6000 * p), (p) => Math.sin(Math.PI * Math.min(1, p * 1.4)) * 0.5), 0, 0.6], [env(fm(1.4, 3200, 1.47, 2, 2.5), (p, t) => Math.min(1, t * 20) * Math.exp(-2.5 * t)), 0.25, 0.4]) },
  { id: 'cute-pop', name: 'Pop mignon', cat: 'magic', tags: ['cute', 'pop', 'kawaii', 'sparkle', 'appear', 'apparition'], gen: () => mix(0, [blip(600, 1400, 0.12, 'sine', 26), 0, 0.8], [env(osc(0.3, 2600), expDecay(14)), 0.05, 0.2], [env(osc(0.3, 3300), expDecay(14)), 0.09, 0.15]) },
];

export const SFX_CATEGORIES = [
  ['meme', 'Mèmes & YouTube'], ['transition', 'Transitions & whoosh'], ['impact', 'Impacts'], ['build', 'Montées'], ['ui', 'Interface & notifs'],
  ['digital', 'Digital & glitch'], ['foley', 'Bruitages'], ['cartoon', 'Cartoon'], ['magic', 'Magie'], ['retro', 'Rétro 8-bit'],
  ['drums', 'Percussions'], ['ambience', 'Ambiances'], ['crowd', 'Foule'],
];

/** Render a sound to a 16-bit WAV buffer (mono → duplicated to stereo). */
export function renderSfx(id) {
  const s = SFX.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown built-in sound ${id}`);
  const x = normalize(s.gen(), -1);
  return { wav: toWav(x), duration: x.length / SR };
}

function toWav(x) {
  const ch = 2, n = x.length;
  const b = Buffer.alloc(44 + n * ch * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, x[i])) * 32767;
    b.writeInt16LE(v | 0, o); b.writeInt16LE(v | 0, o + 2); o += 4;
  }
  return b;
}
