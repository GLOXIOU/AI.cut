import React, { useEffect, useRef, useState } from 'react';
import { Captions, Wand2, Loader2, FileUp, FileDown, Eye, EyeOff, Trash2, Bot, Sparkles } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call, op } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, presetText } from '../../app/i18n.js';
import { NumberField, Slider, Select, Toggle, ColorField, Section, Row } from '../ui/fields.jsx';
import {
  SUBTITLE_PRESETS, SUBTITLE_CATEGORIES, drawSubtitles, resolveSubtitleStyle, subtitleFontSpecs, keywordFlags,
  SUBTITLE_HIGHLIGHTS, SUBTITLE_ANIMATIONS, KEYWORD_ANIMATIONS, SUBTITLE_BACKGROUNDS,
} from '@shared/subtitles.js';
import { fmtTime } from '@shared/timeline.js';

// preview sentence of the style thumbnails (keywords: k = 1)
const SAMPLE_CUES = {
  fr: [{
    id: 'sample', start: 0, end: 3, text: 'Ce secret change tout',
    words: [{ text: 'Ce', start: 0, end: 0.4, k: 0 }, { text: 'secret', start: 0.4, end: 1.0, k: 1 }, { text: 'change', start: 1.0, end: 1.6, k: 0 }, { text: 'tout', start: 1.6, end: 2.4, k: 1 }],
  }],
  en: [{
    id: 'sample', start: 0, end: 3, text: 'This secret changes everything',
    words: [{ text: 'This', start: 0, end: 0.4, k: 0 }, { text: 'secret', start: 0.4, end: 1.0, k: 1 }, { text: 'changes', start: 1.0, end: 1.6, k: 0 }, { text: 'everything', start: 1.6, end: 2.4, k: 1 }],
  }],
};

function PresetThumb({ id, active, onClick }) {
  const ref = useRef(null);
  const lang = useStore((s) => s.lang);
  useEffect(() => {
    const cv = ref.current;
    const W = 1920, H = 1080, k = 160 / W;
    const dpr = window.devicePixelRatio || 1;
    cv.width = 160 * dpr; cv.height = 90 * dpr;
    const ctx = cv.getContext('2d');
    const base = SUBTITLE_PRESETS[id];
    const style = { preset: id, position: 'center', offsetY: base.emojis ? 0.06 : 0, maxWidth: 0.96, size: base.size * 2.5, strokeWidth: (base.strokeWidth || 0) * 2, shadowBlur: (base.shadowBlur || 0) * 1.5 };
    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
      g.addColorStop(0, '#41464f'); g.addColorStop(1, '#1f2227');
      ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
      drawSubtitles(ctx, SAMPLE_CUES[lang] || SAMPLE_CUES.en, style, 0.8, W, H, null);
    };
    draw();
    Promise.all(subtitleFontSpecs(style).map((s) => document.fonts.load(s))).then(draw).catch(() => {});
  }, [id, lang]);
  const p = SUBTITLE_PRESETS[id];
  const { label, hint } = presetText(id, p, lang);
  return (
    <button className={`preset-thumb ${active ? 'on' : ''}`} onClick={onClick} title={hint || label}>
      <canvas ref={ref} style={{ width: 160, height: 90 }} />
      <span>{label}{hint ? <span className="pt-hint"> · {hint}</span> : null}</span>
    </button>
  );
}

const MODES = [['all', 'modeAll', 'modeAllHint'], ['emphasis', 'modeEmphasis', 'modeEmphasisHint'], ['keywords', 'modeKeywords', 'modeKeywordsHint']];

export function SubtitlesPanel() {
  const t = useT();
  const project = useStore((s) => s.project);
  const info = useStore((s) => s.info);
  const copilot = useStore((s) => s.copilot);
  const [busy, setBusy] = useState(false);
  const [maxWords, setMaxWords] = useState(null);
  useEffect(() => { if (!copilot) call('copilot:state').then((s) => useStore.setState({ copilot: s })).catch(() => {}); }, []);
  if (!project) return null;
  const subs = project.subtitles;
  const st = resolveSubtitleStyle(subs.style);
  const setStyle = (patch, label = 'subtitle style') => op('setSubtitleStyle', { style: patch }, label);
  const fonts = (info?.fonts || []).map((f) => f.family);
  const flags = st.mode !== 'all' && subs.cues.length ? keywordFlags(subs.cues, st.kwDensity) : null;

  const generate = async () => {
    setBusy(true);
    try {
      const r = await call('subtitles:generate', { preset: subs.style.preset, ...(maxWords ? { maxWords } : {}) });
      useStore.getState().toast(r.warnings?.length ? 'warning' : 'success', `${t('subsGenerated', { n: r.cues, w: r.words })}${r.warnings?.length ? ' ' + r.warnings.join(' ') : ''}`);
    } catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(false);
  };
  const importSrt = async () => {
    const [f] = await call('dialog:openFiles', { multi: false, filters: [{ name: 'SRT / VTT', extensions: ['srt', 'vtt'] }] });
    if (f) call('ai:call', { name: 'subtitles_file', args: { action: 'import', path: f } }).catch((e) => useStore.getState().toast('error', e.message));
  };
  const exportSrt = async () => {
    const r = await call('ai:call', { name: 'subtitles_file', args: { action: 'export', format: 'srt' } }).catch((e) => useStore.getState().toast('error', e.message));
    if (r?.json?.path) useStore.getState().toast('success', `SRT : ${r.json.path}`, { path: r.json.path });
  };
  const askAi = async () => {
    try {
      await call('copilot:send', { text: t('askAiKeywordsPrompt') });
      useStore.setState({ rightTab: 'ai' });
    } catch (e) { useStore.getState().toast('error', e.message); }
  };
  const redetect = async () => {
    try { await call('subtitles:rescore'); useStore.getState().toast('success', t('keywordsRedetected')); } catch (e) { useStore.getState().toast('error', e.message); }
  };
  const kwColors = Array.isArray(st.kwColors) && st.kwColors.length ? st.kwColors : null;

  return (
    <div className="panel subs-panel">
      <div className="panel-head">
        <span className="panel-title">{t('subtitles')} <span className="dim">· {subs.cues.length}</span></span>
        <div className="panel-actions">
          <button className="icon-btn" title={subs.enabled ? t('hide') : t('show')} onClick={() => op('setSubtitlesEnabled', { enabled: !subs.enabled }, 'toggle subtitles')}>{subs.enabled ? <Eye size={14} /> : <EyeOff size={14} />}</button>
          <button className="icon-btn" title={t('importSrt')} onClick={importSrt}><FileUp size={14} /></button>
          <button className="icon-btn" title={t('exportSrt')} onClick={exportSrt} disabled={!subs.cues.length}><FileDown size={14} /></button>
        </div>
      </div>
      <div className="subs-top">
        <Row>
          <button className="btn primary" onClick={generate} disabled={busy}>{busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} {t('generateSubtitles')}</button>
          <NumberField label={t('wordsPerCue')} value={maxWords ?? st.maxWords} step={1} min={1} max={20} precision={0} onCommit={(v) => { setMaxWords(v); setStyle({ maxWords: v }); }} />
        </Row>
        <div className="dim small">{t('subsFromTimeline')}</div>
      </div>

      <div className="section-label">{t('displayMode')}</div>
      <div className="mode-switch">
        {MODES.map(([id, l, h]) => (
          <button key={id} className={`mode-btn ${st.mode === id ? 'on' : ''}`} onClick={() => setStyle({ mode: id }, `subtitle mode ${id}`)}><b>{t(l)}</b><span>{t(h)}</span></button>
        ))}
      </div>
      {st.mode !== 'all' && (
        <div className="ai-box">
          <div className="title"><Sparkles size={13} /> {t('smartSubs')}</div>
          <Slider label={t('kwDensity')} value={st.kwDensity} min={0.05} max={0.6} step={0.01} onCommit={(v) => setStyle({ kwDensity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Row>
            <button className="btn sm" onClick={redetect} disabled={!subs.cues.length}><Wand2 size={12} /> {t('redetect')}</button>
            <button className="btn sm" onClick={askAi} disabled={!subs.cues.length || !copilot?.available} title={copilot?.available ? '' : t('askAiUnavailable')}><Bot size={12} /> {t('askAi')}</button>
          </Row>
          <div className="dim small">{t('kwManualHint')}</div>
        </div>
      )}

      {SUBTITLE_CATEGORIES.map(([cat, fr]) => {
        const ids = Object.keys(SUBTITLE_PRESETS).filter((k) => (SUBTITLE_PRESETS[k].cat || 'shorts') === cat);
        if (!ids.length) return null;
        return (
          <div key={cat}>
            <div className="cat-title" style={{ padding: '4px 10px 0' }}>{t(`subsCat_${cat}`)}</div>
            <div className="preset-grid">
              {ids.map((id) => <PresetThumb key={id} id={id} active={subs.style.preset === id} onClick={() => op('setSubtitleStyle', { preset: id }, `preset ${id}`)} />)}
            </div>
          </div>
        );
      })}

      {st.mode !== 'all' && (
        <Section title={t('keywordStyle')} fx>
          {kwColors ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {kwColors.map((c, i) => <input key={i} type="color" value={c} onChange={(e) => setStyle({ kwColors: kwColors.map((x, j) => (j === i ? e.target.value : x)) })} style={{ width: 28, height: 22, padding: 1 }} />)}
              <button className="chip" onClick={() => setStyle({ kwColors: null, kwColor: kwColors[0] })}>{t('singleColor')}</button>
            </div>
          ) : (
            <Row>
              <ColorField label={t('color')} value={st.kwColor} onChange={(v) => setStyle({ kwColor: v })} />
              <button className="chip" style={{ flex: 'none' }} onClick={() => setStyle({ kwColors: [st.kwColor, '#4ADE80', '#F87171'] })}>{t('multiColor')}</button>
            </Row>
          )}
          <Slider label={t('size')} value={st.kwScale} min={1} max={1.8} step={0.02} onCommit={(v) => setStyle({ kwScale: v })} format={(v) => `×${v.toFixed(2)}`} />
          <Select label={t('font')} value={st.kwFont || ''} options={[{ value: '', label: t('sameFont') }, ...fonts.map((f) => ({ value: f, label: f }))]} onChange={(v) => setStyle({ kwFont: v })} />
          <Select label={t('animation')} value={st.kwAnim} options={KEYWORD_ANIMATIONS.map((a) => ({ value: a, label: t(`kwAnim_${a}`) }))} onChange={(v) => setStyle({ kwAnim: v })} />
          <Toggle label={t('kwBox')} value={!!st.kwBox} onChange={(v) => setStyle({ kwBox: v })} />
          {st.kwBox && <ColorField label={t('boxColor')} value={st.kwBoxColor} onChange={(v) => setStyle({ kwBoxColor: v })} />}
          <Toggle label={t('autoEmojis')} value={!!st.emojis} onChange={(v) => setStyle({ emojis: v })} />
          {st.mode === 'keywords' && <Slider label={t('kwHold')} value={st.kwHold} min={0.15} max={1.5} step={0.05} onCommit={(v) => setStyle({ kwHold: v })} format={(v) => `${v.toFixed(2)} s`} />}
        </Section>
      )}

      <Section title={t('style')} fx defaultOpen={false}>
        <Select label={t('font')} value={st.font} options={fonts.length ? fonts : [st.font]} onChange={(v) => setStyle({ font: v })} />
        <Row>
          <NumberField label={t('size')} value={st.size} step={2} min={10} max={300} precision={0} onCommit={(v) => setStyle({ size: v })} />
          <NumberField label={t('weight')} value={st.weight} step={100} min={100} max={900} precision={0} onCommit={(v) => setStyle({ weight: v })} />
        </Row>
        <Toggle label={t('uppercase')} value={st.uppercase} onChange={(v) => setStyle({ uppercase: v })} />
        <ColorField label={t('color')} value={st.color} onChange={(v) => setStyle({ color: v })} />
        <ColorField label={t('secondLine')} value={st.secondLineColor || ''} onChange={(v) => setStyle({ secondLineColor: v })} />
        <Select label={t('highlight')} value={st.highlight} onChange={(v) => setStyle({ highlight: v })} options={SUBTITLE_HIGHLIGHTS.map((h) => ({ value: h, label: t(`hl_${h}`) }))} />
        {st.highlight !== 'none' && st.highlight !== 'dim' && <ColorField label={t('activeWordColor')} value={st.highlightColor} onChange={(v) => setStyle({ highlightColor: v })} />}
        {(st.highlight === 'box' || st.highlight === 'pill' || st.highlight === 'marker') && <ColorField label={t('boxColor')} value={st.highlightBoxColor} onChange={(v) => setStyle({ highlightBoxColor: v })} />}
        <Row>
          <NumberField label={t('outline')} value={st.strokeWidth} step={1} min={0} max={30} precision={1} onCommit={(v) => setStyle({ strokeWidth: v })} />
          <ColorField label="" value={st.strokeColor} onChange={(v) => setStyle({ strokeColor: v })} />
        </Row>
        <Row>
          <NumberField label={t('shadow')} value={st.shadowBlur} step={1} min={0} max={60} precision={0} onCommit={(v) => setStyle({ shadowBlur: v })} />
          <NumberField label="Y" value={st.shadowY} step={1} min={-30} max={30} precision={0} onCommit={(v) => setStyle({ shadowY: v })} />
        </Row>
        <Toggle label={t('background')} value={!!st.background} onChange={(v) => setStyle({ background: v ? { color: 'rgba(0,0,0,0.7)', padding: 16, radius: 12, mode: 'line' } : null })} />
        {st.background && (
          <>
            <Select label={t('bgMode')} value={st.background.mode || 'line'} onChange={(v) => setStyle({ background: { ...st.background, mode: v } })} options={SUBTITLE_BACKGROUNDS.map((b) => ({ value: b, label: t(`bg_${b}`) }))} />
            <ColorField label={t('bgColor')} value={st.background.color} onChange={(v) => setStyle({ background: { ...st.background, color: v } })} />
          </>
        )}
        <Select label={t('position')} value={st.position} onChange={(v) => setStyle({ position: v })} options={[{ value: 'bottom', label: t('pos_bottom') }, { value: 'center', label: t('pos_center') }, { value: 'top', label: t('pos_top') }]} />
        <Slider label={t('offset')} value={st.offsetY} min={st.position === 'center' ? -0.4 : 0} max={0.45} step={0.005} onCommit={(v) => setStyle({ offsetY: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label={t('maxWidth')} value={st.maxWidth} min={0.3} max={1} step={0.01} onCommit={(v) => setStyle({ maxWidth: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Select label={t('animation')} value={st.animation} onChange={(v) => setStyle({ animation: v })} options={SUBTITLE_ANIMATIONS.map((a) => ({ value: a, label: t(`sa_${a}`) }))} />
        <Toggle label={t('wordReveal')} value={!!st.wordReveal} onChange={(v) => setStyle({ wordReveal: v })} />
        <Slider label={t('tilt')} value={st.tilt || 0} min={-8} max={8} step={0.5} defaultValue={0} onCommit={(v) => setStyle({ tilt: v })} format={(v) => `${v}°`} />
      </Section>

      <Section title={`${t('cues')} (${subs.cues.length})`} defaultOpen={false} right={subs.cues.length ? <button className="icon-btn xs" title={t('deleteAll')} onClick={() => op('clearSubtitles', {}, 'clear subtitles')}><Trash2 size={11} /></button> : null}>
        <div className="cue-list">
          {subs.cues.map((q) => (
            <div key={q.id} className="cue-row" onClick={() => { playhead.set(q.start, 'ui'); useStore.setState({ selectedCue: q.id, selection: [], rightTab: 'inspector' }); }}>
              <span className="md-time">{fmtTime(q.start)}</span>
              {flags ? (q.words || q.text.split(/\s+/).map((text) => ({ text }))).map((w, i) => <span key={i} className={flags.get(q.id)?.[i] ? 'kw' : ''}>{w.text} </span>) : <span>{q.text}</span>}
            </div>
          ))}
          {!subs.cues.length && <div className="dim small"><Captions size={12} /> {t('noSubsYet')}</div>}
        </div>
      </Section>
    </div>
  );
}
