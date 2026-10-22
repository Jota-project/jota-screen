'use strict';
// Órdenes de control contra un Chrome falso: lo que el mando, el MCP y el agente le hacen a la tele de verdad.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server');
const { startFakeCdp } = require('./helpers/fake-cdp');
const createControl = require('../remote/src/features/control');

let s, cdp, adminTok, fieldReply = { ok: 1 };
const SID = 'S-P1';
const cmd = async body => (await s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const since = n => cdp.calls.slice(n);

before(async () => {
  // playpause devuelve 1 (suena); escribir en directo responde lo que diga fieldReply
  cdp = await startFakeCdp({ evaluate: expr => (expr.includes('v.paused){v.play()') ? 1 : expr.includes('"boot":"') ? fieldReply : undefined) });
  s = await start({ cdpPort: cdp.port });
  await cdp.waitFor(m => m.method === 'Target.attachToTarget');
  adminTok = (await (await s.post('/pair/admin', { t: s.token, name: 'Pruebas' })).json()).token;
});
after(async () => { await s.stop(); await cdp.close(); });

test('se conecta a Chrome, engancha la pestaña y pone el aviso de foco en un mundo aislado', async () => {
  await cdp.waitFor(m => m.method === 'Runtime.addBinding' && m.params.name === '__tvFocus' && m.params.executionContextName === 'tv');
  await cdp.waitFor(m => m.method === 'Page.addScriptToEvaluateOnNewDocument' && m.params.worldName === 'tv');
  assert.match(s.logs(), /CDP conectado/);
  const st = await (await s.api('/api/state')).json();
  assert.equal(st.title, 'Página de prueba');
  assert.equal(st.url, 'https://example.com/');
});

test('teclas y texto van a la pestaña activa', async () => {
  const n = cdp.calls.length;
  assert.deepEqual(await cmd({ t: 'key', k: 'a' }), { ok: 1 });
  await cdp.waitFor(m => m.method === 'Input.dispatchKeyEvent' && m.params.type === 'keyUp' && m.params.key === 'a');
  const keys = since(n).filter(m => m.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keys.map(k => k.params.type), ['keyDown', 'keyUp']);
  assert.ok(keys.every(k => k.sessionId === SID));
  assert.equal((await cmd({ t: 'key', k: 'NoExiste' })).error, 'tecla no válida');
  await cmd({ t: 'text', v: 'hola tele' });
  const tx = await cdp.waitFor(m => m.method === 'Input.insertText' && m.params.text === 'hola tele');
  assert.equal(tx.sessionId, SID);
});

test('navegar: normaliza la dirección, búsquedas a Google e historial', async () => {
  const r = await cmd({ t: 'nav', url: 'example.org' });
  assert.deepEqual(r, { ok: 1, url: 'https://example.org' });
  await cdp.waitFor(m => m.method === 'Page.navigate' && m.params.url === 'https://example.org');
  const q = await cmd({ t: 'nav', url: 'recetas de paella' });
  assert.match(q.url, /^https:\/\/www\.google\.com\/search\?q=recetas/);
  await cmd({ t: 'back' });
  await cdp.waitFor(m => m.method === 'Page.navigateToHistoryEntry' && m.params.entryId === 11);
  await cmd({ t: 'forward' });
  await cdp.waitFor(m => m.method === 'Page.navigateToHistoryEntry' && m.params.entryId === 13);
  await cmd({ t: 'reload' });
  await cdp.waitFor(m => m.method === 'Page.reload');
});

test('reproducir/pausar el vídeo de la página', async () => {
  assert.deepEqual(await cmd({ t: 'pp' }), { playing: true });
  assert.equal((await (await s.api('/api/state')).json()).media, 1);
});

test('la tele cambia de página: el estado lo refleja', async () => {
  cdp.event('Target.targetInfoChanged', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://www.youtube.com/', title: 'YouTube' } });
  for (let i = 0; i < 50; i++) {
    const st = await (await s.api('/api/state')).json();
    if (st.title === 'YouTube') return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('el estado no se actualizó');
});

test('aviso de foco: una contraseña llega al mando sin su valor', async () => {
  const a = await s.ws(adminTok);
  await a.wait(m => m.t === 'me');
  await a.rpc({ t: 'focus', open: true });
  cdp.event('Runtime.bindingCalled', { name: '__tvFocus', payload: JSON.stringify({ kind: 'password', placeholder: 'Contraseña', value: 'secreta' }) }, SID);
  const f = await a.wait(m => m.t === 'focus' && m.kind === 'password');
  assert.equal(f.placeholder, 'Contraseña');
  assert.ok(!('value' in f), 'el valor de una contraseña nunca sale de la tele');
  cdp.event('Runtime.bindingCalled', { name: '__tvFocus', payload: JSON.stringify({ kind: 'text', placeholder: 'Buscar', value: 'abc' }) }, 'OTRA-SESION');
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!a.seen.some(m => m.t === 'focus' && m.placeholder === 'Buscar'), 'se ignoran avisos de otras sesiones');
  a.close();
});

test('emparejar con el código que sale en la tele', async () => {
  const n = cdp.calls.length;
  const st = await (await s.post('/pair/start', { name: 'Tablet' })).json();
  assert.ok(st.pid, JSON.stringify(st));
  const ev = await cdp.waitFor(m => m.method === 'Runtime.evaluate' && /"code":"\d{4}"/.test(m.params.expression) && cdp.calls.indexOf(m) >= n);
  const code = /"code":"(\d{4})"/.exec(ev.params.expression)[1];
  assert.match(ev.params.expression, /"name":"Tablet"/);
  const ok = await (await s.post('/pair/confirm', { pid: st.pid, code })).json();
  assert.equal(ok.role, 'guest');
  assert.match(ok.token, /^[a-f0-9]{32}$/);
  await cdp.waitFor(m => m.method === 'Runtime.evaluate' && m.params.expression.endsWith('(null)') && cdp.calls.indexOf(m) > cdp.calls.indexOf(ev));
});

test('escenario: presentar tareas, datos en vivo, eventos de vuelta y cerrar volviendo a donde estaba', async () => {
  const path = require('node:path');
  const WS = require(path.join(__dirname, '..', 'remote', 'node_modules', 'ws'));
  const prevUrl = (await (await s.api('/api/state')).json()).url;
  const data = { title: 'Compra', items: [{ id: '1', text: 'Pan' }, { id: '2', text: 'Leche' }] };
  const r = await cmd({ t: 'present', kind: 'tasks', data });
  assert.equal(r.ok, 1, JSON.stringify(r));
  await cdp.waitFor(m => m.method === 'Page.navigate' && /\/tpl-tasks\.html$/.test(m.params.url));
  assert.equal((await (await s.api('/api/state')).json()).stage, 'tasks');
  assert.match((await cmd({ t: 'present', kind: 'otra', data })).error, /kind/);
  // la página del escenario (solo desde la propia tele) recibe los datos y manda eventos
  const ws = new WS(`ws://127.0.0.1:${s.port}/stage-ws`);
  const first = await new Promise((ok, ko) => { ws.once('message', d => ok(JSON.parse(d.toString()))); ws.once('error', ko); });
  assert.deepEqual(first, { t: 'data', data });
  ws.send(JSON.stringify({ t: 'event', name: 'toggle', payload: { id: '1' } }));
  await new Promise(x => setTimeout(x, 100));
  const ev = await (await s.api('/api/events?since=0')).json();
  assert.ok(ev.last >= 1);
  assert.equal(ev.events.at(-1).name, 'toggle');
  assert.equal(ev.data.items[0].done, true, 'marcar una tarea en la tele la marca en los datos');
  const up = await cmd({ t: 'stage', data: { title: 'Compra del sábado' } });
  assert.equal(up.data.title, 'Compra del sábado');
  assert.equal(up.data.items.length, 2, 'actualizar mezcla con lo que había');
  ws.close();
  const n = cdp.calls.length;
  await cmd({ t: 'close' });
  await cdp.waitFor(m => m.method === 'Page.navigate' && m.params.url === prevUrl && cdp.calls.indexOf(m) >= n);
  assert.equal((await (await s.api('/api/state')).json()).stage, null);
});

test('escenario: un aviso emergente se pinta encima de lo que se vea', async () => {
  assert.deepEqual(await cmd({ t: 'toast', title: 'La pasta', text: 'Escurrir', seconds: 3 }), { ok: 1 });
  const e = await cdp.waitFor(m => m.method === 'Runtime.evaluate' && m.params.expression.includes('"title":"La pasta"'));
  assert.match(e.params.expression, /"secs":3/);
  assert.match((await cmd({ t: 'toast' })).error, /title/);
});

test('Live Activities: encima de una web, la isla se inyecta por CDP con los tokens de la tele delante', async () => {
  const n = cdp.calls.length;
  assert.equal((await cmd({ t: 'activity', id: 'pasta', title: 'Pasta isla', seconds: 600 })).ok, 1);
  const e = await cdp.waitFor(m => m.method === 'Runtime.evaluate' && m.params.expression.includes('"title":"Pasta isla"') && cdp.calls.indexOf(m) >= n);
  assert.match(e.params.expression, /var __TV_TOKENS="[^"]*--tv-accent:#c3b7e3/);
  assert.match(e.params.expression, /window\.TVIsland\.render\(/);
  assert.ok(e.params.expression.indexOf('__TV_TOKENS=') < e.params.expression.indexOf('if (window.TVIsland) return;'), 'los tokens van antes que la isla');
  await cmd({ t: 'activity', op: 'clear' });
});

test('agente: sin Gateway configurado dice que Jota no está disponible', async () => {
  const r = await cmd({ t: 'ask', text: 'pon algo de jazz' });
  assert.equal(r.error, 'Jota no está disponible.');
  assert.match((await cmd({ t: 'ask', text: '  ' })).error, /vacío/);
});

test('escribir en directo: el texto llega, lo atrasado se descarta, plan B escribe encima y plan C manda solo la diferencia', async () => {
  const a = await s.ws(adminTok);
  await a.wait(m => m.t === 'me');
  fieldReply = { ok: 1 };
  const r1 = await a.rpc({ t: 'field', value: 'hola', selStart: 4, selEnd: 4, seq: 1 });
  assert.equal(r1.ok, 1);
  const ev = await cdp.waitFor(m => m.method === 'Runtime.evaluate' && m.params.expression.includes('"value":"hola"'));
  assert.match(ev.params.expression, /"selStart":4,"selEnd":4/);
  assert.deepEqual(await a.rpc({ t: 'field', value: 'viejo', seq: 1 }), { stale: 1, seq: 1 }, 'lo que llega tarde se descarta');
  fieldReply = { fallback: true };                       // la web rechaza el valor: plan B
  await a.rpc({ t: 'field', value: 'adiós', seq: 2 });
  await cdp.waitFor(m => m.method === 'Input.insertText' && m.params.text === 'adiós');
  fieldReply = { none: true, hidden: true };             // no se ve el campo: plan C, a ciegas con la diferencia
  const n = cdp.calls.length;
  const r3 = await a.rpc({ t: 'field', value: 'adiós!', seq: 3 });
  assert.equal(r3.blind, 1);
  const typed = cdp.calls.slice(n).filter(m => m.method === 'Input.insertText');
  assert.deepEqual(typed.map(m => m.params.text), ['!']);
  fieldReply = { ok: 1 };
  a.close();
});

test('si Chrome se cae, el estado se vacía y vuelve a conectarse solo', async () => {
  const before = cdp.connections();
  cdp.disconnect();
  await new Promise(r => setTimeout(r, 150));
  const st = await (await s.api('/api/state')).json();
  assert.equal(st.title, '');
  const t0 = Date.now();
  while (cdp.connections() === before) {
    if (Date.now() - t0 > 6000) assert.fail('no se reconectó');
    await new Promise(r => setTimeout(r, 50));
  }
  await cdp.waitFor(m => m.method === 'Target.attachToTarget' && cdp.calls.filter(x => x.method === 'Target.attachToTarget').length >= 2, 4000);
});

test('volumen (unidad, audio falso): dos subidas en la misma ráfaga respetan volMax', async () => {
  let vol = 22;
  const audio = {
    read: async () => ({ vol, muted: false }), toggleMute: async () => {}, set: async () => {},
    step: async (n, max = 100) => { await new Promise(r => setTimeout(r, 5)); vol = Math.min(max, vol + n); },
  };
  const state = { vol: 22, muted: false };
  const control = createControl({ cdp: { call: async () => ({}) }, state, broadcast() {}, key: () => ({}), audio,
    cfg: { HOME_URL: 'x', SELF: 'y' }, leaveStage() {} });
  const c = control.commands.find(x => x.t === 'vol');
  const ctx = /** @type {any} */ ({ P: { volMax: 23 } });
  await Promise.all([c.run({ d: 'up' }, ctx), c.run({ d: 'up' }, ctx)]);
  assert.equal(vol, 23);
});
