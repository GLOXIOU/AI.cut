import React, { useEffect, useRef, useState } from 'react';
import { Search, Play, Square, Loader2, X, Image as ImageIcon, Film, AudioLines, Zap, Smile, Plus, Download, Clapperboard, Globe } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call, fileUrl } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, quote } from '../../app/i18n.js';
import { MEMES, STICKER_POSITIONS, MEME_SOUND_QUICK, MEME_VIDEO_QUICK } from '@shared/memes.js';
import { usePreview, addLibraryItem } from './AudioPanel.jsx';

const POS_LABEL = { center: '●', top: '↑', bottom: '↓', left: '←', right: '→', 'top-left': '↖', 'top-right': '↗', 'bottom-left': '↙', 'bottom-right': '↘' };
const VIDEO_CATS = [['', 'Tout', 'All'], ['Reactions', 'Réactions', 'Reactions'], ['Funny', 'Drôle', 'Funny'], ['Effects', 'Effets', 'Effects'], ['Animals', 'Animaux', 'Animals'], ['Dance', 'Danse', 'Dance'], ['Gaming', 'Gaming', 'Gaming']];
const fmtD = (s) => (s ? (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`) : '');
const toast = (lvl, msg) => useStore.getState().toast(lvl, msg);

/** Debounced search of the meme bank. */
function useBank(kind, query, enabled = true, category = '') {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const my = ++seq.current;
    const id = setTimeout(async () => {
      setLoading(true); setError(null);
      try { const r = await call('memes:search', { kind, query, category }); if (my === seq.current) setItems(r || []); }
      catch (e) { if (my === seq.current) { setItems([]); setError(e.message); } }
      if (my === seq.current) setLoading(false);
    }, kind === 'youtube' ? 500 : 200);
    return () => clearTimeout(id);
  }, [kind, query, enabled, category]);
  return [items, loading, error];
}

/** "Mode mème": real internet memes (green-screen videos, GIFs, images, sounds) + one-click combos, added at the playhead. */
export function MemePanel() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const project = useStore((s) => s.project);
  const [tab, setTab] = useState('videos');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [yt, setYt] = useState(false);
  const [busy, setBusy] = useState(null);
  const [mode, setMode] = useState('full');
  const [pos, setPos] = useState('center');
  const [size, setSize] = useState(0.45);
  const [playing, preview] = usePreview();
  const [videos, vidLoading, vidError] = useBank(yt ? 'youtube' : 'video', yt ? q || 'meme' : q, tab === 'videos', cat);
  const [gifs, gifLoading, gifError] = useBank('gif', q, tab === 'gifs');
  const [images, imgLoading, imgError] = useBank('image', q, tab === 'images');
  const [sounds, sndLoading, sndError] = useBank('sound', q, tab === 'sounds');
  const [stickers, setStickers] = useState([]);

  useEffect(() => { call('memes:starter').catch(() => {}); }, []);
  useEffect(() => { setQ(''); setYt(false); }, [tab]);
  useEffect(() => {
    if (tab !== 'emojis') return undefined;
    const id = setTimeout(() => call('stickers:search', { query: q, animated: true, limit: 120 }).then(setStickers).catch(() => setStickers([])), 150);
    return () => clearTimeout(id);
  }, [q, tab]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); if (ok) toast('success', ok(r)); } catch (e) { toast('error', e.message); }
    setBusy(null);
  };
  const at = () => Math.round(playhead.time * 100) / 100;
  const loading = vidLoading || gifLoading || imgLoading || sndLoading;
  if (!project) return null;

  const placeOpts = (
    <div className="sticker-opts">
      <div className="seg">
        <button className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>{t('memeFull')}</button>
        <button className={mode === 'pip' ? 'on' : ''} onClick={() => setMode('pip')}>{t('memePip')}</button>
      </div>
      {mode === 'pip' && (
        <>
          <div className="pos-pick" title={t('position')}>{STICKER_POSITIONS.map((p) => <button key={p} className={pos === p ? 'on' : ''} onClick={() => setPos(p)}>{POS_LABEL[p]}</button>)}</div>
          <label className="size-pick" title={t('size')}><input type="range" min={0.15} max={0.9} step={0.05} value={size} onChange={(e) => setSize(Number(e.target.value))} /><span>{Math.round(size * 100)}%</span></label>
        </>
      )}
    </div>
  );
  const placeArgs = () => (mode === 'pip' ? { mode: 'pip', size, position: pos } : { mode: 'full' });

  const grid = (list, kind) => (
    <div className="meme-img-grid">
      {list.map((it) => (
        <button key={it.id} className="meme-img" disabled={busy === it.id} title={`${it.title}${it.duration ? ` · ${fmtD(it.duration)}` : ''}\n${t('clickToAdd')}`}
          onClick={() => run(it.id, () => (kind === 'video'
            ? call('memes:addVideo', { id: it.id, start: at(), ...(mode === 'pip' ? { size, position: pos } : {}) })
            : call('memes:addImage', { id: it.id, start: at(), ...placeArgs() })), () => `${quote(it.title)} ${t('memeAdded')}`)}>
          <span className="meme-img-thumb">
            <img src={kind === 'image' && it.local ? fileUrl(it.local) : it.thumb || it.url} alt="" loading="lazy" draggable={false} />
            {it.duration ? <i className="meme-dur">{fmtD(it.duration)}</i> : null}
            {busy === it.id && <i className="meme-busy"><Loader2 size={16} className="spin" /></i>}
          </span>
          <span className="meme-img-name">{it.title}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="panel meme-panel">
      <div className="panel-head">
        <div className="seg seg-wide">
          <button className={tab === 'videos' ? 'on' : ''} title={t('memeVideosTip')} onClick={() => setTab('videos')}><Clapperboard size={12} /> {t('memeVideos')}</button>
          <button className={tab === 'gifs' ? 'on' : ''} onClick={() => setTab('gifs')}><Film size={12} /> GIF</button>
          <button className={tab === 'images' ? 'on' : ''} onClick={() => setTab('images')}><ImageIcon size={12} /> {t('memeImages')}</button>
          <button className={tab === 'sounds' ? 'on' : ''} onClick={() => setTab('sounds')}><AudioLines size={12} /> {t('memeSoundsTab')}</button>
          <button className={tab === 'combos' ? 'on' : ''} title={t('memeCombos')} onClick={() => setTab('combos')}><Zap size={12} /></button>
          <button className={tab === 'emojis' ? 'on' : ''} title={t('emojiStickers')} onClick={() => setTab('emojis')}><Smile size={12} /></button>
        </div>
      </div>
      {tab !== 'combos' && (
        <form className="search-box" onSubmit={(e) => e.preventDefault()}>
          <Search size={12} />
          <input placeholder={t(`memeSearch_${tab}`)} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          {loading && <Loader2 size={12} className="spin" />}
          {q && <button type="button" className="icon-btn xs" onClick={() => setQ('')}><X size={11} /></button>}
        </form>
      )}

      {tab === 'videos' && (
        <>
          <div className="quick-tags">
            {!yt && VIDEO_CATS.map(([id, fr, en]) => <button key={id || 'all'} className={`chip ${cat === id ? 'on' : ''}`} onClick={() => setCat(id)}>{lang === 'en' ? en : fr}</button>)}
            <button className={`chip ${yt ? 'on' : ''}`} title={t('ytGreenTip')} onClick={() => setYt(!yt)}><Globe size={11} /> YouTube</button>
          </div>
          {yt && <div className="quick-tags">{MEME_VIDEO_QUICK.map((w) => <button key={w} className={`chip ${q === w ? 'on' : ''}`} onClick={() => setQ(q === w ? '' : w)}>{w}</button>)}</div>}
          {placeOpts}
          {!yt && grid(videos, 'video')}
          {yt && (
            <div className="yt-list">
              {videos.map((v) => (
                <div key={v.id} className="yt-item">
                  <div className="yt-thumb">{v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : null}<span>{fmtD(v.duration)}</span></div>
                  <div className="yt-info">
                    <div className="yt-title" title={v.title}>{v.title}</div>
                    <div className="dim small">{v.channel}</div>
                    <div className="yt-actions">
                      <button className="btn sm" disabled={busy === v.id} onClick={() => run(v.id, () => call('memes:addVideo', { url: v.url, start: at() }), () => t('greenScreenStarted'))}>
                        {busy === v.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />} {t('addKeyed')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!vidLoading && !videos.length && <div className="dim pad small">{vidError || t('noResults')}</div>}
        </>
      )}

      {tab === 'gifs' && (
        <>
          {placeOpts}
          {grid(gifs, 'gif')}
          {!gifLoading && !gifs.length && <div className="dim pad small">{gifError || t('noResults')}</div>}
        </>
      )}

      {tab === 'images' && (
        <>
          {placeOpts}
          {grid(images, 'image')}
          {!imgLoading && !images.length && <div className="dim pad small">{imgError || t('noResults')}</div>}
        </>
      )}

      {tab === 'sounds' && (
        <>
          <div className="quick-tags">{MEME_SOUND_QUICK.map((w) => <button key={w} className={`chip ${q === w ? 'on' : ''}`} onClick={() => setQ(q === w ? '' : w)}>{w}</button>)}</div>
          <div className="lib-list">
            {sounds.map((it) => (
              <div key={it.id} className="lib-item" draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-aicut-sfx', it.id); e.dataTransfer.effectAllowed = 'copy'; }}>
                <button className={`play-dot ${playing === it.id ? 'on' : ''}`} onClick={() => preview(it.id)}>{playing === it.id ? <Square size={10} /> : <Play size={10} />}</button>
                <div className="lib-info"><div className="lib-title" title={it.title}>{it.title}</div></div>
                <button className="icon-btn" title={t('addAtPlayhead')} disabled={busy === it.id} onClick={() => run(it.id, () => addLibraryItem({ ...it, kind: 'sfx' }, t))}>{busy === it.id ? <Loader2 size={13} className="spin" /> : <Plus size={14} />}</button>
              </div>
            ))}
            {!sndLoading && !sounds.length && <div className="dim pad small">{sndError || t('noResults')}</div>}
          </div>
        </>
      )}

      {tab === 'combos' && (
        <>
          <div className="cat-title" style={{ padding: '0 10px' }}>{t('memeCombos')}</div>
          <div className="hint">{t('memeModeHint')}</div>
          <div className="meme-grid">
            {MEMES.map((m) => (
              <button key={m.id} className="meme-btn" disabled={!!busy} onClick={() => run(`m-${m.id}`, () => call('memes:apply', { id: m.id, time: at() }), () => `${lang === 'en' ? m.en : m.fr} — ${t('memeAdded')}`)} title={`${lang === 'en' ? m.en : m.fr}\n${t('memeComboTip')}`}>
                <span className="meme-emoji">{busy === `m-${m.id}` ? <Loader2 size={16} className="spin" /> : m.glyph}</span>
                <span className="meme-name">{lang === 'en' ? m.en : m.fr}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {tab === 'emojis' && (
        <div className="sticker-grid">
          {stickers.map((s) => (
            <button key={s.id} className="sticker" disabled={busy === `s-${s.id}`} title={s.name}
              onClick={() => run(`s-${s.id}`, () => call('stickers:add', { id: s.id, start: at(), position: 'top-right', size: 0.28, animated: true }), () => `${s.glyph} ${t('stickerAdded')}`)}>
              {s.png ? <img src={fileUrl(s.png)} alt={s.glyph} loading="lazy" draggable={false} /> : <span className="glyph">{s.glyph}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="panel-foot dim small">{t('memeBankFoot')}</div>
    </div>
  );
}
