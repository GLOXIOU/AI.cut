import React, { useState } from 'react';
import { Undo2, Redo2, Upload, Settings, Save, Plug, Plus, Pencil, Copy, RotateCcw, Trash2, LayoutPanelLeft, House } from 'lucide-react';
import { useStore, selectLayout } from '../app/store.js';
import { call } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { AI_PANELS, panelsShown } from '../app/layout.js';
import { useShortcut } from '../app/shortcuts.js';
import { Menu } from './ui/Menu.jsx';
import { PanelsMenu } from './layout/Dock.jsx';

/** App logo (rounded square + diamond, as resources/icon.png) in black & white. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect x="12" y="12" width="488" height="488" rx="104" fill="#000" stroke="rgba(255,255,255,.22)" strokeWidth="24" />
      <path d="M256 88 L424 256 L256 424 L88 256 Z" fill="#fff" />
    </svg>
  );
}

/**
 * AI status: compact "● AI" toggle for the AI panels once an AI is usable (an MCP client is connected
 * or the built-in chat can run); otherwise "Connect an AI", which opens Settings → Connect an AI.
 */
function AiButton() {
  const t = useT();
  const project = useStore((s) => s.project);
  const sessions = useStore((s) => s.sessions).filter((x) => x.active !== false);
  const copilot = useStore((s) => s.copilot);
  const activity = useStore((s) => s.activity);
  const layout = useStore(selectLayout);
  const last = activity[activity.length - 1];
  const busy = (last && last.status === 'running') || copilot?.busy;
  const clients = [...new Set(sessions.map((s) => s.client))];
  const ready = sessions.length > 0 || !!copilot?.available;
  if (!ready) {
    return (
      <button className="ai-btn connect" onClick={() => useStore.getState().openSettings('connect')}>
        <Plug size={13} /> {t('aiConnect')}
      </button>
    );
  }
  const shown = panelsShown(layout, AI_PANELS).open; // docked and unfolded
  const who = clients.length ? clients.join(', ') : t('builtinChat');
  return (
    <button className={`ai-btn ${shown && project ? 'on' : ''}`} title={t('aiReadyTitle', { c: who })}
      onClick={() => (project ? useStore.getState().toggleAi() : useStore.getState().openSettings('connect'))}>
      <span className={`dot ${busy ? 'busy' : 'ok'}`} /> {t('aiShort')}
    </button>
  );
}

/** Workspace switcher: each one is a full layout; double-click renames, right-click for more, "+" adds one. */
function Workspaces() {
  const t = useT();
  const list = useStore((s) => s.workspaces);
  const active = useStore((s) => s.activeWs);
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const st = useStore.getState();
  const name = (w) => w.name || (w.nameKey ? t(w.nameKey) : '…');
  const add = () => {
    let n = list.length + 1;
    while (list.some((w) => name(w) === t('wsNewName', { n }))) n++;
    setEditing(st.addWorkspace(t('wsNewName', { n })));
  };
  const openMenu = (e, w) => {
    e.preventDefault();
    setMenu({
      x: e.clientX, y: e.clientY, items: [
        { label: t('wsRename'), icon: Pencil, onClick: () => setEditing(w.id) },
        { label: t('wsDuplicate'), icon: Copy, onClick: () => setEditing(st.duplicateWorkspace(w.id, t('wsCopy', { name: name(w) }))) },
        { label: t('wsReset'), icon: RotateCcw, onClick: () => st.resetWorkspace(w.id) },
        { sep: true },
        { label: t('wsDelete'), icon: Trash2, danger: true, disabled: list.length <= 1, onClick: () => st.deleteWorkspace(w.id) },
      ],
    });
  };
  return (
    <div className="workspaces">
      {list.map((w) => (editing === w.id ? (
        <input key={w.id} className="ws-edit" autoFocus defaultValue={name(w)} onFocus={(e) => e.target.select()}
          onBlur={(e) => { st.renameWorkspace(w.id, e.target.value); setEditing(null); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { st.renameWorkspace(w.id, e.currentTarget.value); setEditing(null); } if (e.key === 'Escape') setEditing(null); }} />
      ) : (
        <button key={w.id} className={active === w.id ? 'on' : ''} title={t('wsHint')} onClick={() => st.switchWorkspace(w.id)} onDoubleClick={() => setEditing(w.id)} onContextMenu={(e) => openMenu(e, w)}>{name(w)}</button>
      )))}
      <button className="ws-add" title={t('wsNew')} onClick={add}><Plus size={13} /></button>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function TopBar() {
  const t = useT();
  const kb = useShortcut();
  const withKey = (label, id) => (kb(id) ? `${label} (${kb(id)})` : label);
  const project = useStore((s) => s.project);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const [panels, setPanels] = useState(null);

  return (
    <div className="topbar">
      <div className="tb-left">
        <div className="brand"><BrandMark /><span>AI.cut</span></div>
        {project && (
          <div className="tb-project">
            <button className="btn sm quiet tb-home" title={t('homeBtnTitle')} onClick={() => call('project:close')}><House size={14} /> <span>{t('homeBtn')}</span></button>
            <span className="tb-name" title={project.name}>{project.name}</span>
            <span className="tb-res">{project.settings.width}×{project.settings.height} · {project.settings.fps} {t('fpsUnit')}</span>
            <button className="icon-btn" disabled={!canUndo} title={withKey(t('undo'), 'undo')} onClick={() => call('project:undo')}><Undo2 size={14} /></button>
            <button className="icon-btn" disabled={!canRedo} title={withKey(t('redo'), 'redo')} onClick={() => call('project:redo')}><Redo2 size={14} /></button>
            <button className="icon-btn" title={withKey(t('save'), 'save')} onClick={() => call('project:save').then(() => useStore.getState().toast('success', t('saved')))}><Save size={14} /></button>
          </div>
        )}
      </div>
      <div className="tb-center">
        {project && <Workspaces />}
      </div>
      <div className="tb-right">
        <AiButton />
        {project && (
          <button className={`icon-btn ${panels ? 'on' : ''}`} title={t('panelsMenu')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPanels(panels ? null : { x: r.right, y: r.bottom + 6, anchor: e.currentTarget }); }}><LayoutPanelLeft size={15} /></button>
        )}
        <button className="icon-btn" title={t('settings')} onClick={() => useStore.getState().openSettings('general')}><Settings size={15} /></button>
        {project && <button className="btn primary sm" onClick={() => useStore.setState({ dialog: 'export' })}><Upload size={13} /> {t('export')}</button>}
      </div>
      {panels && <PanelsMenu {...panels} onClose={() => setPanels(null)} />}
    </div>
  );
}
