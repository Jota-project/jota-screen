'use strict';
// @ts-check
// Capacidad «tele»: la tele Google TV por ADB. Sondea encendido, entrada y volumen (cada 3 s con mandos, 15 s sin ellos),
// da las órdenes power, src y tvkey (sin permiso: también invitados) y aplica las reglas del diseño:
//   - al encenderse la tele (off → on, también con el mando original) va a J-Screen una sola vez;
//   - al apagar o pasar a Tele se pausa lo que suena en J-Screen;
//   - las órdenes que necesitan la pantalla esperan antes a ver J-Screen delante (ensureJ, como mucho 6 s).
const { TV_KEYS } = require('../tv/android-tv');

const WATCHED_MS = 3000, IDLE_MS = 15000;
const ENSURE_MS = 6000, ENSURE_STEP_MS = 500;
const QUIET_KEYS = new Set(['up', 'down', 'left', 'right', 'ok']); // la cruceta va a ráfagas: sin lectura tras cada una
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {{ tv: ReturnType<typeof import('../tv/android-tv').createAndroidTv>, state: any, broadcast: () => void,
 *           watched: () => boolean, pause: () => Promise<void>, log: { info: (m: string) => void } }} o
 *   watched: ¿hay algún mando conectado?  pause: para el vídeo de la página y Spotify (los errores no cuentan)
 */
module.exports = function createTele({ tv, state, broadcast, watched, pause, log }) {
  state.tv = { power: null, src: null };
  let lastPower = null; // último encendido conocido (sin null): de él sale el salto a J-Screen
  let own = false;      // el encendido lo pedimos nosotros (power o ensureJ), que ya van a J-Screen

  async function read() {
    const before = JSON.stringify([state.tv, state.vol, state.muted]);
    try {
      const s = await tv.status();
      state.tv = { power: s.power, src: s.src };
      if (s.vol !== null) { state.vol = s.vol; state.muted = s.muted; }
    } catch { state.tv = { power: null, src: null }; }
    const p = state.tv.power;
    if (p !== null) {
      if (lastPower === 'off' && p === 'on' && !own) {
        log.info('tele: encendida, a J-Screen');
        tv.toJ().catch(() => {});
      }
      if (p === 'on') own = false;
      lastPower = p;
    }
    if (JSON.stringify([state.tv, state.vol, state.muted]) !== before) broadcast();
  }
  // nunca dos lecturas a la vez, y cada una empieza después de lo que la pidió
  let chain = Promise.resolve();
  const readNow = () => (chain = chain.then(read));

  function tick() {
    readNow().then(() => { setTimeout(tick, watched() ? WATCHED_MS : IDLE_MS).unref?.(); });
  }

  /** Hace `fn`, lee el estado al momento y devuelve la tele o el error. */
  async function act(/** @type {() => Promise<any>} */ fn, readAfter = true) {
    try { await fn(); } catch (e) {
      if (readAfter) await readNow();
      return { error: /** @type {Error} */ (e).message };
    }
    if (readAfter) await readNow();
    return { tv: state.tv };
  }
  const quietPause = () => pause().catch(() => {});

  /** @param {boolean} on */
  function power(on) {
    return act(async () => {
      if (!on) await quietPause();
      own = on;
      try { await tv.power(on); } catch (e) { own = false; throw e; }
    });
  }
  /** @param {'j'|'tv'} s */
  function src(s) {
    return act(async () => {
      if (s === 'tv') { await quietPause(); await tv.toTv(); } else await tv.toJ();
    });
  }

  /** Enciende o vuelve a J-Screen si hace falta y espera a verlo (como mucho 6 s). */
  async function ensureJ() {
    const ok = () => state.tv.power === 'on' && state.tv.src === 'j';
    if (ok()) return true;
    try {
      if (state.tv.power === 'off') { own = true; await tv.power(true); } else if (state.tv.src === 'tv') await tv.toJ();
    } catch { own = false; }
    for (const end = Date.now() + ENSURE_MS; Date.now() < end;) {
      await sleep(ENSURE_STEP_MS);
      await readNow();
      if (ok()) return true;
    }
    return false;
  }

  /**
   * Envuelve las órdenes que necesitan la pantalla: antes de su run, J-Screen delante. La orden se hace igual si no llega.
   * @param {import('../transport/commands').Command[]} cmds
   * @param {Set<string>} types  `t` de la orden, o `t:op` si solo cuenta con esa op (p. ej. 'netflix:open')
   * @returns {import('../transport/commands').Command[]}
   */
  function withScreen(cmds, types) {
    return cmds.map(c => (types.has(c.t) || [...types].some(x => x.startsWith(c.t + ':')) ? { ...c, run: async (m, ctx) => {
      const needs = types.has(m.t) || types.has(m.t + ':' + m.op);
      // con la tele sin responder (null) no se espera: la orden va directa
      if (needs && (state.tv.power === 'off' || state.tv.src === 'tv') && !(await ensureJ())) log.info('tele: no llegó a J-Screen a tiempo');
      return c.run(m, ctx);
    } } : c));
  }

  /** @type {import('../transport/commands').Command[]} */
  const commands = [
    { t: 'power', run: m => power(!!m.on) },
    { t: 'src', run: m => src(m.s === 'tv' ? 'tv' : 'j') },
    { t: 'tvkey', run: m => {
      const k = m.k;
      if (typeof k !== 'string' || !Object.hasOwn(TV_KEYS, k)) return { error: 'tecla no válida' };
      return act(() => tv.key(/** @type {keyof typeof TV_KEYS} */ (k)), !QUIET_KEYS.has(k));
    } },
  ];

  return { start: tick, ensureJ, withScreen, commands };
};
