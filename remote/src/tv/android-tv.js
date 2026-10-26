'use strict';
// @ts-check
// La tele Google TV por ADB: leer su estado (encendido, entrada, volumen real) y las teclas que se le mandan.
const { execFile, spawn } = require('node:child_process');
const net = require('node:net');

// Sondeo filtrado de una sola línea de shell (0,31 s medido en la tele real). El grep de Android (toybox) ignora -A con
// -m1 y solo da la cabecera de STREAM_MUSIC: el bloque del volumen sale con sed, que corta en streamVolume.
const STATUS_CMD = "dumpsys power | grep -m1 mWakefulness=; dumpsys activity activities | grep -m1 mResumedActivity; dumpsys tv_input | sed -n '/sessionStateMap/,/mainSessionToken/p'; dumpsys audio | sed -n '/^- STREAM_MUSIC:/,/streamVolume/{p;/streamVolume/q;}'";

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
  const src = power !== 'on' ? null : front && mainInput(out) === input ? 'j' : 'tv';
  const vol = /streamVolume:(\d+)/.exec(out);
  return { power, src, vol: vol ? Number(vol[1]) : null, muted: /Muted: true/.test(out) };
}

/**
 * inputId de la sesión principal (la de `mainSessionToken`), no la primera de la lista: en MediaTek la TDT también va en
 * TurnkeyUiMainActivity y puede quedar una sesión HW4 vieja delante. Sin principal (`null`) o sin coincidencia, null.
 * @param {string} out
 */
function mainInput(out) {
  const main = /mainSessionToken: (\S+)/.exec(out);
  if (!main || main[1] === 'null') return null;
  let id = null;
  for (const l of out.split('\n')) {
    const m = /^\s*(inputId|sessionToken): (\S+)/.exec(l);
    if (m && m[1] === 'inputId') id = m[2];
    else if (m && m[2] === main[1]) return id;
  }
  return null;
}

/** @param {string} input */
const passthroughUri = input => 'content://android.media.tv/passthrough/' + encodeURIComponent(input);

/** @type {Readonly<Record<'up'|'down'|'left'|'right'|'ok'|'back'|'home'|'pp'|'rew'|'ff', string>>} */
const TV_KEYS = Object.freeze({
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', ok: 'KEYCODE_DPAD_CENTER',
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', pp: 'KEYCODE_MEDIA_PLAY_PAUSE', rew: 'KEYCODE_MEDIA_REWIND', ff: 'KEYCODE_MEDIA_FAST_FORWARD',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Sesión monkey: `press KEYCODE_X` por un socket (~10 ms) en vez de `input keyevent` (1-2 s). Se rehace en la siguiente tecla si cae. */
function monkeySession(/** @type {(args: string[]) => Promise<string>} */ run, /** @type {string} */ addr, /** @type {typeof spawn} */ spawnFn = spawn) {
  // matar el `adb shell` local no para monkey en la tele: se mata allí
  const pkill = () => run(['shell', 'pkill', '-f', 'com.android.commands.monkey']).catch(() => {});
  /** @typedef {{ sock: net.Socket | null, proc: import('node:child_process').ChildProcess, waiting: Array<(l: string | null) => void>, dead: boolean, ready: boolean, kill: () => void }} Sess */
  /** @type {Promise<Sess> | null} */
  let sess = null;
  /** @type {Sess | null} */
  let cur = null;
  let tail = Promise.resolve();
  const open = async () => {
    await pkill();   // restos de un arranque anterior del servidor
    const port = (await run(['forward', 'tcp:0', 'tcp:1080'])).trim();
    const proc = spawnFn('adb', ['-s', addr, 'shell', 'monkey', '--port', '1080'], { stdio: 'ignore' });
    /** @type {Sess} */
    const s = { sock: null, proc, waiting: [], dead: false, ready: false, kill() {
      if (s.dead) return;
      s.dead = true; s.sock?.destroy(); proc.kill(); pkill();
      run(['forward', '--remove', 'tcp:' + port]).catch(() => {});
      for (const f of s.waiting.splice(0)) f(null);   // las teclas pendientes fallan ya
      if (cur === s) { cur = null; sess = null; }
    } };
    cur = s;
    proc.on('exit', s.kill); proc.on('error', s.kill);
    // El puerto local acepta TCP en cuanto existe el forward, aunque monkey no escuche aún: solo vale cuando contesta a una sonda.
    for (const end = Date.now() + 15000; !s.dead; await sleep(400)) {
      if (Date.now() > end) break;
      const sock = await new Promise(res => { const c = net.connect(Number(port), '127.0.0.1', () => res(c)); c.once('error', () => res(null)); });
      if (!sock) continue;
      s.sock = sock;
      let buf = '';
      sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { s.waiting.shift()?.(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      sock.on('error', () => { if (s.ready) s.kill(); });
      sock.on('close', () => { if (s.ready) s.kill(); });
      const probe = new Promise(res => s.waiting.push(res));
      sock.write('getvar build.version.release\n');
      const l = await Promise.race([probe, sleep(1000).then(() => null)]);
      if (typeof l === 'string' && l.startsWith('OK')) { s.ready = true; return s; }
      s.waiting.length = 0; sock.destroy(); s.sock = null;   // monkey aún arrancando
    }
    s.kill();
    throw new Error('monkey no arranca');
  };
  return {
    /** @param {string} code */
    press(code) {
      const go = async () => {
        const x = await (sess ||= open().catch(e => { sess = null; throw e; }));
        if (x.dead || !x.sock) throw new Error('sesión caída');
        const reply = new Promise(res => x.waiting.push(res));
        x.sock.write(`press ${code}\n`);
        const l = await Promise.race([reply, sleep(2000).then(() => 'ERROR timeout')]);
        if (!/^OK/.test(String(l))) { x.kill(); throw new Error(String(l)); }
      };
      const r = tail.then(go, go);
      tail = r.catch(() => {});
      return r;
    },
    close() { cur?.kill(); },
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
  /** @param {string} code KEYCODE_… @param {string} name para el registro */
  const press = async (code, name) => {
    try { await a.keys.press(code); }
    catch (e) { log.info(`tele: monkey no responde (${/** @type {Error} */ (e).message}); tecla ${name} por input keyevent (lenta)`); await sh('input keyevent ' + code); }
  };
  /** @param {keyof typeof TV_KEYS} k */
  const key = k => press(TV_KEYS[k], k);
  const set = (/** @type {number} */ v) => sh(`cmd media_session volume --stream 3 --set ${Math.max(0, Math.min(100, Math.round(v)))} --show`);
  const toJ = () => sh('am start -a android.intent.action.VIEW -d ' + passthroughUri(input));
  return {
    /** @returns {Promise<{ vol: number, muted: boolean } | null>} */
    async read() { try { const s = await status(); return s.vol === null ? null : { vol: s.vol, muted: s.muted }; } catch { return null; } },
    toggleMute: () => press('KEYCODE_VOLUME_MUTE', 'mute'),   // por monkey: input keyevent tarda 1-2 s (medido)
    async step(/** @type {number} */ n, max = 100) {
      const { vol } = await status();
      if (vol === null) throw new Error('La tele no responde');   // sin volumen conocido no se fija nada
      return set(Math.max(0, Math.min(max, vol + n)));
    },
    set,
    status,
    // to 'tv': Inicio por input keyevent y no por monkey, que recién despierta tarda en arrancar (>15 s medidos). Dos
    // órdenes y no una: juntas pasan de los 3 s de run (1,3 s + 2,1 s medidos).
    async power(/** @type {boolean} */ on, /** @type {'j'|'tv'} */ to = 'j') {
      await sh('input keyevent ' + (on ? 'KEYCODE_WAKEUP' : 'KEYCODE_SLEEP'));
      if (on) await (to === 'tv' ? sh('input keyevent KEYCODE_HOME') : toJ());
    },
    toJ,
    toTv: () => key('home'),
    key,
    close: () => a.keys.close(),
  };
}

module.exports = { STATUS_CMD, parseStatus, passthroughUri, TV_KEYS, createAndroidTv, monkeySession };
