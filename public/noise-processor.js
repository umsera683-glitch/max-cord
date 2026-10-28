/**
 * AudioWorklet: Supressão de ruídos aprimorada
 * - High-pass filter (remove ronco/baixo contínuo)
 * - Noise gate adaptativo com envelope suave
 * - Estimativa de piso de ruído (EMA)
 * Gratuito, 100% no cliente.
 */
class NoiseSuppressionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._enabled = true;
    this._hpX1 = 0; this._hpY1 = 0;
    const fc = 100;
    const sr = sampleRate || 48000;
    this._hpA = Math.exp((-2 * Math.PI * fc) / sr);
    this._gateOpen = 0;
    this._openThresh = 0.014;
    this._closeThresh = 0.008;
    this._attack = 0.35;
    this._release = 0.06;
    this._noiseFloor = 0.02;
    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.type === 'enable') this._enabled = !!e.data.value;
      if (e.data.type === 'threshold' && typeof e.data.value === 'number') {
        this._openThresh = Math.max(0.002, Math.min(0.1, e.data.value));
        this._closeThresh = this._openThresh * 0.55;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inCh = input[0];
    const outCh = output[0];
    const n = outCh.length;
    if (!this._enabled) {
      outCh.set(inCh);
      for (let c = 1; c < output.length; c++) {
        if (output[c]) output[c].set(input[c] || inCh);
      }
      return true;
    }
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = inCh[i];
      const y = this._hpA * (this._hpY1 + x - this._hpX1);
      this._hpX1 = x;
      this._hpY1 = y;
      const abs = y >= 0 ? y : -y;
      sumSq += y * y;
      if (this._gateOpen < 0.25) {
        this._noiseFloor = this._noiseFloor * 0.995 + abs * 0.005;
      }
      const openT = Math.max(this._openThresh, this._noiseFloor * 3.2);
      const closeT = Math.max(this._closeThresh, this._noiseFloor * 1.8);
      const level = Math.sqrt(sumSq / (i + 1));
      const target = level > (this._gateOpen > 0.5 ? closeT : openT) ? 1 : 0;
      const coeff = target > this._gateOpen ? this._attack : this._release;
      this._gateOpen += (target - this._gateOpen) * coeff;
      let g = this._gateOpen;
      if (g < 0.15) g *= g / 0.15;
      let s = y * g * 1.12;
      if (s > 0.95) s = 0.95 + (s - 0.95) * 0.15;
      if (s < -0.95) s = -0.95 + (s + 0.95) * 0.15;
      outCh[i] = s;
    }
    for (let c = 1; c < output.length; c++) {
      if (output[c]) output[c].set(outCh);
    }
    return true;
  }
}
registerProcessor('noise-suppression-processor', NoiseSuppressionProcessor);
