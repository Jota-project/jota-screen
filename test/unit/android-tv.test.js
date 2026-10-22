'use strict';
// Unitarias de la lectura de la tele por ADB (funciones puras). Los textos son salida real de la tele.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseStatus, passthroughUri, TV_KEYS } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'android-tv'));

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
