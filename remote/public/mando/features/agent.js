// Hablar con Jota (v3): un velo con luces sobre el mando. Lo que se escribe (o se dicta con el micrófono del teclado) va
// al J Gateway; la frase entra palabra a palabra, las luces crecen mientras piensa y la respuesta se escribe en directo
// por el WebSocket (`talk`: partial y final de la voz, token con lo acumulado, done, error).
import { $, el } from '../core/dom.js';
import { rpc, onWs } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, closeSheet } from '../ui/sheets.js';
import { voice, audioCtx, ensureAudioCtx, outSel } from './voice.js';
import { createPcmPlayer } from './pcm-player.js';

/** La voz de la respuesta cuando es «en el móvil»: va sobre el AudioContext de voice.js. */
const player = createPcmPlayer(() => audioCtx() || ensureAudioCtx());
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
  player.stop();
  if (outSel() === 'phone') ensureAudioCtx();           // dentro del gesto (iOS); el audio llega después
  said(text);
  const rep = $('#rep'); rep.className = 'rep wait'; rep.textContent = 'Pensando';
  stage('wait');
  // el permiso o un texto vacío se contestan por aquí (no hay turno, así que no habrá evento talk)
  rpc({ t: 'ask', text, out: outSel() }).then(r => { if (r && r.error && r.error !== 'sin respuesta' && $('#agS').dataset.st === 'wait') { rep.className = 'rep'; rep.textContent = r.error; stage('idle'); } });
}
function onTalk(j) {
  const rep = $('#rep');
  // la parcial es la frase acumulada mientras se habla: sustituye sin animar (las palabras animadas, para la final)
  if (j.ev === 'partial') { const q = $('#agQ'); q.classList.remove('said'); q.textContent = j.text || ''; return; }
  if (j.ev === 'final') { said(j.text || ''); return; }
  if (j.ev === 'token') { rep.className = 'rep'; rep.textContent = j.text || ''; stage('wait'); return; }   // la respuesta acumulada, en directo
  if (j.ev === 'done') { rep.className = 'rep'; rep.textContent = j.reply || 'No he recibido respuesta.'; buzz(12); stage('done'); return; }
  if (j.ev === 'error') { player.stop(); rep.className = 'rep'; rep.textContent = j.error || 'Jota no está disponible.'; stage('idle'); }
}

export const agent = {
  name: 'agent',
  msgs: { talk: onTalk },
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
    onWs('bin', b => player.play(b));
    mic = voice.init({ stage, said, rep, press: () => player.stop(), focus: () => { buzz(8); agin.focus(); } });
    // sin micrófono propio (http): el orbe enfoca el campo y el teclado del móvil trae el suyo
    if (!mic) $('#agOrb').addEventListener('click', () => { buzz(8); agin.focus(); });
    $('#agX').addEventListener('click', () => { buzz(7); closeSheet(); });
    $('#agC').addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-ask]')); if (!b) return;
      buzz(8); ask(b.dataset.ask);
    });
  },
};
