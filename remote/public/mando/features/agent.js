// Hablar con Jota (v3): un velo con luces sobre el mando. Lo que se escribe (o se dicta con el micrófono del teclado) va
// al J Gateway; la frase entra palabra a palabra, las luces crecen mientras piensa y la respuesta se escribe en directo
// por el WebSocket (`talk`: partial y final de la voz, token con lo acumulado, done, error, stopped, hidden).
// «Parar» mientras piensa, escribe o la respuesta suena (en la tele o aquí: hasta `silent`); «Quitar de la tele» tras la
// respuesta, ya en silencio, mientras la tele aún la enseña (hasta `hidden`; si no sonó en la tele, como mucho QUIT_MS).
// Mientras la tele enseña la conversación, su formato (panel o píldora) se cambia desde aquí: ver talkform.js (`form`).
// Con voz (`voice` de talk.js, suene aquí o en la tele), la respuesta sale frase a frase al ritmo de la voz y lo dicho se
// ilumina (un rAF solo mientras hay voz); la cabeza es la del reproductor si suena aquí. Al acabar (`voice` end), al
// pararse o con un error, todo a la vista.
import { $, el } from '../core/dom.js';
import { cmd, rpc, onWs } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, closeSheet } from '../ui/sheets.js';
import { voice, audioCtx, ensureAudioCtx, outSel, interruptOn } from './voice.js';
import { createPcmPlayer } from './pcm-player.js';
import { talkForm } from './talkform.js';

const QUIT_MS = 5000;                                   // lo que tarda la tele en quitar la respuesta cuando no sonó allí
const STOPPED = 'Parado.';
/** La voz de la respuesta cuando es «en el móvil»: va sobre el AudioContext de voice.js. */
const player = createPcmPlayer(() => audioCtx() || ensureAudioCtx(), () => acts());
let mic = false;                                        // true: el orbe graba (hay micrófono y HTTPS)
let out = 'tv';                                         // dónde suena la respuesta en curso
let quit = false, quitT = 0;                            // «Quitar de la tele» disponible (la tele aún enseña la respuesta)
let talking = false;                                    // Jota responde con voz (del primer token a `silent`, `stopped` o `error`)
let asked = 0;                                          // número de la pregunta: el resultado de una ya sustituida no se pinta
/** La voz sincronizada de la respuesta en curso (`at`: cuándo llegó, para avanzar la cabeza) o null.
 *  @type {{ anchors: [number, number][], rate: number, head: number, upto: number, at: number } | null} */
let vox = null;
let voxText = '', voxSaid = 0, voxRaf = 0;              // la respuesta acumulada, el carácter dicho (no retrocede) y el rAF
let voxShown = '';                                      // lo pintado (palabras y dichas): si no cambia, el DOM no se toca
const SENTENCE_END = /[.!?…:]["'»)\]]*$/;              // palabra que cierra frase (como en la tele)

/** Carácter dicho en el ms `t` de audio (copia de charAt de src/features/voice-sync.js).
 *  @param {[number, number][]} a @param {number} rate @param {number} t @param {number} len */
export function spokenAt(a, rate, t, len) {
  if (!a.length || t < a[0][0]) return 0;
  let i = a.length - 1;
  while (i > 0 && a[i][0] > t) i--;
  const [t1, c1] = a[i], nx = a[i + 1];
  const c = nx ? (nx[0] > t1 ? c1 + (nx[1] - c1) * (t - t1) / (nx[0] - t1) : nx[1]) : c1 + (t - t1) / rate;
  return Math.max(0, Math.min(len, c));
}
/** Con `c` caracteres dichos: las palabras a la vista (hasta el fin de la frase en curso) y cuántas ya dichas.
 *  @param {string} text @param {number} c @returns {{ words: string[], said: number }} */
export function voiceWords(text, c) {
  const ws = [...text.matchAll(/\S+/g)];
  let k = 0;
  while (k < ws.length && ws[k].index <= c) k++;         // palabras ya empezadas
  let vis = Math.min(Math.max(1, k), ws.length);
  while (vis < ws.length && !SENTENCE_END.test(ws[vis - 1][0])) vis++;
  let said = 0;
  while (said < vis && ws[said].index + ws[said][0].length <= c) said++;
  return { words: ws.slice(0, vis).map(m => m[0]), said };
}

/** Los botones de la respuesta: Parar y Quitar de la tele. */
function acts() {
  const st = $('#agS').dataset.st, playing = player.playing();
  $('#agStop').hidden = !(st === 'wait' || talking || playing);
  $('#agHide').hidden = !(quit && st === 'done' && !talking && !playing);
}
/** Si no sonó en la tele, el botón se va solo a los QUIT_MS (lo que tarda la tele en quitarla tras el audio). */
function armQuit() {
  clearTimeout(quitT);
  if (out !== 'tv') quitT = setTimeout(() => { quit = false; acts(); }, QUIT_MS);
}
function noQuit() { clearTimeout(quitT); quit = false; }
/** Para lo que suene en el móvil si toca: al interrumpir, o si no hay nada sonando. */
function cut() { if (interruptOn() || !player.playing()) player.stop(); }

/** Estado de la vista: 'idle' (pídeme algo), 'rec' (grabando con el orbe), 'wait' (un momento) o 'done' (respuesta). */
function stage(st) {
  const S = $('#agS');
  S.dataset.st = st;
  $('#shade').classList.toggle('think', st === 'wait' || st === 'rec');
  $('#agSt').textContent = st === 'wait' ? 'Un momento' : st === 'done' ? 'Jota' : st === 'rec' ? 'Te escucho… suelta para enviar' : 'Pídeme algo';   // en reposo nadie escucha todavía
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
/** Voz de talk.js: guarda las anclas y la cabeza (y cuándo llegaron) y pinta mientras dure. @param {any} j */
function onVoice(j) {
  if (j.end) { voiceEnd(true); return; }
  if (!Array.isArray(j.anchors) || ![j.rate, j.head, j.upto].every(Number.isFinite) || !(j.rate > 0)) return;
  vox = { anchors: j.anchors.filter(a => Array.isArray(a) && a.length === 2 && a.every(Number.isFinite)), rate: j.rate, head: j.head, upto: j.upto, at: performance.now() };
  if (!voxRaf) voxRaf = requestAnimationFrame(voiceFrame);
}
function voiceFrame() { voxRaf = 0; if (!vox) return; paintVoice(); voxRaf = requestAnimationFrame(voiceFrame); }
/** La respuesta al ritmo de la voz: hasta que arranca, sigue «Pensando»; solo se toca el DOM si cambia algo. */
function paintVoice() {
  const v = vox, rep = $('#rep');
  const head = out === 'phone' ? player.pos() : Math.min(v.head + performance.now() - v.at, v.upto);
  if (!v.anchors.length || head < v.anchors[0][0] || !voxText) return;
  voxSaid = Math.max(voxSaid, spokenAt(v.anchors, v.rate, head, voxText.length));
  const { words, said } = voiceWords(voxText, voxSaid);
  const key = said + '|' + words.join(' ');
  if (key === voxShown && rep.dataset.voice !== undefined) return;
  voxShown = key;
  if (rep.dataset.voice === undefined) { rep.className = 'rep'; rep.textContent = ''; rep.dataset.voice = ''; }
  const spans = [...rep.querySelectorAll('.vw')];
  while (spans.length > words.length) { const sp = spans.pop(); if (sp.nextSibling) sp.nextSibling.remove(); sp.remove(); }
  words.forEach((w, i) => {
    let sp = spans[i];
    if (!sp) { sp = el('span', 'vw'); rep.append(sp, ' '); }   // el espacio deja partir la línea entre palabras
    if (sp.textContent !== w) sp.textContent = w;
    sp.classList.toggle('said', i < said);
  });
}
/** Se acaba la voz: con `show`, la respuesta entera como siempre (sin tenue). @param {boolean} show */
function voiceEnd(show) {
  const was = !!vox;
  vox = null; cancelAnimationFrame(voxRaf); voxRaf = 0; voxSaid = 0; voxShown = '';
  const rep = $('#rep');
  if (rep.dataset.voice !== undefined) delete rep.dataset.voice;
  if (was && show && voxText) { rep.className = 'rep'; rep.textContent = voxText; }
}
/** Pregunta nueva: la voz y el texto de la anterior ya no cuentan. */
function voiceReset() { voiceEnd(false); voxText = ''; }

function ask(text) {
  cut();
  voiceReset();
  out = outSel();
  if (out === 'phone') ensureAudioCtx();                // dentro del gesto (iOS); el audio llega después
  said(text);
  const rep = $('#rep'); rep.className = 'rep wait'; rep.textContent = 'Pensando';
  stage('wait');
  // el permiso, un texto vacío o BUSY se contestan por aquí (no hay turno, así que no habrá evento talk)
  talking = false;                                      // la voz de la anterior ya no cuenta: vuelve con el primer token
  const me = ++asked;
  rpc({ t: 'ask', text, out, interrupt: interruptOn() }).then(r => {
    if (me !== asked) return;                           // la sustituyó otra (p. ej. al interrumpir): su «Parado.» no va encima
    if (r && r.error && r.error !== 'sin respuesta' && $('#agS').dataset.st === 'wait') { rep.className = 'rep'; rep.textContent = r.error; stage('idle'); }
  });
}
function onTalk(j) {
  if (j.ev === 'form') { talkForm.got(j); return; }   // el formato de la conversación en la tele (y si se puede cambiar)
  const rep = $('#rep');
  // la parcial es la frase acumulada mientras se habla: sustituye sin animar (las palabras animadas, para la final)
  if (j.ev === 'partial') { const q = $('#agQ'); q.classList.remove('said'); q.textContent = j.text || ''; return; }
  if (j.ev === 'final') { player.stop(); said(j.text || ''); return; }   // los frames de la respuesta anterior ya no valen
  if (j.ev === 'voice') { onVoice(j); return; }
  // la respuesta acumulada, en directo (con voz, la pinta la voz)
  if (j.ev === 'token') { talking = out !== 'none'; voxText = j.text || ''; if (!vox) { rep.className = 'rep'; rep.textContent = voxText; } stage('wait'); return; }
  if (j.ev === 'done') {
    voxText = j.reply || '';
    if (!vox) { rep.className = 'rep'; rep.textContent = j.reply || 'No he recibido respuesta.'; }   // con voz, sigue a su ritmo
    buzz(12);
    quit = true; stage('done'); if (!talking) armQuit(); acts();
    return;
  }
  if (j.ev === 'silent') { talking = false; if (quit) armQuit(); acts(); return; }   // Jota dejó de hablar
  if (j.ev === 'error') { talking = false; voiceReset(); player.stop(); voice.abort(); rep.className = 'rep'; rep.textContent = j.error || 'Jota no está disponible.'; stage('idle'); return; }
  // el turno se paró (aquí o desde otro móvil): el audio se corta; si estaba pensando, «Parado.» (grabando otra frase, nada más)
  if (j.ev === 'stopped') {
    talking = false; voiceEnd(true); player.stop(); noQuit();
    if ($('#agS').dataset.st === 'wait') { rep.className = 'rep'; rep.textContent = STOPPED; stage('idle'); }
    acts();
    return;
  }
  if (j.ev === 'hidden') { noQuit(); talkForm.got(null); acts(); }
}
/** Parar: el turno y el audio (aquí y en la tele) y la tele se limpia. */
function stop() {
  buzz(8); voiceEnd(true); player.stop(); noQuit(); talking = false; asked++;
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
    talkForm.init();
    agin.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault(); const v = agin.value.trim();
      if (!v) return;
      agin.value = ''; ask(v);
    });
    const rep = (t, cls = '') => { const r = $('#rep'); r.className = 'rep' + (cls ? ' ' + cls : ''); r.textContent = t; };
    onWs('bin', b => player.play(b));
    mic = voice.init({ stage, said, rep, press: () => { cut(); voiceReset(); out = outSel(); asked++; talking = false; }, focus: () => { buzz(8); agin.focus(); } });
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
