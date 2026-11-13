import React, { useState } from 'react';
import { Loader2, Zap, Eraser, ZoomIn, AudioLines, Wand2, Music2, ListOrdered, Mic, Layers, Rocket, Podcast, Camera, Clapperboard, Copy } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';
import { Slider, Select, Toggle } from '../ui/fields.jsx';
import { animCatalog } from '@shared/anim.js';
import { AUDIO_FX } from '@shared/audiofx.js';

function useRun() {
  const [busy, setBusy] = useState(null);
  const run = async (id, method, args, ok) => {
    setBusy(id);
    try {
      const r = await call(method, args);
      const msg = ok ? ok(r) : null;
      if (msg) useStore.getState().toast('success', msg);
      return r;
    } catch (e) { useStore.getState().toast('error', e.message); return null; }
    finally { setBusy(null); }
  };
  return [busy, run];
}

const RECIPES = [
  ['short', Rocket, 'recipeShort', 'recipeShortHint'],
  ['podcast', Podcast, 'recipePodcast', 'recipePodcastHint'],
  ['vlog', Camera, 'recipeVlog', 'recipeVlogHint'],
  ['cinematic', Clapperboard, 'recipeCinematic', 'recipeCinematicHint'],
];

/** Automatic tools: one-click recipes, cleanup, dynamism, sound, rhythm, chapters. */
export function AutoPanel() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const [busy, run] = useRun();
  const [zoom, setZoom] = useState({ amount: 0.14, every: 5, style: 'cut' });
  const [broll, setBroll] = useState({ in: 'pop', out: 'fade', imageLoop: 'living', videoLoop: '', radius: 0, shadow: false });
  const [voice, setVoice] = useState('voice');
  const [beats, setBeats] = useState({ downbeats: false, every: 1 });
  const [chapters, setChapters] = useState(null);
  const cat = animCatalog(lang);
  const spin = (id, Icon) => (busy === id ? <Loader2 size={12} className="spin" /> : <Icon size={12} />);

  return (
    <div className="panel auto-panel">
      <div className="panel-head"><span className="panel-title">{t('autoTools')}</span></div>

      <div className="cat-title" style={{ padding: '0 10px' }}>{t('recipes')}</div>
      <div className="recipe-grid">
        {RECIPES.map(([id, Icon, l, h]) => (
          <button key={id} className="recipe" disabled={!!busy} onClick={() => run(`r-${id}`, 'edit:recipe', { id }, (r) => `${t(l)} : ${r.done.length} ${t('stepsDone')}${r.skipped.length ? ` · ${r.skipped.length} ${t('stepsSkipped')} (${r.skipped.map((s) => s.split(' — ')[0]).join(', ')})` : ''}`)}>
            <span className="recipe-ico">{busy === `r-${id}` ? <Loader2 size={15} className="spin" /> : <Icon size={15} />}</span>
            <b>{t(l)}</b><span>{t(h)}</span>
          </button>
        ))}
      </div>
      <div className="hint">{t('recipesHint')}</div>

      <div className="auto-card">
        <div className="title"><Eraser size={13} /> {t('cleanup')}</div>
        <div className="row">
          <button className="btn sm" disabled={!!busy} onClick={() => run('sil', 'edit:removeSilences', {}, (r) => t('silencesCut', { n: r.ranges || 0, s: r.secondsRemoved || 0 }))}>{spin('sil', Zap)} {t('removeSilences')}</button>
          <button className="btn sm" disabled={!!busy} onClick={() => run('fil', 'edit:removeFillers', {}, (r) => t('fillersRemoved', { n: r.removed }))}>{spin('fil', Eraser)} {t('removeFillers')}</button>
        </div>
      </div>

      <div className="auto-card">
        <div className="title"><ZoomIn size={13} /> {t('dynamicZooms')}</div>
        <div className="dim small">{t('dynamicZoomsHint')}</div>
        <Slider label={t('intensity')} value={zoom.amount} min={0.05} max={0.35} step={0.01} onCommit={(v) => setZoom({ ...zoom, amount: v })} format={(v) => `+${Math.round(v * 100)}%`} />
        <Slider label={t('frequency')} value={zoom.every} min={2} max={12} step={0.5} onCommit={(v) => setZoom({ ...zoom, every: v })} format={(v) => t('everyNs', { n: v })} />
        <Select label={t('style')} value={zoom.style} onChange={(v) => setZoom({ ...zoom, style: v })} options={[{ value: 'cut', label: t('zoomCut') }, { value: 'smooth', label: t('zoomSmooth') }]} />
        <button className="btn primary sm" disabled={!!busy} onClick={() => run('zoom', 'edit:autoZooms', zoom, (r) => t('zoomsAdded', { n: r.zooms }))}>{spin('zoom', ZoomIn)} {t('addZooms')}</button>
      </div>

      <div className="auto-card">
        <div className="title"><Layers size={13} /> {t('animateAllBroll')}</div>
        <Select label={t('animIn')} value={broll.in} onChange={(v) => setBroll({ ...broll, in: v })} options={[{ value: 'none', label: t('none') }, ...cat.in.map((x) => ({ value: x.id, label: x.label }))]} />
        <Select label={t('animOut')} value={broll.out} onChange={(v) => setBroll({ ...broll, out: v })} options={[{ value: 'none', label: t('none') }, ...cat.out.map((x) => ({ value: x.id, label: x.label }))]} />
        <Select label={t('imagesLoop')} value={broll.imageLoop} onChange={(v) => setBroll({ ...broll, imageLoop: v })} options={[{ value: '', label: t('none') }, ...cat.loop.map((x) => ({ value: x.id, label: x.label }))]} />
        <Select label={t('videosLoop')} value={broll.videoLoop} onChange={(v) => setBroll({ ...broll, videoLoop: v })} options={[{ value: '', label: t('none') }, ...cat.loop.filter((x) => !x.inner).map((x) => ({ value: x.id, label: x.label }))]} />
        <Slider label={t('radius')} value={broll.radius} min={0} max={120} step={1} onCommit={(v) => setBroll({ ...broll, radius: v })} format={(v) => `${Math.round(v)} px`} />
        <Toggle label={t('shadow')} value={broll.shadow} onChange={(v) => setBroll({ ...broll, shadow: v })} />
        <button className="btn primary sm" disabled={!!busy} onClick={() => run('broll', 'edit:animateBroll', broll, (r) => t('brollAnimated', { n: r.clips }))}>{spin('broll', Wand2)} {t('apply')}</button>
      </div>

      <div className="auto-card">
        <div className="title"><Mic size={13} /> {t('voices')}</div>
        <Select label={t('voiceEffect')} value={voice} onChange={setVoice} options={Object.entries(AUDIO_FX).map(([k, v]) => ({ value: k, label: lang === 'en' ? v.en : v.label }))} />
        <div className="row">
          <button className="btn sm" disabled={!!busy} onClick={() => run('voice', 'edit:enhanceVoices', { preset: voice }, (r) => t('voicesDone', { n: r.clips }))}>{spin('voice', Mic)} {t('applyToSpeech')}</button>
          <button className="btn sm quiet" disabled={!!busy} onClick={() => run('voice0', 'edit:enhanceVoices', { preset: null }, () => t('voicesReset'))}>{t('remove')}</button>
        </div>
      </div>

      <div className="auto-card">
        <div className="title"><AudioLines size={13} /> {t('soundDesign')}</div>
        <div className="row">
          <button className="btn sm" disabled={!!busy} onClick={() => run('sfx', 'edit:autoSfx', { keywords: true }, (r) => t('autoSfxDone', { n: r.added }))}>{spin('sfx', AudioLines)} {t('autoSfx')}</button>
          <button className="btn sm" disabled={!!busy} onClick={() => run('duck', 'edit:duckMusic', {}, (r) => t('ducked', { n: r.musicClips }))}>{spin('duck', Wand2)} Ducking</button>
        </div>
      </div>

      <div className="auto-card">
        <div className="title"><Music2 size={13} /> {t('rhythm')}</div>
        <div className="dim small">{t('rhythmHint')}</div>
        <Toggle label={t('downbeatsOnly')} value={beats.downbeats} onChange={(v) => setBeats({ ...beats, downbeats: v })} />
        <Select label={t('density')} value={String(beats.every)} onChange={(v) => setBeats({ ...beats, every: Number(v) })} options={[{ value: '1', label: t('everyBeat') }, { value: '2', label: t('every2') }, { value: '4', label: t('every4') }]} />
        <button className="btn sm" disabled={!!busy} onClick={() => run('beats', 'edit:beatMarkers', beats, (r) => t('beatMarkersDone', { n: r.markers, bpm: Math.round(r.bpm) }))}>{spin('beats', Music2)} {t('beatMarkers')}</button>
      </div>

      <div className="auto-card">
        <div className="title"><Camera size={13} /> {t('freezeFrame')}</div>
        <div className="dim small">{t('freezeHint')}</div>
        <button className="btn sm" disabled={!!busy} onClick={() => run('freeze', 'edit:freezeFrame', { time: playhead.time, duration: 1.5 }, () => t('freezeDone'))}>{spin('freeze', Camera)} {t('freezeAtPlayhead')}</button>
      </div>

      <div className="auto-card">
        <div className="title"><ListOrdered size={13} /> {t('ytChapters')}</div>
        <div className="dim small">{t('ytChaptersHint')}</div>
        <button className="btn sm" onClick={async () => { const r = await run('chap', 'edit:chapters', {}); if (r) setChapters(r); }}>{spin('chap', ListOrdered)} {t('generate')}</button>
        {chapters && (
          <>
            <pre className="credits">{chapters.text}</pre>
            {chapters.warnings?.length > 0 && <div className="warn-text small">{chapters.warnings.join(' ')}</div>}
            <button className="btn sm" onClick={() => { navigator.clipboard.writeText(chapters.text); useStore.getState().toast('success', t('copied')); }}><Copy size={12} /> {t('copy')}</button>
          </>
        )}
      </div>
    </div>
  );
}
