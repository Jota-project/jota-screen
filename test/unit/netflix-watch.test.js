'use strict';
// «Seguir viendo» e historial de Netflix: lectura del historial, cuándo se lee (y cuándo no), lo que se da al reposo y
// al agente, «ponme la de ayer» y las imágenes. Datos inventados; nada de Netflix de verdad.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const W = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'netflix-watch'));
const createNetflix = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'netflix'));
const { createCommands } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'transport', 'commands'));

const IMG = id => `https://occ-0-1-2.1.nflxso.net/dnm/api/v6/abc_DEF-1/AAAAB${id}.webp?r=a1b`;
const ITEMS = [
  { id: 1001, kind: 'show', title: 'La serie de prueba', ep: { id: 2001, s: 2, seasonId: 3001, e: 4, title: 'Capítulo: con dos puntos', still: IMG('s1') }, pos: 600, dur: 2400, card: IMG('c1'), story: IMG('a1') },
  { id: 1002, kind: 'movie', title: 'Una película', ep: null, pos: 0, dur: 5400, card: IMG('c2'), story: 'https://evil.example/x.webp' },
];
const HISTORY = [
  { day: '2026-10-20', date: '20/10/26', id: 2001, title: 'La serie de prueba', season: 'Temporada 2', episode: 'Capítulo: con dos puntos' },
  { day: '2026-10-20', date: '20/10/26', id: 2000, title: 'La serie de prueba', season: 'Temporada 2', episode: 'El anterior' },
  { day: '2026-10-18', date: '18/10/26', id: 1002, title: 'Una película', season: null, episode: null },
];
const memStore = (init = {}) => { let v = init; return { load: () => v, save: x => { v = JSON.parse(JSON.stringify(x)); }, get: () => v }; };

test('historial: fecha, serie, temporada y capítulo, aunque lleven dos puntos', () => {
  const rows = [
    ['21/10/26', '/title/80229873', 'Serie con: dos puntos: Temporada 4: "Capítulo ocho: Papá"'],
    ['20/10/26', '/title/123', 'Una película'],
  ].map(([d, href, t]) => ({ querySelector: q => (q === '.date' ? { textContent: d } : { textContent: t, getAttribute: () => href }) }));
  global.document = { querySelectorAll: () => rows };
  try {
    assert.deepEqual(W.pgHistory(), [
      { date: '21/10/26', id: 80229873, title: 'Serie con: dos puntos', season: 'Temporada 4', episode: 'Capítulo ocho: Papá' },
      { date: '20/10/26', id: 123, title: 'Una película', season: null, episode: null },
    ]);
  } finally { delete global.document; }
  assert.equal(W.isoDate('21/10/26'), '2026-10-21');
  assert.equal(W.isoDate('3/1/2027'), '2027-01-03');
  assert.equal(W.isoDate('ayer'), null);
});

/** Netflix y Chrome de mentira para el orquestador */
function rig({ active = false, tabGuid = null, alive = false, read, last = null, now } = {}) {
  const seen = [];
  const netflix = {
    isActive: () => active,
    profileInfo: () => ({ name: 'Alfonso', guid: 'GA', alive: alive || !!tabGuid, tabGuid }),
    learn: () => {},
    play: async m => { seen.push(m); return { ok: 1, title: m.title, id: m.id || 'buscado', playing: true }; },
    last: () => last,
  };
  const cdp = { ready: true, bgTab: async () => { seen.push('bgTab'); return { close: async () => seen.push('close') }; } };
  const store = memStore();
  const changed = [];
  const w = W.createWatch({ cdp, netflix, store, self: 'http://127.0.0.1:8787', onChange: () => changed.push(1), ...(now ? { now } : {}), read: read || (async (tab, o) => { seen.push('read:' + o.guid + ':' + o.canSwitch); return { profile: 'GA', items: ITEMS, history: HISTORY, warn: [] }; }) });
  return { w, seen, store, changed };
}

test('lectura: en una pestaña de fondo, guarda, avisa al reposo y la cierra siempre', async () => {
  const { w, seen, store, changed } = rig();
  const r = await w.refresh();
  assert.equal(r.ok, 1); assert.equal(r.items, 2); assert.equal(r.history, 3);
  assert.deepEqual(seen, ['bgTab', 'read:GA:true', 'close']);
  assert.equal(store.get().items.length, 2);
  assert.equal(changed.length, 1);
  // si el lector falla, la pestaña se cierra igual y no se pierde lo que había
  const bad = rig({ read: async () => { throw new Error('la web de Netflix ha cambiado'); } });
  assert.match((await bad.w.refresh()).error, /ha cambiado/);
  assert.deepEqual(bad.seen, ['bgTab', 'close']);
});

test('lectura: no con Netflix delante ni con su pestaña en otro perfil; dos a la vez son una', async () => {
  assert.match((await rig({ active: true }).w.refresh()).skipped, /delante/);
  assert.match((await rig({ tabGuid: 'GC' }).w.refresh()).skipped, /otro perfil/);
  // con la pestaña de Netflix viva (en el perfil bueno, o adoptada tras reiniciar sin saber cuál) no se cambia de perfil
  for (const o of [{ tabGuid: 'GA' }, { alive: true }]) {
    const r = rig(o);
    await r.w.refresh();
    assert.ok(r.seen.includes('read:GA:false'), JSON.stringify(o) + ' ' + r.seen.join(','));
  }
  const { w, seen } = rig({ tabGuid: 'GA' });
  const [a, b] = await Promise.all([w.refresh(), w.refresh()]);
  assert.equal(a, b);
  assert.equal(seen.filter(x => x === 'bgTab').length, 1);
});

test('reposo: solo imágenes de Netflix y siempre por nuestra ruta', async () => {
  const { w } = rig();
  await w.refresh();
  const [a, b] = w.forIdle();
  assert.equal(a.story, '/idle/nfx?u=' + encodeURIComponent(IMG('a1')));
  assert.equal(a.ep.still, '/idle/nfx?u=' + encodeURIComponent(IMG('s1')));
  assert.equal(b.story, null, 'una dirección que no es de Netflix no pasa');
  assert.equal(b.ep, null);
  const sent = [];
  const send = (res, code, body) => sent.push(code);
  await w.serveImg({}, {}, new URL('http://x/idle/nfx?u=' + encodeURIComponent('https://evil.example/x.webp')), send);
  assert.deepEqual(sent, [400]);
});

test('agente: qué tengo a medias, qué he visto y «ponme la de ayer»', async () => {
  const { w, seen } = rig();
  await w.refresh();
  const wa = w.watching();
  assert.deepEqual(wa.items[0], { title: 'La serie de prueba', id: 1001, kind: 'show', where: 'T2 E4 «Capítulo: con dos puntos»', progress: '25 %', left: 'quedan 30 min' });
  assert.equal(wa.items[1].left, 'sin empezar (1 h 30 min)');
  const h = w.history();
  assert.deepEqual(h.days.map(d => d.day), ['2026-10-20', '2026-10-18']);
  assert.deepEqual(h.often[0], { title: 'La serie de prueba', episodes: 2 });
  const r = await w.playLast();
  assert.deepEqual(seen.pop(), { id: '1001', title: 'La serie de prueba' }, 'la serie de «seguir viendo»: retoma por donde iba');
  assert.equal(r.last, 'La serie de prueba');
  assert.match((await rig().w.playLast()).error, /historial/, 'sin historial (aún sin leer), lo dice');
});

test('«la última que puse»: lo que se puso en esta tele manda sobre el orden del historial de ese día', async () => {
  const day = new Date('2026-10-20T22:00:00').getTime();
  // se puso la película en la tele después de la serie: el historial de ese día las trae en cualquier orden
  const a = rig({ last: { at: day, id: '1002', title: 'Una película' } });
  await a.w.refresh();
  await a.w.playLast();
  assert.deepEqual(a.seen.pop(), { id: '1002', title: 'Una película' });
  // solo se sabe el capítulo que se estaba viendo (al salir de Netflix): se busca su serie en «seguir viendo»
  const b = rig({ last: { at: day, vid: 2001 } });
  await b.w.refresh();
  await b.w.playLast();
  assert.deepEqual(b.seen.pop(), { id: '1001', title: 'La serie de prueba' });
  // si es de antes del último día del historial, manda el historial
  const c = rig({ last: { at: new Date('2026-10-10T22:00:00').getTime(), id: '1002', title: 'Una película' } });
  await c.w.refresh();
  await c.w.playLast();
  assert.deepEqual(c.seen.pop(), { id: '1001', title: 'La serie de prueba' });
});

test('reposo: si el lector lleva más de 48 h sin leer, no se enseñan progresos viejos', async () => {
  let t = 1e12;
  const { w } = rig({ now: () => t });
  await w.refresh();
  assert.equal(w.forIdle().length, 2);
  t += 49 * 3600e3;
  assert.deepEqual(w.forIdle(), []);
});

test('órdenes: «seguir viendo» e historial no son para invitados', async () => {
  const nf = createNetflix({ cdp: { call: async () => ({}), pages: new Map(), targetId: null, show: async () => {}, newTab: async () => 'X' }, cfg: {}, store: memStore() });
  const { w } = rig();
  nf.extend(w.ops);
  const P = { guest: { web: true }, member: { web: true } };
  const cmds = createCommands({ permsOf: dev => P[dev.role] });
  cmds.register(nf.commands);
  const guest = { role: 'guest' }, member = { role: 'member' };
  for (const op of ['watching', 'history', 'play_last', 'refresh']) assert.match((await cmds.dispatch({ t: 'netflix', op }, { dev: guest })).error, /privado/, op);
  assert.ok((await cmds.dispatch({ t: 'netflix', op: 'watching' }, { dev: member })).items);
});

test('tarjetas para la conversación: la lista de lo que se ve y la del título que se va a poner, con direcciones enteras', async () => {
  const { w } = rig();
  assert.equal(w.media('list'), null, 'sin datos, nada');
  await w.refresh();
  const L = w.media('list');
  assert.equal(L.kind, 'list');
  assert.deepEqual(L.items[0], { title: 'La serie de prueba', sub: 'T2 · E4 · Capítulo: con dos puntos', left: 'quedan 30 min', frac: 0.25,
    img: 'http://127.0.0.1:8787/idle/nfx?u=' + encodeURIComponent(IMG('c1')) });
  assert.equal(L.items[1].sub, 'Película');
  const P = w.media('play', { title: 'la serie de prueba' });
  assert.equal(P.items[0].img, 'http://127.0.0.1:8787/idle/nfx?u=' + encodeURIComponent(IMG('a1')), 'la imagen de ambiente');
  assert.equal(P.items[0].still, 'http://127.0.0.1:8787/idle/nfx?u=' + encodeURIComponent(IMG('s1')), 'y el fotograma del capítulo');
  assert.equal(w.media('play', { id: 2001 }).key, 'nfx-play-1001', 'también por el id del capítulo');
  assert.equal(w.media('play', { title: 'otra cosa' }), null, 'lo que no está en «seguir viendo», sin tarjeta');
});
