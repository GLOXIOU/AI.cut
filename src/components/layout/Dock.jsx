// Dockable panel area (Premiere-style): columns of tab groups above a full-width timeline.
// Tabs can be dragged onto another group (to join it) or onto one of its edges (to dock beside / above / below),
// columns and stacked groups are resized with the splitters, groups can be minimised, panels closed / re-added.
// The whole arrangement belongs to the active workspace (see app/layout.js and the store).
import React, { createContext, memo, useContext, useLayoutEffect, useRef, useState } from 'react';
import {
  FolderOpen, FileText, Sparkles, Music, Laugh, Captions, Wand2, Globe, SlidersHorizontal, Crosshair, CircleDashed, Palette,
  Scissors, Film, Move, AudioLines, MessageSquare, Lightbulb, Brush, MonitorPlay, ChevronsRight, Minimize2, Maximize2, X, RotateCcw,
  Droplets, GripHorizontal,
} from 'lucide-react';
import { useStore, selectLayout } from '../../app/store.js';
import { useT } from '../../app/i18n.js';
import { ALL_PANELS, COL_MIN, PLAYER_MIN, STRIP_W, GROUP_MIN_H, isPlayerCol, isStrip, canDrop, canDropGroup, moveTab, moveGroup, closePanel, updateGroup, hasPanel } from '../../app/layout.js';
import { Menu } from '../ui/Menu.jsx';
import { Player } from '../player/Player.jsx';
import { Timeline } from '../timeline/Timeline.jsx';
import { Inspector } from '../inspector/Inspector.jsx';
import { MediaPanel } from '../panels/MediaPanel.jsx';
import { AudioPanel } from '../panels/AudioPanel.jsx';
import { YouTubePanel } from '../panels/YouTubePanel.jsx';
import { MotionPanel } from '../panels/MotionPanel.jsx';
import { SubtitlesPanel } from '../panels/SubtitlesPanel.jsx';
import { ChatPanel, IdeasPanel, StylePanel } from '../panels/AIPanel.jsx';
import { TranscriptPanel } from '../panels/TranscriptPanel.jsx';
import { AutoPanel } from '../panels/AutoPanel.jsx';
import { MemePanel } from '../panels/MemePanel.jsx';
import { TrackingPanel, BlurPanel, MaskPanel, ColorPanel, CutoutPanel, VideoToolsPanel, AnimationPanel, AudioFxPanel } from '../panels/ToolPanels.jsx';

/**
 * Every dockable panel: tab label (i18n key), icon, component; `fill` panels manage their own scrolling.
 * Components are memoised: moving / resizing / minimising panels re-renders the frames, not their content
 * (each panel still re-renders on its own store subscriptions).
 */
export const PANELS = {
  media: { label: 'filesTab', icon: FolderOpen, C: memo(MediaPanel) },
  transcript: { label: 'textTab', icon: FileText, C: memo(TranscriptPanel) },
  motion: { label: 'effects', icon: Sparkles, C: memo(MotionPanel) },
  audio: { label: 'sounds', icon: Music, C: memo(AudioPanel) },
  memes: { label: 'memesTab', icon: Laugh, C: memo(MemePanel) },
  subtitles: { label: 'subtitles', icon: Captions, C: memo(SubtitlesPanel) },
  auto: { label: 'autoTab', icon: Wand2, C: memo(AutoPanel) },
  youtube: { label: 'web', icon: Globe, C: memo(YouTubePanel) },
  inspector: { label: 'effectControls', icon: SlidersHorizontal, C: memo(Inspector) },
  tracking: { label: 'panelTracking', icon: Crosshair, C: memo(TrackingPanel) },
  blur: { label: 'panelBlur', icon: Droplets, C: memo(BlurPanel) },
  mask: { label: 'panelMask', icon: CircleDashed, C: memo(MaskPanel) },
  color: { label: 'panelColor', icon: Palette, C: memo(ColorPanel) },
  cutout: { label: 'panelCutout', icon: Scissors, C: memo(CutoutPanel) },
  videotools: { label: 'panelVideoTools', icon: Film, C: memo(VideoToolsPanel) },
  animation: { label: 'animation', icon: Move, C: memo(AnimationPanel) },
  audiofx: { label: 'panelAudioFx', icon: AudioLines, C: memo(AudioFxPanel) },
  chat: { label: 'chatTab', icon: MessageSquare, C: memo(ChatPanel), fill: true },
  ideas: { label: 'ideasTab', icon: Lightbulb, C: memo(IdeasPanel) },
  style: { label: 'styleTab', icon: Brush, C: memo(StylePanel) },
  player: { label: 'program', icon: MonitorPlay, C: memo(Player), fill: true },
};

const TimelinePanel = memo(Timeline);
const DragCtx = createContext(null);
const SPLIT = 4;

/** Pointer drag for splitters: moves are coalesced to one update per animation frame. */
function drag(e, onMove, onEnd) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  let raf = 0, dx = 0, dy = 0;
  const flush = () => { raf = 0; onMove(dx, dy); };
  const move = (ev) => { dx = ev.clientX - x0; dy = ev.clientY - y0; if (!raf) raf = requestAnimationFrame(flush); };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (raf) { cancelAnimationFrame(raf); flush(); }
    document.body.classList.remove('dock-busy');
    onEnd?.();
  };
  document.body.classList.add('dock-busy');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Where would a dragged tab (item.panel) or group (item.group) dropped at (x, y) go? → { gid, zone, rect } or null. */
function hitTest(x, y, item, from) {
  const el = document.elementFromPoint(x, y)?.closest('[data-gid]');
  if (!el) return null;
  const gid = el.dataset.gid;
  const r = el.getBoundingClientRect();
  let zone = 'center';
  if (y > r.top + 32) {
    const d = { left: (x - r.left) / r.width, right: (r.right - x) / r.width, top: (y - r.top) / r.height, bottom: (r.bottom - y) / r.height };
    const [edge, v] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
    if (v < 0.27) zone = edge;
  }
  const L = selectLayout(useStore.getState());
  if (item.group ? !canDropGroup(L, item.group, gid, zone) : !canDrop(L, item.panel, from, gid, zone)) return null;
  const half = { left: { width: r.width / 2 }, right: { left: r.left + r.width / 2, width: r.width / 2 }, top: { height: r.height / 2 }, bottom: { top: r.top + r.height / 2, height: r.height / 2 } }[zone] || {};
  return { gid, zone, rect: { left: r.left, top: r.top, width: r.width, height: r.height, ...half } };
}

export function Dock() {
  const layout = useStore(selectLayout);
  const setLayout = useStore((s) => s.setLayout);
  const [dragging, setDragging] = useState(null); // { panel, x, y, target }
  const upperRef = useRef(null);
  const justDragged = useRef(0);

  // item = { panel } (a tab) or { group } (the whole group, grabbed by the empty part of its tab bar)
  const startTabDrag = (e, item, from) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let active = false;
    const move = (ev) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!active) document.body.classList.add('dock-busy');
      active = true;
      setDragging({ item, x: ev.clientX, y: ev.clientY, target: hitTest(ev.clientX, ev.clientY, item, from) });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!active) return;
      document.body.classList.remove('dock-busy');
      justDragged.current = Date.now();
      const target = hitTest(ev.clientX, ev.clientY, item, from);
      setDragging(null);
      if (target) setLayout((L) => (item.group ? moveGroup(L, item.group, target.gid, target.zone) : moveTab(L, item.panel, from, target.gid, target.zone)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // column splitter: resize the neighbour(s) so that the pointer stays on the splitter; the monitor column absorbs the rest
  const colEls = () => [...(upperRef.current?.querySelectorAll(':scope > .dock-col, :scope > .dock-strip') || [])];
  const resizeCols = (i) => (e) => {
    const els = colEls();
    const a = layout.cols[i - 1], b = layout.cols[i];
    const wa = els[i - 1]?.getBoundingClientRect().width || a.w, wb = els[i]?.getBoundingClientRect().width || b.w;
    const pi = layout.cols.findIndex(isPlayerCol);
    const fixA = !isPlayerCol(a) && !isStrip(a), fixB = !isPlayerCol(b) && !isStrip(b);
    drag(e, (dx) => setLayout((L) => {
      const n = structuredClone(L);
      const A = n.cols.find((c) => c.id === a.id), B = n.cols.find((c) => c.id === b.id);
      if (!A || !B) return L;
      if (fixA && fixB) {
        if (pi > i) A.w = Math.max(COL_MIN, wa + dx);
        else if (pi < i - 1) B.w = Math.max(COL_MIN, wb - dx);
        else { A.w = Math.max(COL_MIN, wa + dx); B.w = Math.max(COL_MIN, wb - dx); }
      } else if (fixA) A.w = Math.max(COL_MIN, wa + dx);
      else if (fixB) B.w = Math.max(COL_MIN, wb - dx);
      return n;
    }));
  };
  const resizeTimeline = (e) => {
    const h0 = layout.timeline;
    drag(e, (dx, dy) => setLayout((L) => ({ ...L, timeline: Math.max(150, Math.min(window.innerHeight - 260, h0 - dy)) })));
  };

  const columns = layout.cols.map((c) => (isStrip(c) ? `${STRIP_W}px` : isPlayerCol(c) ? `minmax(${PLAYER_MIN}px, 1fr)` : `minmax(${COL_MIN}px, ${c.w}px)`));
  return (
    <DragCtx.Provider value={{ startTabDrag, justDragged }}>
      <div className="workspace" style={{ gridTemplateRows: `minmax(0, 1fr) ${SPLIT}px ${layout.timeline}px` }}>
        <div className="upper" ref={upperRef} style={{ gridTemplateColumns: columns.join(` ${SPLIT}px `) }}>
          {layout.cols.map((c, i) => (
            <React.Fragment key={c.id}>
              {i > 0 && <div className={`splitter-v ${isStrip(c) || isStrip(layout.cols[i - 1]) ? 'off' : ''}`} onPointerDown={isStrip(c) && isStrip(layout.cols[i - 1]) ? undefined : resizeCols(i)} />}
              {isStrip(c) ? <Strip col={c} /> : <Column col={c} />}
            </React.Fragment>
          ))}
        </div>
        <div className="splitter-h" onPointerDown={resizeTimeline} />
        <div className="frame timeline-frame"><TimelinePanel /></div>
      </div>
      {dragging && <DragGhost {...dragging} />}
    </DragCtx.Provider>
  );
}

function DragGhost({ item, x, y, target }) {
  const t = useT();
  const layout = useStore(selectLayout);
  const tabs = item.group ? (layout.cols.flatMap((c) => c.groups).find((g) => g.id === item.group)?.tabs || []) : [item.panel];
  const panel = tabs[0];
  const P = PANELS[panel];
  return (
    <>
      {target && <div className={`dock-drop ${target.zone}`} style={target.rect} />}
      <div className="dock-ghost" style={{ left: x + 12, top: y + 10 }}>{P && <P.icon size={13} />} {t(P?.label || panel)}{tabs.length > 1 ? ` +${tabs.length - 1}` : ''}</div>
    </>
  );
}

function Column({ col }) {
  const setLayout = useStore((s) => s.setLayout);
  const ref = useRef(null);
  const resizeGroups = (gi) => (e) => {
    const els = [...ref.current.querySelectorAll(':scope > .dock-group')];
    const ga = col.groups[gi - 1], gb = col.groups[gi];
    if (ga.min || gb.min) return;
    const ha = els[gi - 1].getBoundingClientRect().height, hb = els[gi].getBoundingClientRect().height;
    const total = ga.h + gb.h;
    drag(e, (dx, dy) => {
      const na = Math.max(GROUP_MIN_H, Math.min(ha + hb - GROUP_MIN_H, ha + dy));
      setLayout((L) => {
        const n = structuredClone(L);
        const c = n.cols.find((x) => x.id === col.id);
        if (!c) return L;
        c.groups[gi - 1].h = (na / (ha + hb)) * total;
        c.groups[gi].h = ((ha + hb - na) / (ha + hb)) * total;
        return n;
      });
    });
  };
  return (
    <div className="dock-col" ref={ref}>
      {col.groups.map((g, gi) => (
        <React.Fragment key={g.id}>
          {gi > 0 && <div className={`splitter-h ${g.min || col.groups[gi - 1].min ? 'off' : ''}`} onPointerDown={resizeGroups(gi)} />}
          <Group g={g} />
        </React.Fragment>
      ))}
    </div>
  );
}

/** A minimised column: a thin vertical strip listing its panels; clicking one brings the group back. */
function Strip({ col }) {
  const t = useT();
  const setLayout = useStore((s) => s.setLayout);
  return (
    <div className="dock-strip">
      {col.groups.map((g) => (
        <div key={g.id} className="strip-group">
          <button className="icon-btn xs" title={t('restore')} onClick={() => setLayout((L) => updateGroup(L, g.id, { min: false }))}><Maximize2 size={12} /></button>
          {g.tabs.map((p) => {
            const P = PANELS[p];
            return (
              <button key={p} className="strip-tab" title={t(P.label)} onClick={() => setLayout((L) => updateGroup(L, g.id, { min: false, active: p }))}>
                <P.icon size={13} /><span>{t(P.label)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Group({ g }) {
  const P = PANELS[g.active];
  const Body = P?.C;
  const monitor = g.tabs.includes('player');
  return (
    <div className={`frame dock-group ${g.min ? 'min' : ''} ${monitor ? 'program' : ''}`} data-gid={g.id} data-panels={g.tabs.join(' ')} style={g.min ? undefined : { flex: `${g.h} 1 0` }}>
      {monitor ? <MonitorGrip g={g} /> : <TabBar g={g} />}
      {!g.min && Body && <div className={`frame-body ${P.fill ? 'fill' : ''}`}><Body /></div>}
    </div>
  );
}

const openIdeas = (s) => (s.project?.proposals || []).filter((x) => x.status === 'pending').length + (s.project?.requests || []).filter((x) => x.status === 'open' || x.status === 'working').length;
/** The program monitor has no title bar: a small grip appears on hover to drag it elsewhere. */
function MonitorGrip({ g }) {
  const t = useT();
  const { startTabDrag } = useContext(DragCtx);
  return <div className="monitor-grip" title={t('moveMonitor')} onPointerDown={(e) => startTabDrag(e, { group: g.id }, g.id)}><GripHorizontal size={14} /></div>;
}

function useTabExtra() {
  const ideas = useStore(openIdeas);
  return (p) => (p === 'ideas' && ideas > 0 ? <span className="count-badge">{ideas}</span> : null);
}

/**
 * Tab strip of a group. When the names do not all fit, the active tab keeps its name and the others shrink to
 * their icon (name in the tooltip); only if even the icons do not fit do the last ones go to the "»" menu.
 * The active tab is always visible and the strip never scrolls (a scrolled strip used to hide the first tabs).
 */
function TabBar({ g }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const projectName = useStore((s) => s.project?.name || '');
  const setLayout = useStore((s) => s.setLayout);
  const layout = useStore(selectLayout);
  const { startTabDrag, justDragged } = useContext(DragCtx);
  const extra = useTabExtra();
  const boxRef = useRef(null);
  const measureRef = useRef(null);
  const [fitState, setFitState] = useState({ visible: g.tabs, compact: false });
  const { visible, compact } = fitState;
  const [more, setMore] = useState(null);
  const [menu, setMenu] = useState(null);
  const label = (p) => (p === 'player' ? `${t('program')} : ${projectName}` : t(PANELS[p].label));

  useLayoutEffect(() => {
    const fit = () => {
      const box = boxRef.current, m = measureRef.current;
      if (!box || !m) return;
      const n = g.tabs.length;
      const all = [...m.children].map((el) => el.getBoundingClientRect().width);
      const lw = all.slice(0, n), iw = all.slice(n, 2 * n); // with names / icon only
      const avail = box.clientWidth + 0.5;
      const ai = Math.max(0, g.tabs.indexOf(g.active));
      let next = g.tabs, small = false;
      if (lw.reduce((a, b) => a + b, 0) > avail) {
        small = true;
        const compactTotal = lw[ai] + iw.reduce((a, b, i) => a + (i === ai ? 0 : b), 0);
        if (compactTotal > avail) {
          const room = avail - 30; // the "»" button
          let used = lw[ai] || 0;
          const keep = new Set([g.active]);
          for (let i = 0; i < n; i++) {
            if (i === ai) continue;
            if (used + iw[i] > room) break;
            keep.add(g.tabs[i]);
            used += iw[i];
          }
          next = g.tabs.filter((p) => keep.has(p));
        }
      }
      setFitState((s) => (s.compact === small && s.visible.join() === next.join() ? s : { visible: next, compact: small }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (boxRef.current) ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [g.tabs.join(), g.active, lang, projectName]);

  const hidden = g.tabs.filter((p) => !visible.includes(p));
  const activate = (p) => { if (Date.now() - justDragged.current < 200) return; setLayout((L) => updateGroup(L, g.id, { active: p, min: false })); };
  const notDocked = ALL_PANELS.filter((p) => p !== 'player' && !hasPanel(layout, p));
  const openMenu = (e, p) => {
    e.preventDefault();
    const items = [];
    if (p && p !== 'player') items.push({ label: t('closePanel'), icon: X, onClick: () => setLayout((L) => closePanel(L, p)) });
    if (!g.tabs.includes('player')) items.push({ label: g.min ? t('restore') : t('minimize'), icon: g.min ? Maximize2 : Minimize2, onClick: () => setLayout((L) => updateGroup(L, g.id, { min: !g.min })) });
    if (!g.tabs.includes('player') && notDocked.length) {
      items.push({ sep: true }, { header: t('addHere') });
      for (const q of notDocked) items.push({ label: t(PANELS[q].label), icon: PANELS[q].icon, onClick: () => setLayout((L) => { const n = structuredClone(L); for (const c of n.cols) for (const x of c.groups) if (x.id === g.id) { x.tabs.push(q); x.active = q; x.min = false; } return n; }) });
    }
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="tabs-wrap dock-tabs" onPointerDown={(e) => { if (!e.target.closest('button')) startTabDrag(e, { group: g.id }, g.id); }} onContextMenu={(e) => openMenu(e, null)} onDoubleClick={(e) => { if (!e.target.closest('button') && !g.tabs.includes('player')) setLayout((L) => updateGroup(L, g.id, { min: !g.min })); }}>
      <div className="frame-tabs" ref={boxRef}>
        {visible.map((p) => {
          const iconOnly = compact && p !== g.active;
          const Icon = PANELS[p].icon;
          return (
            <button key={p} className={`tab ${g.active === p ? 'on' : ''} ${iconOnly ? 'ico' : ''}`} title={iconOnly ? label(p) : undefined}
              onPointerDown={(e) => startTabDrag(e, { panel: p }, g.id)} onClick={() => activate(p)} onContextMenu={(e) => { e.stopPropagation(); openMenu(e, p); }}>
              {iconOnly ? <Icon size={14} /> : label(p)}{extra(p)}
            </button>
          );
        })}
        <div className="tabs-measure" ref={measureRef} aria-hidden="true">
          {g.tabs.map((p) => <span key={p} className="tab">{label(p)}{extra(p)}</span>)}
          {g.tabs.map((p) => { const Icon = PANELS[p].icon; return <span key={`i-${p}`} className="tab ico"><Icon size={14} />{extra(p)}</span>; })}
        </div>
      </div>
      <div className="tab-actions">
        {hidden.length > 0 && (
          <button className="icon-btn xs" title={t('moreTabs')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const anchor = e.currentTarget; setMore(more ? null : { x: r.right, y: r.bottom + 4, anchor, items: hidden.map((p) => ({ label: label(p), icon: PANELS[p].icon, onClick: () => activate(p) })) }); }}><ChevronsRight size={13} /></button>
        )}
        {!g.tabs.includes('player') && (
          <button className="icon-btn xs" title={g.min ? t('restore') : t('minimize')} onClick={() => setLayout((L) => updateGroup(L, g.id, { min: !g.min }))}>{g.min ? <Maximize2 size={12} /> : <Minimize2 size={12} />}</button>
        )}
      </div>
      {more && <Menu {...more} align="right" onClose={() => setMore(null)} />}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Top-bar "Panels" menu: show / hide any panel, reset the workspace. */
export function PanelsMenu({ x, y, onClose }) {
  const t = useT();
  const layout = useStore(selectLayout);
  const st = useStore.getState();
  const items = [{ header: t('panelsMenu') }];
  for (const p of ALL_PANELS.filter((q) => q !== 'player')) {
    const on = hasPanel(layout, p);
    items.push({ label: t(PANELS[p].label), icon: PANELS[p].icon, checked: on, keepOpen: true, onClick: () => (on ? st.closePanel(p) : st.focusPanel(p)) });
  }
  items.push({ sep: true }, { label: t('wsReset'), icon: RotateCcw, onClick: () => st.resetWorkspace(st.activeWs) }, { note: t('panelsHint') });
  return <Menu x={x} y={y} items={items} align="right" onClose={onClose} />;
}
