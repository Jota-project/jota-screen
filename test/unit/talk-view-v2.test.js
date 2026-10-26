'use strict';
// Conversación en la tele (src/tv/talk-view.js): la foto (SNAP) que recibe TVAgent.render, el estado del orbe derivado
// aquí, 2 turnos en el panel (1 en la píldora), fichas e iconos, cierre 4000 + 45 × letras, tandas y ocultación.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REMOTE = path.join(__dirname, '..', '..', 'remote');
const tv = require(path.join(REMOTE, 'src', 'tv', 'talk-view'));
const { createTalkView, snapshot, KEEP_TURNS, CLOSE_BASE_MS, CLOSE_PER_CHAR_MS, RETRY_HINT } = tv;
const { KINDS } = require(path.join(REMOTE, 'src', 'features', 'agent-ui'));
const { agentSource } = require(path.join(REMOTE, 'src', 'tv', 'tokens'));

// public/ de prueba: los tokens de verdad y un tv-agent.js mínimo (el de verdad lo escribe la página)
const PUB = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-view-'));
fs.mkdirSync(path.join(PUB, 'shared'));
fs.copyFileSync(path.join(REMOTE, 'public', 'shared', 'tokens-tv.css'), path.join(PUB, 'shared', 'tokens-tv.css'));
fs.writeFileSync(path.join(PUB, 'tv-agent.js'), '/* AGENTE-MINIMO */window.TVAgent=window.TVAgent||{render(){return true},hide(){}};\n');
test.after(() => fs.rmSync(PUB, { recursive: true, force: true }));

// Runtime.evaluate en `exprs` (lo que pinta); el resto (scripts de documento nuevo, Page.enable) en `calls`
function fakeCdp() {
  const c = { session: {}, exprs: [], calls: [], has: true, ids: 0, probe: /** @type {any} */ (undefined) };
  c.call = async (method, p) => {
    if (method === 'Runtime.evaluate') {
      c.exprs.push(p.expression);
      // la sonda de pintada contesta `probe` (valor o función que lo da, quizá una promesa) si la prueba lo pone
      if (c.probe !== undefined && p.expression.includes('elementsFromPoint')) return { result: { value: await (typeof c.probe === 'function' ? c.probe() : c.probe) } };
      return { result: { value: c.has } };
    }
    c.calls.push({ method, ...p });
    return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: String(++c.ids) } : {};
  };
  return c;
}
/** Contexto que cada prueba cambia a mano (lo que server.js saca de idle.agentContext() y del estado de la tele). */
const ctxOf = (o = {}) => ({ ctx: 'idle', night: false, calm: false, glass: 'auto', colors: null, ...o });
function make(o) {
  const cdp = fakeCdp(), c = { now: ctxOf(o) };
  const v = createTalkView({ cdp, pub: PUB, context: () => c.now });
  return { cdp, v, c };
}
/** Último objeto pasado a `<global>.render(` en una expresión. */
function arg(e, g = 'TVAgent') {
  const k = `window.${g}.render(`, i = e.lastIndexOf(k);
  assert.ok(i >= 0, 'sin render de ' + g + ': ' + e.slice(-120));
  const s = e.slice(i + k.length);
  for (let j = s.indexOf(')'); j >= 0; j = s.indexOf(')', j + 1)) { try { return JSON.parse(s.slice(0, j)); } catch {} }
  throw new Error('render sin objeto');
}
const flushMicro = () => new Promise(r => setImmediate(r));
async function step(t, ms = 100) { t.mock.timers.tick(ms); await flushMicro(); }
// la última expresión que pinta (las de esperar a la pintada de una página nueva no llevan foto)
const last = cdp => arg(cdp.exprs.filter(e => e.includes('.render(')).at(-1));

test('la primera foto lleva la fuente de tv-agent.js (con tokens) y la foto con las claves exactas del contrato', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel', { voice: true });
  await step(t);
  const e = cdp.exprs[0];
  assert.ok(e.startsWith('(()=>{' + agentSource(PUB) + '\n;'), 'inyecta tv-agent.js con los tokens delante (tokens.agentSource)');
  const s = last(cdp);
  assert.deepEqual(Object.keys(s).sort(), ['calm', 'colors', 'ctx', 'enter', 'form', 'glass', 'icons', 'live', 'night', 'state', 'turns']);
  assert.deepEqual(s, { form: 'panel', ctx: 'idle', state: 'listen', live: true, night: false, calm: false, glass: 'auto', colors: null,
    turns: [{ id: s.turns[0].id, you: '', youFinal: false, jota: '', tools: [], error: false, hint: '' }], icons: {}, enter: 'open' });
  v.you('hola', false);
  await step(t);
  assert.ok(!cdp.exprs[1].includes('AGENTE-MINIMO') && cdp.exprs[1].length < 2000, 'las siguientes, cortas');
});

test('estado derivado: voz → listen; final → think; herramienta → think; primer token → talk; done → done', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  const states = [];
  const see = async () => { await step(t); states.push(last(cdp).state); };
  v.turn('panel', { voice: true }); await see();
  v.you('pon', false); await see();
  v.you('pon jazz', true); await see();
  v.tool({ id: 'c1', kind: 'music', title: 'Reproducir música', detail: 'Spotify' }); await see();
  let s = last(cdp);
  assert.deepEqual(s.turns[0].tools, [{ id: 'c1', kind: 'music', title: 'Reproducir música', detail: 'Spotify', status: 'run' }]);
  assert.deepEqual(s.icons, { music: JSON.parse(JSON.stringify(KINDS.music.icon)) }, 'solo los iconos de los tipos que aparecen');
  v.toolEnd({ id: 'c1', ok: true }); await see();
  v.jota('Ahí'); await see();
  v.jota('Ahí va.'); await see();
  v.done(); await see();
  assert.deepEqual(states, ['listen', 'listen', 'think', 'think', 'think', 'talk', 'talk', 'done']);
  s = last(cdp);
  assert.equal(s.live, false);
  assert.equal(s.turns[0].youFinal, true);
  assert.equal(s.turns[0].tools[0].status, 'ok');
  // escrito (ask): empieza pensando
  v.turn('panel', { voice: false }); await see();
  v.turn('panel'); await see();
  assert.deepEqual(states.slice(-2), ['think', 'think']);
});

test('fallo de herramienta: ficha fail, pista de reintento y el orbe se queda en error (también tras la respuesta y done)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel', { voice: false }); v.you('enciende la luz', true);
  v.tool({ id: 'h', kind: 'home', title: 'Casa', detail: 'Salón' });
  v.toolEnd({ id: 'h', ok: false });
  await step(t);
  let s = last(cdp);
  assert.equal(s.state, 'error');
  assert.equal(s.turns[0].tools[0].status, 'fail');
  assert.equal(s.turns[0].hint, RETRY_HINT);
  assert.equal(RETRY_HINT, 'Di «otra vez» para reintentar.');
  v.jota('No he podido conectar con la casa.');
  v.tool({ id: 'h2', kind: 'home', title: 'Casa', detail: 'Salón' });
  await step(t);
  assert.equal(last(cdp).state, 'error', 'ni el token ni otra herramienta lo sacan de error');
  v.done(); await step(t);
  s = last(cdp);
  assert.equal(s.state, 'error');
  assert.equal(s.live, false);
  // el turno siguiente empieza limpio
  v.turn('panel', { voice: true }); await step(t);
  assert.equal(last(cdp).state, 'listen');
});

test('fallo despejado: otra herramienta que acaba bien quita la pista y el orbe sigue (el error de error() no se despeja)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  assert.equal(tv.RECOVER_ON_OK, true);
  v.turn('panel'); v.you('enciende la luz', true);
  v.tool({ id: 'h', kind: 'home', title: 'Casa', detail: 'Salón' }); v.toolEnd({ id: 'h', ok: false });
  v.tool({ id: 'h2', kind: 'home', title: 'Casa', detail: 'Salón' }); v.toolEnd({ id: 'h2', ok: true });
  await step(t);
  let s = last(cdp);
  assert.deepEqual([s.state, s.turns[0].hint, s.turns[0].tools.map(x => x.status)], ['think', '', ['fail', 'ok']]);
  v.jota('Listo.'); v.done(); await step(t);
  assert.equal(last(cdp).state, 'done', 'el agente se recuperó solo');
  // con texto ya dicho vuelve a talk; tras error() nada lo despeja
  v.turn('panel'); v.you('otra', true); v.jota('Voy');
  v.tool({ id: 'a', kind: 'web', title: 'W', detail: '' }); v.toolEnd({ id: 'a', ok: false });
  v.tool({ id: 'b', kind: 'web', title: 'W', detail: '' }); v.toolEnd({ id: 'b', ok: true });
  await step(t);
  assert.equal(last(cdp).state, 'talk');
  v.error('Jota no está disponible.'); v.tool({ id: 'c', kind: 'web', title: 'W', detail: '' }); v.toolEnd({ id: 'c', ok: true });
  await step(t);
  s = last(cdp);
  assert.deepEqual([s.state, s.turns.at(-1).error], ['error', true]);
});

test('fichas sin result: dejan de girar al cerrar (done, error/down), al Parar y al archivar un turno interrumpido', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const card = id => ({ id, kind: 'web', title: 'Abrir en la tele', detail: 'x.example' });
  const statuses = s => s.turns.map(x => x.tools.map(y => y.status));
  // el Gateway cae con una herramienta en marcha
  let { cdp, v } = make();
  v.turn('panel'); v.you('abre', true); v.tool(card('c1'));
  v.error('Jota no está disponible.'); await step(t);
  let s = last(cdp);
  assert.deepEqual([s.state, s.live, statuses(s)], ['error', false, [[tv.SETTLED_STATUS]]]);
  assert.equal(s.turns[0].hint, '', 'cerrar sin result no es un fallo de herramienta: sin pista');
  // done con la ficha aún girando
  ({ cdp, v } = make());
  v.turn('panel'); v.you('abre', true); v.tool(card('c1')); v.jota('Hecho.'); v.done(); await step(t);
  s = last(cdp);
  assert.deepEqual([s.state, statuses(s)], ['done', [['ok']]]);
  // Parar con la ficha en marcha y pedir otra cosa: el turno anterior no gira
  ({ cdp, v } = make());
  v.turn('panel'); v.you('abre', true); v.tool(card('c1'));
  v.hide(); v.turn('panel'); v.you('otra', true); await step(t);
  s = last(cdp);
  assert.deepEqual([s.state, statuses(s)], ['think', [['ok'], []]]);
  // interrumpir (turn() nuevo sin done ni hide): lo archivado tampoco
  ({ cdp, v } = make());
  v.turn('panel'); v.you('abre', true); v.tool(card('c1'));
  v.turn('panel', { voice: true }); await step(t);
  assert.deepEqual(statuses(last(cdp)), [['ok'], []]);
});

test('error(): la respuesta es el error, state error y turno marcado; toolEnd/tool sueltos sin turno no rompen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.toolEnd({ id: 'nada', ok: false });
  v.tool({ id: 'x', kind: 'web', title: 'T', detail: '' });          // sin turno abierto: se ignora
  v.turn('panel'); v.you('hola', true);
  v.tool({ id: 'y', kind: 'desconocido', title: 'T', detail: '' });   // tipo fuera de KINDS: se ignora
  v.error('Jota no está disponible.');
  await step(t);
  const s = last(cdp);
  assert.equal(s.state, 'error');
  assert.equal(s.live, false);
  assert.deepEqual([s.turns.at(-1).jota, s.turns.at(-1).error, s.turns.at(-1).tools], ['Jota no está disponible.', true, []]);
});

test(`panel: ${KEEP_TURNS} turnos con id creciente (el último es el actual); la píldora lleva los mismos (la página enseña el último)`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  for (let i = 1; i <= 3; i++) { v.turn('panel'); v.you('p' + i, true); v.jota('r' + i); v.done(); }
  v.turn('panel'); v.done();                                             // cancelado sin nada: no cuenta
  v.turn('panel', { voice: true }); v.you('p4', false);
  await step(t);
  let s = last(cdp);
  assert.equal(KEEP_TURNS, 2);
  assert.deepEqual(s.turns.map(x => x.you), ['p3', 'p4']);
  assert.ok(s.turns[1].id > s.turns[0].id);
  v.done();
  v.turn('island'); v.you('p5', true); v.jota('r5');
  await step(t);
  s = last(cdp);
  assert.equal(s.form, 'pill');
  // también los KEEP_TURNS: así el log no cambia en el mismo frame que la forma (el anterior se pliega en el viaje del paso)
  assert.deepEqual(s.turns.map(x => x.you + ':' + x.jota), ['p4:', 'p5:r5']);
  assert.deepEqual(snapshot({ form: 'pill', ctx: 'video', state: 'done', live: false, look: /** @type {any} */ ({}), turns: s.turns.concat({ ...s.turns[1], id: 99 }) }).turns.length, KEEP_TURNS);
});

test('cierre: 4000 + 45 × letras de la respuesta tras done (y no antes)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  const hides = () => cdp.exprs.filter(e => e.includes('TVAgent.hide()')).length;
  const reply = 'Mañana, sol y 24 grados.';
  v.turn('panel'); v.you('¿tiempo?', true); v.jota(reply); v.done();
  await step(t);
  const ms = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * reply.length;
  assert.equal(ms, 4000 + 45 * reply.length);
  await step(t, ms - 101);
  assert.equal(hides(), 0);
  await step(t, 1);
  assert.equal(hides(), 1);
  assert.ok(cdp.exprs.at(-1).includes('window.TVIsland&&window.TVIsland.dim(1)'), 'la isla de actividades vuelve a 1');
});

test('contexto (ronda 2): ctx sigue a la página en cada foto, igual que noche, calma, cristal y colores', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v, c } = make({ ctx: 'music', colors: ['#649ab4', '#f5c089'] });
  v.turn('panel'); v.you('hola', true);
  await step(t);
  assert.deepEqual([last(cdp).ctx, last(cdp).colors], ['music', ['#649ab4', '#f5c089']]);
  c.now = ctxOf({ ctx: 'video', night: true, calm: true, glass: 'C', colors: null });
  v.jota('Buenas');
  await step(t);
  const s = last(cdp);
  assert.deepEqual([s.ctx, s.night, s.calm, s.glass, s.colors], ['video', true, true, 'C', null], 'el tinte ya no se fija al turno');
  assert.equal(s.form, 'panel', 'la forma sí sigue fijada');
});

test('contexto saneado: valores raros caen en los de por defecto; sin context() o si lanza, también', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make({ ctx: 'raro', glass: 'Z', night: 'sí', colors: ['red";alert(1)//', 'blue'] });
  v.turn('island'); v.you('hola', true);
  await step(t);
  const s = last(cdp);
  assert.deepEqual([s.ctx, s.glass, s.night, s.colors], ['video', 'auto', false, null], 'ctx sin valor válido: por el formato');
  const logs = [];
  const cdp2 = fakeCdp();
  const w = createTalkView({ cdp: cdp2, pub: PUB, log: m => logs.push(m), context: () => { throw new Error('reposo sin crear'); } });
  w.turn('panel'); await step(t);
  assert.deepEqual([last(cdp2).form, last(cdp2).ctx, last(cdp2).glass], ['panel', 'web', 'auto']);
  assert.ok(logs.some(l => l.includes('reposo sin crear')));
  const cdp3 = fakeCdp();
  createTalkView({ cdp: cdp3, pub: PUB }).turn('island'); await step(t);
  assert.deepEqual([last(cdp3).form, last(cdp3).ctx], ['pill', 'video'], 'sin context(): el formato de talk.js');
});

test('reset() y una página sin TVAgent reinyectan la fuente', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  const injects = () => cdp.exprs.filter(e => e.includes('AGENTE-MINIMO')).length;
  v.turn('panel'); v.you('a', true);
  await step(t);
  cdp.has = false;
  v.jota('b'); await step(t); await flushMicro();
  assert.equal(injects(), 2, 'la página cambió sin aviso: un reintento con la fuente');
  cdp.has = true;
  v.reset(); await step(t);
  assert.equal(injects(), 3);
});

test('snapshot(): copia los turnos (la foto no cambia si luego cambia el turno) e ignora iconos de tipos desconocidos', () => {
  const turn = { id: 1, you: 'a', youFinal: true, jota: '', tools: [{ id: 't', kind: 'web', title: 'W', detail: '', status: 'run' }], error: false, hint: '' };
  const look = { ctx: 'web', night: false, calm: false, glass: 'auto', colors: null };
  const s = snapshot({ form: 'panel', ctx: 'web', state: 'think', live: true, look, turns: [turn] });
  turn.tools[0].status = 'ok'; turn.you = 'b';
  assert.equal(s.turns[0].tools[0].status, 'run');
  assert.equal(s.turns[0].you, 'a');
  assert.deepEqual(Object.keys(s.icons), ['web']);
});

// ── Ronda 2: «pon esta serie» (navegar con la capa abierta: scripts de documento nuevo y modo restore)
const { AWAIT_PAGE_MS, AFTER_PAINT_MIN_MS, MORPH_DELAY_MS, PILL_DWELL_BASE_MS, PILL_DWELL_PER_CHAR_MS, RESTORE_GLOBAL, BINDING_GAP_MS, NO_LAYER } = tv;
const { FORM_BINDING } = require(path.join(REMOTE, 'src', 'tv', 'agent-contract'));
const { AGENT_LAYOUT_TTL_MS } = require(path.join(REMOTE, 'src', 'tv', 'agent-form'));
const scripts = cdp => cdp.calls.filter(x => x.method === 'Page.addScriptToEvaluateOnNewDocument');
const removed = cdp => cdp.calls.filter(x => x.method === 'Page.removeScriptToEvaluateOnNewDocument').map(x => x.identifier);
/** La foto que lleva un script de documento nuevo. */
const snapOf = src => JSON.parse(src.slice(src.indexOf('var s=') + 6, src.indexOf(`;window.${RESTORE_GLOBAL}=s`)));
const settle = async () => { for (let i = 0; i < 6; i++) await flushMicro(); };

test('script por documento: con la capa a la vista, la fuente (una vez) y la última foto en modo restore; se quitan al cerrar', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel', { voice: true }); v.you('hola', true);
  await step(t); await settle();
  assert.ok(cdp.calls.some(x => x.method === 'Page.enable'), 'Page.enable: sin él no corren');
  let sc = scripts(cdp);
  assert.equal(sc.length, 2, 'fuente + foto');
  assert.ok(sc[0].source.startsWith('(()=>{if(window.top!==window)return;') && sc[0].source.includes('AGENTE-MINIMO'), 'solo el marco principal');
  assert.ok(sc[0].source.includes('__TV_FONTS') && sc[0].source.includes(`window.${RESTORE_GLOBAL}`));
  assert.ok(!('worldName' in sc[0]), 'en el mundo principal (donde render pinta)');
  const s1 = snapOf(sc[1].source);
  assert.equal(s1.enter, 'restore');
  assert.equal(s1.turns.at(-1).you, 'hola');
  assert.equal(last(cdp).enter, 'open', 'la foto normal entra con su animación');
  v.jota('Ahí va'); await step(t); await settle();
  sc = scripts(cdp);
  assert.equal(sc.length, 3, 'la fuente no se vuelve a registrar; la foto sí');
  assert.equal(snapOf(sc[2].source).turns.at(-1).jota, 'Ahí va');
  assert.deepEqual(removed(cdp), ['2'], 'la foto vieja se quita después de poner la nueva');
  v.jota('Ahí va'); await step(t); await settle();
  assert.equal(scripts(cdp).length, 3, 'la misma foto no se registra otra vez');
  v.hide(); await settle();
  assert.deepEqual(removed(cdp).sort(), ['1', '2', '3'], 'al cerrar se quitan la foto y la fuente');
});

test('script por documento: otra pestaña (sesión CDP) vuelve a registrar', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel'); v.you('uno', true);
  await step(t); await settle();
  assert.equal(scripts(cdp).length, 2);
  cdp.session = { otra: 1 }; v.reset();
  await step(t); await settle();
  assert.equal(scripts(cdp).length, 4, 'en la sesión nueva, fuente y foto otra vez');
  assert.deepEqual(removed(cdp), [], 'los de la sesión vieja se fueron con ella: no se piden quitar');
});

test('reset() con la capa a la vista: la foto siguiente va en modo restore (y la otra ya no)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel'); v.you('hola', true);
  await step(t);
  v.reset(); await step(t);
  assert.equal(last(cdp).enter, 'restore');
  v.jota('x'); await step(t);
  assert.equal(last(cdp).enter, 'open');
});

test('reset() justo después de cerrar: se quita otra vez (el script pudo restaurarla); más tarde o sin capa, nada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel'); v.you('hola', true); await step(t);
  v.hide(); await settle();
  const n = cdp.exprs.length;
  v.reset(); await settle();
  assert.equal(cdp.exprs.length, n + 1);
  assert.ok(cdp.exprs.at(-1).includes('TVAgent.hide()'));
  const fresh = make();
  fresh.v.reset(); await settle();
  assert.equal(fresh.cdp.exprs.length, 0, 'nunca pintada: nada que quitar');
});


// ── Ronda 3: el formato lo decide la página (agent-form.js), Jota (layout) y el usuario (arrastre)
const IDLE = { url: 'http://127.0.0.1:8787/idle.html', stage: null, idle: true };
const WEB = { url: 'https://cocina.example/paella', stage: null, idle: false };
const NETFLIX = { url: 'https://www.netflix.com/browse', stage: null, idle: false };
const hidesOf = cdp => cdp.exprs.filter(e => e.includes('TVAgent.hide()')).length;
/** Navegación como server.js: la URL de context() cambia y reset(); la página nueva se pinta (la sonda contesta ya). */
async function go(t, m, page) { m.c.now = { ...m.c.now, page }; m.v.reset(); await step(t); await settle(); }
/** Reproducción como page-poll: state.playback (context) y luego playback(on). */
const play = (m, on) => { m.c.now = { ...m.c.now, playback: on }; m.v.playback(on); };

test('formato al empezar: lo decide la página (contenido → píldora; reposo y web → panel); sin página ni playback, el de talk.js', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [page, pb, want] of [[IDLE, false, 'panel'], [WEB, false, 'panel'], [NETFLIX, false, 'pill'], [WEB, true, 'pill'],
    [{ url: 'http://127.0.0.1:8787/stage/p1.html', stage: 'html', idle: false }, false, 'pill']]) {
    const m = make({ page, playback: pb });
    m.v.turn('island'); m.v.you('x', true); await step(t);
    assert.equal(last(m.cdp).form, want, `${page.url} playback ${pb}`);
  }
  const b = make({ playback: true });
  b.v.turn('panel'); b.v.you('x', true); await step(t);
  assert.equal(last(b.cdp).form, 'pill', 'solo playback (ronda 2): vídeo grande → píldora');
  const c = make();
  c.v.turn('island'); c.v.you('x', true); await step(t);
  assert.equal(last(c.cdp).form, 'pill', 'sin página ni playback en context(): como en la ronda 1');
});

test('navegar a una app de contenido: la píldora llega cuando la página nueva está pintada (+ MORPH_DELAY_MS), sin reproducción', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: IDLE, playback: false });
  const forms = []; m.v.onForm((f, can) => forms.push(f + ':' + can));
  m.v.turn('panel', { voice: true }); m.v.you('ponme esta serie', true);
  m.v.tool({ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', opens: true });
  await step(t);
  m.c.now = { ...m.c.now, page: NETFLIX }; m.v.reset();
  await step(t);
  const i = m.cdp.exprs.findIndex(e => e.includes('getEntriesByType'));
  assert.ok(i >= 0, 'tras pintar la capa en la página nueva, espera a la pintada');
  assert.ok(m.cdp.exprs.slice(0, i).some(e => e.includes('"enter":"restore"') && e.includes('"form":"panel"')), 'primero restaurada, aún panel');
  await settle();
  await step(t, MORPH_DELAY_MS - 100);
  assert.equal(last(m.cdp).form, 'panel', 'aún el respiro');
  await step(t, 100); await step(t);
  assert.equal(last(m.cdp).form, 'pill');
  assert.deepEqual(forms, ['panel:true', 'pill:true']);
  play(m, false); m.v.jota('Ahí la tienes.'); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'pausar (o no reproducir) no devuelve el panel');
});

test('web normal: sigue el panel; un vídeo grande que avanza la pasa a píldora (reserva) y pausar no la devuelve', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: IDLE, playback: false });
  m.v.turn('panel'); m.v.you('abre la receta', true); await step(t);
  await go(t, m, WEB); await step(t, MORPH_DELAY_MS + 200);
  assert.equal(last(m.cdp).form, 'panel');
  assert.equal(m.v.watching(), true, 'capa a la vista: page-poll vigila');
  play(m, true); await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'pill');
  play(m, false); m.v.jota('Listo.'); await step(t);
  assert.equal(last(m.cdp).form, 'pill');
  m.v.done(); m.v.turn('panel'); m.v.you('y otra cosa', true); await step(t);
  assert.equal(last(m.cdp).form, 'panel', 'turno nuevo en una web sin vídeo: panel otra vez');
});

test('reproducción: pausar durante el respiro lo cancela; una capa oculta (Parar) no se reabre', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: WEB, playback: false });
  m.v.turn('panel'); m.v.you('a', true); await step(t);
  play(m, true); await step(t, 200); play(m, false);
  await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'panel');
  m.v.hide(); await settle();
  const n = m.cdp.exprs.length;
  assert.equal(m.v.watching(), false);
  play(m, true); await step(t, MORPH_DELAY_MS + 500);
  await go(t, m, NETFLIX); await step(t, MORPH_DELAY_MS + 500);
  assert.equal(m.cdp.exprs.filter(e => e.includes('.render(')).length, m.cdp.exprs.slice(0, n).filter(e => e.includes('.render(')).length, 'nada se pinta');
});

test('espera a la página: un turno que abre algo no se cierra mientras la página nueva no esté pintada; luego, el cierre normal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = make({ page: IDLE, playback: false });
  const jota = 'La tienes en pantalla.', normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * jota.length;
  m.v.turn('panel'); m.v.you('abre la receta', true);
  m.v.tool({ id: 'w', kind: 'web', title: 'Abrir en la tele', detail: 'cocina.example', opens: true }); m.v.toolEnd({ id: 'w', ok: true });
  await step(t);
  m.cdp.has = false;                                 // la página nueva aún no tiene la capa (no pintada)
  m.c.now = { ...m.c.now, page: WEB }; m.v.reset();
  m.v.jota(jota); m.v.done();
  await step(t); await settle();
  assert.equal(m.v.awaiting(), true);
  await step(t, normal + 500);
  assert.equal(hidesOf(m.cdp), 0, 'el cierre normal no corre mientras se espera');
  m.cdp.has = true; m.v.reset(); await step(t); await settle();  // ya está: se pinta
  assert.equal(m.v.awaiting(), false);
  assert.equal(last(m.cdp).form, 'panel', 'web normal: panel');
  await step(t, AFTER_PAINT_MIN_MS - 200);
  assert.equal(hidesOf(m.cdp), 0, 'se ve un rato encima de la página nueva');
  await step(t, 300);
  assert.equal(hidesOf(m.cdp), 1);
});

test('espera a la página sin fichas (Gateway sin tool_calls_enabled): la arma la navegación del servidor durante el turno', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = make({ page: IDLE, playback: false });
  const jota = 'Ahí la tienes.', normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * jota.length;
  m.v.navigating();                                  // sin turno abierto: no cuenta
  m.v.turn('panel'); m.v.you('ponme esta serie', true);
  m.v.navigating();                                  // control.nav: Jota abre la app (sin evento de herramienta)
  await step(t);
  m.cdp.has = false; m.c.now = { ...m.c.now, page: WEB }; m.v.reset();
  m.v.jota(jota); m.v.done();
  await step(t); await settle();
  assert.equal(m.v.awaiting(), true, 'espera a la página aunque no haya fichas');
  await step(t, normal + 500);
  assert.equal(hidesOf(m.cdp), 0);
  m.cdp.has = true; m.v.reset(); await step(t); await settle();
  assert.equal(m.v.awaiting(), false);
  await step(t, AFTER_PAINT_MIN_MS + 100);
  assert.equal(hidesOf(m.cdp), 1);
  // turno siguiente sin navegar: no hereda la espera
  m.v.turn('panel'); m.v.you('gracias', true); m.v.jota('De nada.'); m.v.done();
  await step(t); await settle();
  assert.equal(m.v.awaiting(), false);
});

test('espera a la página: si nunca se pinta, vence en AWAIT_PAGE_MS; ya pintada o ficha de otro tipo o fallida, no espera', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: IDLE, playback: false });
  m.v.turn('panel'); m.v.you('abre la receta', true);
  m.v.tool({ id: 'w', kind: 'web', title: 'Abrir en la tele', detail: 'cocina.example', opens: true }); m.v.toolEnd({ id: 'w', ok: true });
  await step(t);
  m.cdp.has = false; m.c.now = { ...m.c.now, page: WEB }; m.v.reset();
  m.v.jota('Ya está.'); m.v.done();
  await step(t, AWAIT_PAGE_MS - 100);
  assert.equal(hidesOf(m.cdp), 0);
  await step(t, 200);
  assert.equal(hidesOf(m.cdp), 1, 'vence la espera: se cierra');
  // [ficha, acabó bien, la página nueva ya se pintó antes del fin del turno]
  for (const [kind, ok, painted] of [['web', true, true], ['music', true, false], ['web', false, false]]) {
    const n = make({ page: IDLE, playback: false });
    n.v.turn('panel'); n.v.you('x', true);
    n.v.tool({ id: 'k', kind, title: 'T', detail: '', opens: kind === 'web' }); n.v.toolEnd({ id: 'k', ok });
    await step(t);
    n.cdp.has = painted; n.c.now = { ...n.c.now, page: WEB }; n.v.reset(); await step(t); await settle();
    n.v.jota('Vale.'); n.v.done();
    assert.equal(n.v.awaiting(), false, `${kind} ${ok ? 'bien' : 'fallida'}${painted ? ', ya pintada' : ''}: no espera`);
    await step(t, CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * 5 + 100);
    assert.equal(hidesOf(n.cdp), 1);
  }
});

test('espera a la página de contenido: pintada → píldora → PILL_DWELL y se cierra; nada la reabre', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: IDLE, playback: false });
  const jota = 'Ahí la tienes.';
  m.v.turn('panel'); m.v.you('ponme esta serie', true);
  m.v.tool({ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', opens: true }); m.v.toolEnd({ id: 'n', ok: true });
  await step(t);
  m.cdp.has = false; m.c.now = { ...m.c.now, page: NETFLIX }; m.v.reset();
  m.v.jota(jota); m.v.done(); await step(t); await settle();
  assert.equal(m.v.awaiting(), true);
  m.cdp.has = true; m.v.reset(); await step(t); await settle();
  assert.equal(m.v.awaiting(), true, 'pintada, con el paso en el respiro: sigue esperando');
  await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'pill');
  assert.equal(m.v.awaiting(), false);
  await step(t, PILL_DWELL_BASE_MS + PILL_DWELL_PER_CHAR_MS * jota.length - 300);
  assert.equal(hidesOf(m.cdp), 0, 'la píldora se queda su rato');
  await step(t, 400);
  assert.equal(hidesOf(m.cdp), 1, 'y se cierra');
  play(m, true); await step(t, MORPH_DELAY_MS + 1000);
  assert.equal(hidesOf(m.cdp), 1);
  assert.ok(m.cdp.exprs.at(-1).includes('TVAgent.hide()'), 'nada la reabre: lo último sigue siendo el cierre');
});

test('userForm (talkform / arrastre): los dos sentidos, ya; vale para el contenido actual y se olvida al cambiar de contenido', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: NETFLIX, playback: false });
  const forms = []; m.v.onForm((f, can) => forms.push(f + ':' + can));
  assert.deepEqual(m.v.userForm('panel'), { error: NO_LAYER }, 'sin capa a la vista no hay nada que cambiar');
  m.v.turn('panel'); m.v.you('x', true); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'en Netflix nace píldora');
  assert.deepEqual(m.v.userForm('nada'), { error: 'formato no válido' });
  assert.deepEqual(m.v.userForm('panel'), { ok: 1, form: 'panel' });
  await step(t);
  assert.equal(last(m.cdp).form, 'panel', 'el usuario la amplía aunque se vea contenido');
  await go(t, m, { url: 'https://www.netflix.com/watch/81', stage: null, idle: false }); await step(t, MORPH_DELAY_MS + 200);
  assert.equal(last(m.cdp).form, 'panel', 'mismo contenido: el override sigue');
  m.v.done(); m.v.turn('panel'); m.v.you('y', true); await step(t);
  assert.equal(last(m.cdp).form, 'panel', 'también en el turno siguiente, en el mismo contenido');
  m.v.userForm('pill'); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'y al revés');
  m.v.userForm('panel'); await step(t);
  await go(t, m, { url: 'https://www.youtube.com/', stage: null, idle: false }); await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'otra app: el override se olvida');
  assert.deepEqual(forms.slice(0, 3), ['pill:true', 'panel:true', 'panel:true']);
  m.v.hide(); await settle();
  assert.equal(forms.at(-1), 'pill:false', 'al cerrarse: ya no se puede cambiar');
});

test('userForm sobre contenido tras acabar el turno: el cierre usa los tiempos normales desde el cambio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: NETFLIX, playback: false });
  const jota = 'Vale.';
  m.v.turn('panel'); m.v.you('x', true); m.v.jota(jota); m.v.done(); await step(t);
  await step(t, 1000);
  m.v.userForm('panel'); await step(t);
  await step(t, CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * jota.length - 300);
  assert.equal(hidesOf(m.cdp), 0);
  await step(t, 400);
  assert.equal(hidesOf(m.cdp), 1);
});

test('fromPage (binding del arrastre): solo pill|panel, con la capa a la vista y no más seguido que BINDING_GAP_MS', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = make({ page: NETFLIX, playback: false });
  m.v.turn('panel'); m.v.you('x', true); await step(t);
  m.v.fromPage('{"form":"panel"}'); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'nada que no sea exactamente pill o panel');
  t.mock.timers.tick(BINDING_GAP_MS);
  m.v.fromPage('panel'); await step(t);
  assert.equal(last(m.cdp).form, 'panel');
  m.v.fromPage('pill'); await step(t);
  assert.equal(last(m.cdp).form, 'panel', 'demasiado seguido: se ignora');
  t.mock.timers.tick(BINDING_GAP_MS);
  m.v.fromPage('pill'); await step(t);
  assert.equal(last(m.cdp).form, 'pill');
});

test('el binding del arrastre se pone una vez por sesión CDP (Runtime.addBinding) con la capa a la vista', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: IDLE });
  m.v.turn('panel'); m.v.you('x', true); await step(t); await settle();
  const binds = () => m.cdp.calls.filter(x => x.method === 'Runtime.addBinding');
  assert.deepEqual(binds().map(x => x.name), [FORM_BINDING]);
  m.v.jota('a'); await step(t); await settle();
  m.v.hide(); await settle(); m.v.turn('panel'); m.v.you('y', true); await step(t); await settle();
  assert.equal(binds().length, 1, 'misma sesión: no se repite');
  m.cdp.session = { otra: 1 }; m.v.reset(); await step(t); await settle();
  assert.equal(binds().length, 2, 'sesión nueva: otra vez');
});

test('agentLayout (tv_open con layout): vale al llegar a esa página y mientras se siga en ese sitio; si no se llega, caduca', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = make({ page: IDLE, playback: false });
  m.v.turn('panel'); m.v.you('enséñame las fotos', true); await step(t);
  m.v.agentLayout('pill', 'https://fotos.example/album/1');
  await step(t, MORPH_DELAY_MS + 100);
  assert.equal(last(m.cdp).form, 'panel', 'aún en el reposo: nada');
  await go(t, m, { url: 'https://fotos.example/album/1', stage: null, idle: false }); await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'en la web que abrió con layout pill');
  m.v.done(); m.v.turn('panel'); m.v.you('la siguiente', true); await step(t);
  assert.equal(last(m.cdp).form, 'pill', 'turno nuevo en el mismo sitio: sigue lo que pidió Jota');
  await go(t, m, { url: 'https://otra.example/', stage: null, idle: false });
  m.v.done(); m.v.turn('panel'); m.v.you('z', true); await step(t);
  assert.equal(last(m.cdp).form, 'panel', 'otro sitio: se pierde');
  // Jota pide panel en una app de contenido: manda sobre el contenido (y devuelve la píldora al panel)
  await go(t, m, NETFLIX); await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'pill');
  m.v.agentLayout('panel', 'https://netflix.com/title/1'); await step(t, MORPH_DELAY_MS); await step(t);
  assert.equal(last(m.cdp).form, 'panel');
  // caduca si no se llega
  const n = make({ page: IDLE, playback: false });
  n.v.agentLayout('pill', 'https://nunca.example/');
  t.mock.timers.tick(AGENT_LAYOUT_TTL_MS + 1);
  n.c.now = { ...n.c.now, page: { url: 'https://nunca.example/', stage: null, idle: false } };
  n.v.turn('panel'); n.v.you('x', true); await step(t);
  assert.equal(last(n.cdp).form, 'panel');
  m.v.agentLayout('nada', 'https://x.example/'); // un valor raro no hace nada (ni lanza)
});

// ── Correcciones tras la revisión de la ronda 3
const vm = require('node:vm');
const { PAINT_WAIT_MS, PAINT_EVERY_MS, PAINT_GRID, paintProbe } = tv;
const { HOST_ID } = require(path.join(REMOTE, 'src', 'tv', 'agent-contract'));

test('restore: el documento siguiente se pinta con el tinte que se ve ahora (no salta el ancho ni el velo al navegar)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make({ ctx: 'idle' });
  v.turn('panel'); v.you('ponme esta serie', true);
  await step(t); await settle();
  const s = snapOf(scripts(cdp).at(-1).source);
  assert.deepEqual([s.enter, s.ctx], ['restore', 'idle']);
});

test('pausar en el respiro con la espera a la página: el paso se cancela y la espera acaba (cierre normal, no AWAIT_PAGE_MS)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const WEB2 = { url: 'https://b.example/video', stage: null, idle: false };
  const m = make({ ctx: 'web', page: WEB, playback: false });
  const jota = 'Ahí lo tienes.', normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * jota.length;
  m.v.turn('panel'); await step(t, 200);
  m.v.tool({ id: 'o', kind: 'web', title: 'Abrir', detail: 'b.example', opens: true }); await step(t);
  m.v.toolEnd({ id: 'o', ok: true }); m.v.jota(jota);
  m.c.now = { ...m.c.now, page: WEB2, playback: true };   // la página nueva arranca un vídeo grande
  m.v.reset(); m.v.done();
  await step(t, 150); await settle();                       // pintada → respiro hacia la píldora
  assert.equal(m.v.awaiting(), true, 'el paso está en el respiro: aún espera');
  play(m, false);                                           // se pausa dentro del respiro
  await settle();
  assert.equal(m.v.awaiting(), false, 'sin paso pendiente y pintada: deja de esperar');
  await step(t, normal + 300);
  assert.equal(hidesOf(m.cdp), 1, 'se cierra a su hora normal');
  assert.equal(last(m.cdp).form, 'panel');
});

/** Página falsa para la sonda: una rejilla con lo que hay en cada punto (elementsFromPoint) y relojes a mano. */
function probePage(at, url = 'https://www.netflix.com/browse') {
  const timers = [], frames = [];
  let now = 0, seq = 0;
  const el = (tag, o = {}) => ({ tagName: tag, id: '', childNodes: [], ...o });
  const html = el('HTML'), body = el('BODY');
  const win = {
    innerWidth: 1000, innerHeight: 500,
    document: { URL: url, documentElement: html, body, elementsFromPoint: (x, y) => [...(at(x, y, now) || []), body, html] },
    getComputedStyle: e => ({ backgroundImage: e.bg || 'none' }),
    performance: { getEntriesByType: () => [{ name: 'first-paint' }] },
    setTimeout: (f, ms) => { timers.push({ id: ++seq, at: now + ms, f }); return seq; },
    clearTimeout: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (f, ms) => { const id = ++seq; const tick = () => { timers.push({ id, at: now + ms, f: () => { f(); tick(); } }); }; tick(); return id; },
    clearInterval: id => { for (let i = timers.length - 1; i >= 0; i--) if (timers[i].id === id) timers.splice(i, 1); },
    requestAnimationFrame: f => { frames.push(f); return ++seq; },
  };
  let state = 'pending';
  vm.runInNewContext(`(${paintProbe})(o).then(v => done(v))`, { ...win, o: { wait: PAINT_WAIT_MS, grid: PAINT_GRID, min: 2, every: PAINT_EVERY_MS, host: HOST_ID, blank: tv.PAINT_BLANK, blankRe: tv.BLANK_RE.source },
    done: v => { state = v; }, Promise });
  const advance = async ms => {
    const end = now + ms;
    while (now < end) {
      now += 16;
      for (let x; (x = timers.filter(y => y.at <= now).sort((a, b) => a.at - b.at)[0]);) { timers.splice(timers.indexOf(x), 1); x.f(); }
      frames.splice(0).forEach(f => f(now));
      await new Promise(r => setImmediate(r));
    }
  };
  return { el, advance, state: () => state };
}

test('sonda de pintada: un esqueleto («Cargando…», cajas grises, la capa del agente) no cuenta; el contenido de verdad, sí', async () => {
  const text = (s, o) => ({ tagName: 'P', id: '', childNodes: [{ nodeType: 3, textContent: s }], ...o });
  const layer = { tagName: 'DIV', id: HOST_ID, childNodes: [{ nodeType: 3, textContent: 'Hola, Sito' }] };
  const grey = { tagName: 'DIV', id: '', childNodes: [] };
  const CONTENT_AT = 1500;
  const p = probePage((x, y, now) => {
    const cx = x < 500, cy = y < 250;
    if (x > 600) return [layer, grey];                                      // la capa restaurada encima de un esqueleto
    if (now < CONTENT_AT) return x === 500 && y === 250 ? [text('Cargando…')] : [grey];
    return cx && cy ? [{ tagName: 'IMG', id: '', childNodes: [], complete: true, naturalWidth: 640 }]
      : cx ? [text('Una serie que te va a gustar')] : [{ tagName: 'DIV', id: '', childNodes: [], bg: 'url("a.jpg")' }];
  });
  await p.advance(CONTENT_AT - 100);
  assert.equal(p.state(), 'pending', 'con el esqueleto aún no está pintada');
  await p.advance(PAINT_EVERY_MS + 200);
  assert.equal(p.state(), true, 'con el contenido a la vista, sí (dos rAF después)');
  // sin nada que se reconozca: vence en PAINT_WAIT_MS (false)
  const q = probePage(() => [grey]);
  await q.advance(PAINT_WAIT_MS - 100);
  assert.equal(q.state(), 'pending');
  await q.advance(200);
  assert.equal(q.state(), false);
  // una imagen que aún no ha cargado no es contenido
  const r = probePage(() => [{ tagName: 'IMG', id: '', childNodes: [], complete: false, naturalWidth: 0 }]);
  await r.advance(1000);
  assert.equal(r.state(), 'pending');
});

test('sonda de pintada: la pestaña en blanco (about:blank) contesta PAINT_BLANK al momento, aunque tenga «contenido»', async () => {
  const img = { tagName: 'IMG', id: '', childNodes: [], complete: true, naturalWidth: 640 };
  const b = probePage(() => [img], 'about:blank');
  await b.advance(16);
  assert.equal(b.state(), tv.PAINT_BLANK);
  assert.ok(tv.BLANK_RE.test('about:blank') && !tv.BLANK_RE.test('https://www.netflix.com/browse'));
});

test('otra pestaña con la conversación ya cerrada (Netflix va en la suya): al llegar a ella se quita la capa que quede', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = make({ page: IDLE, playback: false });
  m.v.reset();
  assert.equal(m.cdp.exprs.length, 0, 'sin haber pintado nunca, nada que quitar');
  m.v.turn('panel'); m.v.you('hola', true); m.v.jota('Hola.'); m.v.done();
  await step(t);
  m.v.hide(); await step(t);
  await step(t, 60_000);                             // mucho después del cierre
  const before = m.cdp.exprs.length;
  m.v.reset();                                       // onAttached: vuelve la pestaña de siempre, con su panel aún pintado
  assert.equal(m.cdp.exprs.slice(before).filter(e => e.includes('TVAgent.hide()')).length, 1, 'la quita');
  assert.ok(!m.cdp.exprs.slice(before).some(e => e.includes('.render(')), 'y no la vuelve a pintar');
});

// ── Netflix en su pestaña (cdp.show): cambio de pestaña, pestaña en blanco y espera que se vuelve a armar
const probes = cdp => cdp.exprs.filter(e => e.includes('elementsFromPoint')).length;

test('reset({ tab }) con la capa a la vista: pinta ya (sin batchMs) la última foto vista (su tinte, restore, tab) y devuelve la promesa; la siguiente, la de ahora', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ ctx: 'idle', page: IDLE, playback: false });
  m.v.turn('panel'); m.v.you('abre Netflix', true);
  await step(t); await settle();
  const n = m.cdp.exprs.length;
  m.cdp.session = { otra: 1 };                                   // onAttached: otra pestaña enganchada (Netflix, web)
  m.c.now = { ...m.c.now, ctx: 'web', page: NETFLIX };
  const p = m.v.reset({ tab: true });
  assert.equal(m.cdp.exprs.length, n + 1, 'una llamada al momento, sin esperar a batchMs');
  assert.ok(p && typeof p.then === 'function', 'devuelve la promesa de esa llamada (cdp.show la espera)');
  await p;
  const first = arg(m.cdp.exprs[n]);
  assert.ok(m.cdp.exprs[n].includes('AGENTE-MINIMO'), 'con la fuente (la pestaña nueva no la tiene)');
  assert.deepEqual([first.ctx, first.form, first.enter, first.tab], ['idle', 'panel', 'restore', true], 'la última que se vio, con su tinte');
  await step(t); await settle();
  const next = last(m.cdp);
  assert.deepEqual([next.ctx, next.enter, 'tab' in next], ['web', 'open', false], 'la siguiente ya con el tinte de esta pestaña');
  assert.equal(snapOf(scripts(m.cdp).at(-1).source).tab, undefined, 'el script de documento nuevo no lleva `tab`');
  // sin la capa a la vista, reset({ tab }) no pinta nada
  const q = make({ page: IDLE, playback: false });
  assert.equal(q.v.reset({ tab: true }), undefined);
  assert.equal(q.cdp.exprs.length, 0);
});

test('leave(): la capa de la pestaña que se deja se quita en seco (hide(true)); sin capa pintada, nada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make();
  const sent = [];
  const call = async (method, p) => { sent.push(p.expression); return {}; };
  assert.equal(m.v.leave(call), undefined);
  m.v.turn('panel'); m.v.you('hola', true); await step(t);
  await m.v.leave(call);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('TVAgent.hide(true)') && sent[0].includes('TVIsland.dim(1)'));
});

test('pestaña en blanco (about:blank mientras carga la de verdad): ni se sondea ni cuenta como pintada; la espera sigue hasta la página real', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const BLANK = { url: 'about:blank', stage: null, idle: false };
  const m = make({ page: NETFLIX, playback: false });            // desde una app: ya en píldora
  const jota = 'Hecho.';
  m.v.turn('panel'); m.v.you('pon Netflix', true); await step(t);
  m.v.navigating();                                               // la orden netflix, sin fichas
  m.c.now = { ...m.c.now, page: BLANK }; m.v.reset({ tab: true }); // netflix.front: pestaña nueva en blanco al frente
  await step(t); await settle();
  assert.equal(probes(m.cdp), 0, 'about:blank no se sondea');
  m.v.jota(jota); m.v.done(); await step(t); await settle();
  assert.equal(m.v.awaiting(), true);
  // Chrome ya dice la URL nueva pero el documento sigue en blanco: la sonda contesta «blank» y no cuenta
  m.cdp.probe = tv.PAINT_BLANK;
  m.c.now = { ...m.c.now, page: NETFLIX }; m.v.reset(); await step(t); await settle();
  await step(t, 500); await settle();
  assert.ok(probes(m.cdp) > 1, 'se vuelve a mirar');
  assert.equal(m.v.awaiting(), true, 'la pestaña en blanco no es la página pintada');
  m.cdp.probe = true;                                             // llega el documento de verdad y se pinta
  await step(t, 100); await settle();
  assert.equal(m.v.awaiting(), false);
  await step(t, AFTER_PAINT_MIN_MS - 300); await settle();
  assert.equal(hidesOf(m.cdp), 0, 'se ve al menos AFTER_PAINT_MIN_MS encima de la página de verdad');
  await step(t, CLOSE_BASE_MS); await settle();                  // y lo que quede del cierre normal
  assert.equal(hidesOf(m.cdp), 1);
});

test('espera vencida (la sonda llegó a su tope) y luego la página de verdad: la espera se vuelve a armar y el cierre cuenta AFTER_PAINT_MIN_MS desde su pintada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = make({ page: NETFLIX, playback: false });
  const jota = 'Hecho.', normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * jota.length;
  m.v.turn('panel'); m.v.you('pon Netflix', true); await step(t);
  m.v.navigating();
  m.cdp.probe = false;                                            // sin contenido que se reconozca: vence (cuenta, pero «débil»)
  m.c.now = { ...m.c.now, page: { ...NETFLIX, url: 'https://www.netflix.com/SwitchProfile' } }; m.v.reset();
  await step(t); await settle();
  m.v.jota(jota); m.v.done(); await step(t); await settle();
  assert.equal(m.v.awaiting(), false, 'ya «pintada» por el tope');
  await step(t, 1500); await settle();
  let release;
  m.cdp.probe = () => new Promise(r => { release = r; });         // la página de verdad tarda en enseñar su contenido
  m.c.now = { ...m.c.now, page: NETFLIX }; m.v.reset(); await step(t); await settle();
  assert.equal(m.v.awaiting(), true, 'la navegación vuelve a armar la espera');
  await step(t, normal); await settle();
  assert.equal(hidesOf(m.cdp), 0, 'el cierre normal no corre mientras se espera');
  release(true); await settle();
  assert.equal(m.v.awaiting(), false);
  await step(t, AFTER_PAINT_MIN_MS - 300); await settle();
  assert.equal(hidesOf(m.cdp), 0, 'al menos AFTER_PAINT_MIN_MS encima de la página pintada');
  await step(t, 400); await settle();
  assert.equal(hidesOf(m.cdp), 1);
  // ya pintada de verdad, una navegación dentro de la app (pushState) no alarga el cierre
  const n = make({ page: NETFLIX, playback: false });
  n.v.turn('panel'); n.v.you('pon Netflix', true); await step(t);
  n.v.navigating(); n.c.now = { ...n.c.now, page: { ...NETFLIX, url: 'https://www.netflix.com/browse?x=1' } }; n.v.reset();
  await step(t); await settle();
  n.v.jota(jota); n.v.done(); await step(t); await settle();
  await step(t, 1000);
  n.c.now = { ...n.c.now, page: { ...NETFLIX, url: 'https://www.netflix.com/title/1' } }; n.v.reset(); await step(t); await settle();
  assert.equal(n.v.awaiting(), false);
  await step(t, normal - 1000); await settle();
  assert.equal(hidesOf(n.cdp), 1, 'se cierra a su hora normal');
});

test('reset({ tab, from }): pregunta a la pestaña que se deja qué palabras enseña ya y las manda en la foto del cambio (`shown`)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = make({ page: NETFLIX, playback: false });
  m.v.turn('panel'); m.v.you('vuelve', true); m.v.jota('Vale, te dejo la serie a medias'); await step(t); await settle();
  const id = last(m.cdp).turns.at(-1).id;
  const asked = [];
  const from = async (method, p) => { asked.push(p.expression); return { result: { value: { [id]: [1, 3], x: ['a'] } } }; };
  const n = m.cdp.exprs.length;
  m.v.jota('Vale, te dejo la serie a medias y vuelvo');           // una tanda pendiente: espera a la foto del cambio
  m.cdp.session = { otra: 1 };
  const p = m.v.reset({ tab: true, from });
  assert.ok(asked[0].includes('revealed'), 'pregunta a la que se deja');
  await p;
  const first = arg(m.cdp.exprs[n]);
  assert.deepEqual([first.tab, first.enter, first.shown], [true, 'restore', { [id]: [1, 3] }], 'lo que allí se veía, saneado');
  await step(t); await settle();
  const next = last(m.cdp);
  assert.ok(!('shown' in next) && !('tab' in next) && next.turns.at(-1).jota.endsWith('vuelvo'), 'luego, la de ahora');
  // la que se deja no contesta: no se espera más de FROM_WAIT_MS y se pinta sin `shown`
  const q = make({ page: NETFLIX, playback: false });
  q.v.turn('panel'); q.v.you('hola', true); await step(t); await settle();
  const k = q.cdp.exprs.length;
  const r = q.v.reset({ tab: true, from: () => new Promise(() => {}) });
  await step(t, 100); await r;
  const f = arg(q.cdp.exprs[k]);
  assert.deepEqual([f.tab, 'shown' in f], [true, false]);
});

test('tarjeta de contenido (Netflix): solo con el panel y un turno abierto; el ▶ cambia su estado', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const card = { key: 'nfx-play-1', kind: 'play', items: [{ title: 'La serie', sub: 'T1 · E2 · Uno', frac: 0.5, img: 'http://127.0.0.1:8787/idle/nfx?u=x', still: 'javascript:alert(1)' }] };
  const { cdp, v } = make();
  assert.equal(v.media(card), false, 'sin turno abierto, nada');
  v.turn('panel', { voice: true });
  assert.equal(v.media({ kind: 'raro', items: [{ title: 'x' }] }), false, 'lo que no es una tarjeta, no');
  assert.equal(v.media(card), true);
  await step(t);
  assert.deepEqual(last(cdp).turns.at(-1).media, { key: 'nfx-play-1', kind: 'play', state: 'idle', brand: 'netflix',
    items: [{ title: 'La serie', sub: 'T1 · E2 · Uno', left: '', frac: 0.5, img: 'http://127.0.0.1:8787/idle/nfx?u=x', still: '' }] }, 'saneada: sin direcciones raras');
  v.mediaState('press');
  await step(t);
  assert.equal(last(cdp).turns.at(-1).media.state, 'press');
  // con la píldora (se ve contenido) no se pone: no hay sitio, y quien la pone no espera
  const pill = make(); pill.v.turn('island', { voice: true });
  assert.equal(pill.v.media(card), false);
});

test('tarjeta de contenido: puesta en el reposo, al pasar a una web ajena sigue sin sus imágenes (nada de 127.0.0.1 desde la web)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const card = { key: 'yt-play-x', kind: 'play', brand: 'youtube', items: [{ title: 'Lofi', sub: 'Lofi Girl', frac: 0, img: 'http://127.0.0.1:8787/yt/img?id=n61ULEU7CO0' }] };
  const m = make({ page: IDLE });
  m.v.turn('panel', { voice: true });
  assert.equal(m.v.media(card), true);
  await step(t);
  assert.equal(last(m.cdp).turns.at(-1).media.items[0].img, card.items[0].img, 'en el reposo, con su miniatura');
  m.c.now = ctxOf({ ctx: 'web', page: WEB });
  m.v.jota('Hecho, ya suena');
  await step(t);
  assert.equal(last(m.cdp).turns.at(-1).media.items[0].img, '', 'en la web, sin ella');
  assert.equal(last(m.cdp).turns.at(-1).media.items[0].title, 'Lofi', 'el resto de la tarjeta sigue');
  assert.equal(last(m.cdp).turns.at(-1).media.brand, 'youtube', 'con su marca');
});

test('asked(): lo preguntado en el turno en curso (y nada sin turno)', () => {
  const { v } = make();
  assert.equal(v.asked(), '');
  v.turn('panel', { voice: true }); v.you('¿Por dónde voy de Suits?', true);
  assert.equal(v.asked(), '¿Por dónde voy de Suits?');
});

// ── tandas y ocultación
test('20 tokens en 50 ms producen una sola llamada a render', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('island'); v.you('¿qué tiempo hace?', true);
  await step(t);
  const n = cdp.exprs.length;
  let reply = '';
  for (let i = 0; i < 20; i++) { reply += 'pal' + i + ' '; v.jota(reply); t.mock.timers.tick(2.5); }
  await step(t);
  assert.equal(cdp.exprs.length - n, 1);
  assert.equal(last(cdp).turns.at(-1).jota, reply);
});

test('durante el turno se atenúa la isla de actividades (dim(0)); hide() la quita ya, avisa a onHide y descarta lo pendiente', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  let told = 0;
  v.onHide(() => told++);
  v.turn('panel'); v.you('hola', true); v.jota('buenas'); v.done();
  await step(t);
  assert.ok(cdp.exprs.at(-1).includes('window.TVIsland&&window.TVIsland.dim(0)'));
  v.hide(); await flushMicro();
  assert.equal(hidesOf(cdp), 1);
  assert.ok(cdp.exprs.at(-1).includes('window.TVIsland&&window.TVIsland.dim(1)'));
  assert.equal(told, 1);
  await step(t, 60_000);
  assert.deepEqual([hidesOf(cdp), told], [1, 1], 'el cierre por tiempo ya no oculta otra vez');
  // con un render pendiente: hide lo descarta
  v.turn('island'); v.you('x', true);
  v.hide(); await step(t, 200);
  assert.ok(cdp.exprs.at(-1).includes('TVAgent.hide()'), 'no se repinta tras ocultar');
  assert.equal(told, 2);
});

test('tras hide(), un done o error tardío del mismo turno no vuelve a sacar la capa', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  v.turn('panel'); v.you('hola', true); v.jota('buenas');
  await step(t);
  v.hide(); await settle();
  const n = cdp.exprs.length;
  v.done(); v.jota('más'); v.error('x');
  await step(t, 60_000);
  assert.equal(cdp.exprs.length, n, 'nada más en la tele');
  v.turn('panel'); v.you('nueva', true);
  await step(t);
  assert.equal(cdp.exprs.length, n + 1, 'el turno siguiente pinta normal');
});

test('sin sesión de CDP no se llama a nada y hide() avisa igual a onHide', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make(); cdp.session = null;
  let told = 0;
  v.onHide(() => told++);
  v.turn('panel'); v.you('hola', true); v.done();
  await step(t, 60_000); await settle();
  assert.deepEqual([cdp.exprs.length, cdp.calls.length], [0, 0]);
  assert.equal(told, 1);
  v.hide();
  assert.equal(told, 2);
});

test('una página donde TVAgent no llega a existir recibe la fuente como mucho una vez más (hasta reset)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cdp, v } = make();
  const injects = () => cdp.exprs.filter(e => e.includes('AGENTE-MINIMO')).length;
  v.turn('panel'); v.you('a', true);
  await step(t);
  cdp.has = false;
  for (let i = 0; i < 5; i++) { v.you('a' + i, true); await step(t); await flushMicro(); }
  assert.equal(injects(), 2, 'la primera y un solo reintento');
  v.reset(); await step(t); await flushMicro();
  assert.equal(injects(), 3, 'tras reset se vuelve a intentar');
});

test('ocultar devuelve la isla de actividades a 1 aunque TVAgent.hide falle', () => {
  let dim = null;
  const window = { TVAgent: { hide() { throw new Error('x'); } }, TVIsland: { dim(x) { dim = x; } } };
  assert.throws(() => new Function('window', tv.HIDE)(window));
  assert.equal(dim, 1);
});

test('voice: va en la foto solo con voz, saneada (≤ VOICE_ANCHORS_MAX anclas, números finitos ≥ 0) y con la cabeza al día', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { cdp, v } = make();
  v.turn('panel'); v.jota('Hola. Qué tal.');
  await step(t);
  assert.ok(!('voice' in last(cdp)), 'sin voz, la foto no la lleva');
  const anchors = Array.from({ length: 250 }, (_, i) => [i * 10, i]);
  v.voice({ anchors: [[-1, 0], [5, NaN], 'x', ...anchors], rate: 62, head: -100, upto: 1000, text: 14 });
  await step(t);
  let s = last(cdp);
  assert.equal(s.voice.anchors.length, tv.VOICE_ANCHORS_MAX, 'las últimas');
  assert.deepEqual(s.voice.anchors[0], [500, 50]);
  assert.deepEqual([s.voice.rate, s.voice.upto, s.voice.text], [62, 1000, 14]);
  assert.equal(s.voice.head, 0, 'la cabeza avanza hasta la foto: -100 + 100 ms del lote');
  v.jota('Hola. Qué tal estás.'); await step(t, 2000);
  assert.equal(last(cdp).voice.head, 1000, 'nunca pasa de upto');
  for (const bad of [{ anchors: [], rate: 0, head: 0, upto: 0, text: 0 }, { anchors: [], rate: 62, head: Infinity, upto: 0, text: 0 }, { rate: 62 }, 'x']) {
    assert.equal(tv.cleanVoice(bad), null);
  }
  v.voice(null); await step(t);
  assert.ok(!('voice' in last(cdp)), 'acabada o cortada: fuera');
  v.voice({ anchors: [], rate: 62, head: 0, upto: 0, text: 0 }); await step(t);
  s = last(cdp);
  assert.deepEqual(s.voice.anchors, [], 'en espera');
  v.turn('panel'); await step(t);
  assert.ok(!('voice' in last(cdp)), 'un turno nuevo empieza sin la voz del anterior');
});
