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

function make({ ensure = true, media = 0, turnIdleMs, slowEnsure = false, finalMs, maxVoiceMs } = {}) {
  const subs = new Set(), sent = [], views = [], audio = [], ends = [];
  const gw = {
    ensure: async () => { if (slowEnsure) await new Promise(r => setTimeout(r, 20)); return ensure; }, send: t => sent.push(t), audio: b => audio.push(b), end: () => ends.push(1), on: fn => { subs.add(fn); return () => subs.delete(fn); },
    emit: ev => subs.forEach(f => f(ev)),
  };
  const view = Object.fromEntries(['turn', 'you', 'jota', 'done', 'error'].map(k => [k, (...a) => views.push([k, ...a])]));
  const talk = createTalk({ gw, cfg: { NAME: 'Salón', OWNER: 'Alfonso' }, media: () => media, view, turnIdleMs, finalMs, maxVoiceMs });
  const msgs = [];
  const ws = { readyState: WebSocket.OPEN, send: s => msgs.push(JSON.parse(s)) };
  const perm = { current: 'full' };
  const cmds = createCommands({ permsOf: dev => PERMS[perm.current] });
  cmds.register(talk.commands);
  const ask = (text, dev = { role: 'admin', name: 'Admin' }) => cmds.dispatch({ t: 'ask', text }, { dev, ws });
  const vcmd = (m, dev = { role: 'admin', name: 'Admin' }, sock = ws) => cmds.dispatch(m, { dev, ws: sock });
  const tick = () => new Promise(r => setImmediate(r));
  return { gw, talk, sent, views, msgs, ws, perm, ask, tick, audio, ends, vcmd, make: null };
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
  assert.deepEqual(t.msgs, [], 'el aviso va solo en el resultado, no como ev:error al móvil con turno');
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

test('un turn_start de push durante ensure() (antes de send) no se queda el turno', async () => {
  const t = make({ slowEnsure: true });
  const p = t.ask('hola');
  t.gw.emit({ type: 'turn_start', turnId: 'push', seq: 1 });
  t.gw.emit({ type: 'token', turnId: 'push', text: 'ajeno' });
  t.gw.emit({ type: 'turn_end', turnId: 'push' });
  assert.equal(t.talk.busy(), true);
  assert.deepEqual(t.msgs, []);
  await new Promise(r => setTimeout(r, 40));
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 2 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'mío' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(await p, { ok: 1, reply: 'mío' });
});

test('turno sin eventos: a turnIdleMs falla como down y libera busy; cada evento reinicia el plazo', async () => {
  const t = make({ turnIdleMs: 60 });
  const p = t.ask('hola'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  await new Promise(r => setTimeout(r, 40));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'x' });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(t.talk.busy(), true, 'el token reinició el plazo');
  assert.deepEqual(await p, { error: 'Jota no está disponible.' });
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'error', error: 'Jota no está disponible.' });
  assert.equal(t.views.at(-1)[0], 'error');
  assert.equal(t.talk.busy(), false);
});

test('turn_end sin turn_start previo: no engancha, y el plazo libera el turno', async () => {
  const t = make({ turnIdleMs: 50 });
  const p = t.ask('hola'); await t.tick();
  t.gw.emit({ type: 'turn_end', turnId: 'z' });
  assert.equal(t.talk.busy(), true);
  assert.deepEqual(await p, { error: 'Jota no está disponible.' });
  assert.equal(t.talk.busy(), false);
});

// ── voz
const frame = n => Buffer.alloc(6400, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const other = () => ({ readyState: WebSocket.OPEN, send() {} });

test('vstart y luego binario: cada trozo llega tal cual a gw.audio; el de otro socket o sin vstart se descarta', async () => {
  const t = make();
  t.talk.onBinary(frame(9), t.ws);
  assert.equal(t.audio.length, 0, 'sin vstart');
  assert.deepEqual(await t.vcmd({ t: 'vstart', out: 'tv' }), { ok: 1 });
  assert.equal(t.talk.busy(), true);
  assert.deepEqual(t.views[0], ['turn', 'panel']);
  const a = frame(1), b = frame(2);
  t.talk.onBinary(a, t.ws); t.talk.onBinary(b, t.ws); t.talk.onBinary(frame(3), other());
  assert.equal(t.audio.length, 2);
  assert.equal(t.audio[0], a); assert.equal(t.audio[1], b);
});

test('partial → ev:partial al móvil y view.you(text,false); vend → gw.end(); final → view.you(true), ev:final y send con prefijo', async () => {
  const t = make();
  await t.vcmd({ t: 'vstart', out: 'phone' });
  t.gw.emit({ type: 'partial', text: 'pon' });
  t.gw.emit({ type: 'partial', text: 'pon jazz' });
  assert.deepEqual(t.msgs, [{ t: 'talk', ev: 'partial', text: 'pon' }, { t: 'talk', ev: 'partial', text: 'pon jazz' }]);
  assert.deepEqual(t.views.slice(1), [['you', 'pon', false], ['you', 'pon jazz', false]]);
  assert.deepEqual(await t.vcmd({ t: 'vend' }), { ok: 1 });
  assert.equal(t.ends.length, 1);
  assert.equal(t.sent.length, 0);
  t.talk.onBinary(frame(1), t.ws);
  assert.equal(t.audio.length, 0, 'tras vend no sube más audio');
  t.gw.emit({ type: 'final', text: 'pon jazz' });
  assert.deepEqual(t.views.at(-1), ['you', 'pon jazz', true]);
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'final', text: 'pon jazz' });
  assert.deepEqual(t.sent, [createTalk.prompts('Salón', 'Alfonso').askPrefix + 'pon jazz']);
  assert.equal(t.talk.busy(), true);
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'Hecho.' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'done', reply: 'Hecho.' });
  assert.equal(t.views.at(-1)[0], 'done');
  assert.equal(t.talk.busy(), false);
});

test('voz de invitado: el prefijo es el del socket que hizo vstart', async () => {
  const t = make();
  t.perm.current = 'guest';
  await t.vcmd({ t: 'vstart' }, { role: 'guest', name: 'Ana' });
  await t.vcmd({ t: 'vend' }, { role: 'guest', name: 'Ana' });
  t.gw.emit({ type: 'final', text: 'hola' });
  assert.equal(t.sent[0], createTalk.prompts('Salón', 'Alfonso').askGuest + '(Se llama Ana.) hola');
});

test('final vacía, o sin final a los finalMs tras vend: ev:error «No te he entendido…», busy false y sin send', async () => {
  const t = make({ finalMs: 50 });
  await t.vcmd({ t: 'vstart' }); await t.vcmd({ t: 'vend' });
  t.gw.emit({ type: 'final', text: '  ' });
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'error', error: 'No te he entendido. Prueba otra vez.' });
  assert.equal(t.views.at(-1)[0], 'error');
  assert.equal(t.talk.busy(), false);
  const u = make({ finalMs: 50 });
  await u.vcmd({ t: 'vstart' }); await u.vcmd({ t: 'vend' });
  assert.equal(u.talk.busy(), true);
  await sleep(90);
  assert.deepEqual(u.msgs.at(-1), { t: 'talk', ev: 'error', error: 'No te he entendido. Prueba otra vez.' });
  assert.equal(u.talk.busy(), false);
  u.gw.emit({ type: 'final', text: 'tarde' });
  assert.equal(u.sent.length, 0);
  assert.equal(t.sent.length, 0);
});

test('vcancel, onClose del dueño o tope de grabación: gw.end() una vez, busy libre y la final tardía se descarta', async () => {
  const causes = {
    vcancel: t => t.vcmd({ t: 'vcancel' }),
    onClose: t => t.talk.onClose(t.ws),
    tope: t => sleep(60),
  };
  for (const [name, go] of Object.entries(causes)) {
    const t = make({ maxVoiceMs: 30, finalMs: 200 });
    await t.vcmd({ t: 'vstart' });
    await go(t);
    assert.equal(t.ends.length, 1, name);
    assert.equal(t.talk.busy(), false, name);
    t.gw.emit({ type: 'final', text: 'fantasma' });
    assert.equal(t.sent.length, 0, name);
    assert.deepEqual(t.msgs, [], name + ': sin mensajes');
    // el turno siguiente arranca limpio
    await t.vcmd({ t: 'vstart' }); await t.vcmd({ t: 'vend' });
    t.gw.emit({ type: 'final', text: 'real' });
    assert.equal(t.sent.length, 1, name);
    assert.ok(t.sent[0].endsWith('real'), name);
  }
});

test('vcancel tras vend no repite gw.end(); onClose de otro socket no cancela', async () => {
  const t = make();
  await t.vcmd({ t: 'vstart' });
  t.talk.onClose(other());
  assert.equal(t.talk.busy(), true);
  await t.vcmd({ t: 'vend' }); await t.vcmd({ t: 'vcancel' });
  assert.equal(t.ends.length, 1);
  assert.equal(t.talk.busy(), false);
});

test('la final no vale antes de vend ni sin turno', async () => {
  const t = make();
  t.gw.emit({ type: 'final', text: 'suelta' });
  await t.vcmd({ t: 'vstart' });
  t.gw.emit({ type: 'final', text: 'pronto' });
  assert.equal(t.sent.length, 0);
});

test('vstart de otro móvil (o un ask) durante un turno: BUSY y su audio no se reenvía', async () => {
  const t = make();
  await t.vcmd({ t: 'vstart' });
  const BUSY = { error: 'Sigo con la petición anterior. Espera un momento.' };
  assert.deepEqual(await t.vcmd({ t: 'vstart' }, undefined, other()), BUSY);
  assert.deepEqual(await t.ask('escrito'), BUSY);
  t.talk.onBinary(frame(1), other());
  assert.equal(t.audio.length, 0);
  assert.equal(t.talk.busy(), true);
});

test('vstart con Gateway caído: error, ev:error al móvil y busy libre; down a mitad de grabación igual', async () => {
  const t = make({ ensure: false });
  assert.deepEqual(await t.vcmd({ t: 'vstart' }), { error: 'Jota no está disponible.' });
  assert.deepEqual(t.msgs, [{ t: 'talk', ev: 'error', error: 'Jota no está disponible.' }]);
  assert.equal(t.talk.busy(), false);
  const u = make();
  await u.vcmd({ t: 'vstart' });
  u.gw.emit({ type: 'down' });
  assert.deepEqual(u.msgs.at(-1), { t: 'talk', ev: 'error', error: 'Jota no está disponible.' });
  assert.equal(u.talk.busy(), false);
});

test('vend sin vstart, o de otro socket: error; permiso off: error del permiso', async () => {
  const t = make();
  assert.ok((await t.vcmd({ t: 'vend' })).error);
  await t.vcmd({ t: 'vstart' });
  assert.ok((await t.vcmd({ t: 'vend' }, undefined, other())).error);
  t.perm.current = 'off';
  assert.match((await t.vcmd({ t: 'vstart' })).error, /agente no está disponible/);
});
