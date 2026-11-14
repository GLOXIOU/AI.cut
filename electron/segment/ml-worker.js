// Runs inside an Electron utilityProcess with native ONNX Runtime (onnxruntime-node): DirectML on Windows GPUs where it
// is faster (measured: MobileSAM encoder ~0.2 s vs 1 s on CPU), the multi-threaded CPU otherwise (MDX is faster on the
// CPU than on DirectML or WebGPU on an RTX 2070). Every GPU session is checked against the CPU on its first run.
// in:  {id, type: 'samInit' | 'samFrame' | 'samReset' | 'mdxInit' | 'mdxChunk', data}
// out: {id, ok, result | error}
import ort from 'onnxruntime-node';
import { mdxInput, mdxOutput } from '../../shared/mdx.js';

const port = process.parentPort;
const GPU_EPS = process.platform === 'win32' ? ['dml'] : [];

async function session(file, preferGpu) {
  if (preferGpu) {
    for (const ep of GPU_EPS) {
      try { return { s: await ort.InferenceSession.create(file, { executionProviders: [ep], graphOptimizationLevel: 'all' }), ep, file, checked: false }; } catch { /* next */ }
    }
  }
  return { s: await ort.InferenceSession.create(file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 0 }), ep: 'cpu', file, checked: true };
}
const mad = (a, b) => { let d = 0, n = Math.min(a.length, b.length), s = 0; for (let i = 0; i < n; i++) { d += Math.abs(a[i] - b[i]); s += Math.abs(b[i]); } return s ? d / s : d / Math.max(1, n); };
async function runChecked(m, feeds, out, tol) {
  const r = await m.s.run(feeds);
  if (!m.checked) {
    m.checked = true;
    const cpu = await ort.InferenceSession.create(m.file, { executionProviders: ['cpu'] });
    const ref = await cpu.run(feeds);
    const d = mad(r[out].data, ref[out].data);
    if (d > tol) { m.s = cpu; m.ep = 'cpu'; return ref; }
  }
  return r;
}

// ------------------------------------------------------------------------------------------------ MobileSAM (objects)
// Frame-by-frame segmentation guided by the tracking, made self-correcting: the box given to SAM is the previous
// mask's box moved by the tracked motion (blended with the tracked box), the previous low-res mask is given back as a
// dense prompt, and the result is cleaned (largest region, holes filled) before becoming the alpha.
const sam = { enc: null, dec: null, prev: null };
async function samInit({ encoder, decoder }) {
  sam.enc = await session(encoder, true);
  sam.dec = await session(decoder, false);
  sam.prev = null;
  return { ep: sam.enc.ep };
}

const bboxIoU = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  return i / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
};

/** Largest 4-connected region of `on` (Uint8Array W×H), with its holes filled. Returns { mask, box } or null. */
function cleanRegion(on, W, H) {
  const lab = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  let best = 0, bestN = 0, n = 0;
  for (let s = 0; s < W * H; s++) {
    if (!on[s] || lab[s]) continue;
    n++;
    let sp = 0, cnt = 0;
    stack[sp++] = s; lab[s] = n;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % W;
      if (x > 0 && on[p - 1] && !lab[p - 1]) { lab[p - 1] = n; stack[sp++] = p - 1; }
      if (x < W - 1 && on[p + 1] && !lab[p + 1]) { lab[p + 1] = n; stack[sp++] = p + 1; }
      if (p >= W && on[p - W] && !lab[p - W]) { lab[p - W] = n; stack[sp++] = p - W; }
      if (p < W * (H - 1) && on[p + W] && !lab[p + W]) { lab[p + W] = n; stack[sp++] = p + W; }
    }
    if (cnt > bestN) { bestN = cnt; best = n; }
  }
  if (!best) return null;
  // flood the outside (from the borders) through pixels that are not in the region: what is left is region + holes
  const out = new Uint8Array(W * H);
  let sp = 0;
  const push = (p) => { if (!out[p] && lab[p] !== best) { out[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) {
    const p = stack[--sp];
    const x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < W * (H - 1)) push(p + W);
  }
  const mask = new Uint8Array(W * H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let p = 0; p < W * H; p++) {
    if (out[p]) continue;
    mask[p] = 1;
    const x = p % W, y = (p - x) / W;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { mask, box: [x0, y0, x1 + 1, y1 + 1] };
}

/** rgb (Uint8Array W×H×3), box [x0, y0, x1, y1] px (tracked) → alpha W×H. */
async function samFrame({ rgb, W, H, box: trackBox }) {
  const img = new Float32Array(W * H * 3);
  for (let i = 0; i < img.length; i++) img[i] = rgb[i];
  const { image_embeddings: emb } = await runChecked(sam.enc, { input_image: new ort.Tensor('float32', img, [H, W, 3]) }, 'image_embeddings', 0.05);
  // prompt box: previous mask box moved by the tracked motion, blended with the tracked box
  let box = trackBox;
  const prev = sam.prev;
  if (prev?.box) {
    const dx = (trackBox[0] + trackBox[2] - prev.track[0] - prev.track[2]) / 2, dy = (trackBox[1] + trackBox[3] - prev.track[1] - prev.track[3]) / 2;
    const sx = (trackBox[2] - trackBox[0]) / Math.max(1, prev.track[2] - prev.track[0]), sy = (trackBox[3] - trackBox[1]) / Math.max(1, prev.track[3] - prev.track[1]);
    const cx = (prev.box[0] + prev.box[2]) / 2 + dx, cy = (prev.box[1] + prev.box[3]) / 2 + dy;
    const hw = ((prev.box[2] - prev.box[0]) * sx) / 2 * 1.04, hh = ((prev.box[3] - prev.box[1]) * sy) / 2 * 1.04;
    const pred = [cx - hw, cy - hh, cx + hw, cy + hh];
    box = pred.map((v, i) => 0.7 * v + 0.3 * trackBox[i]);
  }
  const k = 1024 / Math.max(W, H);
  const pts = [[box[0] * k, box[1] * k, 2], [box[2] * k, box[3] * k, 3]];
  const out = await sam.dec.s.run({
    image_embeddings: emb,
    point_coords: new ort.Tensor('float32', Float32Array.from(pts.flatMap((p) => [p[0], p[1]])), [1, pts.length, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(pts.map((p) => p[2])), [1, pts.length]),
    mask_input: new ort.Tensor('float32', prev?.lowRes || new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([prev?.lowRes ? 1 : 0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([H, W]), [2]),
  });
  const masks = out.masks.data, ious = out.iou_predictions.data, nm = out.masks.dims[1], N = W * H;
  let best = 0, bestScore = -1e9;
  for (let j = 0; j < nm; j++) {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, inter = 0, uni = 0;
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) {
      const on = masks[j * N + y * W + x] > 0;
      if (on) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (prev?.mask) { const q = prev.mask[y * W + x] > 0; if (on && q) inter++; if (on || q) uni++; }
    }
    if (x1 < 0) continue;
    const score = bboxIoU([x0, y0, x1, y1], box) + 0.3 * ious[j] + (prev?.mask ? 0.5 * (uni ? inter / uni : 0) : 0);
    if (score > bestScore) { bestScore = score; best = j; }
  }
  const on = new Uint8Array(N);
  for (let i = 0; i < N; i++) on[i] = masks[best * N + i] > 0 ? 1 : 0;
  const region = cleanRegion(on, W, H);
  const alpha = new Uint8Array(N);
  if (region) {
    for (let i = 0; i < N; i++) {
      if (!region.mask[i]) continue;
      const l = masks[best * N + i];
      alpha[i] = on[i] ? Math.round(Math.min(1, Math.max(0.5, (l + 1) / 2)) * 255) : 255; // holes inside → opaque
    }
  }
  const lr = out.low_res_masks.data;
  sam.prev = { lowRes: Float32Array.from(lr.subarray(best * 65536, (best + 1) * 65536)), mask: region?.mask || null, box: region?.box || null, track: trackBox };
  return { alpha, ep: sam.enc.ep };
}

// ------------------------------------------------------------------------------------------------ MDX (voice / music)
const mdx = { m: null, cfg: null };
async function mdxInit({ model, cfg }) {
  mdx.m = await session(model, false);
  mdx.cfg = cfg;
  return { ep: mdx.m.ep };
}
async function mdxChunk({ L, R }) {
  const cfg = mdx.cfg;
  const x = mdxInput(cfg, L, R);
  const out = await mdx.m.s.run({ input: new ort.Tensor('float32', x, [1, 4, cfg.dimF, cfg.dimT]) });
  const [vL, vR] = mdxOutput(cfg, out.output.data);
  return { L: vL, R: vR, ep: mdx.m.ep };
}

const HANDLERS = { samInit, samFrame, samReset: async () => { sam.prev = null; return true; }, mdxInit, mdxChunk };
port.on('message', async (e) => {
  const { id, type, data } = e.data || {};
  try {
    const fn = HANDLERS[type];
    if (!fn) throw new Error(`unknown request ${type}`);
    port.postMessage({ id, ok: true, result: await fn(data) });
  } catch (err) {
    port.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
