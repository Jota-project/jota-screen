'use strict';
// Transporte HTTP y WebSocket: rutas, cabeceras de seguridad, límites de tamaño y canales que solo abre la tele.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { start } = require('./helpers/server');
const { startFakeCdp } = require('./helpers/fake-cdp');
const WS = require(path.join(__dirname, '..', 'remote', 'node_modules', 'ws'));

let s, cdp;
const cmd = async body => (await s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const viaProxy = { 'X-Forwarded-For': '203.0.113.9' }; // como llega algo de fuera a través de nginx o Tailscale

before(async () => {
  cdp = await startFakeCdp();
  s = await start({ cdpPort: cdp.port });
  await cdp.waitFor(m => m.method === 'Target.attachToTarget');
});
after(async () => { await s.stop(); await cdp.close(); });

test('cada página sale con su CSP y las cabeceras de seguridad', async () => {
  const idx = await s.get('/');
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'; connect-src 'self' ws: wss:/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(idx.headers.get('referrer-policy'), 'no-referrer');
  assert.match((await s.get('/idle.html')).headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.match((await s.get('/tpl-tasks.html')).headers.get('content-security-policy'), /img-src \* data: blob:/);
  assert.equal((await s.get('/tv-island.js')).headers.get('content-security-policy'), null);
  assert.equal((await s.get('/no-existe.js')).status, 404);
});

test('reposo: CSP sin \'unsafe-inline\'; su CSS y su JS van en ficheros', async () => {
  const r = await s.get('/idle.html');
  const csp = r.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com;/);
  assert.match(csp, /script-src 'self';/);
  const html = await r.text();
  assert.doesNotMatch(html, /<style\b/i, 'sin <style> en línea');
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) assert.match(tag, /\bsrc=/, 'sin <script> en línea: ' + tag);
  assert.doesNotMatch(html, /<[^>]+\s(style|on[a-z]+)\s*=/i, 'sin atributos style= ni on*=');
  assert.match(html, /<link rel="stylesheet" href="\/idle\.css">/);
  assert.match(html, /<script src="\/idle-app\.js"><\/script>/);
  for (const [p, type] of [['/idle.css', /^text\/css/], ['/idle-app.js', /^text\/javascript/]]) {
    const f = await s.get(p);
    assert.equal(f.status, 200, p);
    assert.match(f.headers.get('content-type'), type, p);
    assert.equal(f.headers.get('content-security-policy'), null, p);
    assert.equal(f.headers.get('cache-control'), 'no-store', p);
  }
});

test('mando: CSP sin \'unsafe-inline\'; su CSS y su JS van en ficheros', async () => {
  const r = await s.get('/');
  const csp = r.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com;/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /object-src 'none'; frame-ancestors 'none'/);
  const html = await r.text();
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, 'sin atributos on*=');
  assert.doesNotMatch(html, /javascript:/i, 'sin enlaces javascript:');
  assert.doesNotMatch(html, /<style\b/i, 'sin <style> en línea');
  assert.doesNotMatch(html, /<[^>]+\sstyle\s*=/i, 'sin atributos style=');
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) assert.match(tag, /\bsrc=/, 'sin <script> en línea: ' + tag);
  assert.match(html, /<link rel="stylesheet" href="\/mando\/styles\/mando\.css">/);
  // el tema, clásico y bloqueante en el <head> antes del CSS (para que no parpadee); la app, módulo ES al final del <body>
  assert.match(html, /<script src="\/mando\/theme\.js"><\/script>\n<link rel="preconnect"/);
  assert.match(html, /<script type="module" src="\/mando\/app\.js"><\/script>\n<\/body>/);
  for (const [p, type] of [['/mando/styles/mando.css', /^text\/css/], ['/mando/theme.js', /^text\/javascript/], ['/mando/app.js', /^text\/javascript/]]) {
    const f = await s.get(p);
    assert.equal(f.status, 200, p);
    assert.match(f.headers.get('content-type'), type, p);
    assert.equal(f.headers.get('content-security-policy'), null, p);
    assert.equal(f.headers.get('cache-control'), 'no-store', p);
  }
  // nada que la CSP vaya a bloquear desde el JS: ni eval ni HTML generado con style= u on*=
  const js = await (await s.get('/mando/app.js')).text();
  assert.doesNotMatch(js, /\beval\(|new Function\b|javascript:/);
  assert.doesNotMatch(js, /\sstyle=|\son[a-z]+=["']/);
});

test('estáticos: caché por tipo, gzip para texto y nada fuera de public/', async () => {
  const js = await s.get('/tv-island.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(js.headers.get('cache-control'), 'no-store');
  assert.equal(js.headers.get('content-encoding'), 'gzip');
  assert.equal((await s.get('/icon-512.png')).headers.get('cache-control'), 'public, max-age=86400');
  const etag = (await s.get('/stage.css')).headers.get('etag');
  assert.equal((await s.get('/stage.css', { headers: { 'If-None-Match': etag } })).status, 304);
  for (const p of ['/%2e%2e/server.js', '/..%2Fserver.js', '/shared/%2F..%2Fserver.js', '/src/core/config.js', '/token', '/node_modules/ws/package.json'])
    assert.equal((await s.get(p)).status, 404, p);
});

test('fuera de la API y de emparejar, solo GET y HEAD', async () => {
  assert.equal((await s.get('/index.html', { method: 'POST' })).status, 405);
  const h = await s.get('/index.html', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal((await h.text()).length, 0);
  assert.equal((await s.get('/pair/info')).status, 405, 'emparejar es solo POST');
});

test('emparejar: ¿hay admin en línea y tele lista?', async () => {
  assert.deepEqual(await (await s.post('/pair/info', {})).json(), { adminOnline: false, tv: true });
  const big = await s.get('/pair/info', { method: 'POST', body: 'x'.repeat(3000) });
  assert.equal(big.status, 413);
});

test('API: un cuerpo de más de 1,2 MB se rechaza', async () => {
  const r = await s.api('/api/cmd', s.token, { method: 'POST', body: 'x'.repeat(1_300_000) });
  assert.equal(r.status, 413);
  assert.equal((await s.api('/api/nada')).status, 404);
});

test('escenario: la página del agente solo la puede pedir la propia tele, con su CSP', async () => {
  const r = await cmd({ t: 'show', html: '<h1>Hola salón</h1>' });
  assert.equal(r.ok, 1, JSON.stringify(r));
  const nav = await cdp.waitFor(m => m.method === 'Page.navigate' && /\/stage\/p\w+\.html$/.test(m.params.url));
  const p = new URL(nav.params.url).pathname;
  const page = await s.get(p);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /^<script src="\/tv-stage\.js"><\/script><h1>Hola salón<\/h1>/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await s.get(p, { headers: viaProxy })).status, 403);
  assert.equal((await s.get('/stage/pnoexiste.html')).status, 404);
  assert.equal((await s.get('/idle/art?u=x', { headers: viaProxy })).status, 403);
  await cmd({ t: 'close' });
});

test('Spotify: la página de vuelta lleva su propia CSP y escapa el error', async () => {
  const r = await s.get('/spotify/callback?state=nada&code=<b>');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'; style-src 'unsafe-inline'/);
  const html = await r.text();
  assert.match(html, /No se pudo conectar/);
  assert.doesNotMatch(html, /<script/);
});

test('WebSocket: los canales de la tele no se abren desde fuera; /ws sin token se cierra con 4001', async () => {
  const refused = url => new Promise(ok => {
    const w = new WS(url, { headers: viaProxy });
    w.on('open', () => ok(false)); w.on('error', () => ok(true)); w.on('close', () => ok(true));
  });
  assert.equal(await refused(`ws://127.0.0.1:${s.port}/idle-ws`), true);
  assert.equal(await refused(`ws://127.0.0.1:${s.port}/stage-ws`), true);
  assert.equal(await refused(`ws://127.0.0.1:${s.port}/otra`), true);
  const code = await new Promise(ok => { const w = new WS(`ws://127.0.0.1:${s.port}/ws?t=${'0'.repeat(32)}`); w.on('close', c => ok(c)); w.on('error', () => {}); });
  assert.equal(code, 4001);
});

test('WebSocket del mando: saludo (estado, ficha y foco) y respuesta con id', async () => {
  const a = await s.ws(s.token);
  const st = await a.wait(m => m.t === 'state');
  assert.equal(st.cdp, true);
  const me = await a.wait(m => m.t === 'me');
  assert.equal(me.role, 'admin');
  await a.wait(m => m.t === 'focus');
  assert.deepEqual(await a.rpc({ t: 'state' }), { ...st, t: 'state' });
  a.close();
});
