// Audio effects (clip inserts and track buses). Pure JS sample processing with NO imports: the very same code runs in
// the preview (inside an AudioWorklet, see src/components/player/dsp-worklet.js) and in the export mixer
// (electron/export/audio-mix.js), so what you hear while editing is what you get in the file.
//
//   clip.afx / track.afx = [{ type, ...params }]   processed in order, stereo, 48 kHz in the export.
//   Time-based effects (LFOs, noise) are functions of the absolute sample position (clip-local for clip inserts,
//   timeline time for track buses), so the preview matches the export at any playhead position.

const TAU = Math.PI * 2;
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
const dbToGain = (db) => Math.pow(10, db / 20);

// [default, min, max, unit?]
export const AFX = {
  reverb: { fr: 'Réverbération', en: 'Reverb', cat: 'space', params: { size: [0.6, 0, 1], damp: [0.4, 0, 1], mix: [0.3, 0, 1], predelay: [12, 0, 250, 'ms'], width: [1, 0, 1] } },
  echo: { fr: 'Écho / delay', en: 'Echo / delay', cat: 'space', params: { delay: [300, 20, 2000, 'ms'], feedback: [0.4, 0, 0.92], mix: [0.35, 0, 1], damp: [0.3, 0, 1] } },
  walkie: { fr: 'Talkie-walkie', en: 'Walkie-talkie', cat: 'voice', params: { drive: [0.6, 0, 1], noise: [0.05, 0, 1], squelch: [1, 0, 1] } },
  telephone: { fr: 'Téléphone', en: 'Telephone', cat: 'voice', params: { drive: [0.3, 0, 1] } },
  radio: { fr: 'Vieille radio', en: 'Old radio', cat: 'voice', params: { crackle: [0.3, 0, 1], drive: [0.3, 0, 1] } },
  megaphone: { fr: 'Mégaphone', en: 'Megaphone', cat: 'voice', params: { drive: [0.7, 0, 1] } },
  underwater: { fr: 'Sous l\'eau', en: 'Underwater', cat: 'voice', params: { depth: [0.7, 0, 1] } },
  robot: { fr: 'Robot', en: 'Robot', cat: 'voice', params: { freq: [55, 10, 400, 'Hz'], metal: [0.5, 0, 1], mix: [1, 0, 1] } },
  pitch: { fr: 'Hauteur (pitch)', en: 'Pitch shift', cat: 'voice', params: { semitones: [5, -12, 12, 'st'], mix: [1, 0, 1] } },
  chorus: { fr: 'Chorus', en: 'Chorus', cat: 'mod', params: { rate: [0.8, 0.05, 5, 'Hz'], depth: [0.5, 0, 1], mix: [0.5, 0, 1] } },
  flanger: { fr: 'Flanger', en: 'Flanger', cat: 'mod', params: { rate: [0.25, 0.02, 5, 'Hz'], depth: [0.7, 0, 1], feedback: [0.5, -0.95, 0.95], mix: [0.5, 0, 1] } },
  tremolo: { fr: 'Trémolo', en: 'Tremolo', cat: 'mod', params: { rate: [5, 0.1, 20, 'Hz'], depth: [0.6, 0, 1] } },
  vibrato: { fr: 'Vibrato', en: 'Vibrato', cat: 'mod', params: { rate: [5, 0.1, 14, 'Hz'], depth: [0.4, 0, 1] } },
  autopan: { fr: 'Audio 8D (auto-pan)', en: '8D audio (auto-pan)', cat: 'mod', params: { rate: [0.15, 0.02, 4, 'Hz'], depth: [1, 0, 1] } },
  distortion: { fr: 'Distorsion', en: 'Distortion', cat: 'color', params: { drive: [0.5, 0, 1], tone: [0.6, 0, 1], mix: [1, 0, 1] } },
  bitcrush: { fr: 'Bitcrusher / lo-fi', en: 'Bitcrusher / lo-fi', cat: 'color', params: { bits: [6, 2, 16], downsample: [6, 1, 40], mix: [1, 0, 1] } },
  vinyl: { fr: 'Vinyle', en: 'Vinyl', cat: 'color', params: { crackle: [0.5, 0, 1], wear: [0.5, 0, 1] } },
  eq: { fr: 'Égaliseur 3 bandes', en: '3-band EQ', cat: 'tone', params: { low: [0, -18, 18, 'dB'], mid: [0, -18, 18, 'dB'], high: [0, -18, 18, 'dB'] } },
  highpass: { fr: 'Passe-haut', en: 'High-pass', cat: 'tone', params: { freq: [120, 20, 8000, 'Hz'] } },
  lowpass: { fr: 'Passe-bas', en: 'Low-pass', cat: 'tone', params: { freq: [4000, 100, 20000, 'Hz'] } },
  compressor: { fr: 'Compresseur', en: 'Compressor', cat: 'dynamics', params: { threshold: [-20, -60, 0, 'dB'], ratio: [4, 1, 20], attack: [10, 0.1, 200, 'ms'], release: [150, 10, 2000, 'ms'], makeup: [4, 0, 24, 'dB'] } },
  gate: { fr: 'Noise gate', en: 'Noise gate', cat: 'dynamics', params: { threshold: [-45, -90, 0, 'dB'], release: [120, 10, 2000, 'ms'] } },
  width: { fr: 'Largeur stéréo', en: 'Stereo width', cat: 'space', params: { width: [1.6, 0, 3] } },
  gain: { fr: 'Gain', en: 'Gain', cat: 'dynamics', params: { db: [0, -24, 24, 'dB'] } },
};
export const AFX_TYPES = Object.keys(AFX);

/** One-click combinations (chains). */
export const AFX_PRESETS = {
  'walkie-talkie': { fr: 'Talkie-walkie', en: 'Walkie-talkie', chain: [{ type: 'walkie' }] },
  phone: { fr: 'Appel téléphonique', en: 'Phone call', chain: [{ type: 'telephone' }] },
  'old-radio': { fr: 'Vieille radio', en: 'Old radio', chain: [{ type: 'radio' }] },
  megaphone: { fr: 'Mégaphone', en: 'Megaphone', chain: [{ type: 'megaphone' }] },
  underwater: { fr: 'Sous l\'eau', en: 'Underwater', chain: [{ type: 'underwater' }] },
  'small-room': { fr: 'Petite pièce', en: 'Small room', chain: [{ type: 'reverb', size: 0.3, damp: 0.6, mix: 0.2, predelay: 5 }] },
  hall: { fr: 'Grande salle', en: 'Concert hall', chain: [{ type: 'reverb', size: 0.75, damp: 0.4, mix: 0.32, predelay: 25 }] },
  cathedral: { fr: 'Cathédrale', en: 'Cathedral', chain: [{ type: 'reverb', size: 0.97, damp: 0.25, mix: 0.45, predelay: 40 }] },
  cave: { fr: 'Grotte', en: 'Cave', chain: [{ type: 'echo', delay: 180, feedback: 0.35, mix: 0.25, damp: 0.5 }, { type: 'reverb', size: 0.9, damp: 0.7, mix: 0.4, predelay: 30 }] },
  stadium: { fr: 'Stade', en: 'Stadium', chain: [{ type: 'echo', delay: 420, feedback: 0.25, mix: 0.2, damp: 0.6 }, { type: 'reverb', size: 0.92, damp: 0.5, mix: 0.35, predelay: 60 }] },
  echo: { fr: 'Écho', en: 'Echo', chain: [{ type: 'echo', delay: 350, feedback: 0.45, mix: 0.4 }] },
  robot: { fr: 'Robot', en: 'Robot', chain: [{ type: 'robot' }] },
  chipmunk: { fr: 'Voix aiguë (chipmunk)', en: 'Chipmunk', chain: [{ type: 'pitch', semitones: 7 }] },
  monster: { fr: 'Voix de monstre', en: 'Monster', chain: [{ type: 'pitch', semitones: -7 }, { type: 'distortion', drive: 0.25, tone: 0.4, mix: 0.6 }, { type: 'reverb', size: 0.6, mix: 0.2 }] },
  '8d': { fr: 'Audio 8D', en: '8D audio', chain: [{ type: 'autopan', rate: 0.12 }, { type: 'reverb', size: 0.5, mix: 0.15 }] },
  lofi: { fr: 'Lo-fi', en: 'Lo-fi', chain: [{ type: 'bitcrush', bits: 8, downsample: 3, mix: 0.6 }, { type: 'lowpass', freq: 5500 }, { type: 'vinyl', crackle: 0.4, wear: 0.4 }] },
  dream: { fr: 'Rêve', en: 'Dreamy', chain: [{ type: 'chorus', rate: 0.5, depth: 0.6, mix: 0.4 }, { type: 'reverb', size: 0.85, damp: 0.3, mix: 0.4, predelay: 30 }] },
  'voice-boost': { fr: 'Voix en avant', en: 'Voice boost', chain: [{ type: 'highpass', freq: 90 }, { type: 'eq', low: -2, mid: 2, high: 3 }, { type: 'compressor', threshold: -22, ratio: 3.5, makeup: 5 }] },
  'bass-boost': { fr: 'Bass boost', en: 'Bass boost', chain: [{ type: 'eq', low: 9, mid: -1, high: 1 }, { type: 'compressor', threshold: -14, ratio: 3, makeup: 2 }] },
  muffled: { fr: 'Étouffé (autre pièce)', en: 'Muffled (next room)', chain: [{ type: 'lowpass', freq: 700 }, { type: 'reverb', size: 0.35, damp: 0.8, mix: 0.25 }] },
};

/** Validate / clamp an effect list. Returns null when empty. */
export function normalizeAfx(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list.slice(0, 16)) {
    const def = AFX[it?.type];
    if (!def) continue;
    const o = { type: it.type };
    for (const [k, spec] of Object.entries(def.params)) {
      const v = Number(it[k]);
      o[k] = Number.isFinite(v) ? clampN(v, spec[1], spec[2]) : spec[0];
    }
    if (it.bypass) o.bypass = true;
    out.push(o);
  }
  return out.length ? out : null;
}

/** Expand preset names inside a list ({ preset: 'cathedral' } or 'cathedral'). */
export function expandAfx(list) {
  const out = [];
  for (const it of [].concat(list || [])) {
    const id = typeof it === 'string' ? it : it?.preset;
    if (id && AFX_PRESETS[id]) out.push(...AFX_PRESETS[id].chain.map((x) => ({ ...x })));
    else if (it && typeof it === 'object' && AFX[it.type]) out.push(it);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ building blocks
/** Deterministic noise: hash of the absolute sample index (identical in preview and export at any position). */
function noiseAt(i, seed) {
  let x = (i * 374761393 + seed * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z = [0, 0, 0, 0]; }
  /** RBJ cookbook. type: lowpass | highpass | bandpass | peaking | lowshelf | highshelf */
  set(type, freq, sr, q = 0.7071, gainDb = 0) {
    const w = TAU * clampN(freq, 10, sr * 0.49) / sr, cw = Math.cos(w), sw = Math.sin(w);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    const alpha = sw / (2 * q);
    switch (type) {
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'lowshelf': case 'highshelf': {
        const al = (sw / 2) * Math.sqrt(2); // shelf slope S = 1
        const sq = 2 * Math.sqrt(A) * al;
        if (type === 'lowshelf') {
          b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq);
          a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq;
        } else {
          b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
          a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq;
        }
        break;
      }
      default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; // lowpass
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  /** Process channel ch (0/1) of buffer x in place. */
  run(x, n, ch) {
    const { b0, b1, b2, a1, a2 } = this;
    const zi = ch * 2;
    let s1 = this.z[zi], s2 = this.z[zi + 1];
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const y = b0 * v + s1;
      s1 = b1 * v - a1 * y + s2;
      s2 = b2 * v - a2 * y;
      x[i] = y;
    }
    this.z[zi] = Math.abs(s1) < 1e-25 ? 0 : s1; this.z[zi + 1] = Math.abs(s2) < 1e-25 ? 0 : s2;
  }
  stereo(L, R, n) { this.run(L, n, 0); this.run(R, n, 1); }
}

class Delay {
  constructor(len) { this.buf = new Float32Array(Math.max(4, len | 0)); this.w = 0; }
  push(v) { this.buf[this.w] = v; this.w = (this.w + 1) % this.buf.length; }
  /** Sample `d` samples ago (fractional, linear interpolation); d ≥ 1. */
  read(d) {
    const L = this.buf.length;
    const p = this.w - d;
    const i0 = Math.floor(p);
    const fr = p - i0;
    const a = this.buf[((i0 % L) + L) % L], b = this.buf[(((i0 + 1) % L) + L) % L];
    return a + (b - a) * fr;
  }
}

const softclip = (x) => Math.tanh(x);

// ------------------------------------------------------------------------------------------------ effects
// Each effect: constructor(params, sr), set(params), process(L, R, n, pos) in place, tail (seconds).

class Reverb { // Freeverb (Jezar) with predelay
  constructor(p, sr) {
    this.sr = sr;
    const k = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
    this.cL = combs.map((t) => ({ d: new Float32Array(Math.round(t * k)), i: 0, f: 0 }));
    this.cR = combs.map((t) => ({ d: new Float32Array(Math.round((t + 23) * k)), i: 0, f: 0 }));
    this.aL = aps.map((t) => ({ d: new Float32Array(Math.round(t * k)), i: 0 }));
    this.aR = aps.map((t) => ({ d: new Float32Array(Math.round((t + 23) * k)), i: 0 }));
    this.pre = [new Delay(Math.round(0.26 * sr)), new Delay(Math.round(0.26 * sr))];
    this.set(p);
  }
  set(p) {
    this.p = p;
    this.room = 0.7 + p.size * 0.28;
    this.damp = p.damp * 0.4;
    this.wet1 = 3 * (p.width / 2 + 0.5); this.wet2 = 3 * ((1 - p.width) / 2);
    this.preN = Math.max(1, Math.round((p.predelay / 1000) * this.sr));
    this.tail = 0.5 + p.size * 7;
  }
  process(L, R, n) {
    const { room, damp, wet1, wet2, preN } = this;
    const mix = this.p.mix, dry = 1 - mix;
    const comb = (c, x) => {
      const y = c.d[c.i];
      c.f = y * (1 - damp) + c.f * damp;
      c.d[c.i] = x + c.f * room;
      if (++c.i >= c.d.length) c.i = 0;
      return y;
    };
    const ap = (a, x) => {
      const b = a.d[a.i];
      a.d[a.i] = x + b * 0.5;
      if (++a.i >= a.d.length) a.i = 0;
      return b - x;
    };
    for (let i = 0; i < n; i++) {
      const inL = L[i], inR = R[i];
      this.pre[0].push(inL); this.pre[1].push(inR);
      const x = (this.pre[0].read(preN) + this.pre[1].read(preN)) * 0.015;
      let oL = 0, oR = 0;
      for (let k = 0; k < 8; k++) { oL += comb(this.cL[k], x); oR += comb(this.cR[k], x); }
      for (let k = 0; k < 4; k++) { oL = ap(this.aL[k], oL); oR = ap(this.aR[k], oR); }
      L[i] = inL * dry + mix * (oL * wet1 + oR * wet2);
      R[i] = inR * dry + mix * (oR * wet1 + oL * wet2);
    }
  }
}

class Echo {
  constructor(p, sr) { this.sr = sr; this.dl = [new Delay(Math.round(2.05 * sr)), new Delay(Math.round(2.05 * sr))]; this.lp = [0, 0]; this.set(p); }
  set(p) { this.p = p; this.d = Math.max(1, (p.delay / 1000) * this.sr); this.tail = p.feedback > 0.01 ? Math.min(12, (p.delay / 1000) * Math.log(0.001) / Math.log(p.feedback)) : p.delay / 1000; }
  process(L, R, n) {
    const { d } = this;
    const fb = this.p.feedback, mix = this.p.mix, damp = this.p.damp * 0.85;
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L;
        const dl = this.dl[ch];
        const y = dl.read(d);
        this.lp[ch] = y * (1 - damp) + this.lp[ch] * damp;
        dl.push(X[i] + this.lp[ch] * fb);
        X[i] += y * mix;
      }
    }
  }
}

class Filters { // a fixed filter bank (voice colours)
  constructor(spec, sr) { this.f = spec.map(([type, freq, q, g]) => new Biquad().set(type, freq, sr, q, g)); }
  process(L, R, n) { for (const b of this.f) b.stereo(L, R, n); }
}

class Walkie {
  constructor(p, sr) {
    this.sr = sr;
    this.bank = new Filters([['highpass', 450, 0.9], ['highpass', 450, 0.9], ['lowpass', 2700, 0.9], ['lowpass', 2700, 0.9], ['peaking', 1600, 1, 5]], sr);
    this.hiss = new Filters([['bandpass', 3000, 0.6]], sr);
    this.env = 0; this.open = 0;
    this.set(p);
  }
  set(p) { this.p = p; this.tail = 0.25; }
  process(L, R, n, pos) {
    const drive = 1 + this.p.drive * 14, norm = 1 / Math.tanh(drive * 0.35);
    const att = Math.exp(-1 / (0.002 * this.sr)), rel = Math.exp(-1 / (0.12 * this.sr));
    if (!this.nz || this.nz.length < n) { this.nz = new Float32Array(n); this.nz2 = new Float32Array(n); }
    const noise = this.nz, noise2 = this.nz2;
    for (let i = 0; i < n; i++) noise[i] = noise2[i] = noiseAt(pos + i, 7);
    this.hiss.process(noise, noise2, n);
    this.bank.process(L, R, n);
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5;
      const a = Math.abs(m);
      this.env = a > this.env ? att * this.env + (1 - att) * a : rel * this.env + (1 - rel) * a;
      const target = this.p.squelch > 0.5 ? (this.env > 0.01 ? 1 : 0) : 1;
      this.open += (target - this.open) * 0.0015;
      let y = Math.tanh(m * drive * 0.35) * norm * 0.7;
      y = Math.round(y * 96) / 96; // 7-bit grit
      y += noise[i] * this.p.noise * 0.9 * this.open;
      L[i] = R[i] = y;
    }
  }
}

class Voicebox { // telephone / radio / megaphone / underwater
  constructor(kind, p, sr) {
    this.kind = kind; this.sr = sr;
    const banks = {
      telephone: [['highpass', 320, 0.8], ['highpass', 320, 0.8], ['lowpass', 3300, 0.8], ['lowpass', 3300, 0.8], ['peaking', 1800, 1, 3]],
      radio: [['highpass', 500, 0.7], ['lowpass', 4300, 0.7], ['lowpass', 4300, 0.7], ['peaking', 1500, 0.9, 6]],
      megaphone: [['highpass', 650, 1], ['highpass', 650, 1], ['lowpass', 3000, 1], ['peaking', 1800, 1.2, 8]],
      underwater: [['lowpass', 420, 0.9], ['lowpass', 420, 0.9], ['lowshelf', 150, 0.7, 4]],
    };
    this.bank = new Filters(banks[kind], sr);
    this.wob = new Delay(Math.round(0.03 * sr));
    this.wobR = new Delay(Math.round(0.03 * sr));
    this.set(p);
  }
  set(p) { this.p = p; this.tail = 0.1; }
  process(L, R, n, pos) {
    const k = this.kind;
    if (k === 'underwater') {
      const depth = this.p.depth;
      for (let i = 0; i < n; i++) {
        const d = 0.006 * this.sr * (1 + depth * Math.sin(TAU * 0.6 * (pos + i) / this.sr));
        this.wob.push(L[i]); this.wobR.push(R[i]);
        L[i] = this.wob.read(Math.max(1, d)); R[i] = this.wobR.read(Math.max(1, d));
      }
      this.bank.process(L, R, n);
      const g = 1.3 + depth * 0.6;
      for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
      return;
    }
    this.bank.process(L, R, n);
    const drive = k === 'megaphone' ? 1 + this.p.drive * 10 : 1 + this.p.drive * 5;
    const norm = 1 / Math.tanh(drive * 0.5);
    const crackle = k === 'radio' ? this.p.crackle : 0;
    for (let i = 0; i < n; i++) {
      let l = Math.tanh(L[i] * drive * 0.5) * norm * 0.8, r = Math.tanh(R[i] * drive * 0.5) * norm * 0.8;
      if (crackle) {
        const nz = noiseAt(pos + i, 11);
        const pop = noiseAt(pos + i, 23) > 1 - 0.0004 * crackle ? nz * 0.4 : 0;
        l += nz * 0.012 * crackle + pop; r += nz * 0.012 * crackle + pop;
      }
      L[i] = l; R[i] = r;
    }
  }
}

class Robot {
  constructor(p, sr) { this.sr = sr; this.dl = [new Delay(Math.round(0.02 * sr)), new Delay(Math.round(0.02 * sr))]; this.set(p); }
  set(p) { this.p = p; this.tail = 0.1; }
  process(L, R, n, pos) {
    const f = this.p.freq, mix = this.p.mix, metal = this.p.metal;
    const d = 0.0045 * this.sr;
    for (let i = 0; i < n; i++) {
      const car = Math.sin(TAU * f * (pos + i) / this.sr);
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L;
        const dl = this.dl[ch];
        const c = dl.read(d);
        const m = X[i] * car * 1.6;
        dl.push(m + c * 0.55 * metal);
        X[i] = X[i] * (1 - mix) + (m + c * metal * 0.7) * mix;
      }
    }
  }
}

class Pitch { // delay-line pitch shifter: two taps, crossfaded saw windows
  constructor(p, sr) {
    this.sr = sr; this.win = Math.round(0.05 * sr);
    this.dl = [new Delay(this.win * 3), new Delay(this.win * 3)];
    this.ph = 0; this.set(p);
  }
  set(p) { this.p = p; this.ratio = Math.pow(2, p.semitones / 12); this.tail = 0.06; }
  process(L, R, n) {
    const W = this.win, step = (1 - this.ratio) / W, mix = this.p.mix;
    for (let i = 0; i < n; i++) {
      this.ph += step;
      this.ph -= Math.floor(this.ph);
      const p2 = (this.ph + 0.5) % 1;
      const s1 = Math.sin(Math.PI * this.ph), s2 = Math.sin(Math.PI * p2);
      const g1 = s1 * s1, g2 = s2 * s2; // sin² + cos² = 1: constant level
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L;
        const dl = this.dl[ch];
        dl.push(X[i]);
        const y = dl.read(1 + this.ph * W) * g1 + dl.read(1 + p2 * W) * g2;
        X[i] = X[i] * (1 - mix) + y * mix;
      }
    }
  }
}

class ModDelay { // chorus / flanger / vibrato
  constructor(kind, p, sr) { this.kind = kind; this.sr = sr; this.dl = [new Delay(Math.round(0.06 * sr)), new Delay(Math.round(0.06 * sr))]; this.set(p); }
  set(p) { this.p = p; this.tail = 0.06; }
  process(L, R, n, pos) {
    const sr = this.sr, p = this.p, k = this.kind;
    for (let i = 0; i < n; i++) {
      const t = (pos + i) / sr;
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L;
        const dl = this.dl[ch];
        const x = X[i];
        let y;
        if (k === 'chorus') {
          y = 0;
          for (let v = 0; v < 3; v++) {
            const ph = TAU * p.rate * t + v * 2.0944 + ch * 1.5708;
            y += dl.read((0.018 + 0.006 * p.depth * (1 + Math.sin(ph))) * sr) / 3;
          }
          dl.push(x);
          X[i] = x * (1 - p.mix * 0.5) + y * p.mix;
        } else if (k === 'flanger') {
          const d = (0.0008 + 0.0045 * p.depth * (0.5 + 0.5 * Math.sin(TAU * p.rate * t + ch * 0.4))) * sr;
          y = dl.read(Math.max(1, d));
          dl.push(x + y * p.feedback);
          X[i] = x * (1 - p.mix * 0.5) + y * p.mix;
        } else { // vibrato
          const d = (0.005 + 0.004 * p.depth * Math.sin(TAU * p.rate * t)) * sr;
          dl.push(x);
          X[i] = dl.read(Math.max(1, d));
        }
      }
    }
  }
}

class Tremolo {
  constructor(p, sr) { this.sr = sr; this.set(p); }
  set(p) { this.p = p; this.tail = 0; }
  process(L, R, n, pos) {
    const { rate, depth } = this.p;
    for (let i = 0; i < n; i++) {
      const g = 1 - depth * (0.5 + 0.5 * Math.sin(TAU * rate * (pos + i) / this.sr));
      L[i] *= g; R[i] *= g;
    }
  }
}

class AutoPan {
  constructor(p, sr) { this.sr = sr; this.set(p); }
  set(p) { this.p = p; this.tail = 0; }
  process(L, R, n, pos) {
    const { rate, depth } = this.p;
    for (let i = 0; i < n; i++) {
      const pan = depth * Math.sin(TAU * rate * (pos + i) / this.sr);
      const a = ((pan + 1) * Math.PI) / 4;
      const m = (L[i] + R[i]) * 0.5;
      const side = (L[i] - R[i]) * 0.5 * (1 - depth);
      L[i] = m * Math.cos(a) * Math.SQRT2 + side;
      R[i] = m * Math.sin(a) * Math.SQRT2 - side;
    }
  }
}

class Distortion {
  constructor(p, sr) { this.sr = sr; this.tone = new Biquad(); this.set(p); }
  set(p) { this.p = p; this.drive = 1 + p.drive * 40; this.norm = 1 / Math.tanh(this.drive * 0.3); this.tone.set('lowpass', 800 + p.tone * 11000, this.sr, 0.7); this.tail = 0; }
  process(L, R, n) {
    const { drive, norm } = this, mix = this.p.mix;
    if (!this.dL || this.dL.length < n) { this.dL = new Float32Array(n); this.dR = new Float32Array(n); }
    const dL = this.dL, dR = this.dR;
    for (let i = 0; i < n; i++) { dL[i] = Math.tanh(L[i] * drive * 0.3) * norm * 0.6; dR[i] = Math.tanh(R[i] * drive * 0.3) * norm * 0.6; }
    this.tone.stereo(dL, dR, n);
    for (let i = 0; i < n; i++) { L[i] = L[i] * (1 - mix) + dL[i] * mix; R[i] = R[i] * (1 - mix) + dR[i] * mix; }
  }
}

class Bitcrush {
  constructor(p, sr) { this.set(p); this.hold = [0, 0]; }
  set(p) { this.p = p; this.q = Math.pow(2, Math.round(p.bits) - 1); this.ds = Math.max(1, Math.round(p.downsample)); this.tail = 0; }
  process(L, R, n, pos) {
    const { q, ds } = this, mix = this.p.mix;
    for (let i = 0; i < n; i++) {
      if ((pos + i) % ds === 0) { this.hold[0] = Math.round(L[i] * q) / q; this.hold[1] = Math.round(R[i] * q) / q; }
      L[i] = L[i] * (1 - mix) + this.hold[0] * mix; R[i] = R[i] * (1 - mix) + this.hold[1] * mix;
    }
  }
}

class Vinyl {
  constructor(p, sr) { this.sr = sr; this.bank = new Filters([['highpass', 60, 0.7], ['lowpass', 7500, 0.7]], sr); this.dl = [new Delay(Math.round(0.01 * sr)), new Delay(Math.round(0.01 * sr))]; this.set(p); }
  set(p) { this.p = p; this.tail = 0.02; }
  process(L, R, n, pos) {
    this.bank.process(L, R, n);
    const { crackle, wear } = this.p;
    for (let i = 0; i < n; i++) {
      const idx = pos + i;
      const d = (0.003 + 0.0012 * wear * Math.sin(TAU * 0.55 * idx / this.sr)) * this.sr;
      this.dl[0].push(L[i]); this.dl[1].push(R[i]);
      let l = this.dl[0].read(d), r = this.dl[1].read(d);
      const hiss = noiseAt(idx, 31) * 0.004 * wear;
      const pop = noiseAt(idx, 37) > 1 - 0.0006 * crackle ? noiseAt(idx, 41) * 0.35 * crackle : 0;
      l += hiss + pop; r += hiss + pop;
      L[i] = l; R[i] = r;
    }
  }
}

class EQ3 {
  constructor(p, sr) { this.sr = sr; this.b = [new Biquad(), new Biquad(), new Biquad()]; this.set(p); }
  set(p) { this.p = p; this.b[0].set('lowshelf', 200, this.sr, 0.7, p.low); this.b[1].set('peaking', 1000, this.sr, 0.9, p.mid); this.b[2].set('highshelf', 5000, this.sr, 0.7, p.high); this.tail = 0; }
  process(L, R, n) { for (const b of this.b) b.stereo(L, R, n); }
}

class Pass {
  constructor(type, p, sr) { this.type = type; this.sr = sr; this.b = [new Biquad(), new Biquad()]; this.set(p); }
  set(p) { this.p = p; for (const b of this.b) b.set(this.type, p.freq, this.sr, 0.7071); this.tail = 0; }
  process(L, R, n) { for (const b of this.b) b.stereo(L, R, n); }
}

class Compressor {
  constructor(p, sr) { this.sr = sr; this.env = 0; this.set(p); }
  set(p) { this.p = p; this.att = Math.exp(-1 / (Math.max(0.0001, p.attack / 1000) * this.sr)); this.rel = Math.exp(-1 / (Math.max(0.001, p.release / 1000) * this.sr)); this.mk = dbToGain(p.makeup); this.tail = 0; }
  process(L, R, n) {
    const { att, rel, mk } = this, th = this.p.threshold, ratio = this.p.ratio;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = a > this.env ? att * this.env + (1 - att) * a : rel * this.env + (1 - rel) * a;
      const db = 20 * Math.log10(this.env + 1e-9);
      const over = db - th;
      const g = over > 0 ? dbToGain(-over * (1 - 1 / ratio)) * mk : mk;
      L[i] *= g; R[i] *= g;
    }
  }
}

class Gate {
  constructor(p, sr) { this.sr = sr; this.env = 0; this.g = 1; this.set(p); }
  set(p) { this.p = p; this.th = dbToGain(p.threshold); this.rel = Math.exp(-1 / (Math.max(0.001, p.release / 1000) * this.sr)); this.att = Math.exp(-1 / (0.001 * this.sr)); this.tail = 0; }
  process(L, R, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = a > this.env ? a : this.env * 0.9995;
      const target = this.env > this.th ? 1 : 0;
      this.g = target > this.g ? this.att * this.g + (1 - this.att) * target : this.rel * this.g + (1 - this.rel) * target;
      L[i] *= this.g; R[i] *= this.g;
    }
  }
}

class Width {
  constructor(p) { this.set(p); }
  set(p) { this.p = p; this.tail = 0; }
  process(L, R, n) {
    const w = this.p.width;
    for (let i = 0; i < n; i++) { const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * w; L[i] = m + s; R[i] = m - s; }
  }
}

class Gain {
  constructor(p) { this.set(p); }
  set(p) { this.p = p; this.g = dbToGain(p.db); this.tail = 0; }
  process(L, R, n) { const g = this.g; for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; } }
}

function makeEffect(it, sr) {
  switch (it.type) {
    case 'reverb': return new Reverb(it, sr);
    case 'echo': return new Echo(it, sr);
    case 'walkie': return new Walkie(it, sr);
    case 'telephone': case 'radio': case 'megaphone': case 'underwater': return new Voicebox(it.type, it, sr);
    case 'robot': return new Robot(it, sr);
    case 'pitch': return new Pitch(it, sr);
    case 'chorus': case 'flanger': case 'vibrato': return new ModDelay(it.type, it, sr);
    case 'tremolo': return new Tremolo(it, sr);
    case 'autopan': return new AutoPan(it, sr);
    case 'distortion': return new Distortion(it, sr);
    case 'bitcrush': return new Bitcrush(it, sr);
    case 'vinyl': return new Vinyl(it, sr);
    case 'eq': return new EQ3(it, sr);
    case 'highpass': case 'lowpass': return new Pass(it.type, it, sr);
    case 'compressor': return new Compressor(it, sr);
    case 'gate': return new Gate(it, sr);
    case 'width': return new Width(it, sr);
    case 'gain': return new Gain(it, sr);
    default: return null;
  }
}

/** Track pan (same law as WebAudio's StereoPannerNode for stereo input). */
export function applyPan(L, R, n, pan) {
  if (!pan) return;
  const x = pan <= 0 ? pan + 1 : pan;
  const gL = Math.cos((x * Math.PI) / 2), gR = Math.sin((x * Math.PI) / 2);
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    if (pan <= 0) { L[i] = l + r * gL; R[i] = r * gR; } else { L[i] = l * gL; R[i] = r + l * gR; }
  }
}

/**
 * Effect chain. process(L, R, n): in place on Float32Arrays, advancing the sample position.
 * setPosition(sample): position used by LFOs / noise (clip-local or timeline sample index).
 */
export class AfxChain {
  constructor(list, sr = 48000, opts = {}) {
    this.sr = sr;
    this.pos = 0;
    this.pan = opts.pan || 0;
    this.build(list || []);
  }
  build(list) {
    this.list = (list || []).filter((x) => AFX[x?.type]);
    this.fx = this.list.map((it) => makeEffect(it, this.sr));
    this.sig = this.list.map((x) => x.type).join('|');
  }
  /** Update parameters; rebuilds only when the effect types / order change. */
  update(list, opts = {}) {
    if (opts.pan !== undefined) this.pan = opts.pan || 0;
    const l = (list || []).filter((x) => AFX[x?.type]);
    if (l.map((x) => x.type).join('|') !== this.sig) { this.build(l); return; }
    this.list = l;
    l.forEach((it, i) => this.fx[i]?.set(it));
  }
  get tail() { let t = 0; this.fx.forEach((f, i) => { if (f && !this.list[i].bypass) t = Math.max(t, f.tail || 0); }); return Math.min(8, t); }
  get active() { return this.fx.some((f, i) => f && !this.list[i].bypass) || !!this.pan; }
  setPosition(sample) { this.pos = Math.max(0, Math.round(sample)); }
  process(L, R, n) {
    for (let k = 0; k < this.fx.length; k++) {
      const f = this.fx[k];
      if (f && !this.list[k].bypass) f.process(L, R, n, this.pos);
    }
    applyPan(L, R, n, this.pan);
    for (let i = 0; i < n; i++) { // NaN guard + hard ceiling (feedback runaways never explode the mix)
      const l = L[i], r = R[i];
      L[i] = l === l ? (l > 8 ? 8 : l < -8 ? -8 : l) : 0;
      R[i] = r === r ? (r > 8 ? 8 : r < -8 ? -8 : r) : 0;
    }
    this.pos += n;
  }
}

/** Short human description of a chain (AI / UI). */
export function afxSummary(list, lang = 'fr') {
  return (list || []).map((x) => (lang === 'en' ? AFX[x.type]?.en : AFX[x.type]?.fr) || x.type).join(' → ');
}
