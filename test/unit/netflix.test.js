'use strict';
// Netflix en su pestaña: primera apertura (pantalla de perfiles), volver a abrir sin recargar, «ponme X» con caché de
// títulos, perfiles y errores. Con un Chrome de mentira que imita lo justo de la web de Netflix.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const createNetflix = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'netflix'));
const createControl = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'control'));

const PROFILES = { Carmen: 'GC', Alfonso: 'GA', Pablo: 'GP' };
const CATALOG = { 'stranger things': [{ id: '80057281', title: 'Stranger Things' }, { id: '81398721', title: 'Stranger Things: Tales' }], dark: [{ id: '80114791', title: 'Dark Matter' }, { id: '80100172', title: 'Dark' }] };

/** Chrome con una pestaña «de siempre» (el reposo) y, si se abre, la de Netflix. */
function fakeTv({ login = false, stuckSpa = false } = {}) {
  const pages = new Map([['MAIN', { url: 'http://127.0.0.1:8787/idle.html' }]]);
  const nf = { url: '', cur: null, gate: false, old: false, video: 0, hidden: false, loads: 0 };
  const log = [];
  const cdp = {
    pages, targetId: 'MAIN',
    async show(id) { log.push('show:' + id); cdp.targetId = id; },
    async newTab() { pages.set('NF', { url: 'about:blank' }); cdp.targetId = 'NF'; log.push('newTab'); return 'NF'; },
    async call(method, params) {
      if (method === 'Page.navigate') {
        log.push('navigate:' + (cdp.targetId === 'NF' ? params.url.replace('https://www.netflix.com', '') : params.url));
        if (cdp.targetId !== 'NF') { pages.get(cdp.targetId).url = params.url; return {}; }
        nf.loads++; nf.old = false;
        const u = new URL(params.url);
        if (login) nf.url = 'https://www.netflix.com/login';
        else if (u.pathname === '/SwitchProfile') { nf.cur = u.searchParams.get('tkn'); nf.gate = false; nf.url = 'https://www.netflix.com/browse'; }
        else { nf.url = params.url; nf.gate = !nf.cur; }
        nf.video = u.pathname.startsWith('/watch/') ? 2 : 0; nf.spaOnly = false;
        pages.get('NF').url = nf.url;
        return {};
      }
      if (method !== 'Runtime.evaluate') return {};
      if (cdp.targetId !== 'NF') return { result: { value: undefined } };
      const e = params.expression;
      let value;
      if (e === 'window.__tvOld=1') nf.old = true;
      else if (e === 'window.__tvHidden=false') nf.hidden = false;
      else if (e.includes('__tvHidden=true')) { nf.hidden = true; nf.video = nf.video && 1; log.push('pausa'); value = 1; }
      else if (e.includes('falcorCache')) {
        const u = new URL(nf.url);
        value = { u: nf.url, old: nf.old, gate: nf.gate, login: u.pathname === '/login', cur: nf.cur || undefined, ps: login ? {} : PROFILES };
      } else if (e.includes('pushState')) {
        const p = JSON.parse(e.match(/pushState\(history\.state,'',("[^"]*")\)/)[1]);
        nf.url = 'https://www.netflix.com' + p; pages.get('NF').url = nf.url;
        log.push('spa:' + p);
        if (p.startsWith('/watch/') && !stuckSpa) nf.video = 2;
        nf.spaOnly = stuckSpa; // la web cambia la dirección pero no repinta
        value = 1;
      } else if (e.includes('standard-card')) {
        const q = new URL(nf.url).searchParams.get('q') || '';
        value = nf.spaOnly ? [] : Object.entries(CATALOG).filter(([k]) => q && k.includes(q.toLowerCase())).flatMap(([, v]) => v);
      } else if (e.includes('v.currentTime>0')) value = nf.video;
      return { result: { value } };
    },
  };
  return { cdp, nf, log };
}
const memStore = (init = {}) => { let v = init; return { load: () => v, save: x => { v = JSON.parse(JSON.stringify(x)); }, get: () => v }; };
const fast = { wait: async () => {}, now: (() => { let t = 0; return () => (t += 10); })() };

test('Netflix: la primera vez abre su pestaña, pasa la pantalla de perfiles y aprende los perfiles', async () => {
  const { cdp, log } = fakeTv();
  const store = memStore();
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store, ...fast });
  const r = await n.open();
  assert.deepEqual(r, { ok: 1, profile: 'Alfonso' });
  assert.deepEqual(log, ['newTab', 'navigate:/browse', 'navigate:/SwitchProfile?tkn=GA']);
  assert.deepEqual(store.get().profiles, PROFILES, 'los perfiles se guardan para ir directo la próxima vez');
});

test('Netflix: volver a abrirlo no recarga (la pestaña se queda cargada detrás) y al salir se pausa', async () => {
  const { cdp, nf, log } = fakeTv();
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast });
  await n.open();
  assert.deepEqual(log, ['newTab', 'navigate:/SwitchProfile?tkn=GA'], 'con los perfiles ya sabidos, directo al perfil');
  log.length = 0;
  await n.leave();
  assert.equal(nf.hidden, true);
  assert.deepEqual(log, ['pausa', 'show:MAIN']);
  log.length = 0;
  const loads = nf.loads;
  assert.deepEqual(await n.open(), { ok: 1, profile: 'Alfonso' });
  assert.deepEqual(log, ['show:NF'], 'solo traerla al frente');
  assert.equal(nf.loads, loads);
  assert.equal(nf.hidden, false, 'delante, puede volver a sonar');
});

test('Netflix: «ponme X» busca, elige el título exacto, lo pone y la segunda vez va directo', async () => {
  const { cdp, log } = fakeTv();
  const store = memStore({ profiles: PROFILES });
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store, ...fast });
  const r = await n.play({ title: 'Dark' });
  assert.equal(r.ok, 1); assert.equal(r.id, '80100172', 'el exacto, aunque no sea el primero'); assert.equal(r.playing, true);
  assert.equal(r.candidates, undefined, 'exacto: sin dudas que contar');
  assert.ok(log.includes('spa:/search?q=Dark') && log.includes('spa:/watch/80100172'));
  assert.deepEqual(store.get().titles.dark, { id: '80100172', title: 'Dark' });
  log.length = 0;
  await n.leave(); log.length = 0;
  const r2 = await n.play({ title: 'dark' });
  assert.equal(r2.id, '80100172');
  assert.deepEqual(log, ['show:NF', 'spa:/watch/80100172'], 'sin buscar ni recargar');
});

test('Netflix: sin título exacto pone el más parecido y cuenta las alternativas; un id va directo', async () => {
  const { cdp } = fakeTv();
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast });
  const r = await n.play({ title: 'Stranger' });
  assert.equal(r.id, '80057281');
  assert.equal(r.candidates.length, 2);
  assert.equal((await n.play({ id: '81398721' })).id, '81398721');
  assert.match((await n.play({ title: 'nada que exista' })).error, /No encuentro/);
  assert.match((await n.play({ id: '1; alert(1)' })).error, /id no válido/);
});

test('Netflix: otro perfil para una petición, perfil por defecto desde el mando y perfiles desconocidos', async () => {
  const { cdp, nf } = fakeTv();
  const store = memStore({ profiles: PROFILES });
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store, ...fast });
  await n.play({ title: 'Dark', profile: 'carmen' });
  assert.equal(nf.cur, 'GC');
  await n.open();
  assert.equal(nf.cur, 'GA', 'sin pedir otro, vuelve al de por defecto');
  assert.deepEqual(n.setProfile('Pablo'), { profile: 'Pablo', profiles: ['Carmen', 'Alfonso', 'Pablo'] });
  assert.equal(store.get().profile, 'Pablo');
  await n.open();
  assert.equal(nf.cur, 'GP');
  assert.match((await n.open({ profile: 'Lucía' })).error, /No hay un perfil «Lucía».*Carmen, Alfonso, Pablo/);
  assert.match(n.setProfile('Lucía').error, /desconocido/);
});

test('Netflix: si la web no repinta tras navegar por dentro, se recarga (búsqueda y vídeo)', async () => {
  const { cdp, log } = fakeTv({ stuckSpa: true });
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast });
  const r = await n.play({ title: 'Dark' });
  assert.equal(r.id, '80100172'); assert.equal(r.playing, true);
  assert.ok(log.includes('navigate:/search?q=Dark') && log.includes('navigate:/watch/80100172'), log.join(' '));
});

test('Netflix: si pide iniciar sesión, no escribe nada y lo dice', async () => {
  const { cdp } = fakeTv({ login: true });
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore(), ...fast });
  assert.match((await n.open()).error, /iniciar sesión/);
});

test('Netflix: tras reiniciar el servidor adopta la pestaña que ya estaba abierta', async () => {
  const { cdp, nf, log } = fakeTv();
  cdp.pages.set('NF', { url: 'https://www.netflix.com/browse' });
  Object.assign(nf, { url: 'https://www.netflix.com/browse', cur: 'GA' });
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast });
  await n.open();
  assert.deepEqual(log, ['show:NF']);
});

test('control: las direcciones de Netflix van a su pestaña y el resto vuelve a la de siempre', async () => {
  const seen = [];
  const netflix = {
    isNetflix: u => /netflix\.com/.test(u),
    open: async m => { seen.push('open ' + m.url); return { ok: 1 }; },
    leave: async () => { seen.push('leave'); },
  };
  const cdp = { call: async (m, p) => { seen.push(m + ' ' + p.url); return {}; } };
  const c = createControl({ cdp, state: {}, broadcast() {}, key() {}, audio: {}, cfg: { HOME_URL: 'http://127.0.0.1:8787/idle.html', SELF: 'http://127.0.0.1:8787' }, leaveStage() {}, netflix });
  assert.deepEqual(await c.nav('https://www.netflix.com'), { ok: 1, url: 'https://www.netflix.com' });
  await c.nav('youtube.com');
  assert.deepEqual(seen, ['open https://www.netflix.com', 'leave', 'Page.navigate https://youtube.com']);
});

test('Netflix: antes de traerlo al frente avisa de lo que va a poner (la conversación enseña su tarjeta y su ▶)', async () => {
  const { cdp, log } = fakeTv();
  const seen = [];
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES, titles: { dark: { id: '80100172', title: 'Dark' } } }), ...fast,
    beforePlay: async t => { seen.push({ ...t, before: log.length }); } });
  await n.play({ title: 'Dark' });
  assert.deepEqual(seen, [{ id: '80100172', title: 'Dark', before: 0 }], 'con el id ya sabido y antes de tocar nada en la tele');
  await n.play({ id: '81398721' });
  assert.equal(seen[1].id, '81398721');
  // si quien escucha falla, se pone igual
  const m = createNetflix({ cdp: fakeTv().cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast, beforePlay: async () => { throw new Error('sin capa'); } });
  assert.equal((await m.play({ title: 'Dark' })).ok, 1);
});

test('Netflix: la pestaña adoptada tras reiniciar dice en qué perfil está (sin traerla al frente) y se suelta', async () => {
  const calls = [];
  const cdp = {
    pages: new Map([['MAIN', { url: 'http://127.0.0.1:8787/idle.html' }], ['NF', { url: 'https://www.netflix.com/browse' }]]), targetId: 'MAIN',
    show: async () => calls.push('show'), newTab: async () => 'X',
    call: async (m, p) => { calls.push(m); return m === 'Target.attachToTarget' ? { sessionId: 'S-NF' } : {}; },
    request: async (m, p, sid) => { calls.push(m + '@' + sid); return { result: { value: { cur: 'GC', gate: false } } }; },
  };
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast });
  assert.deepEqual(await n.profileInfo(), { name: 'Alfonso', guid: 'GA', alive: true, tabGuid: 'GC' });
  assert.deepEqual(calls, ['Target.attachToTarget', 'Runtime.evaluate@S-NF', 'Target.detachFromTarget']);
  calls.length = 0;
  await n.profileInfo();
  assert.deepEqual(calls, [], 'ya sabido: no se vuelve a preguntar');
});

test('Netflix: si la pestaña de fondo está en «¿Quién eres?», entra en el perfil antes de enseñarla', async () => {
  const order = [];
  let page = { cur: 'GA', gate: true, u: 'https://www.netflix.com/browse' };
  const cdp = {
    pages: new Map([['MAIN', { url: 'http://127.0.0.1:8787/idle.html' }], ['NF', { url: 'https://www.netflix.com/browse' }]]), targetId: 'MAIN',
    show: async id => { order.push('show:' + id + (page.gate ? ':CON-PANTALLA-DE-PERFILES' : '')); cdp.targetId = id; },
    newTab: async () => 'X',
    call: async (m, p) => { if (m === 'Runtime.evaluate') return { result: { value: cdp.targetId === 'NF' ? { u: page.u, old: false, gate: page.gate, cur: page.cur, ps: PROFILES } : undefined } }; if (m === 'Target.attachToTarget') return { sessionId: 'S' }; return {}; },
    request: async (m, p) => {
      if (m === 'Page.navigate') { order.push('switch'); page = { cur: 'GA', gate: false, u: 'https://www.netflix.com/browse' }; return {}; }
      return { result: { value: { ...page, ps: PROFILES } } };
    },
  };
  const n = createNetflix({ cdp, cfg: { NETFLIX_PROFILE: 'Alfonso' }, store: memStore({ profiles: PROFILES }), ...fast });
  assert.deepEqual(await n.open(), { ok: 1, profile: 'Alfonso' });
  assert.deepEqual(order, ['switch', 'show:NF'], 'nunca se ve «¿Quién eres?»');
});
