import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository / app root (contains package.json). Inside a packaged app this is .../resources/app.asar */
export const APP_ROOT = path.resolve(here, '..', '..');

/** Unpacked location (asarUnpack) for files that external processes must read. */
export function unpacked(p) {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

export const RESOURCES_DIR = unpacked(path.join(APP_ROOT, 'resources'));
export const SHARED_DIR = path.join(APP_ROOT, 'shared');
export const DIST_DIR = path.join(APP_ROOT, 'dist');
export const BIN_SCRIPTS_DIR = unpacked(path.join(APP_ROOT, 'bin'));

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export const userDir = (...p) => path.join(app.getPath('userData'), ...p);
export const toolsBinDir = () => ensureDir(userDir('bin'));
export const modelsDir = () => ensureDir(userDir('models'));
export const libraryDir = () => ensureDir(userDir('library'));
export const logsDir = () => ensureDir(userDir('logs'));
export const tempDir = () => ensureDir(path.join(app.getPath('temp'), 'aicut'));
export const defaultProjectsDir = () => path.join(app.getPath('documents'), 'AI.cut Projects');

/** Project-relative cache folders */
export const projectCacheDir = (projectDir, ...p) => ensureDir(path.join(projectDir, '.aicut-cache', ...p));
