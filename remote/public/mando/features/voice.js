// Voz (v4): mantener el orbe de «Hablar con Jota» para hablar. El micrófono del móvil sube en directo al servidor como
// PCM (Float32 LE, 16 kHz, mono, trozos de 100 ms) por el WebSocket del mando: `vstart`, audio binario y `vend`. La vista
// del agente enseña la frase mientras se dice (`talk` partial) y la respuesta. La respuesta suena en UN solo sitio: la
// tele (por defecto), este móvil o ninguno (solo texto). No es un módulo del mando: la hoja `agS` es de agent.js, que
// llama aquí con sus funciones de pintar (una hoja solo puede tener un dueño, ver ui/sheets.js).
// El micrófono solo existe en una página segura (HTTPS, p. ej. la URL de Tailscale): en http://mando.local el orbe
// sigue como antes y enfoca el campo para dictar con el teclado del móvil.
import { $ } from '../core/dom.js';
import { cmd, rpc, sendBin } from '../core/api.js';
import { cfg, saveCfg } from '../core/store.js';
import { buzz } from '../ui/haptics.js';

const OUTS = ['tv', 'phone', 'none'];
const OUT_LABEL = { tv: 'Responde en la tele', phone: 'Responde en el móvil', none: 'Responde solo con texto' };
const MAX_MS = 30000;                                   // tope de una grabación (el servidor corta a los 32 s)
const TAP_MS = 300;                                     // soltar antes de esto es un toque: abre el teclado, no manda nada
const FLUSH_MS = 200;                                   // al soltar, lo más que se espera el último trozo del worklet
const NOT_READY = 'No he podido preparar el micrófono. Prueba otra vez.';

/** @type {AudioContext | null} */
let ctx = null;                                         // uno para toda la página: se crea en el gesto y no se cierra
/** @type {Promise<void> | null} */
let mod = null;                                         // el worklet se carga una vez por contexto
/** @type {MediaStream | null} */
let stream = null;
/** @type {MediaStreamAudioSourceNode | null} */
let src = null;
/** @type {AudioWorkletNode | null} */
let node = null;
let held = false;                                       // el dedo (o la tecla) sigue sobre el orbe
let long = false;                                       // la pulsación ya pasa de TAP_MS (o es de teclado)
let started = false;                                    // vstart enviado: el audio va al servidor
let press = 0;                                          // número de la pulsación (lo que llega tarde de otra se ignora)
let tapT = 0, stopT = 0, flushT = 0;
/** @type {Float32Array[]} */
let pending = [];                                       // los primeros trozos, en memoria hasta saber que no es un toque
/** @type {{ stage: (st: string) => void, said: (t: string) => void, rep: (t: string, cls?: string) => void, focus: () => void, press?: () => void }} */
let ui;

export const canRecord = () => !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
  window.AudioContext && window.AudioWorkletNode);
/** El AudioContext del mando (null hasta la primera pulsación); la voz de vuelta en el móvil usa el mismo. */
export const audioCtx = () => ctx;
/** Lo mismo, pero lo crea si aún no hay (un texto escrito sin haber usado el micrófono). Llamar dentro de un gesto. */
export function ensureAudioCtx() {
  try { if (!ctx) ctx = new AudioContext(); if (ctx.state !== 'running') ctx.resume().catch(() => {}); } catch {}
  return ctx;
}
const out = () => (OUTS.includes(cfg.voiceOut) ? cfg.voiceOut : 'tv');
/** Ajuste «Al pulsar el orbe mientras Jota habla»: interrumpir (por defecto) o esperar. */
export const interruptOn = () => cfg.voiceInterrupt !== false;
/** El selector «dónde suena la respuesta» (voz y texto escrito). */
export const outSel = out;
function paintOut() { const b = $('#agOut'); b.textContent = OUT_LABEL[out()]; b.dataset.out = out(); }

/** Suelta el micrófono y los nodos (el contexto se queda). */
function release() {
  clearTimeout(tapT); clearTimeout(stopT); clearTimeout(flushT);
  if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
  if (src) { src.disconnect(); src = null; }
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; pending = [];
}

/** Un trozo de 100 ms del worklet: en memoria mientras puede ser un toque; luego, al servidor. @param {Float32Array} pcm */
function chunk(pcm) {
  if (started) sendBin(pcm); else pending.push(pcm);
}

/** La pulsación pasa a ser de voz: vstart, lo guardado y desde aquí en directo. */
function go() {
  if (started || !held || !long || !node) return;
  started = true;
  const me = press;
  // el servidor abre el turno al leer vstart, antes que el audio que va detrás por el mismo socket
  rpc({ t: 'vstart', out: out(), interrupt: interruptOn() }).then(r => {
    if (!r || !r.error || r.error === 'sin respuesta' || me !== press) return;
    if (started) { started = false; held = false; release(); }   // ocupado, sin permiso o Jota caído: no se sigue grabando
    ui.rep(r.error); ui.stage('idle');                  // (también si ya se soltó: no se queda en «Pensando»)
  });
  for (const p of pending) sendBin(p);
  pending = [];
}

/** @param {boolean} [key] con teclado no hay toque corto: soltar siempre envía */
async function start(key = false) {
  if (held || node || stream) return;                   // ya hay una pulsación en curso (o se está pidiendo el micro)
  held = true; long = key; started = false; pending = [];
  if (ui.press) ui.press();                             // una pulsación nueva corta la respuesta que aún suene en el móvil (si interrumpe)
  const me = ++press;
  // iOS: el contexto se crea (o se reanuda) dentro del propio gesto, antes de cualquier await
  if (!ensureAudioCtx()) {
    ui.rep('Este navegador no puede usar el micrófono.'); held = false; return;
  }
  if (!key) tapT = setTimeout(() => { long = true; go(); }, TAP_MS);
  if (!mod) mod = ctx.audioWorklet.addModule('/mando/features/mic-worklet.js').catch(e => { mod = null; throw e; });
  // las dos a la vez, y si una falla el micrófono que sí se abrió se cierra (si no, se queda encendido)
  const [g, w] = await Promise.allSettled([navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }), mod]);
  const s = g.status === 'fulfilled' ? g.value : null;
  if (!s || w.status === 'rejected') {
    if (s) s.getTracks().forEach(t => t.stop());
    if (me === press) { clearTimeout(tapT); held = false; ui.rep(s ? NOT_READY : 'No tengo permiso para usar el micrófono.'); ui.stage('idle'); }
    return;
  }
  if (me !== press || !held) {                          // se soltó (o se cerró la hoja) mientras se pedía el micrófono
    s.getTracks().forEach(t => t.stop());
    if (me === press && long) { ui.rep('Listo. Mantén el orbe otra vez para hablar.'); ui.stage('idle'); }
    return;
  }
  stream = s;
  try {
    src = ctx.createMediaStreamSource(s);
    node = new AudioWorkletNode(ctx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = e => { if (me === press && e.data instanceof Float32Array) chunk(e.data); };
    src.connect(node); node.connect(ctx.destination);  // la salida es silencio; sin destino Safari no lo procesa
  } catch {
    release(); held = false; ui.rep(NOT_READY); ui.stage('idle'); return;
  }
  buzz(10); ui.rep(''); ui.stage('rec');
  stopT = setTimeout(stop, MAX_MS);
  go();                                                 // si el permiso tardó más que un toque, ya es voz
}

/** Soltar: un toque corto se descarta sin mandar nada y abre el teclado (lo de siempre); si no, vend. */
function stop() {
  if (!held) return;
  held = false;
  const tap = !long, sent = started;
  if (tap || !sent || !node) { release(); started = false; }
  if (tap) { ui.stage('idle'); ui.focus(); return; }
  if (!sent) return;                                    // aún sin micrófono: start() avisa al volver
  buzz(6); ui.rep('Pensando', 'wait'); ui.stage('wait');
  if (node) finish(); else sendEnd();
}

/** vend por rpc: si el servidor ya no tiene grabación (el turno murió), se vuelve a reposo sin pisar el texto que haya. */
function sendEnd() {
  const me = press;
  rpc({ t: 'vend' }).then(r => { if (r && r.error && r.error !== 'sin respuesta' && me === press) ui.stage('idle'); });
}

/** Fin de la frase: el micro se apaga ya, el worklet manda lo que le queda (y lo que estuviera en camino) y luego vend. */
function finish() {
  const n = node, me = press;
  clearTimeout(tapT); clearTimeout(stopT);
  if (stream) stream.getTracks().forEach(t => t.stop());
  const end = () => {
    if (me === press && started) { started = false; sendEnd(); }
    if (node === n) release();                          // si entre tanto se cerró la hoja o falló vstart, ya está suelto
  };
  n.port.onmessage = e => {
    const d = e.data;
    if (d instanceof Float32Array) { if (me === press) chunk(d); return; }
    if (d && d.done) { if (d.pcm instanceof Float32Array && me === press) chunk(d.pcm); end(); }
  };
  n.port.postMessage('flush');
  flushT = setTimeout(end, FLUSH_MS);
}

export const voice = {
  /** La hoja se cierra: si se estaba grabando, se descarta (y el servidor también). */
  close() {
    if (!held && !started) return;
    const sent = started;
    held = false; started = false; press++; release();
    if (sent) cmd({ t: 'vcancel' });
    ui.stage('idle');
  },
  /** El servidor ya cerró el turno (error): se suelta el micrófono sin avisar de vuelta (ni vcancel ni vend). */
  abort() {
    if (!held && !started && !node && !stream) return;
    held = false; started = false; press++; release();
  },
  /** @param {typeof ui} hooks @returns {boolean} true si hay micrófono (el orbe graba) */
  init(hooks) {
    ui = hooks;
    if (!canRecord()) return false;
    const b = $('#agOrb'), o = $('#agOut');
    b.setAttribute('aria-label', 'Mantén para hablar con Jota; toca para escribir');
    $('#agH').textContent = 'Mantén el orbe para hablar · toca para escribir';
    o.hidden = false; paintOut();
    b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); start(); });
    for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, stop);
    b.addEventListener('contextmenu', e => e.preventDefault());
    // teclado: espacio o Intro mantenidos
    b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(true); } });
    b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); } });
    // un solo destino, y se recuerda en este móvil
    o.addEventListener('click', () => { cfg.voiceOut = OUTS[(OUTS.indexOf(out()) + 1) % OUTS.length]; saveCfg(); paintOut(); buzz(8); });
    return true;
  },
};
