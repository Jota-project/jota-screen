'use strict';
// «talk» (remote/src/features/talk.js) con un Gateway falso que expone emit(ev): el texto escrito sale con sus
// instrucciones, la respuesta llega acumulada al móvil que preguntó y los fallos liberan el turno.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const createTalk = require(path.join(__dirname, '..', 'remote', 'src', 'features', 'talk'));
const { createCommands } = require(path.join(__dirname, '..', 'remote', 'src', 'transport', 'commands'));
const { WebSocket } = require(path.join(__dirname, '..', 'remote', 'node_modules', 'ws'));

const PERMS = { full: { agent: 'full', admin: true }, guest: { agent: 'guest' }, off: { agent: 'off' } };

function make({ ensure = true, media = 0 } = {}) {
  const subs = new Set(), sent = [], views = [];
  const gw = {
    ensure: async () => ensure, send: t => sent.push(t), on: fn => { subs.add(fn); return () => subs.delete(fn); },
    emit: ev => subs.forEach(f => f(ev)),
  };
  const view = Object.fromEntries(['turn', 'you', 'jota', 'done', 'error'].map(k => [k, (...a) => views.push([k, ...a])]));
  const talk = createTalk({ gw, cfg: { NAME: 'Salón', OWNER: 'Alfonso' }, media: () => media, view });
  const msgs = [];
  const ws = { readyState: WebSocket.OPEN, send: s => msgs.push(JSON.parse(s)) };
  const perm = { current: 'full' };
  const cmds = createCommands({ permsOf: dev => PERMS[perm.current] });
  cmds.register(talk.commands);
  const ask = (text, dev = { role: 'admin', name: 'Admin' }) => cmds.dispatch({ t: 'ask', text }, { dev, ws });
  const tick = () => new Promise(r => setImmediate(r));
  return { gw, talk, sent, views, msgs, ws, perm, ask, tick };
}

test('ask full: send lleva askPrefix + texto; los tokens llegan acumulados y ask resuelve {ok:1, reply}', async () => {
  const t = make();
  const p = t.ask('pon jazz');
  await t.tick();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0], createTalk.prompts('Salón', 'Alfonso').askPrefix + 'pon jazz');
  assert.equal(t.talk.busy(), true);
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Hecho, ' });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'jazz.' });
  t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(await p, { ok: 1, reply: 'Hecho, jazz.' });
  assert.deepEqual(t.msgs, [
    { t: 'talk', ev: 'token', text: 'Hecho, ' }, { t: 'talk', ev: 'token', text: 'Hecho, jazz.' }, { t: 'talk', ev: 'done', reply: 'Hecho, jazz.' },
  ]);
  assert.deepEqual(t.views.map(v => v[0]), ['turn', 'you', 'jota', 'jota', 'done']);
  assert.deepEqual(t.views[1], ['you', 'pon jazz', true]);
  assert.equal(t.talk.busy(), false);
});

test('ask de invitado: send empieza por askGuest y lleva "(Se llama Ana.)"', async () => {
  const t = make();
  t.perm.current = 'guest';
  const p = t.ask('hola', { role: 'guest', name: 'Ana' });
  await t.tick();
  assert.ok(t.sent[0].startsWith(createTalk.prompts('Salón', 'Alfonso').askGuest + '(Se llama Ana.) '));
  assert.ok(t.sent[0].endsWith('hola'));
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
});

test('ask con permiso off: error del permiso y nada sale', async () => {
  const t = make();
  t.perm.current = 'off';
  assert.match((await t.ask('hola')).error, /agente no está disponible/);
  assert.equal(t.sent.length, 0);
  assert.equal(t.talk.busy(), false);
});

test('ask vacío: error y sin turno', async () => {
  const t = make();
  assert.match((await t.ask('  ')).error, /vacío/);
  assert.equal(t.talk.busy(), false);
});

test('Gateway no disponible (ensure false): error, el móvil lo ve y busy vuelve a false', async () => {
  const t = make({ ensure: false });
  assert.deepEqual(await t.ask('hola'), { error: 'Jota no está disponible.' });
  assert.deepEqual(t.msgs, [{ t: 'talk', ev: 'error', error: 'Jota no está disponible.' }]);
  assert.equal(t.talk.busy(), false);
  assert.equal(t.sent.length, 0);
});

test('down o turn_error a mitad del turno: ev:error «Jota no está disponible.» y busy false', async () => {
  for (const ev of [{ type: 'down' }, { type: 'turn_error', turnId: 'a', message: 'x' }]) {
    const t = make();
    const p = t.ask('hola'); await t.tick();
    t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
    t.gw.emit({ type: 'token', turnId: 'a', text: 'Ho' });
    t.gw.emit(ev);
    assert.deepEqual(await p, { error: 'Jota no está disponible.' });
    assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'error', error: 'Jota no está disponible.' });
    assert.equal(t.talk.busy(), false);
    assert.equal(t.views.at(-1)[0], 'error');
  }
});

test('segundo ask durante un turno: «Sigo con la petición anterior…» y no se llama a send', async () => {
  const t = make();
  const p = t.ask('uno'); await t.tick();
  assert.deepEqual(await t.ask('dos'), { error: 'Sigo con la petición anterior. Espera un momento.' });
  assert.equal(t.sent.length, 1);
  assert.equal(t.talk.busy(), true);
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.equal((await p).ok, 1);
});

test('un turn_start que no pidió nadie (push) se ignora', async () => {
  const t = make();
  t.gw.emit({ type: 'turn_start', turnId: 'x', seq: 1 });
  t.gw.emit({ type: 'token', turnId: 'x', text: 'hola' });
  t.gw.emit({ type: 'turn_end', turnId: 'x' });
  assert.deepEqual(t.msgs, []);
  assert.deepEqual(t.views, []);
  assert.equal(t.talk.busy(), false);
});

test('view.turn recibe island si media() === 1 y panel si es 0 o -1', async () => {
  for (const [media, mode] of [[1, 'island'], [0, 'panel'], [-1, 'panel']]) {
    const t = make({ media });
    const p = t.ask('hola'); await t.tick();
    assert.deepEqual(t.views[0], ['turn', mode]);
    t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'x' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
    await p;
  }
});
