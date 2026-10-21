'use strict';
// Unitarias de los adaptadores de la tele (remote/src/tv).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const R = path.join(__dirname, '..', '..', 'remote', 'src', 'tv');
const { parseProbe, RE_PTR, createAudio, createPointer, createPairScreen } = require(path.join(R, 'devices'));
const { createCdp } = require(path.join(R, 'cdp'));
const { startFakeCdp } = require('../helpers/fake-cdp');

test('sondeo de la página: vídeo y carril de scroll', () => {
  assert.deepEqual(parseProbe([1, 500, 2000, 1000]), { media: 1, scroll: { pos: 0.5, size: 0.5 } });
  assert.deepEqual(parseProbe([-1, 0, 1000, 1000]), { media: -1, scroll: null }, 'sin scroll no hay carril');
  assert.deepEqual(parseProbe([0, 9999, 2000, 1000]).scroll.pos, 1, 'acotado a 1');
  assert.equal(parseProbe(null), null);
});

test('puntero: solo líneas válidas llegan al helper', () => {
  for (const ok of ['m 3 -4', 'w 0 12.5', 'c 1', 'b 1 1', 'b 3 0']) assert.ok(RE_PTR.test(ok), ok);
  for (const bad of ['m 3', 'm 99999 1', 'c 4', 'rm -rf /', 'm 1 1\nc 1']) assert.ok(!RE_PTR.test(bad), bad);
  const written = [];
  const fakeProc = () => { const p = new EventEmitter(); p.stdin = Object.assign(new EventEmitter(), { writable: true, write: s => written.push(s) }); return p; };
  const ptr = createPointer({ script: 'x.py', display: ':0', log: { debug() {} }, spawn: fakeProc });
  ptr.start();
  assert.equal(ptr.line('m 1 2'), true);
  assert.equal(ptr.line('borra todo'), false);
  assert.deepEqual(written, ['m 1 2\n']);
  const off = createPointer({ script: 'x.py', display: ':0', disabled: true, log: { debug() {} }, spawn: () => assert.fail('no debe arrancar') });
  off.start();
});

test('volumen: lee, sube en pasos de 5 % con tope y fija', async () => {
  const runs = [];
  const audio = createAudio({ runtimeDir: '/run/user/1', exec: async a => { runs.push(a.join(' ')); return a[0] === 'get-volume' ? 'Volume: 0.35 [MUTED]\n' : ''; } });
  assert.deepEqual(await audio.read(), { vol: 35, muted: true });
  await audio.step(2); await audio.step(-3); await audio.set(42); await audio.toggleMute();
  assert.deepEqual(runs.slice(1), [
    'set-volume @DEFAULT_AUDIO_SINK@ 10%+ -l 1.0', 'set-volume @DEFAULT_AUDIO_SINK@ 15%-',
    'set-volume @DEFAULT_AUDIO_SINK@ 0.42', 'set-mute @DEFAULT_AUDIO_SINK@ toggle',
  ]);
  const silent = createAudio({ runtimeDir: '/x', exec: async () => '' });
  assert.equal(await silent.read(), null, 'sin wpctl no inventa un volumen');
});

test('CDP: sin conexión o sin pestaña, las llamadas fallan al momento', async () => {
  const cdp = createCdp({ port: 1, log: { info() {}, error() {} } });
  await assert.rejects(cdp.call('Page.reload'), /cdp/);
  cdp.fire('Input.insertText', { text: 'x' }); // no revienta
  const pair = createPairScreen(cdp);
  assert.equal(pair.ready(), false);
});

test('CDP: engancha la pestaña, avisa por los ganchos y corta las llamadas que no responden', async () => {
  const fake = await startFakeCdp();
  const seen = [];
  const cdp = createCdp({ port: fake.port, log: { info() {}, error() {} }, timeoutMs: 300, retryMs: 50, hooks: {
    onAttached: t => seen.push('attached:' + t.title), onDown: () => seen.push('down'),
    onBinding: (n, p) => seen.push('binding:' + n + ':' + p),
  } });
  cdp.connect();
  await fake.waitFor(m => m.method === 'Target.attachToTarget');
  for (let i = 0; i < 50 && !cdp.session; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(cdp.session, 'S-P1');
  assert.deepEqual(seen, ['attached:Página de prueba']);
  assert.deepEqual(await cdp.call('Page.reload'), {});
  fake.event('Runtime.bindingCalled', { name: '__tvFocus', payload: '{}' }, 'S-P1');
  fake.event('Runtime.bindingCalled', { name: '__tvFocus', payload: 'ajeno' }, 'OTRA');
  fake.event('Runtime.executionContextCreated', { context: { id: 9, name: 'tv', auxData: { frameId: 'P1' } } }, 'S-P1');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(seen.includes('binding:__tvFocus:{}') && !seen.some(x => x.includes('ajeno')));
  assert.equal(cdp.worlds.get('tv'), 9);
  // una llamada sin respuesta se corta por tiempo
  cdp.send = function (method, params, sid) { return ++this.id; }; // no llega nada al Chrome falso
  await assert.rejects(cdp.call('Runtime.evaluate', { expression: '1' }), /timeout/);
  cdp.stop();
  await new Promise(r => setTimeout(r, 100));
  assert.ok(seen.includes('down'));
  assert.equal(cdp.ready, false);
  await fake.close();
});

test('CDP: varias pestañas: traer una al frente, abrir otra y un solo enganche aunque se pida dos veces', async () => {
  const fake = await startFakeCdp({ pages: [{ targetId: 'P1', type: 'page', url: 'http://127.0.0.1:8787/idle.html', title: 'Salón' }] });
  const seen = [];
  const cdp = createCdp({ port: fake.port, log: { info() {}, error() {} }, timeoutMs: 500, retryMs: 50, hooks: { onAttached: t => seen.push(t && t.targetId) } });
  cdp.connect();
  for (let i = 0; i < 100 && !cdp.session; i++) await new Promise(r => setTimeout(r, 10));
  const id = await cdp.newTab();
  assert.equal(id, 'P2');
  assert.equal(cdp.targetId, 'P2'); assert.equal(cdp.session, 'S-P2');
  await new Promise(r => setTimeout(r, 30)); // el aviso de pestaña nueva llega después: no debe abrir otra sesión
  assert.equal(fake.find('Target.attachToTarget').filter(c => c.params.targetId === 'P2').length, 1, 'un solo enganche a la pestaña nueva');
  await cdp.show('P1');
  assert.equal(cdp.session, 'S-P1');
  assert.ok(fake.find('Target.activateTarget').some(c => c.params.targetId === 'P1'), 'se trae al frente en Chrome');
  assert.ok(fake.find('Target.detachFromTarget').some(c => c.params.sessionId === 'S-P2'), 'la de detrás se suelta');
  await assert.rejects(cdp.show('NO'), /nopage/);
  assert.deepEqual(seen, ['P1', 'P2', 'P1']);
  cdp.stop(); await fake.close();
});

test('tokens de la tele: la isla los lleva delante y tv-island.js no repite sus colores', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { readTokens, islandSource } = require(path.join(R, 'tokens'));
  const PUB = path.join(__dirname, '..', '..', 'remote', 'public');
  const src = islandSource(PUB);
  assert.ok(src.startsWith('var __TV_TOKENS='), 'empieza por los tokens');
  assert.ok(src.includes('--tv-accent:#c3b7e3'));
  const tok = readTokens(PUB);
  assert.doesNotMatch(tok, /[{}]|\/\*/, 'solo declaraciones, sin llaves ni comentarios');
  // la isla no lleva sueltos los colores que ya están en los tokens
  const island = fs.readFileSync(path.join(PUB, 'tv-island.js'), 'utf8');
  for (const hex of tok.match(/#[0-9a-f]{3,8}\b/gi)) assert.ok(!island.toLowerCase().includes(hex.toLowerCase()), hex + ' suelto en tv-island.js');
  for (const rgba of tok.match(/rgba\([^)]*\)/g)) assert.ok(!island.includes(rgba), rgba + ' suelto en tv-island.js');
  // un fichero de tokens con dos bloques :root (o con algo fuera) es un error claro
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-tok-'));
  fs.mkdirSync(path.join(d, 'shared'));
  fs.writeFileSync(path.join(d, 'tv-island.js'), '');
  for (const css of [':root{--a:1}\n:root{--b:2}', '/* nada */', ':root{--a:1}\n@media (min-width:1px){:root{--a:2}}']) {
    fs.writeFileSync(path.join(d, 'shared', 'tokens-tv.css'), css);
    assert.throws(() => readTokens(d), /exactamente un bloque :root/, css);
    assert.throws(() => islandSource(d), /exactamente un bloque :root/);
  }
  fs.writeFileSync(path.join(d, 'shared', 'tokens-tv.css'), '/* :root{--x:0} en un comentario no cuenta */\n:root{\n  --a:1;\n  --b:"x y";\n}\n');
  assert.equal(readTokens(d), '--a:1; --b:"x y";');
  fs.rmSync(d, { recursive: true, force: true });
});
