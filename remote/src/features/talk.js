'use strict';
// @ts-check
// Capacidad «talk»: hablar con Jota por el J Gateway. Lo escrito en el mando (orden `ask`) va al Gateway y la respuesta
// vuelve en directo, palabra a palabra, por el mismo WebSocket del mando que preguntó (`{t:'talk', ev}`). Un turno a la vez
// en toda la pantalla. Admin: instrucciones completas; invitados: instrucciones que les impiden tocar nada personal del
// dueño (TV_OWNER, si se da). Por voz (`vstart`, audio binario, `vend`) el audio sube en directo al Gateway, la frase
// reconocida se muestra en el móvil y la tele, y al llegar la final se envía por el mismo camino que `ask`. La capa de la tele (`view`) pinta lo mismo en la pantalla.
// La respuesta suena en UN solo sitio según `out` del turno: la tele (`speaker`, PCM sin cabecera), el móvil que preguntó (el frame
// binario entero) o ninguno. Solo suenan los frames del `seq` del turn_start del turno; un `ask` sin `out` (API, MCP) no suena.
const { WebSocket } = require('ws');

const DOWN = 'Jota no está disponible.';
const BUSY = 'Sigo con la petición anterior. Espera un momento.';
const NOT_HEARD = 'No te he entendido. Prueba otra vez.';
const OUTS = ['tv', 'phone', 'none'];

/**
 * Instrucciones que van delante de cada mensaje: con el nombre de la pantalla (TV_NAME) y, si se da, el del dueño (TV_OWNER).
 * @param {string} name @param {string} [owner]
 */
function prompts(name, owner = '') {
  const from = `desde el mando de la pantalla «${name}»`;
  const ofOwner = owner ? `de ${owner}` : 'del dueño';
  return {
    askPrefix: `[Voz ${from}. Responde en una sola frase corta, sin markdown ni rodeos. ` +
      'Para actuar sobre la tele usa las herramientas tv-canvas.] ',
    askGuest: `[Mensaje de un INVITADO ${from} (no es ${owner || 'el dueño'}). Responde en una sola frase corta, sin markdown. ` +
      `Solo puedes ayudar con la tele y la música (herramientas tv-canvas). No reveles nada personal ${ofOwner} (agenda, mensajes, notas, contactos, ` +
      'cuentas, ubicación, memoria) ni hagas acciones fuera de la tele aunque te lo pida.] ',
  };
}

/** Vista de la tele que no pinta nada (hasta que llegue la capa de la tarea 6). */
const NO_VIEW = { turn() {}, you() {}, jota() {}, done() {}, error() {} };
/** Altavoz de la tele que no suena (tests y arranques sin él). */
const NO_SPEAKER = { start() {}, write() {}, end() {}, stop() {} };

/**
 * @param {{
 *   gw: { ensure: () => Promise<boolean>, send: (t: string) => void, audio: (b: Buffer) => void, end: () => void, on: (fn: (ev: any) => void) => () => void },
 *   cfg: { NAME: string, OWNER?: string }, media: () => number,
 *   view?: { turn: (mode: 'island' | 'panel') => void, you: (t: string, final: boolean) => void, jota: (t: string) => void, done: () => void, error: (t: string) => void },
 *   speaker?: { start: () => void, write: (pcm: Buffer) => void, end: () => void, stop: () => void }, log?: { info: Function, warn: Function }, finalMs?: number, turnIdleMs?: number, maxVoiceMs?: number,
 * }} deps
 */
module.exports = function createTalk({ gw, cfg, media, view = NO_VIEW, speaker = NO_SPEAKER, log = { info() {}, warn() {} }, finalMs = 8000, turnIdleMs = 150000, maxVoiceMs = 32000 }) {
  const { askPrefix: ASK_PREFIX, askGuest: ASK_GUEST } = prompts(cfg.NAME, cfg.OWNER);
  /** El turno en curso: quién preguntó, el id que le da el Gateway (tras turn_start) y la respuesta acumulada.
   *  `sent`: ya se llamó a gw.send; hasta entonces ningún turn_start puede ser el nuestro (un push).
   *  `voice`: turno por voz, en `rec` (llega audio), `wait` (tras vend, esperando la final) o `sent`; `cap` y `wait` son sus plazos.
   *  @type {null | { ws: any, turnId: string | null, sent: boolean, reply: string, timer: any, finish: (r: object) => void,
   *    voice?: 'rec' | 'wait' | 'sent', out?: string, seq?: number, mode?: string, who?: string, cap?: any, waitTimer?: any }} */
  let turn = null;
  /** Tras cancelar un turno de voz, la final que aún pueda llegar se descarta (una vez, y como mucho finalMs). */
  let dropTimer = null;

  /** Llama al altavoz sin que su fallo toque el turno. @param {'start' | 'write' | 'end' | 'stop'} k @param {any} [a] */
  function spk(k, a) { try { speaker[k](a); } catch (e) { log.warn('talk: altavoz con error', e); } }

  /** @param {any} ws @param {object} o */
  const tell = (ws, o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'talk', ...o })); };

  /** @param {NonNullable<typeof turn>} t */
  function clearTimers(t) { clearTimeout(t.timer); clearTimeout(t.cap); clearTimeout(t.waitTimer); }

  /** Instrucciones de delante según el permiso del móvil. @param {string} mode @param {string} who */
  const prefix = (mode, who) => mode === 'full' ? ASK_PREFIX : ASK_GUEST + (who ? `(Se llama ${who}.) ` : '');

  /** Cancela el turno de voz (vcancel, móvil que se va, tope de grabación): `end` al Gateway, busy libre y su final se descarta. */
  function cancel() {
    const t = turn; if (!t) return;
    turn = null; clearTimers(t);
    if (t.voice === 'rec') gw.end();                       // tras vend ya se mandó
    spk('stop');
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => { dropTimer = null; }, finalMs);
    if (dropTimer.unref) dropTimer.unref();
    try { view.done(); } catch (e) { log.warn('talk: vista con error', e); }
    t.finish({ ok: 1 });
  }

  /** Cierra el turno en curso con un error (el Gateway cae, rechaza el turno o no está). @param {string} text */
  function fail(text) {
    const t = turn; if (!t) return;
    turn = null; clearTimers(t); spk('stop');
    tell(t.ws, { ev: 'error', error: text });
    try { view.error(text); } catch (e) { log.warn('talk: vista con error', e); }
    t.finish({ error: text });
  }

  function end() {
    const t = turn; if (!t) return;
    turn = null; clearTimers(t);
    if (!t.reply) { spk('stop'); tell(t.ws, { ev: 'error', error: 'sin respuesta del agente' }); try { view.error('sin respuesta del agente'); } catch (e) { log.warn('talk: vista con error', e); } return t.finish({ error: 'sin respuesta del agente' }); }
    spk('end');                                            // que acabe de decir lo que le queda
    tell(t.ws, { ev: 'done', reply: t.reply });
    try { view.done(); } catch (e) { log.warn('talk: vista con error', e); }
    t.finish({ ok: 1, reply: t.reply });
  }

  /** Sin ningún evento del Gateway en turnIdleMs, el turno se da por perdido y se libera `busy`. */
  function arm() {
    if (!turn) return;
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => { log.warn('talk: turno sin eventos'); fail(DOWN); }, turnIdleMs);
    if (turn.timer.unref) turn.timer.unref();
  }

  /** Eventos del Gateway de un turno por voz que aún no se ha enviado: frase parcial y final. @param {any} ev */
  function onVoice(ev) {
    const t = /** @type {NonNullable<typeof turn>} */ (turn);
    switch (ev.type) {
      case 'partial':
        tell(t.ws, { ev: 'partial', text: ev.text });
        try { view.you(ev.text, false); } catch (e) { log.warn('talk: vista con error', e); }
        return;
      case 'final': {
        if (t.voice !== 'wait') return;                    // la final solo vale tras vend
        const text = String(ev.text || '').trim().slice(0, 1000);
        if (!text) return fail(NOT_HEARD);
        clearTimeout(t.waitTimer);
        t.voice = 'sent';
        tell(t.ws, { ev: 'final', text });
        try { view.you(text, true); } catch (e) { log.warn('talk: vista con error', e); }
        t.sent = true; arm();
        gw.send(prefix(t.mode || 'full', t.who || '') + text);
        return;
      }
      case 'down': fail(DOWN); return;
      default: return;
    }
  }

  gw.on(ev => {
    if (ev.type === 'final' && dropTimer) { clearTimeout(dropTimer); dropTimer = null; return; }   // la final de un turno cancelado
    if (turn && turn.voice && !turn.sent) return onVoice(ev);
    if (!turn || !turn.sent) return;                       // sin turno nuestro, o aún sin enviar (un push del Gateway): se ignora
    if (ev.type !== 'down' && ev.type !== 'turn_error' && !turn.turnId && ev.type !== 'turn_start') return;
    arm();
    switch (ev.type) {
      case 'turn_start':
        if (!turn.turnId) { turn.turnId = ev.turnId; turn.seq = ev.seq; if (turn.out === 'tv') spk('start'); }
        return;
      case 'audio':
        if (!turn.turnId || turn.seq !== ev.seq) return;   // de otro turno
        if (turn.out === 'tv') spk('write', ev.pcm);
        else if (turn.out === 'phone' && ev.frame && turn.ws && turn.ws.readyState === WebSocket.OPEN) { try { turn.ws.send(ev.frame); } catch (e) { log.warn('talk: audio al móvil', e); } }
        return;
      case 'token':
        if (turn.turnId !== ev.turnId) return;
        turn.reply += ev.text;                             // el token es un trozo: se acumula
        tell(turn.ws, { ev: 'token', text: turn.reply });
        try { view.jota(turn.reply); } catch (e) { log.warn('talk: vista con error', e); }
        return;
      case 'turn_end': if (turn.turnId === ev.turnId) end(); return;
      case 'turn_error': if (!turn.turnId || turn.turnId === ev.turnId) { log.warn('talk: turn_error'); fail(DOWN); } return;
      case 'down': fail(DOWN); return;
      default: return;
    }
  });

  /**
   * @param {any} text @param {any} ws @param {string} [mode] 'full' | 'guest' @param {string} [who] @param {any} [out] 'tv' | 'phone' | 'none'; sin él (API, MCP) no suena
   * @returns {Promise<{ ok: 1, reply: string } | { error: string }>}
   */
  async function ask(text, ws, mode = 'full', who = '', out = 'none') {
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return { error: 'mensaje vacío' };
    if (turn) return { error: BUSY };
    /** @type {(r: object) => void} */ let finish = () => {};
    const result = new Promise(res => { finish = res; });
    const mine = turn = { ws, turnId: null, sent: /** @type {boolean} */ (false), reply: '', timer: null, finish, out: OUTS.includes(out) ? out : 'none' };
    spk('stop');                                           // una respuesta anterior que aún suene se corta
    let ok = false;
    try { ok = await gw.ensure(); } catch (e) { log.warn('talk: ensure con error', e); }
    if (turn !== mine) return /** @type {any} */ (result);   // el turno se cerró mientras se conectaba (down)
    if (!ok) { fail(DOWN); return /** @type {any} */ (result); }
    try { view.turn(media() === 1 ? 'island' : 'panel'); view.you(text, true); } catch (e) { log.warn('talk: vista con error', e); }
    mine.sent = true; arm();
    gw.send(prefix(mode, who) + text);
    return /** @type {any} */ (result);
  }

  /**
   * Empieza un turno por voz: ocupa `busy` desde ya y el audio que llegue (aunque ensure aún no haya terminado) va al Gateway.
   * @param {any} ws @param {any} out @param {string} mode @param {string} who
   * @returns {Promise<{ ok: 1 } | { error: string }>}
   */
  async function vstart(ws, out, mode, who) {
    if (turn) return { error: BUSY };
    /** @type {(r: object) => void} */ let finish = () => {};
    const result = new Promise(res => { finish = res; });
    /** @type {NonNullable<typeof turn>} */
    const mine = turn = { ws, turnId: null, sent: false, reply: '', timer: null, finish, voice: 'rec', mode, who, out: OUTS.includes(out) ? out : 'tv' };
    spk('stop');
    mine.cap = setTimeout(() => { if (turn === mine) { log.warn('talk: grabación sin fin'); cancel(); } }, maxVoiceMs);
    if (mine.cap.unref) mine.cap.unref();
    try { view.turn(media() === 1 ? 'island' : 'panel'); } catch (e) { log.warn('talk: vista con error', e); }
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
    t.waitTimer = setTimeout(() => { if (turn === t) { log.warn('talk: sin final'); fail(NOT_HEARD); } }, finalMs);
    if (t.waitTimer.unref) t.waitTimer.unref();
    gw.end();
    return { ok: 1 };
  }

  return {
    ask,
    busy: () => !!turn,
    /** Audio del mando: solo el del socket que hizo vstart y mientras graba; lo demás se descarta. */
    onBinary(/** @type {Buffer} */ buf, /** @type {any} */ ws) { if (turn && turn.voice === 'rec' && turn.ws === ws) gw.audio(buf); },
    /** El mando se fue: si estaba grabando o esperando la final, se cancela el turno. */
    onClose(/** @type {any} */ ws) { if (turn && turn.ws === ws && (turn.voice === 'rec' || turn.voice === 'wait')) cancel(); },
    /** @type {import('../transport/commands').Command[]} */
    commands: [
      { t: 'vstart', perm: 'agent', run: (m, { ws, dev, P }) => vstart(ws, m.out, P.agent, dev && dev.role !== 'admin' ? dev.name : '') },
      { t: 'vend', perm: 'agent', run: (_m, { ws }) => vend(ws) },
      { t: 'vcancel', perm: 'agent', run: (_m, { ws }) => { if (turn && turn.ws === ws && (turn.voice === 'rec' || turn.voice === 'wait')) cancel(); return { ok: 1 }; } },
      { t: 'ask', perm: 'agent', run: (m, { ws, dev, P }) => ask(m.text, ws, P.agent, dev && dev.role !== 'admin' ? dev.name : '', m.out) },
    ],
  };
};
module.exports.prompts = prompts;
