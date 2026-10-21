'use strict';
// Formato de la capa del agente (remote/src/tv/agent-form.js): la tabla de prioridades de formFor/decideForm, las apps
// de contenido por sufijo de host (sin falsos positivos) y la clave del contenido (alcance del override y de lo de Jota).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REMOTE = path.join(__dirname, '..', '..', 'remote');
const F = require(path.join(REMOTE, 'src', 'tv', 'agent-form'));
const { FORMS } = require(path.join(REMOTE, 'src', 'tv', 'agent-contract'));
const { CONTENT_HOSTS, isContent, contentEntry, contentKey, decideForm, formFor, OVERRIDE_SCOPE, FORM_SOURCES, FORCED_SOURCES } = F;

const IDLE = { url: 'http://127.0.0.1:8787/idle.html', idle: true };
const WEB = { url: 'https://cocina.example/paella' };
const NF = { url: 'https://www.netflix.com/browse' };

test('formFor: tabla completa de prioridades (usuario > Jota > contenido > reproducción > panel)', () => {
  const rows = [
    // [página, playback, override, agentLayout] → [form, by]
    [IDLE, false, null, null, 'panel', 'default'],
    [WEB, false, null, null, 'panel', 'default'],
    [NF, false, null, null, 'pill', 'content'],
    [{ url: 'http://127.0.0.1:8787/stage/p1.html', stage: 'html' }, false, null, null, 'pill', 'content'],
    [WEB, true, null, null, 'pill', 'playback'],
    [IDLE, true, null, null, 'pill', 'playback'],
    [NF, true, null, null, 'pill', 'content'],
    [{ ...IDLE, stage: 'tasks' }, false, null, null, 'panel', 'default'],   // escenario aún marcado con el reposo delante
    [WEB, false, null, 'pill', 'pill', 'agent'],
    [NF, true, null, 'panel', 'panel', 'agent'],
    [NF, false, 'panel', 'pill', 'panel', 'user'],
    [WEB, true, 'panel', null, 'panel', 'user'],
    [IDLE, false, 'pill', null, 'pill', 'user'],
    [WEB, false, 'grande', 'enorme', 'panel', 'default'],                     // valores raros: como si no estuvieran
    [{ url: 'javascript:alert(1)' }, false, null, null, 'panel', 'default'],
    [{ url: 'no es una url' }, false, null, null, 'panel', 'default'],
    [{}, false, null, null, 'panel', 'default'],
  ];
  for (const [page, playback, override, agentLayout, form, by] of rows) {
    const o = { ...page, playback, override, agentLayout };
    assert.deepEqual(decideForm(o), { form, by }, JSON.stringify(o));
    assert.equal(formFor(o), form);
    assert.ok(FORMS.includes(form) && FORM_SOURCES.includes(by));
  }
  assert.deepEqual([...FORCED_SOURCES], ['user', 'agent'], 'solo usuario y Jota devuelven la píldora al panel');
  assert.equal(OVERRIDE_SCOPE, 'content');
});

test('CONTENT_HOSTS por sufijo con límite de etiqueta (y de segmento en las que llevan ruta)', () => {
  for (const u of ['https://netflix.com/', 'https://www.netflix.com/watch/1', 'https://WWW.NETFLIX.COM./browse', 'http://www.netflix.com:8080/',
    'https://m.youtube.com/watch?v=x', 'https://music.youtube.com/', 'https://open.spotify.com/track/1', 'https://www.primevideo.com/',
    'https://www.rtve.es/play/videos/x', 'https://rtve.es/play', 'https://www.twitch.tv/x', 'https://www.atresplayer.com/', 'https://tv.apple.com/es'])
    assert.ok(isContent(u), u);
  for (const u of ['https://notnetflix.com/', 'https://netflix.com.evil.example/', 'https://evil-netflix.com/', 'https://www.rtve.es/noticias/',
    'https://www.rtve.es/playa/', 'https://spotify.com/', 'https://apple.com/tv', 'https://www.google.com/search?q=netflix.com',
    'file:///netflix.com', 'chrome://netflix.com', '', null, 'netflix.com'])
    assert.ok(!isContent(u), String(u));
  assert.equal(contentEntry('https://music.youtube.com/'), 'music.youtube.com', 'la entrada más larga');
  assert.equal(new Set(CONTENT_HOSTS).size, CONTENT_HOSTS.length, 'sin repetidas');
  for (const h of CONTENT_HOSTS) assert.match(h, /^[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9-]+)*$/, `entrada «${h}» en minúsculas, sin esquema ni barra final`);
  assert.ok(isContent('http://netflix.localhost:9/browse', [...CONTENT_HOSTS, 'netflix.localhost']), 'lista inyectable (pruebas)');
  assert.ok(!isContent('http://netflix.localhost:9/browse'));
});

test('CONTENT_HOSTS: están todas las apps que abre tv_open_app', () => {
  const mcp = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp', 'server.js'), 'utf8');
  const urls = [...mcp.matchAll(/'(https:\/\/[^'?$]+)/g)].map(m => m[1]);
  assert.ok(urls.length >= 3);
  for (const u of urls) assert.ok(isContent(u), `tv_open_app abre ${u}, que no está en CONTENT_HOSTS`);
});

test('contentKey: reposo, escenario, app (por su entrada: un salto de host dentro de la app es lo mismo) o host sin www', () => {
  assert.equal(contentKey(IDLE), 'idle');
  assert.equal(contentKey({ ...IDLE, stage: 'html' }), 'idle');
  assert.equal(contentKey({ url: 'http://127.0.0.1:8787/tpl-tasks.html', stage: 'tasks' }), 'stage:tasks');
  assert.equal(contentKey({ url: 'https://netflix.com/' }), contentKey(NF));
  assert.equal(contentKey(NF), 'netflix.com');
  assert.equal(contentKey({ url: 'https://www.cocina.example/a' }), 'cocina.example');
  assert.equal(contentKey(WEB), 'cocina.example');
  assert.equal(contentKey({ url: 'x' }), '');
});

test('layout de Jota: tv_open / tv_open_app del MCP lo aceptan (mismos valores que FORMS) y lo pasan a la orden nav', () => {
  const mcp = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp', 'server.js'), 'utf8');
  assert.deepEqual(new Function('return ' + mcp.match(/const LAYOUTS = (\[[^\]]*\]);/)[1])(), [...FORMS]);
  assert.match(mcp, /tool\('tv_open',[\s\S]*?\{ url: [^\n]*, layout \},\n\s*async \(\{ url, layout \}\) => out\(await cmd\(\{ t: 'nav', url, \.\.\.\(layout \? \{ layout \} : \{\}\) \}\)/);
  assert.match(mcp, /tool\('tv_open_app',[\s\S]*?, layout \},\n\s*async \(\{ app, query, layout \}\)[\s\S]*?\{ t: 'nav', url, \.\.\.\(layout \? \{ layout \} : \{\}\) \}/);
  assert.ok(mcp.includes('pill when the page is meant to be watched full screen (a video, a photo gallery, a map); ') && mcp.includes('default keeps the conversation panel'));
  const plugin = fs.readFileSync(path.join(__dirname, '..', '..', 'plugin', 'tv-canvas', 'mcp', 'server.js'), 'utf8');
  assert.equal(plugin, mcp, 'plugin sincronizado (npm run sync-plugin)');
});

test('control.nav con layout: avisa (onLayout) con la URL ya normalizada antes de navegar; sin layout o con una dirección mala, no; onNavigate en cada navegación buena', async () => {
  const createControl = require(path.join(REMOTE, 'src', 'features', 'control'));
  const seen = [];
  const cdp = { call: async (m, p) => { seen.push(['cdp', m, p && p.url]); return {}; } };
  const c = createControl({ cdp, state: {}, broadcast() {}, key() {}, audio: /** @type {any} */ ({}), cfg: { HOME_URL: 'http://tv/idle.html', SELF: 'http://tv' },
    leaveStage() {}, onLayout: (u, l) => seen.push(['layout', l, u]), onNavigate: () => seen.push(['navigating']) });
  const nav = c.commands.find(x => x.t === 'nav');
  await nav.run({ url: 'fotos.example/album', layout: 'pill' });
  await nav.run({ url: 'https://x.example/' });
  await nav.run({ url: 'javascript:alert(1)', layout: 'pill' });
  assert.deepEqual(seen, [['layout', 'pill', 'https://fotos.example/album'], ['navigating'], ['cdp', 'Page.navigate', 'https://fotos.example/album'],
    ['navigating'], ['cdp', 'Page.navigate', 'https://x.example/']]);
});

test('layoutOf (args de tool_call del Gateway): tv_open con url y tv_open_app con app conocida; lo demás, null', () => {
  const { layoutOf, APP_URLS } = require(path.join(REMOTE, 'src', 'features', 'agent-ui'));
  assert.deepEqual(layoutOf('tv-canvas__tv_open', { url: 'fotos.example', layout: 'pill' }), { layout: 'pill', url: 'https://fotos.example' });
  assert.deepEqual(layoutOf('tv_open', { url: 'http://a.example/x', layout: 'panel' }), { layout: 'panel', url: 'http://a.example/x' });
  assert.deepEqual(layoutOf('tv_open_app', { app: 'youtube', layout: 'pill' }), { layout: 'pill', url: APP_URLS.youtube });
  for (const [n, a] of [['tv_open', { url: 'a.example' }], ['tv_open', { url: '', layout: 'pill' }], ['tv_open', { url: 'a', layout: 'grande' }],
    ['tv_open_app', { app: 'home', layout: 'pill' }], ['tv_volume', { layout: 'pill' }], ['not_tv_openx', { url: 'a', layout: 'pill' }], ['tv_open', null]])
    assert.equal(layoutOf(n, a), null, JSON.stringify([n, a]));
  for (const u of Object.values(APP_URLS)) assert.ok(isContent(u), u);
});

test('opensPage: las herramientas con ficha que ponen otra página (el cierre espera a que se pinte); las demás, no', () => {
  const { opensPage } = require(path.join(REMOTE, 'src', 'features', 'agent-ui'));
  for (const [n, a] of [['tv-canvas__tv_open', { url: 'x.example' }], ['tv_open_app', { app: 'netflix' }], ['tv_present', { kind: 'tasks', data: {} }],
    ['tv_show_html', { html: '<p>' }], ['tv_idle', { op: 'show' }]]) assert.equal(opensPage(n, a), true, n);
  for (const [n, a] of [['tv_media', { action: 'playpause' }], ['tv_volume', { action: 'up' }], ['tv_spotify', { action: 'play' }],
    ['tv_idle', { op: 'set' }], ['tv_state', {}], ['HassTurnOn', { name: 'luz' }], ['xtv_open', { url: 'a' }]]) assert.equal(opensPage(n, a), false, n);
});

test('tv_click_at: la membrana de la conversación deja pasar el clic de Jota y lo recupera después (también si falla)', async () => {
  const createControl = require(path.join(REMOTE, 'src', 'features', 'control'));
  const seen = [];
  let fail = false;
  const cdp = { call: async (m, p) => { seen.push(m === 'Runtime.evaluate' ? p.expression : m + ':' + p.type); if (fail && p.type === 'mousePressed') throw new Error('x'); return {}; } };
  const c = createControl({ cdp, state: {}, broadcast() {}, key() {}, audio: /** @type {any} */ ({}), cfg: { HOME_URL: 'h', SELF: 's' }, leaveStage() {} });
  await c.clickAt(10, 20);
  assert.deepEqual(seen, ['window.TVAgent&&window.TVAgent.pass&&window.TVAgent.pass(true)', 'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed', 'Input.dispatchMouseEvent:mouseReleased', 'window.TVAgent&&window.TVAgent.pass&&window.TVAgent.pass(false)']);
  seen.length = 0; fail = true;
  await assert.rejects(c.clickAt(10, 20));
  assert.equal(seen.at(-1), 'window.TVAgent&&window.TVAgent.pass&&window.TVAgent.pass(false)');
});

test('stageOf: el escenario sale de la URL (plantilla o HTML propio); fuera de él, null aunque el estado siga marcado', () => {
  const SELF = 'http://127.0.0.1:8787';
  assert.equal(F.stageOf(SELF + '/tpl-tasks.html', SELF), 'tasks');
  assert.equal(F.stageOf(SELF + '/tpl-slides.html?x=1#y', SELF), 'slides');
  assert.equal(F.stageOf(SELF + '/stage/p1a2b.html', SELF), 'html');
  for (const u of [SELF + '/idle.html', 'https://es.wikipedia.org/wiki/Gato', 'https://evil.example/tpl-tasks.html', SELF + 'x/tpl-tasks.html', '', null])
    assert.equal(F.stageOf(u, SELF), null, String(u));
});

test('tras tv_present, «atrás» a una web normal: la web es panel y su clave es la del host (no la del escenario)', async () => {
  const fsx = require('node:fs'), os = require('node:os');
  const createStage = require(path.join(REMOTE, 'src', 'features', 'stage'));
  const createControl = require(path.join(REMOTE, 'src', 'features', 'control'));
  const SELF = 'http://127.0.0.1:8787';
  const state = { url: 'https://es.wikipedia.org/wiki/Gato' };
  const hist = [state.url]; let idx = 0;
  const cdp = { call: async (m, p) => {
    if (m === 'Page.navigate') { hist.splice(idx + 1); hist.push(p.url); idx = hist.length - 1; state.url = p.url; }
    if (m === 'Page.getNavigationHistory') return { currentIndex: idx, entries: hist.map((u, i) => ({ id: i, url: u })) };
    if (m === 'Page.navigateToHistoryEntry') { idx = p.entryId; state.url = hist[idx]; }
    return {};
  } };
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  let control;
  const stage = createStage({ cdp, state, cfg: { SELF, HOME_URL: SELF + '/idle.html', STAGE_DIR: dir }, nav: u => control.nav(u) });
  control = createControl({ cdp, state, broadcast() {}, key() {}, audio: /** @type {any} */ ({}), cfg: { SELF, HOME_URL: SELF + '/idle.html' }, leaveStage: () => stage.leave() });
  await stage.commands.find(c => c.t === 'present').run({ kind: 'tasks', data: { items: [] } });
  const page = () => ({ url: state.url, stage: F.stageOf(state.url, SELF), idle: false });   // como server.js agentCtx
  assert.deepEqual(decideForm({ ...page(), playback: false }), { form: 'pill', by: 'content' }, 'en el escenario: contenido');
  await control.commands.find(c => c.t === 'back').run({});
  assert.equal(state.url, 'https://es.wikipedia.org/wiki/Gato');
  assert.deepEqual(decideForm({ ...page(), playback: false }), { form: 'panel', by: 'default' });
  assert.equal(contentKey(page()), 'es.wikipedia.org');
  fsx.rmSync(dir, { recursive: true, force: true });
});

test('control: abrir la URL que ya se ve (o «recargar») avisa con onReload después de navegar; otra URL, no (ya la ve onPage)', async () => {
  const createControl = require(path.join(REMOTE, 'src', 'features', 'control'));
  const seen = [], state = { url: 'http://tv/idle.html' };
  const cdp = { call: async (m, p) => { seen.push(m + (p && p.url ? ' ' + p.url : '')); return {}; } };
  const c = createControl({ cdp, state, broadcast() {}, key() {}, audio: /** @type {any} */ ({}), cfg: { HOME_URL: 'http://tv/idle.html', SELF: 'http://tv' },
    leaveStage() {}, onReload: () => seen.push('reload') });
  await c.nav('http://tv/idle.html');                 // tv_idle show estando en el reposo
  await c.nav('https://www.netflix.com/browse');      // otra URL (state.url no cambia aquí: lo hace onPage)
  await c.commands.find(x => x.t === 'reload').run({});
  assert.deepEqual(seen, ['Page.navigate http://tv/idle.html', 'reload', 'Page.navigate https://www.netflix.com/browse', 'Page.reload', 'reload']);
});
