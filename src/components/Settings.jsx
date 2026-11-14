import React, { useEffect, useState } from 'react';
import { Cpu, Plug, Unplug, Terminal, Copy, ChevronDown, ChevronRight, Loader2, XCircle, CheckCircle2, Wrench, X, FolderOpen, SlidersHorizontal, ListChecks, Activity, MessageSquare, Server, Keyboard, Plus, RotateCcw, Search } from 'lucide-react';
import { useStore } from '../app/store.js';
import { call } from '../app/api.js';
import { useT, useLang, jobStatus, resolveLang } from '../app/i18n.js';
import { Select, Toggle, NumberField } from './ui/fields.jsx';
import { Modal } from './dialogs.jsx';
import { SHORTCUTS, SHORTCUT_GROUPS, combosFor, comboFromEvent, comboParts, formatCombo } from '../app/shortcuts.js';

const TABS = [['general', 'settingsGeneral', SlidersHorizontal], ['connect', 'aiConnect', Plug], ['shortcuts', 'shortcutsTab', Keyboard], ['jobs', 'jobs', ListChecks], ['activity', 'activity', Activity]];

function renderText(s) {
  const parts = String(s || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

/** Settings: general options, AI connection, background jobs and the detailed AI activity log. */
export function SettingsDialog() {
  const t = useT();
  const tab = useStore((s) => s.settingsTab);
  const settings = useStore((s) => s.settings);
  const jobs = useStore((s) => s.jobs);
  const sessions = useStore((s) => s.sessions);
  const copilot = useStore((s) => s.copilot);
  const close = () => useStore.setState({ dialog: null });
  if (!settings) return null;
  const running = Object.values(jobs).filter((j) => !j.endedAt).length;
  const aiReady = sessions.some((x) => x.active !== false) || !!copilot?.available;
  return (
    <Modal title={t('settings')} onClose={close} width="min(900px, 94vw)" className="settings-modal">
      <nav className="set-nav">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => useStore.setState({ settingsTab: id })}>
            <Icon size={15} /> <span className="grow">{t(label)}</span>
            {id === 'connect' && aiReady && <span className="dot ok" />}
            {id === 'jobs' && running > 0 && <span className="set-count">{running}</span>}
          </button>
        ))}
      </nav>
      <div className="set-page">
        {tab === 'general' && <GeneralPage />}
        {tab === 'connect' && <ConnectPage />}
        {tab === 'jobs' && <JobsPage />}
        {tab === 'shortcuts' && <ShortcutsPage />}
        {tab === 'activity' && <ActivityPage />}
      </div>
    </Modal>
  );
}

function GeneralPage() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  const lang = useLang();
  const [tools, setTools] = useState(null);
  const set = async (patch) => { const s = await call('settings:set', patch); useStore.setState({ settings: s, lang: resolveLang(s, info) }); };
  const sysLang = info?.systemLanguage === 'fr' ? t('langFr') : t('langEn');
  const refresh = () => call('tools:status').then(setTools).catch(() => {});
  useEffect(() => { refresh(); }, []);
  return (
    <>
      <h2 className="set-h">{t('settingsGeneral')}</h2>
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
    </>
  );
}

/** Connect an AI: MCP server status, built-in chat, one-click setup of the AI clients, manual config. */
function ConnectPage() {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const copilot = useStore((s) => s.copilot);
  const [status, setStatus] = useState(null);
  const [snips, setSnips] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(false);
  const refresh = () => call('ai:status').then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
    call('ai:snippets').then(setSnips).catch(() => {});
    call('copilot:state').then((c) => useStore.setState({ copilot: c })).catch(() => {});
  }, []);
  const act = async (fn, id) => {
    setBusy(id);
    try { const r = await fn(); if (r?.message) useStore.getState().toast('success', r.message); } catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(null);
    refresh();
  };
  const copy = (s) => { navigator.clipboard.writeText(s); useStore.getState().toast('success', t('copied')); };
  return (
    <>
      <h2 className="set-h">{t('aiConnect')}</h2>
      <div className="set-card">
        <div className="set-line">
          <Server size={14} className="dim" /> <b>{t('mcpServer')}</b> <span className={`dot ${status?.mcp?.running ? 'ok' : 'err'}`} />
          <code className="url" title={t('copied')} onClick={() => copy(status?.mcp?.url || '')}>{status?.mcp?.url || '…'}</code>
        </div>
        <div className="dim small">{t('mcpToolsInfo', { n: status?.mcp?.tools || 0, m: sessions.length })}</div>
        <div className="set-line">
          <MessageSquare size={14} className="dim" /> <b>{t('builtinChat')}</b> <span className={`dot ${copilot?.available ? 'ok' : ''}`} />
          <span className={`small ${copilot?.available ? 'ok-text' : 'dim'}`}>{copilot?.available ? t('chatReady') : t('chatMissing')}</span>
        </div>
        {copilot && !copilot.available && <div className="dim small">{renderText(t('copilotInstall'))}</div>}
      </div>

      <div className="sub-title">{t('connectedAis')}</div>
      {!sessions.length && <div className="dim small">{t('noSessions')}</div>}
      {sessions.length > 0 && (
        <div className="set-list">
          {sessions.map((s) => <div key={s.id} className="set-row"><span className={`dot ${s.active ? 'ok' : ''}`} /> <b>{s.client}</b> <span className="dim small">{t('callsN', { n: s.calls })}{s.active ? '' : ` · ${t('inactive')}`}</span></div>)}
        </div>
      )}

      <div className="sub-title">{t('oneClickConnect')}</div>
      <div className="set-list">
        {(status?.clients || []).map((c) => (
          <div key={c.id} className="set-row client">
            <div className="client-info">
              <b>{c.label}</b>
              <span className={`small ${c.connected ? 'ok-text' : 'dim'}`}>{c.connected ? t('configured') : c.installed ? t('detected') : t('notDetected')}</span>
            </div>
            <div className="client-actions">
              {(c.id === 'claude-code' || c.id === 'codex' || c.id === 'gemini') && c.installed && (
                <button className="btn sm" title={t('openTerminal')} onClick={() => act(() => call('ai:terminal', { cli: c.id === 'claude-code' ? 'claude' : c.id }), `t-${c.id}`)}><Terminal size={12} /></button>
              )}
              {c.connected
                ? <button className="btn sm" disabled={busy === c.id} onClick={() => act(() => call('ai:disconnect', { id: c.id }), c.id)}><Unplug size={12} /></button>
                : <button className="btn primary sm" disabled={busy === c.id} onClick={() => act(() => call('ai:connect', { id: c.id }), c.id)}>{busy === c.id ? <Loader2 size={12} className="spin" /> : <Plug size={12} />} {t('connect')}</button>}
            </div>
          </div>
        ))}
      </div>

      <div className="steps small">
        <b>{t('howItWorks')}</b>
        <ol>
          <li>{t('howStep1')}</li>
          <li>{renderText(t('howStep2'))}</li>
          <li>{t('howStep3')}</li>
        </ol>
      </div>
      <div className="snippets">
        <div className="section-head" onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('manualConfig')}</div>
        {open && snips && (
          <div className="snip-list">
            {[['Claude Code', snips.claudeCode], ['Codex (config.toml)', snips.codex], ['Codex (HTTP)', snips.codexHttp], ['Claude Desktop', snips.claudeDesktop], ['Cursor / Windsurf', snips.cursor], ['Gemini CLI', snips.gemini], [t('genericMcp'), snips.generic], [t('shellRest'), snips.rest]].map(([label, s]) => (
              <div key={label} className="snip">
                <div className="snip-head"><span>{label}</span><button className="icon-btn xs" onClick={() => copy(s)}><Copy size={11} /></button></div>
                <pre>{s}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const clock = (ms, lang) => new Date(ms).toLocaleTimeString(lang === 'en' ? 'en-US' : 'fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const took = (ms, t) => (ms == null ? '' : ms < 1000 ? t('tookMs', { n: ms }) : t('tookS', { n: (ms / 1000).toFixed(ms < 10000 ? 1 : 0) }));

/** Background jobs (analysis, transcription, downloads, exports…), newest first. */
function JobsPage() {
  const t = useT();
  const lang = useLang();
  const jobs = useStore((s) => s.jobs);
  const list = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
  const running = list.filter((j) => !j.endedAt).length;
  return (
    <>
      <h2 className="set-h">{t('jobs')}{running > 0 && <span className="set-h-meta">{t('jobsRunningN', { n: running })}</span>}</h2>
      {!list.length && <div className="set-empty">{t('noJobs')}</div>}
      <div className="set-list">
        {list.map((j) => (
          <div key={j.id} className={`set-row job ${j.status}`}>
            <div className="job-main">
              <div className="job-top">
                <b className="job-title">{j.title}</b>
                <span className={`job-state ${j.status}`}>{j.status === 'running' ? `${Math.round((j.progress || 0) * 100)} %` : jobStatus(j.status)}</span>
              </div>
              {!j.endedAt && <div className="job-bar"><div style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} /></div>}
              <div className="job-meta">
                <span>{t('startedAt', { t: clock(j.startedAt || j.createdAt, lang) })}{j.endedAt && j.startedAt ? ` · ${took(j.endedAt - j.startedAt, t)}` : ''}</span>
                {j.status === 'running' && j.message && <span>· {j.message}</span>}
              </div>
              {j.status === 'error' && j.error && <div className="job-err">{j.error}</div>}
            </div>
            <div className="client-actions">
              {j.status === 'done' && j.result?.path && <button className="btn sm" title={t('open')} onClick={() => call('shell:reveal', { path: j.result.path })}><FolderOpen size={12} /></button>}
              {!j.endedAt && <button className="btn sm" title={t('cancel')} onClick={() => call('jobs:cancel', { id: j.id })}><X size={12} /></button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Every tool call made by the AIs (MCP clients and the built-in chat), with arguments, timing and errors. */
function ActivityPage() {
  const t = useT();
  const lang = useLang();
  const activity = useStore((s) => s.activity);
  const [filter, setFilter] = useState('all');
  useEffect(() => { call('ai:activity').then((list) => { for (const a of list) useStore.getState().pushActivity(a); }).catch(() => {}); }, []);
  const list = [...activity].reverse().filter((a) => filter === 'all' || a.status === filter);
  return (
    <>
      <div className="set-h-row">
        <h2 className="set-h">{t('activity')}</h2>
        <div className="seg">
          {[['all', 'filterAll'], ['running', 'filterRunning'], ['error', 'filterErrors']].map(([id, label]) => (
            <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{t(label)}</button>
          ))}
        </div>
      </div>
      {!list.length && <div className="set-empty">{t('noActivity')}</div>}
      <div className="set-list">
        {list.map((a) => (
          <div key={a.id} className={`set-row act ${a.status}`}>
            <span className="act-ico">{a.status === 'running' ? <Loader2 size={13} className="spin" /> : a.status === 'error' ? <XCircle size={13} /> : a.status === 'done' ? <CheckCircle2 size={13} /> : <Wrench size={13} />}</span>
            <div className="act-main">
              <div className="act-top">
                <span className="act-tool">{a.tool}</span>
                <span className="act-client">{a.client}</span>
                <span className="act-time">{a.at ? clock(a.at, lang) : ''}{a.ms != null ? ` · ${took(a.ms, t)}` : ''}</span>
              </div>
              {a.args && a.args !== '{}' && <pre className="act-args">{a.args}</pre>}
              {a.error && <div className="act-err">{a.error}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Keyboard shortcuts: every action, its keys; click a key to change it, + to add one, × to remove it. */
function ShortcutsPage() {
  const t = useT();
  const lang = useLang();
  const settings = useStore((s) => s.settings);
  const overrides = settings.shortcuts || {};
  const [rec, setRec] = useState(null); // { id, replace } while waiting for a key
  const [q, setQ] = useState('');
  const toast = (lvl, m) => useStore.getState().toast(lvl, m);
  const save = async (next) => { const s = await call('settings:set', { shortcuts: next }); useStore.setState({ settings: s }); };
  // keep only what differs from the defaults
  const withCombos = (over, id, combos) => {
    const next = { ...over };
    const def = SHORTCUTS.find((a) => a.id === id).keys;
    if (combos.length === def.length && combos.every((c, i) => c === def[i])) delete next[id];
    else next[id] = combos;
    return next;
  };

  useEffect(() => {
    if (!rec) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation(); // neither the editor shortcuts nor the dialog's Escape
      if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) { setRec(null); return; }
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier alone: wait for the key
      let next = { ...overrides };
      let movedFrom = null;
      for (const a of SHORTCUTS) {
        if (a.id === rec.id) continue;
        const cs = combosFor(a.id, next);
        if (cs.includes(combo)) { movedFrom = a.id; next = withCombos(next, a.id, cs.filter((c) => c !== combo)); }
      }
      const mine = combosFor(rec.id, next).filter((c) => c !== combo);
      const at = rec.replace ? mine.indexOf(rec.replace) : -1;
      const updated = at >= 0 ? [...mine.slice(0, at), combo, ...mine.slice(at + 1)] : [...mine, combo];
      save(withCombos(next, rec.id, updated));
      if (movedFrom) toast('info', t('scMoved', { key: formatCombo(combo, lang), from: t(`sc_${movedFrom}`) }));
      setRec(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rec, overrides, lang]);

  const needle = q.trim().toLowerCase();
  const visible = SHORTCUTS.filter((a) => !needle || t(`sc_${a.id}`).toLowerCase().includes(needle) || combosFor(a.id, overrides).some((c) => formatCombo(c, lang).toLowerCase().includes(needle)));
  const keys = (combo) => comboParts(combo, lang).map((k, i) => <kbd key={i}>{k}</kbd>);
  return (
    <>
      <div className="set-h-row">
        <h2 className="set-h">{t('shortcutsTab')}</h2>
        <button className="btn sm" disabled={!Object.keys(overrides).length} onClick={() => save({})}><RotateCcw size={12} /> {t('scResetAll')}</button>
      </div>
      <div className="dim small">{t('scHint')}</div>
      <div className="sp-input sc-search"><Search size={13} /><input value={q} placeholder={t('scSearch')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      {SHORTCUT_GROUPS.map((g) => {
        const rows = visible.filter((a) => a.group === g);
        if (!rows.length) return null;
        return (
          <div key={g} className="sc-group">
            <div className="sub-title">{t(`scg_${g}`)}</div>
            {rows.map((a) => {
              const combos = combosFor(a.id, overrides);
              const custom = Array.isArray(overrides[a.id]);
              return (
                <div key={a.id} className={`sc-row ${rec?.id === a.id ? 'recording' : ''}`}>
                  <span className="sc-label">{t(`sc_${a.id}`)}{custom && <i className="sc-dot" title={t('scCustom')} />}</span>
                  <div className="sc-keys">
                    {combos.map((c) => (
                      rec?.id === a.id && rec.replace === c
                        ? <span key={c} className="sc-chip rec">{t('scPress')}</span>
                        : (
                          <span key={c} className="sc-chip">
                            <button className="sc-combo" title={t('scChange')} onClick={() => setRec({ id: a.id, replace: c })}>{keys(c)}</button>
                            <button className="sc-x" title={t('scRemove')} onClick={() => save(withCombos(overrides, a.id, combos.filter((x) => x !== c)))}><X size={10} /></button>
                          </span>
                        )
                    ))}
                    {!combos.length && rec?.id !== a.id && <span className="dim small">{t('scNone')}</span>}
                    {rec?.id === a.id && !rec.replace && <span className="sc-chip rec">{t('scPress')}</span>}
                    <button className="icon-btn xs" title={t('scAdd')} onClick={() => setRec({ id: a.id, replace: null })}><Plus size={12} /></button>
                    <button className="icon-btn xs" style={{ visibility: custom ? 'visible' : 'hidden' }} title={t('scReset')} onClick={() => save(withCombos(overrides, a.id, a.keys))}><RotateCcw size={11} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
