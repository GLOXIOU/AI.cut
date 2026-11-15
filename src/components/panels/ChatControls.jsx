import React, { useCallback, useState } from 'react';
import { ChevronDown, RotateCw, Loader2 } from 'lucide-react';
import { call } from '../../app/api.js';
import { useStore } from '../../app/store.js';
import { useT, useLang } from '../../app/i18n.js';
import { Menu, Floating } from '../ui/Menu.jsx';

// Composer controls of the built-in chat: model + effort picker, plan usage meter.
// Everything comes from the copilot state (electron/ai/copilot.js → meta).

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const fail = (e) => useStore.getState().toast('error', e.message);
const level = (pct) => (pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '');
const fmtPct = (p) => (p > 0 && p < 1 ? '< 1 %' : `${Math.round(p)} %`);
const locale = (lang) => (lang === 'en' ? 'en-US' : 'fr-FR');

/** Five bars, the first ones lit: how long the model thinks. */
function EffortBars({ effort }) {
  const n = EFFORTS.indexOf(effort) + 1;
  return (
    <span className="effort-bars" aria-hidden="true">
      {EFFORTS.map((e, i) => <i key={e} className={i < n ? 'on' : ''} style={{ height: 4 + i * 1.5 }} />)}
    </span>
  );
}

/** Popup anchored above a composer button; same button toggles it. */
function useAnchored() {
  const [at, setAt] = useState(null);
  const close = useCallback(() => setAt(null), []);
  const toggle = (e) => {
    if (at) { setAt(null); return false; }
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: r.left, y: r.top - 6, anchor: e.currentTarget });
    return true;
  };
  return [at, toggle, close];
}

/** "Opus 5.5 ▂▄▆" button: picks the chat's model and effort (applies to the next reply). */
export function ModelPicker({ meta }) {
  const t = useT();
  const [at, toggle, close] = useAnchored();
  const [more, setMore] = useState(false);
  const models = meta?.models || [];
  const cur = models.find((m) => m.resolved === meta?.model) || models.find((m) => m.value === meta?.model) || null;
  const name = cur?.name || meta?.model || t('aiModel');
  const effort = meta?.effort;
  const efforts = cur ? cur.efforts : models.length && effort ? EFFORTS : [];
  const main = models.filter((m) => m.main);
  const others = models.filter((m) => !m.main);
  const row = (m) => ({ label: m.name, checked: m === cur, keepOpen: true, onClick: () => call('copilot:setModel', { model: m.value }).catch(fail) });
  const items = !models.length
    ? [{ note: meta?.refreshing ? t('aiModelsLoading') : t('aiModelsUnavailable') }]
    : [
      { header: t('aiModel') },
      ...main.map(row),
      ...(!others.length ? [] : more || (cur && !cur.main)
        ? [{ sep: true }, { header: t('aiOtherModels') }, ...others.map(row)]
        : [{ label: t('aiOtherModels'), checked: false, keepOpen: true, trail: <ChevronDown size={12} />, onClick: () => setMore(true) }]),
      ...(!efforts.length ? [] : [
        { sep: true }, { header: t('aiEffort') },
        ...efforts.map((e) => ({ label: t(`effort_${e}`), checked: e === effort, keepOpen: true, trail: <EffortBars effort={e} />, onClick: () => call('copilot:setEffort', { effort: e }).catch(fail) })),
      ]),
    ];
  const open = (e) => { if (toggle(e) && !models.length) call('copilot:refresh', { maxAge: 0 }).catch(() => {}); };
  const showEffort = efforts.length > 0 && EFFORTS.includes(effort);
  return (
    <>
      <button className={`cb-chip cb-model ${at ? 'on' : ''}`} onClick={open}
        title={showEffort ? t('aiModelEffortTitle', { m: name, e: t(`effort_${effort}`).toLowerCase() }) : name}>
        <span className="cb-name">{name}</span>
        {showEffort && <EffortBars effort={effort} />}
        <ChevronDown size={12} className="cb-caret" />
      </button>
      {at && <Menu {...at} place="above" items={items} onClose={close} className="model-menu" />}
    </>
  );
}

function Ring({ pct }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  return (
    <svg className="usage-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="track" cx="7" cy="7" r={r} />
      <circle className="val" cx="7" cy="7" r={r} strokeDasharray={`${(Math.min(100, pct) / 100) * c} ${c}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}

function UsageRow({ label, pct, sub }) {
  return (
    <div className={`up-row ${level(pct)}`}>
      <div className="up-top"><span>{label}</span><b>{fmtPct(pct)}</b></div>
      <div className="up-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
      {sub && <div className="up-sub">{sub}</div>}
    </div>
  );
}

function resetText(ms, t, lang) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(locale(lang), { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return t('usageResetsAt', { t: time });
  const day = d.toLocaleDateString(locale(lang), ms - Date.now() < 6 * 86400000 ? { weekday: 'long' } : { day: 'numeric', month: 'long' });
  return t('usageResetsDay', { d: day, t: time });
}

/** Ring + "5 %" (current 5-hour session of the plan); click for the week, per-model limits and the chat context. */
export function UsageMeter({ meta }) {
  const t = useT();
  const lang = useLang();
  const [at, toggle, close] = useAnchored();
  const now = Date.now();
  // a window past its reset time is empty again until the next reading
  const windows = (meta?.windows || []).map((w) => ({ ...w, pct: w.resetsAt && w.resetsAt <= now ? 0 : w.pct, past: w.resetsAt && w.resetsAt <= now }));
  const session = windows.find((w) => w.id === 'session');
  const week = windows.find((w) => w.id === 'week');
  const ctx = meta?.context;
  const shown = session || (ctx ? { pct: ctx.pct } : null);
  if (!shown) return null;
  const worst = Math.max(session?.pct || 0, week?.pct || 0, meta?.limited ? 100 : 0);
  const label = (w) => (w.id === 'session' ? t('usageSession') : w.id === 'week' ? t('usageWeek') : t('usageWeekModel', { m: w.label }));
  const tokens = (n) => new Intl.NumberFormat(locale(lang), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const open = (e) => { if (toggle(e)) call('copilot:refresh', { maxAge: 60000 }).catch(() => {}); };
  return (
    <>
      <button className={`cb-chip cb-usage ${level(worst)} ${at ? 'on' : ''}`} onClick={open}
        title={session ? windows.map((w) => `${label(w)} : ${fmtPct(w.pct)}`).join('\n') : t('usageContext')}>
        <Ring pct={shown.pct} />
        <span className="cb-pct">{fmtPct(shown.pct)}</span>
      </button>
      {at && (
        <Floating {...at} place="above" onClose={close} className="usage-pop">
          <div className="up-head">
            <b>{t('aiUsage')}</b>
            {meta?.plan && <span className="up-plan">{meta.plan}</span>}
            <button className="icon-btn xs" title={t('usageRefresh')} disabled={meta?.refreshing} onClick={() => call('copilot:refresh', { maxAge: 0 }).catch(() => {})}>
              {meta?.refreshing ? <Loader2 size={12} className="spin" /> : <RotateCw size={12} />}
            </button>
          </div>
          {windows.map((w) => <UsageRow key={w.id} label={label(w)} pct={w.pct} sub={w.resetsAt && !w.past ? resetText(w.resetsAt, t, lang) : null} />)}
          {ctx && (
            <>
              {windows.length > 0 && <div className="up-sep" />}
              <UsageRow label={t('usageContext')} pct={ctx.pct} sub={t('usageTokens', { a: tokens(ctx.used), b: tokens(ctx.max) })} />
            </>
          )}
        </Floating>
      )}
    </>
  );
}
