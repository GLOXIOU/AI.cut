// Voice / music separation test (Node, ONNX Runtime wasm): mixes a voice and a music, separates them and reports the
// SDR of the recovered voice for a given n_fft. node scripts/mdx-test.mjs <models dir> <voice.f32> <music.f32> <outDir> [nFft]
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { MDX_MODELS, mdxGeometry, mdxInput, mdxOutput, stftStereo, istftStereo } from '../shared/mdx.js';

const [models, vf, mf, outDir, nfftArg] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const cfg = { ...MDX_MODELS['kim-vocal-2'], ...(nfftArg ? { nFft: Number(nfftArg) } : {}) };
const readF32 = (f) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const v = readF32(vf), m = readF32(mf);
const n = Math.min(v.length, m.length) / 2;
const split = (x) => { const L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; } return [L, R]; };
const [vL, vR] = split(v), [mL, mR] = split(m);
const xL = vL.map((s, i) => s + mL[i]), xR = vR.map((s, i) => s + mR[i]);

// STFT round trip sanity
const [a, b] = stftStereo(xL.subarray(0, 50000), xR.subarray(0, 50000), cfg.nFft, cfg.hop, Math.floor(50000 / cfg.hop) + 1);
const [rL] = istftStereo(a, b, cfg.nFft, cfg.hop, Math.floor(50000 / cfg.hop) + 1, 50000);
let err = 0; for (let i = 0; i < 50000; i++) err = Math.max(err, Math.abs(rL[i] - xL[i]));
console.log('stft round-trip max error', err.toExponential(2));

const sess = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(models, cfg.file))));
const { trim, chunk, gen } = mdxGeometry(cfg);
const pad = gen - (n % gen);
const total = trim + n + pad + trim;
const PL = new Float32Array(total), PR = new Float32Array(total);
PL.set(xL, trim); PR.set(xR, trim);
const outL = new Float32Array(n + pad), outR = new Float32Array(n + pad);
const t0 = Date.now();
for (let i = 0, k = 0; i + chunk <= total; i += gen, k++) {
  const x = mdxInput(cfg, PL.subarray(i, i + chunk), PR.subarray(i, i + chunk));
  const r = await sess.run({ input: new ort.Tensor('float32', x, [1, 4, cfg.dimF, cfg.dimT]) });
  const [yL, yR] = mdxOutput(cfg, r.output.data);
  outL.set(yL.subarray(trim, trim + gen), k * gen); outR.set(yR.subarray(trim, trim + gen), k * gen);
}
console.log('separation', Date.now() - t0, 'ms for', (n / 44100).toFixed(1), 's');
const sdr = (ref, est) => { let s = 0, e = 0; for (let i = 0; i < n; i++) { s += ref[i] * ref[i]; const d = ref[i] - est[i]; e += d * d; } return 10 * Math.log10(s / e); };
const vocL = outL.map((x) => x * cfg.compensate);
const insL = xL.map((x, i) => x - vocL[i]);
console.log(`nFft ${cfg.nFft}: voice SDR ${sdr(vL, vocL).toFixed(2)} dB, music SDR ${sdr(mL, insL).toFixed(2)} dB (mix-as-voice baseline ${sdr(vL, xL).toFixed(2)} dB)`);
const inter = (L, R) => { const o = new Float32Array(2 * n); for (let i = 0; i < n; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i]; } return Buffer.from(o.buffer); };
fs.writeFileSync(path.join(outDir, `vocals_${cfg.nFft}.f32`), inter(vocL, outR.map((x) => x * cfg.compensate)));
