'use strict';
// @ts-check
// Capacidad «talk»: hablar con Jota por el J Gateway. Lo escrito en el mando (orden `ask`) va al Gateway y la respuesta
// vuelve en directo, palabra a palabra, por el mismo WebSocket del mando que preguntó (`{t:'talk', ev}`). Un turno a la vez
// en toda la pantalla. Admin: instrucciones completas; invitados: instrucciones que les impiden tocar nada personal del
// dueño (TV_OWNER, si se da). La capa de la tele (`view`) pinta lo mismo en la pantalla; `speaker` llega con la voz (tarea 5).
const { WebSocket } = require('ws');

const DOWN = 'Jota no está disponible.';
const BUSY = 'Sigo con la petición anterior. Espera un momento.';

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

/**
 * @param {{
 *   gw: { ensure: () => Promise<boolean>, send: (t: string) => void, on: (fn: (ev: any) => void) => () => void },
 *   cfg: { NAME: string, OWNER?: string }, media: () => number,
 *   view?: { turn: (mode: 'island' | 'panel') => void, you: (t: string, final: boolean) => void, jota: (t: string) => void, done: () => void, error: (t: string) => void },
 *   speaker?: any, log?: { info: Function, warn: Function }, finalMs?: number, turnIdleMs?: number,
 * }} deps
 */
module.exports = function createTalk({ gw, cfg, media, view = NO_VIEW, log = { info() {}, warn() {} }, turnIdleMs = 150000 }) {
  const { askPrefix: ASK_PREFIX, askGuest: ASK_GUEST } = prompts(cfg.NAME, cfg.OWNER);
  /** El turno en curso: quién preguntó, el id que le da el Gateway (tras turn_start) y la respuesta acumulada.
   *  `sent`: ya se llamó a gw.send; hasta entonces ningún turn_start puede ser el nuestro (un push).
   *  @type {null | { ws: any, turnId: string | null, sent: boolean, reply: string, timer: any, finish: (r: object) => void }} */
  let turn = null;

  /** @param {any} ws @param {object} o */
  const tell = (ws, o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'talk', ...o })); };

  /** Cierra el turno en curso con un error (el Gateway cae, rechaza el turno o no está). @param {string} text */
  function fail(text) {
    const t = turn; if (!t) return;
    turn = null; clearTimeout(t.timer);
    tell(t.ws, { ev: 'error', error: text });
    try { view.error(text); } catch (e) { log.warn('talk: vista con error', e); }
    t.finish({ error: text });
  }

  function end() {
    const t = turn; if (!t) return;
    turn = null; clearTimeout(t.timer);
    if (!t.reply) { tell(t.ws, { ev: 'error', error: 'sin respuesta del agente' }); try { view.error('sin respuesta del agente'); } catch (e) { log.warn('talk: vista con error', e); } return t.finish({ error: 'sin respuesta del agente' }); }
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

  gw.on(ev => {
    if (!turn || !turn.sent) return;                       // sin turno nuestro, o aún sin enviar (un push del Gateway): se ignora
    if (ev.type !== 'down' && ev.type !== 'turn_error' && !turn.turnId && ev.type !== 'turn_start') return;
    arm();
    switch (ev.type) {
      case 'turn_start': if (!turn.turnId) turn.turnId = ev.turnId; return;
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
   * @param {any} text @param {any} ws @param {string} [mode] 'full' | 'guest' @param {string} [who]
   * @returns {Promise<{ ok: 1, reply: string } | { error: string }>}
   */
  async function ask(text, ws, mode = 'full', who = '') {
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return { error: 'mensaje vacío' };
    if (turn) return { error: BUSY };
    /** @type {(r: object) => void} */ let finish = () => {};
    const result = new Promise(res => { finish = res; });
    const mine = turn = { ws, turnId: null, sent: /** @type {boolean} */ (false), reply: '', timer: null, finish };
    let ok = false;
    try { ok = await gw.ensure(); } catch (e) { log.warn('talk: ensure con error', e); }
    if (turn !== mine) return /** @type {any} */ (result);   // el turno se cerró mientras se conectaba (down)
    if (!ok) { fail(DOWN); return /** @type {any} */ (result); }
    try { view.turn(media() === 1 ? 'island' : 'panel'); view.you(text, true); } catch (e) { log.warn('talk: vista con error', e); }
    mine.sent = true; arm();
    gw.send((mode === 'full' ? ASK_PREFIX : ASK_GUEST + (who ? `(Se llama ${who}.) ` : '')) + text);
    return /** @type {any} */ (result);
  }

  return {
    ask,
    busy: () => !!turn,
    onBinary(/** @type {Buffer} */ _buf, /** @type {any} */ _ws) {},   // el audio del mando llega en la tarea 3
    onClose(/** @type {any} */ _ws) {},
    /** @type {import('../transport/commands').Command[]} */
    commands: [
      { t: 'ask', perm: 'agent', run: (m, { ws, dev, P }) => ask(m.text, ws, P.agent, dev && dev.role !== 'admin' ? dev.name : '') },
    ],
  };
};
module.exports.prompts = prompts;
