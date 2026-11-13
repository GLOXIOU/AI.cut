import React, { useEffect, useState } from 'react';
import { Film, Music, Image as ImageIcon, Sparkles, Square, Trash2, Scissors, Copy, Unlink, Captions, Settings2, FileText, Wand2, Camera } from 'lucide-react';
import { AUDIO_FX } from '@shared/audiofx.js';
import { useStore } from '../../app/store.js';
import { op, call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, useLang, tplName, paramLabel } from '../../app/i18n.js';
import { engineRef } from '../player/Player.jsx';
import { NumberField, Slider, Select, Toggle, ColorField, TextField, Section, Row } from '../ui/fields.jsx';
import { TRANSITIONS } from '@shared/transitions.js';
import { mediaById, COLOR_DEFAULTS, fmtTime, r4 } from '@shared/timeline.js';
import { ANIM_IN_IDS, ANIM_OUT_IDS, ANIM_LOOP_IDS, ANIM_LOOP, animCatalog, DEFAULT_IN_DURATION, DEFAULT_OUT_DURATION } from '@shared/anim.js';
import { cueWords, keywordFlags, resolveSubtitleStyle } from '@shared/subtitles.js';
import { emojiFor } from '@shared/keywords.js';
import { useTemplates } from '../panels/MotionPanel.jsx';
import { AnimGrid } from './AnimPicker.jsx';

const ICONS = { video: Film, audio: Music, image: ImageIcon, html: Sparkles, color: Square };

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const selectedCue = useStore((s) => s.selectedCue);
  if (!project) return null;
  if (selectedCue) return <CueEditor project={project} cueId={selectedCue} />;
  if (selection.length > 1) return <MultiInspector project={project} ids={selection} />;
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : null;
  if (!clip) return <ProjectInspector project={project} />;
  return <ClipInspector key={clip.id} project={project} clip={clip} />;
}

// live preview then commit
const live = (clip, patch) => engineRef.current?.setOverride(clip.id, patch);
const commit = async (clip, patch, label) => { await op('updateClip', { id: clip.id, ...patch }, label); engineRef.current?.setOverride(clip.id, null); };

function ClipInspector({ project, clip: c }) {
  const t = useT();
  const lang = useLang();
  const media = mediaById(project, c.mediaId);
  const Icon = ICONS[c.type] || Film;
  const visual = c.type !== 'audio';
  const hasAudio = c.type === 'audio' || (c.type === 'video' && media?.hasAudio);
  const color = { ...COLOR_DEFAULTS, ...(c.color || {}) };
  const setColor = (k, v, done) => {
    const nc = { ...color, [k]: v };
    if (done) commit(c, { color: nc }, 'color'); else live(c, { color: nc });
  };
  const crop = { top: 0, right: 0, bottom: 0, left: 0, ...(c.crop || {}) };
  const setCrop = (k, v, done) => { const nc = { ...crop, [k]: v }; if (done) commit(c, { crop: nc }, 'crop'); else live(c, { crop: nc }); };
  const ck = c.chromaKey;

  return (
    <div className="inspector">
      <div className="insp-head">
        <div className={`insp-icon t-${c.type}`}><Icon size={14} /></div>
        <div className="insp-title">
          <TextField value={c.name} onCommit={(v) => op('updateClip', { id: c.id, name: v }, 'rename')} />
          <div className="insp-sub">{t(`type_${c.type}`)}{media ? ` · ${media.name}` : ''}</div>
        </div>
      </div>
      <div className="insp-actions">
        <button className="btn sm" onClick={() => op('splitClip', { id: c.id, time: r4(playhead.time) }, 'split')}><Scissors size={12} /> {t('split')}</button>
        <button className="btn sm" onClick={() => op('duplicateClips', { ids: [c.id] }, 'duplicate')}><Copy size={12} /> {t('duplicate')}</button>
        {c.type === 'video' && media?.hasAudio && !c.muted && <button className="btn sm" onClick={() => op('detachAudio', { id: c.id }, 'detach audio')}><Unlink size={12} /> {t('detachAudio')}</button>}
        {c.type === 'video' && <button className="btn sm" title={t('freezeHint')} onClick={() => call('edit:freezeFrame', { clipId: c.id, time: Math.min(c.start + c.duration - 0.05, Math.max(c.start, playhead.time)), duration: 1.5 }).catch((e) => useStore.getState().toast('error', e.message))}><Camera size={12} /> {t('freezeFrame')}</button>}
        <button className="btn sm danger" title={t('delete')} onClick={() => op('removeClips', { ids: [c.id] }, 'delete')}><Trash2 size={12} /></button>
      </div>

      <Section title={t('clip')}>
        <Row>
          <NumberField label={t('start')} value={c.start} step={0.04} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, start: v }, 'move')} />
          <NumberField label={t('duration')} value={c.duration} step={0.04} min={0.04} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, duration: v }, 'duration')} />
        </Row>
        {(c.type === 'video' || c.type === 'audio') && (
          <Row>
            <NumberField label="In" value={c.in} step={0.04} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, in: v }, 'in point')} />
            <NumberField label={t('speed')} value={c.speed} step={0.05} min={0.1} max={16} suffix="×" onCommit={(v) => op('updateClip', { id: c.id, speed: v }, 'speed')} />
          </Row>
        )}
        <div className="insp-meta">{fmtTime(c.start)} → {fmtTime(c.start + c.duration)}{media?.duration ? ` · source ${fmtTime(c.in)}–${fmtTime(c.in + c.duration * c.speed)}` : ''}</div>
      </Section>

      {c.type === 'html' && <MotionParams clip={c} />}

      {visual && <AnimationSection clip={c} />}

      {visual && (
        <Section title={t('transform')} fx onReset={() => op('updateClip', { id: c.id, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false, crop: null }, 'reset transform')}>
          <Row>
            <NumberField label="X" value={c.x} step={1} onChange={(v) => live(c, { x: v })} onCommit={(v) => commit(c, { x: v }, 'position')} precision={0} suffix="px" />
            <NumberField label="Y" value={c.y} step={1} onChange={(v) => live(c, { y: v })} onCommit={(v) => commit(c, { y: v }, 'position')} precision={0} suffix="px" />
          </Row>
          <Row>
            <NumberField label={t('scale')} value={c.scale} step={0.01} min={0.01} onChange={(v) => live(c, { scale: v })} onCommit={(v) => commit(c, { scale: v }, 'scale')} />
            <NumberField label={t('rotation')} value={c.rotation} step={0.5} onChange={(v) => live(c, { rotation: v })} onCommit={(v) => commit(c, { rotation: v }, 'rotation')} suffix="°" precision={1} />
          </Row>
          <Slider label={t('opacity')} value={c.opacity} defaultValue={1} onChange={(v) => live(c, { opacity: v })} onCommit={(v) => commit(c, { opacity: v }, 'opacity')} format={(v) => `${Math.round(v * 100)}%`} />
          {c.type !== 'html' && c.type !== 'color' && (
            <Select label={t('fit')} value={c.fit} onChange={(v) => op('updateClip', { id: c.id, fit: v }, 'fit')} options={[{ value: 'contain', label: t('fitContain') }, { value: 'cover', label: t('fitCover') }, { value: 'stretch', label: t('fitStretch') }, { value: 'none', label: t('fitNone') }]} />
          )}
          <Row>
            <Toggle label={t('flipH')} value={c.flipH} onChange={(v) => op('updateClip', { id: c.id, flipH: v }, 'flip')} />
            <Toggle label={t('flipV')} value={c.flipV} onChange={(v) => op('updateClip', { id: c.id, flipV: v }, 'flip')} />
          </Row>
          <div className="sub-title">{t('crop')}</div>
          {['top', 'bottom', 'left', 'right'].map((k) => (
            <Slider key={k} label={t(`side_${k}`)} value={crop[k]} max={0.9} defaultValue={0} onChange={(v) => setCrop(k, v)} onCommit={(v) => setCrop(k, v, true)} format={(v) => `${Math.round(v * 100)}%`} />
          ))}
        </Section>
      )}

      {visual && <LayoutSection clip={c} />}

      {visual && <FrameLookSection clip={c} />}

      {visual && c.type !== 'color' && (
        <Section title={t('colorGrade')} fx defaultOpen={!!c.color} onReset={() => op('updateClip', { id: c.id, color: null }, 'reset color')}>
          <Slider label={t('brightness')} value={color.brightness} min={0} max={2} defaultValue={1} onChange={(v) => setColor('brightness', v)} onCommit={(v) => setColor('brightness', v, true)} />
          <Slider label={t('contrast')} value={color.contrast} min={0} max={2} defaultValue={1} onChange={(v) => setColor('contrast', v)} onCommit={(v) => setColor('contrast', v, true)} />
          <Slider label={t('saturation')} value={color.saturation} min={0} max={3} defaultValue={1} onChange={(v) => setColor('saturation', v)} onCommit={(v) => setColor('saturation', v, true)} />
          <Slider label={t('hue')} value={color.hue} min={-180} max={180} step={1} defaultValue={0} onChange={(v) => setColor('hue', v)} onCommit={(v) => setColor('hue', v, true)} format={(v) => `${Math.round(v)}°`} />
          <Slider label={t('bw')} value={color.grayscale} defaultValue={0} onChange={(v) => setColor('grayscale', v)} onCommit={(v) => setColor('grayscale', v, true)} />
          <Slider label={t('sepia')} value={color.sepia} defaultValue={0} onChange={(v) => setColor('sepia', v)} onCommit={(v) => setColor('sepia', v, true)} />
          <Slider label={t('invert')} value={color.invert} defaultValue={0} onChange={(v) => setColor('invert', v)} onCommit={(v) => setColor('invert', v, true)} />
          <Slider label={t('blur')} value={color.blur} min={0} max={40} step={0.5} defaultValue={0} onChange={(v) => setColor('blur', v)} onCommit={(v) => setColor('blur', v, true)} format={(v) => `${v}px`} />
          <div className="preset-chips">
            {[['cinema', t('lookCinema'), { contrast: 1.12, saturation: 0.85, brightness: 0.97 }], ['punchy', 'Punchy', { contrast: 1.18, saturation: 1.35 }], ['vintage', 'Vintage', { sepia: 0.35, contrast: 0.92, saturation: 0.8 }], ['bw', t('bw'), { grayscale: 1, contrast: 1.15 }], ['cold', t('lookCold'), { hue: -12, saturation: 0.9 }], ['warm', t('lookWarm'), { hue: 10, saturation: 1.1, brightness: 1.03 }]].map(([id, n, v]) => (
              <button key={id} className="chip" onClick={() => op('updateClip', { id: c.id, color: { ...COLOR_DEFAULTS, ...v } }, `look ${id}`)}>{n}</button>
            ))}
          </div>
        </Section>
      )}

      {visual && (
        <Section title={t('effects')} fx defaultOpen={!!(ck || c.vignette)}>
          <Toggle label={t('chromaKey')} value={!!ck} onChange={(v) => op('updateClip', { id: c.id, chromaKey: v ? { color: 'green', strength: 6, threshold: 0.08, despill: 0.5 } : null }, 'chroma key')} />
          {ck && (
            <>
              <Select label={t('keyColor')} value={ck.color} onChange={(v) => op('updateClip', { id: c.id, chromaKey: { ...ck, color: v } }, 'chroma key')} options={[{ value: 'green', label: t('green') }, { value: 'blue', label: t('blue') }]} />
              <Slider label={t('strength')} value={ck.strength} min={1} max={16} step={0.5} onChange={(v) => live(c, { chromaKey: { ...ck, strength: v } })} onCommit={(v) => commit(c, { chromaKey: { ...ck, strength: v } }, 'chroma key')} />
              <Slider label={t('threshold')} value={ck.threshold} min={-0.2} max={0.4} step={0.01} onChange={(v) => live(c, { chromaKey: { ...ck, threshold: v } })} onCommit={(v) => commit(c, { chromaKey: { ...ck, threshold: v } }, 'chroma key')} />
              <Slider label={t('despill')} value={ck.despill} onChange={(v) => live(c, { chromaKey: { ...ck, despill: v } })} onCommit={(v) => commit(c, { chromaKey: { ...ck, despill: v } }, 'chroma key')} />
            </>
          )}
          <Slider label={t('vignette')} value={c.vignette} defaultValue={0} onChange={(v) => live(c, { vignette: v })} onCommit={(v) => commit(c, { vignette: v }, 'vignette')} />
          <Row>
            <NumberField label={t('fadeInShort')} value={c.videoFadeIn} step={0.05} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, videoFadeIn: v }, 'video fade')} />
            <NumberField label={t('fadeOutShort')} value={c.videoFadeOut} step={0.05} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, videoFadeOut: v }, 'video fade')} />
          </Row>
        </Section>
      )}

      {visual && (
        <Section title={t('transitionIn')} fx defaultOpen={!!c.transition}>
          <Select value={c.transition?.type || 'none'} onChange={(v) => op('setTransition', { id: c.id, type: v, duration: c.transition?.duration || 0.5 }, 'transition')}
            options={[{ value: 'none', label: t('none') }, ...TRANSITIONS.map((x) => ({ value: x.id, label: lang === 'en' ? x.label : x.labelFr }))]} />
          {c.transition && <NumberField label={t('duration')} value={c.transition.duration} step={0.05} min={0.05} max={5} suffix="s" onCommit={(v) => op('setTransition', { id: c.id, type: c.transition.type, duration: v }, 'transition')} />}
        </Section>
      )}

      {visual && (
        <Section title={t('keyframes')} defaultOpen={!!c.keyframes}>
          <div className="preset-chips">
            {[['zoom-in', t('kfZoomIn')], ['zoom-out', t('kfZoomOut')], ['pan-left', 'Pan ←'], ['pan-right', 'Pan →'], ['shake', t('kfShake')], ['pulse', 'Pulse']].map(([p, l]) => (
              <button key={p} className="chip" onClick={() => op('animateClip', { id: c.id, preset: p }, `animate ${p}`)}>{l}</button>
            ))}
            {c.keyframes && <button className="chip danger" onClick={() => op('clearKeyframes', { id: c.id }, 'clear keyframes')}>{t('clear')}</button>}
          </div>
          {c.keyframes && <div className="insp-meta">{Object.entries(c.keyframes).map(([k, v]) => `${k}: ${v.length}`).join(' · ')}</div>}
        </Section>
      )}

      {hasAudio && (
        <Section title={t('audio')} fx>
          <Toggle label={t('mute')} value={c.muted} onChange={(v) => op('updateClip', { id: c.id, muted: v }, 'mute')} />
          <Slider label={t('volume')} value={c.volume} min={0} max={3} step={0.01} defaultValue={1} onChange={(v) => live(c, { volume: v })} onCommit={(v) => commit(c, { volume: v }, 'volume')} format={(v) => (v <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`)} />
          <Select label={t('voiceEffect')} value={c.audioFx?.preset || ''} onChange={(v) => op('updateClip', { id: c.id, audioFx: v ? { preset: v } : null }, 'voice effect')}
            options={[{ value: '', label: t('none') }, ...Object.entries(AUDIO_FX).map(([k, v]) => ({ value: k, label: lang === 'en' ? v.en : v.label }))]} />
          <Row>
            <NumberField label={t('fadeIn')} value={c.fadeIn} step={0.1} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, fadeIn: v }, 'fade')} />
            <NumberField label={t('fadeOut')} value={c.fadeOut} step={0.1} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, fadeOut: v }, 'fade')} />
          </Row>
          {c.keyframes?.volume && <div className="insp-meta">{t('volumeAutomated', { n: c.keyframes.volume.length })} <button className="link" onClick={() => op('clearKeyframes', { id: c.id, property: 'volume' }, 'clear volume')}>{t('remove')}</button></div>}
        </Section>
      )}

      {c.type === 'color' && (
        <Section title={t('color')}>
          <ColorField label={t('fill')} value={c.fill} onChange={(v) => op('updateClip', { id: c.id, fill: v }, 'fill')} />
        </Section>
      )}
    </div>
  );
}

/** Entrance / exit / continuous animation of a visual clip ("B-roll" & "animated still image"). */
function AnimationSection({ clip: c, ids }) {
  const t = useT();
  const [slot, setSlot] = useState('in');
  const targets = ids || [c.id];
  const a = c?.anim || {};
  const set = (patch, label) => op('setAnimation', { ids: targets, ...patch }, label);
  const cur = a[slot]?.type || null;
  return (
    <Section title={t('animation')} fx defaultOpen right={c?.anim ? <button className="icon-btn xs" title={t('clear')} onClick={() => set({ clear: true }, 'clear animation')}><Trash2 size={11} /></button> : null}>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        {[['in', t('animIn')], ['out', t('animOut')], ['loop', t('animLoop')]].map(([id, l]) => (
          <button key={id} className={slot === id ? 'on' : ''} onClick={() => setSlot(id)}>{l}{a[id] ? ' •' : ''}</button>
        ))}
      </div>
      {slot === 'loop' && (
        <div className="hint" style={{ padding: 0 }}><Wand2 size={12} /> {t('stillHint')}</div>
      )}
      <AnimGrid slot={slot} value={cur} onPick={(id) => set({ [slot]: id || 'none' }, `animation ${slot}`)} />
      {slot !== 'loop' && a[slot] && (
        <Slider label={t('duration')} value={a[slot].duration} min={0.1} max={3} step={0.05} defaultValue={slot === 'in' ? DEFAULT_IN_DURATION : DEFAULT_OUT_DURATION}
          onCommit={(v) => set({ [slot]: { type: a[slot].type, duration: v } }, 'animation duration')} format={(v) => `${v.toFixed(2)} s`} />
      )}
      {slot === 'loop' && a.loop && (
        <>
          <Slider label={t('intensity')} value={a.loop.amount ?? 1} min={0} max={3} step={0.05} defaultValue={1}
            onCommit={(v) => set({ loop: { ...a.loop, amount: v } }, 'loop intensity')} format={(v) => `×${v.toFixed(2)}`} />
          {!ANIM_LOOP[a.loop.type]?.inner && (
            <Slider label={t('speed')} value={a.loop.speed ?? 1} min={0.2} max={3} step={0.05} defaultValue={1}
              onCommit={(v) => set({ loop: { ...a.loop, speed: v } }, 'loop speed')} format={(v) => `×${v.toFixed(2)}`} />
          )}
        </>
      )}
    </Section>
  );
}

const LAYOUTS = [
  ['full', 'layoutFull', [[0, 0, 100, 100]]], ['fit', 'layoutFit', [[8, 18, 84, 64]]],
  ['pip-tl', 'layoutPipTl', [[6, 8, 36, 34]]], ['pip-tr', 'layoutPipTr', [[58, 8, 36, 34]]],
  ['pip-bl', 'layoutPipBl', [[6, 58, 36, 34]]], ['pip-br', 'layoutPipBr', [[58, 58, 36, 34]]],
  ['split-left', 'layoutSplitL', [[0, 0, 50, 100]]], ['split-right', 'layoutSplitR', [[50, 0, 50, 100]]],
  ['split-top', 'layoutSplitT', [[0, 0, 100, 50]]], ['split-bottom', 'layoutSplitB', [[0, 50, 100, 50]]],
  ['blur-fill', 'layoutBlurFill', [[0, 0, 100, 100, 'blur'], [10, 22, 80, 56]]],
];

/** Layout presets: picture-in-picture, split screen, blurred background. */
function LayoutSection({ clip: c }) {
  const t = useT();
  return (
    <Section title={t('layout')} defaultOpen={false}>
      <div className="layout-grid">
        {LAYOUTS.map(([id, label, rects]) => (
          <button key={id} className="layout-btn" title={t(label)} onClick={() => op('layoutClip', { id: c.id, preset: id }, `layout ${id}`)}>
            <span className="layout-ico">{rects.map(([x, y, w, h, k], i) => <i key={i} className={k || ''} style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }} />)}</span>
            <span className="lbl">{t(label)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Rounded corners, border, drop shadow. */
function FrameLookSection({ clip: c, ids }) {
  const t = useT();
  const targets = ids || [c.id];
  const set = (patch, label) => op('setFrameLook', { ids: targets, ...patch }, label);
  const b = c?.border, s = c?.shadow;
  return (
    <Section title={t('frameLook')} fx defaultOpen={!!(c?.radius || b || s)}>
      <div className="preset-chips">
        <button className="chip" onClick={() => set({ radius: 0, border: null, shadow: null }, 'frame none')}>{t('none')}</button>
        <button className="chip" onClick={() => set({ radius: 28, border: null, shadow: { blur: 40, x: 0, y: 14, opacity: 0.45, color: '#000000' } }, 'frame card')}>{t('lookCard')}</button>
        <button className="chip" onClick={() => set({ radius: 18, border: { width: 10, color: '#ffffff' }, shadow: { blur: 30, x: 0, y: 10, opacity: 0.4, color: '#000000' } }, 'frame polaroid')}>{t('lookPhoto')}</button>
        <button className="chip" onClick={() => set({ radius: 60, border: null, shadow: null }, 'frame round')}>{t('lookRound')}</button>
      </div>
      <Slider label={t('radius')} value={c?.radius || 0} min={0} max={300} step={1} defaultValue={0}
        onChange={(v) => c && live(c, { radius: v })} onCommit={(v) => { set({ radius: v }, 'radius'); if (c) engineRef.current?.setOverride(c.id, null); }} format={(v) => `${Math.round(v)} px`} />
      <Toggle label={t('border')} value={!!b} onChange={(v) => set({ border: v ? { width: 8, color: '#ffffff' } : null }, 'border')} />
      {b && (
        <>
          <Slider label={t('thickness')} value={b.width} min={1} max={60} step={1} onCommit={(v) => set({ border: { ...b, width: v } }, 'border')} format={(v) => `${Math.round(v)} px`} />
          <ColorField label={t('color')} value={b.color} onChange={(v) => set({ border: { ...b, color: v } }, 'border color')} />
        </>
      )}
      <Toggle label={t('shadow')} value={!!s} onChange={(v) => set({ shadow: v ? { blur: 40, x: 0, y: 14, opacity: 0.45, color: '#000000' } : null }, 'shadow')} />
      {s && (
        <>
          <Slider label={t('softness')} value={s.blur} min={0} max={160} step={1} onCommit={(v) => set({ shadow: { ...s, blur: v } }, 'shadow')} format={(v) => `${Math.round(v)} px`} />
          <Slider label={t('distance')} value={s.y} min={-80} max={120} step={1} onCommit={(v) => set({ shadow: { ...s, y: v } }, 'shadow')} format={(v) => `${Math.round(v)} px`} />
          <Slider label={t('opacity')} value={s.opacity} min={0} max={1} step={0.01} onCommit={(v) => set({ shadow: { ...s, opacity: v } }, 'shadow')} format={(v) => `${Math.round(v * 100)}%`} />
          <ColorField label={t('color')} value={s.color} onChange={(v) => set({ shadow: { ...s, color: v } }, 'shadow color')} />
        </>
      )}
    </Section>
  );
}

function MotionParams({ clip: c }) {
  const t = useT();
  const lang = useLang();
  const pl = (p) => paramLabel(p.label || p.name, lang);
  const templates = useTemplates();
  const tpl = c.html?.template ? templates.find((x) => x.id === c.html.template) : null;
  const params = { ...(Object.fromEntries((tpl?.params || []).map((p) => [p.name, p.default]))), ...(c.html?.params || {}) };
  const setP = (name, v) => op('updateClip', { id: c.id, params: { [name]: v } }, `motion ${name}`);
  const [code, setCode] = useState(c.html?.code || null);
  useEffect(() => setCode(c.html?.code || null), [c.html]);
  if (c.html?.file) return <Section title={t('htmlFile')}><div className="insp-meta" title={c.html.file}>{c.html.file.split(/[\\/]/).pop()}</div></Section>;
  if (!tpl && !c.html?.code) return null;
  return (
    <Section title={tpl ? `Motion · ${tplName(tpl, lang)}` : 'Motion HTML'} fx>
      {tpl && (tpl.params || []).map((p) => {
        const v = params[p.name];
        if (p.type === 'color') return <ColorField key={p.name} label={pl(p)} value={v} onChange={(x) => setP(p.name, x)} />;
        if (p.type === 'number') return <NumberField key={p.name} label={pl(p)} value={v} step={p.step || 1} min={p.min ?? -Infinity} max={p.max ?? Infinity} onCommit={(x) => setP(p.name, x)} />;
        if (p.type === 'select') return <Select key={p.name} label={pl(p)} value={v} options={p.options} onChange={(x) => setP(p.name, x)} />;
        if (p.type === 'boolean') return <Toggle key={p.name} label={pl(p)} value={!!v} onChange={(x) => setP(p.name, x)} />;
        if (p.type === 'font') return <Select key={p.name} label={pl(p)} value={v} options={(useStore.getState().info?.fonts || []).map((f) => f.family)} onChange={(x) => setP(p.name, x)} />;
        if (p.type === 'image' || p.type === 'file') {
          return (
            <div key={p.name} className="text-row">
              <span className="sel-label">{pl(p)}</span>
              <div className="file-pick">
                <input value={v || ''} onChange={() => {}} readOnly />
                <button className="btn sm" onClick={async () => { const [f] = await call('dialog:openFiles', { multi: false }); if (f) setP(p.name, `aicut://file/${encodeURIComponent(f)}`); }}>…</button>
              </div>
            </div>
          );
        }
        return <TextField key={p.name} label={pl(p)} value={v} multiline={p.type === 'textarea' || String(v || '').length > 40} onCommit={(x) => setP(p.name, x)} />;
      })}
      {code && (
        <div className="code-edit">
          {['html', 'css', 'js'].map((k) => (
            <label key={k} className="text-row"><span className="sel-label">{k.toUpperCase()}</span>
              <textarea className="code" rows={k === 'html' ? 6 : 5} value={code[k] || ''} onChange={(e) => setCode({ ...code, [k]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} />
            </label>
          ))}
          <button className="btn primary sm" onClick={() => op('updateClip', { id: c.id, htmlCode: code }, 'edit motion code')}>{t('applyCode')}</button>
        </div>
      )}
    </Section>
  );
}

function MultiInspector({ project, ids }) {
  const t = useT();
  const clips = project.clips.filter((c) => ids.includes(c.id));
  const visual = clips.filter((c) => c.type !== 'audio');
  return (
    <div className="inspector">
      <div className="insp-head"><div className="insp-title"><b>{t('nSelected', { n: clips.length })}</b><div className="insp-sub">{t('multiHint')}</div></div></div>
      <div className="insp-actions">
        <button className="btn sm" onClick={() => op('duplicateClips', { ids }, 'duplicate')}>{t('duplicate')}</button>
        <button className="btn sm" onClick={() => op('updateClips', { items: clips.map((c) => ({ id: c.id, muted: !clips.every((x) => x.muted) })) }, 'mute')}>{t('muteToggle')}</button>
        <button className="btn sm" onClick={() => op('updateClips', { items: visual.map((c) => ({ id: c.id, transition: { type: 'fade', duration: 0.4 } })) }, 'transitions')}>{t('crossfades')}</button>
        <button className="btn sm danger" onClick={() => op('removeClips', { ids }, 'delete')}>{t('delete')}</button>
        <button className="btn sm danger" onClick={() => op('removeClips', { ids, ripple: true }, 'ripple delete')}>{t('rippleDelete')}</button>
      </div>
      {visual.length > 0 && <AnimationSection clip={visual[0]} ids={visual.map((c) => c.id)} />}
      {visual.length > 0 && <FrameLookSection clip={visual[0]} ids={visual.map((c) => c.id)} />}
    </div>
  );
}

function CueEditor({ project, cueId }) {
  const t = useT();
  const q = project.subtitles.cues.find((x) => x.id === cueId);
  if (!q) return <ProjectInspector project={project} />;
  const st = resolveSubtitleStyle(project.subtitles.style);
  const flags = keywordFlags(project.subtitles.cues, st.kwDensity).get(q.id) || [];
  const words = cueWords(q);
  const toggle = (i) => {
    // cycle: keyword ↔ not keyword (explicit choice)
    const keywords = words.map((w, j) => (j === i ? !flags[j] : flags[j])).map((v, j) => (v ? j : -1)).filter((j) => j >= 0);
    op('setSubtitleKeywords', { items: [{ cueId: q.id, keywords }] }, 'keyword');
  };
  const autoEmoji = words.map((w, i) => (flags[i] ? emojiFor(w.text) : null)).find(Boolean);
  return (
    <div className="inspector">
      <div className="insp-head"><div className="insp-icon t-subs"><Captions size={14} /></div><div className="insp-title"><b>{t('cue')}</b><div className="insp-sub">{fmtTime(q.start)} → {fmtTime(q.end)}</div></div></div>
      <Section title={t('text')}>
        <TextField value={q.text} multiline onCommit={(v) => op('updateSubtitleCues', { items: [{ id: q.id, text: v }] }, 'edit subtitle')} />
        <Row>
          <NumberField label={t('start')} value={q.start} step={0.04} suffix="s" onCommit={(v) => op('updateSubtitleCues', { items: [{ id: q.id, start: v }] }, 'subtitle timing')} />
          <NumberField label={t('end')} value={q.end} step={0.04} suffix="s" onCommit={(v) => op('updateSubtitleCues', { items: [{ id: q.id, end: v }] }, 'subtitle timing')} />
        </Row>
        <button className="btn sm danger" style={{ alignSelf: 'flex-start' }} onClick={() => { op('removeSubtitleCues', { ids: [q.id] }, 'delete subtitle'); useStore.setState({ selectedCue: null }); }}><Trash2 size={12} /> {t('delete')}</button>
      </Section>
      <Section title={t('importantWords')}>
        <div className="dim small">{t('importantWordsHint')}</div>
        <div className="word-chips">
          {words.map((w, i) => (
            <button key={i} className={`word-chip ${flags[i] ? 'kw' : ''} ${w.k === 0 || w.k === 1 ? 'forced' : ''}`} onClick={() => toggle(i)} title={w.s != null ? `score ${Math.round(w.s * 100)}` : ''}>{w.text}</button>
          ))}
        </div>
        <TextField label={autoEmoji ? t('autoEmojiLabel', { e: autoEmoji }) : 'Emoji'} value={q.emoji || ''} placeholder="🔥" onCommit={(v) => op('updateSubtitleCues', { items: [{ id: q.id, emoji: v || null }] }, 'emoji')} />
        <div className="insp-meta">{t('modeNow')} : <b>{t(`mode_${st.mode}`)}</b></div>
      </Section>
      <div className="insp-meta pad">{t('subStyleHint')}</div>
    </div>
  );
}

function ProjectInspector({ project }) {
  const t = useT();
  const s = project.settings;
  const ab = s.autoBroll || {};
  const info = useStore((st) => st.info);
  const lang = useStore((st) => st.lang);
  const [credits, setCredits] = useState('');
  useEffect(() => { call('project:credits').then(setCredits).catch(() => {}); }, [project.media.length, project.clips.length]);
  const cat = animCatalog(lang);
  const setAB = (patch) => op('setProjectSettings', { autoBroll: patch }, 'auto b-roll');
  return (
    <div className="inspector">
      <div className="insp-head"><div className="insp-icon"><Settings2 size={14} /></div><div className="insp-title"><b>{t('projectSettings')}</b><div className="insp-sub">{t('nothingSelected')}</div></div></div>
      <Section title={t('sequence')}>
        <TextField label={t('projectName')} value={project.name} onCommit={(v) => op('setProjectSettings', { name: v }, 'rename project')} />
        <div className="sub-title">{t('resolution')} — {s.width}×{s.height}</div>
        <div className="preset-chips">
          {Object.entries(info?.presets || {}).map(([k, v]) => (
            <button key={k} className={`chip ${v.width === s.width && v.height === s.height ? 'on' : ''}`} title={v.label} onClick={() => op('setProjectSettings', { preset: k }, 'resolution')}>{k}</button>
          ))}
        </div>
        <Row>
          <NumberField label={t('widthShort')} value={s.width} step={2} min={16} precision={0} onCommit={(v) => op('setProjectSettings', { width: v }, 'resolution')} />
          <NumberField label={t('heightShort')} value={s.height} step={2} min={16} precision={0} onCommit={(v) => op('setProjectSettings', { height: v }, 'resolution')} />
        </Row>
        <Select label={t('fps')} value={String(s.fps)} options={['24', '25', '30', '50', '60']} onChange={(v) => op('setProjectSettings', { fps: Number(v) }, 'fps')} />
        <ColorField label={t('background')} value={s.background} onChange={(v) => op('setProjectSettings', { background: v }, 'background')} />
        <Slider label={t('masterVolume')} value={s.masterVolume ?? 1} min={0} max={2} defaultValue={1} onCommit={(v) => op('setProjectSettings', { masterVolume: v }, 'master volume')} />
        <Toggle label={t('normalize')} value={!!s.normalizeLoudness} onChange={(v) => op('setProjectSettings', { normalizeLoudness: v }, 'loudness')} />
      </Section>
      <Section title={t('autoBroll')} defaultOpen={!!ab.enabled}>
        <div className="dim small">{t('autoBrollHint')}</div>
        <Toggle label={t('enabled')} value={!!ab.enabled} onChange={(v) => setAB({ enabled: v })} />
        <Select label={t('animIn')} value={ab.in || ''} onChange={(v) => setAB({ in: v })} options={[{ value: '', label: t('none') }, ...cat.in.map((x) => ({ value: x.id, label: x.label }))]} />
        <Select label={t('animOut')} value={ab.out || ''} onChange={(v) => setAB({ out: v })} options={[{ value: '', label: t('none') }, ...cat.out.map((x) => ({ value: x.id, label: x.label }))]} />
        <Select label={t('imagesLoop')} value={ab.imageLoop || ''} onChange={(v) => setAB({ imageLoop: v })} options={[{ value: '', label: t('none') }, ...cat.loop.map((x) => ({ value: x.id, label: x.label }))]} />
        <Select label={t('videosLoop')} value={ab.videoLoop || ''} onChange={(v) => setAB({ videoLoop: v })} options={[{ value: '', label: t('none') }, ...cat.loop.filter((x) => !x.inner).map((x) => ({ value: x.id, label: x.label }))]} />
        <Slider label={t('radius')} value={ab.radius || 0} min={0} max={120} step={1} defaultValue={0} onCommit={(v) => setAB({ radius: v })} format={(v) => `${Math.round(v)} px`} />
        <Toggle label={t('shadow')} value={!!ab.shadow} onChange={(v) => setAB({ shadow: v })} />
      </Section>
      <Section title={t('notes')} defaultOpen={!!project.notes}>
        <TextField value={project.notes} multiline placeholder={t('notesPlaceholder')} onCommit={(v) => op('setNotes', { notes: v }, 'notes')} />
      </Section>
      {credits && (
        <Section title={t('credits')}>
          <pre className="credits">{credits}</pre>
          <button className="btn sm" onClick={() => { navigator.clipboard.writeText(credits); useStore.getState().toast('success', t('copied')); }}><FileText size={12} /> {t('copy')}</button>
        </Section>
      )}
    </div>
  );
}

export { ANIM_IN_IDS, ANIM_OUT_IDS, ANIM_LOOP_IDS };
