// Timeline → ffmpeg filter graph. Mirrors the preview math in shared/timeline.js exactly.
import {
  r4, clipEnd, mediaById, videoTracks, audioTracks, trackSpans, clipGeometry, isAudible, ffColorChain, ffChromaKey,
  isNeutralColor, EPS, clipFrameLook, clipAnimContext, parseColor, evalKeyframes,
} from '../../shared/timeline.js';
import { animUsage, animExprs, animStateAt, animOpacityRanges } from '../../shared/anim.js';
import { audioFxFilters } from '../../shared/audiofx.js';
import { maskAt, ffMaskLumExpr, maskParams } from '../../shared/fx.js';
import { bakeProject } from '../../shared/follow.js';

const f = (x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) return '0';
  return Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1e6) / 1e6);
};
const even = (x) => Math.max(2, Math.round(x / 2) * 2);

// ----------------------------------------------------------------------------------------------
// Keyframe → ffmpeg expression
// ----------------------------------------------------------------------------------------------
function easeExpr(name, P) {
  switch (name) {
    case 'ease-in': return `pow(${P},3)`;
    case 'ease-out': return `(1-pow(1-${P},3))`;
    case 'ease-in-out': return `if(lt(${P},0.5),4*pow(${P},3),1-pow(-2*${P}+2,3)/2)`;
    case 'hold': return '0';
    default: return P;
  }
}
/**
 * Piecewise expression of keyframes for variable tv (string). Segments are selected by a BALANCED tree of if()s:
 * ffmpeg's expression parser limits the nesting depth (~100), and follow / tracking paths have hundreds of keys.
 */
export function kfExpr(kfs, tv, base) {
  if (!kfs || !kfs.length) return f(base);
  const k = [...kfs].sort((a, b) => a.t - b.t);
  if (k.length === 1) return f(k[0].v);
  const last = k[k.length - 1];
  const seg = (i) => {
    const a = k[i], b = k[i + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const P = `((${tv}-${f(a.t)})/${f(span)})`;
    return `(${f(a.v)}+(${f(b.v - a.v)})*${easeExpr(a.ease, P)})`;
  };
  const build = (lo, hi) => { // segments lo..hi (segment i covers [k[i].t, k[i+1].t))
    if (lo === hi) return seg(lo);
    const mid = (lo + hi + 1) >> 1;
    return `if(lt(${tv},${f(k[mid].t)}),${build(lo, mid - 1)},${build(mid, hi)})`;
  };
  return `if(lt(${tv},${f(k[0].t)}),${f(k[0].v)},if(gte(${tv},${f(last.t)}),${f(last.v)},${build(0, k.length - 2)}))`;
}
const animated = (kfs) => kfs && kfs.length > 1;

// ----------------------------------------------------------------------------------------------
// Graph builder
// ----------------------------------------------------------------------------------------------
class Graph {
  constructor() { this.inputs = []; this.lines = []; this.n = 0; }
  input(args) { this.inputs.push(args); return this.inputs.length - 1; }
  label(p = 'x') { return `${p}${this.n++}`; }
  add(line) { this.lines.push(line); }
  text() { return this.lines.join(';\n'); }
}

/**
 * Hardware decoding of a video input (NVDEC / D3D11VA…), frames copied back to system memory by the decoder.
 * Measured on 4K60 HEVC: same speed as the CPU decoder alone but ~4× less CPU, which lets two chunks run at once.
 * Frames are NOT kept on the GPU (-hwaccel_output_format cuda): in a chunk, concat consumes its inputs one after the
 * other while every decoder is already open, the GPU frame pools ran dry and a chunk took minutes.
 */
function decodeInputArgs(opts, media) {
  // VP8 / VP9 with an alpha channel (cutouts, keyed memes): ffmpeg's native decoders drop the alpha, libvpx keeps it
  if (media?.hasAlpha && (media.codec === 'vp9' || media.codec === 'vp8')) return ['-c:v', media.codec === 'vp9' ? 'libvpx-vp9' : 'libvpx'];
  if (!opts.decode || media?.type !== 'video') return [];
  if (opts.decode === 'cuda') return ['-hwaccel', 'cuda'];
  if (opts.decode === 'hwdec' && opts.hwdec) return ['-hwaccel', opts.hwdec];
  return [];
}

export function sourceRangeFor(clip, media, la, lb) {
  const speed = clip.speed || 1;
  const srcA = (clip.in || 0) + la * speed;
  const srcB = (clip.in || 0) + lb * speed;
  const md = media?.duration || 0;
  const pre = Math.max(0, -srcA) / speed;
  const post = Math.max(0, srcB - md) / speed;
  const a = Math.max(0, srcA);
  const b = Math.min(md, srcB);
  return { a, b, pre, post, speed };
}

/**
 * Build the visual chain for one clip span segment [segA, segB) (timeline time).
 * Returns the label of a W×H rgba stream lasting exactly segB - segA.
 */
function clipSegment(g, project, span, segA, segB, opts) {
  const { width: W, height: H, fps } = opts;
  const clip = span.clip;
  const media = mediaById(project, clip.mediaId);
  const dur = r4(segB - segA);
  const la = segA - clip.start;
  const lb = segB - clip.start;
  const margin = 3 / fps;
  const tl = `(t+${f(la)})`; // local clip time inside filters
  let src;
  const chain = [];

  // ---- geometry: base (keyframes) × clip animations (entrance / exit / continuous) — mirrors clipVisualAt()
  const geo = clipGeometry(clip, media, W, H, Math.max(0, la));
  const kf = clip.keyframes || {};
  const crop = clip.crop;
  const cl = crop?.left || 0, cr = crop?.right || 0, ct = crop?.top || 0, cb = crop?.bottom || 0;
  const cw = 1 - cl - cr, ch = 1 - ct - cb;
  const look = clipFrameLook(clip);
  const actx = clipAnimContext(clip, media, W, H);
  const use = animUsage(clip);
  const AE = animExprs(clip, actx, tl);
  const kfScaleAnim = animated(kf.scale);
  const scaleAnimated = kfScaleAnim || !!AE.s || !!AE.sx || !!AE.sy;
  // "static stage": the clip rendered at a fixed size where rounded corners, border, vignette and inner motion are applied
  const needStatic = look.radius > 0 || !!look.border || clip.vignette > 0 || use.inner;
  const stageS = !scaleAnimated ? geo.scale : needStatic ? maxTotalScale(clip, actx) : geo.scale;
  const mxs = scaleAnimated ? maxAxisScale(clip, actx) : null;

  if (clip.type === 'video') {
    const r = sourceRangeFor(clip, media, la, lb);
    const take = Math.max(1 / fps, r.b - r.a);
    const idx = g.input([...decodeInputArgs(opts, media), '-ss', f(r.a), '-t', f(take + margin * r.speed), '-i', media.path]);
    src = `[${idx}:v]`;
    chain.push('setpts=PTS-STARTPTS');
    if (r.speed !== 1) chain.push(`setpts=PTS/${f(r.speed)}`);
    chain.push(`fps=${fps}`);
    if (r.pre > 1e-4 || r.post > 1e-4) chain.push(`tpad=start_mode=clone:start_duration=${f(r.pre)}:stop_mode=clone:stop_duration=${f(r.post + margin)}`);
    chain.push(`trim=duration=${f(dur)}`, 'setpts=PTS-STARTPTS');
  } else if (clip.type === 'image') {
    const idx = g.input(['-loop', '1', '-framerate', String(fps), '-t', f(dur + margin), '-i', media.path]);
    src = `[${idx}:v]`;
    chain.push(`fps=${fps}`, `trim=duration=${f(dur)}`, 'setpts=PTS-STARTPTS');
  } else if (clip.type === 'html') {
    const layer = opts.htmlLayers?.get(clip.id);
    if (!layer) throw new Error(`HTML layer for clip ${clip.id} was not rendered`);
    if (layer.still) {
      const idx = g.input(['-loop', '1', '-framerate', String(fps), '-t', f(dur + margin), '-i', layer.file]);
      src = `[${idx}:v]`;
    } else {
      const off = Math.max(0, la - layer.t0);
      const idx = g.input(['-ss', f(off), '-t', f(dur + margin), '-i', layer.file]);
      src = `[${idx}:v]`;
    }
    chain.push('setpts=PTS-STARTPTS', `fps=${fps}`, `tpad=stop_mode=clone:stop_duration=${f(margin)}`, `trim=duration=${f(dur)}`, 'setpts=PTS-STARTPTS');
  } else if (clip.type === 'color') {
    const lbl = g.label('col');
    g.add(`color=c=${clip.fill || '#000000'}:s=${W}x${H}:r=${fps}:d=${f(dur)}[${lbl}]`);
    src = `[${lbl}]`;
  } else {
    throw new Error(`Unsupported visual clip type ${clip.type}`);
  }

  const S = `(${kfScaleAnim ? kfExpr(kf.scale, tl, clip.scale ?? 1) : f(geo.scale)})${AE.s ? `*(${AE.s})` : ''}`; // total uniform scale
  const SW = `${S}${AE.sx ? `*(${AE.sx})` : ''}`, SH = `${S}${AE.sy ? `*(${AE.sy})` : ''}`; // per-axis
  const stW = even(geo.fw * cw * stageS), stH = even(geo.fh * ch * stageS);
  // per-frame scale, then pad to the max size so that downstream filters (rotate, geq…) always see a constant frame size
  // (ffmpeg's rotate freezes its geometry on the first frame).
  const dynScale = `scale=w='max(2,trunc(${f(geo.fw * cw)}*${SW}/2)*2)':h='max(2,trunc(${f(geo.fh * ch)}*${SH}/2)*2)':eval=frame:flags=bicubic` +
    (mxs ? `,pad=w=${even(geo.fw * cw * mxs.x + 4)}:h=${even(geo.fh * ch * mxs.y + 4)}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame` : '');

  if (crop) chain.push(`crop=w=iw*${f(cw)}:h=ih*${f(ch)}:x=iw*${f(cl)}:y=ih*${f(ct)}`);
  if (!scaleAnimated || needStatic) {
    if (use.inner) {
      // Ken Burns / pan inside the frame: zoom the picture, then crop back to the frame size
      const Z = AE.z || '1';
      const PX = AE.pu ? `(${AE.pu})*${stW}` : '0', PY = AE.pv ? `(${AE.pv})*${stH}` : '0';
      chain.push('format=rgba');
      chain.push(`scale=w='max(${stW},trunc(${stW}*(${Z})/2)*2)':h='max(${stH},trunc(${stH}*(${Z})/2)*2)':eval=frame:flags=bicubic`);
      chain.push(`crop=w=${stW}:h=${stH}:x='clip((iw-${stW})/2-${PX},0,iw-${stW})':y='clip((ih-${stH})/2-${PY},0,ih-${stH})'`);
    } else {
      chain.push(`scale=${stW}:${stH}:flags=bicubic`);
    }
  } else {
    chain.push(dynScale);
  }
  if (clip.flipH) chain.push('hflip');
  if (clip.flipV) chain.push('vflip');
  chain.push('format=rgba');

  let pre = g.label('c');
  g.add(`${src}${chain.join(',')}[${pre}]`);
  // vignette, border and rounded corners at the static stage size
  if (clip.vignette > 0) {
    const vl = g.label('vig');
    g.add(`color=c=black:s=${stW}x${stH}:r=${fps}:d=${f(1 / fps)},format=rgba,geq=r=0:g=0:b=0:a='255*${f(Math.min(1, clip.vignette))}*clip((hypot((X-W/2)/(W/2)\\,(Y-H/2)/(H/2))/1.41421356-0.35)/0.65\\,0\\,1)',loop=loop=-1:size=1:start=0,trim=duration=${f(dur)}[${vl}]`);
    const o = g.label('c');
    g.add(`[${pre}][${vl}]overlay=0:0:format=auto:eof_action=pass[${o}]`);
    pre = o;
  }
  if (look.radius > 0 || look.border) {
    const R = Math.min(look.radius * stageS, stW / 2, stH / 2);
    if (look.border) {
      const bw = Math.min(look.border.width * stageS, stW / 2, stH / 2);
      const [br, bgc, bb, ba] = parseColor(look.border.color, [255, 255, 255, 1]);
      const ring = `clip(${roundRectCoverage(R, 0)}-${roundRectCoverage(Math.max(0, R - bw), bw)},0,1)`;
      const rl = g.label('ring');
      g.add(`color=c=black:s=${stW}x${stH}:r=${fps}:d=${f(1 / fps)},format=rgba,geq=r='${Math.round(br)}':g='${Math.round(bgc)}':b='${Math.round(bb)}':a='255*${f(ba)}*${ring}',loop=loop=-1:size=1:start=0,trim=duration=${f(dur)}[${rl}]`);
      const o = g.label('c');
      g.add(`[${pre}][${rl}]overlay=0:0:format=auto:eof_action=pass[${o}]`);
      pre = o;
    }
    if (R > 0.01) {
      const ml = g.label('mask');
      g.add(`color=c=white:s=${stW}x${stH}:r=${fps}:d=${f(1 / fps)},format=gbrap,geq=r='255':g='255':b='255':a='255*${roundRectCoverage(R, 0)}',loop=loop=-1:size=1:start=0,trim=duration=${f(dur)}[${ml}]`);
      const p0 = g.label('c'), o = g.label('c');
      g.add(`[${pre}]format=gbrap[${p0}]`);
      g.add(`[${p0}][${ml}]blend=c0_mode=normal:c1_mode=normal:c2_mode=normal:c3_mode=multiply:eof_action=pass,format=rgba[${o}]`);
      pre = o;
    }
  }
  // outer animated scale from the static stage
  const post = [];
  if (scaleAnimated && needStatic) post.push(dynScale, 'format=rgba');
  if (clip.chromaKey) post.push(ffChromaKey(clip.chromaKey));
  if (!isNeutralColor(clip.color)) post.push(...ffColorChain(clip.color));

  // opacity: keyframes × animation (piecewise: constant parts with colorchannelmixer, varying parts with geq)
  post.push(...opacityFilters(clip, actx, kf, la, lb));
  // video fades (to/from transparent)
  if (clip.videoFadeIn > 0 && la < clip.videoFadeIn) post.push(`fade=t=in:st=${f(Math.max(0, -la))}:d=${f(clip.videoFadeIn)}:alpha=1`);
  if (clip.videoFadeOut > 0 && lb > clip.duration - clip.videoFadeOut) {
    post.push(`fade=t=out:st=${f(Math.max(0, clip.duration - clip.videoFadeOut - la))}:d=${f(clip.videoFadeOut)}:alpha=1`);
  }
  if (post.length) {
    const o = g.label('c');
    g.add(`[${pre}]${post.join(',')}[${o}]`);
    pre = o;
  }

  // rotation
  const rotAnimated = animated(kf.rotation) || !!AE.r;
  const Rdeg = `(${animated(kf.rotation) ? kfExpr(kf.rotation, tl, clip.rotation || 0) : f(geo.rotation)}${AE.r ? `+(${AE.r})` : ''})`;
  let rotLabel = pre;
  if (rotAnimated || Math.abs(geo.rotation) > 1e-6) {
    const o = g.label('c');
    if (rotAnimated) {
      g.add(`[${pre}]rotate=a='${Rdeg}*PI/180':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)'[${o}]`);
    } else {
      const rad = (geo.rotation * Math.PI) / 180;
      g.add(`[${pre}]rotate=a=${f(rad)}:c=none:ow='rotw(${f(rad)})':oh='roth(${f(rad)})'[${o}]`);
    }
    rotLabel = o;
  }

  // placement on a transparent full-frame canvas
  const offX0 = ((cl - cr) / 2), offY0 = ((ct - cb) / 2); // in units of displayed w/h
  const xAnim = animated(kf.x) || !!AE.dx, yAnim = animated(kf.y) || !!AE.dy;
  let xExpr, yExpr;
  if (xAnim || yAnim || scaleAnimated || rotAnimated) {
    const X = `(${kfExpr(kf.x, tl, clip.x || 0)})${AE.dx ? `+(${AE.dx})` : ''}`;
    const Y = `(${kfExpr(kf.y, tl, clip.y || 0)})${AE.dy ? `+(${AE.dy})` : ''}`;
    const Sx = scaleAnimated ? SW : f(geo.scale), Sy = scaleAnimated ? SH : f(geo.scale);
    const Rr = rotAnimated ? `(${Rdeg}*PI/180)` : f((geo.rotation * Math.PI) / 180);
    const ox = `(${f(offX0 * geo.fw)}*${Sx})`, oy = `(${f(offY0 * geo.fh)}*${Sy})`;
    xExpr = `'${f(W / 2)}+(${X})+(${ox}*cos(${Rr})-${oy}*sin(${Rr}))-overlay_w/2'`;
    yExpr = `'${f(H / 2)}+(${Y})+(${ox}*sin(${Rr})+${oy}*cos(${Rr}))-overlay_h/2'`;
  } else {
    const rad = (geo.rotation * Math.PI) / 180;
    const ox = offX0 * geo.w, oy = offY0 * geo.h;
    const cx = geo.cx + ox * Math.cos(rad) - oy * Math.sin(rad);
    const cy = geo.cy + ox * Math.sin(rad) + oy * Math.cos(rad);
    xExpr = `'${f(cx)}-overlay_w/2'`;
    yExpr = `'${f(cy)}-overlay_h/2'`;
  }
  const bg = g.label('bg');
  g.add(`color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${f(dur)},format=rgba[${bg}]`);
  let out = g.label('seg');
  g.add(`[${bg}][${rotLabel}]overlay=x=${xExpr}:y=${yExpr}:eval=frame:format=auto:eof_action=pass,format=rgba[${out}]`);

  // animated blur (entrance / exit) on the placed layer, one gblur per frame where it is needed
  if (use.b) {
    const steps = [];
    const n = Math.round(dur * fps);
    for (let k = 0; k < n; k++) {
      const st = animStateAt(clip, Math.max(0, Math.min(clip.duration, la + k / fps)), actx);
      if (st.b > 0.25) steps.push(`gblur=sigma=${f(st.b)}:enable='gte(t,${f((k - 0.5) / fps)})*lt(t,${f((k + 0.5) / fps)})'`);
    }
    if (steps.length) {
      const o = g.label('seg');
      g.add(`[${out}]${steps.join(',')},format=rgba[${o}]`);
      out = o;
    }
  }
  // drop shadow (CSS drop-shadow blur radius = 2σ)
  if (look.shadow) {
    const sh = look.shadow;
    const [r0, g0, b0] = parseColor(sh.color);
    const a1 = g.label('sh'), a2 = g.label('sh'), s0 = g.label('sh'), sbg = g.label('sh'), s1 = g.label('sh'), o = g.label('seg');
    g.add(`[${out}]split[${a1}][${a2}]`);
    g.add(`[${a1}]colorchannelmixer=rr=0:rg=0:rb=0:ra=${f(r0 / 255)}:gr=0:gg=0:gb=0:ga=${f(g0 / 255)}:br=0:bg=0:bb=0:ba=${f(b0 / 255)}:aa=${f(sh.opacity)}${sh.blur > 0 ? `,gblur=sigma=${f(sh.blur / 2)}` : ''},format=rgba[${s0}]`);
    g.add(`color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${f(dur)},format=rgba[${sbg}]`);
    g.add(`[${sbg}][${s0}]overlay=x=${Math.round(sh.x)}:y=${Math.round(sh.y)}:format=auto:eof_action=pass[${s1}]`);
    g.add(`[${s1}][${a2}]overlay=0:0:format=auto:eof_action=pass,format=rgba[${o}]`);
    out = o;
  }
  return out;
}

/** ffmpeg expression (X/Y/W/H of geq) of a rounded rectangle coverage (0..1, anti-aliased), inset by `inset` px. */
function roundRectCoverage(R, inset) {
  const qx = `(abs(X+0.5-W/2)-(W/2-${f(inset)})+${f(R)})`;
  const qy = `(abs(Y+0.5-H/2)-(H/2-${f(inset)})+${f(R)})`;
  return `clip(0.5-(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${f(R)}),0,1)`;
}

/** Max total scale (keyframes × animation) over a clip — the static stage is rendered at that size for quality. */
function maxTotalScale(clip, actx) {
  let m = 0;
  const D = clip.duration || 0;
  for (let i = 0; i <= 90; i++) {
    const t = (D * i) / 90;
    const a = animStateAt(clip, t, actx);
    m = Math.max(m, evalKeyframes(clip.keyframes?.scale, t, clip.scale ?? 1) * a.s * Math.max(a.sx, a.sy));
  }
  return Math.max(0.01, m);
}

/** Max per-axis scale (keyframes × animation) over a clip. */
function maxAxisScale(clip, actx) {
  let x = 0, y = 0;
  const D = clip.duration || 0;
  for (let i = 0; i <= 240; i++) {
    const t = (D * i) / 240;
    const a = animStateAt(clip, t, actx);
    const k = evalKeyframes(clip.keyframes?.scale, t, clip.scale ?? 1) * a.s;
    x = Math.max(x, k * a.sx); y = Math.max(y, k * a.sy);
  }
  return { x: Math.max(0.01, x * 1.01), y: Math.max(0.01, y * 1.01) };
}

/** Opacity filters for a segment [la, lb) (clip-local) combining keyframes and animations. */
function opacityFilters(clip, actx, kf, la, lb) {
  const base = clip.opacity ?? 1;
  const kfAnim = animated(kf.opacity);
  const AEo = animExprs(clip, actx, '(T+0)').o; // presence check only
  if (!kfAnim && !AEo) {
    const op = Math.min(1, Math.max(0, kf.opacity?.[0]?.v ?? base));
    return op < 1 ? [`colorchannelmixer=aa=${f(op)}`] : [];
  }
  const Ojs = (t) => Math.min(1, Math.max(0, evalKeyframes(kf.opacity, t, base) * animStateAt(clip, Math.max(0, Math.min(clip.duration, t)), actx).o));
  // local-time intervals where the opacity varies
  const iv = [...animOpacityRanges(clip)];
  if (kfAnim) { const k = [...kf.opacity].sort((a, b) => a.t - b.t); iv.push([k[0].t, k[k.length - 1].t]); }
  iv.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of iv) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1] + 1e-6) l[1] = Math.max(l[1], r[1]); else merged.push([...r]); }
  const tvT = `(T+${f(la)})`;
  const O = `clip((${kfExpr(kf.opacity, tvT, base)})${animExprs(clip, actx, tvT).o ? `*(${animExprs(clip, actx, tvT).o})` : ''},0,1)`;
  const out = [];
  const segEnd = lb - la;
  const en = (a, b) => `enable='gte(t,${f(a)})*lt(t,${f(b)})'`;
  let cursor = -1e9;
  const constPart = (a, b) => { // local [a,b)
    const s = Math.max(a, la - 1), e = Math.min(b, lb + 1);
    if (e <= s) return;
    const v = Ojs((Math.max(a, la) + Math.min(b, lb)) / 2);
    if (v < 0.999) out.push(`colorchannelmixer=aa=${f(v)}:${en(Math.max(-1, a - la), Math.min(segEnd + 1, b - la))}`);
  };
  for (const [a, b] of merged) {
    constPart(cursor, a);
    if (b > la - 1e-6 && a < lb + 1e-6) out.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${O}':${en(a - la, b - la)}`);
    cursor = b;
  }
  constPart(cursor, 1e9);
  return out;
}

function gapSegment(g, dur, { width: W, height: H, fps, opaque, background }) {
  const l = g.label('gap');
  if (opaque) g.add(`color=c=${background || '#000000'}:s=${W}x${H}:r=${fps}:d=${f(dur)},format=yuv420p[${l}]`);
  else g.add(`color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${f(dur)},format=rgba[${l}]`);
  return l;
}

// ----------------------------------------------------------------------------------------------
// Fast path for the bottom track. Its clips are usually plain full-frame shots: no transparency, no animation. They
// are rendered straight to an opaque YUV picture (scale → crop / pad on the background colour) and the track becomes
// the base picture itself: no RGBA conversion, no transparent canvas, no full-frame overlays (2 per frame before).
// ----------------------------------------------------------------------------------------------
const ALPHA_EXT = /\.(png|webp|gif|svg|apng|avif|tiff?)$/i;
function isSimpleSpan(project, s, W, H) {
  const c = s.clip;
  if (c.type === 'color') return true;
  if (c.type !== 'video' && c.type !== 'image') return false;
  const m = mediaById(project, c.mediaId);
  if (!m?.path || m.hasAlpha || (c.type === 'image' && ALPHA_EXT.test(m.path))) return false;
  if (c.crop || c.chromaKey || c.vignette > 0 || c.videoFadeIn > 0 || c.videoFadeOut > 0) return false;
  if ((c.opacity ?? 1) < 0.999) return false;
  if (c.keyframes && Object.entries(c.keyframes).some(([k, v]) => k !== 'volume' && v?.length)) return false;
  if (animUsage(c).any) return false;
  const look = clipFrameLook(c);
  if (look.radius > 0 || look.border || look.shadow) return false;
  const geo = clipGeometry(c, m, W, H, 0);
  return Math.abs(geo.rotation) < 1e-6 && geo.w >= 2 && geo.h >= 2;
}

/** Opaque YUV segment of a simple clip (see isSimpleSpan), exactly segB - segA long. */
function simpleSegment(g, project, span, segA, segB, opts) {
  const { width: W, height: H, fps } = opts;
  const clip = span.clip;
  const media = mediaById(project, clip.mediaId);
  const dur = r4(segB - segA);
  const la = segA - clip.start, lb = segB - clip.start;
  const margin = 3 / fps;
  const bg = project.settings.background || '#000000';
  if (clip.type === 'color') {
    const l = g.label('col');
    g.add(`color=c=${clip.fill || '#000000'}:s=${W}x${H}:r=${fps}:d=${f(dur)},format=yuv420p[${l}]`);
    return l;
  }
  const geo = clipGeometry(clip, media, W, H, 0);
  const bw = even(geo.w), bh = even(geo.h);
  const x0 = Math.round((geo.cx - bw / 2) / 2) * 2, y0 = Math.round((geo.cy - bh / 2) / 2) * 2;
  const cx0 = Math.max(0, -x0), cy0 = Math.max(0, -y0);
  const cw = Math.min(bw, W - x0) - cx0, ch = Math.min(bh, H - y0) - cy0;
  if (cw < 2 || ch < 2) return gapSegment(g, dur, { ...opts, opaque: true, background: bg }); // entirely off frame
  const chain = [];
  let src;
  if (clip.type === 'video') {
    const r = sourceRangeFor(clip, media, la, lb);
    const take = Math.max(1 / fps, r.b - r.a);
    const idx = g.input([...decodeInputArgs(opts, media), '-ss', f(r.a), '-t', f(take + margin * r.speed), '-i', media.path]);
    src = `[${idx}:v]`;
    chain.push('setpts=PTS-STARTPTS');
    if (r.speed !== 1) chain.push(`setpts=PTS/${f(r.speed)}`);
    chain.push(`fps=${fps}`);
    if (r.pre > 1e-4 || r.post > 1e-4) chain.push(`tpad=start_mode=clone:start_duration=${f(r.pre)}:stop_mode=clone:stop_duration=${f(r.post + margin)}`);
    chain.push(`trim=duration=${f(dur)}`, 'setpts=PTS-STARTPTS');
  } else {
    const idx = g.input(['-loop', '1', '-framerate', String(fps), '-t', f(dur + margin), '-i', media.path]);
    src = `[${idx}:v]`;
    chain.push(`fps=${fps}`, `trim=duration=${f(dur)}`, 'setpts=PTS-STARTPTS');
  }
  // limited-range YUV like the rest of the export (phone footage is often full-range yuvj420p)
  chain.push(`scale=${bw}:${bh}:flags=bicubic:out_range=tv`);
  if (clip.flipH) chain.push('hflip');
  if (clip.flipV) chain.push('vflip');
  if (cx0 || cy0 || cw < bw || ch < bh) chain.push(`crop=${cw}:${ch}:${cx0}:${cy0}`);
  if (cw < W || ch < H) chain.push(`pad=${W}:${H}:${Math.max(0, x0)}:${Math.max(0, y0)}:color=${bg}`);
  if (!isNeutralColor(clip.color)) chain.push(...ffColorChain(clip.color));
  chain.push('format=yuv420p');
  const l = g.label('s');
  g.add(`${src}${chain.join(',')}[${l}]`);
  return l;
}

// ----------------------------------------------------------------------------------------------
// Adjustment layers (shared/fx.js): the composite below is split, processed (grade / blur / pixelate), masked and
// laid back over itself while the layer is active. Mirrors PlayerEngine.renderAdjust (backdrop-filter + CSS mask).
// ----------------------------------------------------------------------------------------------
function adjustSegment(g, span, cur, w0, w1, opts) {
  const { width: W, height: H, fps } = opts;
  const c = span.clip;
  const q = (t) => Math.round((t - w0) * fps) / fps;
  const a = q(Math.max(c.start, w0)), b = q(Math.min(c.start + c.duration, w1));
  if (b - a < 0.5 / fps) return cur;
  const proc = [];
  if (!isNeutralColor(c.color)) proc.push(...ffColorChain(c.color));
  if (c.fx?.blur > 0) proc.push(`gblur=sigma=${f(c.fx.blur)}`);
  if (c.fx?.pixelate > 1) {
    const k = Math.round(c.fx.pixelate);
    // blocks aligned on the frame origin, one source pixel per block (like the preview's SVG filter)
    proc.push(`pad=w=ceil(iw/${k})*${k}:h=ceil(ih/${k})*${k}:x=0:y=0`, `scale=w=iw/${k}:h=ih/${k}:flags=neighbor`, `scale=w=iw*${k}:h=ih*${k}:flags=neighbor`, `crop=${W}:${H}:0:0`);
  }
  if (!proc.length || (c.opacity ?? 1) <= 0.001) return cur;
  const dur = r4(b - a);
  const m = g.label('am'), p = g.label('ap'), pl = g.label('ap');
  g.add(`[${cur}]split[${m}][${p}]`);
  g.add(`[${p}]trim=start=${f(a)}:end=${f(b)},format=rgba,${proc.join(',')},format=rgba[${pl}]`);
  let fx = pl;
  if (c.mask) {
    const mk = maskAt(c, 0, W, H);
    const ml = g.label('mk');
    const path = c.mask._path;
    if (!path?.length) {
      g.add(`color=c=black:s=${W}x${H}:r=${fps}:d=${f(1 / fps)},format=gray,geq=lum='${ffMaskLumExpr(mk)}',loop=loop=-1:size=1:start=0,trim=duration=${f(dur)},setpts=PTS+${f(a)}/TB[${ml}]`);
    } else {
      // moving mask: one large still mask, cropped every frame around the tracked position (crop x/y are per-frame)
      let mw = 0, mh = 0;
      for (const pt of path) { mw = Math.max(mw, pt.w ?? mk.w); mh = Math.max(mh, pt.h ?? mk.h); }
      const { Rx, Ry } = maskParams({ ...mk, w: mw, h: mh });
      const bw = Math.ceil(Rx * 2) + 4, bh = Math.ceil(Ry * 2) + 4;
      const CW = 2 * W + bw + (bw % 2), CH = 2 * H + bh + (bh % 2);
      const cxc = CW / 2, cyc = CH / 2;
      const local = `(t+${f(w0 - c.start)})`;
      const X = kfExpr(path.map((pt) => ({ t: pt.t, v: pt.x })), local, path[0].x);
      const Y = kfExpr(path.map((pt) => ({ t: pt.t, v: pt.y })), local, path[0].y);
      g.add(`color=c=black:s=${CW}x${CH}:r=${fps}:d=${f(1 / fps)},format=gray,geq=lum='${ffMaskLumExpr({ ...mk, cx: cxc, cy: cyc })}',loop=loop=-1:size=1:start=0,trim=duration=${f(dur)},setpts=PTS+${f(a)}/TB,` +
        `crop=w=${W}:h=${H}:x='clip(${f(cxc)}-(${X}),0,${CW - W})':y='clip(${f(cyc)}-(${Y}),0,${CH - H})'[${ml}]`);
    }
    const o = g.label('ap');
    g.add(`[${fx}][${ml}]alphamerge[${o}]`);
    fx = o;
  }
  const post = [];
  if ((c.opacity ?? 1) < 0.999) post.push(`colorchannelmixer=aa=${f(c.opacity)}`);
  if (c.videoFadeIn > 0) post.push(`fade=t=in:st=${f(Math.max(0, c.start - w0))}:d=${f(c.videoFadeIn)}:alpha=1`);
  if (c.videoFadeOut > 0) post.push(`fade=t=out:st=${f(Math.max(0, c.start + c.duration - c.videoFadeOut - w0))}:d=${f(c.videoFadeOut)}:alpha=1`);
  if (post.length) { const o = g.label('ap'); g.add(`[${fx}]${post.join(',')}[${o}]`); fx = o; }
  const out = g.label('lay');
  g.add(`[${m}][${fx}]overlay=0:0:eof_action=pass:format=auto[${out}]`);
  return out;
}

/** Expand a window so it never cuts a transition. */
export function expandWindow(project, w0, w1) {
  let a = w0, b = w1;
  for (const t of videoTracks(project)) {
    for (const s of trackSpans(project, t)) {
      for (const tr of [s.tin, s.tout]) {
        if (!tr) continue;
        if (tr.start < a && tr.end > a) a = tr.start;
        if (tr.start < b && tr.end > b) b = tr.end;
      }
    }
  }
  return [Math.max(0, a), b];
}

/**
 * Build the video graph for the window [w0, w1).
 * opts: { width, height, fps, htmlLayers: Map(clipId → {file, t0, still}), subtitles: {list, band} | null, outLabel }
 */
export function buildVideoGraph(project, w0, w1, opts) {
  const g = new Graph();
  const { width: W, height: H, fps } = opts;
  if (opts.bake !== false) project = bakeProject(project);
  const WD = r4(w1 - w0);
  const base = g.label('base');
  g.add(`color=c=${project.settings.background || '#000000'}:s=${W}x${H}:r=${fps}:d=${f(WD)},format=yuv420p[${base}]`);
  let cur = base;
  let bottom = true;
  for (const track of videoTracks(project)) {
    if (track.hidden) continue;
    const inWindow = trackSpans(project, track).filter((s) => s.end > w0 + EPS && s.start < w1 - EPS);
    const spans = inWindow.filter((s) => s.clip.type !== 'adjust');
    const adjusts = inWindow.filter((s) => s.clip.type === 'adjust');
    if (spans.length) cur = trackLayer(g, project, track, spans, cur, w0, w1, opts, bottom);
    if (spans.length) bottom = false;
    for (const s of adjusts) cur = adjustSegment(g, s, cur, w0, w1, opts);
  }
  return finishGraph(g, project, cur, w0, w1, opts);
}

/** One track of regular clips (concatenated segments + transitions) laid over `cur`. */
function trackLayer(g, project, track, spans, cur, w0, w1, opts, bottom) {
  const { width: W, height: H, fps } = opts;
  const WD = r4(w1 - w0);
  const frameDur = 1 / fps;
  const q = (t) => Math.round((t - w0) * fps) / fps + w0; // quantize to output frames
  {
    // bottom track made only of plain opaque shots: rendered in YUV and used as the base picture (fast path)
    const fast = bottom && opts.fastBase !== false && spans.every((s) => isSimpleSpan(project, s, W, H));
    const gopts = fast ? { ...opts, opaque: true, background: project.settings.background } : opts;
    const groups = []; // each: {label, dur}
    let cursor = w0;
    let last = null; // last group
    for (const s of spans) {
      const segA = q(Math.max(s.start, w0));
      const segB = q(Math.min(s.end, w1));
      if (segB - segA < frameDur / 2) continue;
      const overlap = r4(cursor - segA);
      if (overlap < frameDur / 2 && segA - cursor >= frameDur / 2) {
        const gl = gapSegment(g, r4(segA - cursor), gopts);
        groups.push({ label: gl, dur: r4(segA - cursor) });
        last = null;
      }
      let seg = fast ? simpleSegment(g, project, s, segA, segB, opts) : clipSegment(g, project, s, segA, segB, opts);
      const segDur = r4(segB - segA);
      // transition from transparent (no adjacent previous clip)
      if (s.tin && !s.tin.from && segA <= s.tin.start + frameDur / 2) {
        const d = r4(Math.min(s.tin.duration, segDur));
        const tz = gapSegment(g, d, gopts);
        const o = g.label('xf');
        g.add(`[${tz}][${seg}]xfade=transition=${s.tin.type}:duration=${f(d)}:offset=0[${o}]`);
        seg = o;
      }
      if (overlap >= frameDur / 2 && last && s.tin && s.tin.from) {
        // crossfade with the previous group (centered transition)
        const d = r4(overlap);
        const o = g.label('xf');
        const offset = r4(last.dur - d);
        g.add(`[${last.label}][${seg}]xfade=transition=${s.tin.type}:duration=${f(d)}:offset=${f(offset)}[${o}]`);
        last.label = o;
        last.dur = r4(last.dur + segDur - d);
      } else {
        last = { label: seg, dur: segDur };
        groups.push(last);
      }
      cursor = segB;
    }
    if (!groups.length) return cur;
    if (w1 - cursor >= frameDur / 2) groups.push({ label: gapSegment(g, r4(w1 - cursor), gopts), dur: r4(w1 - cursor) });
    let trackLabel;
    if (groups.length === 1) trackLabel = groups[0].label;
    else {
      trackLabel = g.label('trk');
      g.add(`${groups.map((x) => `[${x.label}]`).join('')}concat=n=${groups.length}:v=1:a=0[${trackLabel}]`);
    }
    const o = g.label('lay');
    if (fast) {
      g.add(`[${cur}]nullsink`); // the plain background is not needed under an opaque base track
      g.add(`[${trackLabel}]format=yuv420p,tpad=stop_mode=clone:stop_duration=${f(2 / fps)},trim=duration=${f(WD)},setpts=PTS-STARTPTS[${o}]`);
    }
    else g.add(`[${cur}][${trackLabel}]overlay=0:0:eof_action=pass[${o}]`);
    return o;
  }
}

function finishGraph(g, project, cur, w0, w1, opts) {
  const { width: W, height: H, fps } = opts;
  const WD = r4(w1 - w0);
  if (opts.subtitles) {
    const idx = g.input(['-f', 'concat', '-safe', '0', '-i', opts.subtitles.list]);
    const sl = g.label('sub');
    g.add(`[${idx}:v]setpts=PTS-STARTPTS,fps=${fps},format=rgba,tpad=stop_mode=clone:stop_duration=${f(2 / fps)},trim=duration=${f(WD)}[${sl}]`);
    const o = g.label('lay');
    g.add(`[${cur}][${sl}]overlay=0:${Math.round(opts.subtitles.band.y)}:eof_action=pass[${o}]`);
    cur = o;
  }

  const outLabel = opts.outLabel || 'vout';
  const ts = Math.max(0, opts.trim?.start ?? 0);
  const te = Math.min(WD, opts.trim?.end ?? WD);
  const post = [ts > 0 ? `trim=start=${f(ts)}:end=${f(te)}` : `trim=duration=${f(te)}`, 'setpts=PTS-STARTPTS'];
  if (opts.outWidth && opts.outHeight && (opts.outWidth !== W || opts.outHeight !== H)) {
    post.push(`scale=${opts.outWidth}:${opts.outHeight}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${opts.outWidth}:${opts.outHeight}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }
  post.push(`format=${opts.pixFmt || 'yuv420p'}`);
  g.add(`[${cur}]${post.join(',')}[${outLabel}]`);
  return { inputs: g.inputs, filter: g.text(), out: outLabel };
}

export function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${f(s)}`);
  return out;
}

/** Collect audible spans: clips on audio tracks + audio of video clips (with transition handles). */
export function audioSpans(project) {
  const anySolo = project.tracks.some((t) => t.solo);
  const out = [];
  for (const track of videoTracks(project)) {
    if (track.muted || (anySolo && !track.solo)) continue;
    for (const s of trackSpans(project, track)) {
      const clip = s.clip;
      if (clip.type !== 'video') continue;
      const media = mediaById(project, clip.mediaId);
      if (!isAudible(clip, media)) continue;
      out.push({ clip, media, track, start: s.start, end: s.end, xin: s.tin?.from ? s.tin.duration : 0, xout: s.tout ? s.tout.duration : 0 });
    }
  }
  for (const track of audioTracks(project)) {
    if (track.muted || (anySolo && !track.solo)) continue;
    for (const clip of project.clips.filter((c) => c.trackId === track.id)) {
      const media = mediaById(project, clip.mediaId);
      if (!isAudible(clip, media)) continue;
      out.push({ clip, media, track, start: clip.start, end: clipEnd(clip), xin: 0, xout: 0 });
    }
  }
  return out;
}

/**
 * Audio graph for [w0, w1). Returns { inputs, filter, out } producing 48 kHz stereo.
 *
 * Every clip is rendered to exactly its number of samples, then clips are laid end to end on a few "lanes" (clips of
 * a lane never overlap) separated by generated silence, so each lane is one continuous stream from 0 to the window
 * end; the lanes are mixed. Positions are counted in samples (no drift), and no filter relies on timestamps to place
 * audio: ffmpeg 8's adelay shifts timestamps instead of inserting silence, and amix then stopped at the end of the
 * first input that was not delayed — an export of a 20 min timeline came out 20 s long (the length of the music clip
 * at its start).
 */
export function buildAudioGraph(project, w0, w1, opts = {}) {
  const g = new Graph();
  const SR = 48000;
  const WD = r4(w1 - w0);
  const total = Math.round(WD * SR);
  const at = (t) => Math.max(0, Math.min(total, Math.round((t - w0) * SR))); // timeline seconds → sample index
  const FMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const silence = (n) => { const l = g.label('z'); g.add(`anullsrc=r=48000:cl=stereo,${FMT},atrim=end_sample=${n},asetpts=N/SR/TB[${l}]`); return l; };
  const items = [];
  for (const s of audioSpans(project)) {
    const a = Math.max(s.start, w0), b = Math.min(s.end, w1);
    if (b - a < 0.005) continue;
    const { clip, media, track } = s;
    const la = a - clip.start, lb = b - clip.start;
    const r = sourceRangeFor(clip, media, la, lb);
    if (r.b - r.a < 0.005) continue;
    const s0 = at(a), n = at(b) - s0;
    if (n < 16) continue;
    const idx = g.input(['-ss', f(r.a), '-t', f(r.b - r.a + 0.05), '-i', media.path]);
    let src = `[${idx}:a]`;
    const head = ['asetpts=PTS-STARTPTS', ...atempoChain(r.speed), 'aresample=48000', FMT];
    const preN = Math.min(n, Math.round(r.pre * SR));
    if (preN > 0) {
      // the clip starts before its media: silence first (sample-exact, see above)
      const x = g.label('a'), z = silence(preN), c = g.label('a');
      g.add(`${src}${head.join(',')}[${x}]`);
      g.add(`[${z}][${x}]concat=n=2:v=0:a=1[${c}]`);
      src = `[${c}]`;
      head.length = 0;
    }
    const chain = [...head, `apad=whole_len=${n}`, `atrim=end_sample=${n}`, 'asetpts=N/SR/TB'];
    const tv = `(t+${f(la)})`;
    const vol = (clip.keyframes?.volume?.length > 1)
      ? `volume='(${kfExpr(clip.keyframes.volume, tv, clip.volume ?? 1)})*${f(track.volume ?? 1)}':eval=frame`
      : `volume=${f((clip.keyframes?.volume?.[0]?.v ?? clip.volume ?? 1) * (track.volume ?? 1))}`;
    chain.push(vol);
    chain.push(...audioFxFilters(clip.audioFx));
    // clip fades (relative to the clip) + transition crossfades (relative to the span)
    if (clip.fadeIn > 0 && la < clip.fadeIn) chain.push(`afade=t=in:st=${f(Math.max(0, -la))}:d=${f(clip.fadeIn)}`);
    if (clip.fadeOut > 0 && lb > clip.duration - clip.fadeOut) chain.push(`afade=t=out:st=${f(Math.max(0, clip.duration - clip.fadeOut - la))}:d=${f(clip.fadeOut)}`);
    if (s.xin > 0 && a <= s.start + 0.001) chain.push(`afade=t=in:st=0:d=${f(s.xin)}:curve=qsin`);
    if (s.xout > 0 && b >= s.end - 0.001) chain.push(`afade=t=out:st=${f(Math.max(0, b - a - s.xout))}:d=${f(s.xout)}:curve=qsin`);
    // filters with latency (compressor, denoiser…) may change the length: back to exactly n samples
    chain.push(`apad=whole_len=${n}`, `atrim=end_sample=${n}`, 'asetpts=N/SR/TB');
    const l = g.label('a');
    g.add(`${src}${chain.join(',')}[${l}]`);
    items.push({ l, s0, s1: s0 + n });
  }
  // interval partitioning: each clip goes on the first lane that is free at its start
  items.sort((p, q) => p.s0 - q.s0);
  const lanes = [];
  for (const it of items) {
    let lane = lanes.find((x) => x.end <= it.s0);
    if (!lane) { lane = { end: 0, parts: [] }; lanes.push(lane); }
    if (it.s0 > lane.end) lane.parts.push(silence(it.s0 - lane.end));
    lane.parts.push(it.l);
    lane.end = it.s1;
  }
  const laneLabels = lanes.map((lane) => {
    if (lane.end < total) lane.parts.push(silence(total - lane.end));
    if (lane.parts.length === 1) return lane.parts[0];
    const l = g.label('lane');
    g.add(`${lane.parts.map((x) => `[${x}]`).join('')}concat=n=${lane.parts.length}:v=0:a=1[${l}]`);
    return l;
  });
  const outLabel = opts.outLabel || 'aout';
  const master = project.settings.masterVolume ?? 1;
  const tail = [];
  if (master !== 1) tail.push(`volume=${f(master)}`);
  if (opts.normalize || project.settings.normalizeLoudness) tail.push('loudnorm=I=-14:TP=-1.5:LRA=11');
  tail.push('alimiter=limit=0.98:level=0:latency=1', 'aresample=48000', FMT, `apad=whole_len=${total}`, `atrim=end_sample=${total}`);
  if (!laneLabels.length) {
    g.add(`anullsrc=r=48000:cl=stereo,${FMT},atrim=end_sample=${total}[${outLabel}]`);
  } else if (laneLabels.length === 1) {
    g.add(`[${laneLabels[0]}]${tail.join(',')}[${outLabel}]`);
  } else {
    g.add(`${laneLabels.map((l) => `[${l}]`).join('')}amix=inputs=${laneLabels.length}:normalize=0:dropout_transition=0:duration=longest,${tail.join(',')}[${outLabel}]`);
  }
  return { inputs: g.inputs, filter: g.text(), out: outLabel, count: items.length, lanes: laneLabels.length };
}

/** HTML clips intersecting a window, with the local time range they must be rendered for. */
export function htmlClipsInWindow(project, w0, w1) {
  const out = [];
  for (const track of videoTracks(project)) {
    if (track.hidden) continue;
    for (const s of trackSpans(project, track)) {
      if (s.clip.type !== 'html') continue;
      if (s.end <= w0 + EPS || s.start >= w1 - EPS) continue;
      const a = Math.max(s.start, w0) - s.clip.start;
      const b = Math.min(s.end, w1) - s.clip.start;
      out.push({ clip: s.clip, t0: a, t1: b });
    }
  }
  return out;
}

/** Count visual spans in a window (to decide chunking). */
export function visualSpanCount(project, w0, w1) {
  let n = 0;
  for (const track of videoTracks(project)) for (const s of trackSpans(project, track)) if (s.end > w0 && s.start < w1) n++;
  return n;
}

/** Choose chunk boundaries that never cut a transition or a fade. */
export function planChunks(project, w0, w1, maxSpans = 24) {
  const total = visualSpanCount(project, w0, w1);
  if (total <= maxSpans * 1.5) return [[w0, w1]];
  const forbidden = [];
  for (const track of videoTracks(project)) {
    for (const s of trackSpans(project, track)) {
      for (const tr of [s.tin, s.tout]) if (tr) forbidden.push([tr.start - 0.05, tr.end + 0.05]);
      const c = s.clip;
      if (c.videoFadeIn > 0) forbidden.push([c.start, c.start + c.videoFadeIn]);
      if (c.videoFadeOut > 0) forbidden.push([clipEnd(c) - c.videoFadeOut, clipEnd(c)]);
      if (c.keyframes || c.anim) forbidden.push([c.start, clipEnd(c)]);
    }
  }
  const okAt = (t) => !forbidden.some(([a, b]) => t > a && t < b);
  const starts = [];
  for (const track of videoTracks(project)) for (const s of trackSpans(project, track)) if (s.start > w0 + 0.5 && s.start < w1 - 0.5) starts.push(s.start);
  starts.sort((a, b) => a - b);
  const chunks = [];
  let a = w0;
  let count = 0;
  for (const t of starts) {
    count++;
    if (count >= maxSpans && okAt(t)) { chunks.push([a, t]); a = t; count = 0; }
  }
  chunks.push([a, w1]);
  return chunks;
}
