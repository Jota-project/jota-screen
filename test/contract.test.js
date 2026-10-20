'use strict';
// Pruebas de contrato del servidor del mando: lo que ven desde fuera el mando, la tele, el MCP y el agente.
// Ejecutar desde la raíz del repo (con remote/node_modules instalado): node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server');

let s, adminTok, guestTok;
before(async () => { s = await start(); });
after(async () => { await s.stop(); });

const HEX32 = /^[a-f0-9]{32}$/;

test('estáticos: el mando, el reposo y la isla se sirven con su CSP y sin caché larga', async () => {
  const r = await s.get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const idle = await s.get('/idle.html');
  assert.equal(idle.status, 200);
  assert.match(idle.headers.get('content-security-policy'), /connect-src 'self' ws:/);
  assert.match(await idle.text(), /id="grid"/);
  const isl = await s.get('/tv-island.js');
  assert.equal(isl.status, 200);
  assert.equal(isl.headers.get('cache-control'), 'no-store');
  assert.equal((await s.get('/no-existe.js')).status, 404);
});

test('estáticos: los tokens de la tele (shared/tokens-tv.css) se sirven como CSS y el reposo los enlaza', async () => {
  const r = await s.get('/shared/tokens-tv.css');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/css/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('content-security-policy'), null);
  assert.match(await r.text(), /--tv-accent:#c3b7e3/);
  assert.match(await (await s.get('/idle.html')).text(), /<link rel="stylesheet" href="\/shared\/tokens-tv\.css">/);
});

test('estáticos: ETag con 304 y gzip para HTML', async () => {
  const a = await s.get('/index.html');
  const etag = a.headers.get('etag');
  assert.ok(etag);
  assert.equal((await s.get('/index.html', { headers: { 'If-None-Match': etag } })).status, 304);
  const gz = await s.get('/index.html', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.status, 200);
});

test('solo la tele: escenario y carátulas se niegan a peticiones reenviadas', async () => {
  const r = await s.get('/idle/art?u=x', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(r.status, 403);
});

test('API: sin token o con uno falso, 401; con el maestro, el estado', async () => {
  assert.equal((await s.get('/api/state')).status, 401);
  assert.equal((await s.api('/api/state', 'f'.repeat(32))).status, 401);
  const r = await s.api('/api/state');
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.ok('vol' in st && 'stage' in st);
  const ev = await (await s.api('/api/events?since=0')).json();
  assert.ok(Number.isInteger(ev.last));
});

test('API: /api/cmd valida el JSON', async () => {
  const r = await s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{no' });
  assert.equal(r.status, 400);
});

test('seguridad: el token maestro nunca sale en el registro', async () => {
  await new Promise(r => setTimeout(r, 200));
  assert.ok(s.logs().includes('escuchando en'), 'el servidor debería haber arrancado');
  assert.ok(!s.logs().includes(s.token), 'el registro contiene el token maestro');
});

test('seguridad: el manifiesto no conserva el token maestro', async () => {
  const m = await (await s.get('/manifest.webmanifest?t=' + s.token)).json();
  assert.ok(!JSON.stringify(m).includes(s.token));
});

test('acceso: el maestro se canjea por un dispositivo admin propio (cookie HttpOnly)', async () => {
  const r = await s.post('/pair/admin', { t: s.token, name: 'Pruebas' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.token, HEX32);
  assert.equal(j.role, 'admin');
  assert.notEqual(j.token, s.token);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  adminTok = j.token;
  const me = await (await s.post('/pair/me', { t: adminTok })).json();
  assert.equal(me.ok, true);
  assert.equal(me.role, 'admin');
  const m = await (await s.post('/pair/me', { t: s.token })).json();
  assert.equal(m.master, true);
});

test('estado: los ficheros de dispositivos y accesos quedan con permisos 600', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const a = await s.ws(adminTok);
  await a.rpc({ t: 'access', op: 'set', cfg: { guestHours: 24 } });
  a.close();
  for (const f of ['devices.json', 'access.json']) {
    const st = fs.statSync(path.join(s.state, f));
    assert.equal(st.mode & 0o777, 0o600, f);
  }
});

test('acceso: un código de admin incorrecto se rechaza', async () => {
  const r = await s.post('/pair/admin', { code: 'AAAAA-BBBBB', name: 'x' });
  assert.equal(r.status, 403);
});

test('WebSocket: token falso se cierra con 4001; el admin recibe estado y su rol', async () => {
  const bad = await s.ws('0'.repeat(32));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(bad.raw.closed?.code, 4001);
  const a = await s.ws(adminTok);
  const st = await a.wait(m => m.t === 'state');
  assert.ok('vol' in st);
  const me = await a.wait(m => m.t === 'me');
  assert.equal(me.role, 'admin');
  assert.equal(me.perms.admin, true);
  a.close();
});

test('reposo: ajustes por defecto y validación de los nuevos (layout, rearrangeMin, calm)', async () => {
  const a = await s.ws(adminTok);
  const g = await a.rpc({ t: 'idle', op: 'get' });
  assert.equal(g.cfg.layout, 'rotar');
  assert.equal(g.cfg.rearrangeMin, 20);
  assert.equal(g.cfg.calm, false);
  const r = await a.rpc({ t: 'idle', op: 'set', cfg: { layout: 'zonas', rearrangeMin: 999, calm: true } });
  assert.equal(r.cfg.layout, 'zonas');
  assert.equal(r.cfg.rearrangeMin, 120);
  assert.equal(r.cfg.calm, true);
  const r2 = await a.rpc({ t: 'idle', op: 'set', cfg: { ...r.cfg, layout: 'inventada' } });
  assert.equal(r2.cfg.layout, 'rotar');
  a.close();
});

test('acceso: un invitado pide permiso, el admin lo concede y recibe su token', async () => {
  const a = await s.ws(adminTok);
  await a.wait(m => m.t === 'me');
  const st = await (await s.post('/pair/start', { mode: 'ask', name: 'Invitada' })).json();
  assert.ok(st.pid, JSON.stringify(st));
  const req = await a.wait(m => m.t === 'pairreq' && m.pid === st.pid);
  assert.equal(req.name, 'Invitada');
  assert.equal((await (await s.post('/pair/poll', { pid: st.pid })).json()).pending, true);
  const ans = await a.rpc({ t: 'pairanswer', pid: st.pid, ok: true, role: 'guest' });
  assert.equal(ans.ok, 1);
  const tok = await (await s.post('/pair/poll', { pid: st.pid })).json();
  assert.match(tok.token, HEX32);
  assert.equal(tok.role, 'guest');
  assert.ok(tok.expires > Date.now());
  guestTok = tok.token;
  const list = await a.rpc({ t: 'devices' });
  assert.ok(list.devices.some(d => d.name === 'Invitada' && d.role === 'guest'));
  a.close();
});

test('permisos: un invitado no administra, no cambia el reposo ni pone presentaciones', async () => {
  const g = await s.ws(guestTok);
  const me = await g.wait(m => m.t === 'me');
  assert.equal(me.role, 'guest');
  assert.equal(me.perms.admin, false);
  assert.match((await g.rpc({ t: 'devices' })).error, /administrador/);
  assert.match((await g.rpc({ t: 'adminlink' })).error, /administrador/);
  assert.match((await g.rpc({ t: 'idle', op: 'set', cfg: { layout: 'margen' } })).error, /administrador/);
  assert.ok((await g.rpc({ t: 'present', kind: 'reminder', data: { title: 'x' } })).error);
  assert.ok((await g.rpc({ t: 'shot' })).error);
  const lib = await g.rpc({ t: 'spotify', a: 'playlists' });
  assert.match(lib.error, /biblioteca/);
  g.close();
});

test('permisos: el admin retira al invitado y su conexión se cierra', async () => {
  const a = await s.ws(adminTok);
  const g = await s.ws(guestTok);
  await g.wait(m => m.t === 'me');
  const list = await a.rpc({ t: 'devices' });
  const id = list.devices.find(d => d.role === 'guest').id;
  const r = await a.rpc({ t: 'revoke', dev: id });
  assert.equal(r.ok, 1);
  await new Promise(x => setTimeout(x, 300));
  assert.equal(g.raw.closed?.code, 4001);
  assert.equal((await s.api('/api/state', guestTok)).status, 401);
  a.close();
});

test('voz: /api/voice llega a su ruta (no la tapa el prefijo /api/) y pide token', async () => {
  const v = await start();                                // servidor propio: las pruebas de arriba agotan el límite de intentos
  try {
    const audio = { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(2000, 1) };
    // con el agente falso (/bin/false) no hay transcripción: 422 de la propia ruta de voz, nunca el 404 de la API
    const r = await v.api('/api/voice?out=none', v.token, audio);
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /No te he entendido/);
    assert.equal((await v.api('/api/voice', 'mal', audio)).status, 401);
  } finally { await v.stop(); }
});

test('salto a https: con TV_PUBLIC_URL https el mando la recibe y su CSP le deja comprobarla; sin ella, nada', async () => {
  const S = 'https://tele.example.ts.net:8443';
  const v = await start({ env: { TV_PUBLIC_URL: S + '/' } });
  try {
    const r = await v.get('/');
    assert.match(await r.text(), new RegExp(`<meta name="tv-secure" content="${S}">`));
    assert.match(r.headers.get('content-security-policy'), new RegExp(`connect-src 'self' ws: wss: ${S};`));
  } finally { await v.stop(); }
  const r = await s.get('/');
  assert.match(await r.text(), /<meta name="tv-secure" content="">/);
  assert.match(r.headers.get('content-security-policy'), /connect-src 'self' ws: wss:;/);
});
