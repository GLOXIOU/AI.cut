import React, { useState } from 'react';
import { Undo2, Redo2, Upload, Settings, Loader2, ListChecks, X, FolderOpen, Save } from 'lucide-react';
import { useStore, WORKSPACES } from '../app/store.js';
import { call } from '../app/api.js';
import { useT, jobStatus } from '../app/i18n.js';

export function TopBar() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const project = useStore((s) => s.project);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const workspace = useStore((s) => s.workspace);
  const allSessions = useStore((s) => s.sessions);
  const sessions = allSessions.filter((x) => x.active !== false);
  const jobs = useStore((s) => s.jobs);
  const activity = useStore((s) => s.activity);
  const copilot = useStore((s) => s.copilot);
  const [showJobs, setShowJobs] = useState(false);
  const active = Object.values(jobs).filter((j) => !j.endedAt);
  const recent = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  const last = activity[activity.length - 1];
  const aiBusy = (last && last.status === 'running') || copilot?.busy;
  const clients = [...new Set(sessions.map((s) => s.client))];

  const setWorkspace = (w) => useStore.setState({ workspace: w.id, leftTab: w.left, rightTab: w.right });

  return (
    <div className="topbar">
      <div className="tb-left">
        <div className="brand"><span className="brand-mark">AI</span><span>AI.cut</span></div>
        {project && (
          <div className="tb-project">
            <span className="tb-name" title={project.name}>{project.name}</span>
            <span className="tb-res">{project.settings.width}×{project.settings.height} · {project.settings.fps} {t('fpsUnit')}</span>
            <button className="icon-btn" disabled={!canUndo} title={`${t('undo')} (Ctrl+Z)`} onClick={() => call('project:undo')}><Undo2 size={14} /></button>
            <button className="icon-btn" disabled={!canRedo} title={`${t('redo')} (Ctrl+Y)`} onClick={() => call('project:redo')}><Redo2 size={14} /></button>
            <button className="icon-btn" title={`${t('save')} (Ctrl+S)`} onClick={() => call('project:save').then(() => useStore.getState().toast('success', t('saved')))}><Save size={14} /></button>
            <button className="icon-btn" title={t('closeProject')} onClick={() => call('project:close')}><FolderOpen size={14} /></button>
          </div>
        )}
      </div>
      <div className="tb-center">
        {project && (
          <div className="workspaces">
            {WORKSPACES.map((w) => (
              <button key={w.id} className={workspace === w.id ? 'on' : ''} onClick={() => setWorkspace(w)}>{lang === 'en' ? w.en : w.fr}</button>
            ))}
          </div>
        )}
      </div>
      <div className="tb-right">
        <button className={`ai-status ${aiBusy ? 'busy' : ''}`} onClick={() => useStore.setState({ rightTab: 'ai', workspace: 'ai', leftTab: useStore.getState().leftTab })} title={t('aiPanel')}>
          <span className={`dot ${aiBusy ? 'busy' : sessions.length ? 'ok' : ''}`} />
          {aiBusy ? `${last?.client || t('ai')} · ${last?.tool || t('thinking')}` : sessions.length ? `${clients.join(', ')}` : t('aiConnect')}
        </button>
        <div className="jobs-wrap">
          <button className={`icon-btn ${active.length ? 'on' : ''}`} title={t('jobs')} onClick={() => setShowJobs(!showJobs)}>
            {active.length ? <Loader2 size={14} className="spin" /> : <ListChecks size={14} />}
            {active.length > 0 && <span className="count">{active.length}</span>}
          </button>
          {showJobs && (
            <div className="jobs-pop" onMouseLeave={() => setShowJobs(false)}>
              {!recent.length && <div className="dim pad">{t('noJobs')}</div>}
              {recent.map((j) => (
                <div key={j.id} className={`job-row ${j.status}`}>
                  <div className="job-title">{j.title}</div>
                  <div className="job-bar"><div style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} /></div>
                  <div className="job-meta">
                    <span>{j.status === 'running' ? `${Math.round(j.progress * 100)}% ${j.message || ''}` : j.status === 'error' ? j.error : jobStatus(j.status)}</span>
                    {!j.endedAt && <button className="icon-btn xs" onClick={() => call('jobs:cancel', { id: j.id })}><X size={11} /></button>}
                    {j.status === 'done' && j.result?.path && <button className="link" onClick={() => call('shell:reveal', { path: j.result.path })}>{t('open')}</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" title={t('settings')} onClick={() => useStore.setState({ dialog: 'settings' })}><Settings size={15} /></button>
        {project && <button className="btn primary sm" onClick={() => useStore.setState({ dialog: 'export' })}><Upload size={13} /> {t('export')}</button>}
      </div>
    </div>
  );
}
