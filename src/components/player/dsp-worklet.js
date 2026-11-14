// AudioWorklet glue. This file is NOT imported as a module: its source is appended to the source of shared/dsp.js and
// loaded as one Blob module (see engine.js), so AfxChain below is the very class the export mixer uses.
/* global AfxChain, registerProcessor, sampleRate, AudioWorkletProcessor */

class AicutAfxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.chain = new AfxChain(o.list || [], sampleRate, { pan: o.pan || 0 });
    if (o.position) this.chain.setPosition(o.position * sampleRate);
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.list !== undefined || d.pan !== undefined) this.chain.update(d.list !== undefined ? d.list : this.chain.list, { pan: d.pan });
      if (d.position !== undefined) this.chain.setPosition(d.position * sampleRate);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    if (this.L.length < n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    const L = this.L.subarray(0, n), R = this.R.subarray(0, n);
    const inp = inputs[0];
    if (inp && inp.length) {
      L.set(inp[0]);
      R.set(inp[1] || inp[0]);
    } else { L.fill(0); R.fill(0); }
    this.chain.process(L, R, n);
    out[0].set(L);
    if (out[1]) out[1].set(R);
    return true;
  }
}

registerProcessor('aicut-afx', AicutAfxProcessor);
