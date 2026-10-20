'use strict';
// @ts-check
// Altavoz de la tele para la voz del Gateway: un proceso (pw-cat) que lee PCM16 24 kHz mono por stdin. Cada respuesta
// arranca el suyo (`start` mata el anterior); `end` cierra stdin y lo deja vaciar; `stop` lo corta. Un fallo al lanzarlo
// o al escribir se avisa una sola vez y nunca llega a quien llama.
const { spawn } = require('node:child_process');

const CMD = ['pw-cat', '--playback', '--raw', '--format', 's16', '--rate', '24000', '--channels', '1', '-'];

/**
 * @param {{ runtimeDir?: string, cmd?: string[] | null, spawnImpl?: Function, log?: { warn: Function } }} o
 */
function createSpeaker({ runtimeDir, cmd, spawnImpl = spawn, log = { warn() {} } }) {
  const argv = cmd && cmd.length ? cmd : CMD;
  /** @type {any} */ let proc = null;
  let warned = false;
  const warn = (/** @type {any} */ e) => { if (!warned) { warned = true; log.warn('speaker: no suena', e && e.message || e); } };

  function kill() {
    const p = proc; proc = null;
    if (p) { try { p.stdin.destroy(); } catch {} try { p.kill(); } catch {} }
  }

  return {
    start() {
      kill();
      try {
        const p = spawnImpl(argv[0], argv.slice(1), { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir || process.env.XDG_RUNTIME_DIR }, stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('error', (/** @type {any} */ e) => { warn(e); if (proc === p) proc = null; });
        p.on('exit', () => { if (proc === p) proc = null; });
        if (p.stdin) p.stdin.on('error', warn);
        proc = p;
      } catch (e) { warn(e); proc = null; }
    },
    /** @param {Buffer} pcm */
    write(pcm) { if (proc) { try { proc.stdin.write(pcm); } catch (e) { warn(e); } } },
    end() { const p = proc; proc = null; if (p) { try { p.stdin.end(); } catch (e) { warn(e); } } },
    stop: kill,
  };
}

module.exports = { createSpeaker, CMD };
