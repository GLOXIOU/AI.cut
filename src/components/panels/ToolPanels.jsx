// Dockable tool panels: each one shows a single feature (tracking, mask, colour, cutout, video tools, animation,
// audio effects) for the clip selected in the timeline, so it can live anywhere in a workspace layout.
import React from 'react';
import { Crosshair, CircleDashed, Palette, Scissors, Clapperboard, Sparkles, AudioLines, Plus, Camera, Droplets, ScanFace, EyeOff } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { op, call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';
import { GradeSection, AdjustSection, FollowSection, ClipAfxSection, TrackInspector, TrackingTools, CutoutStart, VideoEditTools, CutoutTools } from '../inspector/FxSections.jsx';
import { AnimationSection } from '../inspector/Inspector.jsx';
import { mediaById } from '@shared/timeline.js';

function useClip() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const clip = project && selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : null;
  return { project, clip, selection };
}
const isVisual = (c) => c && c.type !== 'audio' && c.type !== 'adjust';

function Empty({ icon: Icon, text }) {
  return <div className="tool-empty"><Icon size={22} strokeWidth={1.6} /><p>{text}</p></div>;
}
function ClipHead({ clip }) {
  const t = useT();
  return <div className="tool-clip"><span className={`tool-dot t-${clip.type}`} /><b>{clip.name}</b><span className="dim small">{t(`type_${clip.type}`)}</span></div>;
}

export function TrackingPanel() {
  const t = useT();
  const { project, clip } = useClip();
  if (!project) return null;
  if (!clip || !isVisual(clip)) return <Empty icon={Crosshair} text={t('pickVideoClip')} />;
  return (
    <div className="tool-panel">
      <ClipHead clip={clip} />
      {clip.type === 'video' ? (
        <>
          <div className="dim small">{t('trackingPanelHint')}</div>
          <TrackingTools clip={clip} project={project} />
        </>
      ) : !(project.trackings || []).length && <div className="dim small">{t('noTrackingsYet')}</div>}
      <FollowSection clip={clip} project={project} />
    </div>
  );
}

export function MaskPanel() {
  const t = useT();
  const { project, clip } = useClip();
  if (!project) return null;
  if (clip?.type === 'adjust') return <div className="tool-panel"><ClipHead clip={clip} /><AdjustSection clip={clip} project={project} /></div>;
  if (!clip || !isVisual(clip)) return <Empty icon={CircleDashed} text={t('pickClipForMask')} />;
  const addMasked = async () => {
    const layer = await op('addAdjustmentLayer', { start: clip.start, duration: clip.duration, fx: { blur: 12 }, mask: { shape: 'ellipse', cx: 0.5, cy: 0.5, w: 0.35, h: 0.45, feather: 30 } }, 'masked adjustment layer');
    if (layer?.id) useStore.getState().select([layer.id]);
  };
  return (
    <div className="tool-panel">
      <ClipHead clip={clip} />
      <div className="dim small">{t('maskPanelHint')}</div>
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={addMasked}><Plus size={13} /> {t('addMaskedLayer')}</button>
    </div>
  );
}

/** Blur / censor: adjustment layers over the selected clip, or a blur / pixelation that follows a tracking. */
export function BlurPanel() {
  const t = useT();
  const { project, clip } = useClip();
  if (!project) return null;
  if (clip?.type === 'adjust') return <div className="tool-panel"><ClipHead clip={clip} /><AdjustSection clip={clip} project={project} /></div>;
  if (!clip || !isVisual(clip)) return <Empty icon={Droplets} text={t('pickClipForBlur')} />;
  const toast = (lvl, m) => useStore.getState().toast(lvl, m);
  const run = (fn) => Promise.resolve().then(fn).catch((e) => toast('error', e.message));
  const layer = (args, label) => run(async () => {
    const l = await op('addAdjustmentLayer', { start: clip.start, duration: clip.duration, ...args }, label);
    if (l?.id) useStore.getState().select([l.id]);
  });
  const trackings = clip.type === 'video' ? (project.trackings || []).filter((x) => x.mediaId === clip.mediaId) : [];
  const now = () => Math.min(clip.start + clip.duration - 0.05, Math.max(clip.start, playhead.time));
  const OPTS = [
    ['blurAll', 'blurAllHint', { fx: { blur: 18 } }],
    ['blurZone', 'blurZoneHint', { fx: { blur: 24 }, mask: { shape: 'ellipse', cx: 0.5, cy: 0.45, w: 0.3, h: 0.4, feather: 30 } }],
    ['censorZone', 'censorHint', { fx: { pixelate: 28 }, mask: { shape: 'ellipse', cx: 0.5, cy: 0.4, w: 0.18, h: 0.3, feather: 12 } }],
    ['blurEdges', 'blurEdgesHint', { fx: { blur: 14 }, mask: { shape: 'rect', cx: 0.5, cy: 0.5, w: 0.6, h: 0.6, feather: 160, invert: true } }],
  ];
  return (
    <div className="tool-panel">
      <ClipHead clip={clip} />
      <div className="dim small">{t('blurPanelHint')}</div>
      <div className="blur-grid">
        {OPTS.map(([k, hint, args]) => (
          <button key={k} className="blur-opt" onClick={() => layer(args, k)}><b>{t(k)}</b><span>{t(hint)}</span></button>
        ))}
      </div>
      {clip.type === 'video' && (
        <>
          <div className="sub-title">{t('blurTracked')}</div>
          {!trackings.length && <div className="dim small">{t('blurTrackHint')}</div>}
          {!trackings.length && (
            <div className="preset-chips">
              <button className="chip" onClick={() => run(async () => { await call('track:start', { clipId: clip.id, time: now(), face: true, name: t('faceName') }); toast('info', t('trackingStarted')); })}><ScanFace size={11} /> {t('trackFace')}</button>
              <button className="chip" onClick={() => window.dispatchEvent(new CustomEvent('aicut:track-mode', { detail: { clipId: clip.id } }))}><Crosshair size={11} /> {t('trackObject')}</button>
            </div>
          )}
          {trackings.map((x) => (
            <div key={x.id} className="trk-row">
              <span className="trk-name">{x.kind === 'face' ? '🙂' : '🎯'} {x.name}</span>
              <div className="preset-chips">
                <button className="chip" onClick={() => run(() => call('track:effect', { tracking: x.id, mode: 'blur' }))}><EyeOff size={11} /> {t('blurIt')}</button>
                <button className="chip" onClick={() => run(() => call('track:effect', { tracking: x.id, mode: 'pixelate' }))}>▦ {t('pixelateIt')}</button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function ColorPanel() {
  const t = useT();
  const { project, clip } = useClip();
  if (!project) return null;
  if (!clip || clip.type === 'audio' || clip.type === 'color') return <Empty icon={Palette} text={t('pickVisualClip')} />;
  return <div className="tool-panel"><ClipHead clip={clip} /><GradeSection clip={clip} /></div>;
}

export function CutoutPanel() {
  const t = useT();
  const { project, clip } = useClip();
  if (!project) return null;
  if (clip?.cutoutOf) return <div className="tool-panel"><ClipHead clip={clip} /><CutoutTools clip={clip} /></div>;
  if (clip?.type !== 'video') return <Empty icon={Scissors} text={t('pickVideoClip')} />;
  return (
    <div className="tool-panel">
      <ClipHead clip={clip} />
      <div className="dim small">{t('cutoutPanelHint')}</div>
      <CutoutStart clip={clip} />
    </div>
  );
}

export function VideoToolsPanel() {
  const t = useT();
  const { project, clip } = useClip();
  if (!project) return null;
  if (clip?.type !== 'video') return <Empty icon={Clapperboard} text={t('pickVideoClip')} />;
  const freeze = () => call('edit:freezeFrame', { clipId: clip.id, time: Math.min(clip.start + clip.duration - 0.05, Math.max(clip.start, playhead.time)), duration: 1.5 }).catch((e) => useStore.getState().toast('error', e.message));
  return (
    <div className="tool-panel">
      <ClipHead clip={clip} />
      <VideoEditTools clip={clip} />
      <div className="preset-chips"><button className="chip" title={t('freezeHint')} onClick={freeze}><Camera size={11} /> {t('freezeFrame')}</button></div>
    </div>
  );
}

export function AnimationPanel() {
  const t = useT();
  const { project, clip, selection } = useClip();
  if (!project) return null;
  const visuals = selection.map((id) => project.clips.find((c) => c.id === id)).filter(isVisual);
  if (!visuals.length) return <Empty icon={Sparkles} text={t('pickVisualClip')} />;
  if (visuals.length > 1) return <div className="tool-panel"><div className="dim small">{t('nSelected', { n: visuals.length })}</div><AnimationSection clip={visuals[0]} ids={visuals.map((c) => c.id)} /></div>;
  return <div className="tool-panel"><ClipHead clip={clip} /><AnimationSection clip={clip} /></div>;
}

export function AudioFxPanel() {
  const t = useT();
  const { project, clip } = useClip();
  const selectedTrack = useStore((s) => s.selectedTrack);
  if (!project) return null;
  const hasAudio = clip && (clip.type === 'audio' || (clip.type === 'video' && mediaById(project, clip.mediaId)?.hasAudio));
  if (hasAudio) return <div className="tool-panel"><ClipHead clip={clip} /><ClipAfxSection clip={clip} /></div>;
  if (!clip && selectedTrack) return <div className="tool-panel"><TrackInspector project={project} trackId={selectedTrack} /></div>;
  return <Empty icon={AudioLines} text={t('pickAudioClip')} />;
}
