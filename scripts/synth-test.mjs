import { SFX, renderSfx } from '../electron/library/synth.js';
import fs from 'node:fs';
const t0 = Date.now(); let bad = [];
for (const s of SFX) { const t = Date.now(); const r = renderSfx(s.id); const pcm = new Int16Array(r.wav.buffer, r.wav.byteOffset + 44, (r.wav.length - 44) / 2); let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v)); if (!(peak > 1000)) bad.push(s.id + ':' + peak); fs.writeFileSync(process.argv[2] + '/' + s.id + '.wav', r.wav); console.log(s.id.padEnd(18), r.duration.toFixed(2) + 's', (Date.now() - t) + 'ms', 'peak', peak); }
console.log('total', SFX.length, 'sounds in', Date.now() - t0, 'ms; silent/bad:', bad.join(',') || 'none');

