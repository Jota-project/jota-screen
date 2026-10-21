'use strict';
// @ts-check
// Capacidad «Netflix»: abrir Netflix rápido y poner una serie de una vez. Netflix vive en su propia pestaña, que se
// queda cargada tras el primer uso: volver a abrirlo es traerla al frente (unos ms) en vez de cargar la web (~3 s).
// Dentro, todo se mueve sin recargar (history.pushState, como hace la propia web): buscar ~0,6 s, reproducir ~1,8 s.
// /watch/<id de la serie> retoma solo el capítulo y el minuto del perfil. Al salir de la pestaña, su vídeo se pausa y
// no puede volver a sonar (los avances del inicio) hasta que se vuelva a enseñar.
// Perfil: el elegido en el mando (netflix.json) o el de la config (TV_NETFLIX_PROFILE); una petición puede pedir otro.

const ORIGIN = 'https://www.netflix.com';
/** @param {string} u */
const isNetflix = u => { try { return /(^|\.)netflix\.com$/.test(new URL(u).hostname); } catch { return false; } };
/** Para comparar títulos: sin tildes, mayúsculas ni signos. @param {any} s */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ───────── lo que se evalúa en la página de Netflix
// estado: dirección, pantalla de perfiles o de entrar, perfil activo y perfiles de la cuenta (caché de la propia web).
// `old` marca el documento de antes de una recarga, para no leerlo como si fuera el nuevo.
const PROBE = `(()=>{const o={u:location.href,old:!!window.__tvOld,gate:!!document.querySelector('[data-uia="profile-gate-screen"]'),login:/^\\/(login|signup)/i.test(location.pathname)};try{const c=netflix.falcorCache;o.cur=c.profilesList.current.value[1];o.ps={};for(const [g,p] of Object.entries(c.profiles)){const n=p&&p.summary&&p.summary.value&&p.summary.value.profileName;if(n)o.ps[n]=g}}catch{}if(!o.ps||!Object.keys(o.ps).length){o.ps={};for(const t of document.querySelectorAll('[data-uia^="profile-selector+tile-"]')){const n=t.innerText.trim();if(n)o.ps[n]=t.dataset.uia.split('tile-')[1]}}return o})()`;
const MARK_OLD = 'window.__tvOld=1';
/** navegar dentro de la web sin recargar; 0 si no se puede (no es Netflix o la web aún no está) @param {string} p */
const GO = p => `(()=>{if(location.origin!==${JSON.stringify(ORIGIN)}||!window.netflix)return 0;history.pushState(history.state,'',${JSON.stringify(p)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}));return 1})()`;
/** resultados de la búsqueda q ya pintados: [{id, title}] @param {string} q */
const CARDS = q => `(()=>{const n=s=>String(s||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();const out=[];for(const a of document.querySelectorAll('a[data-uia="standard-card"][href*="jbv="]')){const u=new URL(a.getAttribute('href'),location.href);if(n(u.searchParams.get('q'))!==${JSON.stringify(norm(q))})continue;const id=u.searchParams.get('jbv');if(id&&!out.some(x=>x.id===id))out.push({id,title:a.getAttribute('aria-label')||''});if(out.length>=8)break}return out})()`;
// 2 = vídeo en marcha, 1 = hay vídeo (si está listo y en pausa, se le da a play), 0 = aún no hay vídeo
const PLAYING = `(()=>{const v=document.querySelector('video');if(!v)return 0;if(v.currentTime>0&&!v.paused)return 2;if(v.paused&&v.readyState>=3)v.play().catch(()=>{});return 1})()`;
// al dejarla en segundo plano: pausa lo que suene (con el reproductor de Netflix; si no, el <video>) y no deja que nada
// vuelva a sonar hasta que se enseñe otra vez
const HIDE = `(()=>{window.__tvHidden=true;if(!window.__tvGuard){window.__tvGuard=1;document.addEventListener('play',e=>{const m=e.target;if(window.__tvHidden&&m&&m.pause)m.pause()},true)}try{const vp=netflix.appContext.state.playerApp.getAPI().videoPlayer;for(const id of vp.getAllPlayerSessionIds())vp.getVideoPlayerBySessionId(id).pause()}catch{}for(const m of document.querySelectorAll('video,audio'))m.pause();return 1})()`;
const UNHIDE = 'window.__tvHidden=false';
/** órdenes que enseñan lo que ve el perfil: no para invitados */
const PRIVATE = new Set(['watching', 'history', 'play_last', 'refresh']);

/**
 * @typedef {{ profile?: string, profiles?: Record<string, string>, titles?: Record<string, { id: string, title: string }>,
 *   last?: { at: number, id?: string, title?: string, vid?: number } }} Data
 * @param {{
 *   cdp: { call: Function, show: (id: string) => Promise<void>, newTab: () => Promise<string>, pages: Map<string, { url: string }>, targetId: string | null },
 *   cfg: { NETFLIX_PROFILE?: string },
 *   store: { load: () => any, save: (v: any) => void },
 *   log?: (s: string) => void,
 *   wait?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   onLeave?: () => void,
 * }} deps   onLeave: Netflix ha pasado a segundo plano (src/features/netflix-watch.js vuelve a leer al rato)
 */
module.exports = function createNetflix({ cdp, cfg, store, log = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, onLeave = () => {} }) {
  /** @type {Data} */
  const data = { profiles: {}, titles: {}, ...(store.load() || {}) };
  const save = () => { try { store.save(data); } catch (e) { log('netflix: no se pudo guardar: ' + e.message); } };
  /** @type {string | null} */
  let tab = null;
  /** @type {string | null} perfil en el que está la pestaña de Netflix (la cookie de perfil es de todo Chrome) */
  let tabGuid = null;
  /** órdenes de más (las de «Seguir viendo», src/features/netflix-watch.js) */
  /** @type {Record<string, (m: any) => any>} */
  const extra = {};

  /** @param {string} expression */
  const ev = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  /** evalúa hasta que `ok` dé sí o pase `ms`; devuelve el último valor @param {string} expr @param {(v: any) => boolean} ok @param {number} ms */
  async function until(expr, ok, ms) {
    const t0 = now();
    for (;;) {
      let v; try { v = await ev(expr); } catch {}
      if (ok(v) || now() - t0 > ms) return v;
      await wait(80);
    }
  }

  /** La pestaña de Netflix, si sigue abierta (tras reiniciar el servidor se adopta la que haya). */
  function alive() {
    if (tab && cdp.pages.has(tab)) return tab;
    tab = null;
    for (const [id, t] of cdp.pages) if (isNetflix(t.url)) { tab = id; break; }
    return tab;
  }
  const isActive = () => !!alive() && cdp.targetId === tab;

  /** @param {Record<string, string> | undefined} ps */
  function learn(ps) {
    if (!ps || !Object.keys(ps).length || JSON.stringify(ps) === JSON.stringify(data.profiles)) return;
    data.profiles = ps; save();
  }
  /** @param {string | undefined} name */
  const guidOf = name => {
    const k = name && Object.keys(data.profiles || {}).find(n => norm(n) === norm(name));
    return k ? /** @type {Record<string, string>} */ (data.profiles)[k] : null;
  };
  /** @param {string | undefined} guid */
  const nameOf = guid => Object.keys(data.profiles || {}).find(n => /** @type {Record<string, string>} */ (data.profiles)[n] === guid) || null;
  const defaultProfile = () => (data.profile || cfg.NETFLIX_PROFILE || '').trim();

  /** Recarga entera de la pestaña de Netflix y espera a la página nueva. @param {string} url */
  async function load(url) {
    try { await ev(MARK_OLD); } catch {}
    await cdp.call('Page.navigate', { url });
    return until(PROBE, v => v && !v.old && (v.gate || v.login || !!v.cur), 10000);
  }
  /** Dentro de la web, sin recargar (si la web no está, recargando). @param {string} path */
  async function go(path) {
    let ok = 0; try { ok = await ev(GO(path)); } catch {}
    if (!ok) await load(ORIGIN + path);
  }

  /** Deja la pestaña de Netflix delante, con la web cargada y en el perfil pedido. */
  async function front(profile) {
    const want = (profile || defaultProfile()).trim();
    let p = null;
    if (alive()) {
      if (!isActive()) await cdp.show(/** @type {string} */ (tab));
      try { await ev(UNHIDE); p = await ev(PROBE); } catch {}
      if (!p || !isNetflix(p.u)) p = null;                       // congelada o fuera de Netflix: se recarga
    } else {
      tab = await cdp.newTab();
      log('netflix: pestaña nueva');
    }
    if (!p) { const g = guidOf(want); p = await load(g ? `${ORIGIN}/SwitchProfile?tkn=${g}` : ORIGIN + '/browse'); }
    if (!p) return { error: 'Netflix no responde' };
    if (p.login) return { error: 'Netflix pide iniciar sesión: hay que hacerlo a mano en la tele' };
    learn(p.ps);
    const g = guidOf(want);
    if (want && !g && Object.keys(data.profiles || {}).length) return { error: `No hay un perfil «${want}» en Netflix (hay: ${Object.keys(data.profiles || {}).join(', ')})` };
    if (g && (p.gate || p.cur !== g)) {
      p = await load(`${ORIGIN}/SwitchProfile?tkn=${g}`);
      if (!p || p.gate || p.cur !== g) return { error: 'No he podido entrar en el perfil ' + want };
    } else if (p.gate) return { error: 'Netflix pregunta el perfil y no hay ninguno elegido (TV_NETFLIX_PROFILE o Ajustes del mando)' };
    tabGuid = p.cur || null;
    return { ok: 1, p };
  }

  /** Abrir Netflix (opcionalmente en una dirección suya: búsqueda, ficha, reproducción). */
  async function open(m = {}) {
    const f = await front(m.profile);
    if (f.error) return f;
    if (m.url) {
      let path = '/';
      try { const u = new URL(m.url); path = u.pathname + u.search; } catch {}
      let here = ''; try { const u = new URL(f.p.u); here = u.pathname + u.search; } catch {}
      if (!/^\/(browse)?$/.test(path) && path !== here) await go(path);
    }
    return { ok: 1, profile: nameOf(f.p.cur) };
  }

  /** Buscar en la web ya cargada y leer los resultados. @param {string} q */
  async function results(q) {
    const path = '/search?q=' + encodeURIComponent(q);
    const got = v => Array.isArray(v) && v.length > 0;
    await go(path);
    let r = await until(CARDS(q), got, 3000);
    if (!got(r)) { await load(ORIGIN + path); r = await until(CARDS(q), got, 6000); } // a veces la web no repinta: plan B, recargar
    return got(r) ? r : [];
  }
  /** @param {string} q @param {{ id: string, title: string }[]} list */
  function best(q, list) {
    const k = norm(q);
    return list.find(c => norm(c.title) === k) || list.find(c => norm(c.title).startsWith(k)) || list[0];
  }

  async function search(m) {
    const q = String(m.query || m.title || '').trim().slice(0, 100);
    if (!q) return { error: 'falta qué buscar' };
    const f = await front(m.profile);
    if (f.error) return f;
    return { ok: 1, query: q, results: await results(q) };
  }

  /** «Ponme X»: abre Netflix, encuentra el título y lo pone (retoma por donde iba el perfil). */
  async function play(m) {
    const t0 = now();
    const title = String(m.title || '').trim().slice(0, 100);
    const id = m.id === undefined ? '' : String(m.id);
    if (id && !/^\d{4,12}$/.test(id)) return { error: 'id no válido' };
    if (!title && !id) return { error: 'falta el título' };
    const f = await front(m.profile);
    if (f.error) return f;
    /** @type {{ id: string, title: string } | undefined} */
    let pick;
    let candidates = [];
    if (id) pick = { id, title };
    else if (data.titles && data.titles[norm(title)]) pick = data.titles[norm(title)];
    else {
      candidates = await results(title);
      if (!candidates.length) return { error: `No encuentro «${title}» en Netflix` };
      pick = best(title, candidates);
      if (norm(pick.title) === norm(title)) { data.titles = { ...data.titles, [norm(title)]: pick }; save(); } // solo si es seguro
    }
    await go('/watch/' + pick.id);
    data.last = { at: now(), id: pick.id, title: pick.title }; save(); // «ponme la última que puse»
    let st = await until(PLAYING, v => v === 2, 6000);
    if (st !== 2) { await load(ORIGIN + '/watch/' + pick.id); st = await until(PLAYING, v => v === 2, 10000); } // plan B: recargar
    return {
      ok: 1, title: pick.title, id: pick.id, playing: st === 2, profile: nameOf(f.p.cur), ms: now() - t0,
      ...(candidates.length > 1 && norm(pick.title) !== norm(title) ? { candidates: candidates.slice(0, 5) } : {}),
    };
  }

  /**
   * Antes de navegar a otra web: si Netflix está delante, se pausa, se queda cargada detrás y vuelve delante la otra
   * pestaña (o una nueva si no hay). Así lo de siempre (reposo, escenario, webs) sigue en su pestaña.
   */
  async function leave() {
    if (!isActive()) return;
    try { await ev(HIDE); } catch {}
    // lo último que se estaba viendo (el id del capítulo de /watch/): para «ponme la última que puse»
    const vid = Number(((cdp.pages.get(/** @type {string} */ (tab)) || { url: '' }).url.match(/\/watch\/(\d+)/) || [])[1]) || null;
    if (vid) { const l = data.last; data.last = { ...(l && l.id && now() - l.at < 6 * 3600e3 ? l : {}), at: now(), vid }; save(); }
    const other = [...cdp.pages.keys()].find(k => k !== tab);
    if (other) await cdp.show(other); else await cdp.newTab();
    try { onLeave(); } catch {}
  }

  /** Para el lector de «Seguir viendo»: qué perfil leer y en cuál está la pestaña de Netflix (si vive). */
  function profileInfo() {
    const name = defaultProfile();
    return { name, guid: guidOf(name), tabGuid: alive() ? tabGuid : null };
  }

  function profiles() {
    return { profile: defaultProfile() || null, profiles: Object.keys(data.profiles || {}) };
  }
  /** Perfil por defecto (desde el mando). @param {string} name */
  function setProfile(name) {
    name = String(name || '').trim();
    const k = Object.keys(data.profiles || {}).find(n => norm(n) === norm(name));
    if (!k) return { error: 'perfil desconocido' };
    data.profile = k; save();
    return profiles();
  }

  /** @param {any} m */
  function run(m) {
    switch (m.op) {
      case 'open': return open({ profile: m.profile });
      case 'search': return search(m);
      case 'play': return play(m);
      case 'profiles': return profiles();
      case 'setprofile': return setProfile(m.profile);
      default: return extra[m.op] ? extra[m.op](m) : { error: 'op debe ser open, search, play, profiles, setprofile' + Object.keys(extra).map(k => ', ' + k).join('') };
    }
  }

  return {
    isNetflix, open, search, play, leave, profiles, setProfile, run, isActive, profileInfo, learn,
    /** lo último que se puso o se estaba viendo: { at, id?, title?, vid? } (vid: id del capítulo) */
    last: () => data.last || null,
    /** añade órdenes (op → función) @param {Record<string, (m: any) => any>} ops */
    extend: ops => Object.assign(extra, ops),
    /** @type {import('../transport/commands').Command[]} */
    commands: [{
      t: 'netflix',
      perm: (m, P, ctx) => {
        const guest = !!(ctx.dev && ctx.dev.role === 'guest');
        if (!P.web) return 'Abrir webs no está permitido';
        if (guest && (m.op === 'setprofile' || m.profile)) return 'Los invitados no pueden elegir el perfil';
        if (guest && PRIVATE.has(m.op)) return 'Lo que se ve en Netflix es privado';   // historial y «seguir viendo» del dueño
        return null;
      },
      run: m => run(m),
    }],
  };
};

module.exports.isNetflix = isNetflix;
module.exports.norm = norm;
