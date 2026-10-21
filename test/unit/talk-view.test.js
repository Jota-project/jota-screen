'use strict';
// Capa de la conversación en la tele (src/tv/talk-view.js): se inyecta una vez por página, agrupa las actualizaciones,
// guarda las últimas frases en el panel y se oculta 5 s después de terminar (o al momento con hide()).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const PUB = path.join(__dirname, '..', '..', 'remote', 'public');
const { createTalkView } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'talk-view'));

/** cdp falso: guarda las expresiones; `has` dice si la página ya tiene window.TVTalk (como devolvería la expresión). */
function fakeCdp() {
  const c = { session: {}, exprs: [], has: true };
  c.call = async (method, p) => { c.exprs.push(p.expression); return { result: { value: c.has } }; };
  return c;
}
const injects = e => e.includes('attachShadow');
/** Último objeto pasado a render en una expresión. */
function payload(e) {
  const i = e.lastIndexOf('TVTalk.render(');
  assert.ok(i >= 0, 'sin render: ' + e.slice(0, 80));
  const s = e.slice(i + 'TVTalk.render('.length);
  for (let j = s.indexOf(')'); j >= 0; j = s.indexOf(')', j + 1)) { try { return JSON.parse(s.slice(0, j)); } catch {} }
  throw new Error('render sin objeto');
}
const flushMicro = () => new Promise(r => setImmediate(r));

test('la primera actualización inyecta la fuente y las siguientes solo llaman a render', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('panel'); v.you('hola', false);
  t.mock.timers.tick(100); await flushMicro();
  v.you('hola Jota', true);
  t.mock.timers.tick(100); await flushMicro();
  v.jota('Buenas');
  t.mock.timers.tick(100); await flushMicro();
  assert.equal(cdp.exprs.length, 3);
  assert.ok(injects(cdp.exprs[0]), 'la primera lleva la fuente');
  assert.ok(cdp.exprs[0].includes('var __TV_TOKENS='), 'con los tokens delante');
  assert.ok(!injects(cdp.exprs[1]) && !injects(cdp.exprs[2]), 'las siguientes no');
  assert.ok(cdp.exprs[2].length < 1000, 'llamada corta');
  assert.deepEqual(payload(cdp.exprs[2]).lines.map(l => l.text), ['hola Jota', 'Buenas']);
});

test('tras navegar (la página ya no tiene TVTalk, o reset()) se vuelve a inyectar', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('panel'); v.you('uno', true);
  t.mock.timers.tick(100); await flushMicro();
  // la página cambió sin aviso: la llamada corta responde que no hay TVTalk y se repite con la fuente al momento
  cdp.has = false;
  v.jota('dos');
  t.mock.timers.tick(100); await flushMicro(); await flushMicro();
  assert.equal(cdp.exprs.length, 3);
  assert.ok(!injects(cdp.exprs[1]) && injects(cdp.exprs[2]));
  assert.equal(payload(cdp.exprs[2]).lines.at(-1).text, 'dos');
  // aviso explícito de página nueva (server.js: onPage/onAttached): se repinta con la fuente
  cdp.has = true;
  v.reset();
  t.mock.timers.tick(100); await flushMicro();
  assert.equal(cdp.exprs.length, 4);
  assert.ok(injects(cdp.exprs[3]));
});

test('20 tokens en 50 ms producen una sola llamada a render', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('island'); v.you('¿qué tiempo hace?', true);
  t.mock.timers.tick(100); await flushMicro();
  const n = cdp.exprs.length;
  let reply = '';
  for (let i = 0; i < 20; i++) { reply += 'pal' + i + ' '; v.jota(reply); t.mock.timers.tick(2.5); }
  t.mock.timers.tick(100); await flushMicro();
  assert.equal(cdp.exprs.length - n, 1);
  assert.equal(payload(cdp.exprs.at(-1)).lines.at(-1).text, reply);
});

test('el panel guarda las 6 últimas frases; la isla manda solo la frase actual y la respuesta', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  for (let i = 1; i <= 4; i++) { v.turn('panel'); v.you('p' + i, true); v.jota('r' + i); v.done(); }
  // un turno cancelado sin frase no entra en el historial
  v.turn('panel'); v.done();
  v.turn('panel'); v.you('p5', false);
  t.mock.timers.tick(100); await flushMicro();
  let p = payload(cdp.exprs.at(-1));
  assert.equal(p.mode, 'panel');
  assert.equal(p.live, true);
  assert.deepEqual(p.lines.map(l => l.who + ':' + l.text), ['jota:r2', 'you:p3', 'jota:r3', 'you:p4', 'jota:r4', 'you:p5']);
  v.done();
  v.turn('island'); v.you('p6', true); v.jota('r6');
  t.mock.timers.tick(100); await flushMicro();
  p = payload(cdp.exprs.at(-1));
  assert.equal(p.mode, 'island');
  assert.deepEqual(p.lines.map(l => l.who + ':' + l.text), ['you:p6', 'jota:r6']);
  // un error va en el hueco de la respuesta y termina el turno
  v.error('Jota no está disponible.');
  t.mock.timers.tick(100); await flushMicro();
  p = payload(cdp.exprs.at(-1));
  assert.equal(p.live, false);
  assert.deepEqual(p.lines.map(l => l.who + ':' + l.text), ['you:p6', 'jota:Jota no está disponible.']);
});

test('5 s después de done (o de error) se llama a hide; un turno nuevo antes de esos 5 s cancela el hide', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  const hides = () => cdp.exprs.filter(e => e.includes('TVTalk.hide()')).length;
  v.turn('panel'); v.you('hola', true); v.jota('buenas'); v.done();
  t.mock.timers.tick(100); await flushMicro();
  t.mock.timers.tick(4800); await flushMicro();
  assert.equal(hides(), 0);
  t.mock.timers.tick(200); await flushMicro();
  assert.equal(hides(), 1);
  assert.ok(!injects(cdp.exprs.at(-1)), 'ocultar no reinyecta');
  // error: igual
  v.turn('panel'); v.you('otra', true); v.error('No te he entendido. Prueba otra vez.');
  t.mock.timers.tick(5100); await flushMicro();
  assert.equal(hides(), 2);
  // turno nuevo a los 3 s: no se oculta
  v.turn('island'); v.you('a', true); v.done();
  t.mock.timers.tick(3000); await flushMicro();
  v.turn('island'); v.you('b', false);
  t.mock.timers.tick(10000); await flushMicro();
  assert.equal(hides(), 2);
});

test('hide() oculta al momento (isla de actividades a 1), cancela el temporizador y avisa a onHide', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  const hides = () => cdp.exprs.filter(e => e.includes('TVTalk.hide()')).length;
  let told = 0;
  v.onHide(() => told++);
  v.turn('panel'); v.you('hola', true); v.jota('buenas'); v.done();
  t.mock.timers.tick(100); await flushMicro();
  v.hide();
  await flushMicro();
  assert.equal(hides(), 1);
  assert.ok(cdp.exprs.at(-1).includes('window.TVIsland&&window.TVIsland.dim(1)'));
  assert.equal(told, 1);
  t.mock.timers.tick(6000); await flushMicro();
  assert.equal(hides(), 1, 'el temporizador ya no oculta otra vez');
  assert.equal(told, 1);
  // por tiempo también avisa
  v.turn('panel'); v.you('otra', true); v.done();
  t.mock.timers.tick(5100); await flushMicro();
  assert.equal(told, 2);
  // con un render pendiente: hide lo descarta
  v.turn('island'); v.you('x', true);
  v.hide();
  t.mock.timers.tick(200); await flushMicro();
  assert.ok(cdp.exprs.at(-1).includes('TVTalk.hide()'), 'no se repinta tras ocultar');
});

test('tras hide(), un done o error tardío del mismo turno no vuelve a sacar la capa', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('panel'); v.you('hola', true); v.jota('buenas');
  t.mock.timers.tick(100); await flushMicro();
  v.hide();
  const n = cdp.exprs.length;
  v.done(); v.jota('más');
  t.mock.timers.tick(6000); await flushMicro();
  assert.equal(cdp.exprs.length, n, 'nada más en la tele');
  // el turno siguiente pinta normal
  v.turn('panel'); v.you('nueva', true);
  t.mock.timers.tick(100); await flushMicro();
  assert.equal(cdp.exprs.length, n + 1);
});

test('hideMs por defecto 5000; sin sesión de CDP hide() también avisa a onHide', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp(); cdp.session = null;
  const v = createTalkView({ cdp, pub: PUB });
  let told = 0;
  v.onHide(() => told++);
  v.turn('panel'); v.done();
  t.mock.timers.tick(4999); await flushMicro();
  assert.equal(told, 0);
  t.mock.timers.tick(1); await flushMicro();
  assert.equal(told, 1);
  v.hide();
  assert.equal(told, 2);
});

test('durante el turno se atenúa la isla de actividades (TVIsland.dim(0)) y al ocultar vuelve a 1', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('island'); v.you('hola', true);
  t.mock.timers.tick(100); await flushMicro();
  assert.ok(cdp.exprs.at(-1).includes('window.TVIsland&&window.TVIsland.dim(0)'));
  v.done();
  t.mock.timers.tick(5100); await flushMicro();
  const last = cdp.exprs.at(-1);
  assert.ok(last.includes('TVTalk.hide()') && last.includes('window.TVIsland&&window.TVIsland.dim(1)'));
});

test('error (o jota/you) sin turn() abre un intercambio nuevo y no toca el anterior', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('island'); v.you('p1', true); v.jota('r1'); v.done();
  t.mock.timers.tick(100); await flushMicro();
  v.error('Jota no está disponible.');
  t.mock.timers.tick(100); await flushMicro();
  let p = payload(cdp.exprs.at(-1));
  assert.equal(p.mode, 'island', 'sin turn() se queda con el último formato');
  assert.equal(p.live, false);
  assert.deepEqual(p.lines.map(l => l.who + ':' + l.text), ['jota:Jota no está disponible.']);
  // en el panel, el intercambio anterior sigue intacto y el error va aparte
  v.turn('panel'); v.you('p2', true); v.jota('r2'); v.done();
  v.error('Jota no está disponible.');
  v.jota('suelta');
  t.mock.timers.tick(100); await flushMicro();
  p = payload(cdp.exprs.at(-1));
  assert.deepEqual(p.lines.map(l => l.who + ':' + l.text),
    ['jota:r1', 'jota:Jota no está disponible.', 'you:p2', 'jota:r2', 'jota:Jota no está disponible.', 'jota:suelta']);
});

test('una página donde TVTalk no llega a existir recibe la fuente como mucho una vez más (hasta reset)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp();
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('panel'); v.you('a', true);
  t.mock.timers.tick(100); await flushMicro();
  cdp.has = false;
  for (let i = 0; i < 5; i++) { v.you('a' + i, true); t.mock.timers.tick(100); await flushMicro(); await flushMicro(); }
  assert.equal(cdp.exprs.filter(injects).length, 2, 'la primera y un solo reintento');
  v.reset();
  t.mock.timers.tick(100); await flushMicro(); await flushMicro();
  assert.equal(cdp.exprs.filter(injects).length, 3, 'tras reset se vuelve a intentar');
});

test('ocultar devuelve la isla de actividades a 1 aunque TVTalk.hide falle', () => {
  const v = createTalkView({ cdp: fakeCdp(), pub: PUB });
  assert.ok(v);
  const e = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'talk-view')).HIDE;
  let dim = null;
  const window = { TVTalk: { hide() { throw new Error('x'); } }, TVIsland: { dim(x) { dim = x; } } };
  assert.throws(() => new Function('window', e)(window));
  assert.equal(dim, 1);
});

test('sin sesión de CDP no se llama a nada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = fakeCdp(); cdp.session = null;
  const v = createTalkView({ cdp, pub: PUB });
  v.turn('panel'); v.you('hola', true); v.done();
  t.mock.timers.tick(9000); await flushMicro();
  assert.equal(cdp.exprs.length, 0);
});

test('tv-talk.js: solo createElement/textContent y los colores de los tokens', () => {
  const src = fs.readFileSync(path.join(PUB, 'tv-talk.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b/i, 'sin colores sueltos');
  assert.ok(src.includes('fullscreenchange'));
  const { talkSource } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'tokens'));
  assert.ok(talkSource(PUB).startsWith('var __TV_TOKENS='));
});
