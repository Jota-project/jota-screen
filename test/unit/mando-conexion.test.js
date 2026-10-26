'use strict';
// Unitarias de la conexión del mando (remote/public/mando/core/api.js): la cola de órdenes sin conexión y el sondeo al
// volver a la página, que suelta una conexión medio abierta (K1 de la auditoría de experiencia: el mando nunca miente).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const PUB = path.join(__dirname, '..', '..', 'remote', 'public');

/** Navegador mínimo: WebSocket falso, reloj y temporizadores a mano, visibilidad. */
function fakes() {
  const g = globalThis, saved = {};
  for (const k of ['WebSocket', 'document', 'location', 'performance', 'setTimeout', 'clearTimeout', 'setInterval']) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  let now = 1000; const timers = [];
  const sockets = [];
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); }
    send(s) { this.sent.push(s); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
  }
  const doc = { hidden: false, l: [], addEventListener(t, f) { this.l.push(f); } };
  const def = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  def('WebSocket', WS); def('document', doc); def('location', { protocol: 'http:', host: 'mando' });
  def('performance', { now: () => now });
  def('setTimeout', (f, ms) => { timers.push({ f, at: now + (ms || 0) }); return timers.length; });
  def('clearTimeout', id => { if (timers[id - 1]) timers[id - 1].f = null; });
  def('setInterval', () => 0);
  const tick = ms => {
    now += ms;
    for (const t of timers) if (t.f && t.at <= now) { const f = t.f; t.f = null; f(); }
  };
  const restore = () => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; } };
  return { sockets, doc, tick, restore, show: () => { doc.hidden = false; for (const f of doc.l) f(); } };
}

async function load() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-con-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const api = await import(pathToFileURL(path.join(tmp, 'mando', 'core', 'api.js')).href);
  return { api, tmp };
}

test('mando conexión: sin conexión las órdenes esperan (la última de cada tipo) y salen al abrir; las viejas no', async () => {
  const f = fakes(); const { api, tmp } = await load();
  try {
    await api.connect();
    const ws = f.sockets[0];
    api.cmd({ t: 'pp' }); api.cmd({ t: 'vol', d: 'up' }); api.cmd({ t: 'vol', d: 'down' });
    api.send('m 3 4');                                    // racha del trackpad: nunca a la cola
    f.tick(1000); ws.open();
    const out = ws.sent.filter(s => s[0] === '{').map(s => JSON.parse(s));
    assert.deepEqual(out, [{ t: 'pp' }, { t: 'vol', d: 'down' }]);
    assert.ok(!ws.sent.includes('m 3 4'));

    ws.readyState = 3; ws.onclose({ code: 1006 });         // se cae: lo pulsado hace más de 4 s no se manda al volver
    api.cmd({ t: 'home' }); f.tick(5000);
    const ws2 = f.sockets[1]; ws2.open();
    assert.ok(!ws2.sent.some(s => s.includes('home')), 'orden caducada');
  } finally { f.restore(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mando conexión: al volver a la página se sondea; sin eco en 1,5 s se suelta y reconecta, con eco sale lo pulsado', async () => {
  const f = fakes(); const { api, tmp } = await load();
  try {
    const closes = []; api.onWs('close', ev => closes.push(ev.code));
    api.start(); await api.connect();
    const ws = f.sockets[0]; ws.open();

    // conexión viva: el eco llega y la orden pulsada durante el sondeo sale entonces
    f.doc.hidden = true; f.show();
    api.cmd({ t: 'pp' });
    assert.ok(!ws.sent.some(s => s.includes('"pp"')), 'espera al eco');
    const ping = ws.sent.filter(s => s[0] === 'p').pop();
    ws.onmessage({ data: ping });
    assert.ok(ws.sent.some(s => s.includes('"pp"')), 'sale con el eco');

    // conexión muerta: sin eco, a los 1,5 s se suelta sin esperar al cierre del navegador y se reconecta
    f.show(); api.cmd({ t: 'home' });
    f.tick(1600);
    assert.ok(ws.closed); assert.deepEqual(closes, [1006]);
    assert.equal(api.isUp(), false);
    f.tick(300);                                          // reintento
    const ws2 = f.sockets[1]; assert.ok(ws2, 'reconecta'); ws2.open();
    assert.ok(ws2.sent.some(s => s.includes('"home"')), 'lo pulsado llega por la conexión nueva');
  } finally { f.restore(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
