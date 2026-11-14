import React, { useEffect } from 'react';
import { useStore } from './store.js';
import { call, op } from './api.js';
import { playhead } from './playhead.js';
import { useT, resolveLang } from './i18n.js';
import { bindingMap, comboFromEvent } from './shortcuts.js';
import { TopBar } from '../components/TopBar.jsx';
import { Welcome } from '../components/Welcome.jsx';
import { Dock } from '../components/layout/Dock.jsx';
import { ExportDialog, Toasts } from '../components/dialogs.jsx';
import { SettingsDialog } from '../components/Settings.jsx';
import { Tour } from '../components/Tour.jsx';
import { projectDuration, r4, fmtTime } from '@shared/timeline.js';

export function App() {
  const t = useT();
  // only open / closed: subscribing to the project itself re-rendered the whole app on every edit
  const hasProject = useStore((s) => !!s.project);
  const dialog = useStore((s) => s.dialog);
  const tour = useStore((s) => s.tour);
  const tourPending = useStore((s) => s.tourPending);
  // the guided tour carries on in the editor once a project is open (its panels need a moment to lay out)
  useEffect(() => {
    if (!hasProject || !tourPending) return undefined;
    const id = setTimeout(() => useStore.getState().startTour('editor'), 700);
    return () => clearTimeout(id);
  }, [hasProject, tourPending]);

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
      call('copilot:state').then((c) => useStore.setState({ copilot: c })).catch(() => {}); // the top bar needs to know if the built-in chat is usable
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

  // ---------------------------------------------------------------- keyboard shortcuts (Premiere-like, remappable)
  // The combo of the event is looked up in the bindings (defaults + Settings → Keyboard shortcuts), then the action
  // runs. An action returning false did not apply (e.g. copy with nothing selected): the key keeps its default.
  useEffect(() => {
    let shuttle = 0;
    const splitAtPlayhead = async (st, p) => {
      const tm = r4(playhead.time);
      if (st.selection.length) { for (const id of st.selection) await op('splitClip', { id, time: tm }, 'split'); } else op('splitAt', { time: tm }, 'split all');
    };
    // Q / W: ripple-trim the start / end of the clip(s) under the playhead to the playhead (Premiere)
    const rippleTrim = async (st, p, edge) => {
      const tm = r4(playhead.time);
      const targets = st.selection.length ? p.clips.filter((c) => st.selection.includes(c.id)) : p.clips.filter((c) => c.trackId === p.tracks[0]?.id);
      const hit = targets.filter((c) => c.start < tm - 1e-3 && c.start + c.duration > tm + 1e-3);
      for (const c of hit) await op('trimClip', { id: c.id, edge, time: tm, ripple: true }, edge === 'start' ? 'ripple trim start' : 'ripple trim end');
      if (edge === 'start' && hit.length) playhead.set(Math.min(...hit.map((c) => c.start)), 'ui');
    };
    const jumpEdit = (p, dir) => {
      const pts = [...new Set([0, ...p.clips.flatMap((c) => [c.start, c.start + c.duration])])].sort((a, b) => a - b);
      const cur = playhead.time;
      const next = dir > 0 ? pts.find((x) => x > cur + 1e-3) : [...pts].reverse().find((x) => x < cur - 1e-3);
      if (next !== undefined) playhead.set(next, 'ui');
    };
    const removeSel = (st, ripple) => {
      if (st.selectedCue) { op('removeSubtitleCues', { ids: [st.selectedCue] }, 'delete subtitle'); useStore.setState({ selectedCue: null }); return true; }
      if (!st.selection.length) return false;
      op('removeClips', { ids: st.selection, ripple }, ripple ? 'ripple delete' : 'delete');
      return true;
    };
    const ACTIONS = {
      playPause: () => { shuttle = 0; window.dispatchEvent(new Event('aicut:toggle-play')); },
      shuttleStop: () => { shuttle = 0; window.dispatchEvent(new CustomEvent('aicut:shuttle', { detail: 0 })); },
      shuttleFwd: () => { shuttle = shuttle >= 1 ? Math.min(8, shuttle * 2) : 1; window.dispatchEvent(new CustomEvent('aicut:shuttle', { detail: shuttle })); },
      shuttleBack: () => { shuttle = shuttle <= -1 ? Math.max(-8, shuttle * 2) : -1; window.dispatchEvent(new CustomEvent('aicut:shuttle', { detail: shuttle })); },
      prevFrame: (st, p) => playhead.set(Math.max(0, playhead.time - 1 / p.settings.fps), 'ui'),
      nextFrame: (st, p) => playhead.set(playhead.time + 1 / p.settings.fps, 'ui'),
      back1s: () => playhead.set(Math.max(0, playhead.time - 1), 'ui'),
      fwd1s: () => playhead.set(playhead.time + 1, 'ui'),
      prevEdit: (st, p) => jumpEdit(p, -1),
      nextEdit: (st, p) => jumpEdit(p, 1),
      goStart: () => playhead.set(0, 'ui'),
      goEnd: (st, p) => playhead.set(projectDuration(p), 'ui'),
      markIn: (st) => { const tm = r4(playhead.time); useStore.setState({ inPoint: tm, ...(st.outPoint != null && st.outPoint <= tm ? { outPoint: null } : {}) }); },
      markOut: (st) => { const tm = r4(playhead.time); useStore.setState({ outPoint: tm, ...(st.inPoint != null && st.inPoint >= tm ? { inPoint: null } : {}) }); },
      clearInOut: () => useStore.setState({ inPoint: null, outPoint: null }),
      split: (st, p) => splitAtPlayhead(st, p),
      rippleTrimStart: (st, p) => rippleTrim(st, p, 'start'),
      rippleTrimEnd: (st, p) => rippleTrim(st, p, 'end'),
      deleteSel: (st) => removeSel(st, false),
      rippleDelete: (st) => removeSel(st, true),
      duplicate: (st) => { if (!st.selection.length) return false; op('duplicateClips', { ids: st.selection }, 'duplicate'); return true; },
      copy: (st) => { if (!st.selection.length) return false; window.__aicutClipboard = st.selection.slice(); st.toast('info', t('copiedClips', { n: st.selection.length })); return true; },
      paste: async (st, p) => {
        const ids = (window.__aicutClipboard || []).filter((id) => p.clips.some((c) => c.id === id));
        if (!ids.length) return false;
        const minStart = Math.min(...ids.map((id) => p.clips.find((c) => c.id === id).start));
        for (const id of ids) { const c = p.clips.find((x) => x.id === id); await op('duplicateClips', { ids: [id], start: r4(playhead.time + (c.start - minStart)) }, 'paste'); }
        return true;
      },
      selectAll: (st, p) => st.select(p.clips.map((c) => c.id)),
      addMarker: () => op('addMarker', { time: r4(playhead.time) }, 'marker'),
      undo: () => call('project:undo'),
      redo: () => call('project:redo'),
      toolSelect: () => useStore.setState({ tool: 'select' }),
      toolRazor: () => useStore.setState({ tool: 'razor' }),
      toggleSnap: (st) => useStore.setState({ snapping: !st.snapping }),
      zoomIn: () => window.dispatchEvent(new Event('aicut:zoom-in')),
      zoomOut: () => window.dispatchEvent(new Event('aicut:zoom-out')),
      zoomFit: () => window.dispatchEvent(new Event('aicut:zoom-fit')),
      deselect: (st) => { st.select([]); useStore.setState({ selectedCue: null, selectedTrack: null, tool: 'select' }); window.dispatchEvent(new Event('aicut:escape')); },
      save: (st) => call('project:save').then(() => st.toast('success', t('saved'))),
      exportVideo: () => useStore.setState({ dialog: 'export' }),
      exportFrame: async (st, p) => { // Premiere: export frame
        const out = await call('dialog:saveFile', { title: t('exportFrame'), defaultPath: `${p.name} ${fmtTime(playhead.time).replace(/:/g, '-')}.png`, filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }] });
        if (out) call('render:frame', { time: playhead.time, width: p.settings.width, out }).then((f) => st.toast('success', `${t('exportFrame')} : ${f}`, { path: f })).catch((err) => st.toast('error', err.message));
      },
    };
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      const st = useStore.getState();
      const p = st.project;
      if (!p || st.dialog) return; // the settings / export dialogs keep their keys (shortcut recording, Escape…)
      const combo = comboFromEvent(e);
      const id = combo && bindingMap(st.settings?.shortcuts).get(combo);
      const run = id && ACTIONS[id];
      if (!run) return;
      // decide synchronously whether the key is ours (async actions such as paste resolve later)
      const r = run(st, p);
      if (r === false) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const lang = useStore((s) => s.lang);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  return (
    <div className="app">
      <TopBar />
      {!hasProject ? <Welcome /> : <Dock />}
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {tour && <Tour />}
      <Toasts />
    </div>
  );
}
