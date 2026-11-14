import React, { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { MousePointer2, Scissors, Magnet, Plus, Maximize, Eye, EyeOff, Lock, Unlock, Volume2, VolumeX, Headphones, Film, Music, Image as ImageIcon, Sparkles, Square, Zap, Wand2, AudioLines, ZoomIn, ZoomOut, SlidersHorizontal, Star, Trash2, X } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { playhead } from '../../app/playhead.js';
import { op, call, fileUrl } from '../../app/api.js';
import { useT } from '../../app/i18n.js';
import { fmtTime, projectDuration, mediaById, r4 } from '@shared/timeline.js';
import { animDurations } from '@shared/anim.js';
import { getPeaks, onPeaks, drawWave } from './peaks.js';
import { engineRef } from '../player/Player.jsx';
import { RulerOverlays, AskAiBox } from './Overlays.jsx';
import { useShortcut } from '../../app/shortcuts.js';

const HEADER_W = 158;
const MARK_H = 20; // band above the ticks: AI ideas (★ flags), pinned requests, the "ask the AI" button
const TICK_H = 26;
const RULER_H = MARK_H + TICK_H;
const LANE_H = { video: 56, audio: 48, subs: 28 };

export function Timeline() {
  const t = useT();
  const kb = useShortcut();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  const snapping = useStore((s) => s.snapping);
  const aiFlash = useStore((s) => s.aiFlash);
  const selectedCue = useStore((s) => s.selectedCue);
  const scrollRef = useRef(null);
  const rulerRef = useRef(null);
  const playheadRef = useRef(null);
  const tcRef = useRef(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [drag, setDrag] = useState(null);
  const [menu, setMenu] = useState(null);
  const [laneMenu, setLaneMenu] = useState(null);
  const [ask, setAsk] = useState(null);
  const [hint, setHint] = useState(null); // { x, y, ctx } bubble shown after the mouse rests on the timeline
  const askBtnRef = useRef(null); // "Ask" pill above the playhead
  const [, setPeaksTick] = useState(0);
  const set = useStore.setState;

  useEffect(() => onPeaks(() => setPeaksTick((x) => x + 1)), []);

  const lanes = useMemo(() => {
    if (!project) return [];
    const v = project.tracks.filter((x) => x.type === 'video').slice().reverse();
    const a = project.tracks.filter((x) => x.type === 'audio');
    return [{ kind: 'subs', id: '__subs', h: LANE_H.subs }, ...v.map((tr) => ({ kind: 'track', track: tr, id: tr.id, h: LANE_H.video })), ...a.map((tr) => ({ kind: 'track', track: tr, id: tr.id, h: LANE_H.audio }))];
  }, [project?.tracks]);
  const laneTop = useMemo(() => { let y = 0; const m = new Map(); for (const l of lanes) { m.set(l.id, y); y += l.h; } m.set('__end', y); return m; }, [lanes]);

  const duration = project ? projectDuration(project) : 0;
  const contentW = Math.max(duration + 20, (view.width - HEADER_W) / zoom + 5) * zoom;
  const fps = project?.settings.fps || 30;

  // ---------------------------------------------------------------- view tracking
  // scroll position / width are cached here so the per-frame playhead update never reads layout (a read right
  // after the timecode write forced a full synchronous reflow on every frame of playback)
  const metrics = useRef({ left: 0, width: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const commit = () => { raf = 0; setView((v) => (v.left === metrics.current.left && v.width === metrics.current.width ? v : { ...metrics.current })); };
    const upd = () => {
      metrics.current = { left: el.scrollLeft, width: el.clientWidth };
      if (!raf) raf = requestAnimationFrame(commit); // at most one timeline render per frame while scrolling
    };
    upd();
    el.addEventListener('scroll', upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', upd); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [project ? 1 : 0]);

  // ---------------------------------------------------------------- playhead line + timecode + autoscroll
  useEffect(() => {
    let lastTc = '';
    const move = (tm) => {
      const x = tm * zoom;
      const el = scrollRef.current;
      if (el && playhead.playing) {
        const m = metrics.current;
        if (x > m.left + m.width - HEADER_W - 40 || x < m.left) {
          const left = Math.max(0, x - 60);
          el.scrollLeft = left;
          metrics.current = { ...m, left };
        }
      }
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const tc = fmtTime(tm, fps);
      if (tc !== lastTc && tcRef.current) { tcRef.current.textContent = tc; lastTc = tc; }
    };
    move(playhead.time);
    return playhead.sub(move);
  }, [zoom, fps]);

  // ---------------------------------------------------------------- ruler
  useEffect(() => {
    const c = rulerRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, view.width - HEADER_W);
    c.width = w * dpr; c.height = TICK_H * dpr;
    c.style.width = `${w}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, TICK_H);
    const steps = [1 / fps, 2 / fps, 5 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
    const major = steps.find((s) => s * zoom >= 80) || 1200;
    const minor = major / (major >= 1 && major % 5 === 0 ? 5 : major >= 1 ? 2 : major >= 0.5 ? 5 : 1);
    const t0 = view.left / zoom, t1 = (view.left + w) / zoom;
    ctx.font = '10px Inter, sans-serif';
    for (let tm = Math.floor(t0 / minor) * minor; tm <= t1; tm += minor) {
      const x = tm * zoom - view.left;
      const isMajor = Math.abs(tm / major - Math.round(tm / major)) < 1e-6;
      ctx.fillStyle = isMajor ? '#6a6a6a' : '#3e3e3e';
      ctx.fillRect(Math.round(x), isMajor ? 14 : 20, 1, isMajor ? 12 : 6);
      if (isMajor) { ctx.fillStyle = '#8c8c8c'; ctx.fillText(fmtTime(tm, fps), x + 4, 11); }
    }
    for (const mk of project?.markers || []) {
      const x = mk.time * zoom - view.left;
      ctx.fillStyle = mk.color || '#d9a13b';
      ctx.beginPath(); ctx.moveTo(x - 4, 14); ctx.lineTo(x + 4, 14); ctx.lineTo(x + 4, 20); ctx.lineTo(x, 24); ctx.lineTo(x - 4, 20); ctx.fill();
    }
  }, [view, zoom, project?.markers, fps]);

  // ---------------------------------------------------------------- zoom helpers
  const setZoom = useCallback((z, anchorClientX) => {
    const el = scrollRef.current;
    const nz = Math.max(2, Math.min(3000, z));
    if (!el) { set({ zoom: nz }); return; }
    const rect = el.getBoundingClientRect();
    const ax = anchorClientX != null ? anchorClientX - rect.left - HEADER_W : (el.clientWidth - HEADER_W) / 2;
    const tAt = (el.scrollLeft + ax) / useStore.getState().zoom;
    set({ zoom: nz });
    requestAnimationFrame(() => { el.scrollLeft = Math.max(0, tAt * nz - ax); });
  }, []);

  useEffect(() => {
    const fit = () => {
      const el = scrollRef.current;
      const d = Math.max(5, projectDuration(useStore.getState().project || { clips: [] }));
      if (el) { set({ zoom: Math.max(2, (el.clientWidth - HEADER_W - 40) / d) }); el.scrollLeft = 0; }
    };
    const zin = () => setZoom(useStore.getState().zoom * 1.4);
    const zout = () => setZoom(useStore.getState().zoom / 1.4);
    window.addEventListener('aicut:zoom-fit', fit);
    window.addEventListener('aicut:zoom-in', zin);
    window.addEventListener('aicut:zoom-out', zout);
    return () => { window.removeEventListener('aicut:zoom-fit', fit); window.removeEventListener('aicut:zoom-in', zin); window.removeEventListener('aicut:zoom-out', zout); };
  }, [setZoom]);

  const onWheel = (e) => {
    if (e.ctrlKey || e.altKey) {
      e.preventDefault();
      setZoom(zoom * Math.pow(1.0015, -e.deltaY), e.clientX);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      const el = scrollRef.current;
      if (el.scrollHeight <= el.clientHeight + 2) { el.scrollLeft += e.deltaY; e.preventDefault(); }
    }
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = (e) => onWheel(e);
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  });

  // ---------------------------------------------------------------- geometry helpers
  const timeAt = (clientX) => {
    const el = scrollRef.current;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / zoom);
  };
  const laneAt = (clientY) => {
    const el = scrollRef.current;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top - RULER_H + el.scrollTop;
    for (const l of lanes) { const top = laneTop.get(l.id); if (y >= top && y < top + l.h) return l; }
    return null;
  };
  const snapPoints = (excludeIds) => {
    const pts = [0, playhead.time];
    for (const c of project.clips) if (!excludeIds.includes(c.id)) pts.push(c.start, c.start + c.duration);
    for (const m of project.markers) pts.push(m.time);
    return pts;
  };
  const snapT = (tm, pts) => {
    if (!snapping) return tm;
    let best = tm, bd = 9 / zoom;
    for (const p of pts) { const d = Math.abs(p - tm); if (d < bd) { bd = d; best = p; } }
    return best;
  };

  // ---------------------------------------------------------------- interactions
  const onClipDown = (e, clip, region) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useStore.getState();
    const track = project.tracks.find((x) => x.id === clip.trackId);
    if (tool === 'razor') { op('splitClip', { id: clip.id, time: snapT(timeAt(e.clientX), snapPoints([clip.id])) }, 'razor'); return; }
    let sel = st.selection;
    if (e.shiftKey || e.ctrlKey || e.metaKey) { st.select([clip.id], 'toggle'); return; }
    if (!sel.includes(clip.id)) { sel = [clip.id]; st.select(sel); }
    if (track?.locked) return;
    const startX = e.clientX, startY = e.clientY;
    const pts = snapPoints(region === 'body' ? sel : [clip.id]);
    const startLane = laneAt(e.clientY);
    let state = null;
    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!state && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      if (region === 'body') {
        let delta = dx / zoom;
        const ns = clip.start + delta, ne = ns + clip.duration;
        const s1 = snapT(ns, pts), s2 = snapT(ne, pts);
        if (s1 !== ns) delta = s1 - clip.start; else if (s2 !== ne) delta = s2 - clip.duration - clip.start;
        const minStart = Math.min(...sel.map((id) => project.clips.find((c) => c.id === id)?.start ?? 0));
        if (minStart + delta < 0) delta = -minStart;
        const lane = laneAt(ev.clientY);
        let trackShift = 0;
        if (lane && startLane && lane.kind === 'track' && startLane.kind === 'track' && lane.track.type === startLane.track.type) {
          const list = project.tracks.filter((x) => x.type === lane.track.type);
          trackShift = list.indexOf(lane.track) - list.indexOf(startLane.track);
        }
        const dyPx = lane && startLane ? laneTop.get(lane.id) - laneTop.get(startLane.id) : 0;
        state = { kind: 'move', ids: sel, delta, trackShift, dyPx: trackShift ? dyPx : 0 };
      } else {
        const tm = snapT(timeAt(ev.clientX), pts);
        state = { kind: 'trim', id: clip.id, edge: region === 'left' ? 'start' : 'end', time: tm, ripple: ev.altKey };
      }
      setDrag(state);
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!state) return;
      if (state.kind === 'move' && (Math.abs(state.delta) > 1e-4 || state.trackShift)) {
        await op('moveClips', { ids: state.ids, delta: r4(state.delta), trackShift: state.trackShift }, 'move clips');
      } else if (state.kind === 'trim') {
        await op('trimClip', { id: state.id, edge: state.edge, time: r4(state.time), ripple: state.ripple }, 'trim');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onLanesDown = (e) => {
    if (e.button !== 0 || e.target.closest('.clip') || e.target.closest('.cue')) return;
    const st = useStore.getState();
    const x0 = e.clientX, y0 = e.clientY;
    const el = scrollRef.current;
    const rect = el.getBoundingClientRect();
    if (!e.shiftKey) st.select([]);
    playhead.set(timeAt(e.clientX), 'ui');
    let box = null;
    const move = (ev) => {
      if (Math.abs(ev.clientX - x0) < 4 && Math.abs(ev.clientY - y0) < 4) return;
      box = { x0: x0 - rect.left - HEADER_W + el.scrollLeft, y0: y0 - rect.top - RULER_H + el.scrollTop, x1: ev.clientX - rect.left - HEADER_W + el.scrollLeft, y1: ev.clientY - rect.top - RULER_H + el.scrollTop };
      setDrag({ kind: 'box', box });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!box) return;
      const [bx0, bx1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
      const [by0, by1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
      const ids = [];
      for (const c of project.clips) {
        const top = laneTop.get(c.trackId);
        const lane = lanes.find((l) => l.id === c.trackId);
        if (top == null || !lane) continue;
        const cx0 = c.start * zoom, cx1 = (c.start + c.duration) * zoom;
        if (cx1 >= bx0 && cx0 <= bx1 && top + lane.h >= by0 && top <= by1) ids.push(c.id);
      }
      st.select(ids, e.shiftKey ? 'add' : 'set');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Scrub: drag the playhead (from the ruler, the playhead head or its line); the view follows near the edges. */
  const startScrub = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    let lastX = e.clientX, raf = 0, alive = true;
    const setT = (clientX, alt) => {
      const tm = timeAt(clientX);
      playhead.set(snapping && !alt ? snapT(tm, snapPoints([])) : tm, 'ui');
    };
    setT(e.clientX, e.altKey);
    document.body.classList.add('scrubbing');
    // auto-scroll while the pointer is held past the left / right edge of the lanes
    const edgeScroll = () => {
      if (!alive) return;
      const r = el.getBoundingClientRect();
      const left = r.left + HEADER_W, right = r.right - 12;
      let d = 0;
      if (lastX > right) d = Math.min(40, (lastX - right) / 2 + 4);
      else if (lastX < left + 8 && el.scrollLeft > 0) d = -Math.min(40, (left + 8 - lastX) / 2 + 4);
      if (d) { el.scrollLeft = Math.max(0, el.scrollLeft + d); setT(Math.max(left, Math.min(right, lastX)), false); }
      raf = requestAnimationFrame(edgeScroll);
    };
    raf = requestAnimationFrame(edgeScroll);
    const move = (ev) => { lastX = ev.clientX; setT(ev.clientX, ev.altKey); };
    const up = () => {
      alive = false;
      cancelAnimationFrame(raf);
      document.body.classList.remove('scrubbing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onRulerDown = startScrub;

  const onDrop = async (e) => {
    e.preventDefault();
    const lane = laneAt(e.clientY);
    const tm = r4(snapT(timeAt(e.clientX), snapPoints([])));
    const mediaId = e.dataTransfer.getData('application/x-aicut-media');
    const tplId = e.dataTransfer.getData('application/x-aicut-template');
    const sfxId = e.dataTransfer.getData('application/x-aicut-sfx');
    const animJson = e.dataTransfer.getData('application/x-aicut-anim');
    const track = lane?.kind === 'track' ? lane.track.id : undefined;
    if (mediaId) { await op('addClip', { mediaId, track, start: tm }, 'add clip'); return; }
    if (tplId) { await op('addClip', { template: tplId, track: track || 'overlay', start: tm }, 'add motion'); return; }
    if (sfxId) {
      const audioTrack = lane?.kind === 'track' && lane.track.type === 'audio' ? lane.track.id : 'auto';
      try { await call('library:add', { id: sfxId, place: { start: tm, track: audioTrack } }); } catch (err) { useStore.getState().toast('error', err.message); }
      return;
    }
    if (animJson) {
      // drop an animation preset on the clip under the cursor
      const a = JSON.parse(animJson);
      const target = project.clips.find((c) => c.trackId === track && c.start <= tm && c.start + c.duration >= tm);
      if (target) await op('setAnimation', { ids: [target.id], [a.slot]: a.type }, `animation ${a.type}`);
      return;
    }
    const files = [...(e.dataTransfer.files || [])].map((f) => window.aicut.pathForFile(f)).filter(Boolean);
    if (files.length) {
      const ids = await call('media:import', { paths: files }).catch((err) => { useStore.getState().toast('error', err.message); return []; });
      useStore.getState().toast('info', t('importedDrag', { n: ids.length }));
    }
  };

  /** Context of a click for "ask the AI here": time (or the in/out range around it), track, clip. */
  const askContext = (e, clip) => {
    const st = useStore.getState();
    const tm = r4(timeAt(e.clientX));
    const lane = laneAt(e.clientY);
    const track = clip ? project.tracks.find((x) => x.id === clip.trackId) : lane?.kind === 'track' ? lane.track : null;
    const inRange = st.inPoint != null && st.outPoint != null && tm >= st.inPoint - 1e-3 && tm <= st.outPoint + 1e-3;
    return { x: e.clientX, y: e.clientY, time: inRange ? st.inPoint : tm, end: inRange ? st.outPoint : null, trackId: track?.id, trackName: track?.name, clipId: clip?.id, clipName: clip?.name };
  };
  const clipAt = (x, y) => {
    const lane = laneAt(y);
    if (lane?.kind !== 'track') return null;
    const tm = timeAt(x);
    return project.clips.find((c) => c.trackId === lane.track.id && c.start <= tm && c.start + c.duration >= tm) || null;
  };

  // "ask the AI here" bubble: appears when the mouse rests ~1 s on the timeline, with the context under it
  const dwell = useRef({ timer: 0, x: -99, y: -99 });
  const clearHint = () => { clearTimeout(dwell.current.timer); dwell.current.timer = 0; setHint(null); };
  const onLanesHover = (e) => {
    const d = dwell.current;
    if (e.buttons || drag || ask || menu || laneMenu || playhead.playing) { clearTimeout(d.timer); d.timer = 0; return; }
    if (hint) {
      if (Math.hypot(e.clientX - hint.x, e.clientY - hint.y) <= 60) return; // moving towards the bubble keeps it
      setHint(null);
    }
    if (d.timer && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return; // hand jitter does not restart the wait
    clearTimeout(d.timer);
    d.x = e.clientX; d.y = e.clientY;
    const at = { clientX: e.clientX, clientY: e.clientY };
    d.timer = setTimeout(() => {
      d.timer = 0;
      if (playhead.playing) return;
      setHint({ x: at.clientX, y: at.clientY, ctx: askContext(at, clipAt(at.clientX, at.clientY)) });
    }, 1000);
  };
  useEffect(() => playhead.sub((tm, src) => { if (src === 'state' && playhead.playing) { clearTimeout(dwell.current.timer); dwell.current.timer = 0; setHint(null); } }), []);
  // the pill above the playhead only shows (animated) once the playhead has stopped moving for 1 s: hidden while
  // playing / scrubbing. Driven through a CSS class, no React render on playhead moves.
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      clearTimeout(timer);
      askBtnRef.current?.classList.remove('show');
      if (playhead.playing) return;
      timer = setTimeout(() => { if (!playhead.playing) askBtnRef.current?.classList.add('show'); }, 1000);
    };
    arm();
    const off = playhead.sub(arm);
    return () => { clearTimeout(timer); off(); };
  }, [!!project]);
  const onLanesLeave = (e) => {
    clearTimeout(dwell.current.timer);
    dwell.current.timer = 0;
    if (!e.relatedTarget?.closest?.('.ask-hint')) setHint(null);
  };
  /** Toolbar button: ask about the in → out range, else the selected clip / the playhead position. */
  const askAtPlayhead = (e) => {
    const st = useStore.getState();
    const r = e.currentTarget.getBoundingClientRect();
    const sel = st.selection.length === 1 ? project.clips.find((c) => c.id === st.selection[0]) : null;
    const track = sel ? project.tracks.find((x) => x.id === sel.trackId) : null;
    const io = st.inPoint != null && st.outPoint != null;
    setAsk({ x: r.left, y: r.bottom - 4, time: io ? st.inPoint : r4(playhead.time), end: io ? st.outPoint : null, trackId: track?.id, trackName: track?.name, clipId: sel?.id, clipName: sel?.name });
  };

  const onLanesMenu = (e) => {
    if (e.target.closest('.clip')) return;
    e.preventDefault();
    const lane = laneAt(e.clientY);
    setLaneMenu({ x: e.clientX, y: e.clientY, time: r4(timeAt(e.clientX)), ctx: askContext(e, null), lane });
  };

  const openMenu = (e, clip) => {
    e.preventDefault();
    e.stopPropagation();
    const st = useStore.getState();
    if (!st.selection.includes(clip.id)) st.select([clip.id]);
    setMenu({ x: e.clientX, y: e.clientY, clip, ctx: askContext(e, clip) });
  };

  if (!project) return <div className="timeline" />;
  const totalH = laneTop.get('__end');
  const visT0 = view.left / zoom - 2, visT1 = (view.left + view.width) / zoom + 2;
  const tb = (id, Icon, title, key) => (
    <button className={`icon-btn ${tool === id ? 'on' : ''}`} title={key ? `${title} (${key})` : title} onClick={() => set({ tool: id })}><Icon size={15} /></button>
  );
  return (
    <div className="timeline" onContextMenu={(e) => e.preventDefault()}>
      <div className="tl-tools">
        {tb('select', MousePointer2, t('selectTool'), kb('toolSelect'))}
        {tb('razor', Scissors, t('razorTool'), kb('toolRazor'))}
        <div className="sep" />
        <button className={`icon-btn ${snapping ? 'on' : ''}`} title={kb('toggleSnap') ? `${t('snapping')} (${kb('toggleSnap')})` : t('snapping')} onClick={() => set({ snapping: !snapping })}><Magnet size={15} /></button>
        <div className="sep" />
        <button className="icon-btn" title={t('zoomIn')} onClick={() => setZoom(zoom * 1.4)}><ZoomIn size={15} /></button>
        <button className="icon-btn" title={t('zoomOut')} onClick={() => setZoom(zoom / 1.4)}><ZoomOut size={15} /></button>
        <button className="icon-btn" title={kb('zoomFit') ? `${t('zoomFit')} (${kb('zoomFit')})` : t('zoomFit')} onClick={() => window.dispatchEvent(new Event('aicut:zoom-fit'))}><Maximize size={15} /></button>
      </div>
      <div className="tl-main">
        <div className="tl-toolbar">
          <div className="tl-seq"><span className="name">{project.name}</span><span className="timecode" ref={tcRef}>{fmtTime(playhead.time, fps)}</span></div>
          <div className="tl-group">
            <button className="btn quiet sm" onClick={() => op('addTrack', { type: 'video' }, 'add track')}><Plus size={12} /> {t('addVideoTrack')}</button>
            <button className="btn quiet sm" onClick={() => op('addTrack', { type: 'audio' }, 'add track')}><Plus size={12} /> {t('addAudioTrack')}</button>
          </div>
          <div className="tl-group">
            <button className="btn quiet sm" title={t('removeSilences')} onClick={async () => { const r = await call('edit:removeSilences', {}).catch((e2) => useStore.getState().toast('error', e2.message)); if (r) useStore.getState().toast('success', t('silencesCut', { n: r.ranges || 0, s: r.secondsRemoved || 0 })); }}><Zap size={12} /> {t('removeSilences')}</button>
            <button className="btn quiet sm" title={t('duckMusic')} onClick={async () => { const r = await call('edit:duckMusic', {}).catch((e2) => useStore.getState().toast('error', e2.message)); if (r) useStore.getState().toast('success', t('ducked', { n: r.musicClips })); }}><Wand2 size={12} /> Ducking</button>
            <button className="btn quiet sm" title={t('autoSfxHint')} onClick={async () => { const r = await call('edit:autoSfx', {}).catch((e2) => useStore.getState().toast('error', e2.message)); if (r) useStore.getState().toast('success', t('autoSfxDone', { n: r.added })); }}><AudioLines size={12} /> {t('autoSfx')}</button>
          </div>
          <div className="tl-spacer" />
          <input className="zoom-range" type="range" min="0" max="1" step="0.001" value={Math.log(zoom / 2) / Math.log(1500)} onChange={(e) => setZoom(2 * Math.pow(1500, Number(e.target.value)))} title="Zoom" />
        </div>
        <div className="tl-body">
          <div className="tl-scroll" ref={scrollRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <div className="tl-inner" style={{ width: contentW + HEADER_W, height: totalH + RULER_H + 40 }}>
              <div className="tl-ruler-row" style={{ width: contentW + HEADER_W, height: RULER_H }}>
                <div className="tl-corner" style={{ width: HEADER_W, height: RULER_H }}>{fmtTime(duration, fps)}</div>
                <div className="tl-band" style={{ left: HEADER_W, width: contentW, height: MARK_H }} onPointerDown={onRulerDown} />
                <canvas className="tl-ruler" ref={rulerRef} style={{ left: HEADER_W + view.left, top: MARK_H, height: TICK_H }} onPointerDown={onRulerDown} onDoubleClick={(e) => op('addMarker', { time: r4(timeAt(e.clientX)), label: '' }, 'marker')} />
                <RulerOverlays project={project} zoom={zoom} headerW={HEADER_W} markH={MARK_H} />
              </div>
              <div className="tl-headers" style={{ top: RULER_H }}>
                {lanes.map((l) => <LaneHeader key={l.id} lane={l} project={project} />)}
              </div>
              <div className="tl-lanes" style={{ left: HEADER_W, top: RULER_H, width: contentW, height: totalH }} onPointerDown={onLanesDown} onPointerDownCapture={clearHint} onPointerMove={onLanesHover} onPointerLeave={onLanesLeave} onWheel={hint ? clearHint : undefined} onContextMenu={onLanesMenu}>
                {lanes.map((l) => (
                  <div key={l.id} className={`lane lane-${l.kind === 'subs' ? 'subs' : l.track.type} ${l.track?.locked ? 'locked' : ''} ${l.track?.hidden ? 'hidden-track' : ''}`} style={{ top: laneTop.get(l.id), height: l.h }} />
                ))}
                {project.subtitles.cues.filter((q) => q.end > visT0 && q.start < visT1).map((q) => (
                  <div key={q.id} className={`cue ${selectedCue === q.id ? 'sel' : ''} ${project.subtitles.enabled ? '' : 'off'}`} style={{ left: q.start * zoom, width: Math.max(2, (q.end - q.start) * zoom), top: 3, height: LANE_H.subs - 6 }}
                    onPointerDown={(e) => { e.stopPropagation(); set({ selectedCue: q.id, selection: [] }); playhead.set(q.start, 'ui'); }}>
                    {(q.end - q.start) * zoom > 24 && q.text}
                  </div>
                ))}
                {project.clips.map((c) => {
                  if (c.start > visT1 || c.start + c.duration < visT0) {
                    if (!(drag?.kind === 'move' && drag.ids.includes(c.id))) return null;
                  }
                  const lane = lanes.find((l) => l.id === c.trackId);
                  if (!lane) return null;
                  let vc = c, dx = 0, dy = 0;
                  if (drag?.kind === 'move' && drag.ids.includes(c.id)) { dx = drag.delta * zoom; dy = drag.dyPx; }
                  if (drag?.kind === 'trim' && drag.id === c.id) vc = trimGhost(c, drag, mediaById(project, c.mediaId));
                  return (
                    <ClipView key={c.id} clip={vc} media={mediaById(project, c.mediaId)} zoom={zoom} top={laneTop.get(c.trackId)} height={lane.h}
                      selected={selection.includes(c.id)} flash={aiFlash[c.id]} dx={dx} dy={dy} dragging={!!(dx || dy)}
                      viewT0={visT0} viewT1={visT1} onDown={onClipDown} onMenu={openMenu} />
                  );
                })}
                {drag?.kind === 'box' && <div className="box-select" style={{ left: Math.min(drag.box.x0, drag.box.x1), top: Math.min(drag.box.y0, drag.box.y1), width: Math.abs(drag.box.x1 - drag.box.x0), height: Math.abs(drag.box.y1 - drag.box.y0) }} />}
              </div>
              <div className="tl-playhead" ref={playheadRef} style={{ left: HEADER_W, height: totalH + RULER_H }}>
                <div className="ph-grab" onPointerDown={startScrub} title={t('dragPlayhead')} />
                <button className="ph-ask" ref={askBtnRef} title={t('askAiToolbarHint')} onPointerDown={(e) => e.stopPropagation()} onClick={askAtPlayhead}><Sparkles size={11} /> {t('askShortBtn')}</button>
                <div className="ph-head" onPointerDown={startScrub} title={t('dragPlayhead')} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <Meters />
      {menu && <ClipMenu menu={menu} onClose={() => setMenu(null)} onAsk={(c) => setAsk(c)} />}
      {laneMenu && <LaneMenu menu={laneMenu} onClose={() => setLaneMenu(null)} onAsk={(c) => setAsk(c)} />}
      {ask && <AskAiBox ctx={ask} onClose={() => setAsk(null)} />}
      {hint && !ask && (
        <button className="ask-hint" style={{ left: hint.x + 14, top: hint.y + 14 }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { setAsk({ ...hint.ctx, x: hint.x, y: hint.y }); setHint(null); }}
          onPointerLeave={(e) => { if (!e.relatedTarget?.closest?.('.tl-lanes')) setHint(null); }}>
          <Sparkles size={13} /> {t('askAiHere')}
          <span className="ask-hint-ctx">{fmtTime(hint.ctx.time)}{hint.ctx.end != null ? ` → ${fmtTime(hint.ctx.end)}` : ''}{hint.ctx.clipName ? ` · ${hint.ctx.clipName}` : ''}</span>
        </button>
      )}
    </div>
  );
}

/** Stereo peak meters fed by the preview engine (Premiere's "Audio Meters"). */
function Meters() {
  const ref = useRef([]);
  // the meters only animate while something plays (and until the bars have fallen back), at ~60 fps max;
  // idle, they cost nothing (they used to redraw on every display refresh, forever)
  useEffect(() => {
    let raf = 0, last = 0, peaks = [-120, -120], hold = [-120, -120], holdAt = [0, 0];
    const sizes = [[0, 0], [0, 0]];
    const draw = (now) => {
      raf = 0;
      if (now - last < 15) { raf = requestAnimationFrame(draw); return; }
      last = now;
      const eng = engineRef.current;
      const live = !!(eng && playhead.playing);
      const lv = live ? eng.levels() : [-120, -120];
      let busy = live;
      ref.current.forEach((cv, ch) => {
        if (!cv) return;
        const [w, h] = sizes[ch];
        if (!w || !h) return;
        if (cv.height !== h || cv.width !== w) { cv.height = h; cv.width = w; }
        peaks[ch] = Math.max(lv[ch], peaks[ch] - 1.2);
        if (peaks[ch] > hold[ch] || now - holdAt[ch] > 1200) { hold[ch] = peaks[ch]; holdAt[ch] = now; }
        if (peaks[ch] > -54 || hold[ch] > -54) busy = true;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#262626';
        ctx.fillRect(0, 0, w, h);
        const y = (db) => h * (1 - Math.max(0, Math.min(1, (db + 54) / 54)));
        const top = y(peaks[ch]);
        const grd = ctx.createLinearGradient(0, h, 0, 0);
        grd.addColorStop(0, '#2e7d5a'); grd.addColorStop(0.72, '#3fb27f'); grd.addColorStop(0.86, '#d9a13b'); grd.addColorStop(1, '#e0564e');
        ctx.fillStyle = grd;
        ctx.fillRect(0, top, w, h - top);
        if (hold[ch] > -54) { ctx.fillStyle = hold[ch] > -1 ? '#e0564e' : '#bdbdbd'; ctx.fillRect(0, y(hold[ch]), w, 1); }
      });
      if (busy) raf = requestAnimationFrame(draw);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const ro = new ResizeObserver(() => {
      ref.current.forEach((cv, ch) => { if (cv) sizes[ch] = [cv.clientWidth, cv.clientHeight]; });
      kick();
    });
    ref.current.forEach((cv) => cv && ro.observe(cv));
    kick();
    const off = playhead.sub((tm, src) => { if (src === 'state' && playhead.playing) kick(); });
    return () => { if (raf) cancelAnimationFrame(raf); ro.disconnect(); off(); };
  }, []);
  return (
    <div className="tl-meters" title="dB">
      <span className="meter-scale">0</span>
      <div className="meter"><canvas ref={(el) => { ref.current[0] = el; }} /><canvas ref={(el) => { ref.current[1] = el; }} /></div>
      <span className="meter-scale">-54</span>
    </div>
  );
}

function trimGhost(c, drag, media) {
  const g = { ...c };
  if (drag.edge === 'start') {
    let ns = Math.min(drag.time, c.start + c.duration - 0.04);
    if (c.type === 'video' || c.type === 'audio') ns = Math.max(ns, c.start - c.in / c.speed);
    g.duration = c.start + c.duration - ns;
    g.in = c.in + (ns - c.start) * c.speed;
    g.start = ns;
  } else {
    let ne = Math.max(c.start + 0.04, drag.time);
    if ((c.type === 'video' || c.type === 'audio') && media?.duration) ne = Math.min(ne, c.start + (media.duration - c.in) / c.speed);
    g.duration = ne - c.start;
  }
  return g;
}

function LaneMenu({ menu, onClose, onAsk }) {
  const t = useT();
  const kb = useShortcut();
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener('pointerdown', h);
    return () => window.removeEventListener('pointerdown', h);
  }, [onClose]);
  const item = (label, fn) => (
    <div className="menu-item" onPointerDown={(e) => e.stopPropagation()} onClick={async () => { onClose(); await fn(); }}>{label}</div>
  );
  const st = useStore.getState();
  const range = st.inPoint != null && st.outPoint != null ? { start: st.inPoint, duration: st.outPoint - st.inPoint } : { start: menu.time, duration: 3 };
  return (
    <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 200) }} onPointerDown={(e) => e.stopPropagation()}>
      {item(`✨ ${t('askAiHere')}…`, () => onAsk(menu.ctx))}
      <div className="menu-sep" />
      {item(t('addAdjustHere'), () => op('addAdjustmentLayer', { ...range, fx: { blur: 12 } }, 'adjustment layer'))}
      {item(t('addMarkerHere'), () => op('addMarker', { time: menu.time }, 'marker'))}
      {item(t('setInHere', { k: kb('markIn') }), () => useStore.setState({ inPoint: menu.time }))}
      {item(t('setOutHere', { k: kb('markOut') }), () => useStore.setState({ outPoint: menu.time }))}
    </div>
  );
}

const LaneHeader = memo(function LaneHeader({ lane, project }) {
  const t = useT();
  const kb = useShortcut();
  const [confirm, setConfirm] = useState(false);
  if (lane.kind === 'subs') {
    const en = project.subtitles.enabled;
    return (
      <div className="lane-head subs" style={{ height: lane.h }}>
        <span className="lane-tag">{t('subsLaneTag')}</span> <span>{t('subtitles')}</span>
        <button className={`icon-btn xs ${en ? '' : 'off'}`} title={t('show')} onClick={() => op('setSubtitlesEnabled', { enabled: !en }, 'toggle subtitles')}>{en ? <Eye size={12} /> : <EyeOff size={12} />}</button>
      </div>
    );
  }
  const tr = lane.track;
  const upd = (patch) => op('updateTrack', { id: tr.id, ...patch }, 'track');
  const n = project.clips.filter((c) => c.trackId === tr.id).length;
  const deletable = project.tracks.filter((x) => x.type === tr.type).length > 1; // the last video / audio track stays
  const remove = async () => {
    setConfirm(false);
    const r = await op('removeTrack', { id: tr.id }, 'delete track');
    if (r) useStore.getState().toast('info', t('trackDeleted', { name: tr.name, undo: kb('undo') }));
  };
  if (confirm) {
    return (
      <div className={`lane-head ${tr.type} confirm`} style={{ height: lane.h }}>
        <span className="lane-confirm-text"><b>{t('deleteTrackQ', { name: tr.name })}</b><small>{t('trackClipsN', { n })}</small></span>
        <div className="lane-btns">
          <button className="btn sm lane-del-yes" title={t('delete')} onClick={remove}><Trash2 size={12} /></button>
          <button className="icon-btn xs" title={t('cancel')} onClick={() => setConfirm(false)}><X size={12} /></button>
        </div>
      </div>
    );
  }
  return (
    <div className={`lane-head ${tr.type}`} style={{ height: lane.h }}>
      <span className="lane-tag">{tr.name}</span>
      <div className="lane-btns">
        {deletable && <button className="icon-btn xs lane-del" title={t('deleteTrack')} onClick={() => (n ? setConfirm(true) : remove())}><Trash2 size={12} /></button>}
        {tr.type === 'video' && <button className={`icon-btn xs ${tr.hidden ? 'off' : ''}`} title={t('toggleOutput')} onClick={() => upd({ hidden: !tr.hidden })}>{tr.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>}
        <button className={`icon-btn xs ${tr.muted ? 'off' : ''}`} title={t('mute')} onClick={() => upd({ muted: !tr.muted })}>{tr.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>
        {tr.type === 'audio' && <button className={`icon-btn xs ${tr.solo ? 'on' : ''}`} title="Solo" onClick={() => upd({ solo: !tr.solo })}><Headphones size={12} /></button>}
        {tr.type === 'audio' && <button className={`icon-btn xs ${tr.afx || tr.pan ? 'on' : ''}`} title={t('trackFxTitle')} onClick={() => useStore.setState({ selectedTrack: tr.id, selection: [], selectedCue: null })}><SlidersHorizontal size={12} /></button>}
        <button className={`icon-btn xs ${tr.locked ? 'on' : ''}`} title={t('lock')} onClick={() => upd({ locked: !tr.locked })}>{tr.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
      </div>
    </div>
  );
});

const TYPE_ICON = { video: Film, audio: Music, image: ImageIcon, html: Sparkles, color: Square, adjust: SlidersHorizontal };

const ClipView = memo(function ClipView({ clip: c, media, zoom, top, height, selected, flash, dx, dy, dragging, viewT0, viewT1, onDown, onMenu }) {
  const t = useT();
  const canvasRef = useRef(null);
  const left = c.start * zoom;
  const width = Math.max(3, c.duration * zoom);
  const Icon = TYPE_ICON[c.type] || Film;
  const showWave = (c.type === 'audio' || (c.type === 'video' && media?.hasAudio)) && media?.peaks;
  const peaks = showWave ? getPeaks(media) : null;
  const vx0 = Math.max(0, (viewT0 - c.start) * zoom);
  const vx1 = Math.min(width, (viewT1 - c.start) * zoom);
  const waveW = Math.max(1, Math.min(4096, Math.round(vx1 - vx0)));
  useEffect(() => {
    if (!showWave || !canvasRef.current) return;
    const cv = canvasRef.current;
    cv.width = waveW;
    cv.height = c.type === 'audio' ? height - 16 : 16;
    const s0 = c.in + (vx0 / zoom) * c.speed;
    const s1 = c.in + (vx1 / zoom) * c.speed;
    drawWave(cv, peaks, s0, s1, c.type === 'audio' ? 'rgba(190,240,215,0.75)' : 'rgba(210,222,245,0.55)');
  }, [peaks, c.in, c.speed, c.duration, zoom, waveW, vx0, vx1, height, showWave]);

  const fs = media?.filmstrip;
  let tiles = null;
  if (c.type === 'video' && fs) {
    const th = height - 18;
    const tw = Math.max(8, th * (fs.tileW / fs.tileH));
    const n0 = Math.floor(vx0 / tw), n1 = Math.min(Math.ceil(vx1 / tw), n0 + 120);
    const url = fileUrl(fs.path);
    tiles = [];
    for (let i = n0; i < n1; i++) {
      const x = i * tw;
      const src = c.in + (x / zoom) * c.speed;
      const idx = Math.max(0, Math.min(fs.count - 1, Math.floor(src / fs.interval)));
      tiles.push(<div key={i} className="tile" style={{ left: x, width: tw, height: th, backgroundImage: `url("${url}")`, backgroundSize: `${fs.cols * tw}px ${fs.rows * th}px`, backgroundPosition: `${-(idx % fs.cols) * tw}px ${-Math.floor(idx / fs.cols) * th}px` }} />);
    }
  } else if (c.type === 'image' && media?.thumb) {
    tiles = <div className="tile still" style={{ left: 0, width: '100%', height: height - 18, backgroundImage: `url("${fileUrl(media.thumb)}")` }} />;
  }
  const recent = flash && Date.now() - flash < 2000;
  const tr = c.transition;
  const ad = c.anim ? animDurations(c) : null;
  return (
    <div className={`clip clip-${c.type} ${selected ? 'sel' : ''} ${recent ? 'ai-flash' : ''} ${dragging ? 'dragging' : ''} ${c.muted ? 'muted' : ''} ${c.proposal ? 'proposal' : ''}`}
      style={{ left, top: top + 2, width, height: height - 4, transform: dx || dy ? `translate(${dx}px, ${dy}px)` : undefined, background: c.type === 'color' ? c.fill : undefined }}
      onPointerDown={(e) => onDown(e, c, 'body')} onContextMenu={(e) => onMenu(e, c)} title={`${c.name}\n${fmtTime(c.start)} → ${fmtTime(c.start + c.duration)}`}>
      <div className="clip-tiles">{tiles}</div>
      {showWave && <canvas ref={canvasRef} className={`clip-wave ${c.type}`} style={{ left: vx0, width: waveW }} />}
      <div className="clip-label">
        <Icon size={10} />
        <span className="clip-name">{c.name}</span>
        {c.speed !== 1 && <span className="badge">{c.speed}×</span>}
        {c.anim?.loop && <span className="badge" title={c.anim.loop.type}>∿</span>}
        {c.keyframes && <span className="badge">◆</span>}
        {(c.radius > 0 || c.border || c.shadow) && <span className="badge">▢</span>}
        {(c.color || c.chromaKey) && <span className="badge">fx</span>}
        {c.follow && <span className="badge" title="tracking">🎯</span>}
        {c.mask && <span className="badge" title="mask">◐</span>}
        {c.afx && <span className="badge" title={c.afx.map((x) => x.type).join(' → ')}>♪fx</span>}
        {c.proposal && <span className="badge prop" title={t('aiProposal')}><Star size={8} fill="currentColor" /> {t('ideaWord')}</span>}
      </div>
      {tr && <div className="clip-trans" style={{ width: Math.max(6, (tr.duration / 2) * zoom) }} title={`${tr.type} ${tr.duration}s`} />}
      {ad?.din > 0 && <div className="clip-anim in" style={{ width: Math.max(4, ad.din * zoom) }} title={c.anim.in.type} />}
      {ad?.dout > 0 && <div className="clip-anim out" style={{ width: Math.max(4, ad.dout * zoom) }} title={c.anim.out.type} />}
      {(c.fadeIn > 0) && <div className="clip-fade in" style={{ width: c.fadeIn * zoom }} />}
      {(c.fadeOut > 0) && <div className="clip-fade out" style={{ width: c.fadeOut * zoom }} />}
      <div className="clip-edge left" onPointerDown={(e) => onDown(e, c, 'left')} />
      <div className="clip-edge right" onPointerDown={(e) => onDown(e, c, 'right')} />
    </div>
  );
});

function ClipMenu({ menu, onClose, onAsk }) {
  const t = useT();
  const { clip } = menu;
  const sel = useStore.getState().selection;
  const ids = sel.includes(clip.id) ? sel : [clip.id];
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener('pointerdown', h);
    return () => window.removeEventListener('pointerdown', h);
  }, [onClose]);
  const item = (label, fn, danger) => (
    <div className={`menu-item ${danger ? 'danger' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={async () => { onClose(); await fn(); }}>{label}</div>
  );
  const visual = clip.type !== 'audio';
  return (
    <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 470) }} onPointerDown={(e) => e.stopPropagation()}>
      {item(`✨ ${t('askAiHere')}…`, () => onAsk(menu.ctx))}
      <div className="menu-sep" />
      {item(`${t('split')} (S)`, () => op('splitClip', { id: clip.id, time: r4(playhead.time) }, 'split'))}
      {item(t('duplicate'), () => op('duplicateClips', { ids }, 'duplicate'))}
      {clip.type === 'video' && item(t('detachAudio'), () => op('detachAudio', { id: clip.id }, 'detach audio'))}
      {visual && <div className="menu-sep" />}
      {visual && <div className="menu-label">{t('animation')}</div>}
      {visual && item(t('menuBrollPop'), () => op('setAnimation', { ids, in: 'pop', out: 'fade' }, 'b-roll pop'))}
      {visual && item(t('menuBrollSlide'), () => op('setAnimation', { ids, in: 'slide-blur-left', out: 'slide-blur-left' }, 'b-roll slide'))}
      {visual && item(t('menuLivingStill'), () => op('setAnimation', { ids, loop: 'living' }, 'living still'))}
      {visual && item(t('menuCloud'), () => op('setAnimation', { ids, loop: 'cloud' }, 'cloud'))}
      {visual && item(t('menuCard'), () => op('setFrameLook', { ids, radius: 36, shadow: { blur: 40, y: 14, opacity: 0.45 } }, 'card look'))}
      {visual && item(t('crossfade'), () => op('setTransition', { id: clip.id, type: 'fade', duration: 0.5 }, 'transition'))}
      {visual && <div className="menu-label">{t('layout')}</div>}
      {visual && item(t('layoutPipTr'), () => op('layoutClip', { id: clip.id, preset: 'pip-tr' }, 'layout pip'))}
      {visual && item(t('layoutBlurFill'), () => op('layoutClip', { id: clip.id, preset: 'blur-fill' }, 'layout blur fill'))}
      {clip.type === 'video' && item(t('freezeFrame'), () => call('edit:freezeFrame', { clipId: clip.id, time: Math.min(clip.start + clip.duration - 0.05, Math.max(clip.start, playhead.time)), duration: 1.5 }).catch((e) => useStore.getState().toast('error', e.message)))}
      {(clip.type === 'audio' || clip.type === 'video') && item(t('menuVoice'), () => op('updateClip', { id: clip.id, audioFx: clip.audioFx ? null : { preset: 'voice' } }, 'voice effect'))}
      {clip.type === 'video' && item(t('menuAdjustOver'), () => op('addAdjustmentLayer', { start: clip.start, duration: clip.duration, fx: { blur: 12 } }, 'adjustment layer'))}
      {clip.type === 'video' && item(t('trackFace'), () => call('track:start', { clipId: clip.id, time: Math.min(clip.start + clip.duration - 0.05, Math.max(clip.start, playhead.time)), face: true, name: t('faceName') }).then(() => useStore.getState().toast('info', t('trackingStarted'))).catch((e) => useStore.getState().toast('error', e.message)))}
      {clip.type === 'video' && item(t('cutoutPerson'), () => call('cutout:start', { clipId: clip.id }).then(() => useStore.getState().toast('info', t('cutoutStarted'))).catch((e) => useStore.getState().toast('error', e.message)))}
      {clip.type === 'audio' && item(t('beatMarkers'), () => call('edit:beatMarkers', { clipId: clip.id }).then((r) => useStore.getState().toast('success', t('beatMarkersDone', { n: r.markers, bpm: Math.round(r.bpm) }))).catch((e) => useStore.getState().toast('error', e.message)))}
      <div className="menu-sep" />
      {item(clip.muted ? t('unmute') : t('mute'), () => op('updateClip', { id: clip.id, muted: !clip.muted }, 'mute'))}
      {clip.mediaId && item(t('analyze'), () => call('media:analyze', { mediaId: clip.mediaId }))}
      <div className="menu-sep" />
      {item(`${t('delete')} (${t('delKey')})`, () => op('removeClips', { ids }, 'delete'), true)}
      {item(`${t('rippleDelete')} (${t('shiftDelKey')})`, () => op('removeClips', { ids, ripple: true }, 'ripple delete'), true)}
    </div>
  );
}
