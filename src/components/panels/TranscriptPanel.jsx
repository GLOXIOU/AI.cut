import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Scissors, Eraser, Copy, X, RefreshCw, Captions } from 'lucide-react';
import { useStore } from '../../app/store.js';
import { call } from '../../app/api.js';
import { playhead } from '../../app/playhead.js';
import { useT } from '../../app/i18n.js';
import { fmtTime } from '@shared/timeline.js';

/** Text-based editing: the transcript of the edit itself. Select words and delete them to cut the video. */
export function TranscriptPanel() {
  const t = useT();
  const rev = useStore((s) => s.rev);
  const project = useStore((s) => s.project);
  const [words, setWords] = useState(null);
  const [sel, setSel] = useState(null); // [a, b]
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const dragRef = useRef(null);

  const load = () => call('edit:transcript').then(setWords).catch(() => setWords([]));
  useEffect(() => { const id = setTimeout(load, 250); return () => clearTimeout(id); }, [rev]);

  // highlight the word under the playhead (no React re-render)
  useEffect(() => {
    if (!words?.length) return undefined;
    let last = -1;
    const upd = (tm) => {
      let i = -1;
      let lo = 0, hi = words.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (words[mid].start <= tm) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      if (i >= 0 && tm > words[i].end + 0.4) i = -1;
      if (i === last) return;
      const box = boxRef.current;
      if (!box) return;
      box.querySelector('.tw.now')?.classList.remove('now');
      if (i >= 0) {
        const el = box.querySelector(`[data-i="${i}"]`);
        if (el) { el.classList.add('now'); if (playhead.playing) el.scrollIntoView({ block: 'nearest' }); }
      }
      last = i;
    };
    upd(playhead.time);
    return playhead.sub(upd);
  }, [words]);

  const paragraphs = useMemo(() => {
    if (!words) return [];
    const out = [];
    let cur = null;
    words.forEach((w, i) => {
      const prev = words[i - 1];
      if (!cur || (prev && w.start - prev.end > 1.1) || (prev && /[.!?…]$/.test(prev.text) && cur.items.length > 40)) { cur = { start: w.start, items: [] }; out.push(cur); }
      cur.items.push(i);
    });
    return out;
  }, [words]);

  const ql = q.trim().toLowerCase();
  const fillers = words ? words.filter((w) => w.filler).length : 0;
  const range = sel ? [Math.min(sel[0], sel[1]), Math.max(sel[0], sel[1])] : null;
  const inSel = (i) => range && i >= range[0] && i <= range[1];

  const onDown = (e, i) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && sel) setSel([sel[0], i]); else setSel([i, i]);
    dragRef.current = e.shiftKey && sel ? sel[0] : i;
    const up = () => { dragRef.current = null; window.removeEventListener('pointerup', up); };
    window.addEventListener('pointerup', up);
  };
  const onEnter = (i) => { if (dragRef.current != null) setSel([dragRef.current, i]); };
  const onClick = (i) => playhead.set(words[i].start, 'ui');

  const deleteSel = async () => {
    if (!range) return;
    setBusy(true);
    try {
      const r = await call('edit:deleteWords', { ranges: [range] });
      useStore.getState().toast('success', t('wordsDeleted', { n: range[1] - range[0] + 1, s: r?.secondsRemoved ?? '' }));
      setSel(null);
    } catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(false);
  };
  const removeFillers = async () => {
    setBusy(true);
    try { const r = await call('edit:removeFillers', {}); useStore.getState().toast('success', t('fillersRemoved', { n: r.removed })); } catch (e) { useStore.getState().toast('error', e.message); }
    setBusy(false);
  };
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (range && (e.key === 'Delete' || e.key === 'Backspace') && boxRef.current?.matches(':hover')) { e.stopPropagation(); e.preventDefault(); deleteSel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!project) return null;
  return (
    <div className="panel transcript-panel">
      <div className="panel-head">
        <span className="panel-title">{t('sequenceText')} <span className="dim">· {words?.length || 0} {t('wordsUnit')}</span></span>
        <div className="panel-actions">
          <button className="icon-btn" title={t('refresh')} onClick={load}><RefreshCw size={13} /></button>
          <button className="icon-btn" title={t('copyText')} onClick={() => { navigator.clipboard.writeText((words || []).map((w) => w.text).join(' ')); useStore.getState().toast('success', t('copied')); }}><Copy size={13} /></button>
        </div>
      </div>
      <div className="bin-tools">
        <div className="search-box" style={{ margin: 0, flex: 1 }}><Search size={12} /><input placeholder={t('searchText')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />{q && <button className="icon-btn xs" onClick={() => setQ('')}><X size={11} /></button>}</div>
      </div>
      <div className="tx-actions">
        <button className="btn sm" disabled={!range || busy} onClick={deleteSel}><Scissors size={12} /> {range ? t('deleteNWords', { n: range[1] - range[0] + 1 }) : t('deleteSelection')}</button>
        <button className="btn sm" disabled={!fillers || busy} onClick={removeFillers}><Eraser size={12} /> {t('removeFillersN', { n: fillers })}</button>
      </div>
      {words && !words.length && (
        <div className="hint" style={{ padding: '10px' }}><Captions size={13} /> {t('noSequenceText')}</div>
      )}
      <div className="tx-body" ref={boxRef}>
        {paragraphs.map((par, pi) => (
          <div key={pi} className="tx-par">
            <span className="tx-time" onClick={() => playhead.set(par.start, 'ui')}>{fmtTime(par.start)}</span>
            <p>
              {par.items.map((i) => {
                const w = words[i];
                const hit = ql && w.text.toLowerCase().includes(ql);
                return (
                  <span key={i} data-i={i} className={`tw ${w.filler ? 'filler' : ''} ${inSel(i) ? 'sel' : ''} ${hit ? 'hit' : ''}`}
                    onPointerDown={(e) => onDown(e, i)} onPointerEnter={() => onEnter(i)} onDoubleClick={() => onClick(i)} onClick={(e) => { if (!e.shiftKey) onClick(i); }}>
                    {w.text}{' '}
                  </span>
                );
              })}
            </p>
          </div>
        ))}
      </div>
      <div className="panel-foot dim small">{t('transcriptFoot')}</div>
    </div>
  );
}
