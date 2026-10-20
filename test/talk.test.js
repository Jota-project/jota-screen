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

function make({ ensure = true, media = 0, turnIdleMs, slowEnsure = false, finalMs, maxVoiceMs, audioTailMs = 20 } = {}) {
  const subs = new Set(), sent = [], views = [], audio = [], ends = [], bins = [], spk = [];
  const gw = {
    ensure: async () => { if (slowEnsure) await new Promise(r => setTimeout(r, 20)); return ensure; }, send: t => sent.push(t), audio: b => audio.push(b), end: () => ends.push(1), on: fn => { subs.add(fn); return () => subs.delete(fn); },
    emit: ev => subs.forEach(f => f(ev)),
  };
  const view = Object.fromEntries(['turn', 'you', 'jota', 'done', 'error'].map(k => [k, (...a) => views.push([k, ...a])]));
  const speaker = Object.fromEntries(['start', 'write', 'end', 'stop'].map(k => [k, (...a) => spk.push([k, ...a])]));
  const talk = createTalk({ gw, cfg: { NAME: 'Salón', OWNER: 'Alfonso' }, media: () => media, view, speaker, turnIdleMs, finalMs, maxVoiceMs, audioTailMs });
  const msgs = [];
  const ws = { readyState: WebSocket.OPEN, send: s => (Buffer.isBuffer(s) ? bins.push(s) : msgs.push(JSON.parse(s))) };
  const perm = { current: 'full' };
  const cmds = createCommands({ permsOf: dev => PERMS[perm.current] });
  cmds.register(talk.commands);
  const ask = (text, dev = { role: 'admin', name: 'Admin' }, out) => cmds.dispatch({ t: 'ask', text, out }, { dev, ws });
  const vcmd = (m, dev = { role: 'admin', name: 'Admin' }, sock = ws) => cmds.dispatch(m, { dev, ws: sock });
  const tick = () => new Promise(r => setImmediate(r));
  return { gw, talk, sent, views, msgs, ws, perm, ask, tick, audio, ends, vcmd, bins, spk, make: null };
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

// ── la respuesta suena en la tele o en el móvil (nunca en los dos)
const wait = ms => new Promise(r => setTimeout(r, ms));
const pframe = (seq, ...pcm) => Buffer.from([0xA1, seq >> 8, seq & 255, ...pcm]);
const aud = (seq, ...pcm) => ({ type: 'audio', seq, pcm: Buffer.from(pcm), frame: pframe(seq, ...pcm) });

async function turnWith(t, out, via = 'ask') {
  const p = via === 'ask' ? t.ask('hola', undefined, out) : (async () => {
    await t.vcmd({ t: 'vstart', out }); await t.tick(); t.vcmd({ t: 'vend' });
    t.gw.emit({ type: 'final', text: 'hola' }); await t.tick(); return null;
  })();
  await t.tick();
  return p;
}

for (const via of ['ask', 'voz']) {
  test(`out tv (${via}): speaker.start en turn_start, write recibe pcm sin cabecera, end al terminar; el móvil no recibe binario`, async () => {
    const t = make();
    const p = turnWith(t, 'tv', via); await t.tick(); await t.tick();
    t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 5 });
    t.gw.emit(aud(5, 1, 2)); t.gw.emit(aud(5, 3));
    t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' });
    t.gw.emit({ type: 'turn_end', turnId: 'a' });
    await p; await wait(40);                               // la cola del audio vence
    assert.deepEqual(t.spk.map(c => c[0]), ['stop', 'start', 'write', 'write', 'end']);
    assert.deepEqual(t.spk.filter(c => c[0] === 'write').map(c => [...c[1]]), [[1, 2], [3]]);
    assert.equal(t.bins.length, 0, 'nunca los dos');
  });

  test(`out phone (${via}): el móvil recibe el frame entero con 0xA1; la tele no suena`, async () => {
    const t = make();
    const p = turnWith(t, 'phone', via); await t.tick(); await t.tick();
    t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 300 });
    t.gw.emit(aud(300, 7, 8));
    t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' });
    t.gw.emit({ type: 'turn_end', turnId: 'a' });
    await p;
    assert.deepEqual(t.bins.map(b => [...b]), [[0xA1, 1, 44, 7, 8]]);
    assert.equal(t.spk.filter(c => c[0] === 'start' || c[0] === 'write').length, 0, 'nunca los dos');
  });
}

test('out none: ni tele ni móvil', async () => {
  const t = make();
  const p = turnWith(t, 'none'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(aud(1, 1, 2));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.equal(t.bins.length, 0);
  assert.equal(t.spk.filter(c => c[0] === 'start' || c[0] === 'write').length, 0);
});

test('ask sin out (API, MCP) no suena en ningún sitio', async () => {
  const t = make();
  const p = t.ask('hola'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(aud(1, 1, 2));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.equal(t.bins.length, 0);
  assert.equal(t.spk.filter(c => c[0] === 'start' || c[0] === 'write').length, 0);
});

test('un frame con seq de otro turno se descarta; sin turn_start tampoco cuenta', async () => {
  const t = make();
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit(aud(5, 9));                                  // aún sin turn_start
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 5 });
  t.gw.emit(aud(4, 1)); t.gw.emit(aud(5, 2)); t.gw.emit(aud(6, 3));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.deepEqual(t.spk.filter(c => c[0] === 'write').map(c => [...c[1]]), [[2]]);
  const u = make();
  const q = turnWith(u, 'phone'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'a', seq: 5 }); u.gw.emit(aud(4, 1)); u.gw.emit(aud(5, 2));
  u.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); u.gw.emit({ type: 'turn_end', turnId: 'a' });
  await q;
  assert.deepEqual(u.bins.map(b => [...b]), [[0xA1, 0, 5, 2]]);
});

test('el altavoz se corta si el turno falla o se cancela, y un error suyo no tumba el turno', async () => {
  const t = make();
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit({ type: 'down' });
  await p;
  assert.equal(t.spk[t.spk.length - 1][0], 'stop');
  const v = make();
  const q = turnWith(v, 'tv'); await v.tick();
  v.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  v.gw.emit({ type: 'token', turnId: 'a', text: 'x' });
  v.gw.emit({ type: 'turn_error', turnId: 'a' });
  assert.deepEqual(await q, { error: 'Jota no está disponible.' });
  assert.equal(v.spk[v.spk.length - 1][0], 'stop');
});

test('un speaker que lanza no rompe el turno', async () => {
  const subs = new Set();
  const gw = { ensure: async () => true, send() {}, audio() {}, end() {}, on: fn => { subs.add(fn); return () => subs.delete(fn); }, emit: ev => subs.forEach(f => f(ev)) };
  const boom = () => { throw new Error('ENOENT'); };
  const talk = createTalk({ gw, cfg: { NAME: 'S' }, media: () => 0, speaker: { start: boom, write: boom, end: boom, stop: boom } });
  const ws = { readyState: WebSocket.OPEN, send() {} };
  const p = talk.ask('hola', ws, 'full', '', 'tv');
  await new Promise(r => setImmediate(r));
  gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); gw.emit({ type: 'audio', seq: 1, pcm: Buffer.from([1]), frame: pframe(1, 1) });
  gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(await p, { ok: 1, reply: 'ok' });
});

// ── la cola del audio tras turn_end
const kinds = t => t.spk.map(c => c[0]);

test('tv: el audio que llega tras turn_end sigue sonando y speaker.end() solo al vencer la cola', async () => {
  const t = make({ audioTailMs: 30 });
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 3 }); t.gw.emit(aud(3, 1));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.equal(t.talk.busy(), false, 'busy libre en turn_end');
  assert.ok(!kinds(t).includes('end'));
  await wait(15); t.gw.emit(aud(3, 2)); t.gw.emit(aud(4, 9));   // llega tarde (y uno ajeno)
  await wait(20);
  assert.ok(!kinds(t).includes('end'), 'cada frame reinicia la cola');
  assert.deepEqual(t.spk.filter(c => c[0] === 'write').map(c => [...c[1]]), [[1], [2]]);
  await wait(30);
  assert.equal(kinds(t).filter(k => k === 'end').length, 1);
  t.gw.emit(aud(3, 5));
  assert.equal(t.spk.filter(c => c[0] === 'write').length, 2, 'vencida la cola, se descarta');
});

test('phone: el frame que llega tras turn_end sigue yendo al móvil', async () => {
  const t = make({ audioTailMs: 30 });
  const p = turnWith(t, 'phone'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 3 });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  t.gw.emit(aud(3, 7));
  assert.deepEqual(t.bins.map(b => [...b]), [[0xA1, 0, 3, 7]]);
  assert.equal(t.spk.filter(c => c[0] !== 'stop').length, 0);
});

test('un ask nuevo durante la cola corta el altavoz y los frames del seq viejo se descartan', async () => {
  const t = make({ audioTailMs: 500 });
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 3 });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  const n = t.spk.length;
  const q = t.ask('otra', undefined, 'tv'); await t.tick();
  assert.equal(t.spk[n][0], 'stop');
  t.gw.emit(aud(3, 1));
  assert.equal(t.spk.filter(c => c[0] === 'write').length, 0);
  t.gw.emit({ type: 'turn_start', turnId: 'b', seq: 4 }); t.gw.emit({ type: 'token', turnId: 'b', text: 'x' }); t.gw.emit({ type: 'turn_end', turnId: 'b' });
  await q;
  assert.ok(!kinds(t).includes('end'), 'la cola vieja no llama a end');
});
