'use strict';
// @ts-check
// Capa de la conversación en la tele: lo que dices y lo que contesta Jota, en directo, encima de cualquier página.
// Dos formatos, fijados al empezar el turno: `island` (hay vídeo: arriba en el centro, solo la frase y la respuesta) y
// `panel` (columna a la derecha con las últimas `keep` frases). La página recibe public/tv-talk.js una sola vez: la
// primera llamada lleva la fuente (con los tokens delante, src/tv/tokens.js) y las siguientes solo `TVTalk.render(…)`.
// Si la página cambia, la llamada corta devuelve false (no hay TVTalk) y se repite al momento con la fuente; server.js
// también avisa con reset() al navegar o al cambiar de pestaña. Ese reintento es uno por página (hasta reset o un render
// bueno): una web donde TVTalk no llega a existir no recibe la fuente entera cada 100 ms. Se oculta `hideMs` después de done o error.
const { talkSource } = require('./tokens');

const DIM_ON = 'window.TVIsland&&window.TVIsland.dim(0)';
// la isla de actividades vuelve a 1 aunque hide falle
const HIDE = 'try{window.TVTalk&&window.TVTalk.hide()}finally{window.TVIsland&&window.TVIsland.dim(1)}';

/**
 * @param {{ cdp: { session?: any, call: (method: string, params: object) => Promise<any> }, pub: string,
 *           batchMs?: number, hideMs?: number, keep?: number, log?: (msg: string) => void }} deps
 */
function createTalkView({ cdp, pub, batchMs = 100, hideMs = 8000, keep = 6, log = () => {} }) {
  /** @type {{ you: string, jota: string }[]} */
  let history = [];
  let cur = { you: '', jota: '' };
  /** @type {'island' | 'panel'} */
  let mode = 'panel';
  let live = false;
  let open = false;      // hay un intercambio en curso (entre turn y done/error)
  let shown = false;     // la capa está (o va a estar) en pantalla
  let injected = false;  // la página actual ya tiene window.TVTalk (según lo último que sabemos)
  let retried = false;   // ya se reenvió la fuente tras un render sin TVTalk (una vez por página: hasta reset o un render bueno)
  let batchT = null, hideT = null;

  const src = () => { try { return talkSource(pub); } catch (e) { log('conversación: ' + e.message); return ''; } };

  function lines() {
    if (mode === 'island') return [{ who: 'you', text: cur.you }, { who: 'jota', text: cur.jota }].filter(l => l.text);
    const all = [];
    for (const x of [...history, cur]) { if (x.you) all.push({ who: 'you', text: x.you }); if (x.jota) all.push({ who: 'jota', text: x.jota }); }
    return all.slice(-keep);
  }

  function schedule() {
    shown = true;
    if (!batchT) batchT = setTimeout(flush, batchMs);
  }
  /** @param {boolean} [retry] la llamada corta dijo que la página no tiene TVTalk */
  function flush(retry) {
    batchT = null;
    if (!cdp.session) return;
    const inj = !injected || retry === true;
    const s = inj ? src() : '';
    if (inj && !s) return;
    const expr = `(()=>{${s ? s + '\n;' : ''}if(!window.TVTalk)return false;window.TVTalk.render(${JSON.stringify({ mode, lines: lines(), live })});${DIM_ON};return true})()`;
    if (inj) injected = true;
    cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
      const v = r?.result?.value;
      if (v === true && !inj) retried = false;
      if (v !== false || inj || retried) return;
      retried = true; // página nueva sin aviso: se repite ya con la fuente, una sola vez
      if (shown) flush(true);
    }).catch(() => { injected = false; });
  }
  function hide() {
    hideT = null;
    clearTimeout(batchT); batchT = null;
    shown = false;
    if (!cdp.session) return;
    cdp.call('Runtime.evaluate', { expression: HIDE }).catch(() => {});
  }
  /** @param {'island' | 'panel'} m */
  function begin(m) {
    clearTimeout(hideT); hideT = null;
    if (cur.you || cur.jota) history = [...history, cur].slice(-keep); // un turno cancelado sin nada no se guarda
    cur = { you: '', jota: '' };
    mode = m === 'island' ? 'island' : 'panel';
    live = true; open = true;
  }
  function end() {
    live = false; open = false;
    schedule();
    clearTimeout(hideT);
    hideT = setTimeout(hide, hideMs);
  }

  return {
    /** @param {'island' | 'panel'} m */
    turn(m) { begin(m); schedule(); },
    /** @param {string} text frase acumulada (sustituye a la anterior) @param {boolean} final */
    you(text, final) { if (!open) begin(mode); cur.you = String(text || ''); schedule(); },
    /** @param {string} text respuesta acumulada */
    jota(text) { if (!open) begin(mode); cur.jota = String(text || ''); schedule(); },
    done() { end(); },
    /** @param {string} text va en el hueco de la respuesta (sin turn() abierto, en un intercambio nuevo con el último formato) */
    error(text) { if (!open) begin(mode); cur.jota = String(text || ''); end(); },
    /** La pestaña cambió (navegación, otra pestaña, CDP reconectado): la próxima llamada lleva la fuente. */
    reset() {
      injected = false; retried = false;
      if (shown) schedule();
    },
  };
}

module.exports = { createTalkView, HIDE };
