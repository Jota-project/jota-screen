'use strict';
// @ts-check
// Sondeo de la página: multimedia (reproduciendo / pausa) y posición de scroll, solo si hay alguien conectado.
// Cada 1,5 s; durante 2 s tras cada scroll del mando, cada 250 ms. Nunca dos lecturas a la vez por CDP.
const { PAGE_PROBE, parseProbe } = require('./devices');

/**
 * @param {{ cdp: { ready: boolean, session: string | null, call: Function }, state: any, broadcast: () => void,
 *           watched: () => boolean }} o   watched: ¿hay algún mando conectado?
 */
function createPagePoll({ cdp, state, broadcast, watched }) {
  let busy = false, last = 0, fastUntil = 0, timer = null;
  async function poll() {
    if (busy || !watched() || !cdp.ready || !cdp.session) return;
    busy = true; last = Date.now();
    try {
      const r = await cdp.call('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true });
      const pr = parseProbe(r?.result?.value);
      if (!pr) return;
      let ch = false;
      if (pr.media !== null && pr.media !== state.media) { state.media = pr.media; ch = true; }
      const sc = pr.scroll;                                       // sin scroll (o sin dato): null y el mando no pinta el carril
      if (JSON.stringify(sc) !== JSON.stringify(state.scroll)) { state.scroll = sc; ch = true; }
      if (ch) broadcast();
    } catch {} finally { busy = false; }
  }
  return {
    poll,
    /** el mando ha hecho scroll: el carril se sondea más a menudo un rato */
    soon() { fastUntil = Date.now() + 2000; },
    start() { timer = setInterval(() => { const now = Date.now(); if (now - last >= (now < fastUntil ? 250 : 1500)) poll(); }, 250); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createPagePoll };
