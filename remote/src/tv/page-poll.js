'use strict';
// @ts-check
// Sondeo de la página: multimedia (reproduciendo / pausa), posición de scroll y reproducción de verdad (`playback`).
// Con algún mando conectado, cada 1,5 s; durante 2 s tras cada scroll del mando, cada 250 ms. Mientras la capa del agente
// está en pantalla, cada 250 ms aunque no haya mandos: de ahí sale el paso del panel a la píldora.
// Nunca dos lecturas a la vez por CDP.
const { PAGE_PROBE, parseProbe, parsePlayback, createPlaybackWatch } = require('./devices');

const SLOW_MS = 1500;   // con mandos y nada más
const FAST_MS = 250;    // tras un scroll del mando, o con la capa del agente en pantalla
const FAST_FOR_MS = 2000;

/**
 * @param {{ cdp: { ready: boolean, session: string | null, call: Function }, state: any, broadcast: () => void,
 *           watched: () => boolean, active?: () => boolean, onPlayback?: (on: boolean) => void, dwellMs?: number }} o
 *   watched: ¿hay algún mando conectado?  active: ¿la capa del agente está en pantalla?  onPlayback: cambió `state.playback`
 */
function createPagePoll({ cdp, state, broadcast, watched, active = () => false, onPlayback = () => {}, dwellMs }) {
  let busy = false, last = 0, fastUntil = 0, timer = null;
  const pb = createPlaybackWatch({ dwellMs });
  if (state.playback === undefined) state.playback = false;
  /** @param {boolean} on */
  function setPlayback(on) {
    if (state.playback === on) return;
    state.playback = on;
    try { onPlayback(on); } catch {}
  }
  async function poll() {
    if (busy || !(watched() || active()) || !cdp.ready || !cdp.session) return;
    busy = true; last = Date.now();
    try {
      const r = await cdp.call('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true });
      const v = r?.result?.value;
      const pr = parseProbe(v);
      if (!pr) return;
      setPlayback(pb.update(parsePlayback(v), Date.now()));
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
    soon() { fastUntil = Date.now() + FAST_FOR_MS; },
    /** otra página u otra pestaña (o Chrome caído): la reproducción se vuelve a medir desde cero */
    reset() { pb.reset(); setPlayback(false); },
    start() {
      timer = setInterval(() => {
        const now = Date.now();
        if (now - last >= (now < fastUntil || active() ? FAST_MS : SLOW_MS)) poll();
      }, FAST_MS);
    },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createPagePoll, SLOW_MS, FAST_MS };
