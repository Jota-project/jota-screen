'use strict';
// Cliente del J Gateway (remote/src/gateway/client.js) contra un Gateway falso: handshake, ready, audio en cola,
// traducción de mensajes, cierre inesperado y órdenes de salida.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocketServer } = require(path.join(__dirname, '..', 'remote', 'node_modules', 'ws'));
const { createGatewayClient } = require(path.join(__dirname, '..', 'remote', 'src', 'gateway', 'client'));

const HANDSHAKE = { client_key: 'k', input_mode: 'audio', output_mode: ['audio', 'text', 'status'], agent: 'j-assistant' };
const nolog = { info() {}, warn() {}, error() {}, debug() {} };

/** Gateway falso: guarda lo que recibe y deja que cada prueba decida qué contesta. @param {(ws: any, n: number) => void} [onConn] */
async function fake(onConn) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  const f = { wss, conns: [], got: [], url: `ws://127.0.0.1:${wss.address().port}/ws/stream` };
  wss.on('connection', ws => {
    f.conns.push(ws);
    ws.on('message', (d, bin) => f.got.push(bin ? d : JSON.parse(d.toString())));
    if (onConn) onConn(ws, f.conns.length);
  });
  f.stop = async () => { for (const c of wss.clients) c.terminate(); await new Promise(r => wss.close(r)); };
  return f;
}
const ready = ws => ws.send(JSON.stringify({ type: 'ready', session_id: 's', agent: 'j-assistant' }));
const mk = (f, o = {}) => createGatewayClient({ url: f.url, key: 'k', agent: 'j-assistant', log: nolog, ...o });
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };

test('ensure() manda el handshake y resuelve true con ready', async () => {
  const f = await fake(ws => { ws.send(JSON.stringify({ type: 'status', service: 'tts', state: 'unavailable' })); setTimeout(() => ready(ws), 20); });
  const c = mk(f);
  try {
    assert.equal(c.isReady(), false);
    const [a, b] = await Promise.all([c.ensure(), c.ensure()]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(f.conns.length, 1, 'un ensure en curso se comparte');
    assert.deepEqual(f.got[0], HANDSHAKE);
    assert.equal(c.isReady(), true);
    assert.equal(await c.ensure(), true);
    assert.equal(f.conns.length, 1, 'ya listo: no reconecta');
  } finally { c.close(); await f.stop(); }
});

test('ensure() resuelve false si el Gateway cierra con 1008 o no manda ready en readyMs', async () => {
  const f1 = await fake(ws => ws.close(1008, 'Clave de cliente invalida o inactiva'));
  const c1 = mk(f1);
  const f2 = await fake();
  const c2 = mk(f2, { readyMs: 200 });
  try {
    assert.equal(await c1.ensure(), false);
    assert.equal(c1.isReady(), false);
    const t = Date.now();
    assert.equal(await c2.ensure(), false);
    assert.ok(Date.now() - t >= 150);
    assert.equal(c2.isReady(), false);
  } finally { c1.close(); c2.close(); await f1.stop(); await f2.stop(); }
});

test('el audio enviado antes de ready se guarda y sale en orden; pasado bufferMax se descarta lo más antiguo', async () => {
  let rdy;
  const f = await fake(ws => { rdy = () => ready(ws); });
  const c = mk(f, { bufferMax: 10 });
  try {
    const p = c.ensure();
    await until(() => f.got.length === 1);
    c.audio(Buffer.from('aaaa')); c.audio(Buffer.from('bbbb')); c.audio(Buffer.from('cccc')); // 12 > 10: cae «aaaa»
    assert.equal(f.got.length, 1, 'antes de ready no sale nada');
    rdy();
    assert.equal(await p, true);
    await until(() => f.got.length === 3);
    assert.deepEqual(f.got.slice(1).map(b => b.toString()), ['bbbb', 'cccc']);
    c.audio(Buffer.from('dd'));
    await until(() => f.got.length === 4);
    assert.equal(f.got[3].toString(), 'dd');
  } finally { c.close(); await f.stop(); }
});

test('traduce los mensajes', async () => {
  const f = await fake(ready);
  const c = mk(f);
  const evs = [];
  const off = c.on(e => evs.push(e));
  try {
    await c.ensure();
    const ws = f.conns[0];
    const J = o => ws.send(JSON.stringify(o));
    J({ type: 'transcription_partial', text: 'ho' });
    J({ type: 'transcription', text: 'hola' });
    J({ type: 'turn_start', turn_id: 't-1', turn_seq: 7 });
    J({ type: 'token', turn_id: 't-1', text: 'Vale' });
    J({ type: 'error', code: 'TURN_ERROR', message: 'turn_timeout', fatal: false, turn_id: 't-1' });
    J({ type: 'error', code: 'OTRO', message: 'x' });
    J({ type: 'status', service: 'tts', state: 'degraded' });
    J({ type: 'turn_end', turn_id: 't-1' });
    ws.send(Buffer.from([0xA1, 0x00, 0x07, 1, 2, 3, 4]), { binary: true });
    ws.send(Buffer.from([0xB2, 0x00, 0x07, 1, 2]), { binary: true });
    ws.send(Buffer.from([0xA1, 0x00]), { binary: true });
    J({ type: 'turn_end', turn_id: 't-2' });
    await until(() => evs.length >= 7);
    assert.deepEqual(evs.slice(0, 5), [
      { type: 'partial', text: 'ho' },
      { type: 'final', text: 'hola' },
      { type: 'turn_start', turnId: 't-1', seq: 7 },
      { type: 'token', turnId: 't-1', text: 'Vale' },
      { type: 'turn_error', turnId: 't-1', message: 'turn_timeout' },
    ]);
    assert.deepEqual(evs[5], { type: 'turn_end', turnId: 't-1' });
    assert.equal(evs[6].type, 'audio');
    assert.equal(evs[6].seq, 7);
    assert.equal(evs[6].pcm.length, 4);
    assert.deepEqual([...evs[6].pcm], [1, 2, 3, 4]);
    assert.deepEqual([...evs[6].frame.subarray(0, 3)], [0xA1, 0, 7], 'el frame entero (con cabecera) para reenviarlo al móvil');
    assert.equal(evs[6].frame.length, 7);
    assert.deepEqual(evs[7], { type: 'turn_end', turnId: 't-2' }, 'status, error ajeno y binarios ajenos se ignoran');
    assert.equal(evs.length, 8);
    off();
    J({ type: 'turn_end', turn_id: 't-3' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(evs.length, 8, 'on() devuelve la baja');
  } finally { c.close(); await f.stop(); }
});

test('cierre inesperado (también 1000) → down, isReady() false, y el siguiente ensure() abre otra conexión', async () => {
  const f = await fake(ready);
  const c = mk(f);
  const evs = [];
  c.on(e => evs.push(e.type));
  try {
    assert.equal(await c.ensure(), true);
    f.conns[0].close(1000, '');
    await until(() => evs.includes('down'));
    assert.equal(c.isReady(), false);
    assert.equal(await c.ensure(), true);
    assert.equal(f.conns.length, 2);
    await until(() => f.got.filter(g => g.client_key).length === 2);
    assert.deepEqual(f.got.filter(g => g.client_key), [HANDSHAKE, HANDSHAKE]);
    assert.equal(evs.filter(t => t === 'down').length, 1);
  } finally { c.close(); await f.stop(); }
});

test('send() y end() escriben sus mensajes; audio() con la sesión lista sale tal cual', async () => {
  const f = await fake(ready);
  const c = mk(f);
  try {
    await c.ensure();
    c.send('x'); c.end();
    await until(() => f.got.length === 3);
    assert.deepEqual(f.got.slice(1), [{ type: 'send', text: 'x' }, { type: 'end' }]);
    c.send('sin sesión tras close'); // no debe lanzar
    c.close();
    c.send('y'); c.end(); c.audio(Buffer.from('z'));
    assert.equal(c.isReady(), false);
  } finally { c.close(); await f.stop(); }
});

test('los logs no llevan la clave ni texto', async () => {
  const lines = [];
  const log = { info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), debug: (...a) => lines.push(a.join(' ')) };
  const f = await fake(ws => { ready(ws); setTimeout(() => ws.send(JSON.stringify({ type: 'transcription', text: 'secreto-hablado' })), 10); setTimeout(() => ws.close(1000, ''), 40); });
  const c = mk(f, { log, key: 'clave-super-secreta' });
  try {
    await c.ensure();
    await until(() => lines.some(l => /1000/.test(l)));
    assert.ok(lines.length > 0);
    assert.doesNotMatch(lines.join('\n'), /clave-super-secreta|secreto-hablado/);
  } finally { c.close(); await f.stop(); }
});
