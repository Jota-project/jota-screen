'use strict';
// Reposo (remote/idle.js): los ajustes de la capa del agente (agentDesign, glass), saneados y guardados, y el contexto
// que server.js pasa a la conversación de la tele (idle.agentContext()).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'remote');
const createIdle = require(path.join(ROOT, 'idle'));
const { agentContextOf } = createIdle;

/** Reposo sin tele ni red: timers simulados (tiene setInterval propios), sin ubicación (no pide el tiempo). */
function make(t, { url = 'about:blank', file = null, ...deps } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (file) fs.writeFileSync(path.join(dir, 'idle.json'), JSON.stringify(file));
  const state = { url };
  const idle = createIdle({
    PUB: path.join(ROOT, 'public'), SELF: 'http://127.0.0.1:8787', file: path.join(dir, 'idle.json'),
    cdp: { call: async () => ({}), session: null }, nav: async u => { state.url = u; }, state, stageKind: () => null,
    fetch: /** @type {any} */ (async () => { throw new Error('sin red en las pruebas'); }), ...deps,
  });
  return { idle, state, file: path.join(dir, 'idle.json') };
}

test('agentDesign y glass: por defecto v1 y auto; se guardan saneados (lo desconocido vuelve al de por defecto, como el resto)', t => {
  const { idle, file } = make(t);
  assert.equal(idle.run({ op: 'get' }).cfg.agentDesign, 'v1');
  assert.equal(idle.run({ op: 'get' }).cfg.glass, 'auto');
  idle.run({ op: 'set', cfg: { agentDesign: 'v2', glass: 'B' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agentDesign, 'v2');
  idle.run({ op: 'set', cfg: { agentDesign: 'v3', glass: 'x' } });
  const cfg = idle.run({ op: 'get' }).cfg;
  assert.equal(cfg.agentDesign, 'v1');
  assert.equal(cfg.glass, 'auto');
  for (const g of ['auto', 'A', 'B', 'C']) assert.equal(idle.run({ op: 'set', cfg: { glass: g } }).cfg.glass, g);
});

test('glass se conserva al volver al diseño viejo (el mando lo enseña apagado, no lo borra) y vuelve a valer con el nuevo', t => {
  const { idle, file } = make(t);
  idle.run({ op: 'set', cfg: { agentDesign: 'v2', glass: 'B' } });
  assert.equal(idle.run({ op: 'set', cfg: { agentDesign: 'v1' } }).cfg.glass, 'B');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).glass, 'B', 'guardado');
  const cfg = idle.run({ op: 'set', cfg: { agentDesign: 'v2' } }).cfg;
  assert.deepEqual([cfg.agentDesign, cfg.glass], ['v2', 'B']);
});

test('agentContext(): diseño, noche, calma, cristal; fuera del reposo sin colores', t => {
  const { idle } = make(t);
  idle.run({ op: 'set', cfg: { agentDesign: 'v2', calm: true, glass: 'C', mode: 'night' } });
  assert.deepEqual(idle.agentContext(), { design: 'v2', night: true, calm: true, glass: 'C', colors: null, idle: false, music: false });
  idle.run({ op: 'set', cfg: { mode: 'day', calm: false } });
  const a = idle.agentContext();
  assert.equal(a.night, false);
  assert.equal(a.calm, false);
});

test('agentContext() en el reposo con música: idle, music y los dos colores de la carátula, legibles y en hex', t => {
  const { idle, state } = make(t);
  state.url = idle.URL_IDLE;
  idle.setMusic({ track: { name: 'So What' }, artist: 'Miles Davis', playing: true, colors: { hsl: [[200, 0.1, 0.1], [30.4, 0.95, 0.9], [0, 0, 0]] } });
  // hsl(200 35% 55%) y hsl(30.4 85% 75%): saturación y luz acotadas, en hex (lo que admite tv-agent.js)
  assert.deepEqual(idle.agentContext().colors, ['#649ab4', '#f5c089']);
  assert.equal(idle.agentContext().idle, true);
  assert.equal(idle.agentContext().music, true);
  state.url = 'https://example.com/';
  assert.equal(idle.agentContext().colors, null, 'fuera del reposo la música no se consulta: sin colores');
});

test('agentContextOf: colores rotos o de menos → null', () => {
  const cfg = { agentDesign: 'v1', glass: 'auto', calm: false };
  for (const colors of [null, [[1, 2, 3]], [[1, 2], [3, 4]], [['a', 1, 1], [1, 1, 1]], 'x']) {
    assert.equal(agentContextOf({ cfg, profile: 'day', idle: true, music: { colors } }).colors, null, JSON.stringify(colors));
  }
  assert.equal(agentContextOf({ cfg, profile: 'day', idle: true, music: null }).music, false);
});

// ───────── «Seguir viendo» configurable (suggest)
const NFX = [{ id: 1, title: 'Suits', pos: 100, dur: 2400 }, { id: 2, title: 'Dark', pos: 0, dur: 3000 }];
const SONG = { track: { name: 'So What' }, artist: 'Miles Davis', album: { name: 'Kind of Blue', image: { l: 'https://i.scdn.co/a' } }, playing: true, progress: 1, duration: 9, at: 0, context: { type: 'playlist', name: 'Jazz' } };
const ids = cfg => cfg.suggest.sources.map(x => x.id + (x.on ? '+' : '-')).join(' ');

test('suggest: por defecto apagado, discreto, 2 a la vez y Netflix, Spotify, YouTube; se sanea (desconocidas fuera, sin repetir, las que faltan al final)', t => {
  const { idle } = make(t);
  const c0 = idle.run({ op: 'get' }).cfg;
  assert.deepEqual([c0.suggest.on, c0.suggest.look, c0.suggest.max, c0.netflix], [false, 'discreto', 2, 'off']);
  assert.equal(ids(c0), 'netflix+ spotify+ youtube-');
  const c = idle.run({ op: 'set', cfg: { suggest: { on: true, max: 7, look: 'raro', sources: [{ id: 'youtube', on: true }, { id: 'hbo', on: true }, { id: 'netflix', on: false }, { id: 'youtube', on: false }] } } }).cfg;
  assert.equal(c.suggest.max, 2, 'max fuera de 1–3: el de antes');
  assert.equal(c.suggest.look, 'discreto');
  assert.equal(ids(c), 'youtube+ netflix- spotify+', 'YouTube guarda su sitio; Spotify, que faltaba, al final (sigue a music)');
  assert.equal(c.netflix, 'off', 'espejo: Netflix apagada');
});

test('suggest: Spotify es music (un solo interruptor) y netflix es el espejo para los mandos de antes, en los dos sentidos', t => {
  const { idle, file } = make(t);
  let c = idle.run({ op: 'set', cfg: { music: false } }).cfg;
  assert.equal(ids(c), 'netflix+ spotify- youtube-');
  c = idle.run({ op: 'set', cfg: { suggest: { ...c.suggest, on: true } } }).cfg;
  assert.equal(c.netflix, 'on');
  // un mando viejo apaga «Seguir viendo de Netflix» mandando la config entera (con el suggest que recibió)
  c = idle.run({ op: 'set', cfg: { ...c, netflix: 'off' } }).cfg;
  assert.deepEqual([c.suggest.on, ids(c), c.netflix], [true, 'netflix- spotify- youtube-', 'off']);
  // y lo enciende: enciende Netflix y, si hacía falta, el apartado
  c = idle.run({ op: 'set', cfg: { suggest: { ...c.suggest, on: false } } }).cfg;
  c = idle.run({ op: 'set', cfg: { ...c, netflix: 'on' } }).cfg;
  assert.deepEqual([c.suggest.on, ids(c)], [true, 'netflix+ spotify- youtube-']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).suggest.on, true, 'guardado');
});

test('suggest: un idle.json de antes con netflix: on se lee como el apartado encendido con Netflix', t => {
  const { idle } = make(t, { file: { netflix: 'on', music: true } });
  const c = idle.run({ op: 'get' }).cfg;
  assert.deepEqual([c.suggest.on, ids(c), c.netflix], [true, 'netflix+ spotify+ youtube-', 'on']);
});

test('wantSuggestions: fuentes en orden con datos, hasta max; de noche nada; Spotify «seguir escuchando» hasta 3 h', t => {
  let T = 1e12;
  const { idle } = make(t, { nfx: () => NFX, now: () => T });
  assert.equal(idle.suggest(), null, 'apagado');
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true } } });
  assert.deepEqual(idle.suggest().blocks.map(b => b.src), ['netflix'], 'sin música: solo Netflix');
  idle.setMusic(SONG);
  idle.suggest();                                        // Spotify quiere entrar (espera 5 min: ver la prueba siguiente)
  T += 5 * 60e3 + 1;
  let s = idle.suggest();
  assert.deepEqual(s.blocks.map(b => b.src), ['netflix', 'spotify']);
  assert.deepEqual([s.look, s.blocks[1].state, s.blocks[1].track, s.blocks[1].ctx, s.blocks[1].art], ['discreto', 'playing', 'So What', 'Jazz', 'https://i.scdn.co/a']);
  idle.setMusic(null);                                   // deja de sonar: «seguir escuchando» con lo último
  assert.equal(idle.suggest().blocks[1].state, 'resume');
  T += 3 * 3600e3 + 1;
  idle.run({ op: 'set', cfg: { suggest: { on: true, max: 1 } } });
  assert.deepEqual(idle.suggest().blocks.map(b => b.src), ['netflix'], 'max 1 (y Spotify ya caducado)');
  idle.run({ op: 'set', cfg: { mode: 'night' } });
  assert.equal(idle.suggest(), null, 'de noche no sale');
});

test('wantSuggestions: un cambio de fuentes espera 5 min seguidos (pausar no recoloca la pantalla); aparecer, al momento', t => {
  let T = 1e12, items = NFX;
  const { idle } = make(t, { nfx: () => items, now: () => T });
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true, sources: [{ id: 'spotify', on: true }, { id: 'netflix', on: true }] } } });
  assert.deepEqual(idle.suggest().blocks.map(b => b.src), ['netflix'], 'aparece al momento');
  idle.setMusic(SONG);
  assert.deepEqual(idle.suggest().blocks.map(b => b.src), ['netflix'], 'Spotify quiere entrar: espera');
  T += 4 * 60e3;
  assert.deepEqual(idle.suggest().blocks.map(b => b.src), ['netflix']);
  T += 61e3;
  assert.deepEqual(idle.suggest().blocks.map(b => b.src), ['spotify', 'netflix'], 'a los 5 min entra, en su orden');
  items = [];
  idle.run({ op: 'set', cfg: { music: false } });
  assert.equal(idle.suggest(), null, 'sin nada que enseñar: fuera al momento');
});

test('wantSuggestions: aspecto «según el momento»: en grande si una serie es el 70 % de los últimos días y va primera', t => {
  let dom = { title: 'Suits', share: 0.8, n: 10 };
  const { idle } = make(t, { nfx: () => NFX, nfxDominant: () => dom });
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true, look: 'auto' } } });
  assert.equal(idle.suggest().look, 'destacado');
  dom = { title: 'Suits', share: 0.5, n: 10 };
  assert.equal(idle.suggest().look, 'discreto', 'no manda tanto');
  dom = { title: 'Dark', share: 0.9, n: 10 };
  assert.equal(idle.suggest().look, 'discreto', 'manda otra que no va primera');
});
