// Thin wrapper around the preload bridge.
import { useStore } from './store.js';

export const bridge = window.aicut;

export async function call(method, args) {
  return bridge.call(method, args);
}

/** Run an editing op on the project (undoable). Shows warnings/errors as toasts. */
export async function op(name, args, label) {
  try {
    const r = await bridge.call('project:op', { name, args, label });
    if (r?.warnings?.length) useStore.getState().toast('warning', r.warnings.join(' '));
    return r?.result;
  } catch (e) {
    useStore.getState().toast('error', e.message);
    return null;
  }
}

export async function safe(method, args, okMessage) {
  try {
    const r = await bridge.call(method, args);
    if (okMessage) useStore.getState().toast('success', okMessage);
    return r;
  } catch (e) {
    useStore.getState().toast('error', e.message);
    return null;
  }
}

export const fileUrl = (p, rev) => (p ? `aicut://file/${encodeURIComponent(p)}${rev ? `?v=${rev}` : ''}` : null);
