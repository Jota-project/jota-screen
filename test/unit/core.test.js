'use strict';
// Unitarias del núcleo (remote/src/core) y del límite de intentos (remote/src/auth/ratelimit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = path.join(__dirname, '..', '..', 'remote', 'src');
const { createLog, MASK } = require(path.join(R, 'core', 'log'));
const { readJson, writeJson, createJsonStore } = require(path.join(R, 'core', 'json-store'));
const { loadConfig } = require(path.join(R, 'core', 'config'));
const { createRateLimiter } = require(path.join(R, 'auth', 'ratelimit'));

const capture = () => { const lines = []; const f = (...a) => lines.push(a.join(' ')); return { lines, out: { log: f, warn: f, error: f } }; };

test('log: oculta el secreto conocido, los ?t= y los Bearer', () => {
  const secret = 'a'.repeat(32), { lines, out } = capture();
  const log = createLog({ secrets: () => [secret], out });
  log.info('url http://x/?t=' + secret);
  log.info('ws /ws?t=0123456789abcdef0123456789abcdef&v=2');
  log.error('cabecera Authorization: Bearer f3be0123456789deadbeef');
  log.warn({ token: secret });
  log.info(new Error('fallo con ' + secret));
  for (const l of lines) { assert.ok(!l.includes(secret), l); assert.ok(!/[a-f0-9]{24,}/.test(l), l); }
  assert.ok(lines.every(l => l.includes(MASK)));
  assert.match(lines[1], /&v=2/);
});

test('log: debug solo con debug activo; texto normal intacto', () => {
  const a = capture(), b = capture();
  createLog({ out: a.out }).debug('oculto');
  createLog({ out: b.out, debug: true }).debug('visible');
  assert.deepEqual(a.lines, []);
  assert.deepEqual(b.lines, ['visible']);
  const c = capture(); createLog({ out: c.out }).info('cliente conectado', '192.168.1.20');
  assert.deepEqual(c.lines, ['cliente conectado 192.168.1.20']);
});

test('json-store: escritura atómica, 0600 y lectura tolerante', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-store-'));
  const f = path.join(dir, 'x.json');
  assert.deepEqual(readJson(f, { vacio: true }), { vacio: true });
  writeJson(f, { a: 1 });
  assert.deepEqual(readJson(f, null), { a: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['x.json'], 'no deja temporales');
  writeJson(f, { b: 2 }, { pretty: true });
  assert.match(fs.readFileSync(f, 'utf8'), /\n  "b": 2/);
  fs.writeFileSync(f, '{roto');
  assert.equal(readJson(f, 'def'), 'def');
  const st = createJsonStore(path.join(dir, 'y.json'), { fallback: [], sanitize: v => (Array.isArray(v) ? v : []) });
  assert.deepEqual(st.load(), []);
  st.save([1, 2]);
  assert.deepEqual(st.load(), [1, 2]);
  fs.rmSync(dir, { recursive: true });
});

test('ratelimit: 5 fallos bloquean la IP 60 s y solo esa', () => {
  let t = 1000;
  const rl = createRateLimiter({ max: 5, ms: 60_000, now: () => t });
  for (let i = 0; i < 4; i++) rl.fail('1.1.1.1');
  assert.equal(rl.blocked('1.1.1.1'), false);
  rl.fail('1.1.1.1');
  assert.equal(rl.blocked('1.1.1.1'), true);
  assert.equal(rl.blocked('2.2.2.2'), false);
  t += 60_001;
  assert.equal(rl.blocked('1.1.1.1'), false);
});

test('config: valores por defecto y entorno', () => {
  const d = loadConfig({});
  assert.equal(d.PORT, 8787);
  assert.equal(d.SELF, 'http://127.0.0.1:8787');
  assert.equal(d.HOME_URL, 'http://127.0.0.1:8787/idle.html');
  assert.equal(d.SP_DEVICE, 'Pantalla');
  assert.ok(d.FILES.token.endsWith(path.join('.local', 'state', 'jota-screen', 'token')));
  assert.ok(Object.isFrozen(d));
  const c = loadConfig({ TV_PORT: '9000', TV_DEBUG: '1', TV_ADMIN_URL: 'http://m.local/', TV_SPOTIFY_BANNER: '1' });
  assert.equal(c.PORT, 9000);
  assert.equal(c.DEBUG, true);
  assert.equal(c.ADMIN_URL, 'http://m.local');
  assert.equal(c.SPOTIFY_BANNER, true);
});
