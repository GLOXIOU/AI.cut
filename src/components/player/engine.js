// Real-time preview compositor. Uses the exact same timeline math as the exporter (shared/*).
import {
  activeVisualLayers, trackSpans, videoTracks, clipVisualAt, cssColorFilter, svgChromaMatrixValues, isAudible, audioGainAt,
  mediaById, trackById, projectDuration, clamp, clipFrameLook, parseColor,
} from '@shared/timeline.js';
import { transitionStyles } from '@shared/transitions.js';
import { drawSubtitles, subtitleFontSpecs } from '@shared/subtitles.js';
import { buildAudioFx } from '@shared/audiofx.js';

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
    this.render(this.time, true);
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
      it.source.connect(it.gain).connect(this.master);
    } catch { it.media.muted = true; }
  }

  wireMedia(it) {
    const v = it.media;
    v.addEventListener('loadedmetadata', () => { it.ready = true; if (it.pendingSeek != null) { v.currentTime = it.pendingSeek; it.pendingSeek = null; } if (!this.playing) this.render(this.time, true); });
    v.addEventListener('seeked', () => {
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
    try { it.source?.disconnect(); it.gain?.disconnect(); } catch { /* */ }
    it.wrap?.remove();
    document.getElementById(`ck_${id}`)?.remove();
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
    if (!wasPlaying) requestAnimationFrame(this.loop);
  }

  pause() {
    this.playing = false;
    for (const it of this.items.values()) { if (it.media?.pause && !it.media.paused) it.media.pause(); }
    this.render(this.time, true);
  }

  seek(t) {
    this.time = clamp(t, 0, Math.max(0, this.duration));
    if (this.playing) { this.clockStart = performance.now(); this.timeStart = this.time; }
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

    for (const L of layers) {
      const c = this.effective(L.clip);
      const m = mediaById(p, c.mediaId);
      let it = this.items.get(c.id);
      if (!it) it = this.createItem(c);
      it.lastUsed = now;
      active.add(c.id);
      const local = t - c.start;
      const g = clipVisualAt(c, m, W, H, Math.max(0, Math.min(c.duration, local)));
      // video fades from/to transparent
      let op = g.opacity;
      if (c.videoFadeIn > 0 && local < c.videoFadeIn) op *= clamp(local / c.videoFadeIn, 0, 1);
      if (c.videoFadeOut > 0 && local > c.duration - c.videoFadeOut) op *= clamp((c.duration - local) / c.videoFadeOut, 0, 1);
      const bs = it.box.style;
      bs.left = `${g.cx - g.w / 2}px`;
      bs.top = `${g.cy - g.h / 2}px`;
      bs.width = `${g.w}px`;
      bs.height = `${g.h}px`;
      bs.transform = `rotate(${g.rotation}deg) scale(${c.flipH ? -1 : 1}, ${c.flipV ? -1 : 1})`;
      bs.opacity = String(op);
      const filters = [];
      if (c.chromaKey) filters.push(this.chromaFilter(c));
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
        this.setGain(it, gain);
      }
    }
    for (const [key, bd] of this.backdrops) if (!usedBackdrops.has(key)) bd.style.display = 'none';

    // preload upcoming visual clips
    for (const track of videoTracks(p)) {
      if (track.hidden) continue;
      for (const s of this.spans.get(track.id) || []) {
        if (s.start > t && s.start - t < PRELOAD_AHEAD && s.clip.type !== 'color') {
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
    if ((it.fxKey || '') === key) return;
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
    if (!c0 || c0.type === 'audio') return null;
    const c = this.effective(c0);
    const local = this.time - c.start;
    if (local < 0 || local > c.duration) return null;
    const g = clipVisualAt(c, mediaById(p, c.mediaId), p.settings.width, p.settings.height, local);
    return { ...g, clip: c, scaleFactor: this.scale, offset: this.offset };
  }
}

export { trackById };
