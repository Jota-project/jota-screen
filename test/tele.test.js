'use strict';
// Capacidad «tele» con una tele falsa: sondeo, órdenes power/src/tvkey, siempre a J-Screen al encender y ensureJ.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createTele = require('../remote/src/features/tele');
const { start } = require('./helpers/server');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

/** Tele falsa con estado programable (`st`); `fail` hace fallar todo como adb caído. */
function fakeTv() {
  const calls = [];
  const no = () => { throw new Error('La tele no responde'); };
  const tv = {
    calls, fail: false, st: { power: 'on', src: 'j', vol: 22, muted: false },
    async status() { if (tv.fail) no(); return { ...tv.st }; },
    async power(on) { calls.push('power:' + on); if (tv.fail) no(); if (tv.wakes !== false) tv.st = { ...tv.st, power: on ? 'on' : 'off', src: on ? tv.st.src : null }; },
    async toJ() { calls.push('toJ'); if (tv.fail) no(); },
    async toTv() { calls.push('toTv'); if (tv.fail) no(); },
    async key(k) { calls.push('key:' + k); if (tv.fail) no(); },
    wakes: true,
  };
  return tv;
}

function setup(t, { watched = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tv = fakeTv();
  const state = { vol: null, muted: false, tv: null };
  const seen = { bc: 0, logs: [] };
  const tele = createTele({
    tv, state, broadcast: () => seen.bc++, watched: () => watched,
    pause: async () => { tv.calls.push('pause'); }, log: { info: m => seen.logs.push(m) },
  });
  const step = async ms => { t.mock.timers.tick(ms); await flush(); };
  const cmd = (t2, m = {}) => tele.commands.find(c => c.t === t2).run(m);
  return { tv, state, seen, tele, step, cmd };
}

test('power off: pausa, apaga, lee el estado y difunde', async t => {
  const { tv, state, seen, cmd } = setup(t);
  const r = await cmd('power', { on: false });
  assert.deepEqual(tv.calls, ['pause', 'power:false']);
  assert.deepEqual(state.tv, { power: 'off', src: null });
  assert.deepEqual(r, { tv: { power: 'off', src: null } });
  assert.ok(seen.bc > 0);
});

test('sondeo off, on, on (tv), on (tv): a J-Screen una sola vez', async t => {
  const { tv, tele, step } = setup(t);
  tv.st = { ...tv.st, power: 'off', src: null };
  tele.start(); await flush();
  tv.st = { ...tv.st, power: 'on', src: 'tv' }; await step(15000);
  await step(15000); await step(15000);
  assert.equal(tv.calls.filter(c => c === 'toJ').length, 1);
});

test('sondeo off, null, on (reposo profundo): a J-Screen una vez', async t => {
  const { tv, tele, step } = setup(t);
  tv.st = { ...tv.st, power: 'off', src: null };
  tele.start(); await flush();
  tv.st = { ...tv.st, power: null, src: null }; await step(15000);
  tv.st = { ...tv.st, power: 'on', src: 'tv' }; await step(15000);
  assert.equal(tv.calls.filter(c => c === 'toJ').length, 1);
});

test('arranque con la tele ya encendida (null, on): no salta', async t => {
  const { tv, tele, step } = setup(t);
  tv.st = { ...tv.st, power: null, src: null };
  tele.start(); await flush();
  tv.st = { ...tv.st, power: 'on', src: 'tv' }; await step(15000);
  assert.equal(tv.calls.filter(c => c === 'toJ').length, 0);
});

test('src tv pausa y pasa a la tele; tecla no válida', async t => {
  const { tv, cmd } = setup(t);
  await cmd('src', { s: 'tv' });
  assert.deepEqual(tv.calls, ['pause', 'toTv']);
  assert.deepEqual(await cmd('tvkey', { k: 'rm' }), { error: 'tecla no válida' });
  assert.deepEqual(await cmd('tvkey', { k: 'constructor' }), { error: 'tecla no válida' });
});

test('el sondeo va cada 3 s con mandos y cada 15 s sin ellos', async t => {
  for (const [watched, ms] of [[true, 3000], [false, 15000]]) {
    await t.test(`watched ${watched}`, async t2 => {
      const { tv, tele, step } = setup(t2, { watched });
      let n = 0; const st = tv.status; tv.status = async () => { n++; return st(); };
      tele.start(); await flush();
      await step(ms - 1); assert.equal(n, 1);
      await step(1); assert.equal(n, 2);
    });
  }
});

test('un sondeo con otro volumen lo pone en el estado y difunde', async t => {
  const { tv, state, seen, tele, step } = setup(t);
  tele.start(); await flush();
  assert.equal(state.vol, 22);
  const bc = seen.bc;
  await step(15000); assert.equal(seen.bc, bc, 'sin cambios no difunde');
  tv.st = { ...tv.st, vol: 30 }; await step(15000);
  assert.equal(state.vol, 30);
  assert.equal(seen.bc, bc + 1);
});

test('tele caída: estado desconocido y la orden da error', async t => {
  const { tv, state, cmd } = setup(t);
  tv.fail = true;
  assert.deepEqual(await cmd('power', { on: true }), { error: 'La tele no responde' });
  assert.deepEqual(state.tv, { power: null, src: null });
});

test('ensureJ enciende y espera a J-Screen; el sondeo no repite el salto', async t => {
  const { tv, tele, step } = setup(t);
  tv.st = { ...tv.st, power: 'off', src: null };
  tele.start(); await flush();
  const p = tele.ensureJ();
  await flush();
  assert.deepEqual(tv.calls, ['power:true']);
  tv.st = { ...tv.st, src: 'tv' }; await step(500);
  tv.st = { ...tv.st, src: 'j' }; await step(500);
  assert.equal(await p, true);
  await step(15000);
  assert.equal(tv.calls.filter(c => c === 'toJ').length, 0, 'power(true) ya fue a J-Screen');
});

test('ensureJ que no llega en 6 s da false y la orden envuelta se hace igual', async t => {
  const { tv, seen, tele, step } = setup(t);
  tv.st = { ...tv.st, power: 'off', src: null }; tv.wakes = false;
  tele.start(); await flush();
  let ran = 0;
  const [nav] = tele.withScreen([{ t: 'nav', run: () => { ran++; return { ok: 1 }; } }], new Set(['nav']));
  const p = nav.run({ t: 'nav' }, /** @type {any} */ ({}));
  for (let i = 0; i < 13; i++) await step(500);
  assert.deepEqual(await p, { ok: 1 });
  assert.equal(ran, 1);
  assert.ok(seen.logs.includes('tele: no llegó a J-Screen a tiempo'));
});

test('withScreen: nav con la tele en Tele pasa por ensureJ; vol y lo que no está en la lista, no', async t => {
  const { tv, tele, step } = setup(t);
  tv.st = { ...tv.st, src: 'tv' };
  tele.start(); await flush();
  const order = [];
  const list = tele.withScreen([
    { t: 'nav', run: () => { order.push('nav'); return 1; } },
    { t: 'vol', run: () => { order.push('vol'); return 1; } },
    { t: 'netflix', run: () => { order.push('netflix'); return 1; } },
  ], new Set(['nav', 'netflix:open']));
  await list[1].run({ t: 'vol' }, /** @type {any} */ ({}));
  await list[2].run({ t: 'netflix', op: 'search' }, /** @type {any} */ ({}));
  assert.deepEqual(tv.calls, []);
  const p = list[0].run({ t: 'nav' }, /** @type {any} */ ({}));
  await flush();
  tv.st = { ...tv.st, src: 'j' }; await step(500);
  await p;
  assert.deepEqual(tv.calls, ['toJ']);
  assert.deepEqual(order, ['vol', 'netflix', 'nav']);
});

test('servidor con la tele caída: arranca sin rechazos sueltos y /api/state da tv desconocida', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-adb-'));
  fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\necho "error: device offline" >&2\nexit 1\n', { mode: 0o755 });
  const s = await start({ env: { TV_ADB: '127.0.0.1:9', TV_INPUT: 'x/HW4', PATH: bin + path.delimiter + process.env.PATH } });
  try {
    let st;
    for (let i = 0; i < 50; i++) {
      st = await (await s.api('/api/state')).json();
      if (st.tv) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(st.tv, { power: null, src: null });
    const cmd = async body => (await s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.deepEqual(await cmd({ t: 'power', on: true }), { error: 'La tele no responde' });
    assert.deepEqual(await cmd({ t: 'tvkey', k: 'home' }), { error: 'La tele no responde' });
    assert.deepEqual((await (await s.api('/api/state')).json()).tv, { power: null, src: null }, 'sigue en pie tras los fallos');
    assert.doesNotMatch(s.logs(), /unhandled|UnhandledPromiseRejection/i);
  } finally { await s.stop(); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('servidor sin TV_ADB: tv es null', async () => {
  const s = await start();
  try { assert.equal((await (await s.api('/api/state')).json()).tv, null); } finally { await s.stop(); }
});
