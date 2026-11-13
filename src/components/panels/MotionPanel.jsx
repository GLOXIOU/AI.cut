import React, { useEffect, useRef, useState } from 'react';
import { Type, Sparkles, Code2, FileJson, Plus, FileUp, Search, Trash2, X, Shuffle, Layers } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call, op, fileUrl } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, useLang, tplName } from '../../app/i18n.js';
import { TRANSITIONS } from '@shared/transitions.js';
import { AnimGrid } from '../inspector/AnimPicker.jsx';

let templatesCache = null;
const subs = new Set();
export function reloadTemplates() {
  return call('motion:templates').then((l) => { templatesCache = l; for (const s of subs) s(l); return l; }).catch(() => []);
}
export function useTemplates() {
  const [list, setList] = useState(templatesCache || []);
  useEffect(() => {
    subs.add(setList);
    if (!templatesCache) reloadTemplates();
    return () => subs.delete(setList);
  }, []);
  return list;
}

const thumbs = new Map(); // template id → url | Promise
function useThumb(id, version) {
  const key = `${id}|${version || ''}`;
  const [url, setUrl] = useState(typeof thumbs.get(key) === 'string' ? thumbs.get(key) : null);
  useEffect(() => {
    let alive = true;
    const v = thumbs.get(key);
    if (typeof v === 'string') { setUrl(v); return undefined; }
    const p = v || call('motion:thumb', { id }).then((file) => { const u = file ? fileUrl(file) : ''; thumbs.set(key, u); return u; }).catch(() => { thumbs.set(key, ''); return ''; });
    thumbs.set(key, p);
    p.then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [key]);
  return url;
}

const CATS = [
  ['user', 'myAnimations'], ['text', 'catText'], ['lower-third', 'catLowerThirds'], ['social', 'catSocial'], ['callout', 'catCallouts'],
  ['data', 'catData'], ['fx', 'catFx'], ['transition', 'catTransitions'], ['frame', 'catFrames'], ['other', 'catOther'],
];

const starter = (title) => ({
  html: `<div class="title">${title}</div>`,
  css: `.title{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font:800 120px Inter;color:#fff;letter-spacing:-2px;text-shadow:0 8px 30px rgba(0,0,0,.45);
  animation:in .6s cubic-bezier(.2,.9,.3,1) both, out .4s ease-in calc(var(--dur) - .4s) both}
@keyframes in{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes out{to{transform:translateY(-30px);opacity:0}}`,
  js: '',
});

export function MotionPanel() {
  const t = useT();
  const templates = useTemplates();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const lang = useStore((s) => s.lang);
  const [q, setQ] = useState('');
  const [section, setSection] = useState('graphics');
  const [animSlot, setAnimSlot] = useState('in');
  const add = (id, extra = {}) => {
    const tpl = templates.find((x) => x.id === id);
    const name = tpl && !tpl.user ? tplName(tpl, lang) : undefined; // clip named in the interface language
    return op('addClip', { template: id, start: Math.round(playhead.time * 100) / 100, track: 'overlay', ...(name ? { name } : {}), ...extra }, `add ${id}`);
  };
  const ql = q.trim().toLowerCase();
  const byCat = (cat) => templates.filter((x) => (x.category || 'other') === cat && !x.hidden && (!ql || `${x.name} ${tplName(x, 'en')} ${x.description || ''} ${x.id}`.toLowerCase().includes(ql)));

  const importLottie = async () => {
    const [f] = await call('dialog:openFiles', { multi: false, filters: [{ name: 'Lottie', extensions: ['json', 'lottie'] }] });
    if (f) add('lottie', { params: { src: `aicut://file/${encodeURIComponent(f)}` }, name: f.split(/[\\/]/).pop() });
  };
  const importHtml = async (folder) => {
    const paths = await call('dialog:openFiles', { multi: true, folder, filters: folder ? undefined : [{ name: 'HTML', extensions: ['html', 'htm'] }], title: t('importAnimations') });
    if (!paths?.length) return;
    try {
      const items = await call('motion:import', { paths });
      await reloadTemplates();
      useStore.getState().toast('success', t('animationsImported', { n: items.length }));
    } catch (e) { useStore.getState().toast('error', e.message); }
  };
  const visualSel = (project?.clips || []).filter((c) => selection.includes(c.id) && c.type !== 'audio');

  return (
    <div className="panel motion-panel">
      <div className="panel-head">
        <div className="seg">
          <button className={section === 'graphics' ? 'on' : ''} onClick={() => setSection('graphics')}><Sparkles size={12} /> {t('graphics')}</button>
          <button className={section === 'clipAnim' ? 'on' : ''} onClick={() => setSection('clipAnim')}><Layers size={12} /> {t('clipAnimations')}</button>
          <button className={section === 'transitions' ? 'on' : ''} onClick={() => setSection('transitions')}><Shuffle size={12} /> {t('transitions')}</button>
        </div>
      </div>

      {section === 'graphics' && (
        <>
          <div className="fx-tools">
            <button className="btn sm" onClick={() => add('text', { params: { text: t('yourText') }, duration: 3 })}><Type size={12} /> {t('addText')}</button>
            <button className="btn sm" onClick={() => importHtml(false)} title={t('importAnimationsHint')}><FileUp size={12} /> {t('importHtml')}</button>
            <button className="btn sm" onClick={() => importHtml(true)} title={t('importAnimationsHint')}>{t('folder')}</button>
            <button className="btn sm" onClick={importLottie}><FileJson size={12} /> Lottie</button>
            <button className="btn sm" onClick={() => op('addClip', { htmlCode: starter(t('starterTitle')), start: Math.round(playhead.time * 100) / 100, duration: 3, track: 'overlay', name: 'Motion HTML' }, 'custom motion')}><Code2 size={12} /> HTML</button>
          </div>
          <div className="search-box"><Search size={12} /><input placeholder={t('searchGraphics')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />{q && <button className="icon-btn xs" onClick={() => setQ('')}><X size={11} /></button>}</div>
          {CATS.map(([cat, label]) => {
            const list = byCat(cat);
            if (!list.length && cat !== 'user') return null;
            if (!list.length && ql) return null;
            return (
              <div key={cat} className="motion-cat">
                <div className="cat-title">{t(label)} <span className="count">{list.length || ''}</span></div>
                {cat === 'user' && !list.length && <div className="hint" style={{ padding: 0 }}>{t('myAnimationsEmpty')}</div>}
                <div className="motion-grid">
                  {list.map((tpl) => <TemplateCard key={tpl.id} tpl={tpl} project={project} onAdd={() => add(tpl.id)} />)}
                </div>
              </div>
            );
          })}
          <div className="hint"><Sparkles size={12} /> {t('motionAiHint')}</div>
        </>
      )}

      {section === 'clipAnim' && (
        <div className="pad" style={{ paddingTop: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="dim small">{t('clipAnimHint')}</div>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            {[['in', t('animIn')], ['out', t('animOut')], ['loop', t('animLoop')]].map(([id, l]) => (
              <button key={id} className={animSlot === id ? 'on' : ''} onClick={() => setAnimSlot(id)}>{l}</button>
            ))}
          </div>
          {animSlot === 'loop' && <div className="dim small">{t('stillHint')}</div>}
          <AnimGrid slot={animSlot} value={null} onPick={(id) => {
            if (!visualSel.length) { useStore.getState().toast('info', t('selectClipsFirst')); return; }
            op('setAnimation', { ids: visualSel.map((c) => c.id), [animSlot]: id || 'none' }, `animation ${animSlot}`);
          }} />
          <div className="dim small">{visualSel.length ? t('appliesTo', { n: visualSel.length }) : t('selectClipsFirst')}</div>
        </div>
      )}

      {section === 'transitions' && (
        <div className="fx-list">
          <div className="hint" style={{ padding: '0 4px 6px' }}>{t('transitionsHint')}</div>
          {TRANSITIONS.map((x) => (
            <div key={x.id} className="fx-item" onClick={() => {
              if (!visualSel.length) { useStore.getState().toast('info', t('selectClipsFirst')); return; }
              op('updateClips', { items: visualSel.map((c) => ({ id: c.id, transition: { type: x.id, duration: c.transition?.duration || 0.5 } })) }, `transition ${x.id}`);
            }}>
              <span className="fx-ico"><Shuffle size={11} /></span>
              <span>{lang === 'en' ? x.label : x.labelFr}</span>
              <span className="fx-meta">{x.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ tpl, project, onAdd }) {
  const t = useT();
  const lang = useLang();
  const [hover, setHover] = useState(false);
  const frameRef = useRef(null);
  const thumb = useThumb(tpl.id, tpl.addedAt || '');
  const W = project?.settings.width || 1920, H = project?.settings.height || 1080;
  useEffect(() => {
    if (!hover) return undefined;
    let raf;
    const t0 = performance.now();
    const dur = tpl.defaultDuration || 4;
    const tick = (now) => {
      const tt = ((now - t0) / 1000) % (dur + 0.6);
      try { frameRef.current?.contentWindow?.postMessage({ type: 'aicut:seek', t: Math.min(tt, dur) }, '*'); } catch { /* */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover, tpl]);
  const k = 150 / W;
  return (
    <div className="tpl-card" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-aicut-template', tpl.id)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onAdd} title={tpl.description}>
      <div className="tpl-thumb">
        {hover ? (
          <div className="tpl-live" style={{ width: W * k, height: H * k }}>
            <iframe ref={frameRef} title={tpl.id} sandbox="allow-scripts" src={`aicut://html/__tpl__/${encodeURIComponent(tpl.id)}?w=${W}&h=${H}`} style={{ width: W, height: H, transform: `scale(${k})` }} />
          </div>
        ) : thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="tpl-ph"><Sparkles size={16} /></span>}
        <span className="tpl-add"><Plus size={12} /></span>
        {tpl.user && (
          <button className="icon-btn xs tpl-del" title={t('remove')} onClick={async (e) => { e.stopPropagation(); await call('motion:remove', { id: tpl.id }); reloadTemplates(); }}><Trash2 size={11} /></button>
        )}
      </div>
      <div className="tpl-name">{tplName(tpl, lang)}</div>
    </div>
  );
}
