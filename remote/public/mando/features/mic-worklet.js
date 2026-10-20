// @ts-nocheck — se ejecuta en el AudioWorkletGlobalScope (registerProcessor, sampleRate), que el lib DOM de tsc no trae
/* global registerProcessor, AudioWorkletProcessor, sampleRate */
// Micrófono del mando (voice.js): recibe el audio a la frecuencia del AudioContext (iOS no garantiza 16 kHz), lo pasa a
// 16 kHz mono con interpolación lineal y manda al hilo principal trozos de 100 ms (Float32Array de 1600 muestras).
// La salida queda en silencio: el nodo va al destino solo para que el navegador lo procese.
const RATE = 16000, CHUNK = 1600;

class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / RATE;                     // muestras de entrada por cada muestra de salida
    this.pos = 0;                                      // posición (fraccionaria) de la siguiente salida en el bloque actual
    this.last = 0;                                     // última muestra del bloque anterior (para interpolar en la junta)
    this.buf = new Float32Array(CHUNK); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    // la entrada «virtual» es [last, ...ch]: el índice i del bloque es i + 1 en ella
    let p = this.pos;
    while (p < ch.length) {
      const i = Math.floor(p), f = p - i;
      const a = i === 0 ? this.last : ch[i - 1], b = ch[i];
      this.buf[this.n++] = a + (b - a) * f;
      if (this.n === CHUNK) { const out = this.buf; this.port.postMessage(out, [out.buffer]); this.buf = new Float32Array(CHUNK); this.n = 0; }
      p += this.step;
    }
    this.pos = p - ch.length;
    this.last = ch[ch.length - 1];
    return true;
  }
}

registerProcessor('pcm16k', Pcm16k);
