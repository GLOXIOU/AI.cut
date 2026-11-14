import React, { useEffect, useRef, useState } from 'react';
import { Plus, FolderOpen, Trash2, Film, ArrowRight, Compass } from 'lucide-react';
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
const FPS = [24, 25, 30, 50, 60];

function Ratio({ r }) {
  const k = 22 / Math.max(r[0], r[1]);
  return <span className="ratio" style={{ width: r[0] * k, height: r[1] * k }} />;
}

export function Welcome() {
  const t = useT();
  const lang = useLang();
  const version = useStore((s) => s.info?.version);
  const [recent, setRecent] = useState([]);
  const [typed, setName] = useState(null); // null = untouched → localized default name
  const name = typed ?? t('defaultProjectName');
  const [preset, setPreset] = useState('1080p');
  const [fps, setFps] = useState(60);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const nameRef = useRef(null);
  const cardRef = useRef(null);
  const refresh = () => call('project:recent').then(setRecent).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const create = async () => {
    setBusy(true);
    try { await call('project:create', { name: name.trim() || 'Untitled', preset, fps }); }
    catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(false);
  };
  // "New project" brings the creation card into view and briefly outlines it
  const focusNew = () => {
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    nameRef.current?.focus();
    nameRef.current?.select();
    setFlash(false);
    requestAnimationFrame(() => setFlash(true));
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
  const fmt = FORMATS.find((f) => f.id === preset);
  const locale = lang === 'fr' ? 'fr-FR' : 'en-US';

  return (
    <div className="home">
      <aside className="home-side">
        <button className="home-action primary" onClick={focusNew}>
          <span className="ha-ico"><Plus size={16} strokeWidth={2.2} /></span>
          {t('newProject')}
        </button>
        <button className="home-action open" onClick={openFile}>
          <span className="ha-ico"><FolderOpen size={15} /></span>
          {t('openProject')}
        </button>
        <button className="home-action discover" onClick={() => useStore.getState().startTour('home')}>
          <span className="ha-ico"><Compass size={15} /></span>
          {t('discover')}
        </button>
        {version && <div className="home-version">AI.cut {version}</div>}
      </aside>

      <div className="home-main">
        <div className="home-inner">
          <h1 className="home-title">{t('homeTitle')}</h1>

          <section ref={cardRef} className={`np-card ${flash ? 'flash' : ''}`} onAnimationEnd={() => setFlash(false)}>
            <div className="np-body">
              <div className="np-fields">
                <div className="np-col">
                  <label className="np-lbl" htmlFor="np-name">{t('projectName')}</label>
                  <input id="np-name" ref={nameRef} className="np-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') create(); }} autoFocus />
                </div>
                <div className="np-col">
                  <label className="np-lbl">{t('fps')}</label>
                  <div className="np-seg">
                    {FPS.map((v) => <button key={v} className={fps === v ? 'on' : ''} onClick={() => setFps(v)}>{v}</button>)}
                  </div>
                </div>
              </div>
              <div className="np-col">
                <label className="np-lbl">{t('format')}</label>
                <div className="format-grid">
                  {FORMATS.map((f) => (
                    <button key={f.id} className={`format-btn ${preset === f.id ? 'on' : ''}`} onClick={() => setPreset(f.id)}>
                      <span className="fb-ratio"><Ratio r={f.r} /></span>
                      <span className="fb-name">{t(f.label)}</span>
                      <span className="fb-sub">{f.sub}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="np-foot">
              <span className="np-summary">{t(fmt.label)} · {fmt.sub} · {fps} {t('fpsUnit')}</span>
              <button className="np-create" disabled={busy} onClick={create}>{t('create')} <ArrowRight size={15} strokeWidth={2.2} /></button>
            </div>
          </section>

          <section>
            <div className="home-h2">{t('recentProjects')}{recent.length > 0 && <span className="count">{recent.length}</span>}</div>
            {!recent.length ? <div className="recent-empty">{t('noRecent')}</div> : (
              <div className="recent-list">
                {recent.map((r) => (
                  <div key={r.path} className={`recent-row ${r.exists ? '' : 'missing'}`} onClick={() => r.exists && call('project:open', { path: r.path }).catch((e) => useStore.getState().toast('error', e.message))}>
                    <span className="rr-ico"><Film size={14} /></span>
                    <span className="rr-main">
                      <span className="rr-name">{r.name}</span>
                      <span className="rr-path" title={r.path}>{r.path}</span>
                    </span>
                    <span className="rr-date">{new Date(r.openedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    <button className="icon-btn rr-del" title={r.exists ? t('deleteProject') : t('forget')} onClick={(e) => { e.stopPropagation(); remove(r); }}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
