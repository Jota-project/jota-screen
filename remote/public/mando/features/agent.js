// Hablar con Jota (v3): un velo con luces sobre el mando. Lo que se escribe (o se dicta con el micrófono del teclado) va
// a OpenClaw; la frase entra palabra a palabra, las luces crecen mientras piensa y la respuesta llega por el WebSocket.
import { $, el } from '../core/dom.js';
import { cmd } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, closeSheet } from '../ui/sheets.js';

/** Estado de la vista: 'idle' (te escucho), 'wait' (un momento) o 'done' (respuesta). */
function stage(st) {
  const S = $('#agS');
  S.dataset.st = st;
  $('#shade').classList.toggle('think', st === 'wait');
  $('#agSt').textContent = st === 'wait' ? 'Un momento' : st === 'done' ? 'Jota' : 'Te escucho';
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
    open() { const agin = $('#agin'); agin.value = ''; agin.focus(); $('#shade').classList.add('vz'); },
    close() { $('#shade').classList.remove('vz', 'think'); },
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
    $('#agOrb').addEventListener('click', () => { buzz(8); agin.focus(); });   // el teclado del móvil trae el micrófono
    $('#agX').addEventListener('click', () => { buzz(7); closeSheet(); });
    $('#agC').addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-ask]')); if (!b) return;
      buzz(8); ask(b.dataset.ask);
    });
  },
};
