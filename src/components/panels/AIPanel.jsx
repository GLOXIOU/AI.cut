import React, { useEffect, useRef, useState } from 'react';
import { Send, Square, Plus, Loader2, CheckCircle2, XCircle, Terminal, Plug, Unplug, Copy, Bot, User, Sparkles, Activity, Link, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';

const SUGGESTIONS = ['sugg1', 'sugg2', 'sugg3', 'sugg4', 'sugg5', 'sugg6'];

let lastTab = 'copilot'; // remembered across remounts (the panel unmounts when the inspector tab is shown)

export function AIPanel() {
  const t = useT();
  const [tab, setTabState] = useState(lastTab);
  const setTab = (x) => { lastTab = x; setTabState(x); };
  const sessions = useStore((s) => s.sessions);
  return (
    <div className="panel ai-panel">
      <div className="ai-tabs">
        <button className={tab === 'copilot' ? 'on' : ''} onClick={() => setTab('copilot')}><Sparkles size={13} /> {t('copilot')}</button>
        <button className={tab === 'connect' ? 'on' : ''} onClick={() => setTab('connect')}><Plug size={13} /> {t('connections')} {sessions.length > 0 && <span className="dot-ok" />}</button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}><Activity size={13} /> {t('activity')}</button>
      </div>
      {tab === 'copilot' && <Copilot />}
      {tab === 'connect' && <Connections />}
      {tab === 'activity' && <ActivityFeed />}
    </div>
  );
}

function renderText(s) {
  // tiny markdown: **bold**, `code`, line breaks, bullet lists
  const parts = String(s || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

function Copilot() {
  const t = useT();
  const cp = useStore((s) => s.copilot);
  const project = useStore((s) => s.project);
  const [text, setText] = useState('');
  const listRef = useRef(null);
  useEffect(() => { call('copilot:state').then((s) => useStore.setState({ copilot: s })).catch(() => {}); }, []);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [cp?.messages]);

  const send = async (msg) => {
    const m = (msg ?? text).trim();
    if (!m) return;
    setText('');
    try { await call('copilot:send', { text: m, ui: { playhead: playhead.time, selection: useStore.getState().selection } }); }
    catch (e) { useStore.getState().toast('error', e.message); }
  };

  if (cp && !cp.available) {
    return (
      <div className="copilot empty-state">
        <Bot size={30} />
        <p>{renderText(t('copilotNeedsClaude'))}</p>
        <p className="dim small">{renderText(t('copilotInstall'))}</p>
      </div>
    );
  }
  const msgs = cp?.messages || [];
  return (
    <div className="copilot">
      <div className="chat-list" ref={listRef}>
        {!msgs.length && (
          <div className="chat-welcome">
            <div className="cw-title"><Sparkles size={16} /> {t('whatToEdit')}</div>
            <div className="dim small">{t('copilotIntro')}</div>
            <div className="suggestions">
              {SUGGESTIONS.map((k) => <button key={k} className="chip" disabled={!project} onClick={() => send(t(k))}>{t(k)}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.role === 'user' && <div className="msg-avatar"><User size={12} /></div>}
            {m.role === 'assistant' && <div className="msg-avatar ai"><Bot size={12} /></div>}
            <div className="msg-body">
              {m.text && <div className="msg-text">{renderText(m.text)}</div>}
              {m.tools?.length > 0 && (
                <div className="msg-tools">
                  {m.tools.map((tl) => (
                    <div key={tl.id} className={`tool-chip ${tl.status}`} title={tl.error || tl.input}>
                      {tl.status === 'running' ? <Loader2 size={10} className="spin" /> : tl.status === 'error' ? <XCircle size={10} /> : <CheckCircle2 size={10} />}
                      {tl.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {cp?.busy && <div className="msg msg-assistant"><div className="msg-avatar ai"><Bot size={12} /></div><div className="msg-body"><span className="typing"><i /><i /><i /></span></div></div>}
      </div>
      <div className="chat-input">
        <textarea rows={3} placeholder={project ? t('askAnything') : t('openProjectFirst')} value={text} disabled={!project}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="chat-actions">
          <button className="icon-btn" title={t('newChat')} onClick={() => call('copilot:reset')}><Plus size={15} /></button>
          {cp?.busy
            ? <button className="btn sm danger" onClick={() => call('copilot:stop')}><Square size={12} /> {t('stop')}</button>
            : <button className="btn primary sm" disabled={!text.trim() || !project} onClick={() => send()}><Send size={12} /> {t('send')}</button>}
        </div>
      </div>
    </div>
  );
}

function Connections() {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const [status, setStatus] = useState(null);
  const [snips, setSnips] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(false);
  const refresh = () => call('ai:status').then(setStatus).catch(() => {});
  useEffect(() => { refresh(); call('ai:snippets').then(setSnips).catch(() => {}); }, []);
  const act = async (fn, id) => {
    setBusy(id);
    try { const r = await fn(); if (r?.message) useStore.getState().toast('success', r.message); } catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(null);
    refresh();
  };
  const copy = (s) => { navigator.clipboard.writeText(s); useStore.getState().toast('success', t('copied')); };
  return (
    <div className="connections">
      <div className="mcp-card">
        <div className="mcp-row"><span className={`dot ${status?.mcp?.running ? 'ok' : 'err'}`} /> <b>{t('mcpServer')}</b> <code className="url" onClick={() => copy(status?.mcp?.url || '')}>{status?.mcp?.url || '…'}</code></div>
        <div className="dim small">{t('mcpToolsInfo', { n: status?.mcp?.tools || 0, m: sessions.length })}</div>
        {sessions.map((s) => <div key={s.id} className="session-row"><span className={`dot ${s.active ? 'ok' : ''}`} /> {s.client} <span className="dim small">{t('callsN', { n: s.calls })}{s.active ? '' : ` · ${t('inactive')}`}</span></div>)}
      </div>
      <div className="how-to">
        <div className="sub-title">{t('oneClickConnect')}</div>
        {(status?.clients || []).map((c) => (
          <div key={c.id} className="client-row">
            <div className="client-info">
              <b>{c.label}</b>
              <span className={`small ${c.connected ? 'ok-text' : 'dim'}`}>{c.connected ? t('configured') : c.installed ? t('detected') : t('notDetected')}</span>
            </div>
            <div className="client-actions">
              {c.connected
                ? <button className="btn sm" disabled={busy === c.id} onClick={() => act(() => call('ai:disconnect', { id: c.id }), c.id)}><Unplug size={12} /></button>
                : <button className="btn primary sm" disabled={busy === c.id} onClick={() => act(() => call('ai:connect', { id: c.id }), c.id)}>{busy === c.id ? <Loader2 size={12} className="spin" /> : <Plug size={12} />} {t('connect')}</button>}
              {(c.id === 'claude-code' || c.id === 'codex' || c.id === 'gemini') && c.installed && (
                <button className="btn sm" title={t('openTerminal')} onClick={() => act(() => call('ai:terminal', { cli: c.id === 'claude-code' ? 'claude' : c.id }), `t-${c.id}`)}><Terminal size={12} /></button>
              )}
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
    </div>
  );
}

function ActivityFeed() {
  const t = useT();
  const activity = useStore((s) => s.activity);
  useEffect(() => { call('ai:activity').then((list) => { for (const a of list) useStore.getState().pushActivity(a); }).catch(() => {}); }, []);
  const list = [...activity].reverse();
  return (
    <div className="activity">
      {!list.length && <div className="dim pad">{t('noActivity')}</div>}
      {list.map((a) => (
        <div key={a.id} className={`act-row ${a.status}`}>
          {a.status === 'running' ? <Loader2 size={11} className="spin" /> : a.status === 'error' ? <XCircle size={11} /> : <Wrench size={11} />}
          <span className="act-client">{a.client}</span>
          <span className="act-tool">{a.tool}</span>
          <span className="act-ms dim">{a.ms != null ? `${a.ms} ms` : ''}</span>
          {a.error && <div className="act-err">{a.error}</div>}
          {!a.error && a.args && a.args !== '{}' && <div className="act-args dim">{a.args}</div>}
        </div>
      ))}
    </div>
  );
}
