// Voz (v3): mantener el orbe de «Hablar con Jota» para hablar. Graba con el micrófono del móvil, sube el audio a
// /api/voice y la vista del agente enseña lo entendido y la respuesta. La respuesta suena en UN solo sitio: la tele
// (por defecto), este móvil o ninguno (solo texto). No es un módulo del mando: la hoja `agS` es de agent.js, que llama
// aquí con sus funciones de pintar (una hoja solo puede tener un dueño, ver ui/sheets.js).
// El micrófono solo existe en una página segura (HTTPS, p. ej. la URL de Tailscale): en http://mando.local el orbe
// sigue como antes y enfoca el campo para dictar con el teclado del móvil.
import { $ } from '../core/dom.js';
import { cfg, saveCfg, state } from '../core/store.js';
import { buzz } from '../ui/haptics.js';

const OUTS = ['tv', 'phone', 'none'];
const OUT_LABEL = { tv: 'Responde en la tele', phone: 'Responde en el móvil', none: 'Responde solo con texto' };
const MAX_MS = 30000;                                   // el servidor admite ~4 MB; 30 s de voz van de sobra
const TAP_MS = 300;                                     // soltar antes de esto es un toque: abre el teclado, no graba

let rec = null, chunks = [], stream = null, stopT = 0, downAt = 0, busy = false, player = null, cancelled = false;
/** @type {{ stage: (st: string) => void, said: (t: string) => void, rep: (t: string, cls?: string) => void, focus: () => void }} */
let ui;

export const canRecord = () => !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
const out = () => (OUTS.includes(cfg.voiceOut) ? cfg.voiceOut : 'tv');
function paintOut() { const b = $('#agOut'); b.textContent = OUT_LABEL[out()]; b.dataset.out = out(); }

/** El tipo de audio que graba este navegador (Safari: mp4; Chrome y Firefox: webm u ogg). */
function pickType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}
function release() { clearTimeout(stopT); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; }

async function start() {
  if (busy || rec) return;
  if (player) { player.pause(); player = null; }        // si aún suena la respuesta anterior, se calla
  cancelled = false; downAt = Date.now();
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { ui.rep('No tengo permiso para usar el micrófono.'); ui.stage('idle'); return; }
  if (cancelled) { release(); return; }                  // se soltó (toque) mientras se pedía el permiso
  const type = pickType();
  chunks = [];
  rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const t = rec.mimeType || type || 'audio/webm'; rec = null; release();
    if (cancelled) { ui.stage('idle'); return; }
    send(new Blob(chunks, { type: t }));
  };
  rec.start();
  buzz(10); ui.rep(''); ui.stage('rec');
  stopT = setTimeout(stop, MAX_MS);
}

/** Soltar: si fue un toque corto, se descarta y se abre el teclado (lo de siempre); si no, se envía. */
function stop() {
  const tap = Date.now() - downAt < TAP_MS;
  if (tap) cancelled = true;
  if (rec && rec.state === 'recording') { if (!tap) buzz(6); rec.stop(); }
  if (tap) ui.focus();
}

async function send(blob) {
  if (blob.size < 400) { ui.rep('No he oído nada. Prueba otra vez.'); ui.stage('idle'); return; }
  busy = true; ui.rep('Pensando', 'wait'); ui.stage('wait');
  let st = 'idle';                                       // 'done' solo si Jota ha contestado
  try {
    const r = await fetch('/api/voice?out=' + out(), { method: 'POST', headers: { 'Content-Type': blob.type, ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (j.text) ui.said(j.text);
    if (j.error && !j.reply) ui.rep(j.error);
    else {
      ui.rep(j.reply || 'No he recibido respuesta.'); buzz(12); st = 'done';
      if (j.audio && out() === 'phone') { player = new Audio(j.audio); player.play().catch(() => {}); }   // solo si se pidió el móvil
    }
  } catch { ui.rep('No hay conexión con el mando.'); }
  busy = false; ui.stage(st);
}

export const voice = {
  /** La hoja se cierra: si se estaba grabando, se descarta. */
  close() { if (rec) { cancelled = true; rec.stop(); } },
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
    b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); downAt = 0; start(); } });
    b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); } });
    // un solo destino, y se recuerda en este móvil
    o.addEventListener('click', () => { cfg.voiceOut = OUTS[(OUTS.indexOf(out()) + 1) % OUTS.length]; saveCfg(); paintOut(); buzz(8); });
    return true;
  },
};
