import React, { useEffect, useRef, useState } from 'react';
import { Send, Square, Loader2, CheckCircle2, XCircle, Bot, User, Sparkles, Lightbulb, MapPin, Check, X, Trash2, Wand2, Plug, Link } from 'lucide-react';
import { op } from '../../app/api.js';
import { fmtTime } from '@shared/timeline.js';
import { useStore } from '../../app/store.js';
import { call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';

// The AI panels (chat, ideas, style) are three dockable panels: grouped by default, movable separately.
const SUGGESTIONS = ['sugg1', 'sugg2', 'sugg3', 'sugg4', 'sugg5', 'sugg6'];

function renderText(s) {
  // tiny markdown: **bold**, `code`, line breaks, bullet lists
  const parts = String(s || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

/** Built-in chat (drives the local Claude Code CLI through the AI.cut MCP server). */
export function ChatPanel() {
  const t = useT();
  const cp = useStore((s) => s.copilot);
  const project = useStore((s) => s.project);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false); // hides the suggestions right away, before the reply starts streaming
  const listRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => { call('copilot:state').then((s) => useStore.setState({ copilot: s })).catch(() => {}); }, []);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [cp?.messages, cp?.busy]);

  const send = async (msg) => {
    const m = (msg ?? text).trim();
    if (!m || !project) return;
    setText('');
    setSent(true);
    try { await call('copilot:send', { text: m, ui: { playhead: playhead.time, selection: useStore.getState().selection } }); }
    catch (e) { setSent(false); useStore.getState().toast('error', e.message); }
  };

  if (cp && !cp.available) {
    return (
      <div className="chat-empty">
        <Bot size={28} />
        <p>{renderText(t('copilotNeedsClaude'))}</p>
        <p className="dim small">{renderText(t('copilotInstall'))}</p>
        <button className="btn primary" onClick={() => useStore.getState().openSettings('connect')}><Plug size={13} /> {t('aiConnect')}</button>
      </div>
    );
  }
  const msgs = cp?.messages || [];
  const showSuggestions = !msgs.length && !sent && !cp?.busy;
  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {showSuggestions && (
          <div className="chat-sugg">
            <div className="cs-title"><Sparkles size={13} /> {t('suggestions')}</div>
            {SUGGESTIONS.map((k) => <button key={k} className="sugg" disabled={!project} onClick={() => send(t(k))}>{t(k)}</button>)}
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
      <div className="composer">
        <div className={`composer-box ${project ? '' : 'disabled'}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); } }}>
          <textarea ref={inputRef} rows={3} placeholder={project ? t('askAnything') : t('openProjectFirst')} value={text} disabled={!project}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <div className="composer-bar">
            {cp?.busy
              ? <button className="send-btn stop" onClick={() => call('copilot:stop')}><Square size={11} fill="currentColor" /> {t('stop')}</button>
              : <button className="send-btn" disabled={!text.trim() || !project} onClick={() => send()}><Send size={14} /> {t('send')}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** AI proposals (accept / reject) and the requests pinned on the timeline. */
export function IdeasPanel() {
  const t = useT();
  const project = useStore((s) => s.project);
  if (!project) return <div className="dim pad">{t('openProjectFirst')}</div>;
  const props = [...(project.proposals || [])].reverse();
  const reqs = [...(project.requests || [])].reverse();
  const go = (tm) => playhead.set(Math.max(0, tm), 'ui');
  return (
    <div className="ideas">
      <div className="sub-title"><Lightbulb size={12} /> {t('proposalsTitle')}</div>
      {!props.length && <div className="dim small pad">{t('noProposals')}</div>}
      {props.map((p) => (
        <div key={p.id} className={`idea-row ${p.status}`}>
          <div className="idea-head" onClick={() => p.time != null && go(p.time)}>
            <b>{p.title}</b> <span className="dim small">{p.by} · {p.time != null ? fmtTime(p.time) : ''} · {t(`prop_${p.status}`)}</span>
          </div>
          {p.description && <div className="small">{p.description}</div>}
          {(p.status === 'pending' || p.status === 'recording') && (
            <div className="pop-actions">
              <button className="btn sm primary" onClick={() => op('acceptProposal', { id: p.id }, 'accept proposal')}><Check size={12} /> {t('accept')}</button>
              <button className="btn sm danger" onClick={() => op('rejectProposal', { id: p.id }, 'reject proposal')}><X size={12} /> {t('reject')}</button>
            </div>
          )}
        </div>
      ))}
      {props.some((p) => p.status === 'accepted' || p.status === 'rejected') && <button className="btn sm quiet" onClick={() => op('removeProposals', { decided: true }, 'clean proposals')}>{t('clearDecided')}</button>}
      <div className="sub-title"><MapPin size={12} /> {t('requestsTitle')}</div>
      {!reqs.length && <div className="dim small pad">{t('noRequests')}</div>}
      {reqs.map((r) => (
        <div key={r.id} className={`idea-row req ${r.status}`}>
          <div className="idea-head" onClick={() => go(r.time)}>
            <span className={`req-status ${r.status}`}>{t(`req_${r.status}`)}</span> <span className="dim small">{fmtTime(r.time)}{r.end != null ? ` → ${fmtTime(r.end)}` : ''}</span>
            <button className="icon-btn xs" style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); op('removeRequests', { ids: [r.id] }, 'delete request'); }}><Trash2 size={11} /></button>
          </div>
          <div className="small">« {r.text} »</div>
          {r.reply && <div className="small dim">↳ {r.repliedBy || 'IA'} : {r.reply}</div>}
        </div>
      ))}
    </div>
  );
}

/** "Edit like this video": analyse a link, then ask the AI to reproduce its style. */
export function StylePanel() {
  const t = useT();
  const project = useStore((s) => s.project);
  const copilot = useStore((s) => s.copilot);
  const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const job = useStore((s) => (jobId ? s.jobs[jobId] : null)); // only its own analysis job, not every job update
  const [extra, setExtra] = useState('');
  if (!project) return <div className="dim pad">{t('openProjectFirst')}</div>;
  const refs = [...(project.styleRefs || [])].reverse();
  const analyze = async () => {
    try { const j = await call('style:analyze', { url: url.trim() }); setJobId(j.id); setUrl(''); } catch (e) { useStore.getState().toast('error', e.message); }
  };
  const apply = async (id) => {
    try { const r = await call('style:apply', { id, text: extra.trim(), target: copilot?.available ? 'copilot' : 'mcp' }); useStore.getState().toast('success', r.sentTo === 'copilot' ? t('styleSentCopilot') : t('mcpRequestHint')); } catch (e) { useStore.getState().toast('error', e.message); }
  };
  return (
    <div className="ideas style-panel">
      <div className="sp-card">
        <div className="sp-title"><Wand2 size={14} /> {t('styleTitle')}</div>
        <div className="sp-sub">{t('styleIntro')}</div>
        <div className="sp-input">
          <Link size={13} />
          <input value={url} placeholder={t('stylePlaceholder')} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && url.trim()) analyze(); }} />
        </div>
        <button className="btn primary block sp-go" disabled={!url.trim()} onClick={analyze}><Sparkles size={13} /> {t('analyze')}</button>
      </div>
      {job && job.status !== 'done' && <div className="small">{job.status === 'error' ? `⚠ ${job.error}` : `${Math.round((job.progress || 0) * 100)} % · ${job.message || ''}`}</div>}
      {refs.map((r) => {
        const pr = r.profile || {};
        return (
          <div key={r.id} className="idea-row">
            <div className="idea-head"><b>🎬 {r.name}</b><button className="icon-btn xs" style={{ marginLeft: 'auto' }} onClick={() => op('removeStyleRefs', { ids: [r.id] }, 'remove style')}><Trash2 size={11} /></button></div>
            <div className="small">{t('stylePacing', { cpm: Math.round(pr.pacing?.cutsPerMinute || 0), shot: pr.pacing?.medianShot ?? '?' })}{pr.speech?.wordsPerMinute ? ` · ${t('styleWpm', { n: Math.round(pr.speech.wordsPerMinute) })}` : ''}{pr.sound?.bpm ? ` · ${Math.round(pr.sound.bpm)} BPM` : ''}</div>
            <div className="dim small">{pr.source?.aspect} · {t('styleLook', { s: pr.look?.saturation, w: pr.look?.warmth })}</div>
            <textarea rows={2} value={extra} placeholder={t('styleExtra')} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button className="btn sm primary" onClick={() => apply(r.id)}><Sparkles size={12} /> {t('applyStyle')}</button>
          </div>
        );
      })}
    </div>
  );
}
