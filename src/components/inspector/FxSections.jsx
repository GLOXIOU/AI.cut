// Inspector sections for the effects added in Nov. 2026: Lumetri-like grade, adjustment layers (blur / pixelate /
// mask), attaching a clip to a tracking, audio effect chains (clips and tracks), video tools (tracking, cutout).
import React, { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Power, Crosshair, ScanFace, Scissors, Type, EyeOff, Sun } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { op, call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT, useLang } from '../../app/i18n.js';
import { engineRef } from '../player/Player.jsx';
import { NumberField, Slider, Select, Toggle, Section, Row } from '../ui/fields.jsx';
import { COLOR_DEFAULTS, fmtTime } from '@shared/timeline.js';
import { LOOKS } from '@shared/grade.js';
import { AFX, AFX_PRESETS, expandAfx, normalizeAfx } from '@shared/dsp.js';
import { ANCHORS } from '@shared/fx.js';

const live = (clip, patch) => engineRef.current?.setOverride(clip.id, patch);
const commit = async (clip, patch, label) => { await op('updateClip', { id: clip.id, ...patch }, label); engineRef.current?.setOverride(clip.id, null); };
const pct = (v) => `${Math.round(v * 100)}%`;
const sgn = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

// ------------------------------------------------------------------------------------------------ grade
export function GradeSection({ clip: c }) {
  const t = useT();
  const lang = useLang();
  const color = { ...COLOR_DEFAULTS, ...(c.color || {}) };
  const set = (k, v, done) => {
    const nc = { ...color, [k]: v };
    if (done) commit(c, { color: nc }, 'color'); else live(c, { color: nc });
  };
  const S = (k, label, min, max, step, format, def = COLOR_DEFAULTS[k]) => (
    <Slider key={k} label={label} value={color[k]} min={min} max={max} step={step} defaultValue={def} onChange={(v) => set(k, v)} onCommit={(v) => set(k, v, true)} format={format} />
  );
  return (
    <Section title={t('colorGrade')} fx defaultOpen={!!c.color} onReset={() => op('updateClip', { id: c.id, color: null }, 'reset color')}>
      <div className="preset-chips">
        {Object.entries(LOOKS).map(([id, l]) => (
          <button key={id} className="chip" title={lang === 'en' ? l.en : l.fr} onClick={() => op('setColorGrade', { ids: [c.id], look: id }, `look ${id}`)}>{lang === 'en' ? l.en : l.fr}</button>
        ))}
      </div>
      <div className="sub-title">{t('gradeLight')}</div>
      {S('exposure', t('exposure'), -3, 3, 0.05, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`)}
      {S('contrast', t('contrast'), 0, 2, 0.01)}
      {S('highlights', t('highlights'), -1, 1, 0.01, sgn)}
      {S('shadows', t('shadows'), -1, 1, 0.01, sgn)}
      {S('whites', t('whites'), -1, 1, 0.01, sgn)}
      {S('blacks', t('blacks'), -1, 1, 0.01, sgn)}
      <div className="sub-title">{t('gradeBalance')}</div>
      {S('temperature', t('temperature'), -1, 1, 0.01, sgn)}
      {S('tint', t('tint'), -1, 1, 0.01, sgn)}
      {S('saturation', t('saturation'), 0, 3, 0.01)}
      {S('hue', t('hue'), -180, 180, 1, (v) => `${Math.round(v)}°`)}
      <div className="sub-title">{t('gradeCreative')}</div>
      {S('fade', t('fadeLook'), 0, 1, 0.01, pct)}
      {S('splitShadow', t('splitShadows'), 0, 1, 0.01, pct)}
      {color.splitShadow > 0 && S('splitShadowHue', t('hueShadows'), 0, 360, 1, (v) => `${Math.round(v)}°`)}
      {S('splitHighlight', t('splitHighlights'), 0, 1, 0.01, pct)}
      {color.splitHighlight > 0 && S('splitHighlightHue', t('hueHighlights'), 0, 360, 1, (v) => `${Math.round(v)}°`)}
      {S('brightness', t('brightness'), 0, 2, 0.01)}
      {S('grayscale', t('bw'), 0, 1, 0.01)}
      {S('sepia', t('sepia'), 0, 1, 0.01)}
      {S('invert', t('invert'), 0, 1, 0.01)}
      {S('blur', t('blur'), 0, 40, 0.5, (v) => `${v}px`)}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ adjustment layer
export function AdjustSection({ clip: c, project }) {
  const t = useT();
  const fx = { blur: 0, pixelate: 0, ...(c.fx || {}) };
  const m = c.mask;
  const setFx = (k, v, done) => { const n = { ...fx, [k]: v }; if (done) commit(c, { fx: n }, 'adjust fx'); else live(c, { fx: n }); };
  const setMask = (patch, done) => {
    const n = { shape: 'ellipse', cx: 0.5, cy: 0.5, w: 0.35, h: 0.45, feather: 30, invert: false, ...(m || {}), ...patch };
    if (done) commit(c, { mask: n }, 'mask'); else live(c, { mask: n });
  };
  const trackings = project.trackings || [];
  return (
    <>
      <Section title={t('adjustLayer')} fx>
        <div className="dim small">{t('adjustHint')}</div>
        <Slider label={t('blur')} value={fx.blur} min={0} max={120} step={0.5} defaultValue={0} onChange={(v) => setFx('blur', v)} onCommit={(v) => setFx('blur', v, true)} format={(v) => `${v}px`} />
        <Slider label={t('pixelate')} value={fx.pixelate} min={0} max={120} step={1} defaultValue={0} onChange={(v) => setFx('pixelate', v)} onCommit={(v) => setFx('pixelate', v, true)} format={(v) => (v > 1 ? `${v}px` : '—')} />
        <Slider label={t('opacity')} value={c.opacity} defaultValue={1} onChange={(v) => live(c, { opacity: v })} onCommit={(v) => commit(c, { opacity: v }, 'opacity')} format={pct} />
        <Row>
          <NumberField label={t('fadeInShort')} value={c.videoFadeIn} step={0.05} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, videoFadeIn: v }, 'fade')} />
          <NumberField label={t('fadeOutShort')} value={c.videoFadeOut} step={0.05} min={0} suffix="s" onCommit={(v) => op('updateClip', { id: c.id, videoFadeOut: v }, 'fade')} />
        </Row>
        <div className="preset-chips">
          <button className="chip" onClick={() => op('updateClip', { id: c.id, fx: { blur: 18 }, mask: null }, 'blur all')}>{t('blurAll')}</button>
          <button className="chip" onClick={() => op('updateClip', { id: c.id, fx: { pixelate: 28 }, mask: { shape: 'ellipse', cx: 0.5, cy: 0.4, w: 0.18, h: 0.3, feather: 12 } }, 'censor')}>{t('censorZone')}</button>
          <button className="chip" onClick={() => op('updateClip', { id: c.id, fx: null, color: { brightness: 0.4, saturation: 0.7 }, mask: { shape: 'ellipse', cx: 0.5, cy: 0.45, w: 0.4, h: 0.6, feather: 120, invert: true } }, 'spotlight')}>{t('spotlight')}</button>
          <button className="chip" onClick={() => op('updateClip', { id: c.id, fx: { blur: 14 }, mask: { shape: 'rect', cx: 0.5, cy: 0.5, w: 0.6, h: 0.6, feather: 160, invert: true } }, 'tilt blur')}>{t('dreamEdges')}</button>
        </div>
      </Section>
      <Section title={t('mask')} fx defaultOpen={!!m} right={m ? <button className="icon-btn xs" title={t('remove')} onClick={() => op('updateClip', { id: c.id, mask: null }, 'remove mask')}><Trash2 size={11} /></button> : null}>
        {!m && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setMask({}, true)}><Plus size={12} /> {t('addMask')}</button>}
        {m && (
          <>
            <Select label={t('shape')} value={m.shape} onChange={(v) => setMask({ shape: v }, true)} options={[{ value: 'ellipse', label: t('ellipse') }, { value: 'rect', label: t('rectangle') }]} />
            <Toggle label={t('invertMask')} value={!!m.invert} onChange={(v) => setMask({ invert: v }, true)} />
            <Slider label={t('feather')} value={m.feather} min={0} max={400} step={1} defaultValue={20} onChange={(v) => setMask({ feather: v })} onCommit={(v) => setMask({ feather: v }, true)} format={(v) => `${v}px`} />
            {!m.follow && (
              <>
                <Slider label="X" value={m.cx} min={-0.2} max={1.2} step={0.005} onChange={(v) => setMask({ cx: v })} onCommit={(v) => setMask({ cx: v }, true)} format={pct} />
                <Slider label="Y" value={m.cy} min={-0.2} max={1.2} step={0.005} onChange={(v) => setMask({ cy: v })} onCommit={(v) => setMask({ cy: v }, true)} format={pct} />
              </>
            )}
            <Slider label={t('widthShort')} value={m.w} min={0.01} max={1.5} step={0.005} onChange={(v) => setMask({ w: v })} onCommit={(v) => setMask({ w: v }, true)} format={pct} />
            <Slider label={t('heightShort')} value={m.h} min={0.01} max={1.5} step={0.005} onChange={(v) => setMask({ h: v })} onCommit={(v) => setMask({ h: v }, true)} format={pct} />
            <Select label={t('followTracking')} value={m.follow?.tracking || ''} onChange={(v) => setMask({ follow: v ? { tracking: v, size: true } : undefined }, true)}
              options={[{ value: '', label: t('none') }, ...trackings.map((x) => ({ value: x.id, label: `${x.kind === 'face' ? '🙂' : '🎯'} ${x.name}` }))]} />
            <div className="dim small">{t('maskGizmoHint')}</div>
          </>
        )}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ follow a tracking
export function FollowSection({ clip: c, project }) {
  const t = useT();
  const trackings = project.trackings || [];
  if (!trackings.length && !c.follow) return null;
  const f = c.follow;
  const set = (patch) => op('updateClip', { id: c.id, follow: patch === null ? null : { ...(f || {}), ...patch } }, 'follow');
  return (
    <Section title={t('followSection')} fx defaultOpen={!!f}>
      <Select label={t('followTracking')} value={f?.tracking || ''} onChange={(v) => set(v ? { tracking: v } : null)}
        options={[{ value: '', label: t('none') }, ...trackings.map((x) => ({ value: x.id, label: `${x.kind === 'face' ? '🙂' : '🎯'} ${x.name}` }))]} />
      {f && (
        <>
          <Select label={t('anchor')} value={f.anchor || 'center'} onChange={(v) => set({ anchor: v })} options={ANCHORS.map((a) => ({ value: a, label: t(`anchor_${a}`) }))} />
          <Row>
            <NumberField label={t('offsetX')} value={f.offsetX || 0} step={2} precision={0} suffix="px" onCommit={(v) => set({ offsetX: v })} />
            <NumberField label={t('offsetY')} value={f.offsetY || 0} step={2} precision={0} suffix="px" onCommit={(v) => set({ offsetY: v })} />
          </Row>
          <Toggle label={t('followScale')} value={!!f.scale} onChange={(v) => set({ scale: v })} />
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ audio effects
/** Effect chain editor. list = [{type, ...}], onChange(list, label, final) */
export function AfxEditor({ list, onChange, onLive }) {
  const t = useT();
  const lang = useLang();
  const items = list || [];
  const [adding, setAdding] = useState('');
  const name = (type) => (lang === 'en' ? AFX[type]?.en : AFX[type]?.fr) || type;
  const upd = (i, patch, final = true) => {
    const next = items.map((x, j) => (j === i ? { ...x, ...patch } : x));
    if (final) onChange(next, `audio fx ${items[i].type}`); else onLive?.(next);
  };
  const move = (i, d) => { const n = items.slice(); const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n, 'audio fx order'); };
  return (
    <div className="afx">
      <div className="preset-chips">
        {Object.entries(AFX_PRESETS).map(([id, p]) => (
          <button key={id} className="chip" onClick={() => onChange(normalizeAfx(expandAfx([id])), `audio preset ${id}`)}>{lang === 'en' ? p.en : p.fr}</button>
        ))}
      </div>
      {items.map((it, i) => (
        <div key={`${i}_${it.type}`} className={`afx-item ${it.bypass ? 'off' : ''}`}>
          <div className="afx-head">
            <button className={`icon-btn xs ${it.bypass ? 'off' : 'on'}`} title={t('bypass')} onClick={() => upd(i, { bypass: !it.bypass })}><Power size={11} /></button>
            <span className="afx-name">{name(it.type)}</span>
            <span className="spacer" />
            {i > 0 && <button className="icon-btn xs" onClick={() => move(i, -1)}><ChevronUp size={11} /></button>}
            {i < items.length - 1 && <button className="icon-btn xs" onClick={() => move(i, 1)}><ChevronDown size={11} /></button>}
            <button className="icon-btn xs" title={t('remove')} onClick={() => onChange(items.filter((_, j) => j !== i), 'remove audio fx')}><Trash2 size={11} /></button>
          </div>
          {Object.entries(AFX[it.type]?.params || {}).map(([k, [def, min, max, unit]]) => (
            <Slider key={k} label={t(`afx_${k}`)} value={it[k] ?? def} min={min} max={max} step={(max - min) / 200} defaultValue={def}
              onChange={(v) => upd(i, { [k]: v }, false)} onCommit={(v) => upd(i, { [k]: v })}
              format={(v) => (unit ? `${Math.round(v * 10) / 10} ${unit}` : max <= 1 && min >= -1 ? `${Math.round(v * 100)}%` : `${Math.round(v * 100) / 100}`)} />
          ))}
        </div>
      ))}
      <div className="afx-add">
        <select value={adding} onChange={(e) => { const v = e.target.value; setAdding(''); if (v) onChange([...(items || []), { type: v }], `add ${v}`); }} onKeyDown={(e) => e.stopPropagation()}>
          <option value="">{t('addEffect')}</option>
          {Object.keys(AFX).map((k) => <option key={k} value={k}>{name(k)}</option>)}
        </select>
        {items.length > 0 && <button className="btn sm" onClick={() => onChange(null, 'clear audio fx')}>{t('clear')}</button>}
      </div>
    </div>
  );
}

export function ClipAfxSection({ clip: c }) {
  const t = useT();
  const stems = (keep) => call('stems:start', { clipId: c.id, keep }).then(() => useStore.getState().toast('info', t('stemsStarted'))).catch((e) => useStore.getState().toast('error', e.message));
  return (
    <Section title={t('audioEffects')} fx defaultOpen={!!c.afx}>
      <div className="preset-chips">
        <button className="chip" title={t('stemsHint')} onClick={() => stems('both')}>🎙🎵 {t('separateStems')}</button>
        <button className="chip" onClick={() => stems('voice')}>🎙 {t('keepVoice')}</button>
        <button className="chip" onClick={() => stems('music')}>🎵 {t('keepMusic')}</button>
      </div>
      <AfxEditor list={c.afx} onChange={(list, label) => op('updateClip', { id: c.id, afx: list }, label).then(() => engineRef.current?.setOverride(c.id, null))}
        onLive={(list) => live(c, { afx: normalizeAfx(list) })} />
      <div className="dim small">{t('afxHint')}</div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ track inspector
export function TrackInspector({ project, trackId }) {
  const t = useT();
  const tr = project.tracks.find((x) => x.id === trackId);
  if (!tr) return null;
  const upd = (patch, label) => op('updateTrack', { id: tr.id, ...patch }, label);
  const n = project.clips.filter((c) => c.trackId === tr.id).length;
  return (
    <div className="inspector">
      <div className="insp-head"><div className="insp-icon"><Sun size={14} /></div><div className="insp-title"><b>{t('trackTitle', { name: tr.name })}</b><div className="insp-sub">{t('trackSub', { n })}</div></div></div>
      <Section title={t('mixer')}>
        <Slider label={t('volume')} value={tr.volume ?? 1} min={0} max={2} step={0.01} defaultValue={1} onCommit={(v) => upd({ volume: v }, 'track volume')} format={(v) => (v <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`)} />
        <Slider label={t('pan')} value={tr.pan || 0} min={-1} max={1} step={0.01} defaultValue={0} onCommit={(v) => upd({ pan: v }, 'pan')} format={(v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`)} />
        <Row>
          <Toggle label={t('mute')} value={!!tr.muted} onChange={(v) => upd({ muted: v }, 'mute')} />
          <Toggle label="Solo" value={!!tr.solo} onChange={(v) => upd({ solo: v }, 'solo')} />
        </Row>
      </Section>
      <Section title={t('trackEffects')} fx>
        <div className="dim small">{t('trackFxHint')}</div>
        <AfxEditor list={tr.afx} onChange={(list, label) => upd({ afx: list }, label)} />
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ video tools
// Split in three blocks so the dockable panels (Tracking, Cutout, Video tools) can show them on their own;
// the inspector still shows them together in one section.
function useRunner() {
  const [busy, setBusy] = useState(null);
  const toast = (lvl, m) => useStore.getState().toast(lvl, m);
  const run = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { toast('error', e.message); } setBusy(null); };
  return { busy, run, toast };
}
const clipTime = (c) => Math.min(c.start + c.duration - 0.05, Math.max(c.start, playhead.time));

/** Track an object / a face in a video clip, then attach a label, blur, pixelate, spotlight or cutout to it. */
export function TrackingTools({ clip: c, project }) {
  const t = useT();
  const { busy, run, toast } = useRunner();
  const trackings = (project.trackings || []).filter((x) => x.mediaId === c.mediaId);
  return (
    <>
      <div className="preset-chips">
        <button className="chip" onClick={() => window.dispatchEvent(new CustomEvent('aicut:track-mode', { detail: { clipId: c.id } }))}><Crosshair size={11} /> {t('trackObject')}</button>
        <button className="chip" disabled={busy === 'face'} onClick={() => run('face', async () => { await call('track:start', { clipId: c.id, time: clipTime(c), face: true, name: t('faceName') }); toast('info', t('trackingStarted')); })}><ScanFace size={11} /> {t('trackFace')}</button>
      </div>
      {trackings.map((x) => (
        <div key={x.id} className="trk-row">
          <span className="trk-name">{x.kind === 'face' ? '🙂' : '🎯'} {x.name}</span>
          <span className="dim small">{fmtTime(x.points?.[0]?.[0] || 0)}–{fmtTime(x.points?.[x.points.length - 1]?.[0] || 0)}</span>
          <div className="preset-chips">
            <button className="chip" onClick={() => run('l', () => call('track:attach', { tracking: x.id, label: t('labelDefault') }))}><Type size={11} /> {t('addLabel')}</button>
            <button className="chip" onClick={() => run('b', () => call('track:effect', { tracking: x.id, mode: 'blur' }))}><EyeOff size={11} /> {t('blurIt')}</button>
            <button className="chip" onClick={() => run('p', () => call('track:effect', { tracking: x.id, mode: 'pixelate' }))}>▦ {t('pixelateIt')}</button>
            <button className="chip" onClick={() => run('s', () => call('track:effect', { tracking: x.id, mode: 'spotlight' }))}><Sun size={11} /> {t('spotlight')}</button>
            <button className="chip" onClick={() => run('co', async () => { await call('cutout:start', { clipId: c.id, tracking: x.id }); toast('info', t('cutoutStarted')); })}><Scissors size={11} /> {t('cutoutIt')}</button>
            <button className="chip" title={t('fixTrackingHint')} onClick={() => window.dispatchEvent(new CustomEvent('aicut:track-mode', { detail: { clipId: c.id, fix: x.id } }))}><Crosshair size={11} /> {t('fixTracking')}</button>
            <button className="chip danger" onClick={() => op('removeTrackings', { ids: [x.id] }, 'remove tracking')}><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
    </>
  );
}

/** Cut the person (or a picked object) out of a video clip. */
export function CutoutStart({ clip: c }) {
  const t = useT();
  const { busy, run, toast } = useRunner();
  return (
    <div className="preset-chips">
      <button className="chip" disabled={busy === 'cut'} onClick={() => run('cut', async () => { await call('cutout:start', { clipId: c.id }); toast('info', t('cutoutStarted')); })}><Scissors size={11} /> {t('cutoutPerson')}</button>
      <button className="chip" title={t('cutoutObjectHint')} onClick={() => window.dispatchEvent(new CustomEvent('aicut:track-mode', { detail: { clipId: c.id, purpose: 'cutout' } }))}><Scissors size={11} /> {t('cutoutObject')}</button>
    </div>
  );
}

/** Auto reframe, reverse, stabilise, smooth slow motion. */
export function VideoEditTools({ clip: c }) {
  const t = useT();
  const { busy, run, toast } = useRunner();
  return (
    <div className="preset-chips">
      <button className="chip" disabled={busy === 'reframe'} title={t('autoReframeHint')} onClick={() => run('reframe', async () => { await call('edit:autoReframe', { clipId: c.id, time: clipTime(c) }); toast('success', t('reframed')); })}>{busy === 'reframe' ? '…' : '⤢'} {t('autoReframe')}</button>
      <button className="chip" onClick={() => run('rev', async () => { await call('edit:derive', { clipId: c.id, kind: 'reverse' }); toast('info', t('renderStarted')); })}>⏪ {t('reverseClip')}</button>
      <button className="chip" onClick={() => run('stab', async () => { await call('edit:derive', { clipId: c.id, kind: 'stabilize' }); toast('info', t('renderStarted')); })}>🎥 {t('stabilize')}</button>
      <button className="chip" title={t('slowmoHint')} onClick={() => run('slow', async () => { await call('edit:derive', { clipId: c.id, kind: 'slowmo', factor: c.speed < 1 ? c.speed : 0.5 }); toast('info', t('renderStarted')); })}>🐢 {t('smoothSlowmo')} ×{c.speed < 1 ? c.speed : 0.5}</button>
    </div>
  );
}

export function VideoTools({ clip: c, project }) {
  const t = useT();
  const hasTrackings = (project.trackings || []).some((x) => x.mediaId === c.mediaId);
  return (
    <Section title={t('trackingCutout')} fx defaultOpen={hasTrackings}>
      <div className="dim small">{t('trackingHint')}</div>
      <CutoutStart clip={c} />
      <VideoEditTools clip={c} />
      <TrackingTools clip={c} project={project} />
    </Section>
  );
}

/** Cutout clip: put text / a photo behind the subject. */
export function CutoutTools({ clip: c }) {
  const t = useT();
  const [text, setText] = useState(t('behindDefault'));
  if (!c.cutoutOf) return null;
  return (
    <Section title={t('behindSubject')} fx>
      <div className="dim small">{t('behindHint')}</div>
      <div className="field-row">
        <input className="text-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn sm primary" onClick={() => call('cutout:behind', { cutoutClipId: c.id, text }).catch((e) => useStore.getState().toast('error', e.message))}><Type size={12} /> {t('addText')}</button>
      </div>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={async () => {
        const [f] = await call('dialog:openFiles', { multi: false, filters: [{ name: 'Images / vidéos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm'] }] });
        if (!f) return;
        const [mediaId] = await call('media:import', { paths: [f] });
        call('cutout:behind', { cutoutClipId: c.id, mediaId, scale: 0.6 }).catch((e) => useStore.getState().toast('error', e.message));
      }}><Plus size={12} /> {t('addImageBehind')}</button>
    </Section>
  );
}
