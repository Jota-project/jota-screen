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

function make({ ensure = true, media = 0, turnIdleMs, slowEnsure = false, finalMs, maxVoiceMs, audioTailMs = 20, playMarginMs, log, noVoiceMs, speakerLatencyMs } = {}) {
  const subs = new Set(), sent = [], views = [], audio = [], ends = [], bins = [], spk = [], cancels = [], voices = [];
  const gw = {
    ensure: async () => { if (slowEnsure) await new Promise(r => setTimeout(r, 20)); return ensure; }, send: t => sent.push(t), audio: b => audio.push(b), end: () => ends.push(1), on: fn => { subs.add(fn); return () => subs.delete(fn); },
    cancel: () => cancels.push(1), emit: ev => subs.forEach(f => f(ev)),
  };
  // la vista falsa avisa de que se oculta como la real: al momento con hide(), y por tiempo cuando la prueba llama a hidden()
  let onHide = () => {};
  const view = Object.fromEntries(['turn', 'you', 'jota', 'done', 'error', 'tool', 'toolEnd'].map(k => [k, (...a) => views.push([k, ...a])]));
  view.hide = () => { views.push(['hide']); onHide(); };
  view.onHide = fn => { onHide = fn; };
  view.voice = x => voices.push(x);                       // la voz sincronizada, aparte: no cambia la secuencia de `views`
  // formato: la vista falsa acepta lo que se le pida y avisa cuando la prueba llama a form()
  let onForm = () => {};
  view.userForm = f => { views.push(['userForm', f]); return f === 'pill' || f === 'panel' ? { ok: 1, form: f } : { error: 'formato no válido' }; };
  view.agentLayout = (l, u) => views.push(['agentLayout', l, u]);
  view.onForm = fn => { onForm = fn; };
  // el altavoz falso avisa de su fin como el real: al momento con stop(); tras end(), cuando la prueba llama a idle()
  let onIdle = () => {};
  const speaker = Object.fromEntries(['start', 'write', 'end', 'stop'].map(k => [k, (...a) => spk.push([k, ...a])]));
  speaker.stop = () => { spk.push(['stop']); onIdle(); };
  speaker.onIdle = fn => { onIdle = fn; };
  const talk = createTalk({ gw, cfg: { NAME: 'Salón', OWNER: 'Alfonso' }, media: () => media, view, speaker, log, turnIdleMs, finalMs, maxVoiceMs, audioTailMs, playMarginMs, noVoiceMs, speakerLatencyMs });
  const msgs = [];
  const ws = { readyState: WebSocket.OPEN, send: s => (Buffer.isBuffer(s) ? bins.push(s) : msgs.push(JSON.parse(s))) };
  const perm = { current: 'full' };
  const cmds = createCommands({ permsOf: dev => PERMS[perm.current] });
  cmds.register(talk.commands);
  const ask = (text, dev = { role: 'admin', name: 'Admin' }, out) => cmds.dispatch({ t: 'ask', text, out }, { dev, ws });
  const vcmd = (m, dev = { role: 'admin', name: 'Admin' }, sock = ws) => cmds.dispatch(m, { dev, ws: sock });
  const tick = () => new Promise(r => setImmediate(r));
  return { gw, talk, sent, views, voices, msgs, ws, perm, ask, tick, audio, ends, vcmd, bins, spk, cancels, idle: () => onIdle(), hidden: () => onHide(), form: (f, can) => onForm(f, can), make: null };
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
  // la tele abre su propio intercambio antes del error: no se mezcla con la conversación anterior
  assert.deepEqual(t.views, [['turn', 'panel', { voice: false }], ['you', 'hola', true], ['error', 'Jota no está disponible.']]);
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
    assert.deepEqual(t.views[0], ['turn', mode, { voice: false }]);
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
  assert.deepEqual(t.views[0], ['turn', 'panel', { voice: true }]);
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
  assert.deepEqual(t.msgs.slice(-2), [{ t: 'talk', ev: 'done', reply: 'Hecho.' }, { t: 'talk', ev: 'silent' }], 'sin audio: silent al momento');
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

test('cancelar sin final y empezar otra grabación: su final dentro de la ventana no se descarta', async () => {
  const t = make({ finalMs: 5000 });
  await t.vcmd({ t: 'vstart' });
  await t.vcmd({ t: 'vcancel' });                          // sin habla: el Gateway no emite final vacía
  await t.vcmd({ t: 'vstart' });
  t.gw.emit({ type: 'partial', text: 'ho' });
  await t.vcmd({ t: 'vend' });
  t.gw.emit({ type: 'final', text: 'hola' });
  assert.equal(t.sent.length, 1);
  assert.ok(t.sent[0].endsWith('hola'));
});

test('turno que acaba sin respuesta: «No he recibido respuesta.»', async () => {
  const t = make();
  const p = t.ask('hola');
  await sleep(5);
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(await p, { error: 'No he recibido respuesta.' });
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'error', error: 'No he recibido respuesta.' });
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

// ── el panel espera al audio; Parar, Quitar de la tele e interrumpir con el orbe
const BUSY_R = { error: 'Sigo con la petición anterior. Espera un momento.' };
const vk = t => t.views.map(v => v[0]);
/** Frame con `bytes` bytes de PCM (bytes / 2 muestras a 24 kHz). */
const audN = (seq, bytes) => { const pcm = Buffer.alloc(bytes, 1); return { type: 'audio', seq, pcm, frame: Buffer.concat([Buffer.from([0xA1, seq >> 8, seq & 255]), pcm]) }; };

test('tv: view.done llega cuando el altavoz termina de vaciar (onIdle tras end), no en turn_end', async () => {
  const t = make({ audioTailMs: 20 });
  const p = t.ask('hola', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 5 });
  t.gw.emit(aud(5, 1, 2));
  assert.equal(t.talk.speaking(), true, 'habla desde el primer frame');
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(await p, { ok: 1, reply: 'ok' });
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'done', reply: 'ok' }, 'el móvil recibe done con el texto');
  assert.equal(t.talk.busy(), false);
  assert.ok(!vk(t).includes('done'), 'la tele aún no');
  await wait(40);
  assert.ok(kinds(t).includes('end'));
  assert.ok(!vk(t).includes('done'), 'end no basta: falta que vacíe');
  assert.equal(t.talk.speaking(), true);
  t.idle();
  assert.equal(vk(t).at(-1), 'done');
  assert.equal(t.talk.speaking(), false);
  t.idle();
  assert.equal(vk(t).filter(k => k === 'done').length, 1, 'una sola vez');
});

test('phone: view.done tras la duración estimada del audio (muestras / 24000 s + margen)', async () => {
  const t = make({ audioTailMs: 20, playMarginMs: 20 });
  const p = t.ask('hola', undefined, 'phone'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 5 });
  t.gw.emit(audN(5, 4800)); t.gw.emit(audN(5, 4800));    // 2 × 2400 muestras = 200 ms
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.equal(t.bins.length, 2);
  assert.ok(!vk(t).includes('done'));
  await wait(120);
  assert.ok(!vk(t).includes('done'), 'aún suena en el móvil');
  assert.equal(t.talk.speaking(), true);
  await wait(160);
  assert.equal(vk(t).at(-1), 'done');
  assert.equal(t.talk.speaking(), false);
});

test('none (o sin audio): view.done en turn_end y nunca habla', async () => {
  const t = make();
  const p = t.ask('hola', undefined, 'none'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(aud(1, 1, 2));
  assert.equal(t.talk.speaking(), false);
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.equal(vk(t).at(-1), 'done');
  const u = make();
  const q = u.ask('hola', undefined, 'tv'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); u.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); u.gw.emit({ type: 'turn_end', turnId: 'a' });
  await q;
  assert.equal(vk(u).at(-1), 'done', 'tv sin audio: en turn_end');
  assert.equal(u.talk.speaking(), false);
});

test('stop con turno en vuelo: gw.cancel, ev:stopped, ask {error:"Parado."}, altavoz cortado y vista oculta; el turn_end posterior no hace nada', async () => {
  const t = make();
  const p = t.ask('hola', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit(aud(1, 1)); t.gw.emit({ type: 'token', turnId: 'a', text: 'Ho' });
  const n = t.spk.length;
  assert.deepEqual(await t.vcmd({ t: 'stop' }), { ok: 1 });
  assert.equal(t.cancels.length, 1);
  assert.deepEqual(await p, { error: 'Parado.' });
  assert.equal(t.talk.busy(), false);
  assert.equal(t.talk.speaking(), false);
  assert.ok(t.spk.slice(n).some(c => c[0] === 'stop'));
  assert.equal(vk(t).at(-1), 'hide');
  assert.deepEqual(t.msgs.slice(-2), [{ t: 'talk', ev: 'stopped' }, { t: 'talk', ev: 'hidden' }]);
  const views = t.views.length, msgs = t.msgs.length, writes = t.spk.filter(c => c[0] === 'write').length;
  t.gw.emit(aud(1, 2)); t.gw.emit({ type: 'token', turnId: 'a', text: 'la' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.equal(t.views.length, views, 'ni done ni nada en la tele');
  assert.equal(t.msgs.length, msgs, 'ni mensajes al móvil');
  assert.equal(t.spk.filter(c => c[0] === 'write').length, writes, 'ni más audio');
});

test('stop mientras Jota aún habla (turno acabado): corta el audio y oculta, sin gw.cancel; sin nada, solo oculta', async () => {
  const t = make({ audioTailMs: 500 });
  const p = t.ask('hola', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(aud(1, 1));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.equal(t.talk.speaking(), true);
  assert.deepEqual(await t.vcmd({ t: 'stop' }), { ok: 1 });
  assert.equal(t.cancels.length, 0);
  assert.equal(t.talk.speaking(), false);
  assert.equal(kinds(t).at(-1), 'stop');
  assert.equal(vk(t).at(-1), 'hide');
  assert.ok(t.msgs.some(m => m.ev === 'stopped'), 'el móvil que preguntó para su audio');
  t.gw.emit(aud(1, 2));
  assert.equal(t.spk.filter(c => c[0] === 'write').length, 1, 'la cola ya no suena');
  const u = make();
  assert.deepEqual(await u.vcmd({ t: 'stop' }), { ok: 1 });
  assert.deepEqual(vk(u), ['hide']);
  assert.equal(u.cancels.length, 0);
});

test('hide: oculta al momento y el móvil que preguntó recibe ev:hidden (también cuando se oculta por tiempo)', async () => {
  const t = make();
  const p = t.ask('hola'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  t.hidden();                                              // la vista se oculta por tiempo
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'hidden' });
  const n = t.msgs.length;
  assert.deepEqual(await t.vcmd({ t: 'hide' }, undefined, other()), { ok: 1 });
  assert.equal(vk(t).at(-1), 'hide');
  assert.deepEqual(t.msgs.slice(n), [{ t: 'talk', ev: 'hidden' }], 'al móvil que preguntó, aunque lo quite otro');
});

test('vstart con interrupt durante un turno: lo para (sin ocultar) y empieza la grabación nueva', async () => {
  const t = make();
  const p = t.ask('uno', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'x' });
  assert.deepEqual(await t.vcmd({ t: 'vstart', out: 'tv', interrupt: true }), { ok: 1 });
  assert.equal(t.cancels.length, 1);
  assert.deepEqual(await p, { error: 'Parado.' });
  assert.ok(!t.msgs.some(m => m.ev === 'stopped'), 'el mismo móvil que interrumpe no recibe stopped');
  assert.ok(!vk(t).includes('hide'), 'el turno nuevo pinta encima');
  assert.equal(vk(t).at(-1), 'turn');
  assert.equal(t.talk.busy(), true, 'busy es del turno nuevo');
  t.talk.onBinary(frame(4), t.ws);
  assert.equal(t.audio.length, 1, 'el audio nuevo va al Gateway');
  t.gw.emit({ type: 'turn_end', turnId: 'a' });           // el cierre del cancelado
  await t.vcmd({ t: 'vend' });
  t.gw.emit({ type: 'final', text: 'dos' });
  assert.ok(t.sent.at(-1).endsWith('dos'));
});

test('vstart con interrupt mientras Jota habla corta el audio; sin interrupt: BUSY y el audio sigue', async () => {
  const t = make({ audioTailMs: 500 });
  const p = t.ask('uno', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(aud(1, 1));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  const n = t.spk.length;
  assert.deepEqual(await t.vcmd({ t: 'vstart', out: 'tv' }), BUSY_R);
  assert.deepEqual(await t.vcmd({ t: 'ask', text: 'otra', out: 'tv' }), BUSY_R, 'el escrito, igual');
  assert.equal(t.spk.length, n, 'el altavoz no se toca');
  t.gw.emit(aud(1, 2));
  assert.equal(t.spk.filter(c => c[0] === 'write').length, 2, 'el audio sigue');
  assert.equal(t.talk.speaking(), true);
  assert.deepEqual(await t.vcmd({ t: 'vstart', out: 'tv', interrupt: true }), { ok: 1 });
  assert.equal(t.talk.speaking(), false);
  assert.ok(t.spk.slice(n).some(c => c[0] === 'stop'));
  assert.equal(t.cancels.length, 0, 'sin turno en vuelo no hay nada que cancelar');
  assert.equal(t.talk.busy(), true);
  t.talk.onBinary(frame(4), t.ws);
  assert.equal(t.audio.length, 1);
  t.gw.emit(aud(1, 3));
  assert.equal(t.spk.filter(c => c[0] === 'write').length, 2, 'la cola vieja ya no suena');
});

test('sin interrupt durante un turno: BUSY y el turno sigue con su audio', async () => {
  const t = make();
  const p = t.ask('uno', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  assert.deepEqual(await t.vcmd({ t: 'vstart', out: 'tv', interrupt: false }), BUSY_R);
  assert.equal(t.cancels.length, 0);
  t.gw.emit(aud(1, 1));
  assert.equal(t.spk.filter(c => c[0] === 'write').length, 1);
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.deepEqual(await p, { ok: 1, reply: 'ok' });
});

test('un invitado no para ni interrumpe el turno de otro dispositivo; el suyo sí', async () => {
  const t = make();
  const p = t.ask('uno', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.perm.current = 'guest';
  const ana = { role: 'guest', name: 'Ana' }, sock = other();
  assert.deepEqual(await t.vcmd({ t: 'stop' }, ana, sock), BUSY_R);
  assert.deepEqual(await t.vcmd({ t: 'vstart', out: 'tv', interrupt: true }, ana, sock), BUSY_R);
  assert.deepEqual(await t.vcmd({ t: 'ask', text: 'dos', interrupt: true }, ana, sock), BUSY_R);
  assert.equal(t.cancels.length, 0);
  assert.equal(t.talk.busy(), true);
  assert.ok(!vk(t).includes('hide'));
  // el móvil que preguntó sí, aunque sea invitado
  assert.deepEqual(await t.vcmd({ t: 'stop' }, ana), { ok: 1 });
  assert.deepEqual(await p, { error: 'Parado.' });
  // y un dispositivo con el agente completo, el de cualquiera
  t.perm.current = 'full';
  const q = t.ask('tres', undefined, 'tv'); await t.tick();
  assert.deepEqual(await t.vcmd({ t: 'stop' }, undefined, other()), { ok: 1 });
  assert.deepEqual(await q, { error: 'Parado.' });
});

test('ask con interrupt tras un turno aún sin turn_start: el turn_start y turn_end tardíos del cancelado no se quedan el turno nuevo', async () => {
  const t = make();
  const p = t.ask('uno'); await t.tick();
  const q = t.vcmd({ t: 'ask', text: 'dos', interrupt: true }); await t.tick();
  assert.deepEqual(await p, { error: 'Parado.' });
  assert.equal(t.cancels.length, 1);
  assert.equal(t.sent.length, 2);
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'turn_end', turnId: 'a' });   // el cancelado
  assert.equal(t.talk.busy(), true);
  t.gw.emit({ type: 'turn_start', turnId: 'b', seq: 2 }); t.gw.emit({ type: 'token', turnId: 'b', text: 'dos' }); t.gw.emit({ type: 'turn_end', turnId: 'b' });
  assert.deepEqual(await q, { ok: 1, reply: 'dos' });
  // con el id ya conocido: su turn_end se ignora por id
  const u = make();
  const r = u.ask('uno'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); u.gw.emit({ type: 'token', turnId: 'a', text: 'x' });
  const s2 = u.vcmd({ t: 'ask', text: 'dos', interrupt: true }); await u.tick();
  await r;
  u.gw.emit({ type: 'turn_end', turnId: 'a' });
  u.gw.emit({ type: 'turn_start', turnId: 'b', seq: 2 }); u.gw.emit({ type: 'token', turnId: 'b', text: 'bien' }); u.gw.emit({ type: 'turn_end', turnId: 'b' });
  assert.deepEqual(await s2, { ok: 1, reply: 'bien' });
});

// ── ronda de arreglos: interrumpir escribiendo, «silent» y el móvil anterior de la tele
test('interrumpir desde el mismo móvil no le manda ev:stopped (al dueño de otro móvil sí)', async () => {
  const t = make();
  const p = t.ask('uno', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'x' });
  const q = t.vcmd({ t: 'ask', text: 'dos', out: 'tv', interrupt: true }); await t.tick();
  assert.deepEqual(await p, { error: 'Parado.' });
  assert.ok(!t.msgs.some(m => m.ev === 'stopped'), 'el que interrumpe no recibe stopped');
  await t.vcmd({ t: 'vstart', out: 'tv', interrupt: true });
  assert.ok(!t.msgs.some(m => m.ev === 'stopped'), 'tampoco por voz');
  t.gw.emit({ type: 'turn_end', turnId: 'b' });
  void q;
  // otro móvil (agente completo) interrumpe el turno de t.ws: t.ws sí recibe stopped
  const u = make();
  const r = u.ask('uno', undefined, 'tv'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  const omsgs = [], sock = { readyState: WebSocket.OPEN, send: s => omsgs.push(JSON.parse(s)) };
  await u.vcmd({ t: 'vstart', out: 'tv', interrupt: true }, undefined, sock);
  await r;
  assert.ok(u.msgs.some(m => m.ev === 'stopped'));
  assert.ok(!omsgs.some(m => m.ev === 'stopped'));
});

test('ev:silent al móvil cuando Jota deja de hablar: tras onIdle (tv), tras la estimación (phone), en turn_end sin audio; none no', async () => {
  const t = make({ audioTailMs: 20 });
  const p = t.ask('hola', undefined, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(aud(1, 1, 2));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p; await wait(40);
  assert.ok(!t.msgs.some(m => m.ev === 'silent'), 'aún vaciando');
  t.idle();
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'silent' });
  const u = make({ audioTailMs: 20, playMarginMs: 20 });
  const q = u.ask('hola', undefined, 'phone'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); u.gw.emit(audN(1, 4800));
  u.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); u.gw.emit({ type: 'turn_end', turnId: 'a' });
  await q;
  assert.ok(!u.msgs.some(m => m.ev === 'silent'));
  await wait(200);
  assert.deepEqual(u.msgs.at(-1), { t: 'talk', ev: 'silent' });
  const w = make();
  const r = w.ask('hola', undefined, 'tv'); await w.tick();
  w.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); w.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); w.gw.emit({ type: 'turn_end', turnId: 'a' });
  await r;
  assert.deepEqual(w.msgs.slice(-2), [{ t: 'talk', ev: 'done', reply: 'ok' }, { t: 'talk', ev: 'silent' }], 'tv sin audio: al momento');
  const n = make();
  const s2 = n.ask('hola', undefined, 'none'); await n.tick();
  n.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); n.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); n.gw.emit({ type: 'turn_end', turnId: 'a' });
  await s2;
  assert.ok(!n.msgs.some(m => m.ev === 'silent'));
});

test('cuando otro móvil abre un intercambio en la tele, el anterior recibe ev:hidden', async () => {
  const t = make();
  const p = t.ask('uno'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  const omsgs = [], sock = { readyState: WebSocket.OPEN, send: s => omsgs.push(JSON.parse(s)) };
  t.vcmd({ t: 'ask', text: 'dos' }, undefined, sock); await t.tick();
  assert.deepEqual(t.msgs.at(-1), { t: 'talk', ev: 'hidden' });
  const n = t.msgs.length;
  t.vcmd({ t: 'stop' }, undefined, sock); await t.tick();
  t.vcmd({ t: 'ask', text: 'tres' }, undefined, sock); await t.tick();
  assert.equal(t.msgs.length, n, 'el mismo móvil otra vez: nada al anterior');
});

// ───────── llamadas a herramientas (tool_call del Gateway, traducido a {type:'tool'} en gateway/client.js)

/** Logs capturados: lo que se registra no puede llevar args, resultados ni texto de la conversación. */
function logs() { const lines = []; const put = (...a) => lines.push(a.map(String).join(' ')); return { lines, log: { info: put, warn: put } }; }
const toolEv = (phase, o = {}) => ({ type: 'tool', turnId: 'a', phase, id: 'c1', name: 'tv-canvas__tv_volume', ...(phase === 'start' ? { args: { action: 'set', level: 30 } } : { ok: true }), ...o });

test('tool con ficha: la vista recibe tool al start y toolEnd al end; y la ficha sale de agent-ui', async () => {
  const t = make();
  const p = t.ask('baja el volumen'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit(toolEv('start'));
  t.gw.emit(toolEv('end', { ok: false }));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Listo.' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.deepEqual(t.views.filter(v => v[0] === 'tool' || v[0] === 'toolEnd'), [
    ['tool', { id: 'c1', kind: 'volume', title: 'Volumen', detail: 'Volumen 30 %' }],
    ['toolEnd', { id: 'c1', ok: false }],
  ]);
  assert.ok(!t.msgs.some(m => m.ev === 'tool'), 'al móvil no se le manda nada nuevo');
});

test('tool sin ficha: nada a la vista y el log lleva solo el nombre saneado (ni args ni resultado)', async () => {
  const { lines, log } = logs();
  const t = make({ log });
  const p = t.ask('qué hay en la tele'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit(toolEv('start', { name: 'tv_state\n<b>', args: { secreto: 'clave-xyz' } }));
  t.gw.emit(toolEv('end', { name: 'tv_state' }));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Una peli.' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  await p;
  assert.ok(!t.views.some(v => v[0] === 'tool' || v[0] === 'toolEnd'));
  assert.deepEqual(lines, ['talk: herramienta sin ficha tv_stateb']);
  assert.doesNotMatch(lines.join('\n'), /clave-xyz|qué hay|Una peli/);
});

test('tool de otro turno, de un turno parado (fantasma) o sin turno enviado: se ignora', async () => {
  const t = make();
  t.gw.emit(toolEv('start'));                                  // sin turno nuestro (un push)
  const p = t.ask('uno'); await t.tick();
  t.gw.emit(toolEv('start'));                                  // aún sin turn_start: no es del turno
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit(toolEv('start', { turnId: 'b' }));                 // de otro turno
  t.vcmd({ t: 'stop' }); await p;                              // parado: «a» pasa a fantasma
  const q = t.ask('dos'); await t.tick();
  t.gw.emit(toolEv('start'));                                  // lo que quede del parado
  t.gw.emit({ type: 'turn_start', turnId: 'c', seq: 2 });
  t.gw.emit(toolEv('start', { turnId: 'c', id: 'c9' }));
  t.gw.emit(toolEv('end', { turnId: 'c', id: 'otro' }));       // end de una llamada sin ficha: no llega
  t.gw.emit({ type: 'token', turnId: 'c', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'c' });
  await q;
  assert.deepEqual(t.views.filter(v => v[0] === 'tool' || v[0] === 'toolEnd').map(v => v[1].id), ['c9']);
});

test('parado antes de su turn_start: las herramientas del fantasma no llegan a la vista; las del turno nuestro sí, antes del texto', async () => {
  const tools = t => t.views.filter(v => v[0] === 'tool' || v[0] === 'toolEnd');
  // el fantasma (g) trae una herramienta que falla y acaba sin respuesta; luego llega el nuestro (b)
  const t = make();
  const p = t.ask('uno'); await t.tick();
  t.vcmd({ t: 'stop' }); await p;                              // sin turn_start: el siguiente puede ser el suyo
  const q = t.ask('dos'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'g', seq: 1 });
  t.gw.emit(toolEv('start', { turnId: 'g', id: 'g1', name: 'tv_open', args: { url: 'https://youtube.com' } }));
  t.gw.emit(toolEv('end', { turnId: 'g', id: 'g1', ok: false }));
  t.gw.emit({ type: 'turn_end', turnId: 'g' });
  t.gw.emit({ type: 'turn_start', turnId: 'b', seq: 2 });
  t.gw.emit({ type: 'token', turnId: 'b', text: 'Hecho.' }); t.gw.emit({ type: 'turn_end', turnId: 'b' });
  assert.deepEqual(await q, { ok: 1, reply: 'Hecho.' });
  assert.deepEqual(tools(t), [], 'ni la ficha ni su fallo');
  // el turn_start sí era el nuestro: lo retenido sale con el primer token, en orden y antes de la respuesta
  const u = make();
  const r = u.ask('uno'); await u.tick();
  u.vcmd({ t: 'stop' }); await r;
  const w = u.ask('dos'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'b', seq: 1 });
  u.gw.emit(toolEv('start', { turnId: 'b' })); u.gw.emit(toolEv('end', { turnId: 'b' }));
  assert.deepEqual(tools(u), [], 'aún puede ser el parado');
  u.gw.emit({ type: 'token', turnId: 'b', text: '' });         // un token vacío no confirma nada
  assert.deepEqual(tools(u), []);
  u.gw.emit({ type: 'token', turnId: 'b', text: 'Listo.' }); u.gw.emit({ type: 'turn_end', turnId: 'b' });
  assert.deepEqual(await w, { ok: 1, reply: 'Listo.' });
  const after = u.views.slice(u.views.findIndex(v => v[0] === 'tool'));
  assert.deepEqual(after.slice(0, 3).map(v => v[0]), ['tool', 'toolEnd', 'jota'], 'fichas delante del texto');
  assert.deepEqual(after[1], ['toolEnd', { id: 'c1', ok: true }]);
});

test('un tool del turno rearma el plazo sin eventos (arm), como un token', async () => {
  const t = make({ turnIdleMs: 60 });
  const p = t.ask('hola'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 30)); t.gw.emit(toolEv('start', { id: 'c' + i })); }
  assert.equal(t.talk.busy(), true, '120 ms con tools cada 30: sigue vivo');
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
  assert.equal((await p).ok, 1);
});

// ───────── formato de la capa en la tele (ronda 3): talkform, ev:'form' y el `layout` que pide Jota

test('talkform: con permiso agent y solo quien puede parar (el móvil que preguntó o el agente completo); sin turno, cualquiera', async () => {
  const t = make();
  assert.deepEqual(await t.vcmd({ t: 'talkform', form: 'panel' }, undefined, other()), { ok: 1, form: 'panel' }, 'sin nada en vuelo');
  const p = t.ask('hola'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.perm.current = 'guest';
  assert.deepEqual(await t.vcmd({ t: 'talkform', form: 'pill' }, { role: 'guest', name: 'Ana' }, other()), BUSY_R, 'otro móvil invitado: no');
  assert.deepEqual(await t.vcmd({ t: 'talkform', form: 'pill' }, { role: 'guest', name: 'Ana' }), { ok: 1, form: 'pill' }, 'el que preguntó: sí');
  t.perm.current = 'full';
  assert.deepEqual(await t.vcmd({ t: 'talkform', form: 'panel' }, undefined, other()), { ok: 1, form: 'panel' }, 'agente completo: sí');
  assert.deepEqual(await t.vcmd({ t: 'talkform', form: 'gigante' }), { error: 'formato no válido' });
  t.perm.current = 'off';
  assert.ok((await t.vcmd({ t: 'talkform', form: 'pill' })).error, 'sin permiso agent: no');
  assert.deepEqual(t.views.filter(v => v[0] === 'userForm').map(v => v[1]), ['panel', 'pill', 'panel', 'gigante']);
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
});

test('ev:form al móvil que preguntó cuando la tele cambia de formato (y canSwitch false al cerrarse)', async () => {
  const t = make();
  const p = t.ask('hola'); await t.tick();
  t.form('panel', true); t.form('pill', true); t.form('pill', false);
  assert.deepEqual(t.msgs.filter(m => m.ev === 'form'), [
    { t: 'talk', ev: 'form', form: 'panel', canSwitch: true }, { t: 'talk', ev: 'form', form: 'pill', canSwitch: true },
    { t: 'talk', ev: 'form', form: 'pill', canSwitch: false }]);
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
});

test('tool_call de tv_open / tv_open_app con layout: la vista recibe agentLayout con la página que se abre; sin layout, nada', async () => {
  const t = make();
  const p = t.ask('enséñame las fotos'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit(toolEv('start', { id: 'o1', name: 'tv-canvas__tv_open', args: { url: 'fotos.example/album', layout: 'pill' } }));
  t.gw.emit(toolEv('start', { id: 'o2', name: 'tv_open_app', args: { app: 'netflix', layout: 'panel' } }));
  t.gw.emit(toolEv('start', { id: 'o3', name: 'tv_open', args: { url: 'https://x.example/' } }));
  t.gw.emit(toolEv('start', { id: 'o4', name: 'tv_open', args: { url: 'https://x.example/', layout: 'grande' } }));
  t.gw.emit(toolEv('start', { id: 'o5', name: 'tv_volume', args: { action: 'up', layout: 'pill' } }));
  t.gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
  assert.deepEqual(t.views.filter(v => v[0] === 'tool').map(v => [v[1].id, v[1].opens === true]),
    [['o1', true], ['o2', true], ['o3', true], ['o4', true], ['o5', false]], 'opens: la ficha pone otra página');
  assert.deepEqual(t.views.filter(v => v[0] === 'agentLayout'), [
    ['agentLayout', 'pill', 'https://fotos.example/album'], ['agentLayout', 'panel', 'https://www.netflix.com/']]);
});

test('el móvil del intercambio se reconecta (otra conexión, mismo dispositivo): recibe el formato al conectarse, lo sigue recibiendo y puede cambiarlo', async () => {
  /** Conexión de un móvil (devId: su dispositivo; sin él, el token maestro). @param {string} [devId] */
  const sock = devId => { const msgs = []; return { readyState: WebSocket.OPEN, devId, msgs, send: x => msgs.push(JSON.parse(x)) }; };
  const subs = new Set();
  const gw = { ensure: async () => true, send() {}, audio() {}, end() {}, cancel() {}, on: f => { subs.add(f); return () => subs.delete(f); }, emit: ev => subs.forEach(f => f(ev)) };
  let onForm = () => {}, can = true, now = 'panel';
  const view = { turn() {}, you() {}, jota() {}, done() {}, error() {}, onForm: fn => { onForm = fn; }, form: () => ({ form: now, canSwitch: can }),
    userForm: f => ({ ok: 1, form: f }) };
  const talk = createTalk({ gw, cfg: { NAME: 'S' }, media: () => 0, view });
  const cmds = createCommands({ permsOf: () => PERMS.guest }); cmds.register(talk.commands);
  const guest = { role: 'guest', name: 'Ana' };
  const A = sock('d1');
  const p = cmds.dispatch({ t: 'ask', text: 'pon netflix' }, { dev: guest, ws: A });
  await new Promise(r => setImmediate(r));
  gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  onForm('panel', true);
  A.readyState = WebSocket.CLOSED; talk.onClose(A);   // bloquea la pantalla / cambia de red
  const B = sock('d1'), C = sock('d2'), M = sock();
  assert.deepEqual(talk.greet(C), [], 'otro dispositivo: nada');
  assert.deepEqual(talk.greet(M), [], 'token maestro (sin dispositivo): nunca es «el mismo»');
  assert.deepEqual(talk.greet(B), [{ t: 'talk', ev: 'form', form: 'panel', canSwitch: true }], 'al reconectarse, el formato');
  now = 'pill'; onForm('pill', true);
  assert.deepEqual(B.msgs.filter(m => m.ev === 'form'), [{ t: 'talk', ev: 'form', form: 'pill', canSwitch: true }], 'los cambios llegan a la conexión nueva');
  assert.deepEqual(await cmds.dispatch({ t: 'talkform', form: 'panel' }, { dev: guest, ws: B }), { ok: 1, form: 'panel' }, 'reconectado, puede cambiarlo');
  assert.deepEqual(await cmds.dispatch({ t: 'talkform', form: 'panel' }, { dev: guest, ws: C }), BUSY_R, 'otro móvil invitado, no');
  can = false;
  assert.deepEqual(talk.greet(sock('d1')), [], 'la tele ya no deja cambiarlo: nada que mandar');
  gw.emit({ type: 'token', turnId: 'a', text: 'ok' }); gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
});

// ───────── voz y texto sincronizados (voice-sync.js): la vista y el móvil reciben `voice` solo cuando cambia
/** PCM16 LE 24 kHz: seno a 220 Hz con amplitud 0,3 (voz) o ceros (silencio). @param {number} ms @param {boolean} on */
const tone = (ms, on) => { const n = ms * 24, b = Buffer.alloc(n * 2); if (on) for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 220 * i / 24000)), i * 2); return b; };
const audPcm = (seq, pcm) => ({ type: 'audio', seq, pcm, frame: Buffer.concat([Buffer.from([0xA1, seq >> 8, seq & 255]), pcm]) });
const vmsgs = t => t.msgs.filter(m => m.ev === 'voice');

test('voz out tv: en espera desde turn_start (sin anclas), luego anclas del audio; la vista y el móvil reciben lo mismo', async () => {
  const t = make({ audioTailMs: 500 });
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  assert.equal(t.voices.length, 1);
  assert.deepEqual([t.voices[0].anchors, t.voices[0].head, t.voices[0].upto], [[], 0, 0], 'en espera: la tele aún no enseña la respuesta');
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Hola. Qué tal.' });
  t.gw.emit(audPcm(1, Buffer.concat([tone(300, true), tone(300, false), tone(400, true)])));
  const v = t.voices.at(-1);
  assert.deepEqual(v.anchors, [[0, 0], [300, 5], [600, 6]]);
  assert.deepEqual([v.upto, v.text, v.rate], [1000, 14, 62]);
  assert.ok(v.head < 0 && v.head >= -150, 'aún no suena: la latencia del altavoz por delante');
  assert.deepEqual(vmsgs(t).at(-1), { t: 'talk', ev: 'voice', ...v }, 'el móvil, lo mismo');
  t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
  t.idle();                                                 // no ha vaciado: aún suena
  await wait(520); t.idle();
  assert.equal(t.voices.at(-1), null, 'acaba de sonar: null');
  assert.deepEqual(vmsgs(t).at(-1), { t: 'talk', ev: 'voice', end: true });
});

test('voz: un trozo de audio no es un mensaje (solo anclas nuevas, cambio de rate o atasco)', async () => {
  const t = make({ audioTailMs: 500 });
  const p = turnWith(t, 'phone'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Una frase larga sin pausas que dura un buen rato.' });
  for (let i = 0; i < 50; i++) t.gw.emit(audPcm(1, tone(40, true)));   // 2 s en 50 trozos
  assert.equal(t.bins.length, 50);
  assert.deepEqual(t.voices.map(v => v.anchors.length), [0, 1], 'en espera y el arranque');
  assert.equal(vmsgs(t).length, 2);
  t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
});

test('voz out none (o sin out): ni la vista ni el móvil reciben voice', async () => {
  for (const out of ['none', undefined]) {
    const t = make();
    const p = t.ask('hola', undefined, out); await t.tick();
    t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); t.gw.emit(audPcm(1, tone(400, true)));
    t.gw.emit({ type: 'token', turnId: 'a', text: 'Hola.' }); t.gw.emit({ type: 'turn_end', turnId: 'a' });
    await p;
    assert.deepEqual([t.voices, vmsgs(t)], [[], []]);
  }
});

test('voz: tras un stop vuelve a null (y el móvil recibe end)', async () => {
  const t = make();
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Hola.' }); t.gw.emit(audPcm(1, tone(400, true)));
  assert.equal(t.voices.at(-1).anchors.length, 1);
  await t.vcmd({ t: 'stop' }); await p;
  assert.equal(t.voices.at(-1), null);
  assert.equal(vmsgs(t).filter(m => m.end).length, 1, 'una vez');
  // interrumpir con otra pregunta, igual
  const u = make();
  const q = turnWith(u, 'tv'); await u.tick();
  u.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 }); u.gw.emit({ type: 'token', turnId: 'a', text: 'Ho' });
  u.vcmd({ t: 'ask', text: 'otra', out: 'tv', interrupt: true }); await u.tick(); await q;
  assert.equal(u.voices.at(-1), null);
});

test('voz: sin audio en noVoiceMs tras el primer token, null (y todo sigue como siempre)', async () => {
  const t = make({ noVoiceMs: 30, audioTailMs: 500 });
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  await wait(50);
  assert.notEqual(t.voices.at(-1), null, 'el plazo cuenta desde el primer token');
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Hola.' });
  await wait(50);
  assert.equal(t.voices.at(-1), null);
  t.gw.emit(audPcm(1, tone(400, true)));
  assert.equal(t.voices.at(-1), null, 'el audio que llega tarde ya no la enciende');
  t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
});

test('voz: con audio a tiempo no hay plazo que la apague; un atasco se avisa al llegar el trozo siguiente', async () => {
  const t = make({ noVoiceMs: 30, audioTailMs: 2000, speakerLatencyMs: 0 });
  const p = turnWith(t, 'tv'); await t.tick();
  t.gw.emit({ type: 'turn_start', turnId: 'a', seq: 1 });
  t.gw.emit({ type: 'token', turnId: 'a', text: 'Hola, ¿qué tal estás hoy por aquí?' });
  t.gw.emit(audPcm(1, tone(100, true)));
  const n = t.voices.length;
  await wait(400);                                         // 100 ms de audio: el altavoz se queda sin nada
  assert.notEqual(t.voices.at(-1), null);
  t.gw.emit(audPcm(1, tone(100, true)));
  assert.equal(t.voices.length, n + 1, 'se reanuda: aviso');
  const v = t.voices.at(-1);
  assert.equal(v.upto, 200);
  assert.ok(v.head >= 100 && v.head < 150, 'la cabeza sigue donde se quedó, no corrida por el atasco');
  t.gw.emit({ type: 'turn_end', turnId: 'a' }); await p;
});
