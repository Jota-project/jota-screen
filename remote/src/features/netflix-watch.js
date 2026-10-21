'use strict';
// @ts-check
// Lector de «Seguir viendo» y del historial de Netflix. Todo lo que toca la web de Netflix por dentro está aquí: si
// Netflix cambia su web, esto es lo que se rompe (y avisa en el registro), no el resto.
//   · «Seguir viendo»: la fila del inicio, leída con el cliente GraphQL (Apollo) de la propia web, en alta resolución.
//   · Imágenes: tarjeta con el logo (665×375), ambiente sin texto (StoryArt 848×477) y fotograma del episodio (342×192).
//   · Historial: la página «Actividad» (fecha, serie, temporada y capítulo).
// Se ejecuta en una pestaña oculta y temporal (cdp.bgTab), nunca en la que se ve. Solo lectura y solo el perfil activo.
// Las funciones pg* se ejecutan dentro de la página: se serializan con toString, así que no pueden usar nada de fuera.

/* eslint-disable no-undef */

/** Perfil activo y perfiles de la cuenta (caché de la propia web). */
function pgProfile() {
  const o = { u: location.href, gate: !!document.querySelector('[data-uia="profile-gate-screen"]'), login: /^\/(login|signup)/i.test(location.pathname), cur: null, ps: {} };
  try {
    const c = /** @type {any} */ (window).netflix.falcorCache;
    o.cur = c.profilesList.current.value[1];
    for (const [g, p] of Object.entries(c.profiles)) { const n = p && p.summary && p.summary.value && p.summary.value.profileName; if (n) o.ps[n] = g; }
  } catch {}
  return o;
}

/** ¿Está ya el cliente GraphQL con la consulta del inicio? (la web tarda un poco en montarlo) */
function pgReady() {
  /** @type {any} */ const w = window;
  if (!w.__tvApollo) {
    const root = document.getElementById('appMountPoint') || document.body.firstElementChild;
    if (!root) return false;
    const k = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
    if (!k) return false;
    const st = [/** @type {any} */ (root)[k]], seen = new Set();
    while (st.length) {
      const x = st.pop();
      if (!x || seen.has(x)) continue;
      seen.add(x);
      const p = x.memoizedProps;
      if (p && p.client && p.client.cache && p.client.cache.extract) { w.__tvApollo = p.client; break; }
      if (x.child) st.push(x.child);
      if (x.sibling) st.push(x.sibling);
    }
    if (!w.__tvApollo) return false;
  }
  return [...w.__tvApollo.getObservableQueries('all').values()].some(q => q.queryName === 'GetBrowsePage');
}

/** «Seguir viendo» en el orden de la fila, con lo necesario para enseñarlo y ponerlo. */
async function pgContinue() {
  /** @type {any} */ const w = window;
  const c = w.__tvApollo;
  const q = [...c.getObservableQueries('all').values()].find(q => q.queryName === 'GetBrowsePage');
  const r = await c.query({ query: q.options.query, variables: { ...q.options.variables, fetchHighResCards: true }, fetchPolicy: 'network-only' });
  const d = c.cache.extract();
  const g = x => (x && x.__ref ? d[x.__ref] : x);
  const imgs = o => { const out = []; const walk = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (typeof x.url === 'string' && x.width) out.push(x); for (const k in x) walk(x[k]); }; walk(o); return out; };
  const treat = []; const seen = new Set();
  const walk = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (x.__typename === 'PinotContinueWatchingEntityTreatment' && !seen.has(x.id)) { seen.add(x.id); treat.push(x); return; } for (const k in x) walk(x[k]); };
  walk(r.data);
  return treat.map(t => {
    const ue = t.unifiedEntity || {};
    const e = d[(ue.__typename || '') + ':' + JSON.stringify({ videoId: ue.videoId })] || g(ue) || ue;
    const show = e.__typename === 'Show';
    const cur = show ? g(e.currentEpisode) || {} : e;
    const se = show ? g(cur.parentSeason) || {} : {};
    const card = imgs(t).filter(i => i.width <= 700).sort((a, b) => b.width - a.width)[0];
    return {
      id: e.videoId, kind: show ? 'show' : 'movie', title: t.displayString || e.title || '',
      ep: show && cur.videoId ? { id: cur.videoId, s: se.seasonSeq || se.number || null, seasonId: se.videoId || null, e: cur.number || null, title: cur.title || '' } : null,
      pos: (cur.bookmark && cur.bookmark.position) || 0, dur: cur.runtimeSec || cur.displayRuntimeSec || 0, status: cur.watchStatus || '',
      card: card ? card.url : null,
    };
  });
}

/** Imágenes grandes de cada título: ambiente (StoryArt) y fotograma del episodio. Consultas persistidas de la web. */
async function pgArt(items) {
  const js = performance.getEntriesByType('resource').map(e => e.name).find(u => /akiraClient.*\.js/.test(u));
  const src = js ? await (await fetch(js)).text() : '';
  const qid = name => { const m = src.match(new RegExp('\\.' + name + 'Document=\\{__meta__:\\{q:"([0-9a-f-]{36})"')); return m ? m[1] : null; };
  const gql = async (op, id, variables) => {
    if (!id) return null;
    const r = await fetch('/graphql', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: op, variables, extensions: { persistedQuery: { id, version: 102 } } }) });
    return r.ok ? r.json() : null;
  };
  const imgs = o => { const out = []; const walk = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (typeof x.url === 'string' && x.width) out.push(x); for (const k in x) walk(x[k]); }; walk(o); return out; };
  const qArt = qid('VideoDetailModalCachedArtworkQuery'), qEps = qid('PreviewModalEpisodeSelectorSeasonEpisodes');
  await Promise.all(items.map(async it => {
    try {
      const a = await gql('VideoDetailModalCachedArtworkQuery', qArt, { unifiedEntityId: 'Video:' + it.id });
      const story = imgs(a && a.data).filter(i => /^StoryArt/i.test(i.key || '')).sort((x, y) => y.width - x.width)[0];
      if (story) it.story = story.url;
    } catch {}
    if (!it.ep || !it.ep.seasonId) return;
    try {
      const r = await gql('PreviewModalEpisodeSelectorSeasonEpisodes', qEps, { seasonId: it.ep.seasonId, count: 80, playbackRedirectEnabled: false });
      /** @type {any} */ let node = null;
      const walk = x => { if (!x || typeof x !== 'object' || node) return; if (Array.isArray(x)) return x.forEach(walk); if (x.__typename === 'Episode' && x.videoId === it.ep.id) { node = x; return; } for (const k in x) walk(x[k]); };
      walk(r && r.data);
      if (node) { const s = imgs(node.artwork ? { a: node.artwork } : node).sort((x, y) => y.width - x.width)[0]; if (s) it.ep.still = s.url; if (!it.dur && node.displayRuntimeSec) it.dur = node.displayRuntimeSec; }
    } catch {}
  }));
  return { items, ids: { art: !!qArt, eps: !!qEps } };
}

/** Historial de la página «Actividad»: fecha (dd/mm/aa), id del episodio o la película, serie, temporada y capítulo. */
function pgHistory() {
  return [...document.querySelectorAll('li.retableRow')].map(r => {
    const a = r.querySelector('.title a');
    const text = (a && a.textContent || '').trim();
    const id = Number(((a && a.getAttribute('href')) || '').match(/\/title\/(\d+)/)?.[1]) || null;
    const date = (r.querySelector('.date') || {}).textContent || '';
    const m = text.match(/^(.*): "(.*)"$/);               // «Serie: Temporada 4: "Capítulo: con dos puntos"»
    if (!m) return { date: date.trim(), id, title: text, season: null, episode: null };
    const head = m[1], cut = head.lastIndexOf(': ');
    return { date: date.trim(), id, title: cut > 0 ? head.slice(0, cut) : head, season: cut > 0 ? head.slice(cut + 2) : null, episode: m[2] };
  }).filter(h => h.title);
}

/** dd/mm/aa → AAAA-MM-DD @param {string} s */
function isoDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const ORIGIN = 'https://www.netflix.com';
/** Para comparar nombres: sin tildes, mayúsculas ni signos. @param {any} s */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Lee todo en una pestaña de fondo. `tab`: { go(url), ev(fn, ...args), until(fn, ok, ms) } (ver cdp.bgTab).
 * @param {any} tab
 * @param {{ name?: string, guid?: string | null, learn?: (ps: Record<string, string>) => void, canSwitch?: boolean }} o
 *   name/guid: perfil que se lee (el de por defecto). canSwitch: si se puede cambiar de perfil (la cookie es de todo
 *   Chrome: no se cambia si la pestaña de Netflix vive en otro perfil).
 */
async function readAll(tab, { name = '', guid = null, learn = () => {}, canSwitch = true }) {
  const ok = v => v && (v.login || v.gate || !!v.cur);
  await tab.go(ORIGIN + (guid && canSwitch ? '/SwitchProfile?tkn=' + guid : '/browse'));
  let p = await tab.until(pgProfile, ok, 12000);
  if (!ok(p)) throw new Error('Netflix no responde');
  if (p.login) throw new Error('Netflix pide iniciar sesión');
  if (p.ps && Object.keys(p.ps).length) {
    learn(p.ps);
    if (!guid && name) { const k = Object.keys(p.ps).find(n => norm(n) === norm(name)); guid = k ? p.ps[k] : null; }
  }
  if (guid && (p.gate || p.cur !== guid)) {
    if (!canSwitch) throw new Error('Netflix está en otro perfil');
    await tab.go(ORIGIN + '/SwitchProfile?tkn=' + guid);
    p = await tab.until(pgProfile, v => ok(v) && v.cur === guid && !v.gate, 12000);
    if (!p || p.cur !== guid || p.gate) throw new Error('no se pudo entrar en el perfil ' + name);
  }
  if (p.gate) throw new Error('Netflix pregunta el perfil y no hay ninguno elegido');
  if (!(await tab.until(pgReady, v => v === true, 15000))) throw new Error('la web de Netflix ha cambiado: no encuentro su cliente GraphQL');
  const items = await tab.ev(pgContinue);
  const art = await tab.ev(pgArt, items);
  await tab.go(ORIGIN + '/viewingactivity');
  const raw = await tab.until(pgHistory, v => Array.isArray(v) && v.length > 0, 10000);
  const history = (raw || []).map(h => ({ ...h, day: isoDate(h.date) }));
  return { profile: p.cur, items: art.items, history, warn: [...(art.ids.art ? [] : ['sin consulta de ambiente']), ...(art.ids.eps ? [] : ['sin consulta de episodios']), ...(raw && raw.length ? [] : ['sin historial'])] };
}

// ───────── orquestación: cuándo se lee, qué se guarda y qué se da al reposo y al agente

const NFX_IMG = /^https:\/\/occ-[\w-]+\.1\.nflxso\.net\/dnm\/api\/v6\/[\w/-]+\.(webp|jpg|png)(\?r=\w+)?$/; // imágenes de Netflix (y nada más)
const fmtMin = sec => { const m = Math.max(1, Math.round(sec / 60)); return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min'; };

/**
 * @param {{
 *   cdp: { ready: boolean, bgTab: () => Promise<any> },
 *   netflix: { isActive: () => boolean, profileInfo: () => { name: string, guid: string | null, tabGuid: string | null }, learn: (ps: Record<string, string>) => void, play: (m: any) => Promise<any>, last?: () => any },
 *   store: { load: () => any, save: (v: any) => void },
 *   log?: (s: string) => void, onChange?: () => void, now?: () => number, read?: typeof readAll, fetch?: typeof fetch,
 * }} deps   read: el lector (para las pruebas)
 */
function createWatch({ cdp, netflix, store, log = () => {}, onChange = () => {}, now = Date.now, read = readAll, fetch: get = fetch }) {
  /** @type {{ at: number, profile: string | null, items: any[], history: any[] }} */
  let data = { at: 0, profile: null, items: [], history: [], ...(store.load() || {}) };
  /** @type {Promise<any> | null} */ let busy = null;
  let soonT = null;

  /** Leer ahora (una sola lectura a la vez; si ya hay una, se espera a esa). */
  function refresh(why = '') {
    if (busy) return busy;
    busy = (async () => {
      if (!cdp.ready) return { error: 'la tele no está conectada' };
      if (netflix.isActive()) return { skipped: 'Netflix está delante' };        // ni con algo sonando ni a medias
      const w = netflix.profileInfo();
      const canSwitch = !(w.tabGuid && w.guid && w.tabGuid !== w.guid);
      if (!canSwitch) return { skipped: 'Netflix está en otro perfil' };
      const t0 = now();
      const tab = await cdp.bgTab();
      try {
        const r = await read(tab, { name: w.name, guid: w.guid, learn: netflix.learn, canSwitch });
        data = { at: now(), profile: w.name || null, items: r.items, history: r.history };
        store.save(data);
        log(`netflix: «Seguir viendo» leído${why ? ' (' + why + ')' : ''}: ${r.items.length} títulos, ${r.history.length} del historial, ${now() - t0} ms` + (r.warn.length ? ' · ' + r.warn.join(', ') : ''));
        onChange();
        return { ok: 1, items: r.items.length, history: r.history.length, ms: now() - t0, warn: r.warn };
      } finally { await tab.close(); }
    })().catch(e => { log('netflix: no he podido leer «Seguir viendo»: ' + e.message); return { error: e.message }; })
      .finally(() => { busy = null; });
    return busy;
  }
  /** Leer dentro de un rato (p. ej. al salir de Netflix: lo visto ya está en su historial). */
  function soon(ms = 120e3) { clearTimeout(soonT); soonT = setTimeout(() => refresh('tras ver Netflix'), ms); soonT.unref?.(); }
  function start({ firstMs = 60e3, everyMs = 3 * 3600e3 } = {}) {
    setTimeout(() => refresh('al arrancar'), firstMs).unref?.();
    setInterval(() => { if (now() - data.at > everyMs * .9) refresh('periódica'); }, everyMs).unref?.();
  }

  // ───────── para el reposo: lo justo, con las imágenes por nuestra ruta (la tele no habla con Netflix desde ahí)
  const img = u => (u && NFX_IMG.test(u) ? '/idle/nfx?u=' + encodeURIComponent(u) : null);
  function forIdle() {
    if (now() - data.at > 48 * 3600e3) return [];        // si el lector lleva días sin leer, mejor nada que progresos viejos
    return data.items.map(it => ({
      id: it.id, kind: it.kind, title: it.title, pos: it.pos, dur: it.dur,
      ep: it.ep ? { s: it.ep.s, e: it.ep.e, title: it.ep.title, still: img(it.ep.still) } : null,
      card: img(it.card), story: img(it.story),
    }));
  }

  // ───────── para el agente
  const epTxt = it => (it.ep ? `T${it.ep.s || '?'} E${it.ep.e || '?'}${it.ep.title ? ' «' + it.ep.title + '»' : ''}` : 'película');
  function watching() {
    return {
      at: data.at ? new Date(data.at).toISOString() : null, profile: data.profile,
      items: data.items.map(it => ({
        title: it.title, id: it.id, kind: it.kind, where: epTxt(it),
        progress: it.dur ? Math.round(100 * it.pos / it.dur) + ' %' : null,
        left: it.dur && it.pos >= 30 ? 'quedan ' + fmtMin(it.dur - it.pos) : it.dur ? 'sin empezar (' + fmtMin(it.dur) + ')' : null,
      })),
    };
  }
  /** Lo visto por días y por serie (lo más reciente primero). */
  function history() {
    const days = [];
    for (const h of data.history) {
      let d = days.find(x => x.day === h.day);
      if (!d) days.push(d = { day: h.day, seen: [] });
      d.seen.push(h.season ? `${h.title} · ${h.season} · «${h.episode}»` : h.title);
    }
    const count = {};
    for (const h of data.history) count[h.title] = (count[h.title] || 0) + 1;
    const often = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, n]) => ({ title, episodes: n }));
    return { at: data.at ? new Date(data.at).toISOString() : null, profile: data.profile, days, often };
  }
  /**
   * «Ponme la de ayer»: lo último que se vio; si está en «Seguir viendo», se retoma por donde iba. Lo que se puso en esta
   * tele (netflix.last) manda si es de ese día o posterior: dentro de un mismo día, el orden del historial no es fiable.
   */
  async function playLast() {
    const h0 = data.history[0];
    const L = netflix.last ? netflix.last() : null;
    /** @type {{ id?: string, title: string } | null} */ let target = null;
    if (L && (!h0 || !h0.day || L.at >= new Date(h0.day + 'T00:00:00').getTime())) {
      if (L.id) target = { id: String(L.id), title: L.title || '' };
      else if (L.vid) {
        const it = data.items.find(i => i.id === L.vid || (i.ep && i.ep.id === L.vid));
        const h = data.history.find(x => x.id === L.vid);
        if (it) target = { id: String(it.id), title: it.title }; else if (h) target = { title: h.title };
      }
    }
    if (!target && h0) {
      const it = data.items.find(i => norm(i.title) === norm(h0.title));
      target = it ? { id: String(it.id), title: it.title } : { title: h0.title };
    }
    if (!target) return { error: 'no sé qué se vio por última vez (aún no hay historial)' };
    const r = await netflix.play(target);
    return r.error ? r : { ...r, last: target.title };
  }

  // ───────── imágenes para el reposo: solo de Netflix, solo desde la propia tele, con caché en memoria
  const cache = new Map();
  /** @param {any} req @param {any} res @param {URL} url @param {Function} send */
  async function serveImg(req, res, url, send) {
    const u = url.searchParams.get('u') || '';
    if (!NFX_IMG.test(u)) return send(res, 400, 'no');
    try {
      let b = cache.get(u);
      if (!b) {
        const r = await get(u, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return send(res, 502, '');
        b = { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/webp' };
        cache.set(u, b); if (cache.size > 60) cache.delete(cache.keys().next().value);
      }
      send(res, 200, b.buf, { 'Content-Type': b.type, 'Cache-Control': 'public, max-age=86400' });
    } catch { send(res, 502, ''); }
  }

  const { send, isLocalTV } = require('../transport/http-util');
  /** @type {any[]} */
  const routes = [{ path: '/idle/nfx', run(req, res, { url }) {
    if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
    return serveImg(req, res, url, send);
  } }];
  /** órdenes para `netflix` (src/features/netflix.js: extend) */
  const ops = { watching: () => watching(), history: () => history(), play_last: () => playLast(), refresh: () => refresh('a petición') };

  return { refresh, soon, start, forIdle, watching, history, playLast, serveImg, routes, ops, data: () => data };
}

module.exports = { readAll, createWatch, pgProfile, pgReady, pgContinue, pgArt, pgHistory, isoDate, NFX_IMG };
