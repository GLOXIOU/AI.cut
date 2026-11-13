// Checks that the ffmpeg expressions generated for clip animations (export) match the JS evaluation (preview).
// node scripts/anim-test.mjs
import { ANIM_IN_IDS, ANIM_OUT_IDS, ANIM_LOOP_IDS, animStateAt, animExprs, normalizeAnim } from '../shared/anim.js';

// Tiny evaluator for the subset of the ffmpeg expression language we generate.
const FN = {
  IF: (c, a, b) => (c ? a : b), lt: (a, b) => (a < b ? 1 : 0), lte: (a, b) => (a <= b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0), eq: (a, b) => (a === b ? 1 : 0), clip: (x, a, b) => Math.min(b, Math.max(a, x)),
  pow: Math.pow, sin: Math.sin, cos: Math.cos, abs: Math.abs, max: Math.max, min: Math.min, hypot: Math.hypot, trunc: Math.trunc,
};
function evalFf(expr, t) {
  const js = expr.replace(/\bif\(/g, 'IF(');
  // eslint-disable-next-line no-new-func
  const f = new Function(...Object.keys(FN), 'PI', 't', `return (${js});`);
  return f(...Object.values(FN), Math.PI, t);
}

const ctx = { W: 1920, H: 1080, w: 960, h: 540, x: 300, y: -120 };
const props = ['dx', 'dy', 's', 'sx', 'sy', 'r', 'o', 'z', 'pu', 'pv'];
const ident = { dx: 0, dy: 0, s: 1, sx: 1, sy: 1, r: 0, o: 1, z: 1, pu: 0, pv: 0 };
let bad = 0, checks = 0;
function check(name, anim, D = 4) {
  const clip = { duration: D, anim: normalizeAnim(anim) };
  const E = animExprs(clip, ctx, '(t)');
  for (let i = 0; i <= 200; i++) {
    const t = (D * i) / 200;
    const js = animStateAt(clip, t, ctx);
    for (const p of props) {
      const ff = E[p] ? evalFf(E[p], t) : ident[p];
      checks++;
      if (!Number.isFinite(ff) || Math.abs(ff - js[p]) > 1e-4 * Math.max(1, Math.abs(js[p]))) {
        if (bad < 25) console.log(`MISMATCH ${name} ${p} t=${t.toFixed(3)} js=${js[p]} ff=${ff}\n   ${E[p]}`);
        bad++;
      }
    }
  }
}
for (const id of ANIM_IN_IDS) check(`in:${id}`, { in: { type: id, duration: 0.6 } });
for (const id of ANIM_OUT_IDS) check(`out:${id}`, { out: { type: id, duration: 0.7 } });
for (const id of ANIM_LOOP_IDS) check(`loop:${id}`, { loop: { type: id, amount: 1.3, speed: 1.2, offset: 0.5, span: 6 } });
check('combo', { in: { type: 'pop', duration: 0.5 }, out: { type: 'slide-left', duration: 0.5 }, loop: { type: 'cloud' } });
check('overlap', { in: { type: 'elastic', duration: 3 }, out: { type: 'glitch', duration: 3 }, loop: { type: 'living' } }, 2);
console.log(bad ? `❌ ${bad}/${checks} mismatches` : `✅ ${checks} values match (${ANIM_IN_IDS.length} in, ${ANIM_OUT_IDS.length} out, ${ANIM_LOOP_IDS.length} loops)`);
process.exit(bad ? 1 : 0);
