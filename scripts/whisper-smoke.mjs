// Quick smoke test for the whisper.cpp binding: node scripts/whisper-smoke.mjs <model> <wav16k> [variant]
import { initWhisper } from '@fugood/whisper.node';

const [model, wav, variant = 'default'] = process.argv.slice(2);
const t0 = Date.now();
const ctx = await initWhisper({ filePath: model, useGpu: variant !== 'default' }, variant);
console.log('init ms', Date.now() - t0);
const t1 = Date.now();
const { promise } = ctx.transcribeFile(wav, {
  language: 'auto', maxLen: 1, tokenTimestamps: true, maxThreads: 6,
  onProgress: (p) => process.stdout.write(`progress ${p}\r`),
});
const res = await promise;
console.log('\ntranscribe ms', Date.now() - t1, 'language', res.language);
console.log('text:', res.result);
console.log('segments', res.segments.length);
console.log(JSON.stringify(res.segments.slice(0, 25)));
await ctx.release();
