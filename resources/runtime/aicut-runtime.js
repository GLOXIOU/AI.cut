/*
 * AI.cut motion-design runtime — injected in every HTML clip (templates, AI-written HTML, imported animations, Lottie).
 *
 * Time is fully controlled by the host: CSS animations / transitions, Web Animations, GSAP timelines registered with
 * AICUT.timeline(), Lottie animations registered with AICUT.lottie() and AICUT.onFrame() callbacks are all seeked to the
 * exact clip-local time of each frame. Nothing runs on wall-clock time, which makes the preview and the export identical.
 *
 * Imported / custom HTML (config.virtualTime) also gets a VIRTUAL CLOCK: requestAnimationFrame, setTimeout/setInterval,
 * performance.now() and Date.now() follow the timeline, so ordinary web animations (canvas loops, GSAP, anime.js,
 * lottie autoplay, CSS transitions triggered by JS…) render frame-exactly too. Jumps are replayed frame by frame.
 *
 * Authoring rules (for humans and AIs):
 *  - Transparent background; the page is the size of the video (AICUT.width × AICUT.height).
 *  - Prefer CSS @keyframes with animation-delay for sequencing (fill-mode is forced to `both`).
 *  - For JS/canvas animation use AICUT.onFrame((t, A) => { ...draw for time t... }).
 *  - Read parameters from AICUT.params; clip duration is AICUT.duration (seconds).
 *  - Async loading: const done = AICUT.delayRender(); ... done();
 */
(function () {
  'use strict';
  const cfg = window.AICUT_CONFIG || {};
  const VT = !!cfg.virtualTime;
  const frameCbs = [];
  const timelines = [];
  const lotties = [];
  let pending = 0;
  let booted = false;
  let time = 0;
  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });
  const realRAF = window.requestAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    linear: (p) => p,
    in: (p) => p * p * p,
    out: (p) => 1 - Math.pow(1 - p, 3),
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outBack: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
    outElastic: (p) => (p === 0 ? 0 : p === 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
    outBounce: (p) => {
      const n1 = 7.5625, d1 = 2.75;
      if (p < 1 / d1) return n1 * p * p;
      if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
      if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
      return n1 * (p -= 2.625 / d1) * p + 0.984375;
    },
  };

  function post(msg) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ ...msg, clipId: cfg.clipId }, '*'); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------------------------------ virtual clock
  let vnow = 0; // ms
  let imperative = false; // the page uses rAF / timers (state that cannot be rewound)
  let rafQueue = [];
  let rafSeq = 0;
  const timers = new Map();
  let timerSeq = 0;
  if (VT) {
    const epoch0 = Date.now();
    window.requestAnimationFrame = function (cb) { imperative = true; const id = ++rafSeq; rafQueue.push({ id, cb }); return id; };
    window.cancelAnimationFrame = function (id) { rafQueue = rafQueue.filter((x) => x.id !== id); };
    try { performance.now = () => vnow; } catch (e) { /* ignore */ }
    Date.now = () => epoch0 + vnow;
    window.setTimeout = function (cb, ms, ...args) { imperative = true; const id = ++timerSeq; timers.set(id, { at: vnow + Math.max(0, Number(ms) || 0), cb, args, every: 0 }); return id; };
    window.setInterval = function (cb, ms, ...args) { imperative = true; const id = ++timerSeq; const every = Math.max(4, Number(ms) || 0); timers.set(id, { at: vnow + every, cb, args, every }); return id; };
    window.clearTimeout = window.clearInterval = function (id) { timers.delete(id); };
  }
  function advanceClock(target) {
    let guard = 0;
    while (guard++ < 5000) {
      let next = null;
      for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, tm] = next;
      vnow = Math.max(vnow, tm.at);
      if (tm.every) tm.at += tm.every; else timers.delete(id);
      try { if (typeof tm.cb === 'function') tm.cb(...tm.args); } catch (e) { reportError(e); }
    }
    vnow = target;
    const q = rafQueue;
    rafQueue = [];
    for (const { cb } of q) { try { cb(vnow); } catch (e) { reportError(e); } }
  }
  function driveClock(t) {
    const target = Math.max(0, t * 1000);
    if (target < vnow - 0.5) {
      // cannot rewind imperative state: in the live preview reload the document (the host re-sends the time)
      if (imperative && A.mode === 'preview' && booted) { try { location.reload(); } catch (e) { /* ignore */ } return false; }
      vnow = target;
      advanceClock(target);
      return true;
    }
    const step = 1000 / (A.fps || 30);
    let guard = 0;
    while (vnow + step < target - 0.5 && guard++ < 1800) advanceClock(vnow + step);
    advanceClock(target);
    return true;
  }

  // ------------------------------------------------------------------------------------------ seeking
  const animStart = new WeakMap(); // VT: virtual start time (ms) of animations created after boot
  function seek(t) {
    if (VT && !driveClock(t)) return;
    time = t;
    const root = document.documentElement;
    if (root) {
      root.style.setProperty('--t', String(t));
      root.style.setProperty('--p', String(A.duration > 0 ? clamp(t / A.duration, 0, 1) : 0));
    }
    const ms = Math.max(0, t * 1000);
    const anims = document.getAnimations ? document.getAnimations() : [];
    for (const a of anims) {
      try {
        if (a.playState !== 'paused') a.pause();
        if (VT) {
          if (!animStart.has(a)) animStart.set(a, booted ? ms : 0);
          a.currentTime = Math.max(0, ms - animStart.get(a));
        } else a.currentTime = ms;
      } catch (e) { /* ignore */ }
    }
    for (const tl of timelines) {
      try {
        if (typeof tl.seek === 'function') tl.seek(Math.max(0, t), false);
        else if (typeof tl.time === 'function') tl.time(Math.max(0, t));
      } catch (e) { /* ignore */ }
    }
    for (const l of lotties) {
      try {
        const an = l.anim;
        let ms2 = Math.max(0, t - (l.offset || 0)) * 1000 * (l.speed || 1);
        const total = (an.totalFrames / (an.frameRate || 30)) * 1000;
        if (l.loop && total > 0) ms2 = ms2 % total;
        else ms2 = Math.min(ms2, Math.max(0, total - 1));
        an.goToAndStop(ms2, false);
      } catch (e) { /* ignore */ }
    }
    for (const cb of frameCbs) {
      try { cb(t, A); } catch (e) { reportError(e); }
    }
  }

  function reportError(e) {
    const message = (e && (e.message || e.reason?.message)) || String(e);
    if (!A._errors) A._errors = [];
    if (A._errors.length < 20) A._errors.push(message);
    post({ type: 'aicut:error', message });
  }

  const A = (window.AICUT = {
    params: cfg.params || {},
    duration: cfg.duration ?? 5,
    width: cfg.width ?? window.innerWidth,
    height: cfg.height ?? window.innerHeight,
    fps: cfg.fps ?? 30,
    mode: cfg.mode || 'preview',
    clipId: cfg.clipId || null,
    virtualTime: VT,
    get time() { return time; },
    seek,
    onFrame(cb) {
      frameCbs.push(cb);
      try { cb(time, A); } catch (e) { reportError(e); }
      return () => { const i = frameCbs.indexOf(cb); if (i >= 0) frameCbs.splice(i, 1); };
    },
    /** Register a GSAP timeline (or any object with seek(t)/time(t)). It is paused and host-driven. */
    timeline(tl) { try { tl.pause && tl.pause(); } catch (e) { /* */ } timelines.push(tl); seek(time); return tl; },
    /** Register a lottie-web animation. opts: {loop, offset, speed} */
    lottie(anim, opts) { lotties.push({ anim, ...(opts || {}) }); seek(time); return anim; },
    delayRender() {
      pending++;
      let done = false;
      const timer = realSetTimeout(() => finish(), 15000);
      function finish() { if (done) return; done = true; realClearTimeout(timer); pending--; checkReady(); }
      return finish;
    },
    ready: () => readyPromise,
    // helpers
    clamp, lerp, ease,
    /** progress of t inside [start, start+dur] (0..1, clamped) */
    progress: (t, start, dur) => clamp((t - start) / Math.max(1e-6, dur), 0, 1),
    /** interpolate(t, [t0, t1], [v0, v1], easeFn) */
    interpolate(t, inR, outR, fn) {
      const p = clamp((t - inR[0]) / Math.max(1e-6, inR[1] - inR[0]), 0, 1);
      return lerp(outR[0], outR[1], (fn || ease.linear)(p));
    },
    /** Damped spring 0→1 */
    spring(t, { stiffness = 170, damping = 26, mass = 1 } = {}) {
      if (t <= 0) return 0;
      const w0 = Math.sqrt(stiffness / mass), z = damping / (2 * Math.sqrt(stiffness * mass));
      if (z < 1) {
        const wd = w0 * Math.sqrt(1 - z * z);
        return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
      }
      return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    },
    /** Wrap text of an element into spans (chars|words) with --i / --n CSS variables for staggering. */
    splitText(el, by = 'chars') {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) return [];
      const text = el.textContent;
      el.textContent = '';
      const parts = by === 'words' ? text.split(/(\s+)/) : Array.from(text);
      const spans = [];
      let i = 0;
      const count = parts.filter((p) => p.trim()).length;
      for (const part of parts) {
        if (!part.trim()) { el.appendChild(document.createTextNode(part)); continue; }
        const s = document.createElement('span');
        s.textContent = part;
        s.className = by === 'words' ? 'w' : 'c';
        s.style.setProperty('--i', String(i++));
        s.style.setProperty('--n', String(count));
        s.style.display = 'inline-block';
        el.appendChild(s);
        spans.push(s);
      }
      return spans;
    },
  });
  function checkReady() {
    if (!booted || pending > 0) return;
    seek(time);
    window.__aicutReady = true;
    readyResolve();
    post({ type: 'aicut:ready', errors: A._errors || [] });
  }

  window.addEventListener('error', (e) => reportError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'aicut:seek' && typeof d.t === 'number') seek(d.t);
  });

  // Frame capture hook used by the offscreen exporter: seek, update the sync tag, wait one (real) frame.
  let tagEl = null;
  window.__aicutFrame = function (t, tag) {
    seek(t);
    if (tag != null) {
      if (!tagEl) {
        tagEl = document.createElement('div');
        tagEl.setAttribute('style', `position:fixed!important;left:0!important;top:${A.height}px!important;width:${A.width}px!important;` +
          'height:16px!important;z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;' +
          'transform:none!important;opacity:1!important;animation:none!important;transition:none!important');
        document.documentElement.appendChild(tagEl);
      }
      tagEl.style.setProperty('background', `rgb(${tag & 255},${(tag >> 8) & 255},255)`, 'important');
    }
    return new Promise((r) => realRAF(() => r(true)));
  };
  window.__aicutErrors = () => A._errors || [];

  /** Libraries with their own clock: make them follow the virtual clock without lag compensation. */
  function tameLibraries() {
    try { if (window.gsap?.ticker?.lagSmoothing) window.gsap.ticker.lagSmoothing(0); } catch (e) { /* ignore */ }
    try { if (window.TweenMax?.ticker) window.TweenLite?.lagSmoothing?.(0); } catch (e) { /* ignore */ }
  }

  async function boot() {
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
    const imgs = Array.from(document.images || []);
    await Promise.all(imgs.map((img) => (img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; realSetTimeout(r, 10000); }))));
    if (VT) {
      tameLibraries();
      // let window.onload handlers run before the first frame
      if (document.readyState !== 'complete') await new Promise((r) => { window.addEventListener('load', r, { once: true }); realSetTimeout(r, 3000); });
      tameLibraries();
    }
    booted = true;
    seek(0);
    checkReady();
  }
  boot();
})();
