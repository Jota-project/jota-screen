'use strict';
// @ts-check
// La tele Google TV por ADB: leer su estado (encendido, entrada, volumen real) y las teclas que se le mandan.

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

module.exports = { STATUS_CMD, parseStatus, passthroughUri, TV_KEYS };
