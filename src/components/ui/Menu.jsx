import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

/**
 * Small floating menu (context menus, dropdowns). items: { label, icon, onClick, danger, disabled, checked, keepOpen }
 * | { sep: true } | { header } | { note }. Closes on outside click, Escape, scroll of the page or window resize.
 */
export function Menu({ x, y, items, onClose, align = 'left', anchor = null }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = align === 'right' ? x - r.width : x;
    let top = y;
    left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
    if (top + r.height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - r.height - 6);
    setPos({ left, top });
  }, [x, y, align]);
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target) && !anchor?.contains?.(e.target)) onClose(); }; // the anchor button toggles itself
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, anchor]);
  return (
    <div className="context-menu menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} className="menu-sep" />;
        if (it.header) return <div key={i} className="menu-head">{it.header}</div>;
        if (it.note) return <div key={i} className="menu-note">{it.note}</div>;
        const Icon = it.icon;
        return (
          <div key={i} className={`menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
            onClick={() => { if (it.disabled) return; it.onClick?.(); if (!it.keepOpen) onClose(); }}>
            {it.checked !== undefined && <span className="menu-check">{it.checked && <Check size={12} />}</span>}
            {Icon && <Icon size={13} className="menu-ico" />}
            <span className="grow">{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}
