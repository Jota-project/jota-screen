// La respuesta del Gateway en el móvil: frames binarios 0xA1 + turn_seq (uint16 BE) + PCM16 LE 24 kHz mono. Cada trozo se
// programa justo detrás del anterior en el AudioContext del mando (el de la voz), sin huecos. Solo vale el turno del
// primer frame de la respuesta: los de otro `seq` se descartan hasta el siguiente `stop`.
const RATE = 24000;
const LEAD = 0.05;                                      // margen al arrancar o tras un hueco (s)

/** PCM16 LE → Float32 en [-1, 1). @param {ArrayBuffer} buf @param {number} [from] byte donde empieza el PCM */
export function pcm16ToFloat32(buf, from = 0) {
  const n = (buf.byteLength - from) >> 1, v = new DataView(buf, from, n * 2), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 32768;
  return out;
}

/** @param {() => AudioContext | null} getCtx el contexto del mando (lo crea si aún no hay: p. ej. un texto sin haber usado el micrófono) */
export function createPcmPlayer(getCtx) {
  /** @type {number | null} */ let seq = null;
  let at = 0;                                           // cuándo acaba lo ya programado
  /** @type {Set<AudioBufferSourceNode>} */ const live = new Set();
  return {
    /** @param {ArrayBuffer} frame */
    play(frame) {
      if (!(frame instanceof ArrayBuffer) || frame.byteLength < 5 || new Uint8Array(frame)[0] !== 0xA1) return;
      const s = new DataView(frame).getUint16(1);
      if (seq === null) seq = s; else if (s !== seq) return;   // de otro turno
      const ctx = getCtx(); if (!ctx) return;
      const pcm = pcm16ToFloat32(frame, 3); if (!pcm.length) return;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      const b = ctx.createBuffer(1, pcm.length, RATE); b.copyToChannel(pcm, 0);
      const n = ctx.createBufferSource(); n.buffer = b; n.connect(ctx.destination);
      at = Math.max(at, ctx.currentTime + LEAD);
      n.start(at); at += b.duration;
      live.add(n); n.onended = () => live.delete(n);
    },
    /** Corta lo que suena y olvida el turno (una pulsación nueva, un `ask` nuevo, un error). */
    stop() {
      for (const n of live) { n.onended = null; try { n.stop(); } catch {} try { n.disconnect(); } catch {} }
      live.clear(); seq = null; at = 0;
    },
  };
}
