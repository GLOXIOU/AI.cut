// Real-time preview compositor. Uses the exact same timeline math as the exporter (shared/*).
import {
  activeVisualLayers, trackSpans, videoTracks, clipVisualAt, cssColorFilter, svgChromaMatrixValues, isAudible, audioGainAt,
  mediaById, trackById, projectDuration, clamp, clipFrameLook, parseColor,
} from '@shared/timeline.js';
import { transitionStyles } from '@shared/transitions.js';
import { drawSubtitles, subtitleFontSpecs } from '@shared/subtitles.js';
import { buildAudioFx } from '@shared/audiofx.js';
import { gradeTables, hasToneGrade } from '@shared/grade.js';
import { maskAt, cssMask, svgPixelateMarkup } from '@shared/fx.js';
import { bakeProject } from '@shared/follow.js';
import { withoutPendingProposals } from '@shared/proposals.js';
import dspSource from '@shared/dsp.js?raw';
import workletGlue from './dsp-worklet.js?raw';

const PRELOAD_AHEAD = 2.5;
const KEEP_ALIVE = 4;
const SVGNS = 'http://www.w3.org/2000/svg';

const fileUrl = (p) => `aicut://file/${encodeURIComponent(p)}`;
function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export class PlayerEngine {
  /** opts.silent: picture only (external monitor window: the sound plays in the editor). */
  constructor(host, opts = {}) {
    this.host = host;
    this.silent = !!opts.silent;
    this.stage = el('div', 'pe-stage', host);
    this.bg = el('div', 'pe-bg', this.stage);
    this.layerHost = el('div', 'pe-layers', this.stage);
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'pe-defs');
    this.svg.setAttribute('width', '0');
    this.svg.setAttribute('height', '0');
    this.stage.appendChild(this.svg);
    this.subCanvas = el('canvas', 'pe-subs', host);
    this.subCtx = this.subCanvas.getContext('2d');
    this.items = new Map();
    this.backdrops = new Map();
    this.overrides = new Map();
    this.project = null;
    this.spans = new Map();
    this.duration = 0;
    this.time = 0;
    this.playing = false;
    this.loopPlayback = false;
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.subCache = new Map();
    this.volume = 1;
    this.onTime = null;
    this.onEnded = null;
    this.onHtmlError = null;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    this.master = this.audioCtx.createGain();
    this.master.connect(this.audioCtx.destination);
    // level meters (L / R)
    this.splitter = this.audioCtx.createChannelSplitter(2);
    this.master.connect(this.splitter);
    this.analysers = [0, 1].map((ch) => {
      const a = this.audioCtx.createAnalyser();
      a.fftSize = 1024;
      this.splitter.connect(a, ch);
      return a;
    });
    this.meterBuf = new Float32Array(1024);
    // audio effects (shared/dsp.js) run in an AudioWorklet: clip inserts + one bus per track
    this.buses = new Map();
    this.afxReady = false;
    this.hideProposals = false;
    if (!this.silent) {
      const url = URL.createObjectURL(new Blob([`${dspSource}\n${workletGlue}`], { type: 'text/javascript' }));
      this.audioCtx.audioWorklet.addModule(url).then(() => {
        this.afxReady = true;
        for (const it of this.items.values()) it.afxKey = null;
        for (const b of this.buses.values()) b.key = null;
        if (this.project) { this.syncBuses(this.project); this.render(this.time, true); }
      }).catch((e) => console.warn('[afx] worklet failed', e));
    }
    this.rate = 1;
    this.loop = this.loop.bind(this);
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(host);
    this.fontsReady = new Set();
  }

  destroy() {
    this.pause();
    this.ro.disconnect();
    window.removeEventListener('message', this.onMessage);
    for (const id of [...this.items.keys()]) this.removeItem(id);
    try { this.audioCtx.close(); } catch { /* ignore */ }
    this.host.innerHTML = '';
  }

  onMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.clipId) return;
    const it = this.items.get(d.clipId);
    if (!it) return;
    if (d.type === 'aicut:ready') { it.ready = true; it.lastPosted = null; if (!this.playing) this.render(this.time, true); }
    if (d.type === 'aicut:error' && this.onHtmlError) this.onHtmlError(d.clipId, d.message);
  }

  // ---------------------------------------------------------------- project / layout
  setProject(p) {
    const prev = this.project;
    this.source = p;
    if (p) {
      if (this.hideProposals) p = withoutPendingProposals(p);
      p = bakeProject(p); // clips / masks attached to a tracking → plain keyframes (same as the export)
    }
    this.project = p;
    if (!p) {
      for (const id of [...this.items.keys()]) this.removeItem(id);
      this.clearSubs();
      return;
    }
    this.spans = new Map(videoTracks(p).map((t) => [t.id, trackSpans(p, t)]));
    this.duration = projectDuration(p);
    if (!prev || prev.settings.width !== p.settings.width || prev.settings.height !== p.settings.height) this.fit();
    this.bg.style.background = p.settings.background || '#000';
    for (const [id, it] of this.items) {
      const c = p.clips.find((x) => x.id === id);
      if (!c || it.key !== this.itemKey(c)) this.removeItem(id);
    }
    this.ensureFonts();
    this.syncBuses(p);
    this.render(this.time, true);
  }

  setHideProposals(v) {
    this.hideProposals = !!v;
    if (this.source) this.setProject(this.source);
  }

  ensureFonts() {
    const style = this.project?.subtitles?.style;
    if (!style) return;
    for (const spec of subtitleFontSpecs(style)) {
      if (this.fontsReady.has(spec)) continue;
      this.fontsReady.add(spec);
      document.fonts.load(spec).then(() => { this.subCache.clear(); if (!this.playing) this.drawSubs(this.time); }).catch(() => {});
    }
  }

  fit() {
    const p = this.project;
    const W = p?.settings.width || 1920, H = p?.settings.height || 1080;
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = Math.min(r.width / W, r.height / H);
    this.scale = k;
    this.offset = { x: (r.width - W * k) / 2, y: (r.height - H * k) / 2 };
    Object.assign(this.stage.style, { width: `${W}px`, height: `${H}px`, transform: `translate(${this.offset.x}px, ${this.offset.y}px) scale(${k})` });
    const dpr = window.devicePixelRatio || 1;
    this.subCanvas.width = Math.max(1, Math.round(W * k * dpr));
    this.subCanvas.height = Math.max(1, Math.round(H * k * dpr));
    Object.assign(this.subCanvas.style, { left: `${this.offset.x}px`, top: `${this.offset.y}px`, width: `${W * k}px`, height: `${H * k}px` });
    this.subCache.clear();
    this.drawSubs(this.time);
    this.onFit?.();
  }

  mediaSrc(m) {
    if (!m) return null;
    return fileUrl(m.proxy || m.path);
  }

  itemKey(c) {
    const p = this.project;
    if (c.type === 'html') return `html|${hashStr(JSON.stringify(c.html))}|${c.duration}|${p.settings.width}x${p.settings.height}`;
    if (c.type === 'color') return 'color';
    if (c.type === 'adjust') return 'adjust';
    const m = mediaById(p, c.mediaId);
    return `${c.type}|${c.mediaId}|${m?.proxy || m?.path || ''}`;
  }

  // ---------------------------------------------------------------- items
  createItem(c) {
    const p = this.project;
    const m = mediaById(p, c.mediaId);
    const it = { id: c.id, type: c.type, key: this.itemKey(c), lastUsed: performance.now(), ready: false, pendingSeek: null };
    if (c.type === 'audio') {
      const a = new Audio();
      a.crossOrigin = 'anonymous';
      a.preload = 'auto';
      a.src = this.mediaSrc(m);
      it.media = a;
      this.attachAudio(it);
      this.wireMedia(it);
      this.items.set(c.id, it);
      return it;
    }
    it.wrap = el('div', 'pe-wrap', this.layerHost);
    if (c.type === 'adjust') { // adjustment layer: full-frame backdrop-filter element
      it.adj = el('div', 'pe-adjust', it.wrap);
      it.media = it.adj;
      it.ready = true;
      this.items.set(c.id, it);
      return it;
    }
    it.holder = el('div', 'pe-holder', it.wrap);
    it.box = el('div', 'pe-box', it.holder);
    if (c.type === 'video') {
      const v = el('video', 'pe-media', it.box);
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      v.playsInline = true;
      v.disablePictureInPicture = true;
      v.src = this.mediaSrc(m);
      it.media = v;
      if (m?.hasAudio && !this.silent) this.attachAudio(it); else v.muted = true;
      this.wireMedia(it);
    } else if (c.type === 'image') {
      const img = el('img', 'pe-media', it.box);
      img.draggable = false;
      img.src = this.mediaSrc(m);
      it.media = img;
      it.ready = true;
    } else if (c.type === 'html') {
      const f = el('iframe', 'pe-media pe-html', it.box);
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('scrolling', 'no');
      f.style.width = `${p.settings.width}px`;
      f.style.height = `${p.settings.height}px`;
      f.src = `aicut://html/${c.id}?rev=${hashStr(it.key)}`;
      f.addEventListener('load', () => { it.lastPosted = null; it.loaded = true; if (!this.playing) this.render(this.time, true); });
      it.media = f;
    } else if (c.type === 'color') {
      it.media = el('div', 'pe-media', it.box);
      it.ready = true;
    }
    it.vig = el('div', 'pe-vignette', it.box);
    it.bord = el('div', 'pe-border', it.box);
    this.items.set(c.id, it);
    return it;
  }

  attachAudio(it) {
    try {
      it.source = this.audioCtx.createMediaElementSource(it.media);
      it.gain = this.audioCtx.createGain();
      it.gain.gain.value = 0;
      it.source.connect(it.gain); // gain → track bus: see syncAfx
    } catch { it.media.muted = true; }
  }

  wireMedia(it) {
    const v = it.media;
    v.addEventListener('loadedmetadata', () => { it.ready = true; if (it.pendingSeek != null) { v.currentTime = it.pendingSeek; it.pendingSeek = null; } if (!this.playing) this.render(this.time, true); });
    v.addEventListener('seeked', () => {
      // paused + pixelated adjustment layer: its canvas copies the video, redraw once the new frame is decoded
      if (!this.playing && this.pixelActive && it.pendingSeek == null) requestAnimationFrame(() => { if (!this.playing) this.render(this.time, true); });
      if (it.pendingSeek != null) {
        const s = it.pendingSeek;
        it.pendingSeek = null;
        if (Math.abs(v.currentTime - s) > 0.02) v.currentTime = s;
      }
    });
    v.addEventListener('error', () => { it.error = v.error?.message || 'media error'; });
  }

  removeItem(id) {
    const it = this.items.get(id);
    if (!it) return;
    try { it.media?.pause?.(); } catch { /* */ }
    if (it.media && (it.type === 'video' || it.type === 'audio')) { it.media.removeAttribute('src'); try { it.media.load(); } catch { /* */ } }
    try { it.source?.disconnect(); it.gain?.disconnect(); it.afxNode?.disconnect(); } catch { /* */ }
    it.wrap?.remove();
    for (const pre of ['ck_', 'gr_', 'px_', 'ga_']) document.getElementById(`${pre}${id}`)?.remove();
    this.items.delete(id);
  }

  effective(c) {
    const o = this.overrides.get(c.id);
    return o ? { ...c, ...o } : c;
  }
  setOverride(clipId, patch) {
    if (patch) this.overrides.set(clipId, { ...(this.overrides.get(clipId) || {}), ...patch });
    else this.overrides.delete(clipId);
    if (!this.playing) this.render(this.time, true);
  }

  chromaFilter(c) {
    const id = `ck_${c.id}`;
    let f = document.getElementById(id);
    const values = svgChromaMatrixValues(c.chromaKey);
    if (!f) {
      f = document.createElementNS(SVGNS, 'filter');
      f.setAttribute('id', id);
      f.setAttribute('color-interpolation-filters', 'sRGB');
      // filter region = the element itself (the default 10 % margin would turn the transparent margin into opaque
      // black: the keyer's constant offset gives alpha 1 to "nothing"), and keep the source transparency (rounded corners…)
      for (const [k, v] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1']]) f.setAttribute(k, v);
      const m = document.createElementNS(SVGNS, 'feColorMatrix');
      m.setAttribute('type', 'matrix');
      m.setAttribute('result', 'ck');
      f.appendChild(m);
      const comp = document.createElementNS(SVGNS, 'feComposite');
      comp.setAttribute('in', 'ck');
      comp.setAttribute('in2', 'SourceAlpha');
      comp.setAttribute('operator', 'in');
      f.appendChild(comp);
      this.svg.appendChild(f);
    }
    const m = f.firstChild;
    if (m.getAttribute('values') !== values) m.setAttribute('values', values);
    return `url(#${id})`;
  }

  /** SVG filter of the tone grade (shared/grade.js tables). Returns 'url(#…)' or ''. prefix: gr_ (clip) / ga_ (adjust). */
  gradeFilter(c, prefix = 'gr_') {
    if (!hasToneGrade(c.color)) return '';
    const id = `${prefix}${c.id}`;
    let f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS(SVGNS, 'filter');
      f.setAttribute('id', id);
      f.setAttribute('color-interpolation-filters', 'sRGB');
      for (const [k, v] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1']]) f.setAttribute(k, v);
      const ct = document.createElementNS(SVGNS, 'feComponentTransfer');
      for (const ch of ['R', 'G', 'B']) { const fn = document.createElementNS(SVGNS, `feFunc${ch}`); fn.setAttribute('type', 'table'); ct.appendChild(fn); }
      f.appendChild(ct);
      this.svg.appendChild(f);
    }
    const key = JSON.stringify(c.color);
    if (f.dataset.key !== key) {
      f.dataset.key = key;
      const tb = gradeTables(c.color);
      const fns = f.firstChild.childNodes;
      ['r', 'g', 'b'].forEach((k, i) => fns[i].setAttribute('tableValues', tb[k].map((v) => v.toFixed(5)).join(' ')));
    }
    return `url(#${id})`;
  }

  /** SVG pixelate filter for an adjustment layer. */
  pixelFilter(c, size) {
    const id = `px_${c.id}`;
    let f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS(SVGNS, 'filter');
      f.setAttribute('id', id);
      f.setAttribute('color-interpolation-filters', 'sRGB');
      for (const [k, v] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1']]) f.setAttribute(k, v);
      this.svg.appendChild(f);
    }
    const key = String(Math.round(size));
    if (f.dataset.key !== key) { f.dataset.key = key; f.innerHTML = svgPixelateMarkup(size); }
    return `url(#${id})`;
  }

  /**
   * Motion graphics (iframes) cannot be read back nor pixelated by CSS / SVG filters in this compositor: inside a
   * pixelated region they are mirrored (same document, same time) and blurred by about half a block instead.
   */
  syncMirrors(it, layers, px) {
    const keep = new Set();
    for (const { it: src, c } of layers) {
      keep.add(c.id);
      let m = it.mirrors.get(c.id);
      if (!m || m.key !== src.key) {
        m?.box.remove();
        const box = el('div', 'pe-box', it.pixHost);
        const f = el('iframe', 'pe-media pe-html', box);
        f.setAttribute('sandbox', 'allow-scripts');
        f.setAttribute('scrolling', 'no');
        f.style.width = src.media.style.width; f.style.height = src.media.style.height;
        f.src = src.media.src;
        m = { box, f, key: src.key, loaded: false, last: null };
        f.addEventListener('load', () => { m.loaded = true; m.last = null; });
        it.mirrors.set(c.id, m);
      }
      const bs = src.box.style, ms = m.box.style;
      for (const k of ['left', 'top', 'width', 'height', 'transform', 'opacity', 'clipPath']) if (ms[k] !== bs[k]) ms[k] = bs[k];
      ms.filter = `${bs.filter || ''} blur(${Math.max(2, px * 0.45)}px)`.trim();
      if (m.f.style.transform !== src.media.style.transform) { m.f.style.transform = src.media.style.transform; m.f.style.transformOrigin = src.media.style.transformOrigin; }
      const lt = src.lastPosted;
      if (m.loaded && lt != null && m.last !== lt) { try { m.f.contentWindow?.postMessage({ type: 'aicut:seek', t: lt }, '*'); m.last = lt; } catch { /* */ } }
    }
    for (const [id, m] of it.mirrors) if (!keep.has(id)) { m.box.remove(); it.mirrors.delete(id); }
  }

  /** Draw the regular layers below (video / image) into a small canvas at scale k (preview of pixelation). */
  drawBelow(ctx, cw, ch, k, layers) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = this.project.settings.background || '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    for (const { it, c, g, op } of layers) {
      const m = it.media;
      const isVid = m instanceof HTMLVideoElement, isImg = m instanceof HTMLImageElement;
      if (!(isVid && m.readyState >= 2) && !(isImg && m.complete && m.naturalWidth)) {
        if (c.type !== 'color') continue;
      }
      const cr = c.crop || {};
      const cl = cr.left || 0, crr = cr.right || 0, ct = cr.top || 0, cb = cr.bottom || 0;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, op));
      const f = (it.box.style.filter || '').replace(/url\([^)]*\)/g, '').trim();
      ctx.filter = f || 'none';
      ctx.setTransform(k, 0, 0, k, g.cx * k, g.cy * k);
      ctx.rotate(((g.rotation || 0) * Math.PI) / 180);
      ctx.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
      const dx = -g.w / 2 + cl * g.w, dy = -g.h / 2 + ct * g.h, dw = g.w * (1 - cl - crr), dh = g.h * (1 - ct - cb);
      if (c.type === 'color') { ctx.fillStyle = c.fill || '#000'; ctx.fillRect(dx, dy, dw, dh); }
      else {
        const vw = isVid ? m.videoWidth : m.naturalWidth, vh = isVid ? m.videoHeight : m.naturalHeight;
        try { ctx.drawImage(m, cl * vw, ct * vh, vw * (1 - cl - crr), vh * (1 - ct - cb), dx, dy, dw, dh); } catch { /* not decodable yet */ }
      }
      ctx.restore();
    }
  }

  /** Adjustment layer at clip-local time: backdrop filter + mask + opacity. */
  renderAdjust(it, c, local, W, H, L, drawn = []) {
    const filters = [];
    const g = this.gradeFilter(c, 'ga_');
    if (g) filters.push(g);
    const cf = cssColorFilter(c.color);
    if (cf) filters.push(cf);
    if (c.fx?.blur > 0) filters.push(`blur(${c.fx.blur}px)`);
    const a = it.adj.style;
    let op = c.opacity ?? 1;
    if (c.videoFadeIn > 0 && local < c.videoFadeIn) op *= clamp(local / c.videoFadeIn, 0, 1);
    if (c.videoFadeOut > 0 && local > c.duration - c.videoFadeOut) op *= clamp((c.duration - local) / c.videoFadeOut, 0, 1);
    const bf = filters.join(' ');
    a.backdropFilter = bf;
    a.webkitBackdropFilter = bf;
    a.opacity = String(op);
    a.display = bf && op > 0.001 ? '' : 'none';
    const mk = cssMask(maskAt(c, Math.max(0, local), W, H));
    const applyMask = (st) => {
      if (st.maskImage !== mk.image) { st.maskImage = mk.image; st.webkitMaskImage = mk.image; }
      st.maskSize = mk.size; st.webkitMaskSize = mk.size;
      st.maskPosition = mk.position; st.webkitMaskPosition = mk.position;
      st.maskComposite = mk.composite;
    };
    applyMask(a);
    // pixelation: Chromium ignores SVG reference filters in backdrop-filter over video, so the layers below are
    // redrawn at 1 px per block in a small canvas shown with nearest-neighbour upscaling (blocks from the frame origin)
    const px = c.fx?.pixelate > 1 ? Math.round(c.fx.pixelate) : 0;
    if (px) {
      if (!it.pixHost) {
        it.pixHost = el('div', 'pe-pixhost', it.wrap);
        it.pix = el('canvas', 'pe-pixelate', it.pixHost);
        it.pixCtx = it.pix.getContext('2d');
        it.mirrors = new Map();
      }
      const cw = Math.ceil(W / px), ch = Math.ceil(H / px);
      if (it.pix.width !== cw || it.pix.height !== ch) { it.pix.width = cw; it.pix.height = ch; }
      const ps = it.pix.style;
      ps.width = `${cw * px}px`; ps.height = `${ch * px}px`;
      const hs = it.pixHost.style;
      hs.opacity = String(op);
      hs.display = op > 0.001 ? '' : 'none';
      applyMask(hs);
      this.pixelActive = true;
      const below = drawn.filter((d) => d.trackIndex < L.trackIndex);
      this.drawBelow(it.pixCtx, cw, ch, 1 / px, below);
      this.syncMirrors(it, below.filter((d) => d.c.type === 'html'), px);
    } else if (it.pixHost) { it.pixHost.remove(); it.pixHost = null; it.pix = null; it.mirrors = null; }
    const ws = it.wrap.style;
    ws.display = '';
    ws.visibility = 'visible';
    ws.zIndex = String(L.trackIndex * 4 + 1);
  }

  // ---------------------------------------------------------------- audio routing (track buses + clip effects)
  busFor(trackId) {
    let b = this.buses.get(trackId);
    if (!b) {
      b = { input: this.audioCtx.createGain(), node: null, key: null };
      b.input.connect(this.master);
      this.buses.set(trackId, b);
    }
    return b;
  }

  /** Track effect chains + pan (AudioWorklet running shared/dsp.js). */
  syncBuses(p) {
    if (!p || this.silent) return;
    for (const t of p.tracks) {
      const b = this.busFor(t.id);
      const active = this.afxReady && ((t.afx && t.afx.length) || t.pan);
      const key = active ? JSON.stringify([t.afx || [], t.pan || 0]) : '';
      if (b.key === key) continue;
      b.key = key;
      try { b.input.disconnect(); } catch { /* */ }
      if (active) {
        const opts = { list: t.afx || [], pan: t.pan || 0, position: this.time };
        if (!b.node) b.node = new AudioWorkletNode(this.audioCtx, 'aicut-afx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: opts });
        else b.node.port.postMessage({ list: opts.list, pan: opts.pan });
        try { b.node.disconnect(); } catch { /* */ }
        b.input.connect(b.node);
        b.node.connect(this.master);
      } else {
        if (b.node) { try { b.node.disconnect(); } catch { /* */ } b.node = null; }
        b.input.connect(this.master);
      }
    }
  }

  /** Clip insert effects: gain → [worklet] → track bus. */
  syncAfx(it, c) {
    if (!it.gain || this.silent) return;
    const list = this.afxReady && c.afx?.length ? c.afx : null;
    const key = `${c.trackId}|${list ? JSON.stringify(list) : ''}`;
    if (it.afxKey === key) return;
    const sameTypes = it.afxNode && list && it.afxTypes === list.map((x) => x.type).join('|') && it.busId === c.trackId;
    it.afxKey = key;
    const bus = this.busFor(c.trackId);
    if (sameTypes) { it.afxNode.port.postMessage({ list }); return; }
    try { it.gain.disconnect(); } catch { /* */ }
    if (list) {
      const local = Math.max(0, this.time - c.start);
      if (!it.afxNode) it.afxNode = new AudioWorkletNode(this.audioCtx, 'aicut-afx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { list, position: local } });
      else it.afxNode.port.postMessage({ list });
      try { it.afxNode.disconnect(); } catch { /* */ }
      it.gain.connect(it.afxNode);
      it.afxNode.connect(bus.input);
      it.afxTypes = list.map((x) => x.type).join('|');
    } else {
      if (it.afxNode) { try { it.afxNode.disconnect(); } catch { /* */ } it.afxNode = null; }
      it.gain.connect(bus.input);
      it.afxTypes = '';
    }
    it.busId = c.trackId;
  }

  /** LFO / noise positions follow the playhead (clip-local for inserts, timeline time for buses). */
  syncAfxPositions(t) {
    if (!this.afxReady) return;
    for (const b of this.buses.values()) b.node?.port.postMessage({ position: t });
    for (const it of this.items.values()) {
      if (!it.afxNode) continue;
      const c = this.project?.clips.find((x) => x.id === it.id);
      if (c) it.afxNode.port.postMessage({ position: Math.max(0, t - c.start) });
    }
  }

  /** Peak level per channel in dBFS (for the audio meters). */
  levels() {
    return this.analysers.map((a) => {
      a.getFloatTimeDomainData(this.meterBuf);
      let m = 0;
      for (let i = 0; i < this.meterBuf.length; i++) { const v = Math.abs(this.meterBuf[i]); if (v > m) m = v; }
      return m > 1e-6 ? 20 * Math.log10(m) : -120;
    });
  }

  // ---------------------------------------------------------------- transport
  async play(rate = 1) {
    if (!this.project) return;
    this.rate = rate || 1;
    if (this.rate > 0 && this.time >= this.duration - 0.02) this.time = 0;
    try { await this.audioCtx.resume(); } catch { /* */ }
    const wasPlaying = this.playing;
    this.playing = true;
    this.clockStart = performance.now();
    this.timeStart = this.time;
    this.syncAfxPositions(this.time);
    if (!wasPlaying) requestAnimationFrame(this.loop);
  }

  pause() {
    this.playing = false;
    for (const it of this.items.values()) { if (it.media?.pause && !it.media.paused) it.media.pause(); }
    this.render(this.time, true);
  }

  seek(t) {
    this.time = clamp(t, 0, Math.max(0, this.duration));
    if (this.playing) { this.clockStart = performance.now(); this.timeStart = this.time; this.syncAfxPositions(this.time); }
    this.render(this.time, true);
  }

  loop(now) {
    if (!this.playing) return;
    let t = this.timeStart + ((now - this.clockStart) / 1000) * this.rate;
    if (t >= this.duration) {
      if (this.loopPlayback && this.duration > 0) { this.clockStart = now; this.timeStart = 0; t = 0; }
      else { this.time = this.duration; this.pause(); this.onTime?.(this.time); this.onEnded?.(); return; }
    }
    if (t <= 0 && this.rate < 0) { this.time = 0; this.pause(); this.onTime?.(0); this.onEnded?.(); return; }
    this.time = t;
    // reverse / fast shuttle: frame-accurate seeking instead of media playback
    this.render(t, this.rate !== 1);
    this.onTime?.(t);
    requestAnimationFrame(this.loop);
  }

  setVolume(v) {
    this.volume = v;
    this.master.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.02);
  }

  // ---------------------------------------------------------------- rendering
  render(t, seeking) {
    const p = this.project;
    if (!p) return;
    const W = p.settings.width, H = p.settings.height;
    const now = performance.now();
    const layers = activeVisualLayers(p, t, this.spans);
    const active = new Set();
    const usedBackdrops = new Set();
    const anySolo = p.tracks.some((tk) => tk.solo);
    const drawn = []; // regular layers already placed this frame (bottom → top), for adjustment-layer pixelation
    this.pixelActive = false;

    for (const L of layers) {
      const c = this.effective(L.clip);
      const m = mediaById(p, c.mediaId);
      let it = this.items.get(c.id);
      if (!it) it = this.createItem(c);
      it.lastUsed = now;
      active.add(c.id);
      const local = t - c.start;
      if (c.type === 'adjust') { this.renderAdjust(it, c, local, W, H, L, drawn); continue; }
      const g = clipVisualAt(c, m, W, H, Math.max(0, Math.min(c.duration, local)));
      // video fades from/to transparent
      let op = g.opacity;
      if (c.videoFadeIn > 0 && local < c.videoFadeIn) op *= clamp(local / c.videoFadeIn, 0, 1);
      if (c.videoFadeOut > 0 && local > c.duration - c.videoFadeOut) op *= clamp((c.duration - local) / c.videoFadeOut, 0, 1);
      drawn.push({ it, c, g, op, trackIndex: L.trackIndex });
      const bs = it.box.style;
      bs.left = `${g.cx - g.w / 2}px`;
      bs.top = `${g.cy - g.h / 2}px`;
      bs.width = `${g.w}px`;
      bs.height = `${g.h}px`;
      bs.transform = `rotate(${g.rotation}deg) scale(${c.flipH ? -1 : 1}, ${c.flipV ? -1 : 1})`;
      bs.opacity = String(op);
      const filters = [];
      if (c.chromaKey) filters.push(this.chromaFilter(c));
      const gf = this.gradeFilter(c);
      if (gf) filters.push(gf);
      const cf = cssColorFilter(c.color);
      if (cf) filters.push(cf);
      bs.filter = filters.join(' ');
      // crop + rounded corners (radius scales with the clip, clamped to the visible rect)
      const cr = c.crop || {};
      const cl = cr.left || 0, crr = cr.right || 0, ct = cr.top || 0, cb = cr.bottom || 0;
      const look = clipFrameLook(c);
      const visW = g.w * (1 - cl - crr), visH = g.h * (1 - ct - cb);
      const rad = Math.min(look.radius * g.scale, visW / 2, visH / 2);
      bs.clipPath = c.crop || rad > 0 ? `inset(${ct * 100}% ${crr * 100}% ${cb * 100}% ${cl * 100}%${rad > 0 ? ` round ${rad}px` : ''})` : '';
      // inner motion (Ken Burns / pan inside the frame)
      const ms = it.media.style;
      if (g.z !== 1 || g.pu || g.pv) {
        ms.transformOrigin = `${(cl + (1 - cl - crr) / 2) * 100}% ${(ct + (1 - ct - cb) / 2) * 100}%`;
        ms.transform = `translate(${g.pu * visW}px, ${g.pv * visH}px) scale(${g.z})`;
      } else if (ms.transform) { ms.transform = ''; }
      // border (inset ring that follows the rounded crop)
      const bd = it.bord.style;
      if (look.border) {
        Object.assign(bd, {
          display: 'block', left: `${cl * 100}%`, top: `${ct * 100}%`, width: `${(1 - cl - crr) * 100}%`, height: `${(1 - ct - cb) * 100}%`,
          borderRadius: `${rad}px`, boxShadow: `inset 0 0 0 ${Math.min(look.border.width * g.scale, visW / 2, visH / 2)}px ${look.border.color}`,
        });
      } else if (bd.display !== 'none') bd.display = 'none';
      // blur (animations) + drop shadow on the holder, so both extend outside the clip frame
      const hf = [];
      if (g.blur > 0.05) hf.push(`blur(${g.blur}px)`);
      if (look.shadow) {
        const [r0, g0, b0] = parseColor(look.shadow.color);
        hf.push(`drop-shadow(${look.shadow.x}px ${look.shadow.y}px ${look.shadow.blur}px rgba(${r0},${g0},${b0},${look.shadow.opacity}))`);
      }
      it.holder.style.filter = hf.join(' ');
      it.vig.style.opacity = c.vignette > 0 ? '1' : '0';
      if (c.vignette > 0) it.vig.style.background = `radial-gradient(ellipse farthest-corner at 50% 50%, rgba(0,0,0,0) 35%, rgba(0,0,0,${Math.min(1, c.vignette)}) 100%)`;
      if (c.type === 'color') it.media.style.background = c.fill || '#000';
      if (c.type === 'html') {
        const f = it.media;
        const sx = g.w / W, sy = g.h / H;
        if (g.z !== 1 || g.pu || g.pv) {
          // inner zoom around the visible centre (iframe transform-origin is 0 0)
          const ox = (cl + (1 - cl - crr) / 2) * g.w, oy = (ct + (1 - ct - cb) / 2) * g.h;
          f.style.transformOrigin = '0 0';
          f.style.transform = `translate(${g.pu * visW + ox * (1 - g.z)}px, ${g.pv * visH + oy * (1 - g.z)}px) scale(${sx * g.z}, ${sy * g.z})`;
        } else f.style.transform = `scale(${sx}, ${sy})`;
        const lt = Math.max(0, local);
        if (it.loaded && (it.lastPosted == null || Math.abs(it.lastPosted - lt) > 0.0005)) {
          try { f.contentWindow?.postMessage({ type: 'aicut:seek', t: lt }, '*'); it.lastPosted = lt; } catch { /* */ }
        }
      }
      // transitions
      const ws = it.wrap.style;
      ws.display = '';
      ws.visibility = 'visible';
      ws.zIndex = String(L.trackIndex * 4 + (L.trans?.role === 'in' ? 2 : 1));
      let st = {};
      if (L.trans) {
        const ts = transitionStyles(L.trans.type, L.trans.p, W, H);
        st = L.trans.role === 'in' ? ts.b : ts.a;
        if (ts.backdrop) {
          const key = `${L.track.id}`;
          usedBackdrops.add(key);
          let bd = this.backdrops.get(key);
          if (!bd) { bd = el('div', 'pe-backdrop', this.layerHost); this.backdrops.set(key, bd); }
          bd.style.background = ts.backdrop;
          bd.style.zIndex = String(L.trackIndex * 4);
          bd.style.display = '';
        }
      }
      ws.opacity = st.opacity !== undefined ? String(st.opacity) : '';
      ws.clipPath = st.clipPath || '';
      ws.maskImage = st.mask || '';
      ws.webkitMaskImage = st.mask || '';
      const tf = [];
      if (st.translate) tf.push(`translate(${st.translate[0]}px, ${st.translate[1]}px)`);
      if (st.scale) tf.push(`scale(${st.scale})`);
      ws.transform = tf.join(' ');
      // media sync + audio
      if (c.type === 'video') {
        this.syncMedia(it, c, m, t);
        const track = L.track;
        let gain = 0;
        if (isAudible(c, m) && !track.muted && (!anySolo || track.solo)) {
          gain = audioGainAt(c, local) * (track.volume ?? 1);
          if (L.trans && L.trans.from) gain *= L.trans.role === 'in' ? Math.sin((L.trans.p * Math.PI) / 2) : Math.cos((L.trans.p * Math.PI) / 2);
        }
        this.syncAudioFx(it, c.audioFx);
        this.syncAfx(it, c);
        this.setGain(it, gain);
      }
    }
    for (const [key, bd] of this.backdrops) if (!usedBackdrops.has(key)) bd.style.display = 'none';

    // preload upcoming visual clips
    for (const track of videoTracks(p)) {
      if (track.hidden) continue;
      for (const s of this.spans.get(track.id) || []) {
        if (s.start > t && s.start - t < PRELOAD_AHEAD && s.clip.type !== 'color' && s.clip.type !== 'adjust') {
          const c = s.clip;
          let it = this.items.get(c.id);
          if (!it) it = this.createItem(c);
          it.lastUsed = now;
          if (!active.has(c.id)) {
            it.wrap.style.visibility = 'hidden';
            if (c.type === 'video') this.syncMedia(it, c, mediaById(p, c.mediaId), s.start, true);
            active.add(c.id);
          }
        }
      }
    }

    // audio clips on audio tracks
    for (const track of p.tracks) {
      if (track.type !== 'audio' || this.silent) continue;
      const audible = !track.muted && (!anySolo || track.solo);
      for (const c0 of p.clips) {
        if (c0.trackId !== track.id) continue;
        const c = this.effective(c0);
        const inRange = t >= c.start - 0.001 && t < c.start + c.duration;
        const soon = c.start > t && c.start - t < PRELOAD_AHEAD;
        if (!inRange && !soon) continue;
        const m = mediaById(p, c.mediaId);
        let it = this.items.get(c.id);
        if (!it) it = this.createItem(c);
        it.lastUsed = now;
        active.add(c.id);
        this.syncAfx(it, c);
        if (inRange) {
          this.syncMedia(it, c, m, t);
          this.syncAudioFx(it, c.audioFx);
          this.setGain(it, audible && isAudible(c, m) ? audioGainAt(c, t - c.start) * (track.volume ?? 1) : 0);
        } else {
          this.syncMedia(it, c, m, c.start, true);
          this.setGain(it, 0);
        }
      }
    }

    // hide / pause / garbage-collect inactive items
    for (const [id, it] of this.items) {
      if (active.has(id)) continue;
      if (it.wrap) it.wrap.style.display = 'none';
      if (it.media?.pause && !it.media.paused) it.media.pause();
      if (it.gain) this.setGain(it, 0);
      if (now - it.lastUsed > KEEP_ALIVE * 1000) this.removeItem(id);
    }
    this.drawSubs(t);
  }

  /** Voice / audio effect chain between the media source and its gain (rebuilt when the preset changes). */
  syncAudioFx(it, fx) {
    if (!it.source) return;
    const key = fx?.preset || '';
    if (it.fxKey === key) return;
    it.fxKey = key;
    try { it.source.disconnect(); } catch { /* */ }
    if (it.fx) { for (const n of it.fx.nodes) { try { n.disconnect(); } catch { /* */ } } it.fx = null; }
    const chain = key ? buildAudioFx(this.audioCtx, fx) : null;
    if (chain) { it.source.connect(chain.input); chain.output.connect(it.gain); it.fx = chain; } else it.source.connect(it.gain);
  }

  setGain(it, g) {
    if (!it.gain) return;
    const v = Math.max(0, g);
    if (Math.abs((it.lastGain ?? -1) - v) < 1e-4) return;
    it.lastGain = v;
    it.gain.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.012);
  }

  syncMedia(it, c, m, t, preloadOnly = false) {
    const v = it.media;
    if (!v || !m) return;
    const speed = c.speed || 1;
    const maxT = Math.max(0, (m.duration || 0) - 0.04);
    const raw = (c.in || 0) + (t - c.start) * speed;
    const st = Math.min(Math.max(0, raw), maxT);
    const frozen = raw < 0 || raw > maxT;
    if (v.readyState < 1) { it.pendingSeek = st; return; }
    if (this.playing && this.rate > 0 && !preloadOnly && !frozen) {
      const pr = Math.min(16, speed * this.rate);
      if (v.playbackRate !== pr) v.playbackRate = pr;
      if (v.paused) {
        if (Math.abs(v.currentTime - st) > 0.05) v.currentTime = st;
        v.play().catch(() => {});
      } else if (Math.abs(v.currentTime - st) > 0.3) {
        v.currentTime = st;
      }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - st) > 0.015) {
        if (v.seeking) it.pendingSeek = st;
        else v.currentTime = st;
      }
    }
  }

  clearSubs() {
    this.subCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.subCtx.clearRect(0, 0, this.subCanvas.width, this.subCanvas.height);
  }

  drawSubs(t) {
    const p = this.project;
    this.clearSubs();
    if (!p || !p.subtitles?.enabled || !p.subtitles.cues?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const k = this.scale * dpr;
    this.subCtx.setTransform(k, 0, 0, k, 0, 0);
    drawSubtitles(this.subCtx, p.subtitles.cues, p.subtitles.style, t, p.settings.width, p.settings.height, this.subCache);
  }

  /** Geometry (stage px) of a clip at the current time, for the transform gizmo. */
  geometryOf(clipId) {
    const p = this.project;
    const c0 = p?.clips.find((x) => x.id === clipId);
    if (!c0 || c0.type === 'audio' || c0.type === 'adjust') return null;
    const c = this.effective(c0);
    const local = this.time - c.start;
    if (local < 0 || local > c.duration) return null;
    const g = clipVisualAt(c, mediaById(p, c.mediaId), p.settings.width, p.settings.height, local);
    return { ...g, clip: c, scaleFactor: this.scale, offset: this.offset };
  }
}

export { trackById };
