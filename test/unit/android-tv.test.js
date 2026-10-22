'use strict';
// Unitarias de la lectura de la tele por ADB (funciones puras). Los textos son salida real de la tele.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseStatus, passthroughUri, TV_KEYS, createAndroidTv } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'android-tv'));

const TV_INPUT = 'com.mediatek.tvinput/.hdmi.HDMIInputService/HW4';
const OUT = `  mWakefulness=Awake
    mResumedActivity: ActivityRecord{d6c81d3 u0 com.mediatek.wwtv.tvcenter/.nav.TurnkeyUiMainActivity t5542}
  sessionStateMap: ITvInputSession -> SessionState
    android.os.Binder@1483134: com.android.server.tv.TvInputManagerService$SessionState@3e14e47
      inputId: ${TV_INPUT}
      sessionId: 100051120
      sessionToken: android.os.Binder@1483134
- STREAM_MUSIC:
   Muted: false
   Muted Internally: false
   Min: 0
   Max: 100
   streamVolume:22
`;

test('leer la tele: encendida con J-Screen en la entrada', () => {
  assert.deepEqual(parseStatus(OUT, TV_INPUT), { power: 'on', src: 'j', vol: 22, muted: false });
});

test('leer la tele: otra entrada o el launcher delante es «tv»', () => {
  const sintonizador = OUT.replace('HDMIInputService/HW4', 'TunerInputService/HW0');
  assert.equal(parseStatus(sintonizador, TV_INPUT).src, 'tv');
  const launcher = OUT.replace('com.mediatek.wwtv.tvcenter/.nav.TurnkeyUiMainActivity', 'com.google.android.tvlauncher/.MainActivity');
  assert.equal(parseStatus(launcher, TV_INPUT).src, 'tv', 'la sesión HW4 vieja no cuenta si no es la de delante');
});

test('leer la tele: encendido, silencio y salida vacía', () => {
  assert.equal(parseStatus(OUT.replace('Awake', 'Dreaming'), TV_INPUT).power, 'on');
  for (const w of ['Asleep', 'Dozing']) {
    const s = parseStatus(OUT.replace('Awake', w), TV_INPUT);
    assert.equal(s.power, 'off'); assert.equal(s.src, null);
  }
  assert.equal(parseStatus(OUT.replace('Muted: false', 'Muted: true'), TV_INPUT).muted, true);
  const vacio = parseStatus('', TV_INPUT);
  assert.equal(vacio.power, null); assert.equal(vacio.src, null); assert.equal(vacio.vol, null);
});

test('URI de passthrough y teclas', () => {
  assert.equal(passthroughUri(TV_INPUT), 'content://android.media.tv/passthrough/com.mediatek.tvinput%2F.hdmi.HDMIInputService%2FHW4');
  for (const k of ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'pp', 'rew', 'ff']) assert.match(TV_KEYS[k], /^KEYCODE_/, k);
  assert.equal(Object.keys(TV_KEYS).length, 10);
});

// ── createAndroidTv con un adb falso ─────────────────────────────────────────────────────────────────────
const fakeAdb = (vol = 22, out = null) => {
  const runs = [], pressed = [];
  return { runs, pressed,
    run: async args => { runs.push(args); if (args[0] === 'connect') return 'connected'; if (adbState.fail) throw new Error('boom'); return out ?? OUT.replace('streamVolume:22', 'streamVolume:' + vol); },
    keys: { press: async c => { pressed.push(c); }, close() {} } };
};
let adbState = { fail: false };
const mk = (vol, out) => { adbState = { fail: false }; const adb = fakeAdb(vol, out); const logs = []; return { adb, logs, tv: createAndroidTv({ addr: 'x:5555', input: TV_INPUT, log: { info: m => logs.push(m) }, adb }) }; };
const sets = adb => adb.runs.map(r => r[1]).filter(c => /--set/.test(c)).map(c => /--set (\d+)/.exec(c)[1]);

test('tele: step acota a 0..max y suma al volumen real', async () => {
  let t = mk(22); await t.tv.step(1); assert.deepEqual(sets(t.adb), ['23']);
  t = mk(3); await t.tv.step(-5); assert.deepEqual(sets(t.adb), ['0']);
  t = mk(22); await t.tv.step(2, 23); assert.deepEqual(sets(t.adb), ['23']);
});

test('tele: power(true) despierta y luego pasa a J; power(false) duerme', async () => {
  const { adb, tv } = mk(22);
  await tv.power(true);
  assert.match(adb.runs[0][1], /KEYCODE_WAKEUP/);
  assert.match(adb.runs[1][1], new RegExp('am start .* -d ' + passthroughUri(TV_INPUT).replace(/[/.]/g, '\\$&')));
  await tv.power(false);
  assert.match(adb.runs[2][1], /KEYCODE_SLEEP/);
});

test('tele: las teclas van por la sesión monkey, en orden, sin run', async () => {
  const { adb, tv } = mk(22);
  await tv.key('left');
  for (let i = 0; i < 10; i++) tv.key(i % 2 ? 'up' : 'down');
  await tv.key('ok');
  assert.equal(adb.pressed[0], 'KEYCODE_DPAD_LEFT');
  assert.deepEqual(adb.pressed.slice(1, 4), ['KEYCODE_DPAD_DOWN', 'KEYCODE_DPAD_UP', 'KEYCODE_DPAD_DOWN']);
  assert.equal(adb.pressed.length, 12);
  assert.equal(adb.runs.length, 0);
});

test('tele: si monkey falla la tecla va por input keyevent y se registra', async () => {
  const { adb, tv, logs } = mk(22);
  adb.keys.press = async () => { throw new Error('sin monkey'); };
  await tv.key('back');
  assert.match(adb.runs[0][1], /input keyevent KEYCODE_BACK/);
  assert.equal(logs.length, 1);
});

test('tele: si adb falla read() da null y el resto lanza; la siguiente llamada hace connect antes', async () => {
  const { adb, tv } = mk(22);
  adbState.fail = true;
  assert.equal(await tv.read(), null);
  await assert.rejects(tv.power(true), /La tele no responde/);
  await assert.rejects(tv.status(), /La tele no responde/);
  adbState.fail = false;
  adb.runs.length = 0;
  await tv.status();
  assert.deepEqual(adb.runs[0], ['connect', 'x:5555']);
});

test('tele: unauthorized deja el aviso en el registro', async () => {
  const { tv, logs } = mk(22, 'error: device unauthorized.');
  await assert.rejects(tv.status(), /La tele no responde/);
  assert.match(logs[0], /ADB sin autorizar/);
});
