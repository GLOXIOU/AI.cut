import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Play, Square, Plus, Loader2, Music, Zap, BadgeCheck, Info, Globe, AudioLines, X, Laugh, Mic2 } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, quote } from '../../app/i18n.js';
import { Toggle, Slider } from '../ui/fields.jsx';

const QUICK_SFX = ['whoosh', 'boom', 'pop', 'ding', 'glitch', 'swoosh', 'impact', 'riser', 'click', 'cash', 'laugh', 'applause'];
const QUICK_MUSIC = ['upbeat', 'chill', 'epic', 'funny', 'dark', 'piano', 'electro', 'cinematic', 'happy', 'travel'];

let libCache = null;
/** Built-in sounds (synth + real recordings) and bundled music, loaded once. */
export function useLibrary() {
  const [lib, setLib] = useState(libCache || { items: [], categories: [], memeCategories: [], music: [], musicCategories: [] });
  useEffect(() => {
    if (!libCache) call('library:builtin').then((b) => { libCache = b; setLib(b); }).catch(() => {});
  }, []);
  return lib;
}

/** Shared preview player (one sound at a time). */
let previewAudio = null;
export function usePreview() {
  const [playing, setPlaying] = useState(null);
  useEffect(() => () => { if (previewAudio && playing) previewAudio.pause(); }, [playing]);
  const toggle = async (id) => {
    if (playing === id) { previewAudio?.pause(); setPlaying(null); return; }
    const url = await call('library:preview', { id }).catch(() => null);
    if (!url) return;
    if (!previewAudio) previewAudio = new Audio();
    previewAudio.pause();
    previewAudio.src = url;
    previewAudio.onended = () => setPlaying(null);
    previewAudio.play().catch(() => {});
    setPlaying(id);
  };
  return [playing, toggle];
}

/** Add a library item at the playhead (sounds go to a free audio track). */
/** Title of a library item in the interface language. */
export const itemTitle = (it) => (useStore.getState().lang === 'en' ? it.titleEn || it.title : it.title);

export async function addLibraryItem(it, t) {
  const place = { start: Math.round(playhead.time * 100) / 100, track: 'auto', ...(it.kind === 'music' ? { volume: 0.3, fadeIn: 1, fadeOut: 2 } : {}) };
  const r = await call('library:add', { id: it.id, place });
  const local = ['builtin:', 'pack:', 'music:', 'myinstants:'].some((p) => it.id.startsWith(p));
  useStore.getState().toast(local ? 'success' : 'info', local
    ? `${quote(itemTitle(it))} ${t('added')}${it.attributionRequired ? ` (${t('creditRequired')})` : ''}`
    : `${t('downloading')} ${quote(itemTitle(it))}…${it.attributionRequired ? ` (${t('creditRequired')})` : ''}`);
  return r;
}

const fmtD = (d) => (d >= 60 ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : `${d.toFixed(1)}s`);

export function AudioPanel() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const [kind, setKind] = useState('builtin');
  const [query, setQuery] = useState('');
  const [license, setLicense] = useState('no-attribution');
  const [results, setResults] = useState([]);
  const lib = useLibrary();
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [playing, preview] = usePreview();
  const [adding, setAdding] = useState(null);
  const seq = useRef(0);

  const search = async (q = query, k = kind) => {
    if (k !== 'music' && k !== 'online') return;
    if (k === 'music' && !q.trim()) { setResults([]); setErrors([]); return; }
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await call('library:search', k === 'music'
        ? { query: q, kind: 'music', license, limit: 20, source: 'all' }
        : { query: q || 'whoosh', kind: 'sfx', license, limit: 20, source: 'openverse' });
      if (my !== seq.current) return;
      setResults(r.results.filter((x) => !x.local));
      setErrors(r.errors || []);
    } catch (e) { setErrors([e.message]); }
    if (my === seq.current) setLoading(false);
  };
  useEffect(() => { setResults([]); setErrors([]); if (kind === 'online' || (kind === 'music' && query.trim())) search(query, kind); }, [kind, license]);

  const add = async (it) => {
    setAdding(it.id);
    try { await addLibraryItem(it, t); } catch (e) { useStore.getState().toast('error', e.message); }
    setAdding(null);
  };

  const ql = query.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const matches = (x) => !ql || `${x.title} ${x.titleEn || ''} ${x.tags.join(' ')} ${x.category}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(ql);
  const sfxGroups = useMemo(() => {
    const items = lib.items.filter(matches);
    const cats = kind === 'meme' ? lib.categories.filter(([id]) => lib.memeCategories.includes(id)) : lib.categories;
    return cats.map(([id, fr, en]) => [id, lang === 'en' ? en || fr : fr, items.filter((x) => x.category === id)]).filter(([, , l]) => l.length);
  }, [lib, ql, kind, lang]);
  const musicGroups = useMemo(() => {
    const items = lib.music.filter(matches);
    return lib.musicCategories.map(([id, fr, en]) => [id, lang === 'en' ? en : fr, items.filter((x) => x.category === id)]).filter(([, , l]) => l.length);
  }, [lib, ql, lang]);

  const tile = (it) => (
    <div key={it.id} className="sfx-tile" draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-aicut-sfx', it.id); e.dataTransfer.effectAllowed = 'copy'; }}
      title={`${itemTitle(it)}${it.real ? ` — ${t('realRecording')}` : ''}\n${it.tags.slice(0, 8).join(', ')}\n${t('dragToTimeline')}`}>
      <button className={`play-dot ${playing === it.id ? 'on' : ''}`} onClick={() => preview(it.id)}>{playing === it.id ? <Square size={10} /> : <Play size={10} />}</button>
      <span className="lib-title">{itemTitle(it)}</span>
      {it.real && <span className="real-tag" title={t('realRecording')}><Mic2 size={9} /></span>}
      <button className="icon-btn xs" title={t('addAtPlayhead')} disabled={adding === it.id} onClick={() => add(it)}>{adding === it.id ? <Loader2 size={11} className="spin" /> : <Plus size={12} />}</button>
    </div>
  );
  const row = (it) => (
    <div key={it.id} className="lib-item" draggable={it.id.startsWith('music:') || it.id.startsWith('builtin:') || it.id.startsWith('pack:')} onDragStart={(e) => e.dataTransfer.setData('application/x-aicut-sfx', it.id)}>
      <button className={`play-dot ${playing === it.id ? 'on' : ''}`} onClick={() => preview(it.id)}>{playing === it.id ? <Square size={10} /> : <Play size={10} />}</button>
      <div className="lib-info">
        <div className="lib-title" title={itemTitle(it)}>{itemTitle(it)}</div>
        <div className="lib-meta">
          <span className="src">{it.source === 'pack' ? t('bundled') : it.source === 'freepd' ? 'FreePD' : it.source.split('/').pop()}</span>
          {it.duration ? <span>{fmtD(it.duration)}</span> : null}
          {it.bpm ? <span>{it.bpm} bpm</span> : null}
          {it.attributionRequired ? <span className="lic warn" title={it.attribution}>{it.license} · {t('creditRequired')}</span> : <span className="lic ok"><BadgeCheck size={10} /> {t('noCreditNeeded')}</span>}
        </div>
      </div>
      <button className="icon-btn" title={t('addAtPlayhead')} disabled={adding === it.id} onClick={() => add(it)}>{adding === it.id ? <Loader2 size={13} className="spin" /> : <Plus size={14} />}</button>
    </div>
  );

  return (
    <div className="panel audio-panel">
      <div className="panel-head">
        <div className="seg seg-wide">
          <button className={kind === 'builtin' ? 'on' : ''} onClick={() => setKind('builtin')}><Zap size={12} /> {t('sfxShort')}</button>
          <button className={kind === 'music' ? 'on' : ''} onClick={() => setKind('music')}><Music size={12} /> {t('music')}</button>
          <button className={kind === 'meme' ? 'on' : ''} onClick={() => setKind('meme')}><Laugh size={12} /> {t('memes')}</button>
          <button className={kind === 'online' ? 'on' : ''} onClick={() => setKind('online')}><Globe size={12} /> {t('online')}</button>
        </div>
      </div>
      <form className="search-box" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <Search size={12} />
        <input placeholder={kind === 'music' ? t('musicSearchPh') : t('sfxSearchPh')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {loading && <Loader2 size={12} className="spin" />}
        {query && <button type="button" className="icon-btn xs" onClick={() => { setQuery(''); setResults([]); if (kind === 'online') search(''); }}><X size={11} /></button>}
      </form>

      {(kind === 'builtin' || kind === 'meme') && (
        <>
          {kind === 'builtin' && !ql && <AutoSfxCard />}
          {kind === 'meme' && (
            <div className="hint"><Laugh size={13} /> <span>{t('memeSoundsHint')} <button className="link" onClick={() => useStore.setState({ leftTab: 'memes', workspace: null })}>{t('openMemePanel')}</button></span></div>
          )}
          {sfxGroups.map(([id, label, list]) => (
            <div key={id}>
              <div className="cat-title" style={{ padding: '0 10px' }}>{label} <span className="count">{list.length}</span></div>
              <div className="sfx-grid">{list.map(tile)}</div>
            </div>
          ))}
          {!sfxGroups.length && <div className="dim pad">{t('noResults')}</div>}
          <div className="panel-foot dim small">{t('builtinSfxFoot2')}</div>
        </>
      )}

      {kind === 'music' && (
        <>
          <div className="quick-tags">
            {QUICK_MUSIC.map((q) => <button key={q} className={`chip ${query === q ? 'on' : ''}`} onClick={() => { setQuery(q); search(q); }}>{q}</button>)}
          </div>
          <div className="license-row">
            <select value={license} onChange={(e) => setLicense(e.target.value)}>
              <option value="no-attribution">{t('noAttribution')}</option>
              <option value="attribution-ok">{t('creditsOk')}</option>
            </select>
          </div>
          {query.trim() && (
            <div className="lib-list">
              <div className="cat-title" style={{ padding: '4px 4px 0' }}>{t('onlineResults')} {loading && <Loader2 size={11} className="spin" />}</div>
              {results.map(row)}
              {!loading && !results.length && <div className="dim pad small">{t('noResults')}</div>}
              {errors.length > 0 && <div className="dim pad small"><Info size={11} /> {errors.join(' · ')}</div>}
            </div>
          )}
          {musicGroups.map(([id, label, list]) => (
            <div key={id} className="lib-list">
              <div className="cat-title" style={{ padding: '4px 4px 0' }}>{label} <span className="count">{list.length}</span></div>
              {list.map(row)}
            </div>
          ))}
          <div className="panel-foot dim small">{t('musicFoot')}</div>
        </>
      )}

      {kind === 'online' && (
        <>
          <div className="quick-tags">
            {QUICK_SFX.map((q) => <button key={q} className={`chip ${query === q ? 'on' : ''}`} onClick={() => { setQuery(q); search(q); }}>{q}</button>)}
          </div>
          <div className="license-row">
            <select value={license} onChange={(e) => setLicense(e.target.value)}>
              <option value="no-attribution">{t('noAttribution')}</option>
              <option value="attribution-ok">{t('creditsOk')}</option>
            </select>
          </div>
          <div className="lib-list">
            {results.map(row)}
            {!loading && !results.length && <div className="dim pad">{t('noResults')}</div>}
            {errors.length > 0 && <div className="dim pad small"><Info size={11} /> {errors.join(' · ')}</div>}
          </div>
          <div className="panel-foot dim small">{t('onlineFoot')}</div>
        </>
      )}
    </div>
  );
}

/** One-click sound design: whooshes on cuts / B-roll entrances, pops on titles, boom on emphasis. */
function AutoSfxCard() {
  const t = useT();
  const [o, setO] = useState({ transitions: true, broll: true, titles: true, keywords: false, volume: 0.6 });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await call('edit:autoSfx', o);
      useStore.getState().toast(r.added ? 'success' : 'info', t('autoSfxDone', { n: r.added }));
    } catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(false);
  };
  return (
    <div className="auto-card">
      <div className="title"><AudioLines size={13} /> {t('autoSfx')}</div>
      <div className="dim small">{t('autoSfxText')}</div>
      <Toggle label={t('autoSfxTransitions')} value={o.transitions} onChange={(v) => setO({ ...o, transitions: v })} />
      <Toggle label={t('autoSfxBroll')} value={o.broll} onChange={(v) => setO({ ...o, broll: v })} />
      <Toggle label={t('autoSfxTitles')} value={o.titles} onChange={(v) => setO({ ...o, titles: v })} />
      <Toggle label={t('autoSfxKeywords')} value={o.keywords} onChange={(v) => setO({ ...o, keywords: v })} />
      <Slider label={t('volume')} value={o.volume} min={0.1} max={1.5} step={0.05} onCommit={(v) => setO({ ...o, volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <button className="btn primary sm" disabled={busy} onClick={run}>{busy ? <Loader2 size={12} className="spin" /> : <AudioLines size={12} />} {t('autoSfxRun')}</button>
    </div>
  );
}
