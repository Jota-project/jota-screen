'use strict';
// @ts-check
// Capacidad «YouTube»: poner un vídeo de una vez. La búsqueda se lee en una pestaña de fondo (cdp.bgTab), mientras la
// tele sigue en lo que estaba (el reposo): así la conversación enseña la tarjeta del vídeo con su miniatura antes de irse
// (en una web ajena la tarjeta va sin imágenes y en la píldora no cabe). Luego la pestaña de siempre va a /watch?v=<id>
// (por control.nav: si Netflix está delante, se queda detrás) y se espera a que suene, a pantalla completa.
// De la búsqueda vale el primer vídeo de verdad: de ytInitialData (está ~1 s antes que el DOM), solo videoRenderer (ni
// anuncios, ni estanterías de Shorts, ni listas); si la web cambia, el DOM (ytd-video-renderer a#video-title).

const ORIGIN = 'https://www.youtube.com';
const ID_RE = /^[\w-]{11}$/;
/** @param {string} u */
const isYoutube = u => { try { return /(^|\.)youtube\.com$/.test(new URL(u).hostname); } catch { return false; } };

// ───────── lo que se evalúa en la página de búsqueda (pestaña de fondo): [{ id, title, channel, len, live }]
function pgResults() {
  const out = [];
  /** @param {any} r */
  const text = r => (r ? r.simpleText || (r.runs || []).map(x => x.text).join('') : '');
  const add = v => { if (v.id && /^[\w-]{11}$/.test(v.id) && !out.some(x => x.id === v.id)) out.push(v); };
  try {
    const secs = /** @type {any} */ (window).ytInitialData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
    for (const s of secs) {
      for (const c of (s.itemSectionRenderer && s.itemSectionRenderer.contents) || []) {
        const v = c.videoRenderer;
        if (!v) continue;                                                   // anuncios, Shorts, listas, canales
        const url = (((v.navigationEndpoint || {}).commandMetadata || {}).webCommandMetadata || {}).url || '';
        if (/^\/shorts\//.test(url)) continue;
        const live = (v.badges || []).some(b => /LIVE/.test(JSON.stringify(b))) || !v.lengthText;
        add({ id: v.videoId, title: text(v.title), channel: text(v.ownerText || v.longBylineText), len: text(v.lengthText), live });
      }
    }
  } catch {}
  if (!out.length) {
    for (const a of document.querySelectorAll('ytd-video-renderer a#video-title[href*="/watch?v="]')) {
      const id = new URL(/** @type {HTMLAnchorElement} */ (a).href).searchParams.get('v') || '';
      add({ id, title: (a.getAttribute('title') || a.textContent || '').trim(), channel: '', len: '', live: false });
    }
  }
  return out.slice(0, 8);
}

// estado del vídeo en la pestaña de siempre: 2 = suena, 1 = hay reproductor (si está listo y en pausa, se le da a play),
// 0 = aún no (u otro vídeo). ad: delante va un anuncio. fs: ya a pantalla completa
/** @param {string} id */
const PLAYING = id => `(()=>{if(new URLSearchParams(location.search).get('v')!==${JSON.stringify(id)})return {st:0};const p=document.getElementById('movie_player'),v=p&&p.querySelector('video');if(!v)return {st:0};const o={ad:p.classList.contains('ad-showing'),fs:!!document.fullscreenElement};try{const d=p.getVideoData();if(!o.ad&&d&&d.video_id===${JSON.stringify(id)})o.title=d.title}catch{}if(v.currentTime>0&&!v.paused)return {...o,st:2};if(v.paused&&v.readyState>=3)v.play().catch(()=>{});return {...o,st:1}})()`;

/** Miniatura de un vídeo: la grande (16:9, sin bandas) y, si no la hay, la mediana. @param {string} id */
const thumbs = id => [`https://i.ytimg.com/vi/${id}/hq720.jpg`, `https://i.ytimg.com/vi/${id}/mqdefault.jpg`];

/**
 * @param {{
 *   cdp: { call: Function, bgTab: () => Promise<any> },
 *   nav: (url: string) => Promise<any>,
 *   key?: (k: string) => any,
 *   self?: string,
 *   log?: (s: string) => void,
 *   wait?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   get?: typeof fetch,
 *   beforePlay?: (card: any) => any,
 * }} deps   nav: control.nav (la pestaña de siempre; deja Netflix detrás). key: una tecla en la pestaña activa (la «f» de
 *   pantalla completa). self: origen del servidor, para las imágenes de la tarjeta. beforePlay: va a ponerse el vídeo,
 *   antes de navegar (la conversación enseña su tarjeta y su ▶); se espera a que acabe
 */
module.exports = function createYoutube({ cdp, nav, key = () => {}, self = '', log = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, get = fetch, beforePlay = () => {} }) {
  /** @param {string} expression */
  const ev = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  /** @param {string} expr @param {(v: any) => boolean} ok @param {number} ms */
  async function until(expr, ok, ms) {
    const t0 = now();
    for (;;) {
      let v; try { v = await ev(expr); } catch {}
      if (ok(v) || now() - t0 > ms) return v;
      await wait(100);
    }
  }

  /** Los primeros vídeos de una búsqueda, leídos en una pestaña de fondo (no se ve ni suena). @param {string} q */
  async function results(q) {
    const tab = await cdp.bgTab();
    try {
      await tab.go(ORIGIN + '/results?search_query=' + encodeURIComponent(q));
      const r = await tab.until(pgResults, (/** @type {any} */ v) => Array.isArray(v) && v.length > 0, 8000);
      return Array.isArray(r) ? r : [];
    } finally { await tab.close(); }
  }

  // ───────── miniaturas para la tarjeta de la conversación (se piden por id: nunca una URL de fuera)
  const cache = new Map();
  /** @param {string} id @returns {Promise<{ buf: Buffer, type: string } | null>} */
  async function thumb(id) {
    if (!ID_RE.test(id)) return null;
    let b = cache.get(id);
    if (b) return b;
    for (const u of thumbs(id)) {
      try {
        const r = await get(u, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        b = { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
        cache.set(id, b); if (cache.size > 40) cache.delete(cache.keys().next().value);
        return b;
      } catch {}
    }
    return null;
  }
  const { send, isLocalTV } = require('../transport/http-util');
  /** @type {any[]} */
  const routes = [{ path: '/yt/img', async run(/** @type {any} */ req, /** @type {any} */ res, /** @type {{ url: URL }} */ { url }) {
    if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
    const b = await thumb(url.searchParams.get('id') || '');
    return b ? send(res, 200, b.buf, { 'Content-Type': b.type, 'Cache-Control': 'public, max-age=86400' }) : send(res, 404, '');
  } }];

  /** Tarjeta para la conversación (talk-view.js: media). @param {{ id: string, title: string, channel?: string, len?: string, live?: boolean }} v */
  const card = v => ({ key: 'yt-play-' + v.id, kind: 'play', items: [{
    title: v.title || 'YouTube', sub: [v.channel, v.live ? 'En directo' : v.len].filter(Boolean).join(' · ') || 'YouTube',
    left: '', frac: 0, img: self ? `${self}/yt/img?id=${v.id}` : '',
  }] });

  async function search(m) {
    const q = String(m.query || '').trim().slice(0, 150);
    if (!q) return { error: 'falta qué buscar' };
    try { return { ok: 1, query: q, results: await results(q) }; } catch (e) { return { error: 'YouTube no responde: ' + e.message }; }
  }

  /** «Pon en YouTube X»: busca, elige el primer vídeo de verdad, lo pone a pantalla completa y espera a que suene. */
  async function play(m) {
    const t0 = now();
    const q = String(m.query || '').trim().slice(0, 150);
    const id = m.id === undefined ? '' : String(m.id).trim();
    if (id && !ID_RE.test(id)) return { error: 'id no válido' };
    if (!q && !id) return { error: 'falta qué buscar' };
    /** @type {{ id: string, title: string, channel?: string, len?: string, live?: boolean }} */
    let pick = { id, title: String(m.title || '').slice(0, 200) };
    let candidates = [];
    if (!id) {
      try { candidates = await results(q); } catch (e) { return { error: 'YouTube no responde: ' + e.message }; }
      if (!candidates.length) return { error: `No encuentro «${q}» en YouTube` };
      pick = candidates[0];
    }
    thumb(pick.id).catch(() => {});        // que la miniatura ya esté cuando la tarjeta la pida
    try { await beforePlay(card(pick)); } catch (e) { log('youtube: ' + e.message); }
    const r = await nav(`${ORIGIN}/watch?v=${pick.id}`);
    if (r && r.error) return r;
    let st = await until(PLAYING(pick.id), v => v && v.st === 2, 12000);
    const playing = !!st && st.st === 2;
    // pantalla completa: la «f» del reproductor, cuando ya suena (antes la web aún no la atiende); si no entra, otra vez
    for (let i = 0; playing && i < 2 && !(st && st.fs); i++) {
      key('f');
      st = { ...st, ...(await until(PLAYING(pick.id), v => v && v.fs, 1500)) };
    }
    log(`youtube: «${q || pick.id}» → ${pick.id} «${pick.title}» ${playing ? 'suena' : 'no arranca'}${st && st.ad ? ' (anuncio)' : ''}, ${now() - t0} ms`);
    return {
      ok: 1, id: pick.id, title: (st && st.title) || pick.title, playing, ...(st && st.ad ? { ad: true } : {}), ms: now() - t0,
      ...(candidates.length > 1 ? { candidates: candidates.slice(1, 5).map(c => ({ id: c.id, title: c.title, channel: c.channel })) } : {}),
    };
  }

  /** @param {any} m */
  function run(m) {
    switch (m.op) {
      case 'play': return play(m);
      case 'search': return search(m);
      default: return { error: 'op debe ser play o search' };
    }
  }

  return {
    isYoutube, play, search, run, routes, thumb,
    /** @type {import('../transport/commands').Command[]} */
    commands: [{ t: 'youtube', perm: (m, P) => (P.web ? null : 'Abrir webs no está permitido'), run: m => run(m) }],
  };
};

module.exports.isYoutube = isYoutube;
module.exports.pgResults = pgResults;
