// Transitions: names map 1:1 to ffmpeg `xfade` transitions used at export time.
// The preview reproduces the exact xfade math with CSS (opacity / transforms / clip-path / masks).
// Convention: p = elapsed fraction (0 → 1); ffmpeg's `progress` = 1 - p. A = outgoing, B = incoming.

export const TRANSITIONS = [
  { id: 'fade', label: 'Cross dissolve', labelFr: 'Fondu enchaîné' },
  { id: 'fadeblack', label: 'Dip to black', labelFr: 'Fondu au noir' },
  { id: 'fadewhite', label: 'Dip to white', labelFr: 'Fondu au blanc' },
  { id: 'wipeleft', label: 'Wipe left', labelFr: 'Volet gauche' },
  { id: 'wiperight', label: 'Wipe right', labelFr: 'Volet droite' },
  { id: 'wipeup', label: 'Wipe up', labelFr: 'Volet haut' },
  { id: 'wipedown', label: 'Wipe down', labelFr: 'Volet bas' },
  { id: 'slideleft', label: 'Push left', labelFr: 'Glisser gauche' },
  { id: 'slideright', label: 'Push right', labelFr: 'Glisser droite' },
  { id: 'slideup', label: 'Push up', labelFr: 'Glisser haut' },
  { id: 'slidedown', label: 'Push down', labelFr: 'Glisser bas' },
  { id: 'smoothleft', label: 'Smooth wipe left', labelFr: 'Volet doux gauche' },
  { id: 'smoothright', label: 'Smooth wipe right', labelFr: 'Volet doux droite' },
  { id: 'smoothup', label: 'Smooth wipe up', labelFr: 'Volet doux haut' },
  { id: 'smoothdown', label: 'Smooth wipe down', labelFr: 'Volet doux bas' },
  { id: 'circleopen', label: 'Circle open', labelFr: 'Cercle ouvrant' },
  { id: 'circleclose', label: 'Circle close', labelFr: 'Cercle fermant' },
  { id: 'radial', label: 'Clock wipe', labelFr: 'Balayage radial' },
  { id: 'zoomin', label: 'Zoom in', labelFr: 'Zoom avant' },
];
export const TRANSITION_IDS = TRANSITIONS.map((t) => t.id);

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function stops(fn, n, unit = '%', range = 100) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = Math.min(1, Math.max(0, fn(u)));
    out.push(`rgba(0,0,0,${a.toFixed(4)}) ${(u * range).toFixed(3)}${unit}`);
  }
  return out.join(', ');
}

/**
 * CSS styles for the outgoing (a) and incoming (b) wrappers at elapsed fraction p.
 * W/H = project size (wrappers are full-canvas boxes). Returns { a, b, backdrop }.
 */
export function transitionStyles(type, p, W, H) {
  p = Math.min(1, Math.max(0, p));
  const q = 1 - p; // ffmpeg progress
  const a = {}, b = {};
  let backdrop = null;
  switch (type) {
    case 'fade':
      b.opacity = p;
      break;
    case 'fadeblack':
    case 'fadewhite': {
      const s1 = smoothstep(0.8, 1, q);
      const s2 = smoothstep(0.2, 1, q);
      const wA = q * s1;
      const wB = (1 - q) * (1 - s2);
      b.opacity = wB;
      a.opacity = wB < 1 ? wA / (1 - wB) : 0;
      backdrop = type === 'fadeblack' ? '#000' : '#fff';
      break;
    }
    case 'wipeleft': b.clipPath = `inset(0 0 0 ${(q * 100).toFixed(3)}%)`; break;
    case 'wiperight': b.clipPath = `inset(0 ${(q * 100).toFixed(3)}% 0 0)`; break;
    case 'wipeup': b.clipPath = `inset(${(q * 100).toFixed(3)}% 0 0 0)`; break;
    case 'wipedown': b.clipPath = `inset(0 0 ${(q * 100).toFixed(3)}% 0)`; break;
    case 'slideleft': a.translate = [-p * W, 0]; b.translate = [q * W, 0]; break;
    case 'slideright': a.translate = [p * W, 0]; b.translate = [-q * W, 0]; break;
    case 'slideup': a.translate = [0, -p * H]; b.translate = [0, q * H]; break;
    case 'slidedown': a.translate = [0, p * H]; b.translate = [0, -q * H]; break;
    case 'smoothleft':
      b.mask = `linear-gradient(to right, ${stops((u) => smoothstep(0, 1, 1 + u - 2 * q), 16)})`;
      break;
    case 'smoothright':
      b.mask = `linear-gradient(to left, ${stops((u) => smoothstep(0, 1, 1 + u - 2 * q), 16)})`;
      break;
    case 'smoothup':
      b.mask = `linear-gradient(to bottom, ${stops((u) => smoothstep(0, 1, 1 + u - 2 * q), 16)})`;
      break;
    case 'smoothdown':
      b.mask = `linear-gradient(to top, ${stops((u) => smoothstep(0, 1, 1 + u - 2 * q), 16)})`;
      break;
    case 'circleopen': {
      const P = (q - 0.5) * 3;
      b.mask = `radial-gradient(circle farthest-corner at 50% 50%, ${stops((u) => 1 - smoothstep(0, 1, u + P), 20)})`;
      break;
    }
    case 'circleclose': {
      const P = (p - 0.5) * 3;
      b.mask = `radial-gradient(circle farthest-corner at 50% 50%, ${stops((u) => smoothstep(0, 1, u + P), 20)})`;
      break;
    }
    case 'radial': {
      const T = (q - 0.5) * 2.5 * Math.PI;
      // phi = atan2(dx, dy) = PI - theta_css ; B weight = smoothstep(0, 1, phi - T)
      b.mask = `conic-gradient(from 0deg at 50% 50%, ${stops((u) => {
        const theta = u * 2 * Math.PI;
        let phi = Math.PI - theta;
        if (phi <= -Math.PI) phi += 2 * Math.PI;
        return smoothstep(0, 1, phi - T);
      }, 120, 'deg', 360)})`;
      break;
    }
    case 'zoomin': {
      const zf = smoothstep(0.5, 1, q);
      a.scale = 1 / Math.max(zf, 0.04);
      b.opacity = 1 - smoothstep(0, 0.5, q);
      break;
    }
    default:
      b.opacity = p;
  }
  return { a, b, backdrop };
}
