'use strict';
// @ts-check
// Capacidad «tele»: la tele Google TV por ADB. Sondea encendido, entrada y volumen (cada 3 s con mandos, 15 s sin ellos),
// da las órdenes power, src y tvkey (sin permiso: también invitados) y aplica las reglas del diseño:
//   - al encenderse la tele (off → on, también con el mando original) va a J-Screen una sola vez; si la encendimos
//     nosotros y aun así sale otra cosa (el lanzador llega después del am start), se vuelve a J-Screen una vez;
//   - al apagar o pasar a Tele (por orden nuestra o con el mando original) se pausa lo que suena en J-Screen, una vez;
//   - src con la tele apagada la enciende antes (j: el encendido ya va a J-Screen; tv: encender y luego Tele);
//   - las órdenes que necesitan la pantalla esperan antes a ver J-Screen delante (ensureJ, como mucho 6 s).
const { TV_KEYS } = require('../tv/android-tv');

const WATCHED_MS = 3000, IDLE_MS = 15000;
const ENSURE_MS = 6000, ENSURE_STEP_MS = 500;
const QUIET_KEYS = new Set(['up', 'down', 'left', 'right', 'ok']); // la cruceta va a ráfagas: sin lectura tras cada una
const OWN_PAUSE_MS = 30000; // la pausa de una orden propia vale para su apagado o paso a Tele si el sondeo lo ve en este tiempo
const sleep = ms => new Promise(r => setTimeout(r, ms));

// órdenes que ponen algo en pantalla: antes, J-Screen delante (`t`, o `t:op` si solo cuenta esa op; buscar no enciende)
const SCREEN = new Set(['nav', 'home', 'youtube:play', 'present', 'show', 'netflix:open', 'netflix:play', 'idle:show']);

/**
 * @param {{ tv: ReturnType<typeof import('../tv/android-tv').createAndroidTv>, state: any, broadcast: () => void,
 *           watched: () => boolean, pause: () => Promise<void>, log: { info: (m: string) => void } }} o
 *   watched: ¿hay algún mando conectado?  pause: para el vídeo de la página y Spotify (los errores no cuentan)
 */
function createTele({ tv, state, broadcast, watched, pause, log }) {
  state.tv = { power: null, src: null };
  let lastPower = null; // último encendido conocido (sin null): de él sale el salto a J-Screen
  let lastSrc = null;   // entrada en la última lectura encendida (null tras verla apagada): de ella sale el j → tv
  /** @type {false|'j'|'tv'} el encendido lo pedimos nosotros, con la entrada a la que va */
  let own = false;
  /** @type {null|'off'|'tv'} ya pausamos para este cambio (orden propia), hasta pausedUntil */
  let pausedFor = null, pausedUntil = 0;
  const quietPause = () => pause().catch(() => {});

  async function read() {
    const before = JSON.stringify([state.tv, state.vol, state.muted]);
    try {
      const s = await tv.status();
      state.tv = { power: s.power, src: s.src };
      if (s.vol !== null) { state.vol = s.vol; state.muted = s.muted; }
    } catch { state.tv = { power: null, src: null }; }
    const p = state.tv.power, src = state.tv.src;
    if (p !== null) {
      if (lastPower === 'off' && p === 'on' && !own) {
        log.info('tele: encendida, a J-Screen');
        tv.toJ().catch(() => {});
      }
      if (p === 'on' && own) {
        if (own === 'j' && src !== 'j') { log.info('tele: encendida pero no en J-Screen, a J-Screen'); tv.toJ().catch(() => {}); }
        own = false;
      }
      const change = lastPower === 'on' && p === 'off' ? 'off' : p === 'on' && lastSrc === 'j' && src === 'tv' ? 'tv' : null;
      if (change) {
        if (pausedFor === change && Date.now() < pausedUntil) pausedFor = null;
        else quietPause();   // sin await: la pausa puede tardar segundos y las lecturas van en cadena
      }
      lastPower = p;
      lastSrc = p === 'on' ? src : null;
    }
    if (JSON.stringify([state.tv, state.vol, state.muted]) !== before) broadcast();
  }
  // nunca dos lecturas a la vez, y cada una empieza después de lo que la pidió
  let chain = Promise.resolve();
  // un fallo fuera de la lectura (broadcast, log) no puede dejar la cadena rechazada: el sondeo se pararía
  const readNow = () => (chain = chain.then(read).catch(() => {}));

  function tick() {
    readNow().finally(() => { setTimeout(tick, watched() ? WATCHED_MS : IDLE_MS).unref?.(); });
  }
  // apagada, o sin responder después de verla apagada (reposo profundo): hay que encenderla
  const asleep = () => state.tv.power === 'off' || (state.tv.power === null && lastPower === 'off');

  /** Hace `fn`, lee el estado al momento y devuelve la tele o el error. */
  async function act(/** @type {() => Promise<any>} */ fn, readAfter = true) {
    try { await fn(); } catch (e) {
      if (readAfter) await readNow();
      return { error: /** @type {Error} */ (e).message };
    }
    if (readAfter) await readNow();
    return { tv: state.tv };
  }
  /** Pausa ya, y el sondeo no vuelve a pausar cuando vea este cambio. */
  async function ownPause(/** @type {'off'|'tv'} */ change) {
    await quietPause();
    pausedFor = change; pausedUntil = Date.now() + OWN_PAUSE_MS;
  }
  /** @param {() => Promise<any>} fn */
  const undoPause = async fn => { try { await fn(); } catch (e) { pausedFor = null; throw e; } };

  /** @param {boolean} on */
  function power(on) {
    return act(async () => {
      if (!on) { await ownPause('off'); return undoPause(() => tv.power(false)); }
      own = 'j';
      try { await tv.power(true); } catch (e) { own = false; throw e; }
    });
  }
  /** @param {'j'|'tv'} s */
  function src(s) {
    return act(async () => {
      if (asleep()) {
        own = s;
        try { await tv.power(true); } catch (e) { own = false; throw e; }
        if (s === 'tv') await tv.toTv();
      } else if (s === 'tv') { await ownPause('tv'); await undoPause(() => tv.toTv()); } else await tv.toJ();
    });
  }

  /** Enciende o vuelve a J-Screen si hace falta y espera a verlo (como mucho 6 s). */
  async function ensureJ() {
    const ok = () => state.tv.power === 'on' && state.tv.src === 'j';
    if (ok()) return true;
    try {
      if (asleep()) { own = 'j'; await tv.power(true); } else if (state.tv.src === 'tv') await tv.toJ();
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
      if (types.has(m.t) || types.has(m.t + ':' + m.op)) {
        await readNow();   // el estado guardado puede tener 15 s: la tele pudo apagarse con el mando original
        // sin responder y sin haberla visto apagada no se espera: la orden va directa
        if ((asleep() || state.tv.src === 'tv') && !(await ensureJ())) log.info('tele: no llegó a J-Screen a tiempo');
      }
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
}

module.exports = createTele;
module.exports.SCREEN = SCREEN;
