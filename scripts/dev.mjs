// Dev runner: starts Vite (HMR) and Electron pointing at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron');

const server = await createServer({ configFile: path.join(root, 'vite.config.js') });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] vite at ${url}`);
const proc = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
proc.on('close', async (code) => { await server.close(); process.exit(code ?? 0); });
