/**
 * RNNoise AudioWorkletProcessor
 * Processa áudio em frames de 480 amostras (10ms a 48kHz)
 * usando a biblioteca RNNoise compilada para WASM.
 *
 * RNNoise: https://github.com/xiph/rnnoise
 * Baseado no trabalho do Jitsi Meet (Apache 2.0)
 */

/* global sampleRate */

const RNNOISE_FRAME_SIZE = 480; // RNNoise exige frames de 480 amostras

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer    = new Float32Array(RNNOISE_FRAME_SIZE);
    this._bufferPos = 0;
    this._rnnoiseState = null;
    this._module = null;
    this._enabled = true;

    // Receber instância do módulo WASM e estado da thread principal
    this.port.onmessage = (e) => {
      if (e.data.type === 'init') {
        this._module = e.data.module;
        this._rnnoiseState = this._module._rnnoise_create(0);
        this._heapInput  = this._allocHeap(RNNOISE_FRAME_SIZE);
        this._heapOutput = this._allocHeap(RNNOISE_FRAME_SIZE);
      } else if (e.data.type === 'enable') {
        this._enabled = e.data.value;
      } else if (e.data.type === 'destroy') {
        if (this._rnnoiseState && this._module) {
          this._module._rnnoise_destroy(this._rnnoiseState);
          this._rnnoiseState = null;
        }
      }
    };
  }

  _allocHeap(size) {
    const ptr = this._module._malloc(size * 4); // Float32 = 4 bytes
    return { ptr, arr: new Float32Array(this._module.HEAPF32.buffer, ptr, size) };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const inputChannel  = input[0];
    const outputChannel = inputChannel; // pass-through se RNNoise não disponível

    if (!this._enabled || !this._rnnoiseState || !this._module) {
      // Sem processamento — pass-through direto
      this.port.postMessage({ type: 'audio', data: outputChannel }, [outputChannel.buffer.slice(0).buffer]);
      return true;
    }

    // Acumular amostras no buffer
    let inputOffset = 0;
    while (inputOffset < inputChannel.length) {
      const toCopy = Math.min(
        RNNOISE_FRAME_SIZE - this._bufferPos,
        inputChannel.length - inputOffset
      );
      this._buffer.set(inputChannel.subarray(inputOffset, inputOffset + toCopy), this._bufferPos);
      this._bufferPos += toCopy;
      inputOffset     += toCopy;

      if (this._bufferPos === RNNOISE_FRAME_SIZE) {
        this._processFrame();
        this._bufferPos = 0;
      }
    }

    return true;
  }

  _processFrame() {
    // RNNoise espera amostras em [-32768, 32767] (16-bit PCM range)
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      this._heapInput.arr[i] = this._buffer[i] * 32768;
    }

    this._module._rnnoise_process_frame(
      this._rnnoiseState,
      this._heapOutput.ptr,
      this._heapInput.ptr
    );

    // Converter de volta para [-1, 1]
    const out = new Float32Array(RNNOISE_FRAME_SIZE);
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      out[i] = this._heapOutput.arr[i] / 32768;
    }

    this.port.postMessage({ type: 'audio', data: out }, [out.buffer]);
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
