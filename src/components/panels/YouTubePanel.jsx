import React, { useState } from 'react';
import { Search, Download, Loader2, Music, Film, ExternalLink, ShieldCheck, Link2 } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, useLang } from '../../app/i18n.js';

const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

export function YouTubePanel() {
  const t = useT();
  const lang = useLang();
  const [q, setQ] = useState('');
  const [cc, setCc] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('audio');
  const [url, setUrl] = useState('');
  const [section, setSection] = useState({ start: '', end: '' });
  const [place, setPlace] = useState(true);

  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try { setResults(await call('youtube:search', { query: q, limit: 12, creativeCommons: cc })); }
    catch (e) { useStore.getState().toast('error', e.message); }
    setLoading(false);
  };
  const dl = async (u) => {
    try {
      const opts = { url: u, mode, ...(section.start !== '' ? { start: Number(section.start) } : {}), ...(section.end !== '' ? { end: Number(section.end) } : {}) };
      if (place) opts.place = { start: Math.round(playhead.time * 100) / 100, track: mode === 'audio' ? 'auto' : 'overlay', ...(mode === 'audio' ? { volume: 0.5 } : {}) };
      await call('youtube:download', opts);
      useStore.getState().toast('info', t('downloadStarted'));
    } catch (e) { useStore.getState().toast('error', e.message); }
  };

  return (
    <div className="panel yt-panel">
      <div className="panel-head">
        <span className="panel-title">{t('ytTitle')}</span>
        <div className="seg">
          <button className={mode === 'audio' ? 'on' : ''} onClick={() => setMode('audio')}><Music size={12} /> {t('audioOnly')}</button>
          <button className={mode === 'video' ? 'on' : ''} onClick={() => setMode('video')}><Film size={12} /> {t('video')}</button>
        </div>
      </div>
      <form className="search-box" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <Search size={13} />
        <input placeholder={t('searchYoutube')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {loading && <Loader2 size={13} className="spin" />}
      </form>
      <label className="check-row"><input type="checkbox" checked={cc} onChange={(e) => setCc(e.target.checked)} /> <ShieldCheck size={12} /> {t('ccOnly')}</label>
      <div className="yt-url">
        <Link2 size={13} />
        <input placeholder={t('pasteUrl')} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn primary sm" disabled={!url} onClick={() => dl(url)}><Download size={12} /></button>
      </div>
      <div className="yt-options">
        <span className="dim small">{t('section')}</span>
        <input className="mini" placeholder={t('startPh')} value={section.start} onChange={(e) => setSection({ ...section, start: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <input className="mini" placeholder={t('endPh')} value={section.end} onChange={(e) => setSection({ ...section, end: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <label className="check-row small"><input type="checkbox" checked={place} onChange={(e) => setPlace(e.target.checked)} /> {t('placeAtPlayhead')}</label>
      </div>
      <div className="yt-list">
        {results.map((r) => (
          <div key={r.id} className="yt-item">
            <div className="yt-thumb">{r.thumbnail ? <img src={r.thumbnail} alt="" /> : null}<span>{fmtDur(r.duration)}</span></div>
            <div className="yt-info">
              <div className="yt-title" title={r.title}>{r.title}</div>
              <div className="dim small">{r.channel}{r.views ? ` · ${Intl.NumberFormat(lang, { notation: 'compact' }).format(r.views)} ${t('views')}` : ''}</div>
              <div className="yt-actions">
                <button className="btn sm" onClick={() => dl(r.url)}><Download size={12} /> {mode === 'audio' ? 'MP3' : 'MP4'}</button>
                <button className="icon-btn xs" onClick={() => call('shell:external', { url: r.url })}><ExternalLink size={12} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="panel-foot dim small">{t('ytDisclaimer')} — {t('viaYtdlp')}</div>
    </div>
  );
}
