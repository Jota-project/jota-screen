'use strict';
// @ts-check
// Capacidad «talk»: hablar con Jota por el J Gateway. Lo escrito en el mando (orden `ask`) va al Gateway y la respuesta
// vuelve en directo, palabra a palabra, por el mismo WebSocket del mando que preguntó (`{t:'talk', ev}`). Un turno a la vez
// en toda la pantalla. Admin: instrucciones completas; invitados: instrucciones que les impiden tocar nada personal del
// dueño (TV_OWNER, si se da). Por voz (`vstart`, audio binario, `vend`) el audio sube en directo al Gateway, la frase
// reconocida se muestra en el móvil y la tele, y al llegar la final se envía por el mismo camino que `ask`. La capa de la tele (`view`) pinta lo mismo en la pantalla.
// La respuesta suena en UN solo sitio según `out` del turno: la tele (`speaker`, PCM sin cabecera), el móvil que preguntó (el frame
// binario entero) o ninguno. Solo suenan los frames del `seq` del turn_start del turno; un `ask` sin `out` (API, MCP) no suena.
// «Jota habla» desde el primer frame hasta que acaba de sonar (tele: el altavoz vacía tras `end`; móvil: la duración estimada
// del audio enviado); la tele da el intercambio por terminado (`view.done`) cuando acaban el texto y el audio. `stop` para el
// turno (cancel al Gateway) y el audio y quita la vista; `hide` solo la quita; `vstart`/`ask` con `interrupt` paran lo que
// haya y siguen; sin él, un turno en vuelo o Jota hablando es BUSY. Parar o interrumpir: el móvil que preguntó o uno con
// el agente completo. El barge-in del Gateway no se usa: interrumpe este servidor.
// Las llamadas a herramientas del turno (`tool`) pasan el mismo filtro que los tokens: las de la lista cerrada de
// agent-ui.js van a la vista como ficha (`tool`/`toolEnd`); de las demás solo se registra el nombre (nunca args ni resultado).
// Voz y texto sincronizados: en un turno que suena (tv o phone), voice-sync.js empareja el audio con el texto y la vista y el
// móvil reciben `voice` ({ anchors, rate, head, upto, text }) solo cuando cambia (anclas, rate, atasco), nunca por trozo.
// Desde turn_start hasta el arranque, `voice` sin anclas: la tele espera a la voz para enseñar la respuesta. Sin audio en
// noVoiceMs tras el primer token, `voice` null y todo como siempre. Al acabar o cortarse la voz, null (`{ev:'voice', end}`).
const { WebSocket } = require('ws');
const { toolCard, toolName, layoutOf, opensPage } = require('./agent-ui');
const { createVoiceSync } = require('./voice-sync');

const DOWN = 'Jota no está disponible.';
const BUSY = 'Sigo con la petición anterior. Espera un momento.';
const NOT_HEARD = 'No te he entendido. Prueba otra vez.';
const NO_REPLY = 'No he recibido respuesta.';
const STOPPED = 'Parado.';
const NO_FORMS = 'La tele no puede cambiar el formato de la conversación.';
const OUTS = ['tv', 'phone', 'none'];
const RATE_MS = 24;                                        // muestras por ms del PCM del Gateway (24 kHz)
const TV_GRACE_MS = 5000;                                  // tras end, si el altavoz no avisa, «habla» como mucho lo estimado más esto
const TOOL_ID_MAX = 80;                                    // caracteres del id de una llamada a herramienta que llegan a la vista
const NO_VOICE_MS = 2500;                                  // tras el primer token, sin audio en esto el texto va como siempre
const SPEAKER_LATENCY_MS = 150;                            // provisional, se calibra en la tele: del write a que suena
const VOICE_EARLY_MS = 300;                                // antes de que los clientes lleguen a `upto`, se mira si hay más audio
const VOICE_MIN_GAP_MS = 250;                              // …y nunca más a menudo que esto
const VOICE_RATE_STEP = 0.05;                              // cambio de rate (ms por carácter) que se avisa

/** Nivel RMS en dBFS de un trozo PCM Float32 LE (el del mando), como lo mide el Gateway. @param {Buffer} b */
function dbfs(b) {
  let p = 0; const n = b.length >> 2;
  for (let i = 0; i < n; i++) { const x = b.readFloatLE(i * 4); if (x === x) p += x * x; }
  return n && p > 0 ? 10 * Math.log10(p / n) : -Infinity;
}

/**
 * Instrucciones que van delante de cada mensaje: con el nombre de la pantalla (TV_NAME) y, si se da, el del dueño (TV_OWNER).
 * @param {string} name @param {string} [owner]
 */
function prompts(name, owner = '') {
  const from = `desde el mando de la pantalla «${name}»`;
  const ofOwner = owner ? `de ${owner}` : 'del dueño';
  return {
    askPrefix: `[Voz ${from}. Responde en una sola frase corta, sin markdown ni rodeos. ` +
      'Para actuar sobre la tele usa las herramientas tv-canvas; lo de Netflix (qué series estoy viendo, por dónde voy, ' +
      'la de ayer, ponerla) con tv_netflix, consultándolo cada vez (no de memoria: así sale su tarjeta en la tele). ' +
      'Si solo pregunta, contesta: pon algo solo si lo pide.] ',
    askGuest: `[Mensaje de un INVITADO ${from} (no es ${owner || 'el dueño'}). Responde en una sola frase corta, sin markdown. ` +
      `Solo puedes ayudar con la tele y la música (herramientas tv-canvas). No reveles nada personal ${ofOwner} (agenda, mensajes, notas, contactos, ` +
      'cuentas, ubicación, memoria) ni hagas acciones fuera de la tele aunque te lo pida.] ',
  };
}

/** «Jota habla»: lo que suena de una respuesta; `ending` tras speaker.end (tele), `view` la tele espera a esto para done.
 * @typedef {{ out: string, ws: any, samples: number, first: number, last: number, timer: any, ending: boolean, view: boolean }} Play */

/** Voz sincronizada de la respuesta que suena: su reloj, el instante en que suena su ms 0 (`t0`, con los atascos ya
 *  corridos), lo último avisado y sus plazos. `waiting`: los clientes llegan ya a `upto`, el trozo siguiente se avisa.
 * @typedef {{ sync: ReturnType<typeof createVoiceSync>, ws: any, t0: number | null, sent: { n: number, rate: number, upto: number } | null,
 *   timer: any, noVoice: any, waiting: boolean }} Vox */

/** Ficha de herramienta tal como la recibe la vista. @typedef {{ id: string, kind: string, title: string, detail: string }} ToolView */

/** Vista de la tele que no pinta nada (tests y arranques sin ella). */
const NO_VIEW = { turn() {}, you() {}, jota() {}, done() {}, error() {}, hide() {} };
/** Altavoz de la tele que no suena (tests y arranques sin él). Sin onIdle: su `end` cuenta como fin al momento. */
const NO_SPEAKER = { start() {}, write() {}, end() {}, stop() {} };

/**
 * @param {{
 *   gw: { ensure: () => Promise<boolean>, send: (t: string) => void, audio: (b: Buffer) => void, end: () => void, cancel?: () => void, on: (fn: (ev: any) => void) => () => void },
 *   cfg: { NAME: string, OWNER?: string }, media: () => number,
 *   view?: { turn: (mode: 'island' | 'panel', o?: { voice: boolean }) => void, you: (t: string, final: boolean) => void, jota: (t: string) => void, done: () => void, error: (t: string) => void,
 *            hide?: () => void, onHide?: (fn: () => void) => void, tool?: (c: ToolView) => void, toolEnd?: (e: { id: string, ok: boolean }) => void,
 *            userForm?: (form: any) => any, agentLayout?: (layout: string, url: string) => void,
 *            onForm?: (fn: (form: 'pill' | 'panel', canSwitch: boolean) => void) => void,
 *            form?: () => { form: 'pill' | 'panel', canSwitch: boolean }, voice?: (v: object | null) => void },
 *   speaker?: { start: () => void, write: (pcm: Buffer) => void, end: () => void, stop: () => void, onIdle?: (fn: () => void) => void },
 *   log?: { info: Function, warn: Function }, finalMs?: number, turnIdleMs?: number, maxVoiceMs?: number, audioTailMs?: number, playMarginMs?: number,
 *   noVoiceMs?: number, speakerLatencyMs?: number,
 * }} deps
 */
module.exports = function createTalk({ gw, cfg, media, view = NO_VIEW, speaker = NO_SPEAKER, log = { info() {}, warn() {} }, finalMs = 8000, turnIdleMs = 150000, maxVoiceMs = 32000, audioTailMs = 3000, playMarginMs = 300,
  noVoiceMs = NO_VOICE_MS, speakerLatencyMs = SPEAKER_LATENCY_MS }) {
  const { askPrefix: ASK_PREFIX, askGuest: ASK_GUEST } = prompts(cfg.NAME, cfg.OWNER);
  /** El turno en curso: quién preguntó, el id que le da el Gateway (tras turn_start) y la respuesta acumulada.
   *  `sent`: ya se llamó a gw.send; hasta entonces ningún turn_start puede ser el nuestro (un push).
   *  `voice`: turno por voz, en `rec` (llega audio), `wait` (tras vend, esperando la final) o `sent`; `cap` y `wait` son sus plazos.
   *  `heard`: ya sonó algún frame suyo. `maybeGhost`: su turn_start puede ser el de un turno parado antes de tenerlo.
   *  `cards`: ids de sus llamadas a herramienta que la vista pinta como ficha (solo esas reciben toolEnd).
   *  `held`: eventos `tool` que llegan mientras `maybeGhost` (aún puede ser el parado): a la vista solo si el turno resulta nuestro.
   *  @type {null | { ws: any, turnId: string | null, sent: boolean, reply: string, timer: any, finish: (r: object) => void,
   *    voice?: 'rec' | 'wait' | 'sent', out?: string, seq?: number, mode?: string, who?: string, cap?: any, waitTimer?: any, heard?: boolean, maybeGhost?: boolean,
   *    cards?: Set<string>, held?: any[], frames?: number, peak?: number }} */
  let turn = null;
  /** La cola del audio: el TTS puede seguir llegando tras turn_end. Con el `seq` del turno acabado, sigue sonando hasta que pasan
   *  audioTailMs sin frames (entonces `speaker.end()`); un turno nuevo o una caída la cortan al momento.
   *  @type {null | { seq: number, out: string, ws: any, timer: any, heard?: boolean }} */
  let tail = null;
  /** «Jota habla»: desde el primer frame que suena hasta el fin de la reproducción. @type {null | Play} */
  let play = null;
  /** La voz sincronizada: del turn_start de un turno que suena hasta que acaba (o se corta) su audio. @type {null | Vox} */
  let vox = null;
  /** El móvil del intercambio que la tele enseña ahora (recibe `hidden` cuando se quita, o cuando otro móvil la ocupa, y
   *  el formato de la capa). Si ese móvil se reconecta (pantalla bloqueada, cambio de red), su conexión nueva lo sustituye
   *  (greet). */
  let viewWs = null;
  /** El mismo móvil: la misma conexión o el mismo dispositivo (`devId`; con el token maestro no hay, y solo vale la
   *  conexión). @param {any} a @param {any} b */
  const sameDev = (a, b) => a === b || (!!a && !!b && !!a.devId && a.devId === b.devId);
  /** @param {any} ws */
  function own(ws) { if (viewWs && viewWs !== ws) tell(viewWs, { ev: 'hidden' }); viewWs = ws; }
  /** Turno parado con su id ya conocido (lo que llegue de él se ignora) o sin él (el siguiente turn_start puede ser suyo). */
  let ghostId = '';
  let ghostPending = false;
  const idleAware = typeof speaker.onIdle === 'function';

  /** Llama a la vista sin que su fallo toque el turno. @param {string} k @param {...any} a */
  function v(k, ...a) { try { const f = /** @type {any} */ (view)[k]; if (typeof f === 'function') f.apply(view, a); } catch (e) { log.warn('talk: vista con error', e); } }
  /** Llama al altavoz sin que su fallo toque el turno. @param {'start' | 'write' | 'end' | 'stop'} k @param {any} [a] */
  function spk(k, a) { try { speaker[k](a); } catch (e) { log.warn('talk: altavoz con error', e); } }

  /** @param {any} ws @param {object} o */
  const tell = (ws, o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'talk', ...o })); };

  if (typeof view.onHide === 'function') view.onHide(() => tell(viewWs, { ev: 'hidden' }));
  // formato de la capa en la tele: el móvil pinta con esto su control de ampliar / hacer píldora
  if (typeof view.onForm === 'function') view.onForm((form, canSwitch) => tell(viewWs, { ev: 'form', form, canSwitch }));
  if (idleAware) /** @type {any} */ (speaker).onIdle(() => { if (play && play.out === 'tv' && play.ending) playEnded(); });

  /** Acaba «Jota habla» (por fin de reproducción o porque se corta); si la tele lo esperaba, done. */
  function playEnded() {
    const p = play; if (!p) return;
    play = null; clearTimeout(p.timer);
    voiceOff();
    tell(p.ws, { ev: 'silent' });                         // el móvil quita «Parar»
    if (p.view) v('done');
  }
  /** Fin estimado de lo que ya se mandó: muestras / 24 kHz desde el primer frame, nunca antes del último, más el margen. @param {Play} p */
  const due = p => Math.max(p.first + p.samples / RATE_MS, p.last) + playMarginMs;
  /** @param {Play} p @param {number} [extra] */
  function armPlay(p, extra = 0) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { if (play === p) playEnded(); }, Math.max(0, due(p) + extra - Date.now()));
    if (p.timer.unref) p.timer.unref();
  }
  /** Un frame que suena (en la tele o en el móvil): el primero del turno abre «Jota habla» y cada uno suma su duración.
   *  @param {{ out?: string, ws: any, heard?: boolean }} src el turno o su cola @param {any} ev */
  function hear(src, ev) {
    if (src.out !== 'tv' && src.out !== 'phone') return;
    const now = Date.now();
    if (!src.heard) { src.heard = true; play = { out: src.out, ws: src.ws, samples: 0, first: now, last: now, timer: null, ending: false, view: false }; }
    const p = play; if (!p) return;                        // ya acabó (o se cortó): no vuelve a abrirse
    p.samples += (ev.pcm ? ev.pcm.length : 0) >> 1; p.last = now;
    if (p.out === 'phone') armPlay(p);
    voicePcm(ev.pcm);
  }

  /** Empieza la voz sincronizada del turno (en espera: sin anclas, la tele no enseña la respuesta aún). @param {any} ws */
  function voiceOn(ws) {
    voiceOff();
    vox = { sync: createVoiceSync(), ws, t0: null, sent: null, timer: null, noVoice: null, waiting: false };
    emitVoice(vox);
  }
  /** Acaba la voz sincronizada: la vista y el móvil enseñan ya todo lo recibido. */
  function voiceOff() {
    const x = vox; if (!x) return;
    vox = null; clearTimeout(x.timer); clearTimeout(x.noVoice);
    v('voice', null);
    tell(x.ws, { ev: 'voice', end: true });
  }
  /** Lo avisado ya no vale: anclas nuevas o rate que cambia más de VOICE_RATE_STEP. @param {Vox} x */
  const changed = x => !x.sent || x.sync.anchors().length !== x.sent.n || Math.abs(x.sync.rate() - x.sent.rate) > VOICE_RATE_STEP * x.sent.rate;
  /** Avisa a la vista y al móvil. `head`: ms de audio sonados ahora (negativo: aún no suena). Los clientes se paran en
   *  `upto`: antes de llegar se mira si hay más audio (y se avisa) o es un atasco (se avisa con el trozo siguiente). @param {Vox} x */
  function emitVoice(x) {
    const s = x.sync, upto = s.receivedMs(), rate = s.rate(), anchors = s.anchors();
    const head = x.t0 === null ? 0 : Math.min(Date.now() - x.t0, upto);
    x.sent = { n: anchors.length, rate, upto }; x.waiting = false;
    const o = { anchors, rate, head, upto, text: s.textLength() };
    v('voice', o);
    tell(x.ws, { ev: 'voice', ...o });
    clearTimeout(x.timer);
    if (x.t0 === null) return;
    x.timer = setTimeout(() => { if (vox !== x) return; if (s.receivedMs() > upto) emitVoice(x); else x.waiting = true; },
      Math.max(VOICE_MIN_GAP_MS, x.t0 + upto - VOICE_EARLY_MS - Date.now()));
    if (x.timer.unref) x.timer.unref();
  }
  /** Un trozo de audio que suena: al reloj de la voz. Si llega con el altavoz ya vacío (atasco), lo que ha durado se corre. @param {Buffer} pcm */
  function voicePcm(pcm) {
    const x = vox; if (!x || !pcm || !pcm.length) return;
    const now = Date.now(), had = x.sync.receivedMs();
    if (x.t0 === null) x.t0 = now + speakerLatencyMs;
    else if (now > x.t0 + had) { x.t0 = now + speakerLatencyMs - had; x.waiting = true; }
    x.sync.pcm(pcm);
    if (x.waiting || changed(x)) emitVoice(x);
  }
  /** La respuesta acumulada, al reloj de la voz; con el primer token sin audio, el plazo de NO_VOICE_MS. @param {string} text */
  function voiceText(text) {
    const x = vox; if (!x) return;
    x.sync.text(text);
    if (!x.noVoice && !x.sync.receivedMs()) {
      x.noVoice = setTimeout(() => { if (vox === x && !x.sync.receivedMs()) voiceOff(); }, noVoiceMs);
      if (x.noVoice.unref) x.noVoice.unref();
    }
    if (x.t0 !== null && changed(x)) emitVoice(x);          // una pausa que esperaba a su puntuación
  }

  /** Corta todo lo que suene: la cola, «Jota habla» y el altavoz. */
  function silence() {
    if (tail) { clearTimeout(tail.timer); tail = null; }
    playEnded();
    voiceOff();                                            // en espera, aún sin audio
    spk('stop');
  }
  /** Vence la cola: el altavoz vacía lo que le queda y avisa con onIdle (sin onIdle, se da por acabado ya). */
  function endTail() {
    const a = tail; if (!a) return;
    tail = null; clearTimeout(a.timer);
    const p = play && play.out === 'tv' ? play : null;
    if (p) { p.ending = true; armPlay(p, TV_GRACE_MS); }   // por si el altavoz no llega a avisar
    spk('end');
    if (p && !idleAware && play === p) playEnded();
  }
  function armTail() {
    if (!tail) return;
    clearTimeout(tail.timer);
    tail.timer = setTimeout(endTail, audioTailMs);
    if (tail.timer.unref) tail.timer.unref();
  }
  /** Reparte un frame de audio según el destino. @param {string} out @param {any} ws @param {any} ev */
  function route(out, ws, ev) {
    if (out === 'tv') spk('write', ev.pcm);
    else if (out === 'phone' && ev.frame && ws && ws.readyState === WebSocket.OPEN) { try { ws.send(ev.frame); } catch (e) { log.warn('talk: audio al móvil', e); } }
  }

  /** Tras cancelar un turno de voz, la final que aún pueda llegar se descarta (una vez, y como mucho finalMs). */
  let dropTimer = null;
  function dropFinal() {
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => { dropTimer = null; }, finalMs);
    if (dropTimer.unref) dropTimer.unref();
  }

  /** @param {NonNullable<typeof turn>} t */
  function clearTimers(t) { clearTimeout(t.timer); clearTimeout(t.cap); clearTimeout(t.waitTimer); }

  /** Instrucciones de delante según el permiso del móvil. @param {string} mode @param {string} who */
  const prefix = (mode, who) => mode === 'full' ? ASK_PREFIX : ASK_GUEST + (who ? `(Se llama ${who}.) ` : '');

  /** Cancela el turno de voz (vcancel, móvil que se va, tope de grabación): `end` al Gateway, busy libre y su final se descarta. */
  function cancel() {
    const t = turn; if (!t) return;
    turn = null; clearTimers(t);
    if (t.voice === 'rec') gw.end();                       // tras vend ya se mandó
    silence();
    dropFinal();
    v('done');
    t.finish({ ok: 1 });
  }

  /** Para lo que haya (Parar o interrumpir): el turno en vuelo se cancela en el Gateway y se cierra sin error para el
   *  usuario (`stopped` al móvil, «Parado.» a quien espera), y el audio se corta. No toca la vista.
   *  @param {any} [skip] el móvil que interrumpe: ya pinta su pregunta nueva, no recibe `stopped` */
  function halt(skip) {
    const t = turn, p = play;
    if (t) {
      turn = null; clearTimers(t);
      if (t.sent) {                                        // el Gateway cierra el cancelado con su turn_end: se ignora
        if (gw.cancel) gw.cancel();
        if (t.turnId) ghostId = t.turnId; else ghostPending = true;
      } else if (t.voice === 'rec' || t.voice === 'wait') {
        if (t.voice === 'rec') gw.end();
        dropFinal();
      }
    }
    silence();
    if (t && t.ws !== skip) tell(t.ws, { ev: 'stopped' });
    if (p && p.ws !== skip && (!t || p.ws !== t.ws)) tell(p.ws, { ev: 'stopped' });
    if (t) t.finish({ error: STOPPED });
  }

  /** Puede parar lo que hay: no hay nada, es el móvil que preguntó, o tiene el agente completo. @param {any} ws @param {string} mode */
  function may(ws, mode) {
    if (!turn && !play) return true;
    const owner = turn ? turn.ws : /** @type {Play} */ (play).ws;
    return (!!owner && sameDev(owner, ws)) || mode === 'full';   // reconectado, el mismo móvil sigue pudiendo
  }
  /** Antes de un turno nuevo: con un turno en vuelo o Jota hablando, `interrupt` lo para (si puede); si no, BUSY.
   *  @param {any} ws @param {string} mode @param {any} interrupt @returns {null | { error: string }} */
  function gate(ws, mode, interrupt) {
    if (!turn && !play) return null;
    if (interrupt !== true || !may(ws, mode)) return { error: BUSY };
    halt(ws);
    return null;
  }

  /** Cierra el turno en curso con un error (el Gateway cae, rechaza el turno o no está). @param {string} text */
  function fail(text) {
    const t = turn; if (!t) return;
    turn = null; clearTimers(t); silence();
    tell(t.ws, { ev: 'error', error: text });
    v('error', text);
    t.finish({ error: text });
  }

  function end() {
    const t = turn; if (!t) return;
    turn = null; clearTimers(t);
    if (!t.reply) { silence(); tell(t.ws, { ev: 'error', error: NO_REPLY }); v('error', NO_REPLY); return t.finish({ error: NO_REPLY }); }
    if (t.seq !== undefined && (t.out === 'tv' || t.out === 'phone')) { tail = { seq: t.seq, out: t.out, ws: t.ws, timer: null, heard: t.heard }; armTail(); }   // el audio sigue un poco
    tell(t.ws, { ev: 'done', reply: t.reply });
    if (play) play.view = true;                            // con audio, la tele espera a que acabe de sonar
    else { v('done'); if (t.out === 'tv' || t.out === 'phone') tell(t.ws, { ev: 'silent' }); }
    t.finish({ ok: 1, reply: t.reply });
  }

  /** Sin ningún evento del Gateway en turnIdleMs, el turno se da por perdido y se libera `busy`. */
  function arm() {
    if (!turn) return;
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => { log.warn('talk: turno sin eventos'); fail(DOWN); }, turnIdleMs);
    if (turn.timer.unref) turn.timer.unref();
  }

  /** Formato de la tele para un turno nuevo: con vídeo en marcha, la isla; si no, el panel. */
  const viewMode = () => (media() === 1 ? 'island' : 'panel');

  /** Llamada a herramienta del turno en curso: ficha a la vista si la lleva; si no, solo su nombre al registro.
   *  @param {NonNullable<typeof turn>} t @param {any} ev */
  function onTool(t, ev) {
    if (t.maybeGhost) { (t.held || (t.held = [])).push(ev); return; }   // hasta saber si es el parado
    const id = String(ev.id || '').slice(0, TOOL_ID_MAX);
    if (!id) return;                                       // sin id no se puede cerrar su ficha
    if (ev.phase === 'start') {
      const lay = layoutOf(ev.name, ev.args);              // Jota elige el formato de la página que abre
      if (lay) v('agentLayout', lay.layout, lay.url);
      const card = toolCard(ev.name, ev.args);
      if (!card) { log.info('talk: herramienta sin ficha ' + toolName(ev.name)); return; }
      (t.cards || (t.cards = new Set())).add(id);
      v('tool', { id, ...card, ...(opensPage(ev.name, ev.args) ? { opens: true } : {}) });   // opens: pone otra página
    } else if (ev.phase === 'end' && t.cards && t.cards.has(id)) v('toolEnd', { id, ok: ev.ok === true });
  }

  /** El turno con `maybeGhost` es el nuestro (ya trae respuesta): sus herramientas retenidas van a la vista, en orden.
   *  @param {NonNullable<typeof turn>} t */
  function confirmTurn(t) {
    if (!t.maybeGhost) return;
    const held = t.held || [];
    t.maybeGhost = false; t.held = undefined;
    for (const ev of held) onTool(t, ev);
  }

  /** Eventos del Gateway de un turno por voz que aún no se ha enviado: frase parcial y final. @param {any} ev */
  function onVoice(ev) {
    const t = /** @type {NonNullable<typeof turn>} */ (turn);
    switch (ev.type) {
      case 'partial':
        tell(t.ws, { ev: 'partial', text: ev.text });
        v('you', ev.text, false);
        return;
      case 'final': {
        if (t.voice !== 'wait') return;                    // la final solo vale tras vend
        const text = String(ev.text || '').trim().slice(0, 1000);
        if (!text) return fail(NOT_HEARD);
        clearTimeout(t.waitTimer);
        t.voice = 'sent';
        tell(t.ws, { ev: 'final', text });
        v('you', text, true);
        t.sent = true; arm();
        gw.send(prefix(t.mode || 'full', t.who || '') + text);
        return;
      }
      case 'down': fail(DOWN); return;
      default: return;
    }
  }

  gw.on(ev => {
    // el turn_start del parado llega sin turno enviado esperándolo (parado sin más, o el nuevo aún graba): ya tiene id
    if (ev.type === 'turn_start' && ghostPending && !(turn && turn.sent)) { ghostPending = false; ghostId = ev.turnId; }
    if (tail) {                                            // el turno acabó, pero su audio aún puede llegar
      if (ev.type === 'audio' && ev.seq === tail.seq) { hear(tail, ev); route(tail.out, tail.ws, ev); armTail(); return; }
      if (ev.type === 'down') silence();
    }
    if (ev.type === 'final' && dropTimer) { clearTimeout(dropTimer); dropTimer = null; return; }   // la final de un turno cancelado
    if (turn && turn.voice && !turn.sent) return onVoice(ev);
    if (!turn || !turn.sent) return;                       // sin turno nuestro, o aún sin enviar (un push del Gateway): se ignora
    if (ghostId && ev.turnId === ghostId) return;          // lo que quede de un turno parado
    if (ev.type !== 'down' && ev.type !== 'turn_error' && !turn.turnId && ev.type !== 'turn_start') return;
    arm();
    switch (ev.type) {
      case 'turn_start':
        if (!turn.turnId) {
          turn.turnId = ev.turnId; turn.seq = ev.seq; if (turn.out === 'tv') spk('start');
          if (turn.out === 'tv' || turn.out === 'phone') voiceOn(turn.ws); else voiceOff();
          if (ghostPending) { ghostPending = false; turn.maybeGhost = true; }
        }
        return;
      case 'audio':
        if (!turn.turnId || turn.seq !== ev.seq) return;   // de otro turno
        hear(turn, ev);
        route(turn.out || 'none', turn.ws, ev);
        return;
      case 'token':
        if (turn.turnId !== ev.turnId) return;
        turn.reply += ev.text;                             // el token es un trozo: se acumula
        if (turn.reply) confirmTurn(turn);                 // antes que el texto: las fichas van delante de la respuesta
        tell(turn.ws, { ev: 'token', text: turn.reply });
        v('jota', turn.reply);
        voiceText(turn.reply);
        return;
      case 'tool':
        if (turn.turnId !== ev.turnId) return;
        onTool(turn, ev);
        return;
      case 'turn_end':
        if (turn.turnId !== ev.turnId) return;
        if (turn.maybeGhost && !turn.reply) {              // era el cierre del turno parado (sin respuesta): se sigue esperando el nuestro
          ghostId = turn.turnId; turn.turnId = null; turn.seq = undefined; turn.maybeGhost = false;
          turn.held = undefined;                           // sus herramientas no eran nuestras: nunca llegaron a la vista
          if (turn.heard) { turn.heard = false; silence(); }
          return;
        }
        end(); return;
      case 'turn_error': if (!turn.turnId || turn.turnId === ev.turnId) { log.warn('talk: turn_error'); fail(DOWN); } return;
      case 'down': fail(DOWN); return;
      default: return;
    }
  });

  /**
   * @param {any} text @param {any} ws @param {string} [mode] 'full' | 'guest' @param {string} [who] @param {any} [out] 'tv' | 'phone' | 'none'; sin él (API, MCP) no suena
   * @param {any} [interrupt] true: para el turno en vuelo o el habla de Jota (si puede) en vez de contestar BUSY
   * @returns {Promise<{ ok: 1, reply: string } | { error: string }>}
   */
  async function ask(text, ws, mode = 'full', who = '', out = 'none', interrupt = false) {
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return { error: 'mensaje vacío' };
    const busy = gate(ws, mode, interrupt); if (busy) return busy;
    /** @type {(r: object) => void} */ let finish = () => {};
    const result = new Promise(res => { finish = res; });
    const mine = turn = { ws, turnId: null, sent: /** @type {boolean} */ (false), reply: '', timer: null, finish, out: OUTS.includes(out) ? out : 'none' };
    silence();                                             // una respuesta anterior que aún suene se corta
    // la tele abre el intercambio ya, como vstart: un error al conectar va en él y no en la conversación anterior
    own(ws); v('turn', viewMode(), { voice: false }); v('you', text, true);
    let ok = false;
    try { ok = await gw.ensure(); } catch (e) { log.warn('talk: ensure con error', e); }
    if (turn !== mine) return /** @type {any} */ (result);   // el turno se cerró mientras se conectaba (down, stop)
    if (!ok) { fail(DOWN); return /** @type {any} */ (result); }
    mine.sent = true; arm();
    gw.send(prefix(mode, who) + text);
    return /** @type {any} */ (result);
  }

  /**
   * Empieza un turno por voz: ocupa `busy` desde ya y el audio que llegue (aunque ensure aún no haya terminado) va al Gateway.
   * @param {any} ws @param {any} out @param {string} mode @param {string} who @param {any} [interrupt] como en ask
   * @returns {Promise<{ ok: 1 } | { error: string }>}
   */
  async function vstart(ws, out, mode, who, interrupt = false) {
    const busy = gate(ws, mode, interrupt); if (busy) return busy;
    /** @type {(r: object) => void} */ let finish = () => {};
    const result = new Promise(res => { finish = res; });
    /** @type {NonNullable<typeof turn>} */
    const mine = turn = { ws, turnId: null, sent: false, reply: '', timer: null, finish, voice: 'rec', mode, who, out: OUTS.includes(out) ? out : 'tv' };
    silence();
    clearTimeout(dropTimer); dropTimer = null;             // la ventana de un turno cancelado no se come la final de este
    mine.cap = setTimeout(() => { if (turn === mine) { log.warn('talk: grabación sin fin'); cancel(); } }, maxVoiceMs);
    if (mine.cap.unref) mine.cap.unref();
    own(ws); v('turn', viewMode(), { voice: true });
    let ok = false;
    try { ok = await gw.ensure(); } catch (e) { log.warn('talk: ensure con error', e); }
    if (turn !== mine) return { ok: 1 };                   // cancelado o caído mientras se conectaba
    if (!ok) { fail(DOWN); return /** @type {any} */ (result); }
    return { ok: 1 };
  }

  /** @param {any} ws */
  function vend(ws) {
    const t = turn;
    if (!t || t.voice !== 'rec' || t.ws !== ws) return { error: 'no hay grabación' };
    t.voice = 'wait'; clearTimeout(t.cap);
    // trozos y pico (dBFS, como la compuerta de energía del Gateway, -45): 0 trozos = el móvil no manda; pico bajo = micro mudo
    t.waitTimer = setTimeout(() => { if (turn === t) { log.warn(`talk: sin final (${t.frames || 0} trozos, pico ${(t.peak ?? -Infinity).toFixed(1)} dBFS)`); fail(NOT_HEARD); } }, finalMs);
    if (t.waitTimer.unref) t.waitTimer.unref();
    gw.end();
    return { ok: 1 };
  }

  /** Nombre que va en las instrucciones de un invitado. @param {any} dev */
  const who = dev => (dev && dev.role !== 'admin' ? dev.name : '');

  return {
    ask,
    /** Un mando se conecta: si es el móvil del intercambio que se ve (otra conexión del mismo dispositivo), pasa a ser el
     *  del intercambio y recibe el formato de la capa, para volver a pintar su control de ampliar / hacer píldora.
     *  @param {any} ws @returns {object[]} mensajes que mandarle al conectarse */
    greet(ws) {
      if (!viewWs || viewWs === ws || !sameDev(viewWs, ws)) return [];
      viewWs = ws;
      const f = typeof view.form === 'function' ? view.form() : null;
      return f && f.canSwitch ? [{ t: 'talk', ev: 'form', form: f.form, canSwitch: true }] : [];
    },
    busy: () => !!turn,
    /** Jota sigue hablando la respuesta (en la tele o en el móvil). */
    speaking: () => !!play,
    /** Audio del mando: solo el del socket que hizo vstart y mientras graba; lo demás se descarta. */
    onBinary(/** @type {Buffer} */ buf, /** @type {any} */ ws) {
      if (!turn || turn.voice !== 'rec' || turn.ws !== ws) return;
      const db = dbfs(buf);
      turn.frames = (turn.frames || 0) + 1; turn.peak = Math.max(turn.peak ?? -Infinity, db);
      v('level', db);                                   // el orbe de la tele sigue la voz (un trozo cada 100 ms)
      gw.audio(buf);
    },
    /** El mando se fue: si estaba grabando o esperando la final, se cancela el turno. */
    onClose(/** @type {any} */ ws) { if (turn && turn.ws === ws && (turn.voice === 'rec' || turn.voice === 'wait')) cancel(); },
    /** @type {import('../transport/commands').Command[]} */
    commands: [
      { t: 'vstart', perm: 'agent', run: (m, { ws, dev, P }) => vstart(ws, m.out, P.agent, who(dev), m.interrupt) },
      { t: 'vend', perm: 'agent', run: (_m, { ws }) => vend(ws) },
      { t: 'vcancel', perm: 'agent', run: (_m, { ws }) => { if (turn && turn.ws === ws && (turn.voice === 'rec' || turn.voice === 'wait')) cancel(); return { ok: 1 }; } },
      { t: 'ask', perm: 'agent', run: (m, { ws, dev, P }) => ask(m.text, ws, P.agent, who(dev), m.out, m.interrupt) },
      // Parar: el turno en vuelo (cancel al Gateway) y el audio, y la tele se limpia ya
      { t: 'stop', perm: 'agent', run: (_m, { ws, P }) => { if (!may(ws, P.agent)) return { error: BUSY }; halt(); v('hide'); return { ok: 1 }; } },
      // Quitar de la tele: solo la vista
      { t: 'hide', perm: 'agent', run: () => { v('hide'); return { ok: 1 }; } },
      // Ampliar en la tele / hacer píldora: quien puede parar (el móvil que preguntó, también reconectado, o
      // el agente completo). El evento `form` (que pinta el control) va al móvil del intercambio, como `hidden`
      { t: 'talkform', perm: 'agent', run: (m, { ws, P }) => {
        if (!may(ws, P.agent)) return { error: BUSY };
        if (typeof view.userForm !== 'function') return { error: NO_FORMS };
        return view.userForm(m.form);
      } },
    ],
  };
};
module.exports.prompts = prompts;
