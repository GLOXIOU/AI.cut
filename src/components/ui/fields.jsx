import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { t } from '../../app/i18n.js';

/** Number input with drag-to-scrub label. onChange fires live (onCommit on release/enter). */
export function NumberField({ label, value, onChange, onCommit, step = 1, min = -Infinity, max = Infinity, precision = 2, suffix = '', width }) {
  const [text, setText] = useState(fmt(value, precision));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(fmt(value, precision)); }, [value, focus, precision]);
  const clampV = (v) => Math.min(max, Math.max(min, v));
  const onScrub = (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = Number(value) || 0;
    let last = v0;
    const move = (ev) => {
      const mul = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      last = clampV(round(v0 + ((ev.clientX - x0) / 2) * step * mul, precision));
      onChange?.(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (last !== v0) (onCommit || onChange)?.(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const commit = () => {
    const v = parseFloat(String(text).replace(',', '.'));
    if (Number.isFinite(v)) { const c = clampV(v); (onCommit || onChange)?.(c); setText(fmt(c, precision)); }
    else setText(fmt(value, precision));
  };
  return (
    <label className="nf" style={width ? { width } : undefined}>
      {label && <span className="nf-label" onPointerDown={onScrub} title={t('dragToAdjust')}>{label}</span>}
      <input
        className="nf-input" value={text} onFocus={(e) => { setFocus(true); e.target.select(); }}
        onBlur={() => { setFocus(false); commit(); }} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = clampV(round((Number(value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), precision));
            (onCommit || onChange)?.(v);
          }
          e.stopPropagation();
        }}
      />
      {suffix && <span className="nf-suffix">{suffix}</span>}
    </label>
  );
}
const round = (v, p) => Math.round(v * Math.pow(10, p)) / Math.pow(10, p);
const fmt = (v, p) => (v === undefined || v === null || Number.isNaN(Number(v)) ? '' : String(round(Number(v), p)));

export function Slider({ label, value, onChange, onCommit, min = 0, max = 1, step = 0.01, format, defaultValue }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <div className="slider-row">
      <span className="sl-label" onDoubleClick={() => defaultValue !== undefined && (onCommit || onChange)?.(defaultValue)} title={defaultValue !== undefined ? t('dblClickDefault') : ''}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={local ?? 0}
        onChange={(e) => { const v = Number(e.target.value); setLocal(v); onChange?.(v); }}
        onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyUp={(e) => onCommit?.(Number(e.currentTarget.value))} />
      <span className="sl-value">{format ? format(local) : Math.round((local ?? 0) * 100) / 100}</span>
    </div>
  );
}

export function Select({ label, value, options, onChange }) {
  return (
    <label className="select-row">
      {label && <span className="sel-label">{label}</span>}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
        {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </label>
  );
}

export function Toggle({ label, value, onChange }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <button type="button" className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button>
    </label>
  );
}

export function ColorField({ label, value, onChange }) {
  const v = toHex(value);
  return (
    <label className="color-row">
      <span className="sel-label">{label}</span>
      <input type="color" value={v} onChange={(e) => onChange(e.target.value)} />
      <input className="color-text" value={value || ''} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
}
function toHex(c) {
  if (!c) return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  return '#000000';
}

export function TextField({ label, value, onCommit, multiline, placeholder = '' }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const P = multiline ? 'textarea' : 'input';
  return (
    <label className="text-row">
      {label && <span className="sel-label">{label}</span>}
      <P value={text} placeholder={placeholder} rows={multiline ? 3 : undefined} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !multiline) e.currentTarget.blur(); if (e.key === 'Enter' && multiline && (e.ctrlKey || e.metaKey)) e.currentTarget.blur(); }} />
    </label>
  );
}

export function Section({ title, children, defaultOpen = true, onReset, right, fx }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${open ? 'open' : ''}`}>
      <div className="section-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {fx && <span className="fx">fx</span>}
        <span>{title}</span>
        <div className="section-right" onClick={(e) => e.stopPropagation()}>
          {right}
          {onReset && <button className="icon-btn xs" title={t('reset')} onClick={onReset}><RotateCcw size={11} /></button>}
        </div>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Row({ children }) { return <div className="field-row">{children}</div>; }

export function useDebounced(fn, ms = 300) {
  const t = useRef(null);
  return (...a) => { clearTimeout(t.current); t.current = setTimeout(() => fn(...a), ms); };
}
