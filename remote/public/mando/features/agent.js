// Hablar con Jota (v3): un velo con luces sobre el mando. Lo que se escribe (o se dicta con el micrófono del teclado) va
// a OpenClaw; la frase entra palabra a palabra, las luces crecen mientras piensa y la respuesta llega por el WebSocket.
import { $, el } from '../core/dom.js';
import { cmd } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, closeSheet } from '../ui/sheets.js';
import { voice } from './voice.js';

let mic = false;                                        // true: el orbe graba (hay micrófono y HTTPS)

/** Estado de la vista: 'idle' (te escucho), 'rec' (grabando con el orbe), 'wait' (un momento) o 'done' (respuesta). */
function stage(st) {
  const S = $('#agS');
  S.dataset.st = st;
  $('#shade').classList.toggle('think', st === 'wait' || st === 'rec');
  $('#agSt').textContent = st === 'wait' ? 'Un momento' : st === 'done' ? 'Jota' : st === 'rec' ? 'Te escucho… suelta para enviar' : 'Te escucho';
}
/* la frase entra palabra a palabra (el retraso de cada una va en --i; con movimiento reducido, todas a la vez) */
function said(text) {
  const q = $('#agQ'); q.textContent = '';
  text.split(/\s+/).filter(Boolean).forEach((w, i) => { const s = el('span', 'w', w); s.style.setProperty('--i', String(i)); q.append(s, ' '); });
  void q.offsetWidth;
  q.classList.remove('said'); requestAnimationFrame(() => q.classList.add('said'));
}
function ask(text) {
  cmd({ t: 'ask', text });
  said(text);
  const rep = $('#rep'); rep.className = 'rep wait'; rep.textContent = 'Pensando';
  stage('wait');
}
function onAsk(j) {
  const rep = $('#rep');
  if (j.stage === 'thinking') { rep.className = 'rep wait'; rep.textContent = 'Pensando'; stage('wait'); return; }
  rep.className = 'rep'; rep.textContent = j.reply || 'No he recibido respuesta.'; buzz(12);
  stage('done');
}

export const agent = {
  name: 'agent',
  msgs: { ask: onAsk },
  sheets: { agS: {
    open() {
      const agin = $('#agin'); agin.value = ''; if (!mic) agin.focus(); $('#shade').classList.add('vz');   // con micro, sin teclado encima del orbe
      if ($('#agS').dataset.st === 'wait') stage('wait');   // se cerró mientras pensaba: las luces siguen creciendo
    },
    close() { voice.close(); $('#shade').classList.remove('vz', 'think'); },
  } },
  clicks: { ag: () => openSheet('agS') },
  init() {
    const agin = $('#agin');
    stage('idle');
    agin.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault(); const v = agin.value.trim();
      if (!v) return;
      agin.value = ''; ask(v);
    });
    const rep = (t, cls = '') => { const r = $('#rep'); r.className = 'rep' + (cls ? ' ' + cls : ''); r.textContent = t; };
    mic = voice.init({ stage, said, rep, focus: () => { buzz(8); agin.focus(); } });
    // sin micrófono propio (http): el orbe enfoca el campo y el teclado del móvil trae el suyo
    if (!mic) $('#agOrb').addEventListener('click', () => { buzz(8); agin.focus(); });
    $('#agX').addEventListener('click', () => { buzz(7); closeSheet(); });
    $('#agC').addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-ask]')); if (!b) return;
      buzz(8); ask(b.dataset.ask);
    });
  },
};
