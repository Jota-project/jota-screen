'use strict';
// @ts-check
// Reloj de la voz de Jota: qué carácter de la respuesta se está diciendo en cada ms de audio. El Gateway manda el texto y
// el PCM sin tiempos por palabra, así que se escuchan las pausas del audio y se emparejan con la puntuación del texto.
// Puro (sin E/S): `text(t)` con la respuesta acumulada, `pcm(buf)` con cada trozo de PCM16 LE 24 kHz mono del turno.
// - Ventanas de 20 ms: silencio si su RMS < max(SILENCE_FLOOR, SILENCE_REL × mediana del RMS de voz visto hasta ahora).
// - Arranque: la primera ventana de voz, ancla [t, 0]. Pausa: ≥ PAUSE_MS de silencio seguido, con voz detrás.
// - Cada pausa [ps, pe] va al hueco de puntuación más cercano a lo esperado (c_última + (ps − t_última) / rate), dentro de
//   la tolerancia; si no hay, es una respiración y se ignora. Si la puntuación aún no ha llegado, espera al texto.
//   Emparejada con el hueco c: anclas [ps, c] y [pe, inicio de la palabra siguiente].
// - `rate()`: ms por carácter medidos entre anclas de voz (con dos pausas emparejadas como mínimo); si no, el de partida.
// - `charAt(anclas, rate, t, largo)`: interpolación lineal entre anclas (los clientes llevan una copia: tv-agent.js y
//   mando/features/agent.js).

const SAMPLES_PER_MS = 24;                                 // PCM del Gateway a 24 kHz
const WIN_MS = 20;                                         // ventana de análisis
const WIN = WIN_MS * SAMPLES_PER_MS;                       // 480 muestras
const SILENCE_FLOOR = 0.012;                               // RMS normalizado por debajo del que siempre es silencio
const SILENCE_REL = 0.15;                                  // …o por debajo de esta parte de la mediana de la voz
const PAUSE_MS = 180;                                      // silencio seguido que cuenta como pausa (menos: respiración)
const DEFAULT_MS_PER_CHAR = 62;                            // provisional, se calibra en la tele
const RATE_MIN = 35, RATE_MAX = 120;                       // ms por carácter medidos: se recortan a esto
const TOL_MIN = 12, TOL_REL = 0.35;                        // tolerancia del emparejamiento, en caracteres
const PUNCT = /[.,;:!?…\n]/;                               // huecos donde la voz suele parar

/**
 * Carácter dicho en el ms de audio `t`: interpolado entre anclas y, tras la última, a `rate` ms por carácter.
 * @param {[number, number][]} anchors @param {number} rate @param {number} t @param {number} len @returns {number}
 */
function charAt(anchors, rate, t, len) {
  if (!anchors.length || t < anchors[0][0]) return 0;
  let i = anchors.length - 1;
  while (i > 0 && anchors[i][0] > t) i--;
  const [t1, c1] = anchors[i], next = anchors[i + 1];
  const c = next ? (next[0] > t1 ? c1 + (next[1] - c1) * (t - t1) / (next[0] - t1) : next[1]) : c1 + (t - t1) / rate;
  return Math.max(0, Math.min(len, c));
}

/** @param {{ rateMsPerChar?: number }} [o] */
function createVoiceSync({ rateMsPerChar = DEFAULT_MS_PER_CHAR } = {}) {
  let text = '';
  let samples = 0;                                         // muestras recibidas
  /** @type {number | null} */ let odd = null;           // byte suelto de un trozo impar (la muestra sigue en el siguiente)
  let sumSq = 0, inWin = 0, wins = 0;                      // ventana en curso y ventanas ya cerradas
  /** @type {number[]} */ const voiceRms = [];             // RMS de las ventanas de voz (para la mediana)
  let started = false;
  /** @type {number | null} */ let quietFrom = null;      // ms donde empezó el silencio en curso
  /** @type {[number, number][]} */ const anchors = [];
  /** @type {[number, number][]} */ const pending = [];    // pausas [ps, pe] esperando a su puntuación
  let said = 0;                                            // máximo carácter dado por at()

  function median() {
    if (!voiceRms.length) return 0;
    const s = [...voiceRms].sort((a, b) => a - b);
    return s[s.length >> 1];
  }
  function rate() {
    let sum = 0, n = 0;
    // anclas de voz: [arranque o fin de pausa] → [inicio de la pausa siguiente], es decir, (0,1), (2,3)…
    for (let i = 0; i + 1 < anchors.length; i += 2) {
      const dc = anchors[i + 1][1] - anchors[i][1];
      if (dc > 0) { sum += (anchors[i + 1][0] - anchors[i][0]) / dc; n++; }
    }
    return n >= 2 ? Math.max(RATE_MIN, Math.min(RATE_MAX, sum / n)) : rateMsPerChar;
  }
  /** Empareja la pausa con un hueco de puntuación. @param {number} ps @param {number} pe @returns {'ok' | 'skip' | 'wait'} */
  function match(ps, pe) {
    const [tl, cl] = anchors[anchors.length - 1];
    const exp = cl + (ps - tl) / rate(), tol = Math.max(TOL_MIN, TOL_REL * (exp - cl));
    let best = -1;
    for (let i = cl; i < text.length && i < exp + tol; i++) {
      if (!PUNCT.test(text[i])) continue;
      const c = i + 1;
      if (c > cl && (best < 0 || Math.abs(c - exp) < Math.abs(best - exp))) best = c;
    }
    if (best >= 0 && Math.abs(best - exp) <= tol) {
      let w = best;
      while (w < text.length && /\s/.test(text[w])) w++;   // la palabra siguiente (o el final de lo que hay)
      anchors.push([ps, best], [pe, w]);
      return 'ok';
    }
    return text.length < exp + tol ? 'wait' : 'skip';      // la puntuación puede estar aún por llegar
  }
  function settle() {
    while (pending.length) {
      if (match(pending[0][0], pending[0][1]) === 'wait') return;
      pending.shift();
    }
  }
  /** Una ventana cerrada. @param {number} rms */
  function closeWin(rms) {
    const at = wins * WIN_MS;
    wins++;
    const quiet = rms < Math.max(SILENCE_FLOOR, SILENCE_REL * median());
    if (quiet) { if (started && quietFrom === null) quietFrom = at; return; }
    voiceRms.push(rms);
    if (!started) { started = true; anchors.push([at, 0]); return; }
    if (quietFrom !== null && at - quietFrom >= PAUSE_MS) { pending.push([quietFrom, at]); settle(); }
    quietFrom = null;
  }
  /** @param {number} s muestra Int16 */
  function sample(s) {
    const x = s / 32768;
    sumSq += x * x;
    if (++inWin === WIN) { closeWin(Math.sqrt(sumSq / WIN)); sumSq = 0; inWin = 0; }
  }

  return {
    /** @param {string} t la respuesta acumulada */
    text(t) { text = String(t || ''); settle(); },
    /** @param {Buffer} buf PCM16 LE (puede venir a mitad de un frame, sin alinear) */
    pcm(buf) {
      let i = 0;
      if (odd !== null && buf.length) { sample((buf[0] << 24 >> 16) | odd); samples++; odd = null; i = 1; }
      for (; i + 1 < buf.length; i += 2) { sample(buf.readInt16LE(i)); samples++; }
      if (i < buf.length) odd = buf[i];
    },
    /** @returns {[number, number][]} copia de las anclas [ms de audio, carácter] */
    anchors: () => anchors.map(a => /** @type {[number, number]} */ ([a[0], a[1]])),
    rate,
    /** ms de audio recibidos */
    receivedMs: () => samples / SAMPLES_PER_MS,
    /** largo del texto al que se refieren las anclas */
    textLength: () => text.length,
    /** Carácter dicho en el ms `t`: nunca retrocede. @param {number} t */
    at(t) { said = Math.max(said, charAt(anchors, rate(), t, text.length)); return said; },
  };
}

module.exports = { createVoiceSync, charAt, DEFAULT_MS_PER_CHAR, PAUSE_MS, SAMPLES_PER_MS };
