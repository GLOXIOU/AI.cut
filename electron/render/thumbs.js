// Still thumbnails of motion templates (rendered once offscreen, cached in userData/motion-thumbs).
import fs from 'node:fs';
import path from 'node:path';
import { userDir } from '../core/paths.js';
import { sha1, uid, exists } from '../core/util.js';
import { log } from '../core/log.js';
import { getTemplate, composeHtmlClip } from './html.js';
import { renderHtmlFrame } from './html-renderer.js';
import { registerRenderDoc, unregisterRenderDoc } from '../media/protocol.js';

const VERSION = 2;
let queue = Promise.resolve();
const inflight = new Map();

/** PNG thumbnail of a template (640×360, transparent background). Returns the file path or null. */
export function templateThumb(id) {
  const tpl = getTemplate(id);
  if (!tpl) return Promise.resolve(null);
  const W = 640, H = 360;
  const key = sha1(`${VERSION}|${id}|${tpl.source}|${JSON.stringify(tpl.params || [])}|${W}x${H}`).slice(0, 16);
  const dir = userDir('motion-thumbs');
  const file = path.join(dir, `${String(id).replace(/[^\w-]+/g, '_')}_${key}.png`);
  if (exists(file)) return Promise.resolve(file);
  if (inflight.has(file)) return inflight.get(file);
  const job = queue.then(async () => {
    if (exists(file)) return file;
    fs.mkdirSync(dir, { recursive: true });
    const dur = tpl.defaultDuration || 4;
    const fake = { id: `thumb_${id}`, type: 'html', duration: dur, html: { template: id, params: {} } };
    const token = uid('thumb', 10);
    const url = registerRenderDoc(token, composeHtmlClip(fake, { settings: { width: W, height: H, fps: 30 } }, { mode: 'render' }));
    try {
      // most graphics are fully on screen a little after the middle of their duration
      await renderHtmlFrame({ url, width: W, height: H, time: Math.min(dur * 0.55, Math.max(0.6, dur - 0.6)), out: file });
      return file;
    } catch (e) {
      log.warn('template thumbnail failed', id, e.message);
      return null;
    } finally {
      unregisterRenderDoc(token);
      inflight.delete(file);
    }
  });
  queue = job.catch(() => null);
  inflight.set(file, job);
  return job;
}
