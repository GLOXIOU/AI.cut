import React, { useMemo, useState } from 'react';
import { Upload, FolderOpen, Film, Music, Image as ImageIcon, Sparkles, Loader2, AlertTriangle, Plus, ScanText, Trash2, FolderSearch, Search, Captions, LayoutGrid, List, X } from 'lucide-react';
import { useStore, localSet } from '../../app/store.js';
import { call, op, fileUrl } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';
import { fmtTime } from '@shared/timeline.js';

const ICON = { video: Film, audio: Music, image: ImageIcon, html: Sparkles, lottie: Sparkles };

export function MediaPanel() {
  const t = useT();
  const project = useStore((s) => s.project);
  const jobs = useStore((s) => s.jobs);
  const view = useStore((s) => s.mediaView);
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState(null);
  const [detail, setDetail] = useState(null);
  const media = useMemo(() => (project?.media || []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase())), [project?.media, q]);

  const importFiles = async (folder = false) => {
    const paths = await call('dialog:openFiles', { multi: true, folder, title: t('importFiles') });
    if (paths?.length) await call('media:import', { paths }).catch((e) => useStore.getState().toast('error', e.message));
  };
  const onDrop = async (e) => {
    e.preventDefault();
    setOver(false);
    const paths = [...(e.dataTransfer.files || [])].map((f) => window.aicut.pathForFile(f)).filter(Boolean);
    if (paths.length) await call('media:import', { paths }).catch((err) => useStore.getState().toast('error', err.message));
  };
  const addToTimeline = (m) => op('addClip', { mediaId: m.id, ...(m.type === 'image' || m.type === 'html' || m.type === 'lottie' ? { start: playhead.time } : {}) }, 'add clip');
  const analyzing = (m) => Object.values(jobs).some((j) => j.meta?.mediaId === m.id && !j.endedAt);
  const proxyJob = (m) => Object.values(jobs).find((j) => j.type === 'proxy' && j.meta?.mediaId === m.id && j.status === 'running');
  const setView = (v) => { useStore.setState({ mediaView: v }); localSet('aicut.mediaView', v); };

  const status = (m) => {
    const a = m.analysis || {};
    const busy = m.status === 'processing' || analyzing(m);
    return (
      <div className="media-status">
        {busy && <span className="st busy"><Loader2 size={10} className="spin" /> {m.status === 'processing' && !proxyJob(m) ? t('importing') : a.transcript === 'running' ? t('transcribing') : proxyJob(m) ? `proxy ${Math.round((proxyJob(m).progress || 0) * 100)}%` : t('analysing')}</span>}
        {!busy && a.transcript === 'done' && a.words > 0 && <span className="st ok" title={`${a.words} · ${a.language}`}><Captions size={10} /> {a.language} · {a.words}</span>}
        {!busy && a.shots > 1 && <span className="st">{a.shots} {t('shots')}</span>}
        {a.bpm && <span className="st">{Math.round(a.bpm)} BPM</span>}
        {m.status === 'error' && <span className="st err" title={m.error}><AlertTriangle size={10} /> {t('error')}</span>}
        {m.offline && <span className="st err"><AlertTriangle size={10} /> offline</span>}
        {m.source?.attributionRequired && <span className="st warn" title={m.source.attribution}>CC-BY</span>}
      </div>
    );
  };
  const cardProps = (m) => ({
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData('application/x-aicut-media', m.id); e.dataTransfer.effectAllowed = 'copy'; },
    onDoubleClick: () => addToTimeline(m),
    onClick: () => setDetail(detail === m.id ? null : m.id),
    onContextMenu: (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, m }); },
  });

  return (
    <div className={`panel media-panel ${over ? 'drop-over' : ''}`} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="panel-head">
        <span className="panel-title">{project?.name} <span className="dim">· {project?.media.length || 0} {t('items')}</span></span>
        <div className="panel-actions">
          <button className="btn primary sm" onClick={() => importFiles(false)}><Upload size={12} /> {t('import')}</button>
          <button className="icon-btn" title={t('importFolder')} onClick={() => importFiles(true)}><FolderOpen size={14} /></button>
        </div>
      </div>
      <div className="bin-tools">
        <div className="search-box" style={{ margin: 0, flex: 1 }}><Search size={12} /><input placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />{q && <button className="icon-btn xs" onClick={() => setQ('')}><X size={11} /></button>}</div>
        <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} title={t('gridView')} onClick={() => setView('grid')}><LayoutGrid size={12} /></button>
          <button className={view === 'list' ? 'on' : ''} title={t('listView')} onClick={() => setView('list')}><List size={12} /></button>
        </div>
      </div>
      {!project?.media.length && (
        <div className="dropzone" onClick={() => importFiles(false)}>
          <Upload size={24} />
          <div>{t('dropHere')}</div>
          <div className="dim small">MP4 · MOV · MKV · MP3 · WAV · PNG · JPG · GIF · HTML · Lottie</div>
        </div>
      )}
      {view === 'grid' ? (
        <div className="media-grid">
          {media.map((m) => {
            const Icon = ICON[m.type] || Film;
            return (
              <div key={m.id} className={`media-card ${detail === m.id ? 'sel' : ''} ${m.offline ? 'offline' : ''}`} {...cardProps(m)}>
                <div className="media-thumb">
                  {m.thumb ? <img src={fileUrl(m.thumb)} alt="" draggable={false} /> : <Icon size={22} />}
                  {m.duration > 0 && m.type !== 'html' && <span className="media-dur">{fmtTime(m.duration).replace(/\.\d+$/, '')}</span>}
                  <span className="media-type"><Icon size={10} /></span>
                  <button className="media-add" title={t('addToTimeline')} onClick={(e) => { e.stopPropagation(); addToTimeline(m); }}><Plus size={12} /></button>
                </div>
                <div className="media-name" title={m.path}>{m.name}</div>
                {status(m)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="media-list">
          {media.map((m) => {
            const Icon = ICON[m.type] || Film;
            return (
              <div key={m.id} className={`media-row ${detail === m.id ? 'sel' : ''}`} {...cardProps(m)}>
                <div className="media-thumb">{m.thumb ? <img src={fileUrl(m.thumb)} alt="" draggable={false} /> : <Icon size={14} />}</div>
                <div className="meta"><div className="media-name" title={m.path}>{m.name}</div>{status(m)}</div>
                <span className="dim small">{m.duration > 0 && m.type !== 'html' ? fmtTime(m.duration).replace(/\.\d+$/, '') : ''}</span>
              </div>
            );
          })}
        </div>
      )}
      {detail && <MediaDetail media={project.media.find((m) => m.id === detail)} onClose={() => setDetail(null)} />}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <div className="menu-item" onClick={() => { addToTimeline(menu.m); setMenu(null); }}><Plus size={12} /> {t('addToTimeline')}</div>
          <div className="menu-item" onClick={() => { call('media:analyze', { mediaId: menu.m.id }); setMenu(null); }}><ScanText size={12} /> {t('analyze')}</div>
          <div className="menu-item" onClick={() => { call('shell:reveal', { path: menu.m.path }); setMenu(null); }}><FolderSearch size={12} /> {t('reveal')}</div>
          {menu.m.offline && <div className="menu-item" onClick={async () => { const [f] = await call('dialog:openFiles', { multi: false }); if (f) call('media:relink', { mediaId: menu.m.id, path: f }); setMenu(null); }}>{t('relink')}</div>}
          {menu.m.type === 'html' && <div className="menu-item" onClick={async () => { await call('motion:import', { paths: [menu.m.path] }).catch((e) => useStore.getState().toast('error', e.message)); useStore.getState().toast('success', t('addedToLibrary')); setMenu(null); }}><Sparkles size={12} /> {t('addToMyAnimations')}</div>}
          <div className="menu-sep" />
          <div className="menu-item danger" onClick={() => { op('removeMedia', { ids: [menu.m.id] }, 'remove media'); setMenu(null); }}><Trash2 size={12} /> {t('remove')}</div>
        </div>
      )}
    </div>
  );
}

function MediaDetail({ media, onClose }) {
  const t = useT();
  const [an, setAn] = useState(null);
  React.useEffect(() => { if (media) call('media:analysis', { mediaId: media.id }).then(setAn).catch(() => {}); }, [media?.id, media?.analysis?.transcript]);
  if (!media) return null;
  const segs = an?.transcript?.segments || [];
  return (
    <div className="media-detail">
      <div className="md-head"><b>{media.name}</b><button className="icon-btn xs" onClick={onClose}><X size={12} /></button></div>
      <div className="md-meta">{media.type} · {media.width ? `${media.width}×${media.height} · ` : ''}{media.duration ? `${media.duration.toFixed(1)}s` : ''}{media.fps ? ` · ${media.fps} fps` : ''}{an?.audio?.integratedLufs != null ? ` · ${an.audio.integratedLufs} LUFS` : ''}</div>
      {an?.descriptions?.summary && <div className="md-notes">{an.descriptions.summary}</div>}
      {segs.length > 0 ? (
        <div className="md-transcript">
          {segs.map((s, i) => (
            <div key={i} className="md-seg" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-aicut-media', media.id)}
              onClick={() => op('addClip', { mediaId: media.id, in: s.start, out: s.end }, 'add select')} title={t('addExcerpt')}>
              <span className="md-time">{fmtTime(s.start)}</span> {s.text}
            </div>
          ))}
        </div>
      ) : <div className="dim small">{media.analysis?.transcript === 'running' ? t('transcribing') : media.hasAudio ? t('noTranscript') : t('noAudio')}</div>}
    </div>
  );
}
