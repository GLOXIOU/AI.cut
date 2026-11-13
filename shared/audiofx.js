// Voice / audio effect presets: ffmpeg filters for the export and an equivalent WebAudio chain for the live preview.
// (The export additionally runs a denoiser on the voice presets — the preview cannot.)

export const AUDIO_FX = {
  voice: { label: 'Voix claire', en: 'Clear voice', desc: 'Coupe-bas, présence, compression douce, débruitage' },
  podcast: { label: 'Voix podcast / radio FM', en: 'Podcast voice', desc: 'Voix chaude et dense, compression marquée' },
  radio: { label: 'Vieille radio', en: 'Old radio', desc: 'Bande étroite, médium poussé' },
  phone: { label: 'Téléphone', en: 'Phone call', desc: '300–3400 Hz, légère saturation' },
  megaphone: { label: 'Mégaphone', en: 'Megaphone', desc: 'Bande étroite saturée' },
  deep: { label: 'Voix grave', en: 'Deep voice', desc: 'Graves renforcés, aigus adoucis' },
  echo: { label: 'Écho / salle', en: 'Echo / hall', desc: 'Réverbération ample' },
  underwater: { label: 'Sous l\'eau', en: 'Underwater', desc: 'Filtre passe-bas étouffé' },
};
export const AUDIO_FX_IDS = Object.keys(AUDIO_FX);

/** ffmpeg audio filters for a preset (appended to the clip's chain at export). */
export function audioFxFilters(fx) {
  switch (fx?.preset) {
    case 'voice': return ['highpass=f=80', 'afftdn=nf=-25', 'equalizer=f=3000:t=q:w=1:g=3', 'acompressor=threshold=-24dB:ratio=3:attack=10:release=200:makeup=1.6'];
    case 'podcast': return ['highpass=f=70', 'afftdn=nf=-25', 'lowshelf=f=150:g=3', 'equalizer=f=3500:t=q:w=1:g=4', 'acompressor=threshold=-26dB:ratio=4:attack=10:release=250:makeup=2.2'];
    case 'radio': return ['highpass=f=500', 'lowpass=f=4500', 'equalizer=f=1500:t=q:w=0.8:g=6', 'acompressor=threshold=-22dB:ratio=4:attack=5:release=150:makeup=1.8'];
    case 'phone': return ['highpass=f=300', 'lowpass=f=3400', 'asoftclip=type=tanh', 'volume=1.2'];
    case 'megaphone': return ['highpass=f=600', 'lowpass=f=3000', 'volume=2.2', 'asoftclip=type=tanh', 'volume=0.8'];
    case 'deep': return ['lowshelf=f=200:g=6', 'highshelf=f=4000:g=-3'];
    case 'echo': return ['aecho=0.8:0.8:90|180|300:0.35|0.22|0.12'];
    case 'underwater': return ['lowpass=f=450', 'lowpass=f=450', 'volume=1.4'];
    default: return [];
  }
}

function softClipCurve(amount = 1.5) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
  return curve;
}
function impulse(ctx, sec = 1.6, decay = 2.5) {
  const len = Math.round(ctx.sampleRate * sec);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/**
 * Build a WebAudio chain for the preview. Returns { input, output, nodes } (connect source → input, output → gain).
 */
export function buildAudioFx(ctx, fx) {
  const nodes = [];
  const biq = (type, f, gain = 0, q = 0.707) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = gain; b.Q.value = q; nodes.push(b); return b; };
  const comp = (th, ratio) => { const c = ctx.createDynamicsCompressor(); c.threshold.value = th; c.ratio.value = ratio; c.attack.value = 0.01; c.release.value = 0.2; c.knee.value = 6; nodes.push(c); return c; };
  const gain = (g) => { const n = ctx.createGain(); n.gain.value = g; nodes.push(n); return n; };
  const shaper = (amt) => { const s = ctx.createWaveShaper(); s.curve = softClipCurve(amt); s.oversample = '2x'; nodes.push(s); return s; };
  let chain = [];
  switch (fx?.preset) {
    case 'voice': chain = [biq('highpass', 80), biq('peaking', 3000, 3, 1.2), comp(-24, 3), gain(1.2)]; break;
    case 'podcast': chain = [biq('highpass', 70), biq('lowshelf', 150, 3), biq('peaking', 3500, 4, 1.2), comp(-26, 4), gain(1.3)]; break;
    case 'radio': chain = [biq('highpass', 500), biq('lowpass', 4500), biq('peaking', 1500, 6, 0.9), comp(-22, 4), gain(1.2)]; break;
    case 'phone': chain = [biq('highpass', 300), biq('lowpass', 3400), shaper(1.6), gain(1.2)]; break;
    case 'megaphone': chain = [biq('highpass', 600), biq('lowpass', 3000), gain(2.2), shaper(2.2), gain(0.8)]; break;
    case 'deep': chain = [biq('lowshelf', 200, 6), biq('highshelf', 4000, -3)]; break;
    case 'underwater': chain = [biq('lowpass', 450), biq('lowpass', 450), gain(1.4)]; break;
    case 'echo': {
      const input = gain(1), out = gain(1), wet = gain(0.35), conv = ctx.createConvolver();
      conv.buffer = impulse(ctx, 1.8, 2.2);
      nodes.push(conv);
      input.connect(out); input.connect(conv).connect(wet).connect(out);
      return { input, output: out, nodes };
    }
    default: return null;
  }
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  return { input: chain[0], output: chain[chain.length - 1], nodes };
}
