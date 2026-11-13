// Playhead time lives outside React state (updated at 60 fps during playback).
const listeners = new Set();
let time = 0;
let playing = false;

export const playhead = {
  get time() { return time; },
  get playing() { return playing; },
  set(t, source = 'ui') {
    time = Math.max(0, t || 0);
    for (const l of listeners) l(time, source);
  },
  setPlaying(p) {
    playing = !!p;
    for (const l of listeners) l(time, 'state');
  },
  sub(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
