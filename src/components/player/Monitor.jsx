// External program monitor: a second window (usually full screen on another display) that shows the program
// output while you edit. It runs its own silent PlayerEngine on the same project and follows the editor's
// transport (time / play / rate) sent through the main process; the sound keeps playing in the editor.
import React, { useEffect, useRef, useState } from 'react';
import { PlayerEngine } from './engine.js';

export function MonitorApp() {
  const hostRef = useRef(null);
  const [empty, setEmpty] = useState(true);
  const [cursor, setCursor] = useState(true);

  useEffect(() => {
    document.title = 'AI.cut — Programme';
    document.body.classList.add('monitor-body');
    const eng = new PlayerEngine(hostRef.current, { silent: true });
    let lastSync = null;
    const setProject = (p) => { eng.setProject(p || null); setEmpty(!p?.clips?.length); };
    window.aicut.call('project:get').then((r) => setProject(r?.project)).catch(() => {});
    const offs = [
      window.aicut.on('project', (payload) => setProject(payload?.project)),
      window.aicut.on('monitor', (m) => {
        if (!m) return;
        lastSync = m;
        // time the editor had when it sent the message + transport latency
        const lag = m.playing ? Math.max(0, Math.min(0.25, (Date.now() - m.sentAt) / 1000)) * (m.rate || 1) : 0;
        const t = m.time + lag;
        if (m.playing) {
          if (!eng.playing || eng.rate !== (m.rate || 1)) { eng.seek(t); eng.play(m.rate || 1); }
          else if (Math.abs(eng.time - t) > 0.06) eng.seek(t); // drift correction
        } else {
          if (eng.playing) eng.pause();
          if (Math.abs(eng.time - t) > 1e-4) eng.seek(t);
        }
      }),
    ];
    eng.onEnded = () => { if (lastSync?.playing) eng.seek(eng.duration); };
    window.aicut.call('monitor:ready').catch(() => {});
    return () => { offs.forEach((f) => f()); eng.destroy(); };
  }, []);

  // hide the pointer when it does not move; keyboard: Esc / F = full screen, Space = play / pause in the editor
  useEffect(() => {
    let timer = null;
    const wake = () => { setCursor(true); clearTimeout(timer); timer = setTimeout(() => setCursor(false), 1800); };
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); window.aicut.call('monitor:command', { action: 'toggle' }).catch(() => {}); }
      else if (k === 'escape') window.aicut.call('monitor:command', { action: 'escape' }).catch(() => {});
      else if (k === 'f' || k === 'f11') { e.preventDefault(); window.aicut.call('monitor:command', { action: 'fullscreen' }).catch(() => {}); }
      else if (k === 'arrowleft' || k === 'arrowright' || k === 'j' || k === 'k' || k === 'l' || k === 'home' || k === 'end') {
        window.aicut.call('monitor:command', { action: 'key', key: e.key, shift: e.shiftKey }).catch(() => {});
      }
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', onKey); };
  }, []);

  return (
    <div className={`monitor ${cursor ? '' : 'no-cursor'}`} onDoubleClick={() => window.aicut.call('monitor:command', { action: 'fullscreen' }).catch(() => {})}>
      <div className="monitor-host" ref={hostRef} />
      {empty && <div className="monitor-empty">AI.cut</div>}
    </div>
  );
}
