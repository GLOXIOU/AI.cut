import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward, StepBack, StepForward, Volume2, VolumeX, Maximize2, Camera, Repeat, Grid3x3, MonitorUp, MonitorX } from 'lucide-react';
import { PlayerEngine } from './engine.js';
import { useStore } from '../../app/store.js';
import { playhead } from '../../app/playhead.js';
import { call, op } from '../../app/api.js';
import { fmtTime } from '@shared/timeline.js';
import { useT } from '../../app/i18n.js';

export let engineRef = { current: null };

export function Player() {
  const t = useT();
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

  useEffect(() => {
    const eng = new PlayerEngine(hostRef.current);
    engineRef.current = eng;
    eng.onTime = (tm) => { playhead.set(tm, 'player'); };
    eng.onEnded = () => { setPlaying(false); setRate(1); playhead.setPlaying(false); };
    eng.onFit = () => setFitTick((x) => x + 1);
    eng.onHtmlError = (clipId, msg) => console.warn('[motion]', clipId, msg);
    const unsub = playhead.sub((tm, src) => {
      if (src !== 'player' && src !== 'state') eng.seek(tm);
      setTime(tm);
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
      call('ui:state', { playhead: playhead.time, selection: useStore.getState().selection, playing: playhead.playing }).catch(() => {});
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
      <div className="frame-tabs">
        <span className="frame-title">{t('program')} : {project?.name || ''}</span>
        <span className="spacer" />
        {playing && rate !== 1 && <span className="frame-title" style={{ color: 'var(--accent-hi)' }}>{rate > 0 ? '▶' : '◀'} ×{Math.abs(rate)}</span>}
      </div>
      <div className="player-host" ref={hostRef} onDoubleClick={() => hostRef.current?.requestFullscreen?.()}>
        {!project?.clips.length && <div className="player-empty">{t('emptyTimeline')}</div>}
        {guides && project && <SafeGuides engine={engineRef.current} />}
        {gizmo && <Gizmo g={gizmo} />}
      </div>
      <div className="player-controls">
        <div className="pc-left">
          <span className="timecode">{fmtTime(time, fps)}</span>
        </div>
        <div className="pc-center">
          <button className="icon-btn" title={`${t('toStart')} (Home)`} onClick={() => playhead.set(0, 'ui')}><SkipBack size={15} /></button>
          <button className="icon-btn" title={`${t('prevFrame')} (←)`} onClick={() => step(-1 / fps)}><StepBack size={15} /></button>
          <button className="play-btn" title={`${t('play')} (Espace · J K L)`} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
          <button className="icon-btn" title={`${t('nextFrame')} (→)`} onClick={() => step(1 / fps)}><StepForward size={15} /></button>
          <button className="icon-btn" title={`${t('toEnd')} (End)`} onClick={() => playhead.set(dur, 'ui')}><SkipForward size={15} /></button>
        </div>
        <div className="pc-right">
          <button className={`icon-btn ${loop ? 'on' : ''}`} title={t('loop')} onClick={() => setLoop(!loop)}><Repeat size={14} /></button>
          <button className={`icon-btn ${guides ? 'on' : ''}`} title={t('safeMargins')} onClick={() => setGuides(!guides)}><Grid3x3 size={14} /></button>
          <button className="icon-btn" title={t('snapshot')} onClick={snapshot}><Camera size={14} /></button>
          <button className="icon-btn" title={t('sound')} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
          <button className={`icon-btn ${monitor.open ? 'on' : ''}`} title={monitor.open ? t('monitorClose') : t('monitorOpen')} onClick={toggleMonitor}>{monitor.open ? <MonitorX size={14} /> : <MonitorUp size={14} />}</button>
          <button className="icon-btn" title={t('fullscreen')} onClick={() => hostRef.current?.requestFullscreen?.()}><Maximize2 size={14} /></button>
          <span className="timecode dim" style={{ marginLeft: 6 }}>{fmtTime(dur, fps)}</span>
        </div>
      </div>
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
