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

test('volumen (wpctl): unmute quita el silencio del sink', async () => {
  const runs = [];
  const audio = createAudio({ runtimeDir: '/x', exec: async a => { runs.push(a.join(' ')); return ''; } });
  await audio.unmute();
  assert.deepEqual(runs, ['set-mute @DEFAULT_AUDIO_SINK@ 0']);
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

test('CDP: al conectar con Netflix cargada detrás, se engancha la pestaña que se ve', async () => {
  const fake = await startFakeCdp({
    pages: [{ targetId: 'P1', type: 'page', url: 'http://127.0.0.1:8787/idle.html', title: 'Salón' }, { targetId: 'P2', type: 'page', url: 'https://www.netflix.com/browse', title: 'Netflix' }],
    evaluate: (e, m) => (e === 'document.visibilityState' ? (m.sessionId === 'S-P2' ? 'hidden' : 'visible') : undefined),
  });
  const cdp = createCdp({ port: fake.port, log: { info() {}, error() {} }, timeoutMs: 500, retryMs: 50 });
  try {
    cdp.connect();
    await fake.waitFor(m => m.method === 'Target.attachToTarget' && m.params.targetId === 'P2');
    for (let i = 0; i < 100 && cdp.session !== 'S-P1'; i++) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(cdp.targetId, 'P1'); assert.equal(cdp.session, 'S-P1');
  } finally { cdp.stop(); await fake.close(); }
});

test('CDP: una pestaña de fondo no se engancha, no cuenta entre las pestañas y se cierra', async () => {
  const fake = await startFakeCdp({ pages: [{ targetId: 'P1', type: 'page', url: 'http://127.0.0.1:8787/idle.html', title: 'Salón' }], evaluate: e => (e.includes('location.href') ? 'https://www.netflix.com/browse' : undefined) });
  const cdp = createCdp({ port: fake.port, log: { info() {}, error() {} }, timeoutMs: 500, retryMs: 50 });
  try {
    cdp.connect();
    for (let i = 0; i < 100 && !cdp.session; i++) await new Promise(r => setTimeout(r, 10));
    const tab = await cdp.bgTab();
    await tab.go('https://www.netflix.com/browse');
    // Chrome avisa de que la pestaña ha navegado: tampoco así entra entre las pestañas
    fake.event('Target.targetInfoChanged', { targetInfo: { targetId: 'P2', type: 'page', url: 'https://www.netflix.com/browse', title: 'Netflix' } });
    assert.equal(await tab.ev(() => globalThis.location.href), 'https://www.netflix.com/browse');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(cdp.session, 'S-P1', 'la sesión activa sigue en la que se ve');
    assert.deepEqual([...cdp.pages.keys()], ['P1']);
    assert.ok(cdp.bg.has('P2'));
    assert.ok(!fake.find('Target.activateTarget').length, 'nunca se trae al frente');
    const nav = fake.find('Page.navigate')[0];
    assert.equal(nav.sessionId, 'S-P2', 'navega la de fondo, no la activa');
    assert.ok(fake.find('Page.addScriptToEvaluateOnNewDocument').some(c => c.sessionId === 'S-P2' && /pause/.test(c.params.source)), 'muda antes de cargar nada');
    await tab.close();
    assert.ok(fake.find('Target.closeTarget').some(c => c.params.targetId === 'P2'));
  } finally { cdp.stop(); await fake.close(); }
});

test('CDP show: engancha la pestaña detrás, espera a que pinte (onAttached), la trae al frente, avisa a la que deja (onLeft) y la suelta', async () => {
  const fake = await startFakeCdp({ pages: [{ targetId: 'P1', type: 'page', url: 'http://127.0.0.1:8787/idle.html', title: 'Salón' },
    { targetId: 'P2', type: 'page', url: 'https://www.netflix.com/browse', title: 'Netflix' }], evaluate: () => 'visible' });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /** @type {(from: any) => any} */ let paint = () => undefined;
  /** @type {any[]} */ const left = [], froms = [];
  const cdp = createCdp({ port: fake.port, log: { info() {}, error() {} }, timeoutMs: 500, retryMs: 50, frontWaitMs: 150, hooks: {
    onAttached: (t, from) => { froms.push(from); return paint(from); },
    onLeft: call => { left.push('left'); return call('Runtime.evaluate', { expression: 'DEJA' }); },
  } });
  try {
    cdp.connect();
    for (let i = 0; i < 100 && !(cdp.session === 'S-P2' && !cdp.attaching); i++) await sleep(10);
    assert.equal(cdp.session, 'S-P2');
    const i0 = fake.calls.length;
    // pintar en la pestaña nueva tarda: show no la trae al frente hasta que acaba
    paint = from => from('Runtime.evaluate', { expression: 'MIRA' }).then(() => sleep(60)).then(() => cdp.call('Runtime.evaluate', { expression: 'PINTA' }));
    await cdp.show('P1');
    const after = fake.calls.slice(i0), at = (method, f = () => true) => after.findIndex(c => c.method === method && f(c));
    const attach = at('Target.attachToTarget', c => c.params.targetId === 'P1'), painted = at('Runtime.evaluate', c => c.params.expression === 'PINTA');
    const front = at('Target.activateTarget'), deja = at('Runtime.evaluate', c => c.params.expression === 'DEJA');
    const detach = at('Target.detachFromTarget', c => c.params.sessionId === 'S-P2');
    assert.ok(attach >= 0 && attach < painted && painted < front, `engancha y pinta antes de traerla al frente (${attach}, ${painted}, ${front})`);
    assert.equal(after[painted].sessionId, 'S-P1', 'pinta en la nueva');
    const mira = at('Runtime.evaluate', c => c.params.expression === 'MIRA');
    assert.ok(mira >= 0 && mira < front && after[mira].sessionId === 'S-P2', 'onAttached puede mirar la que se deja (from), aún enganchada');
    assert.ok(front < deja && deja < detach, `luego avisa a la que deja y la suelta (${front}, ${deja}, ${detach})`);
    assert.equal(after[deja].sessionId, 'S-P2', 'onLeft va a la sesión de la que se deja');
    assert.deepEqual([cdp.targetId, cdp.session, left.length], ['P1', 'S-P1', 1]);
    // quien escucha no contesta nunca: el cambio de pestaña no se cuelga (tope frontWaitMs)
    paint = () => new Promise(() => {});
    const t0 = Date.now();
    await cdp.show('P2');
    assert.ok(Date.now() - t0 < 150 + 250, `show acaba igual (${Date.now() - t0} ms)`);
    assert.equal(cdp.session, 'S-P2');
    // activate a secas (autoActivate, pestaña cerrada) sigue soltando la anterior antes de enganchar
    paint = () => undefined;
    const i1 = fake.calls.length;
    await cdp.activate('P1');
    const a = fake.calls.slice(i1);
    const d = a.findIndex(c => c.method === 'Target.detachFromTarget' && c.params.sessionId === 'S-P2');
    assert.ok(d >= 0 && d < a.findIndex(c => c.method === 'Target.attachToTarget'), 'activate suelta la anterior primero');
    assert.equal(left.length, 2, 'onLeft solo desde show');
    assert.equal(froms.at(-1), null, 'sin show no hay from');
  } finally { cdp.stop(); await fake.close(); }
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

// ── reproducción de verdad (ronda 2): señal aparte de `media`, para el paso del panel a la píldora
const dev = require(path.join(R, 'devices'));
test('PAGE_PROBE: `media` sigue igual (4 primeros valores) y el 5.º es el vídeo que suena con más área', () => {
  assert.deepEqual(parseProbe([1, 500, 2000, 1000, [0.9, 12.5]]), { media: 1, scroll: { pos: 0.5, size: 0.5 } }, 'parseProbe no cambia');
  assert.deepEqual(dev.parsePlayback([1, 0, 0, 0, [0.9, 12.5]]), { area: 0.9, t: 12.5 });
  assert.equal(dev.parsePlayback([1, 0, 0, 0, null]), null);
  assert.equal(dev.parsePlayback([1, 0, 0, 0]), null);
  assert.equal(dev.parsePlayback([1, 0, 0, 0, ['x', 1]]), null);
  for (const k of ['paused', 'ended', 'readyState<' + dev.PLAYBACK_MIN_READY, 'fullscreenElement', 'getBoundingClientRect']) assert.ok(dev.PAGE_PROBE.includes(k), k);
});

test('createPlaybackWatch: grande y avanzando durante el dwell → true; pequeño, quieto o pausado → false al momento', () => {
  const w = dev.createPlaybackWatch({ dwellMs: 600 });
  const big = t => ({ area: 1, t });
  assert.equal(w.update(big(0), 0), false, 'una lectura no dice si avanza');
  assert.equal(w.update(big(0.25), 250), false);
  assert.equal(w.update(big(0.5), 500), false);
  assert.equal(w.update(big(0.75), 750), true, '600 ms avanzando desde la primera lectura');
  assert.equal(w.update(big(0.75), 1000), false, 'se para (buffering, pausa): false');
  assert.equal(w.update(big(1), 1250), false, 'vuelve a contar');
  const tr = dev.createPlaybackWatch({ dwellMs: 600 });
  let on = false;
  for (let i = 0; i < 20; i++) on = tr.update({ area: dev.PLAYBACK_MIN_AREA - 0.1, t: i * 0.25 }, i * 250) || on;
  assert.equal(on, false, 'un tráiler pequeño nunca');
  w.update(big(2), 1500); w.update(big(2.3), 1800); w.update(big(2.6), 2100);
  assert.equal(w.on, true);
  assert.equal(w.update(null, 2400), false, 'sin vídeo sonando');
  w.reset(); assert.equal(w.on, false);
});
