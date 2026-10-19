'use strict';
// Órdenes de control contra un Chrome falso: lo que el mando, el MCP y el agente le hacen a la tele de verdad.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server');
const { startFakeCdp } = require('./helpers/fake-cdp');

let s, cdp, adminTok;
const SID = 'S-P1';
const cmd = async body => (await s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const since = n => cdp.calls.slice(n);

before(async () => {
  // playpause devuelve 1 (suena); el resto de evaluaciones, nada
  cdp = await startFakeCdp({ evaluate: expr => (expr.includes('v.paused){v.play()') ? 1 : undefined) });
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
