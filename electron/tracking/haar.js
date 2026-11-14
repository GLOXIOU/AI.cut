// Viola-Jones face detector running OpenCV Haar cascades (XML, "new" format) in pure JS.
// The cascade files (BSD, from the OpenCV repository) are downloaded on first use into userData/models.

/** Parse an OpenCV cascade XML. */
export function parseCascade(xml) {
  const num = (tag) => Number((new RegExp(`<${tag}>\\s*([^<]+)</${tag}>`).exec(xml) || [])[1]);
  const W = num('width'), H = num('height');
  if (!W || !H) throw new Error('Not an OpenCV cascade (width/height missing)');
  const stagesXml = xml.slice(xml.indexOf('<stages>'), xml.indexOf('</stages>'));
  const stages = [];
  const reStage = /<stageThreshold>([^<]+)<\/stageThreshold>\s*<weakClassifiers>([\s\S]*?)<\/weakClassifiers>/g;
  let m;
  while ((m = reStage.exec(stagesXml))) {
    const weak = [];
    const reWeak = /<internalNodes>([^<]+)<\/internalNodes>\s*<leafValues>([^<]+)<\/leafValues>/g;
    let w;
    while ((w = reWeak.exec(m[2]))) {
      const nodes = w[1].trim().split(/\s+/).map(Number);
      const leaves = w[2].trim().split(/\s+/).map(Number);
      const list = [];
      for (let i = 0; i + 3 < nodes.length; i += 4) list.push({ left: nodes[i], right: nodes[i + 1], f: nodes[i + 2], thr: nodes[i + 3] });
      weak.push({ nodes: list, leaves });
    }
    stages.push({ thr: Number(m[1]), weak });
  }
  const featXml = xml.slice(xml.indexOf('<features>'), xml.indexOf('</features>'));
  const features = [];
  const reFeat = /<rects>([\s\S]*?)<\/rects>(?:\s*<tilted>(\d)<\/tilted>)?/g;
  while ((m = reFeat.exec(featXml))) {
    const rects = [...m[1].matchAll(/<_>\s*([^<]+?)\s*<\/_>/g)].map((r) => r[1].trim().split(/\s+/).map(Number)).map(([x, y, w, h, wt]) => ({ x, y, w, h, wt }));
    features.push({ rects, tilted: m[2] === '1' });
  }
  if (!stages.length || !features.length) throw new Error('Cascade parse failed');
  return { W, H, stages, features };
}

function integral(gray, w, h) {
  const S = new Float64Array((w + 1) * (h + 1)), Q = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rs += v; rq += v * v;
      const k = (y + 1) * (w + 1) + x + 1;
      S[k] = S[k - w - 1] + rs; Q[k] = Q[k - w - 1] + rq;
    }
  }
  return { S, Q, W1: w + 1 };
}

/** Flat, typed-array form of the cascade (fast inner loop). Stump-only cascades get the fast path. */
function compile(cas) {
  if (cas._c) return cas._c;
  const stageThr = [], stageEnd = [];
  const fIdx = [], thr = [], leafL = [], leafR = [];
  let stump = true;
  for (const st of cas.stages) {
    for (const wk of st.weak) {
      if (wk.nodes.length !== 1) stump = false;
      const n = wk.nodes[0];
      fIdx.push(n.f); thr.push(n.thr); leafL.push(wk.leaves[0]); leafR.push(wk.leaves[1] ?? wk.leaves[0]);
    }
    stageThr.push(st.thr); stageEnd.push(fIdx.length);
  }
  cas._c = { stump, stageThr: Float64Array.from(stageThr), stageEnd: Int32Array.from(stageEnd), fIdx: Int32Array.from(fIdx), thr: Float64Array.from(thr), leafL: Float64Array.from(leafL), leafR: Float64Array.from(leafR) };
  return cas._c;
}

/** Feature rects at window scale s → flat arrays of integral-image offsets (4 corners) + weights, 3 rects max. */
function scaleFeatures(cas, s, W1) {
  const nF = cas.features.length;
  const off = new Int32Array(nF * 12), wt = new Float64Array(nF * 3), cnt = new Uint8Array(nF);
  cas.features.forEach((ft, i) => {
    if (ft.tilted) return;
    const rects = ft.rects.slice(0, 3).map((r) => ({ x: Math.round(r.x * s), y: Math.round(r.y * s), w: Math.round(r.w * s), h: Math.round(r.h * s), wt: r.wt }));
    if (rects.length > 1) {
      let rest = 0;
      for (let k = 1; k < rects.length; k++) rest += rects[k].wt * rects[k].w * rects[k].h;
      const a0 = rects[0].w * rects[0].h;
      if (a0 > 0) rects[0].wt = -rest / a0;
    }
    cnt[i] = rects.length;
    rects.forEach((r, k) => {
      const p = r.y * W1 + r.x;
      off[i * 12 + k * 4] = p; off[i * 12 + k * 4 + 1] = p + r.w; off[i * 12 + k * 4 + 2] = p + r.h * W1; off[i * 12 + k * 4 + 3] = p + r.h * W1 + r.w;
      wt[i * 3 + k] = r.wt;
    });
  });
  return { off, wt, cnt };
}

/**
 * Detect objects in a gray image (Uint8Array w×h). Returns [{ x, y, w, h, n }] in px (n = neighbours).
 * opts: { scaleFactor = 1.15, minSize = 24, minNeighbors = 3 }
 */
export function detect(cas, gray, w, h, opts = {}) {
  const sf = opts.scaleFactor || 1.15;
  const minNeighbors = opts.minNeighbors ?? 3;
  const C = compile(cas);
  const { S, Q, W1 } = integral(gray, w, h);
  const raw = [];
  const nStages = C.stageThr.length;
  for (let s = Math.max(1, (opts.minSize || cas.W) / cas.W); s * cas.W <= w && s * cas.H <= h; s *= sf) {
    const ww = Math.round(cas.W * s), wh = Math.round(cas.H * s);
    const { off, wt, cnt } = scaleFeatures(cas, s, W1);
    const step = Math.max(1, Math.round(s * 1.5));
    const nx = Math.round(s), ny = Math.round(s), nw = ww - 2 * nx, nh = wh - 2 * ny, narea = nw * nh;
    for (let y = 0; y + wh <= h; y += step) {
      for (let x = 0; x + ww <= w; x += step) {
        const base = y * W1 + x;
        const a = base + ny * W1 + nx, b = a + nw, c = a + nh * W1, d = c + nw;
        const sum = S[d] - S[b] - S[c] + S[a];
        const sq = Q[d] - Q[b] - Q[c] + Q[a];
        let nf = narea * sq - sum * sum;
        nf = nf > 0 ? Math.sqrt(nf) : 1;
        let k = 0, pass = true;
        for (let si = 0; si < nStages; si++) {
          let acc = 0;
          const end = C.stageEnd[si];
          for (; k < end; k++) {
            const f = C.fIdx[k];
            const o = f * 12, ow = f * 3;
            let v = wt[ow] * (S[base + off[o + 3]] - S[base + off[o + 1]] - S[base + off[o + 2]] + S[base + off[o]]);
            v += wt[ow + 1] * (S[base + off[o + 7]] - S[base + off[o + 5]] - S[base + off[o + 6]] + S[base + off[o + 4]]);
            if (cnt[f] > 2) v += wt[ow + 2] * (S[base + off[o + 11]] - S[base + off[o + 9]] - S[base + off[o + 10]] + S[base + off[o + 8]]);
            acc += v < C.thr[k] * nf ? C.leafL[k] : C.leafR[k];
          }
          if (acc < C.stageThr[si]) { pass = false; break; }
        }
        if (pass) raw.push({ x, y, w: ww, h: wh });
      }
    }
  }
  return group(raw, minNeighbors, 0.2);
}

/** OpenCV groupRectangles-like clustering. */
function group(rects, minNeighbors, eps) {
  const n = rects.length;
  const parent = rects.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const similar = (a, b) => {
    const delta = eps * (Math.min(a.w, b.w) + Math.min(a.h, b.h)) * 0.5;
    return Math.abs(a.x - b.x) <= delta && Math.abs(a.y - b.y) <= delta && Math.abs(a.x + a.w - b.x - b.w) <= delta && Math.abs(a.y + a.h - b.y - b.h) <= delta;
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (similar(rects[i], rects[j])) parent[find(i)] = find(j);
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const c = clusters.get(r) || { x: 0, y: 0, w: 0, h: 0, n: 0 };
    c.x += rects[i].x; c.y += rects[i].y; c.w += rects[i].w; c.h += rects[i].h; c.n++;
    clusters.set(r, c);
  }
  let out = [...clusters.values()].filter((c) => c.n >= minNeighbors).map((c) => ({ x: c.x / c.n, y: c.y / c.n, w: c.w / c.n, h: c.h / c.n, n: c.n }));
  // drop rectangles inside a stronger one
  out = out.filter((a) => !out.some((b) => b !== a && b.n >= a.n && a.x >= b.x - 0.1 * b.w && a.y >= b.y - 0.1 * b.h && a.x + a.w <= b.x + b.w * 1.1 && a.y + a.h <= b.y + b.h * 1.1));
  return out.sort((a, b) => b.w * b.h - a.w * a.h);
}
