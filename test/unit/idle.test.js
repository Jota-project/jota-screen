'use strict';
// Reposo (remote/idle.js): el ajuste de la capa del agente (glass), saneados y guardados, y el contexto
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

test('glass: por defecto auto; se guarda saneado (lo desconocido vuelve al de por defecto, como el resto)', t => {
  const { idle, file } = make(t);
  assert.equal(idle.run({ op: 'get' }).cfg.glass, 'auto');
  idle.run({ op: 'set', cfg: { glass: 'B' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).glass, 'B', 'guardado');
  assert.equal(idle.run({ op: 'set', cfg: { glass: 'x' } }).cfg.glass, 'auto');
  for (const g of ['auto', 'A', 'B', 'C']) assert.equal(idle.run({ op: 'set', cfg: { glass: g } }).cfg.glass, g);
});

test('un idle.json viejo con agentDesign: se descarta al cargar y no vuelve a guardarse', t => {
  const { idle, file } = make(t, { file: { agentDesign: 'v2', glass: 'C' } });
  const cfg = idle.run({ op: 'get' }).cfg;
  assert.equal(cfg.glass, 'C');
  assert.ok(!('agentDesign' in cfg));
  idle.run({ op: 'set', cfg: { agentDesign: 'v1', calm: true } });
  assert.ok(!('agentDesign' in JSON.parse(fs.readFileSync(file, 'utf8'))));
});

test('agentContext(): noche, calma, cristal; fuera del reposo sin colores', t => {
  const { idle } = make(t);
  idle.run({ op: 'set', cfg: { calm: true, glass: 'C', mode: 'night' } });
  assert.deepEqual(idle.agentContext(), { night: true, calm: true, glass: 'C', colors: null, idle: false, music: false });
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
  const cfg = { glass: 'auto', calm: false };
  for (const colors of [null, [[1, 2, 3]], [[1, 2], [3, 4]], [['a', 1, 1], [1, 1, 1]], 'x']) {
    assert.equal(agentContextOf({ cfg, profile: 'day', idle: true, music: { colors } }).colors, null, JSON.stringify(colors));
  }
  assert.equal(agentContextOf({ cfg, profile: 'day', idle: true, music: null }).music, false);
});

// ───────── «Seguir viendo» configurable (suggest)
const NFX = [{ id: 1, title: 'Suits', pos: 100, dur: 2400 }, { id: 2, title: 'Dark', pos: 0, dur: 3000 }];
const SONG = { track: { name: 'So What' }, artist: 'Miles Davis', album: { name: 'Kind of Blue', image: { l: 'https://i.scdn.co/a' } }, playing: true, progress: 1, duration: 9, at: 0, context: { type: 'playlist', name: 'Jazz' } };
const ids = cfg => cfg.suggest.sources.map(x => x.id + (x.on ? '+' : '-')).join(' ');

test('suggest: por defecto apagado con Netflix, Spotify y YouTube; se sanea (desconocidas fuera, sin repetir, las que faltan al final) y sin max/look/mode', t => {
  const { idle } = make(t, { file: { suggest: { on: true, max: 3, look: 'destacado', mode: 'fijo' } } });
  const c0 = idle.run({ op: 'get' }).cfg;
  assert.deepEqual(Object.keys(c0.suggest).sort(), ['on', 'sources'], 'lo de fijo de un idle.json de antes, fuera');
  const c = idle.run({ op: 'set', cfg: { suggest: { on: true, sources: [{ id: 'youtube', on: true }, { id: 'hbo', on: true }, { id: 'netflix', on: false }, { id: 'youtube', on: false }] } } }).cfg;
  assert.equal(ids(c), 'youtube+ netflix- spotify+', 'YouTube guarda su sitio; Spotify, que faltaba, al final (sigue a music)');
  assert.equal(c.netflix, 'off', 'espejo: Netflix apagada');
});

test('suggest: por defecto apagado, con Netflix y Spotify encendidas', t => {
  const c = make(t).idle.run({ op: 'get' }).cfg;
  assert.deepEqual([c.suggest.on, ids(c)], [false, 'netflix+ spotify+ youtube-']);
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

test('seguir viendo: una tarjeta, la fuente más reciente de las últimas 3 h; si no, nada; noche nada; sonando, Spotify', t => {
  let T = 1e12, recent = { at: T - 40 * 60e3, items: [NFX[0]] };
  const { idle } = make(t, { nfxRecent: () => recent, now: () => T });
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true } } });
  let s = idle.suggest();
  assert.deepEqual([s.look, s.blocks.length, s.blocks[0].src, s.blocks[0].ago], ['discreto', 1, 'netflix', T - 40 * 60e3]);
  idle.setMusic(SONG); idle.setMusic(null);              // Spotify sonó después: gana Spotify (resume)
  idle.suggest(); T += 5 * 60e3 + 1;                     // Spotify quiere entrar: espera la histéresis de hold()
  s = idle.suggest(); assert.deepEqual([s.blocks.length, s.blocks[0].src, s.blocks[0].state], [1, 'spotify', 'resume']);
  T += 3 * 3600e3 + 1;
  assert.equal(idle.suggest(), null, 'pasadas las 3 h: lo esencial');
  idle.setMusic(SONG); assert.equal(idle.suggest().blocks[0].state, 'playing', 'sonando: siempre');
  recent = { at: T, items: [] }; idle.setMusic(null);
  idle.suggest(); T += 5 * 60e3 + 1;
  assert.equal(idle.suggest().blocks[0].src, 'spotify', 'Netflix sin título que case: no sale');
  idle.run({ op: 'set', cfg: { mode: 'night' } }); assert.equal(idle.suggest(), null);
});

test('fresh: al apagar va al reposo; ya en el reposo o con fresh false, nada', async t => {
  const { idle, state } = make(t, { url: 'https://www.netflix.com/watch/1' });
  assert.equal(idle.run({ op: 'get' }).cfg.fresh, true);
  await idle.fresh(); assert.ok(idle.isIdle(state.url));
  state.url = 'https://example.com';
  idle.run({ op: 'set', cfg: { fresh: false } });
  await idle.fresh(); assert.equal(state.url, 'https://example.com');
  assert.equal(idle.run({ op: 'set', cfg: { fresh: 'x', usage: 0 } }).cfg.usage, false);
});

test('fresh: un segundo fresh() ya en el reposo no navega; si nav falla, resuelve sin lanzar', async t => {
  let n = 0, fail = true, st;
  const { idle, state } = make(t, { url: 'https://example.com', nav: async u => { n++; if (fail) throw new Error('cdp caído'); st.url = u; } });
  st = state;
  await idle.fresh(); assert.equal(n, 1, 'nav falla y fresh resuelve');
  fail = false;
  await idle.fresh(); await idle.fresh(); assert.equal(n, 2, 'tras ir al reposo, el segundo no navega');
});

test('seguir viendo: un Spotify en pausa que se sondea al abrir el reposo no tapa a Netflix (cuenta cuándo sonó, no cuándo se vio)', t => {
  let T = 1e12, recent = null;
  const { idle } = make(t, { nfxRecent: () => recent, now: () => T });
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true } } });
  idle.setMusic(SONG); idle.setMusic({ ...SONG, playing: false });   // sonó y se pausó en T0
  T += 2 * 3600e3; recent = { at: T - 60e3, items: [NFX[0]] };       // Netflix dejado hace 1 min
  idle.setMusic({ ...SONG, playing: false });                         // sondeo al abrir el reposo: pausado
  const s = idle.suggest();
  assert.deepEqual(s.blocks.map(b => b.src), ['netflix']);
  T += 2 * 3600e3; recent = null;                                     // sin Netflix; Spotify sonó hace 4 h: fuera
  idle.setMusic({ ...SONG, playing: false });
  assert.equal(idle.suggest(), null, 'la ventana de 3 h se cuenta desde que sonó');
});

test('seguir viendo: Spotify que empieza a sonar tapa a la tarjeta de Netflix al momento, sin esperar la histéresis', t => {
  let T = 1e12;
  const { idle } = make(t, { nfxRecent: () => ({ at: T - 10 * 60e3, items: [NFX[0]] }), now: () => T });
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true } } });
  assert.equal(idle.suggest().blocks[0].src, 'netflix');
  idle.setMusic(SONG); T += 60e3;
  const b = idle.suggest().blocks[0];
  assert.deepEqual([b.src, b.state], ['spotify', 'playing']);
});

test('privacidad: oculta la tarjeta y lo que suena salvo lo que se deje ver; al activarla, hasta las 6:00 de la tele', t => {
  let T = Date.UTC(2026, 10, 6, 21, 30);                               // 21:30 UTC (tz por defecto: UTC)
  const { idle, file } = make(t, { nfxRecent: () => ({ at: T - 10 * 60e3, items: [NFX[0]] }), now: () => T });
  idle.run({ op: 'set', cfg: { mode: 'day', suggest: { on: true } } });
  assert.equal(idle.suggest().blocks[0].src, 'netflix');
  const c = idle.run({ op: 'set', cfg: { privacy: { on: true, show: ['spotify', 'hbo'] } } }).cfg;
  assert.deepEqual([c.privacy.on, c.privacy.until, c.privacy.show], [true, Date.UTC(2026, 10, 7, 6, 0), ['spotify']]);
  assert.equal(idle.suggest(), null, 'Netflix oculta');
  idle.setMusic(SONG);
  assert.equal(idle.suggest().blocks[0].src, 'spotify', 'Spotify se deja ver');
  idle.run({ op: 'set', cfg: { privacy: { on: true, show: [] } } });
  assert.equal(idle.suggest(), null, 'todo oculto');
  assert.equal(JSON.parse(idle.payload()).music, null, 'tampoco «suena ahora»');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).privacy.until, Date.UTC(2026, 10, 7, 6, 0), 'cambiar show no la alarga');
  T = Date.UTC(2026, 10, 7, 6, 0);
  assert.equal(idle.suggest().blocks[0].src, 'spotify', 'a las 6:00 se quita sola');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).privacy.on, false, 'y se guarda');
  assert.equal(idle.run({ op: 'set', cfg: { privacy: { on: false, until: T + 1e6 } } }).cfg.privacy.until, null);
});

test('privacidad: activada de madrugada, se quita a las 6:00 de ese día; un until futuro (MCP) se respeta', t => {
  const T = Date.UTC(2026, 10, 7, 2, 0);
  const { idle } = make(t, { now: () => T });
  assert.equal(idle.run({ op: 'set', cfg: { privacy: { on: true } } }).cfg.privacy.until, Date.UTC(2026, 10, 7, 6, 0));
  idle.run({ op: 'set', cfg: { privacy: { on: false } } });
  assert.equal(idle.run({ op: 'set', cfg: { privacy: { on: true, until: T + 3600e3 } } }).cfg.privacy.until, T + 3600e3);
});
