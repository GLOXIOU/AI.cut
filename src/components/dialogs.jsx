import React, { useEffect, useState } from 'react';
import { X, Download, Loader2, FolderOpen, Cpu, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { useStore } from '../app/store.js';
import { call } from '../app/api.js';
import { useT, useLang, jobStatus, resolveLang } from '../app/i18n.js';
import { Select, Toggle, NumberField } from './ui/fields.jsx';
import { projectDuration, fmtTime } from '@shared/timeline.js';

function Modal({ title, onClose, children, width = 520 }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width }}>
        <div className="modal-head"><b>{title}</b><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ExportDialog() {
  const t = useT();
  const info = useStore((s) => s.info);
  const project = useStore((s) => s.project);
  const settings = useStore((s) => s.settings);
  const jobs = useStore((s) => s.jobs);
  const [preset, setPreset] = useState(settings?.exportDefaults?.preset || 'youtube-1080p');
  const [quality, setQuality] = useState('high');
  const [hardware, setHardware] = useState(true);
  const [burn, setBurn] = useState(true);
  const [srt, setSrt] = useState(false);
  const [useRange, setUseRange] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [path, setPath] = useState('');
  const [jobId, setJobId] = useState(null);
  const [enc, setEnc] = useState(null);
  const close = () => useStore.setState({ dialog: null });
  const dur = project ? projectDuration(project) : 0;
  useEffect(() => { setRange({ start: 0, end: dur }); call('app:encoders').then(setEnc).catch(() => {}); }, []);
  const job = jobId ? jobs[jobId] : null;
  const p = (info?.exportPresets || []).find((x) => x.id === preset);
  const start = async () => {
    try {
      const j = await call('export:start', { preset, quality, hardware, burnSubtitles: burn, subtitlesFile: srt ? 'srt' : null, ...(useRange ? { range } : {}), ...(path ? { path } : {}) });
      setJobId(j.id);
      call('settings:set', { exportDefaults: { ...(settings?.exportDefaults || {}), preset, quality, hardware } });
    } catch (e) { useStore.getState().toast('error', e.message); }
  };
  const browse = async () => {
    const f = await call('dialog:saveFile', { title: t('output'), filters: [{ name: p?.format?.toUpperCase() || 'Video', extensions: [p?.format || 'mp4'] }] });
    if (f) setPath(f);
  };
  const gpu = enc && (enc.h264_nvenc || enc.hevc_nvenc);
  return (
    <Modal title={t('exportVideo')} onClose={close}>
      {!job && (
        <>
          <Select label={t('preset')} value={preset} onChange={setPreset} options={(info?.exportPresets || []).map((x) => ({ value: x.id, label: x.label }))} />
          {p?.video && <Select label={t('quality')} value={quality} onChange={setQuality} options={['draft', 'good', 'high', 'max'].map((q) => ({ value: q, label: t(`q_${q}`) }))} />}
          {p?.video && <Toggle label={`${t('hardware')}${gpu ? ` (${t('nvencDetected')})` : enc ? ` (${t('notAvailable')})` : ''}`} value={hardware && !!gpu} onChange={setHardware} />}
          {p?.video && project?.subtitles?.cues?.length > 0 && <Toggle label={t('burnSubtitles')} value={burn} onChange={setBurn} />}
          {project?.subtitles?.cues?.length > 0 && <Toggle label={t('sidecar')} value={srt} onChange={setSrt} />}
          <Toggle label={`${t('range')} (${useRange ? t('partialRange') : t('wholeTimeline')} · ${fmtTime(dur)})`} value={useRange} onChange={setUseRange} />
          {useRange && (
            <div className="field-row">
              <NumberField label={t('start')} value={range.start} step={0.1} min={0} suffix="s" onCommit={(v) => setRange({ ...range, start: v })} />
              <NumberField label={t('end')} value={range.end} step={0.1} min={0} suffix="s" onCommit={(v) => setRange({ ...range, end: v })} />
            </div>
          )}
          <div className="text-row">
            <span className="sel-label">{t('output')}</span>
            <div className="file-pick"><input value={path} placeholder={t('exportAutoPath')} readOnly /><button className="btn sm" onClick={browse}><FolderOpen size={13} /></button></div>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={close}>{t('cancel')}</button>
            <button className="btn primary" disabled={!dur} onClick={start}><Download size={14} /> {t('startExport')}</button>
          </div>
        </>
      )}
      {job && (
        <div className="export-progress">
          <div className="ep-title">{job.status === 'done' ? <CheckCircle2 size={18} className="ok-text" /> : job.status === 'error' ? <AlertTriangle size={18} className="err-text" /> : <Loader2 size={18} className="spin" />} {job.title}</div>
          <div className="job-bar big"><div style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
          <div className="dim">{job.status === 'running' ? `${Math.round(job.progress * 100)}% — ${job.message || ''}` : job.status === 'error' ? job.error : job.status === 'done' ? `${job.result?.width}×${job.result?.height} · ${job.result?.encoder} · ${(job.result?.size / 1048576).toFixed(1)} ${t('mb')} · ${job.result?.seconds}s` : jobStatus(job.status)}</div>
          {job.result?.warnings?.length > 0 && <div className="warn-text small"><Info size={12} /> {job.result.warnings.join(' ')}</div>}
          <div className="modal-foot">
            {!job.endedAt && <button className="btn danger" onClick={() => call('jobs:cancel', { id: job.id })}>{t('cancel')}</button>}
            {job.status === 'done' && <button className="btn" onClick={() => call('shell:reveal', { path: job.result.path })}><FolderOpen size={14} /> {t('showFile')}</button>}
            {job.status === 'done' && <button className="btn primary" onClick={() => call('shell:open', { path: job.result.path })}>{t('playVideo')}</button>}
            {job.endedAt && <button className="btn" onClick={close}>{t('close')}</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function SettingsDialog() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  const lang = useLang();
  const [tools, setTools] = useState(null);
  const close = () => useStore.setState({ dialog: null });
  const set = async (patch) => { const s = await call('settings:set', patch); useStore.setState({ settings: s, lang: resolveLang(s, info) }); };
  const sysLang = info?.systemLanguage === 'fr' ? t('langFr') : t('langEn');
  const refresh = () => call('tools:status').then(setTools).catch(() => {});
  useEffect(() => { refresh(); }, []);
  if (!settings) return null;
  return (
    <Modal title={t('settings')} onClose={close} width={600}>
      <Select label={t('language')} value={settings.language || ''} onChange={(v) => set({ language: v || null })} options={[{ value: '', label: t('languageAuto', { l: sysLang }) }, { value: 'en', label: lang === 'en' ? 'English' : 'English (anglais)' }, { value: 'fr', label: lang === 'fr' ? 'Français' : 'Français (French)' }]} />
      <div className="dim small" style={{ marginTop: -4 }}>{t('uiLanguageHint')}</div>
      <Toggle label={t('autoAnalyze')} value={settings.autoAnalyze} onChange={(v) => set({ autoAnalyze: v })} />
      <Select label={t('whisperModel')} value={settings.whisperModel} onChange={(v) => set({ whisperModel: v })} options={[{ value: 'auto', label: t('whisperAuto') }, ...(tools?.models || []).map((m) => ({ value: m.id, label: `${m.label}${m.installed ? ' ✓' : ''}` }))]} />
      <Select label={t('whisperBackend')} value={settings.whisperBackend} onChange={(v) => set({ whisperBackend: v })} options={[{ value: 'auto', label: t('backendAuto') }, { value: 'cpu', label: t('cpuOnly') }]} />
      <Select label={t('spokenLanguage')} value={settings.whisperLanguage || 'auto'} onChange={(v) => set({ whisperLanguage: v })} options={[{ value: 'auto', label: t('autoDetect') }, { value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }, { value: 'es', label: 'Español' }, { value: 'de', label: 'Deutsch' }, { value: 'it', label: 'Italiano' }, { value: 'pt', label: 'Português' }]} />
      <Select label={t('previewProxies')} value={settings.proxyMode} onChange={(v) => set({ proxyMode: v })} options={[{ value: 'auto', label: t('proxyAuto') }, { value: 'always', label: t('always') }, { value: 'never', label: t('never') }]} />
      <NumberField label={t('mcpPort')} value={settings.mcpPort} step={1} min={1024} max={65535} precision={0} onCommit={(v) => set({ mcpPort: v })} />
      <div className="sub-title">{t('dependencies')}</div>
      <div className="deps">
        <div className="dep-row"><Cpu size={13} /> ffmpeg <span className={tools?.ffmpeg ? 'ok-text' : 'err-text'}>{tools?.ffmpeg || t('missing')}</span></div>
        <div className="dep-row"><Cpu size={13} /> yt-dlp <span className={tools?.ytdlp ? 'ok-text' : 'dim'}>{tools?.ytdlp ? `${tools.ytdlpVersion || ''}` : t('downloadedOnFirstUse')}</span>
          {!tools?.ytdlp && <button className="btn sm" onClick={() => call('tools:installYtdlp').then(() => setTimeout(refresh, 4000))}>{t('install')}</button>}</div>
        <div className="dep-row"><Cpu size={13} /> Whisper GPU <span className={tools?.whisper?.gpu === false ? 'warn-text' : 'ok-text'}>{tools?.whisper?.gpu === null ? t('notTested') : tools?.whisper?.gpu ? 'Vulkan OK' : 'CPU'}</span></div>
        <div className="dep-row"><Cpu size={13} /> {t('gpuEncoder')} <span className={tools?.encoders?.h264_nvenc ? 'ok-text' : 'dim'}>{tools?.encoders?.h264_nvenc ? 'NVENC' : t('softwareEncoder')}</span></div>
        {(tools?.models || []).map((m) => (
          <div key={m.id} className="dep-row small"><span className="dim">{t('modelN', { id: m.id })}</span> {m.installed ? <span className="ok-text">{t('installed')}</span> : <button className="btn sm" onClick={() => call('tools:downloadModel', { name: m.id })}>{t('download')} ({Math.round(m.size / 1048576)} {t('mb')})</button>}</div>
        ))}
      </div>
      <div className="modal-foot"><button className="btn primary" onClick={close}>OK</button></div>
    </Modal>
  );
}

export function Toasts() {
  const tr = useT();
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => useStore.getState().dismissToast(t.id)}>
          {t.from && <b>{t.from} : </b>}{t.message}
          {t.path && <button className="link" onClick={(e) => { e.stopPropagation(); call('shell:reveal', { path: t.path }); }}>{tr('open')}</button>}
        </div>
      ))}
    </div>
  );
}
