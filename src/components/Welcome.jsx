import React, { useEffect, useState } from 'react';
import { Plus, FolderOpen, Trash2, Bot, Film } from 'lucide-react';
import { useStore } from '../app/store.js';
import { call } from '../app/api.js';
import { useT, useLang } from '../app/i18n.js';

const FORMATS = [
  { id: '1080p', label: 'YouTube 16:9', sub: '1920 × 1080', r: [16, 9] },
  { id: 'vertical', label: 'Shorts · TikTok · Reels', sub: '1080 × 1920', r: [9, 16] },
  { id: 'square', label: 'fmtSquare', sub: '1080 × 1080', r: [1, 1] },
  { id: 'portrait', label: 'Instagram 4:5', sub: '1080 × 1350', r: [4, 5] },
  { id: '4k', label: '4K UHD', sub: '3840 × 2160', r: [16, 9] },
  { id: 'cinema', label: 'fmtCinema', sub: '1920 × 804', r: [2.39, 1] },
];

function Ratio({ r }) {
  const k = 22 / Math.max(r[0], r[1]);
  return <span className="ratio" style={{ width: r[0] * k, height: r[1] * k }} />;
}

export function Welcome() {
  const t = useT();
  const lang = useLang();
  const [recent, setRecent] = useState([]);
  const [typed, setName] = useState(null); // null = untouched → localized default name
  const name = typed ?? t('defaultProjectName');
  const [preset, setPreset] = useState('1080p');
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const refresh = () => call('project:recent').then(setRecent).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const create = async () => {
    setBusy(true);
    try { await call('project:create', { name: name.trim() || 'Untitled', preset, fps }); }
    catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(false);
  };
  // existing project → native confirmation (Recycle Bin / remove from list / cancel); missing one → just drop it
  const remove = async (r) => {
    try {
      const res = await call(r.exists ? 'project:delete' : 'project:forget', { path: r.path });
      if (res?.deleted) useStore.getState().toast('success', t('projectDeleted'));
    } catch (e) { useStore.getState().toast('error', e.message); }
    refresh();
  };
  const openFile = async () => {
    const [f] = await call('dialog:openFiles', { multi: false, filters: [{ name: 'AI.cut', extensions: ['aicut'] }] });
    if (f) call('project:open', { path: f }).catch((e) => useStore.getState().toast('error', e.message));
  };

  return (
    <div className="home">
      <div className="home-side">
        <button className="btn primary" onClick={() => document.getElementById('np-name')?.focus()}><Plus size={14} /> {t('newProject')}</button>
        <button className="btn" onClick={openFile}><FolderOpen size={14} /> {t('openProject')}</button>
        <div className="side-foot">
          <div className="row" style={{ marginBottom: 6, color: 'var(--text-2)' }}><Bot size={13} /> {t('homeAiTitle')}</div>
          {t('homeAiText')}
        </div>
      </div>
      <div className="home-main">
        <div>
          <div className="home-title">{t('homeTitle')}</div>
          <div className="home-sub">{t('appTagline')}</div>
        </div>
        <div className="new-project">
          <div className="field">
            <label className="lbl" htmlFor="np-name">{t('projectName')}</label>
            <input id="np-name" className="big-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') create(); }} autoFocus />
            <label className="lbl" style={{ marginTop: 8 }}>{t('fps')}</label>
            <div className="fps-row">
              {[24, 25, 30, 50, 60].map((v) => <button key={v} className={`chip ${fps === v ? 'on' : ''}`} onClick={() => setFps(v)}>{v}</button>)}
            </div>
            <button className="btn primary lg" style={{ marginTop: 14 }} disabled={busy} onClick={create}><Film size={14} /> {t('create')}</button>
          </div>
          <div className="field">
            <label className="lbl">{t('format')}</label>
            <div className="format-grid">
              {FORMATS.map((f) => (
                <button key={f.id} className={`format-btn ${preset === f.id ? 'on' : ''}`} onClick={() => setPreset(f.id)}>
                  <Ratio r={f.r} />
                  <span>{t(f.label)}</span>
                  <span className="dim small">{f.sub}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="cat-title">{t('recentProjects')}</div>
          {!recent.length ? <div className="dim">{t('noRecent')}</div> : (
            <table className="recent-table">
              <thead><tr><th>{t('name')}</th><th>{t('modified')}</th><th>{t('location')}</th><th /></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.path} className={`row-link ${r.exists ? '' : 'missing'}`} onClick={() => r.exists && call('project:open', { path: r.path }).catch((e) => useStore.getState().toast('error', e.message))}>
                    <td>{r.name}</td>
                    <td className="path">{new Date(r.openedAt).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US')}</td>
                    <td className="path" title={r.path}>{r.path}</td>
                    <td style={{ width: 30 }}><button className="icon-btn xs" title={r.exists ? t('deleteProject') : t('forget')} onClick={(e) => { e.stopPropagation(); remove(r); }}><Trash2 size={12} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="home-tip">{t('homeTip')}</div>
      </div>
    </div>
  );
}
