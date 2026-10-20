// Hablar con Jota (v3): un velo con luces sobre el mando. Lo que se escribe (o se dicta con el micrófono del teclado) va
// al J Gateway; la frase entra palabra a palabra, las luces crecen mientras piensa y la respuesta se escribe en directo
// por el WebSocket (`talk`: partial y final de la voz, token con lo acumulado, done, error, stopped, hidden).
// «Parar» mientras piensa, escribe o la respuesta suena en este móvil; «Quitar de la tele» tras la respuesta, mientras la
// tele aún la enseña (hasta `hidden`; si no sonó en la tele, como mucho QUIT_MS).
import { $, el } from '../core/dom.js';
import { cmd, rpc, onWs } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, closeSheet } from '../ui/sheets.js';
import { voice, audioCtx, ensureAudioCtx, outSel, interruptOn } from './voice.js';
import { createPcmPlayer } from './pcm-player.js';

const QUIT_MS = 5000;                                   // lo que tarda la tele en quitar la respuesta cuando no sonó allí
const STOPPED = 'Parado.';
/** La voz de la respuesta cuando es «en el móvil»: va sobre el AudioContext de voice.js. */
const player = createPcmPlayer(() => audioCtx() || ensureAudioCtx(), () => { if (quit && !player.playing()) armQuit(); acts(); });
let mic = false;                                        // true: el orbe graba (hay micrófono y HTTPS)
let out = 'tv';                                         // dónde suena la respuesta en curso
let quit = false, quitT = 0;                            // «Quitar de la tele» disponible (la tele aún enseña la respuesta)

/** Los botones de la respuesta: Parar y Quitar de la tele. */
function acts() {
  const st = $('#agS').dataset.st, playing = player.playing();
  $('#agStop').hidden = !(st === 'wait' || playing);
  $('#agHide').hidden = !(quit && st === 'done' && !playing);
}
/** Sin sonar en la tele no llega a tiempo `hidden` de la tele para todo: el botón se va solo a los QUIT_MS. */
function armQuit() {
  clearTimeout(quitT);
  if (out !== 'tv') quitT = setTimeout(() => { quit = false; acts(); }, QUIT_MS);
}
function noQuit() { clearTimeout(quitT); quit = false; }
/** Para lo que suene en el móvil si toca: al interrumpir, o si no hay nada sonando. */
function cut() { if (interruptOn() || !player.playing()) player.stop(); }

/** Estado de la vista: 'idle' (te escucho), 'rec' (grabando con el orbe), 'wait' (un momento) o 'done' (respuesta). */
function stage(st) {
  const S = $('#agS');
  S.dataset.st = st;
  $('#shade').classList.toggle('think', st === 'wait' || st === 'rec');
  $('#agSt').textContent = st === 'wait' ? 'Un momento' : st === 'done' ? 'Jota' : st === 'rec' ? 'Te escucho… suelta para enviar' : 'Te escucho';
  if (st !== 'done') noQuit();
  acts();
}
/* la frase entra palabra a palabra (el retraso de cada una va en --i; con movimiento reducido, todas a la vez) */
function said(text) {
  const q = $('#agQ'); q.textContent = '';
  text.split(/\s+/).filter(Boolean).forEach((w, i) => { const s = el('span', 'w', w); s.style.setProperty('--i', String(i)); q.append(s, ' '); });
  void q.offsetWidth;
  q.classList.remove('said'); requestAnimationFrame(() => q.classList.add('said'));
}
function ask(text) {
  cut();
  out = outSel();
  if (out === 'phone') ensureAudioCtx();                // dentro del gesto (iOS); el audio llega después
  said(text);
  const rep = $('#rep'); rep.className = 'rep wait'; rep.textContent = 'Pensando';
  stage('wait');
  // el permiso, un texto vacío o BUSY se contestan por aquí (no hay turno, así que no habrá evento talk)
  rpc({ t: 'ask', text, out, interrupt: interruptOn() }).then(r => { if (r && r.error && r.error !== 'sin respuesta' && $('#agS').dataset.st === 'wait') { rep.className = 'rep'; rep.textContent = r.error; stage('idle'); } });
}
function onTalk(j) {
  const rep = $('#rep');
  // la parcial es la frase acumulada mientras se habla: sustituye sin animar (las palabras animadas, para la final)
  if (j.ev === 'partial') { const q = $('#agQ'); q.classList.remove('said'); q.textContent = j.text || ''; return; }
  if (j.ev === 'final') { player.stop(); said(j.text || ''); return; }   // los frames de la respuesta anterior ya no valen
  if (j.ev === 'token') { rep.className = 'rep'; rep.textContent = j.text || ''; stage('wait'); return; }   // la respuesta acumulada, en directo
  if (j.ev === 'done') {
    rep.className = 'rep'; rep.textContent = j.reply || 'No he recibido respuesta.'; buzz(12);
    quit = true; stage('done'); if (!player.playing()) armQuit(); acts();
    return;
  }
  if (j.ev === 'error') { player.stop(); voice.abort(); rep.className = 'rep'; rep.textContent = j.error || 'Jota no está disponible.'; stage('idle'); return; }
  // el turno se paró (aquí o desde otro móvil): el audio se corta; si estaba pensando, «Parado.» (grabando otra frase, nada más)
  if (j.ev === 'stopped') {
    player.stop(); noQuit();
    if ($('#agS').dataset.st === 'wait') { rep.className = 'rep'; rep.textContent = STOPPED; stage('idle'); }
    acts();
    return;
  }
  if (j.ev === 'hidden') { noQuit(); acts(); }
}
/** Parar: el turno y el audio (aquí y en la tele) y la tele se limpia. */
function stop() {
  buzz(8); player.stop(); noQuit();
  const st = $('#agS').dataset.st;
  if (st === 'wait') { const rep = $('#rep'); rep.className = 'rep'; rep.textContent = STOPPED; stage('idle'); }
  acts();
  rpc({ t: 'stop' }).then(r => { if (r && r.error && r.error !== 'sin respuesta') { const rep = $('#rep'); rep.className = 'rep'; rep.textContent = r.error; } });
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
    mic = voice.init({ stage, said, rep, press: () => { cut(); out = outSel(); }, focus: () => { buzz(8); agin.focus(); } });
    $('#agStop').addEventListener('click', stop);
    $('#agHide').addEventListener('click', () => { buzz(7); noQuit(); acts(); cmd({ t: 'hide' }); });
    // sin micrófono propio (http): el orbe enfoca el campo y el teclado del móvil trae el suyo
    if (!mic) $('#agOrb').addEventListener('click', () => { buzz(8); agin.focus(); });
    $('#agX').addEventListener('click', () => { buzz(7); closeSheet(); });
    $('#agC').addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-ask]')); if (!b) return;
      buzz(8); ask(b.dataset.ask);
    });
  },
};
