'use strict';
// YouTube: «pon en YouTube X» busca en una pestaña de fondo, enseña la tarjeta, pone el primer vídeo de verdad en la
// pestaña de siempre (pantalla completa) y espera a que suene. Con un Chrome de mentira y unos datos de búsqueda como los
// de la web (ytInitialData), con anuncios, Shorts y listas por medio.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const createYoutube = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'youtube'));
const { pgResults } = createYoutube;

const vr = (id, title, o = {}) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: o.channel || 'Canal' }] },
  ...(o.live ? { badges: [{ metadataBadgeRenderer: { label: 'LIVE', style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } : { lengthText: { simpleText: o.len || '3:10' } }),
  navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: o.url || '/watch?v=' + id } } } } });
/** ytInitialData de una búsqueda: anuncio, Short suelto, estantería de Shorts y lista antes y entre los vídeos */
const SEARCH = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
  { itemSectionRenderer: { contents: [
    { adSlotRenderer: { slotId: 'x' } },
    vr('shortAAAAAA', 'un short', { url: '/shorts/shortAAAAAA' }),
    { reelShelfRenderer: { title: 'Shorts' } },
    vr('n61ULEU7CO0', 'Best of lofi hip hop 2021', { channel: 'Lofi Girl', len: '6:10:58' }),
    { lockupViewModel: { contentId: 'PLxxxx' } },
    vr('rFZHOHl-L8A', 'lofi hip hop radio', { channel: 'Lofi Girl', live: true }),
    vr('n61ULEU7CO0', 'repetido'),
    vr('CFGLoQIhmow', 'lofi mix (Part 1)'),
  ] } },
  { continuationItemRenderer: {} },
] } } } } };

/** pgResults tal como corre en la página (sin nada de Node), con estos datos. */
function inPage(data, anchors = []) {
  const ctx = vm.createContext({ window: { ytInitialData: data }, document: { querySelectorAll: () => anchors }, URL, JSON });
  return JSON.parse(JSON.stringify(vm.runInContext(`(${pgResults})()`, ctx)));   // a este lado (otro realm)
}

test('YouTube: de la búsqueda, solo vídeos de verdad (ni anuncios, ni Shorts, ni listas), sin repetir y en orden', () => {
  const r = inPage(SEARCH);
  assert.deepEqual(r.map(v => v.id), ['n61ULEU7CO0', 'rFZHOHl-L8A', 'CFGLoQIhmow']);
  assert.deepEqual(r[0], { id: 'n61ULEU7CO0', title: 'Best of lofi hip hop 2021', channel: 'Lofi Girl', len: '6:10:58', live: false });
  assert.equal(r[1].live, true, 'el directo, marcado');
});

test('YouTube: si la web cambia y no hay ytInitialData, los vídeos del DOM', () => {
  const a = (id, t) => ({ href: 'https://www.youtube.com/watch?v=' + id + '&pp=x', getAttribute: k => (k === 'title' ? t : null), textContent: t });
  const r = inPage(undefined, [a('n61ULEU7CO0', 'Lofi'), a('bad', 'id raro')]);
  assert.deepEqual(r.map(v => [v.id, v.title]), [['n61ULEU7CO0', 'Lofi']]);
});

/** Chrome con la pestaña de siempre (el reposo) y pestañas de fondo para buscar. */
function fakeTv({ results = inPage(SEARCH), adMs = 0, stuck = false } = {}) {
  const log = [];
  const tv = { url: 'http://127.0.0.1:8787/idle.html', polls: 0, fs: false };
  const cdp = {
    async bgTab() {
      log.push('bg');
      return {
        go: async url => log.push('bg:' + url.replace('https://www.youtube.com', '')),
        until: async (fn, ok) => { assert.equal(typeof fn, 'function'); const v = results; return ok(v) ? v : v; },
        close: async () => log.push('bg:close'),
      };
    },
    async call(method, params) {
      if (method !== 'Runtime.evaluate') return {};
      const id = new URL(tv.url).searchParams.get('v');
      assert.ok(params.expression.includes('movie_player'));
      if (!params.expression.includes(JSON.stringify(id))) return { result: { value: { st: 0 } } };
      tv.polls++;
      const st = stuck ? 1 : tv.polls < 2 ? 0 : tv.polls < 3 ? 1 : 2;
      return { result: { value: { st, ad: tv.polls * 100 < adMs, fs: tv.fs, ...(st === 2 ? { title: 'título del reproductor' } : {}) } } };
    },
  };
  const nav = async url => { log.push('nav:' + url); tv.url = url; tv.polls = 0; return { ok: 1, url }; };
  const key = k => { log.push('key:' + k); tv.fs = true; };
  return { cdp, nav, key, log, tv };
}
const fast = { wait: async () => {}, now: (() => { let t = 0; return () => (t += 10); })() };

test('YouTube: «pon en YouTube música lofi» busca detrás, enseña la tarjeta, pone el primero a pantalla completa y espera a que suene', async () => {
  const { cdp, nav, key, log } = fakeTv();
  const cards = [];
  const yt = createYoutube({ cdp, nav, key, self: 'http://127.0.0.1:8787', ...fast, get: async () => ({ ok: false }),
    beforePlay: c => { cards.push(c); log.push('card'); } });
  const r = await yt.play({ query: 'música lofi' });
  assert.equal(r.ok, 1); assert.equal(r.id, 'n61ULEU7CO0'); assert.equal(r.playing, true);
  assert.equal(r.title, 'título del reproductor', 'el título del vídeo que suena');
  assert.equal(r.ad, undefined);
  assert.deepEqual(r.candidates.map(c => c.id), ['rFZHOHl-L8A', 'CFGLoQIhmow']);
  assert.deepEqual(log, ['bg', 'bg:/results?search_query=m%C3%BAsica%20lofi', 'bg:close', 'card', 'nav:https://www.youtube.com/watch?v=n61ULEU7CO0', 'key:f'],
    'la búsqueda no se ve; la tarjeta antes de irse; una sola navegación');
  assert.deepEqual(cards[0], { key: 'yt-play-n61ULEU7CO0', kind: 'play', brand: 'youtube', items: [{ title: 'Best of lofi hip hop 2021', sub: 'Lofi Girl · 6:10:58', left: '', frac: 0,
    img: 'http://127.0.0.1:8787/yt/img?id=n61ULEU7CO0' }] });
});

test('YouTube: con un id va directo (sin buscar); con un anuncio delante lo dice; ids y búsquedas vacías, fuera', async () => {
  const { cdp, nav, key, log } = fakeTv({ adMs: 1000 });
  const yt = createYoutube({ cdp, nav, key, ...fast, get: async () => ({ ok: false }) });
  const r = await yt.play({ id: 'CFGLoQIhmow' });
  assert.equal(r.id, 'CFGLoQIhmow'); assert.equal(r.ad, true); assert.equal(r.candidates, undefined);
  assert.ok(!log.includes('bg'), 'sin pestaña de fondo');
  assert.match((await yt.play({ id: '"><script>' })).error, /id no válido/);
  assert.match((await yt.play({})).error, /falta/);
  assert.match((await yt.run({ op: 'search' })).error, /falta/);
  assert.match((await yt.run({ op: 'x' })).error, /op debe ser/);
});

test('YouTube: sin resultados o con la web parada, error claro y no se toca la tele', async () => {
  const empty = fakeTv({ results: [] });
  const yt = createYoutube({ cdp: empty.cdp, nav: empty.nav, key: empty.key, ...fast });
  assert.match((await yt.play({ query: 'zzzz' })).error, /No encuentro «zzzz»/);
  assert.ok(!empty.log.some(l => l.startsWith('nav:')), 'sin navegar');
  const down = createYoutube({ cdp: { bgTab: async () => { throw new Error('cdp'); }, call: async () => ({}) }, nav: empty.nav, ...fast });
  assert.match((await down.play({ query: 'x' })).error, /YouTube no responde/);
  const stuck = fakeTv({ stuck: true });
  const r = await createYoutube({ cdp: stuck.cdp, nav: stuck.nav, key: stuck.key, ...fast }).play({ query: 'lofi' });
  assert.equal(r.ok, 1); assert.equal(r.playing, false, 'se dice que no arranca');
});

test('YouTube: search devuelve los resultados sin poner nada', async () => {
  const { cdp, nav, log } = fakeTv();
  const r = await createYoutube({ cdp, nav, ...fast }).search({ query: 'lofi' });
  assert.equal(r.results.length, 3);
  assert.ok(!log.some(l => l.startsWith('nav:')));
});

test('YouTube: la miniatura se pide por id (nunca una URL de fuera), con la mediana si no hay grande, y solo desde la tele', async () => {
  const asked = [];
  const get = async u => { asked.push(u); return /hq720/.test(u) ? { ok: false } : { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([1, 2]).buffer }; };
  const yt = createYoutube({ cdp: /** @type {any} */ ({}), nav: async () => ({}), get, ...fast });
  const b = await yt.thumb('n61ULEU7CO0');
  assert.deepEqual([...b.buf], [1, 2]);
  assert.deepEqual(asked, ['https://i.ytimg.com/vi/n61ULEU7CO0/hq720.jpg', 'https://i.ytimg.com/vi/n61ULEU7CO0/mqdefault.jpg']);
  await yt.thumb('n61ULEU7CO0');
  assert.equal(asked.length, 2, 'en caché');
  assert.equal(await yt.thumb('https://evil/x'), null);
  const route = yt.routes[0];
  assert.equal(route.path, '/yt/img');
  const res = { code: 0, writeHead(c) { this.code = c; }, end() {}, setHeader() {} };
  await route.run({ socket: { remoteAddress: '192.168.1.50' }, headers: {} }, res, { url: new URL('http://x/yt/img?id=n61ULEU7CO0') });
  assert.equal(res.code, 403, 'un móvil de la red no la pide');
});
