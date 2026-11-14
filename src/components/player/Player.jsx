import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward, StepBack, StepForward, Volume2, VolumeX, Maximize2, Camera, Repeat, Grid3x3, MonitorUp, MonitorX, Crosshair, Lightbulb } from 'lucide-react';
import { PlayerEngine } from './engine.js';
import { useStore } from '../../app/store.js';
import { playhead } from '../../app/playhead.js';
import { call, op } from '../../app/api.js';
import { fmtTime } from '@shared/timeline.js';
import { maskAt } from '@shared/fx.js';
import { followPointAt } from '@shared/follow.js';
import { useT } from '../../app/i18n.js';
import { useShortcut } from '../../app/shortcuts.js';

export let engineRef = { current: null };

export function Player() {
  const t = useT();
  const kb = useShortcut();
  const withKey = (label, ...ids) => { const k = ids.map(kb).filter(Boolean).join(' · '); return k ? `${label} (${k})` : label; };
  const hostRef = useRef(null);
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [guides, setGuides] = useState(false);
  const [gizmo, setGizmo] = useState(null);
  const [fitTick, setFitTick] = useState(0);
  const [monitor, setMonitor] = useState({ open: false });
  const [trackMode, setTrackMode] = useState(null); // { clipId } while drawing a box to track
  const hideProposals = useStore((s) => s.hideProposals);

  useEffect(() => {
    const eng = new PlayerEngine(hostRef.current);
    engineRef.current = eng;
    eng.onTime = (tm) => { playhead.set(tm, 'player'); };
    eng.onEnded = () => { setPlaying(false); setRate(1); playhead.setPlaying(false); };
    eng.onFit = () => setFitTick((x) => x + 1);
    eng.onHtmlError = (clipId, msg) => console.warn('[motion]', clipId, msg);
    const unsub = playhead.sub((tm, src) => {
      if (src !== 'player' && src !== 'state') eng.seek(tm);
      // playback ticks ('player') do not re-render React: the overlays that need the time (transform gizmo, mask,
      // tracking paths) are hidden while playing and the timecode updates itself; seeks, steps and pause do
      if (src !== 'player') setTime(tm);
    });
    return () => { unsub(); eng.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setProject(project); }, [project]);

  const start = useCallback((r = 1) => {
    const eng = engineRef.current;
    if (!eng) return;
    if (!eng.playing) eng.seek(playhead.time);
    eng.play(r);
    setPlaying(true); setRate(r); playhead.setPlaying(true);
  }, []);
  const stop = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.pause(); eng.rate = 1;
    setPlaying(false); setRate(1); playhead.setPlaying(false);
  }, []);
  const toggle = useCallback(() => { if (engineRef.current?.playing) stop(); else start(1); }, [start, stop]);

  useEffect(() => {
    const onToggle = () => toggle();
    const onShuttle = (e) => { const r = e.detail; if (!r) stop(); else start(r); };
    window.addEventListener('aicut:toggle-play', onToggle);
    window.addEventListener('aicut:shuttle', onShuttle);
    const off = window.aicut.on('player', (cmd) => {
      const eng = engineRef.current;
      if (!eng) return;
      if (cmd.action === 'seek' && cmd.time != null) playhead.set(cmd.time, 'ai');
      if (cmd.action === 'play' && !eng.playing) start(1);
      if (cmd.action === 'pause' && eng.playing) stop();
      if (cmd.action === 'select' && cmd.clipIds) useStore.getState().select(cmd.clipIds);
      if (cmd.action === 'zoom-fit') window.dispatchEvent(new Event('aicut:zoom-fit'));
      if (cmd.action === 'toggle') toggle(); // Space pressed in the external monitor window
      if (cmd.action === 'key' && cmd.key) window.dispatchEvent(new KeyboardEvent('keydown', { key: cmd.key, shiftKey: !!cmd.shift }));
    });
    return () => { window.removeEventListener('aicut:toggle-play', onToggle); window.removeEventListener('aicut:shuttle', onShuttle); off(); };
  }, [toggle, start, stop]);

  // report UI state to main (for the AI: "here", "this clip")
  useEffect(() => {
    const id = setInterval(() => {
      const st = useStore.getState();
      call('ui:state', { playhead: playhead.time, selection: st.selection, playing: playhead.playing, inPoint: st.inPoint, outPoint: st.outPoint }).catch(() => {});
    }, 700);
    return () => clearInterval(id);
  }, []);

  // ---------------------------------------------------------------- external program monitor (second screen)
  useEffect(() => {
    call('monitor:status').then(setMonitor).catch(() => {});
    const offState = window.aicut.on('monitor:state', (st) => setMonitor(st));
    // transport → monitor: every seek / play / pause at once, and the running time twice a second while playing
    let last = 0, raf = 0, lastPlaying = null, lastRate = 1;
    const push = () => {
      raf = 0;
      call('monitor:sync', { time: playhead.time, playing: playhead.playing, rate: engineRef.current?.rate || 1, sentAt: Date.now() }).catch(() => {});
      last = performance.now();
    };
    const off = playhead.sub((tm, src) => {
      if (!monitorOpen.current) return;
      const eng = engineRef.current;
      const rate = eng?.rate || 1;
      const changed = playhead.playing !== lastPlaying || rate !== lastRate;
      lastPlaying = playhead.playing; lastRate = rate;
      if (playhead.playing && src === 'player' && !changed && performance.now() - last < 500) return;
      if (!raf) raf = requestAnimationFrame(push);
    });
    return () => { offState(); off(); if (raf) cancelAnimationFrame(raf); };
  }, []);
  const monitorOpen = useRef(false);
  useEffect(() => {
    monitorOpen.current = !!monitor.open;
    if (monitor.open) call('monitor:sync', { time: playhead.time, playing: playhead.playing, rate: engineRef.current?.rate || 1, sentAt: Date.now() }).catch(() => {});
  }, [monitor.open, monitor.ready]);
  const toggleMonitor = async () => {
    try { setMonitor(await call('monitor:toggle')); } catch (e) { useStore.getState().toast('error', e.message); }
  };

  useEffect(() => { engineRef.current?.setVolume(muted ? 0 : 1); }, [muted]);
  useEffect(() => {
    const on = (e) => { stop(); setTrackMode({ clipId: e.detail?.clipId, purpose: e.detail?.purpose || 'track', fix: e.detail?.fix || null }); };
    const off = () => setTrackMode(null);
    window.addEventListener('aicut:track-mode', on);
    window.addEventListener('aicut:escape', off);
    return () => { window.removeEventListener('aicut:track-mode', on); window.removeEventListener('aicut:escape', off); };
  }, [stop]);
  /** Video clip to track: the selected one, else the topmost video clip under the playhead. */
  const trackTarget = () => {
    const p = useStore.getState().project;
    const sel = p?.clips.find((c) => c.id === useStore.getState().selection[0] && c.type === 'video');
    if (sel) return sel;
    const vids = p?.tracks.filter((x) => x.type === 'video').map((x) => x.id) || [];
    const under = (p?.clips || []).filter((c) => c.type === 'video' && c.start <= playhead.time && c.start + c.duration > playhead.time);
    return under.sort((a, b) => vids.indexOf(b.trackId) - vids.indexOf(a.trackId))[0] || null;
  };
  useEffect(() => { if (engineRef.current) engineRef.current.loopPlayback = loop; }, [loop]);

  // gizmo for the selected visual clip
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || selection.length !== 1 || playing) { setGizmo(null); return; }
    setGizmo(eng.geometryOf(selection[0]));
  }, [selection, time, project, playing, fitTick]);

  const fps = project?.settings.fps || 30;
  const dur = project ? Math.max(0, ...project.clips.map((c) => c.start + c.duration), 0) : 0;
  const step = (d) => { playhead.set(Math.max(0, Math.min(dur, playhead.time + d)), 'ui'); };

  const snapshot = async () => {
    try {
      const img = await call('render:frame', { time: playhead.time, width: 1920 });
      useStore.getState().toast('success', `${t('snapshot')} : ${img}`, { path: img });
    } catch (e) { useStore.getState().toast('error', e.message); }
  };

  return (
    <div className="player">
      {/* the "Program : name" title is the dock tab; only the J/K/L shuttle speed shows here */}
      {playing && rate !== 1 && <span className="shuttle-badge">{rate > 0 ? '▶' : '◀'} ×{Math.abs(rate)}</span>}
      <div className="player-host" ref={hostRef} onDoubleClick={() => hostRef.current?.requestFullscreen?.()}>
        {!project?.clips.length && <div className="player-empty">{t('emptyTimeline')}</div>}
        {guides && project && <SafeGuides engine={engineRef.current} />}
        {gizmo && !trackMode && <Gizmo g={gizmo} />}
        {!trackMode && !playing && selection.length === 1 && <MaskGizmo clipId={selection[0]} time={time} fitTick={fitTick} />}
        {trackMode && <TrackBoxTool clipId={trackMode.clipId} purpose={trackMode.purpose} fix={trackMode.fix} onDone={() => setTrackMode(null)} />}
        {!playing && project && selection.length === 1 && <TrackPaths project={project} clipId={selection[0]} time={time} fitTick={fitTick} />}
      </div>
      <div className="player-controls">
        <div className="pc-left">
          <Timecode fps={fps} />
        </div>
        <div className="pc-center">
          <button className="icon-btn pc-sm" title={withKey(t('toStart'), 'goStart')} onClick={() => playhead.set(0, 'ui')}><SkipBack size={15} /></button>
          <button className="icon-btn" title={withKey(t('prevFrame'), 'prevFrame')} onClick={() => step(-1 / fps)}><StepBack size={15} /></button>
          <button className="play-btn" title={withKey(t('play'), 'playPause', 'shuttleBack', 'shuttleStop', 'shuttleFwd')} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
          <button className="icon-btn" title={withKey(t('nextFrame'), 'nextFrame')} onClick={() => step(1 / fps)}><StepForward size={15} /></button>
          <button className="icon-btn pc-sm" title={withKey(t('toEnd'), 'goEnd')} onClick={() => playhead.set(dur, 'ui')}><SkipForward size={15} /></button>
        </div>
        <div className="pc-right">
          <button className={`icon-btn pc-sm ${loop ? 'on' : ''}`} title={t('loop')} onClick={() => setLoop(!loop)}><Repeat size={14} /></button>
          <button className={`icon-btn pc-md ${guides ? 'on' : ''}`} title={t('safeMargins')} onClick={() => setGuides(!guides)}><Grid3x3 size={14} /></button>
          <button className={`icon-btn pc-sm ${trackMode ? 'on' : ''}`} title={t('trackObjectHint')} onClick={() => { if (trackMode) { setTrackMode(null); return; } const c = trackTarget(); if (!c) { useStore.getState().toast('warning', t('noVideoToTrack')); return; } stop(); setTrackMode({ clipId: c.id }); }}><Crosshair size={14} /></button>
          {(project?.proposals || []).some((x) => x.status === 'pending' || x.status === 'recording') && (
            <button className={`icon-btn pc-sm ${hideProposals ? '' : 'on'}`} title={hideProposals ? t('showProposals') : t('hideProposals')} onClick={() => { const v = !hideProposals; useStore.setState({ hideProposals: v }); engineRef.current?.setHideProposals(v); }}><Lightbulb size={14} /></button>
          )}
          <button className="icon-btn pc-md" title={t('snapshot')} onClick={snapshot}><Camera size={14} /></button>
          <button className="icon-btn" title={t('sound')} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
          <button className={`icon-btn pc-md ${monitor.open ? 'on' : ''}`} title={monitor.open ? t('monitorClose') : t('monitorOpen')} onClick={toggleMonitor}>{monitor.open ? <MonitorX size={14} /> : <MonitorUp size={14} />}</button>
          <button className="icon-btn pc-sm" title={t('fullscreen')} onClick={() => hostRef.current?.requestFullscreen?.()}><Maximize2 size={14} /></button>
          <span className="timecode dim pc-lg" style={{ marginLeft: 6 }}>{fmtTime(dur, fps)}</span>
        </div>
      </div>
    </div>
  );
}

/** Draw a box on the picture → tracking job for that region of the clip. */
/** Program timecode, written straight into the DOM on every playhead move (no React render per frame). */
function Timecode({ fps }) {
  const ref = useRef(null);
  useEffect(() => {
    let last = '';
    const upd = (tm) => {
      const s = fmtTime(tm, fps);
      if (s !== last && ref.current) { ref.current.textContent = s; last = s; }
    };
    upd(playhead.time);
    return playhead.sub(upd);
  }, [fps]);
  return <span className="timecode" ref={ref} />;
}

function TrackBoxTool({ clipId, purpose = 'track', fix = null, onDone }) {
  const t = useT();
  const [box, setBox] = useState(null);
  const ref = useRef(null);
  const [face, setFace] = useState(false);
  const start = (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = ref.current.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    let b = null;
    const move = (ev) => { b = { x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top }; setBox(b); };
    const up = async () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setBox(null);
      if (!b || Math.abs(b.x1 - b.x0) < 6 || Math.abs(b.y1 - b.y0) < 6) return;
      const eng = engineRef.current;
      const g = eng?.geometryOf(clipId);
      if (!g) { useStore.getState().toast('warning', t('clipNotVisible')); onDone(); return; }
      const k = eng.scale, o = eng.offset;
      const hostR = ref.current.getBoundingClientRect(), stageL = hostR.left + o.x, stageT = hostR.top + o.y;
      const toStage = (cx, cy) => [(cx + r.left - stageL) / k, (cy + r.top - stageT) / k];
      const [ax, ay] = toStage(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
      const [bx, by] = toStage(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
      let u0 = (ax - (g.cx - g.w / 2)) / g.w, u1 = (bx - (g.cx - g.w / 2)) / g.w;
      let v0 = (ay - (g.cy - g.h / 2)) / g.h, v1 = (by - (g.cy - g.h / 2)) / g.h;
      if (g.clip.flipH) [u0, u1] = [1 - u1, 1 - u0];
      if (g.clip.flipV) [v0, v1] = [1 - v1, 1 - v0];
      const clamp01 = (v) => Math.min(1, Math.max(0, v));
      u0 = clamp01(u0); u1 = clamp01(u1); v0 = clamp01(v0); v1 = clamp01(v1);
      if (u1 - u0 < 0.005 || v1 - v0 < 0.005) { onDone(); return; }
      const box = { x: u0, y: v0, w: u1 - u0, h: v1 - v0 };
      try {
        if (fix) {
          await call('track:start', { clipId, time: playhead.time, box, fix });
          useStore.getState().toast('info', t('trackingFixed'));
        } else if (purpose === 'cutout') {
          await call('cutout:start', { clipId, time: playhead.time, box });
          useStore.getState().toast('info', t('cutoutStarted'));
        } else {
          await call('track:start', { clipId, time: playhead.time, box, face, name: face ? t('faceName') : t('objectName') });
          useStore.getState().toast('info', t('trackingStarted'));
        }
      } catch (err) { useStore.getState().toast('error', err.message); }
      onDone();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="track-tool" ref={ref} onPointerDown={start}>
      <div className="track-tool-hint" onPointerDown={(e) => e.stopPropagation()}>
        {fix ? t('drawBoxFix') : purpose === 'cutout' ? t('drawBoxCutout') : t('drawBoxHint')}
        {!fix && purpose !== 'cutout' && <label className="tt-face"><input type="checkbox" checked={face} onChange={(e) => setFace(e.target.checked)} /> {t('itsAFace')}</label>}
        <button className="btn sm" onClick={onDone}>{t('cancel')}</button>
      </div>
      {box && <div className="track-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
    </div>
  );
}

/** Trajectory of the trackings of the selected clip (or of the tracking it follows) + the tracked box now. */
function TrackPaths({ project, clipId, time, fitTick }) {
  const eng = engineRef.current;
  const clip = project.clips.find((c) => c.id === clipId);
  const W = project.settings.width, H = project.settings.height;
  const paths = useMemo(() => {
    if (!clip) return [];
    const list = clip.type === 'video' ? (project.trackings || []).filter((x) => x.mediaId === clip.mediaId).map((x) => ({ tr: x, target: clip.id }))
      : clip.follow ? (project.trackings || []).filter((x) => x.id === clip.follow.tracking).map((x) => ({ tr: x, target: clip.follow.clip })) : [];
    return list.map(({ tr, target }) => {
      const tc = project.clips.find((c) => c.id === target) || project.clips.find((c) => c.mediaId === tr.mediaId);
      if (!tc) return null;
      const n = Math.min(600, Math.max(2, Math.ceil(tc.duration * 10)));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const p = followPointAt(project, { tracking: tr.id, clip: tc.id }, tc.start + (tc.duration * i) / n, W, H);
        if (p && !p.outside) pts.push([p.x, p.y]);
      }
      return { id: tr.id, name: tr.name, kind: tr.kind, target: tc.id, pts, anchors: (tr.anchors || []).map((a) => a.t) };
    }).filter(Boolean);
  }, [project, clipId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!eng || !paths.length) return null;
  const k = eng.scale, o = eng.offset;
  return (
    <svg className="track-paths" data-tick={fitTick} style={{ left: o.x, top: o.y, width: W * k, height: H * k }} viewBox={`0 0 ${W} ${H}`}>
      {paths.map((p) => {
        const now = followPointAt(project, { tracking: p.id, clip: p.target }, time, W, H);
        return (
          <g key={p.id}>
            <polyline points={p.pts.map((q) => q.join(',')).join(' ')} fill="none" stroke={p.kind === 'face' ? '#e05a9a' : '#f5c542'} strokeWidth={3 / k} strokeOpacity="0.8" strokeDasharray={`${8 / k} ${5 / k}`} />
            {now && !now.outside && <rect x={now.x - now.bw / 2} y={now.y - now.bh / 2} width={now.bw} height={now.bh} fill="none" stroke={p.kind === 'face' ? '#e05a9a' : '#f5c542'} strokeWidth={2 / k} />}
            {now && !now.outside && <text x={now.x - now.bw / 2} y={now.y - now.bh / 2 - 8 / k} fontSize={14 / k} fill="#fff" stroke="#000" strokeWidth={3 / k} paintOrder="stroke">{p.name}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** Move / resize the mask of a selected adjustment layer on the picture. */
function MaskGizmo({ clipId, time, fitTick }) {
  const eng = engineRef.current;
  const c = eng?.project?.clips.find((x) => x.id === clipId);
  if (!eng || !c || c.type !== 'adjust' || !c.mask) return null;
  const local = time - c.start;
  if (local < 0 || local > c.duration) return null;
  const P = eng.project.settings;
  const mk = maskAt(eng.effective(c), local, P.width, P.height);
  const k = eng.scale, o = eng.offset;
  const follow = !!c.mask.follow;
  const onDown = (e, mode) => {
    if (follow && mode === 'move') return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const base = { ...c.mask };
    let patch = null;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / k / P.width, dy = (ev.clientY - sy) / k / P.height;
      patch = mode === 'move' ? { ...base, cx: base.cx + dx, cy: base.cy + dy } : { ...base, w: Math.max(0.01, base.w + dx * 2), h: Math.max(0.01, base.h + dy * 2) };
      delete patch._path;
      eng.setOverride(clipId, { mask: { ...patch, ...(base._path ? { _path: base._path } : {}) } });
    };
    const up = async () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (patch) await op('updateClip', { id: clipId, mask: patch }, mode === 'move' ? 'move mask' : 'resize mask');
      eng.setOverride(clipId, null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={`mask-gizmo ${mk.shape} ${follow ? 'follow' : ''}`} data-tick={fitTick}
      style={{ left: o.x + (mk.cx - mk.w / 2) * k, top: o.y + (mk.cy - mk.h / 2) * k, width: mk.w * k, height: mk.h * k }} onPointerDown={(e) => onDown(e, 'move')}>
      <div className="gz-handle br" onPointerDown={(e) => onDown(e, 'size')} />
    </div>
  );
}

function SafeGuides({ engine }) {
  if (!engine) return null;
  const p = engine.project;
  const k = engine.scale, o = engine.offset;
  const W = p.settings.width * k, H = p.settings.height * k;
  return (
    <div className="safe-guides" style={{ left: o.x, top: o.y, width: W, height: H }}>
      <div className="sg-action" />
      <div className="sg-title" />
      <div className="sg-cross-h" />
      <div className="sg-cross-v" />
    </div>
  );
}

/** Move / scale handles for the selected clip, directly on the video. */
function Gizmo({ g }) {
  const k = g.scaleFactor, o = g.offset;
  const c = g.clip;
  const left = o.x + (g.cx - g.w / 2) * k, top = o.y + (g.cy - g.h / 2) * k;
  const dragRef = useRef(null);

  const onDown = (e, mode) => {
    e.stopPropagation();
    e.preventDefault();
    const eng = engineRef.current;
    const startX = e.clientX, startY = e.clientY;
    const base = { x: c.x || 0, y: c.y || 0, scale: c.scale ?? 1 };
    const cx = o.x + g.cx * k, cy = o.y + g.cy * k;
    const d0 = Math.hypot(startX - cx, startY - cy) || 1;
    dragRef.current = { patch: null };
    const move = (ev) => {
      let patch;
      if (mode === 'move') {
        let nx = base.x + (ev.clientX - startX) / k, ny = base.y + (ev.clientY - startY) / k;
        if (!ev.shiftKey) { if (Math.abs(nx) < 12) nx = 0; if (Math.abs(ny) < 12) ny = 0; }
        patch = { x: Math.round(nx), y: Math.round(ny) };
      } else {
        const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
        patch = { scale: Math.max(0.02, Math.round(base.scale * (d / d0) * 1000) / 1000) };
      }
      dragRef.current.patch = patch;
      eng?.setOverride(c.id, patch);
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const patch = dragRef.current?.patch;
      if (patch) await op('updateClip', { id: c.id, ...patch }, mode === 'move' ? 'move on canvas' : 'scale on canvas');
      eng?.setOverride(c.id, null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="gizmo" style={{ left, top, width: g.w * k, height: g.h * k, transform: `rotate(${g.rotation}deg)` }} onPointerDown={(e) => onDown(e, 'move')}>
      {['tl', 'tr', 'bl', 'br'].map((h) => <div key={h} className={`gz-handle ${h}`} onPointerDown={(e) => onDown(e, 'scale')} />)}
    </div>
  );
}
