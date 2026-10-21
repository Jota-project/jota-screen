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
function make(t, { url = 'about:blank', saved = null } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (saved) fs.writeFileSync(path.join(dir, 'idle.json'), JSON.stringify(saved));
  const state = { url };
  const idle = createIdle({
    PUB: path.join(ROOT, 'public'), SELF: 'http://127.0.0.1:8787', file: path.join(dir, 'idle.json'),
    cdp: { call: async () => ({}), session: null }, nav: async u => { state.url = u; }, state, stageKind: () => null,
    fetch: /** @type {any} */ (async () => { throw new Error('sin red en las pruebas'); }),
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
  const { idle, file } = make(t, { saved: { agentDesign: 'v2', glass: 'C' } });
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
