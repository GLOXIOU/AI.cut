// Timeline overlays: in / out range, AI proposals (💡 accept / reject), user requests pinned for the AI (📌),
// and the "ask the AI here" box.
import React, { useEffect, useRef, useState } from 'react';
import { Check, X, Eye, EyeOff, Send, Trash2, RotateCcw, Lightbulb, MapPin, Sparkles, Star } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { op, call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';
import { fmtTime, r4 } from '@shared/timeline.js';
import { engineRef } from '../player/Player.jsx';

const OPEN = new Set(['recording', 'pending']);

/**
 * Positioned inside the ruler row (scrolls with the content). The top band (markH px) holds the AI ideas as
 * "★ Idée : title" flags (with their time range underneath) and the requests pinned for the AI.
 */
export function RulerOverlays({ project, zoom, headerW, markH = 0 }) {
  const t = useT();
  const inPoint = useStore((s) => s.inPoint);
  const outPoint = useStore((s) => s.outPoint);
  const [open, setOpen] = useState(null); // {kind, id, x}
  const props = (project.proposals || []).filter((p) => OPEN.has(p.status) && p.time != null);
  const reqs = (project.requests || []).filter((r) => r.status !== 'dismissed' || Date.now() - Date.parse(r.closedAt || 0) < 60000);
  return (
    <>
      {(inPoint != null || outPoint != null) && (
        <div className="io-range" style={{ top: markH, left: headerW + (inPoint ?? 0) * zoom, width: Math.max(2, ((outPoint ?? projectEnd(project)) - (inPoint ?? 0)) * zoom) }} title={`In ${fmtTime(inPoint ?? 0)} → Out ${fmtTime(outPoint ?? projectEnd(project))}`} />
      )}
      {props.map((p) => {
        const left = headerW + p.time * zoom;
        const width = Math.max(2, ((p.end ?? p.time + 1) - p.time) * zoom);
        const show = (e) => { e.stopPropagation(); setOpen({ kind: 'prop', id: p.id, x: e.clientX, y: e.clientY }); };
        return (
          <React.Fragment key={p.id}>
            <div className={`idea-range ${p.status}`} style={{ left, width }} />
            <div className={`idea-flag ${p.status}`} style={{ left }} title={p.description ? `${p.title}\n${p.description}` : p.title}
              onPointerDown={(e) => e.stopPropagation()} onClick={show}>
              <Star size={10} fill="currentColor" /><b>{t('ideaWord')} :</b><span>{p.title}</span>
            </div>
          </React.Fragment>
        );
      })}
      {reqs.map((r) => (
        <div key={r.id} className={`req-pin ${r.status}`} style={{ left: headerW + r.time * zoom - 7 }}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setOpen({ kind: 'req', id: r.id, x: e.clientX, y: e.clientY }); }} title={r.text}>
          <MapPin size={11} />
        </div>
      ))}
      {open?.kind === 'prop' && <ProposalPopover project={project} id={open.id} at={open} onClose={() => setOpen(null)} />}
      {open?.kind === 'req' && <RequestPopover project={project} id={open.id} at={open} onClose={() => setOpen(null)} />}
    </>
  );
}

const projectEnd = (p) => p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

function useOutside(ref, onClose) {
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', h);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('pointerdown', h); window.removeEventListener('keydown', k); };
  }, [onClose]);
}

const place = (at, w = 320, h = 220) => ({ left: Math.min(at.x, window.innerWidth - w - 8), top: Math.max(8, Math.min(at.y + 12, window.innerHeight - h - 8)) });

function ProposalPopover({ project, id, at, onClose }) {
  const t = useT();
  const ref = useRef(null);
  useOutside(ref, onClose);
  const hide = useStore((s) => s.hideProposals);
  const p = (project.proposals || []).find((x) => x.id === id);
  if (!p) return null;
  const toggleHide = () => { const v = !hide; useStore.setState({ hideProposals: v }); engineRef.current?.setHideProposals(v); };
  const n = (p.added?.length || 0) + Object.keys(p.before || {}).length + (p.removed?.length || 0);
  return (
    <div className="tl-popover" ref={ref} style={place(at, 330, 230)}>
      <div className="pop-title"><span className="idea-tag"><Star size={10} fill="currentColor" /> {t('ideaWord')}</span> <b>{p.title}</b></div>
      {p.description && <div className="pop-text">{p.description}</div>}
      <div className="dim small">{t('proposalMeta', { by: p.by || 'IA', n, from: fmtTime(p.time), to: fmtTime(p.end ?? p.time) })}{p.status === 'recording' ? ` · ${t('recording')}` : ''}</div>
      <div className="pop-actions">
        <button className="btn sm" onClick={() => { playhead.set(Math.max(0, p.time - 1), 'ui'); window.dispatchEvent(new Event('aicut:toggle-play')); }}>▶ {t('preview')}</button>
        <button className="btn sm" title={t('compareHint')} onClick={toggleHide}>{hide ? <Eye size={12} /> : <EyeOff size={12} />} {hide ? t('showProposals') : t('hideProposals')}</button>
      </div>
      <div className="pop-actions">
        <button className="btn sm primary" onClick={async () => { await op('acceptProposal', { id }, 'accept proposal'); onClose(); }}><Check size={12} /> {t('accept')}</button>
        <button className="btn sm danger" onClick={async () => { await op('rejectProposal', { id }, 'reject proposal'); onClose(); }}><X size={12} /> {t('reject')}</button>
      </div>
    </div>
  );
}

function RequestPopover({ project, id, at, onClose }) {
  const t = useT();
  const ref = useRef(null);
  useOutside(ref, onClose);
  const r = (project.requests || []).find((x) => x.id === id);
  if (!r) return null;
  return (
    <div className="tl-popover" ref={ref} style={place(at, 320, 200)}>
      <div className="pop-title"><MapPin size={13} /> {t('requestTitle')} · {fmtTime(r.time)}{r.end != null ? ` → ${fmtTime(r.end)}` : ''} <span className={`req-status ${r.status}`}>{t(`req_${r.status}`)}</span></div>
      <div className="pop-text">« {r.text} »</div>
      {r.reply && <div className="pop-reply"><b>{r.repliedBy || 'IA'} :</b> {r.reply}</div>}
      <div className="pop-actions">
        {r.status !== 'open' && r.status !== 'working' && <button className="btn sm" onClick={async () => { await call('ai:askHere', { text: r.text, time: r.time, end: r.end, trackId: r.trackId, clipId: r.clipId }); await op('removeRequests', { ids: [r.id] }, 'retry request'); onClose(); }}><RotateCcw size={12} /> {t('askAgain')}</button>}
        <button className="btn sm danger" onClick={async () => { await op('removeRequests', { ids: [r.id] }, 'delete request'); onClose(); }}><Trash2 size={12} /> {t('delete')}</button>
      </div>
    </div>
  );
}

/** The "ask the AI here" box. ctx: { x, y, time, end?, trackId?, clipId?, trackName?, clipName? } */
export function AskAiBox({ ctx, onClose }) {
  const t = useT();
  const ref = useRef(null);
  const [text, setText] = useState('');
  useOutside(ref, onClose);
  const send = async () => {
    const s = text.trim();
    if (!s) return;
    try {
      await call('ai:askHere', { text: s, time: r4(ctx.time), end: ctx.end != null ? r4(ctx.end) : null, trackId: ctx.trackId || null, clipId: ctx.clipId || null, target: 'mcp' });
      onClose();
    } catch (e) { useStore.getState().toast('error', e.message); }
  };
  return (
    <div className="tl-popover ask-ai" ref={ref} style={place(ctx, 360, 230)} onPointerDown={(e) => e.stopPropagation()}>
      <div className="pop-title"><Sparkles size={14} className="ask-ico" /> {t('askAiHere')}</div>
      <div className="ask-ctx">
        <span className="ctx-chip">{ctx.end != null ? `${fmtTime(ctx.time)} → ${fmtTime(ctx.end)}` : fmtTime(ctx.time)}</span>
        {ctx.trackName && <span className="ctx-chip">{ctx.trackName}</span>}
        {ctx.clipName && <span className="ctx-chip clip">{ctx.clipName}</span>}
      </div>
      <textarea autoFocus rows={3} value={text} placeholder={t('askAiPlaceholder')} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === 'Escape') onClose(); }} />
      <div className="pop-actions">
        <span className="dim small grow">{t('mcpRequestHint')}</span>
        <button className="btn sm primary" disabled={!text.trim()} onClick={send}><Send size={12} /> {t('send')}</button>
      </div>
    </div>
  );
}
