import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronsRight } from 'lucide-react';
import { useStore, WORKSPACES, localSet } from './store.js';
import { call, op } from './api.js';
import { playhead } from './playhead.js';
import { useT, resolveLang } from './i18n.js';
import { TopBar } from '../components/TopBar.jsx';
import { Welcome } from '../components/Welcome.jsx';
import { Player } from '../components/player/Player.jsx';
import { Timeline } from '../components/timeline/Timeline.jsx';
import { Inspector } from '../components/inspector/Inspector.jsx';
import { MediaPanel } from '../components/panels/MediaPanel.jsx';
import { AudioPanel } from '../components/panels/AudioPanel.jsx';
import { YouTubePanel } from '../components/panels/YouTubePanel.jsx';
import { MotionPanel } from '../components/panels/MotionPanel.jsx';
import { SubtitlesPanel } from '../components/panels/SubtitlesPanel.jsx';
import { AIPanel } from '../components/panels/AIPanel.jsx';
import { TranscriptPanel } from '../components/panels/TranscriptPanel.jsx';
import { AutoPanel } from '../components/panels/AutoPanel.jsx';
import { MemePanel } from '../components/panels/MemePanel.jsx';
import { ExportDialog, SettingsDialog, Toasts } from '../components/dialogs.jsx';
import { projectDuration, r4 } from '@shared/timeline.js';

const LEFT_TABS = [['media', 'project'], ['transcript', 'textTab'], ['motion', 'effects'], ['audio', 'sounds'], ['memes', 'memesTab'], ['subtitles', 'subtitles'], ['auto', 'autoTab'], ['youtube', 'web']];

/** Panel tab strip; tabs that do not fit are reachable from a "»" menu (Premiere-style). */
function PanelTabs({ tabs, active, onSelect, extra }) {
  const t = useT();
  const ref = useRef(null);
  const [hidden, setHidden] = useState([]);
  const [open, setOpen] = useState(false);
  const measure = () => {
    const box = ref.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const out = [];
    for (const el of box.querySelectorAll('.tab')) {
      const b = el.getBoundingClientRect();
      if (b.right > r.right + 1 || b.left < r.left - 1) out.push(el.dataset.id);
    }
    setHidden((h) => (h.join() === out.join() ? h : out));
  };
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [tabs.length]);
  const pick = (id) => {
    setOpen(false);
    onSelect(id);
    requestAnimationFrame(() => { ref.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); measure(); });
  };
  return (
    <div className="tabs-wrap">
      <div className="frame-tabs" ref={ref} onScroll={measure}>
        {tabs.map(([id, label]) => (
          <button key={id} data-id={id} className={`tab ${active === id ? 'on' : ''}`} onClick={() => pick(id)}>{t(label)}{extra?.(id)}</button>
        ))}
      </div>
      {hidden.length > 0 && (
        <div className="tabs-more">
          <button className={`icon-btn xs ${hidden.includes(active) ? 'on' : ''}`} title={t('moreTabs')} onClick={() => setOpen(!open)}><ChevronsRight size={13} /></button>
          {open && (
            <div className="tabs-menu" onMouseLeave={() => setOpen(false)}>
              {tabs.filter(([id]) => hidden.includes(id)).map(([id, label]) => (
                <div key={id} className={`menu-item ${active === id ? 'on' : ''}`} onClick={() => pick(id)}>{t(label)}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
const RIGHT_TABS = [['inspector', 'effectControls'], ['ai', 'ai']];

/** Pointer-drag helper for splitters. */
function drag(e, onMove) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const move = (ev) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function App() {
  const t = useT();
  const project = useStore((s) => s.project);
  const leftTab = useStore((s) => s.leftTab);
  const rightTab = useStore((s) => s.rightTab);
  const dialog = useStore((s) => s.dialog);
  const timelineHeight = useStore((s) => s.timelineHeight);
  const leftWidth = useStore((s) => s.leftWidth);
  const rightWidth = useStore((s) => s.rightWidth);
  const sessions = useStore((s) => s.sessions);

  // ---------------------------------------------------------------- bootstrap & events
  useEffect(() => {
    (async () => {
      const [info, settings, cur] = await Promise.all([call('app:info'), call('settings:get'), call('project:get')]);
      useStore.setState({ info, settings, lang: resolveLang(settings, info) });
      if (cur?.project) useStore.getState().setProject({ project: cur.project, file: cur.file, dir: cur.dir, meta: { canUndo: cur.canUndo, canRedo: cur.canRedo } });
      const v = document.createElement('video');
      call('ui:caps', { hevc: !!v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') }).catch(() => {});
      call('jobs:list').then((list) => list.forEach((j) => useStore.getState().setJob(j))).catch(() => {});
      call('ai:status').then((s) => useStore.setState({ sessions: s.mcp?.sessions || [] })).catch(() => {});
    })();
    const offs = [
      window.aicut.on('project', (p) => useStore.getState().setProject(p)),
      window.aicut.on('jobs', (j) => useStore.getState().setJob(j)),
      window.aicut.on('activity', (a) => useStore.getState().pushActivity(a)),
      window.aicut.on('sessions', (s) => useStore.setState({ sessions: s })),
      window.aicut.on('toast', (tt) => useStore.getState().toast(tt.level || 'info', tt.message, { from: tt.from, path: tt.path })),
      window.aicut.on('copilot', (c) => useStore.setState({ copilot: c })),
      window.aicut.on('settings', (s) => useStore.setState({ settings: s, lang: resolveLang(s, useStore.getState().info) })),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // ---------------------------------------------------------------- keyboard shortcuts (Premiere-like)
  useEffect(() => {
    let shuttle = 0;
    const onKey = async (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      const st = useStore.getState();
      const p = st.project;
      if (!p) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const fps = p.settings.fps;
      if (k === ' ') { e.preventDefault(); shuttle = 0; window.dispatchEvent(new Event('aicut:toggle-play')); return; }
      if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); call('project:undo'); return; }
      if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); call('project:redo'); return; }
      if (ctrl && k === 's') { e.preventDefault(); call('project:save').then(() => st.toast('success', t('saved'))); return; }
      if (ctrl && k === 'e') { e.preventDefault(); useStore.setState({ dialog: 'export' }); return; }
      if (ctrl && k === 'a') { e.preventDefault(); st.select(p.clips.map((c) => c.id)); return; }
      if (ctrl && k === 'd' && st.selection.length) { e.preventDefault(); op('duplicateClips', { ids: st.selection }, 'duplicate'); return; }
      if (ctrl && k === 'c' && st.selection.length) { window.__aicutClipboard = st.selection.slice(); st.toast('info', t('copiedClips', { n: st.selection.length })); return; }
      if (ctrl && k === 'v' && window.__aicutClipboard?.length) {
        const ids = window.__aicutClipboard.filter((id) => p.clips.some((c) => c.id === id));
        if (!ids.length) return;
        const minStart = Math.min(...ids.map((id) => p.clips.find((c) => c.id === id).start));
        for (const id of ids) { const c = p.clips.find((x) => x.id === id); await op('duplicateClips', { ids: [id], start: r4(playhead.time + (c.start - minStart)) }, 'paste'); }
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        if (st.selectedCue) { op('removeSubtitleCues', { ids: [st.selectedCue] }, 'delete subtitle'); useStore.setState({ selectedCue: null }); return; }
        if (st.selection.length) op('removeClips', { ids: st.selection, ripple: e.shiftKey }, e.shiftKey ? 'ripple delete' : 'delete');
        return;
      }
      if (ctrl) return;
      if (k === 's') {
        const tm = r4(playhead.time);
        if (st.selection.length) { for (const id of st.selection) await op('splitClip', { id, time: tm }, 'split'); }
        else op('splitAt', { time: tm }, 'split all');
        return;
      }
      // Q / W: ripple-trim the start / end of the clip(s) under the playhead to the playhead (Premiere)
      if (k === 'q' || k === 'w') {
        const tm = r4(playhead.time);
        const targets = st.selection.length ? p.clips.filter((c) => st.selection.includes(c.id)) : p.clips.filter((c) => c.trackId === p.tracks[0]?.id);
        const hit = targets.filter((c) => c.start < tm - 1e-3 && c.start + c.duration > tm + 1e-3);
        for (const c of hit) await op('trimClip', { id: c.id, edge: k === 'q' ? 'start' : 'end', time: tm, ripple: true }, k === 'q' ? 'ripple trim start' : 'ripple trim end');
        if (k === 'q' && hit.length) playhead.set(Math.min(...hit.map((c) => c.start)), 'ui');
        return;
      }
      // J / K / L shuttle
      if (k === 'k') { shuttle = 0; window.dispatchEvent(new CustomEvent('aicut:shuttle', { detail: 0 })); return; }
      if (k === 'l') { shuttle = shuttle >= 1 ? Math.min(8, shuttle * 2) : 1; window.dispatchEvent(new CustomEvent('aicut:shuttle', { detail: shuttle })); return; }
      if (k === 'j') { shuttle = shuttle <= -1 ? Math.max(-8, shuttle * 2) : -1; window.dispatchEvent(new CustomEvent('aicut:shuttle', { detail: shuttle })); return; }
      if (k === 'c') { useStore.setState({ tool: 'razor' }); return; }
      if (k === 'v') { useStore.setState({ tool: 'select' }); return; }
      if (k === 'm') { op('addMarker', { time: r4(playhead.time) }, 'marker'); return; }
      if (k === 'n') { useStore.setState({ snapping: !st.snapping }); return; }
      if (k === 'arrowleft') { e.preventDefault(); playhead.set(Math.max(0, playhead.time - (e.shiftKey ? 1 : 1 / fps)), 'ui'); return; }
      if (k === 'arrowright') { e.preventDefault(); playhead.set(playhead.time + (e.shiftKey ? 1 : 1 / fps), 'ui'); return; }
      if (k === 'home') { playhead.set(0, 'ui'); return; }
      if (k === 'end') { playhead.set(projectDuration(p), 'ui'); return; }
      if (k === 'arrowup' || k === 'arrowdown') {
        e.preventDefault();
        const pts = [...new Set([0, ...p.clips.flatMap((c) => [c.start, c.start + c.duration])])].sort((a, b) => a - b);
        const cur = playhead.time;
        const next = k === 'arrowdown' ? pts.find((x) => x > cur + 1e-3) : [...pts].reverse().find((x) => x < cur - 1e-3);
        if (next !== undefined) playhead.set(next, 'ui');
        return;
      }
      if (k === '+' || k === '=') { window.dispatchEvent(new Event('aicut:zoom-in')); return; }
      if (k === '-') { window.dispatchEvent(new Event('aicut:zoom-out')); return; }
      if (k === '\\') { window.dispatchEvent(new Event('aicut:zoom-fit')); return; }
      if (k === 'escape') { st.select([]); useStore.setState({ selectedCue: null, tool: 'select' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setTab = (side, id) => {
    const patch = side === 'left' ? { leftTab: id } : { rightTab: id };
    const st = { ...useStore.getState(), ...patch };
    const ws = WORKSPACES.find((w) => w.left === st.leftTab && w.right === st.rightTab);
    useStore.setState({ ...patch, workspace: ws ? ws.id : null });
  };

  const splitLeft = (e) => { const w0 = leftWidth; drag(e, (dx) => { const v = Math.max(240, Math.min(620, w0 + dx)); useStore.setState({ leftWidth: v }); localSet('aicut.leftWidth', v); }); };
  const splitRight = (e) => { const w0 = rightWidth; drag(e, (dx) => { const v = Math.max(260, Math.min(620, w0 - dx)); useStore.setState({ rightWidth: v }); localSet('aicut.rightWidth', v); }); };
  const splitTimeline = (e) => { const h0 = timelineHeight; drag(e, (dx, dy) => { const v = Math.max(170, Math.min(window.innerHeight - 260, h0 - dy)); useStore.setState({ timelineHeight: v }); localSet('aicut.timelineHeight', v); }); };
  const liveSessions = sessions.filter((x) => x.active !== false).length;
  const lang = useStore((s) => s.lang);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  return (
    <div className="app">
      <TopBar />
      {!project ? <Welcome /> : (
        <div className="workspace" style={{ gridTemplateRows: `minmax(0, 1fr) 4px ${timelineHeight}px` }}>
          <div className="upper" style={{ gridTemplateColumns: `${leftWidth}px 4px minmax(0, 1fr) 4px ${rightWidth}px` }}>
            <div className="frame">
              <PanelTabs tabs={LEFT_TABS} active={leftTab} onSelect={(id) => setTab('left', id)} />
              <div className="frame-body">
                {leftTab === 'media' && <MediaPanel />}
                {leftTab === 'audio' && <AudioPanel />}
                {leftTab === 'youtube' && <YouTubePanel />}
                {leftTab === 'motion' && <MotionPanel />}
                {leftTab === 'subtitles' && <SubtitlesPanel />}
                {leftTab === 'transcript' && <TranscriptPanel />}
                {leftTab === 'auto' && <AutoPanel />}
                {leftTab === 'memes' && <MemePanel />}
              </div>
            </div>
            <div className="splitter-v" onPointerDown={splitLeft} />
            <div className="frame"><Player /></div>
            <div className="splitter-v" onPointerDown={splitRight} />
            <div className="frame">
              <div className="frame-tabs">
                {RIGHT_TABS.map(([id, label]) => (
                  <button key={id} className={`tab ${rightTab === id ? 'on' : ''}`} onClick={() => setTab('right', id)}>
                    {t(label)}{id === 'ai' && liveSessions > 0 && <span className="dot-ok" />}
                  </button>
                ))}
              </div>
              <div className="frame-body">{rightTab === 'inspector' ? <Inspector /> : <AIPanel />}</div>
            </div>
          </div>
          <div className="splitter-h" onPointerDown={splitTimeline} />
          <div className="frame"><Timeline /></div>
        </div>
      )}
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      <Toasts />
    </div>
  );
}
