'use strict';
// Unitarias del transporte y del estado de la tele (remote/src/transport, src/core/tv-state, src/tv/page-poll).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const S = path.join(__dirname, '..', '..', 'remote', 'src');
const { createHttp } = require(path.join(S, 'transport', 'http'));
const { bindAddrs } = require(path.join(S, 'transport', 'listen'));
const { clientIp, isLocalTV } = require(path.join(S, 'transport', 'http-util'));
const { createStatic, cacheFor, pageCsp } = require(path.join(S, 'transport', 'static'));
const { createTvState } = require(path.join(S, 'core', 'tv-state'));
const { createPagePoll } = require(path.join(S, 'tv', 'page-poll'));

const fakeRes = () => { const r = { code: 0, headersSent: false, writeHead(c) { r.code = c; r.headersSent = true; }, end() {} }; return r; };
const req = (method, url, remote = '127.0.0.1', headers = {}) => ({ method, url, headers, socket: { remoteAddress: remote } });

test('rutas: exacta, prefijo y expresión; POST solo donde se permite; si no, estáticos', () => {
  const hit = [];
  const h = createHttp({
    routes: [
      { prefix: '/api/', anyMethod: true, run: (q, r, c) => hit.push('api:' + c.p) },
      { path: '/x', run: () => hit.push('x') },
      { re: /^\/s\/(\w+)$/, run: (q, r, c) => hit.push('s:' + c.match[1]) },
      { path: '/boom', run: () => { throw new Error('x'); } },
    ],
    fallback: (q, r, p) => hit.push('static:' + p),
  });
  h(req('POST', '/api/cmd'), fakeRes());
  h(req('GET', '/x?y=1'), fakeRes());
  h(req('GET', '/s/abc'), fakeRes());
  h(req('GET', '/'), fakeRes());
  const r405 = fakeRes(); h(req('POST', '/x'), r405);
  const r500 = fakeRes(); h(req('GET', '/boom'), r500);
  assert.deepEqual(hit, ['api:/api/cmd', 'x', 's:abc', 'static:/index.html']);
  assert.equal(r405.code, 405);
  assert.equal(r500.code, 500);
});

test('IP real tras el proxy local y tele solo en bucle local sin proxy', () => {
  assert.equal(clientIp(req('GET', '/', '::ffff:192.168.1.5')), '192.168.1.5');
  assert.equal(clientIp(req('GET', '/', '127.0.0.1', { 'x-forwarded-for': '10.0.0.7, 127.0.0.1' })), '10.0.0.7');
  assert.equal(clientIp(req('GET', '/', '192.168.1.5', { 'x-forwarded-for': '1.2.3.4' })), '192.168.1.5', 'solo se fía del proxy local');
  assert.equal(isLocalTV(req('GET', '/', '::1')), true);
  assert.equal(isLocalTV(req('GET', '/', '127.0.0.1', { 'tailscale-user-login': 'x' })), false);
  assert.equal(isLocalTV(req('GET', '/', '192.168.1.19')), false);
});

test('escucha solo en bucle local, red privada y Tailscale', () => {
  const v4 = address => ({ family: 'IPv4', internal: false, address });
  const got = bindAddrs({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth0: [v4('192.168.1.19'), v4('8.8.8.8')],
    tailscale0: [v4('100.109.57.116')], docker0: [v4('172.17.0.1')], wg0: [v4('172.40.0.1'), { family: 'IPv6', internal: false, address: 'fe80::1' }],
  });
  assert.deepEqual(got, ['127.0.0.1', '192.168.1.19', '100.109.57.116']);
});

test('estado de la tele: varios cambios seguidos, un solo mensaje', async () => {
  const sent = [];
  const c = { readyState: 1, send: s => sent.push(JSON.parse(s)) };
  const tv = createTvState({ cdpUp: () => true, clients: () => [c] });
  tv.state.url = 'https://www.youtube.com/watch?v=1'; tv.broadcast(); tv.state.title = 'Vídeo'; tv.broadcast();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, 'www.youtube.com');
  assert.equal(sent[0].title, 'Vídeo');
  tv.clearPage();
  assert.deepEqual([tv.state.url, tv.state.media, tv.state.scroll], ['', -1, null]);
});

test('estado de la tele: lleva el ambiente del reposo (amb) para que el mando tome su color', async () => {
  const { ambientOf } = require(path.join(__dirname, '..', '..', 'remote', 'idle'));
  const music = { title: 'Midnight City', artist: 'M83', colors: [[10, 0.5, 0.6], [260, 0.4, 0.3], [40, 0.6, 0.5]] };
  assert.equal(ambientOf({ idle: false, profile: 'day', music }), null, 'fuera del reposo, sin ambiente');
  assert.deepEqual(ambientOf({ idle: true, profile: 'evening', music: null }), { profile: 'evening', music: null });
  assert.deepEqual(ambientOf({ idle: true, profile: 'day', music }),
    { profile: 'day', music: { title: 'Midnight City', artist: 'M83', colors: [[10, 0.5, 0.6], [260, 0.4, 0.3]] } }, 'dos colores');
  assert.equal(ambientOf({ idle: true, profile: 'day', music: { ...music, colors: null } }).music.colors, null);
  let amb = null;
  const tv = createTvState({ cdpUp: () => true, clients: () => [], ambient: () => amb });
  assert.equal(tv.publicState().amb, null);
  amb = ambientOf({ idle: true, profile: 'day', music });
  assert.deepEqual(tv.publicState().amb.music.colors, [[10, 0.5, 0.6], [260, 0.4, 0.3]]);
  assert.equal(createTvState({ cdpUp: () => true, clients: () => [] }).publicState().amb, null, 'sin reposo conectado');
});

test('sondeo de la página: solo con mandos conectados, y avisa si cambia', async () => {
  let calls = 0, watched = false, bc = 0;
  const cdp = { ready: true, session: 'S', call: async () => { calls++; return { result: { value: [1, 0, 2000, 1000] } }; } };
  const state = { media: -1, scroll: null };
  const poll = createPagePoll({ cdp, state, broadcast: () => bc++, watched: () => watched });
  await poll.poll();
  assert.equal(calls, 0, 'sin nadie mirando no pregunta a Chrome');
  watched = true;
  await poll.poll();
  assert.deepEqual([state.media, state.scroll, bc], [1, { pos: 0, size: 0.5 }, 1]);
  await poll.poll();
  assert.equal(bc, 1, 'sin cambios no se difunde');
});

test('estáticos: subcarpetas sí; ocultos, enlaces simbólicos y nombres de rutas, no', () => {
  const fs = require('node:fs'), os = require('node:os');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-pub-'));
  fs.mkdirSync(path.join(d, 'shared', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(d, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<p>hola');
  fs.writeFileSync(path.join(d, 'shared', 'tokens-tv.css'), ':root{--x:1}');
  fs.writeFileSync(path.join(d, 'shared', 'fonts', 'f.woff2'), 'x');
  fs.writeFileSync(path.join(d, 'a', 'b', 'c', 'hondo.js'), '1');
  fs.writeFileSync(path.join(d, '.env'), 'SECRETO=1');
  fs.symlinkSync('/etc', path.join(d, 'fuera'));
  const st = createStatic({ dir: d });
  assert.ok(st.has('/index.html') && st.has('/shared/tokens-tv.css') && st.has('/shared/fonts/f.woff2'));
  assert.equal(st.get('/shared/tokens-tv.css').type, 'text/css; charset=utf-8');
  assert.ok(!st.has('/.env') && !st.has('/fuera/hostname') && !st.has('/a/b/c/hondo.js'), 'ocultos, enlaces y más de 2 niveles fuera');
  fs.mkdirSync(path.join(d, 'api'));
  assert.throws(() => createStatic({ dir: d }), /public\/api choca/);
  fs.rmSync(d, { recursive: true, force: true });
  assert.equal(cacheFor('/shared/x.svg'), 'no-cache', 'los tokens compartidos siempre se revalidan');
  assert.equal(cacheFor('/icon-180.png'), 'public, max-age=86400');
  assert.equal(pageCsp('/tpl-tasks.html') !== null && pageCsp('/tpl-x.js') === null && pageCsp('/stage.css') === null, true);
});
