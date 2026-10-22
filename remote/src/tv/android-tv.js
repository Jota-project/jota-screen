'use strict';
// @ts-check
// La tele Google TV por ADB: leer su estado (encendido, entrada, volumen real) y las teclas que se le mandan.
const { execFile, spawn } = require('node:child_process');
const net = require('node:net');

// Sondeo filtrado de una sola línea de shell (0,31 s medido en la tele real).
const STATUS_CMD = "dumpsys power | grep -m1 mWakefulness=; dumpsys activity activities | grep -m1 mResumedActivity; dumpsys tv_input | grep -A5 -m1 sessionStateMap; dumpsys audio | grep -A5 -m1 '^- STREAM_MUSIC'";

/**
 * @param {string} out salida de STATUS_CMD
 * @param {string} input inputId de TV Input Framework donde está J-Screen (HDMI)
 * @returns {{ power: 'on'|'off'|null, src: 'j'|'tv'|null, vol: number|null, muted: boolean }}
 */
function parseStatus(out, input) {
  const wake = /mWakefulness=(\w+)/.exec(out);
  const power = !wake ? null : /^(Awake|Dreaming)$/.test(wake[1]) ? 'on' : /^(Asleep|Dozing)$/.test(wake[1]) ? 'off' : null;
  // Dreaming sigue siendo «encendida»: el salvapantallas no apaga la tele.
  const front = /mResumedActivity:.*TurnkeyUiMainActivity/.test(out);
  const session = /sessionStateMap[\s\S]*?inputId: (\S+)/.exec(out);
  const src = power !== 'on' ? null : front && session && session[1] === input ? 'j' : 'tv';
  const vol = /streamVolume:(\d+)/.exec(out);
  return { power, src, vol: vol ? Number(vol[1]) : null, muted: /Muted: true/.test(out) };
}

/** @param {string} input */
const passthroughUri = input => 'content://android.media.tv/passthrough/' + encodeURIComponent(input);

/** @type {Readonly<Record<'up'|'down'|'left'|'right'|'ok'|'back'|'home'|'pp'|'rew'|'ff', string>>} */
const TV_KEYS = Object.freeze({
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', ok: 'KEYCODE_DPAD_CENTER',
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', pp: 'KEYCODE_MEDIA_PLAY_PAUSE', rew: 'KEYCODE_MEDIA_REWIND', ff: 'KEYCODE_MEDIA_FAST_FORWARD',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Conecta al puerto local de monkey; arranca en 1-3 s, así que se reintenta. @param {number} port */
async function connectRetry(port) {
  for (let i = 0; ; i++) {
    try { return await new Promise((res, rej) => { const s = net.connect(port, '127.0.0.1', () => res(s)); s.once('error', rej); }); }
    catch (e) { if (i >= 8) throw e; await sleep(500); }
  }
}

/** Sesión monkey: `press KEYCODE_X` por un socket (~10 ms) en vez de `input keyevent` (1-2 s). Se rehace en la siguiente tecla si cae. */
function monkeySession(/** @type {(args: string[]) => Promise<string>} */ run, /** @type {string} */ addr) {
  /** @type {Promise<{ sock: net.Socket, proc: import('node:child_process').ChildProcess, waiting: Array<(l: string) => void> }> | null} */
  let sess = null;
  let tail = Promise.resolve();
  const close = () => { const s = sess; sess = null; s?.then(x => { x.sock.destroy(); x.proc.kill(); }, () => {}); };
  const open = async () => {
    const port = (await run(['forward', 'tcp:0', 'tcp:1080'])).trim();
    const proc = spawn('adb', ['-s', addr, 'shell', 'monkey', '--port', '1080'], { stdio: 'ignore' });
    proc.on('exit', close);
    try {
      const sock = await connectRetry(Number(port));
      const x = { sock, proc, waiting: /** @type {Array<(l: string) => void>} */ ([]) };
      let buf = '';
      sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { x.waiting.shift()?.(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      sock.on('close', close);
      return x;
    } catch (e) { proc.kill(); throw e; }
  };
  return {
    /** @param {string} code */
    press(code) {
      const go = async () => {
        const x = await (sess ||= open());
        const reply = new Promise(res => x.waiting.push(res));
        x.sock.write(`press ${code}\n`);
        const l = await Promise.race([reply, sleep(2000).then(() => 'ERROR timeout')]);
        if (!/^OK/.test(String(l))) { close(); throw new Error(String(l)); }
      };
      const r = tail.then(go, go);
      tail = r.catch(() => {});
      return r;
    },
    close,
  };
}

/**
 * La tele por ADB, con la interfaz de volumen de createAudio. Todo menos read() lanza 'La tele no responde' si adb falla.
 * @param {{ addr: string, input: string, log: { info: (m: string) => void }, adb?: { run: (a: string[]) => Promise<string>, keys: { press: (c: string) => Promise<void>, close: () => void } } }} o
 */
function createAndroidTv({ addr, input, log, adb }) {
  const raw = (/** @type {string[]} */ args) => new Promise((res, rej) => execFile('adb', ['-s', addr, ...args], { timeout: 3000 }, (e, o, se) => (e ? rej(new Error(String(se || e.message))) : res(o))));
  const a = adb || { run: raw, keys: monkeySession(raw, addr) };
  let stale = false; // el último resultado fue offline / unauthorized / error: antes del siguiente run, adb connect
  /** @param {string[]} args */
  async function run(args) {
    if (stale) { stale = false; await a.run(['connect', addr]).catch(() => {}); }
    try {
      const out = await a.run(args);
      if (/offline|unauthorized/.test(out)) throw new Error(out);
      return out;
    } catch (e) {
      stale = true;
      if (/unauthorized/.test(String(/** @type {Error} */ (e).message))) log.info('tele: ADB sin autorizar; acepta el aviso «¿Permitir depuración?» en la tele');
      throw new Error('La tele no responde');
    }
  }
  const sh = (/** @type {string} */ cmd) => run(['shell', cmd]);
  const status = async () => parseStatus(await sh(STATUS_CMD), input);
  /** @param {keyof typeof TV_KEYS} k */
  const key = async k => {
    try { await a.keys.press(TV_KEYS[k]); }
    catch (e) { log.info(`tele: monkey no responde (${/** @type {Error} */ (e).message}); tecla ${k} por input keyevent (lenta)`); await sh('input keyevent ' + TV_KEYS[k]); }
  };
  const set = (/** @type {number} */ v) => sh(`cmd media_session volume --stream 3 --set ${v} --show`);
  const toJ = () => sh('am start -a android.intent.action.VIEW -d ' + passthroughUri(input));
  return {
    /** @returns {Promise<{ vol: number, muted: boolean } | null>} */
    async read() { try { const s = await status(); return s.vol === null ? null : { vol: s.vol, muted: s.muted }; } catch { return null; } },
    toggleMute: () => sh('input keyevent KEYCODE_VOLUME_MUTE'),
    async step(/** @type {number} */ n, max = 100) {
      const { vol } = await status();
      return set(Math.max(0, Math.min(max, (vol ?? 0) + n)));
    },
    set,
    status,
    async power(/** @type {boolean} */ on) { await sh('input keyevent ' + (on ? 'KEYCODE_WAKEUP' : 'KEYCODE_SLEEP')); if (on) await toJ(); },
    toJ,
    toTv: () => key('home'),
    key,
  };
}

module.exports = { STATUS_CMD, parseStatus, passthroughUri, TV_KEYS, createAndroidTv };
