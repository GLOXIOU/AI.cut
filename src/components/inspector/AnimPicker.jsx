import React, { useEffect, useRef, useState } from 'react';
import { animStateAt, animCatalog, ANIM_LOOP } from '@shared/anim.js';
import { useStore } from '../../app/store.js';

const W = 46, H = 26;
const CTX = { W, H, w: 20, h: 14, x: 0, y: 0 };

/**
 * Tiny live preview of an animation (same math as the player / export): plays on hover.
 * slot: 'in' | 'out' | 'loop'
 */
export function AnimTile({ slot, type, active, label, onClick, draggable }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const D = slot === 'loop' ? 6 : 1.4;
    const clip = { duration: D, anim: { [slot]: slot === 'loop' ? { type, amount: ANIM_LOOP[type]?.inner ? 1 : 4 } : { type, duration: 0.6 } } };
    const apply = (t) => {
      const a = type ? animStateAt(clip, t, CTX) : { dx: 0, dy: 0, s: 1, sx: 1, sy: 1, r: 0, o: 1, b: 0, z: 1, pu: 0, pv: 0 };
      const k = slot === 'loop' && !ANIM_LOOP[type]?.inner ? 1.6 : 1;
      el.style.transform = `translate(${a.dx * k}px, ${a.dy * k}px) rotate(${a.r * k}deg) scale(${a.s * a.sx * (slot === 'loop' && a.z > 1 ? a.z * 1.6 - 0.6 : 1)}, ${a.s * a.sy * (slot === 'loop' && a.z > 1 ? a.z * 1.6 - 0.6 : 1)})`;
      el.style.opacity = String(a.o);
      el.style.filter = a.b > 0.3 ? `blur(${a.b * 0.12}px)` : '';
      el.style.backgroundPosition = `${50 + a.pu * 300}% ${50 + a.pv * 300}%`;
    };
    if (!hover && !active) { apply(slot === 'out' ? 0 : slot === 'loop' ? 0 : 1.4); return undefined; }
    let raf;
    const t0 = performance.now();
    const cycle = slot === 'loop' ? 6 : 2.1;
    let lastFrame = 0;
    const tick = (now) => {
      // the active tile animates for as long as it is shown: 30 fps is plenty for a 46 px demo
      if (now - lastFrame < 32) { raf = requestAnimationFrame(tick); return; }
      lastFrame = now;
      let t = ((now - t0) / 1000) % cycle;
      if (slot === 'out') t = Math.min(1.4, t + 0.8); // exit plays at the end of the 1.4 s demo clip
      if (slot === 'in') t = Math.min(1.4, t);
      apply(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover, active, slot, type]);
  return (
    <button type="button" className={`anim-opt ${active ? 'on' : ''}`} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      draggable={draggable} onDragStart={(e) => { if (type) e.dataTransfer.setData('application/x-aicut-anim', JSON.stringify({ slot, type })); }} title={label}>
      <span className="anim-stage"><i ref={ref} style={{ backgroundImage: 'linear-gradient(135deg,#b9c3d4 0 45%,#8e9ab0 45% 100%)', backgroundSize: '200% 200%' }} /></span>
      <span className="lbl">{label}</span>
    </button>
  );
}

/** Grid of animations for one slot (entrance / exit / continuous). */
export function AnimGrid({ slot, value, onPick, filter }) {
  const lang = useStore((s) => s.lang);
  const cat = animCatalog(lang)[slot].filter((x) => !filter || filter(x));
  return (
    <div className="anim-grid">
      <AnimTile slot={slot} type={null} active={!value} label={lang === 'en' ? 'None' : 'Aucune'} onClick={() => onPick(null)} />
      {cat.map((x) => <AnimTile key={x.id} slot={slot} type={x.id} active={value === x.id} label={x.label} onClick={() => onPick(x.id)} draggable />)}
    </div>
  );
}
