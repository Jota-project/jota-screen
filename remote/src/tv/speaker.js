'use strict';
// @ts-check
// Altavoz de la tele para la voz del Gateway: un proceso (pw-cat) que lee PCM16 24 kHz mono por stdin. Cada respuesta
// arranca el suyo (`start` mata el anterior); `end` cierra stdin y lo deja vaciar; `stop` lo corta. Un fallo al lanzarlo
// o al escribir se avisa una sola vez y nunca llega a quien llama. `onIdle(fn)`: una vez por reproducción, cuando acaba
// tras `end` (el proceso sale; o ya no estaba: no arrancó o murió antes) o se corta con `stop`; nunca por un `start` que
// la sustituye (la nueva manda).
const { spawn } = require('node:child_process');

const CMD = ['pw-cat', '--playback', '--raw', '--format', 's16', '--rate', '24000', '--channels', '1', '-'];

/**
 * @param {{ runtimeDir?: string, cmd?: string[] | null, spawnImpl?: Function, log?: { warn: Function } }} o
 */
function createSpeaker({ runtimeDir, cmd, spawnImpl = spawn, log = { warn() {} } }) {
  const argv = cmd && cmd.length ? cmd : CMD;
  /** @type {any} */ let proc = null;
  /** @type {any} */ let draining = null;                 // tras `end`: sigue sonando lo que le queda, pero start/stop aún lo pueden matar
  /** La reproducción actual: `ended` tras end, `gone` sin proceso vivo, `told` ya avisada (o sustituida).
   *  @typedef {{ ended: boolean, gone: boolean, told: boolean }} Gen */
  /** @type {Gen | null} */
  let cur = null;
  /** @type {() => void} */ let idle = () => {};
  let warned = false;
  const warn = (/** @type {any} */ e) => { if (!warned) { warned = true; log.warn('speaker: no suena', e && e.message || e); } };

  /** @param {Gen} g */
  function tell(g) { if (g.told) return; g.told = true; try { idle(); } catch (e) { log.warn('speaker: onIdle con error', e); } }
  /** El proceso de la reproducción `g` ya no está. @param {Gen} g */
  function gone(g) { g.gone = true; if (g.ended) tell(g); }

  /** @param {any} p */
  function die(p) { try { p.stdin.destroy(); } catch {} try { p.kill(); } catch {} }
  function kill() {
    const p = proc, d = draining; proc = null; draining = null;
    if (p) die(p);
    if (d) die(d);
  }

  return {
    start() {
      if (cur) cur.told = true;                         // la sustituida no avisa
      kill(); warned = false;
      /** @type {Gen} */ const g = { ended: false, gone: false, told: false };
      cur = g;
      try {
        const p = spawnImpl(argv[0], argv.slice(1), { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir || process.env.XDG_RUNTIME_DIR }, stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('error', (/** @type {any} */ e) => { warn(e); if (proc === p) proc = null; if (draining === p) draining = null; gone(g); });
        p.on('exit', () => { if (proc === p) proc = null; if (draining === p) draining = null; gone(g); });
        if (p.stdin) p.stdin.on('error', warn);
        proc = p;
      } catch (e) { warn(e); proc = null; g.gone = true; }
    },
    /** @param {Buffer} pcm */
    write(pcm) { if (proc) { try { proc.stdin.write(pcm); } catch (e) { warn(e); } } },
    end() {
      const g = cur; if (!g || g.ended) return;
      g.ended = true;
      const p = proc;
      if (!p) { tell(g); return; }                       // no arrancó o ya murió: no hay nada que vaciar
      proc = null; draining = p; try { p.stdin.end(); } catch (e) { warn(e); }
    },
    stop() { kill(); if (cur) tell(cur); },
    /** @param {() => void} fn */
    onIdle(fn) { idle = fn; },
  };
}

module.exports = { createSpeaker, CMD };
