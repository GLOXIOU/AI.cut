// Short guided tour ("Discover AI.cut"): highlights a few elements one after the other with a short text.
// Part 1 runs on the home screen; part 2 starts by itself in the editor once a project is opened.
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../app/store.js';
import { useT } from '../app/i18n.js';
import { useShortcut } from '../app/shortcuts.js';

/** sel: element to highlight (first match), null = centered card. key: i18n `${key}T` (title) + `${key}` (text). */
export const TOUR = {
  home: [
    { sel: '.home-action.primary', key: 'tourNew' },
    { sel: '.np-card', key: 'tourCard' },
    { sel: '.home-action.open', key: 'tourOpen' },
    { sel: null, key: 'tourHomeEnd' },
  ],
  editor: [
    { sel: '.dock-group[data-panels~="media"]', key: 'tourFiles' },
    { sel: '.dock-group[data-panels~="tracking"], .dock-group[data-panels~="blur"], .dock-group[data-panels~="mask"]', key: 'tourTools' },
    { sel: '.timeline-frame', key: 'tourTimeline' },
    { sel: '.tl-ruler-row', key: 'tourAsk' },
    { sel: '.dock-group[data-panels~="inspector"]', key: 'tourInspector' },
    { sel: '.ai-btn', key: 'tourAi' },
    { sel: '.workspaces', key: 'tourWorkspaces' },
    { sel: '.tb-right .btn.primary', key: 'tourExport' },
  ],
};

const CARD_W = 330, CARD_H = 190, GAP = 14, PAD = 6;
const find = (sel) => (sel ? document.querySelector(sel) : null);

function placeCard(r) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!r) return { left: (vw - CARD_W) / 2, top: (vh - CARD_H) / 2 };
  const clampX = (x) => Math.max(12, Math.min(vw - CARD_W - 12, x));
  const clampY = (y) => Math.max(12, Math.min(vh - CARD_H - 12, y));
  if (r.bottom + GAP + CARD_H < vh) return { left: clampX(r.left), top: r.bottom + GAP };
  if (r.top - GAP - CARD_H > 0) return { left: clampX(r.left), top: r.top - GAP - CARD_H };
  if (r.right + GAP + CARD_W < vw) return { left: r.right + GAP, top: clampY(r.top) };
  if (r.left - GAP - CARD_W > 0) return { left: r.left - GAP - CARD_W, top: clampY(r.top) };
  return { left: (vw - CARD_W) / 2, top: clampY(r.bottom - CARD_H - GAP) };
}

export function Tour() {
  const t = useT();
  const kb = useShortcut();
  const vars = { play: kb('playPause'), split: kb('split'), jkl: [kb('shuttleBack'), kb('shuttleStop'), kb('shuttleFwd')].filter(Boolean).join(' ') };
  const tour = useStore((s) => s.tour);
  const steps = TOUR[tour.part].filter((s) => !s.sel || find(s.sel)); // steps whose element is not in the current layout are skipped
  const i = Math.min(tour.step, steps.length - 1);
  const step = steps[i];
  const [rect, setRect] = useState(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = find(step?.sel);
      if (!el) { setRect(null); return; }
      const b = el.getBoundingClientRect();
      const left = Math.max(4, b.left - PAD), top = Math.max(4, b.top - PAD);
      setRect({ left, top, width: Math.min(window.innerWidth - 4, b.right + PAD) - left, height: Math.min(window.innerHeight - 4, b.bottom + PAD) - top, right: b.right + PAD, bottom: b.bottom + PAD });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tour.part, i, step?.sel]);

  const end = () => useStore.getState().endTour(tour.part === 'home');
  const next = () => (i >= steps.length - 1 ? end() : useStore.setState({ tour: { ...tour, step: i + 1 } }));
  const prev = () => i > 0 && useStore.setState({ tour: { ...tour, step: i - 1 } });

  // the tour owns the keyboard while it is shown (no play / cut shortcuts behind it)
  useEffect(() => {
    const key = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); useStore.getState().endTour(false); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === ' ') e.preventDefault();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  if (!step) return null;
  const last = i === steps.length - 1;
  const pos = placeCard(rect);
  return (
    <div className="tour" onPointerDown={(e) => e.stopPropagation()}>
      {rect ? <div className="tour-spot" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} /> : <div className="tour-dim" />}
      <div className="tour-card" key={`${tour.part}-${i}`} style={{ left: pos.left, top: pos.top, width: CARD_W }} role="dialog" aria-label={t(`${step.key}T`)}>
        <button className="icon-btn xs tour-close" title={t('tourSkip')} onClick={() => useStore.getState().endTour(false)}><X size={13} /></button>
        <div className="tour-step">{t('tourStepN', { i: i + 1, n: steps.length })}</div>
        <h3>{t(`${step.key}T`)}</h3>
        <p>{t(step.key, vars)}</p>
        <div className="tour-actions">
          <div className="tour-dots">{steps.map((s, k) => <i key={s.key} className={k === i ? 'on' : ''} />)}</div>
          {!last && <button className="btn sm quiet" onClick={() => useStore.getState().endTour(false)}>{t('tourSkip')}</button>}
          {i > 0 && <button className="btn sm" onClick={prev}>{t('tourPrev')}</button>}
          <button className="btn sm primary" autoFocus onClick={next}>{last ? t('tourDone') : t('tourNext')}</button>
        </div>
      </div>
    </div>
  );
}
