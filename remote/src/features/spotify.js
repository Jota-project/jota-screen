'use strict';
// @ts-check
// Capacidad «Spotify»: spotifyd («Salón») es el altavoz Spotify Connect de la tele y se maneja con la Web API de Spotify
// (app propia, PKCE). Aquí viven el token, el límite de peticiones (429, con la espera guardada), todas las acciones de
// la orden `spotify`, el «ahora suena» en vivo (nowplaying.js) para el mando y el reposo, y el retoque de la web de Spotify.
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { readJson, writeJson } = require('../core/json-store');
const { send, TYPES } = require('../transport/http-util');

/**
 * @param {{
 *   cdp: { call: Function, session: string | null },
 *   cfg: { FILES: { spotify: string }, SP_DEVICE: string, PUBLIC_URL: string, DEBUG: boolean, SPOTIFY_BANNER: boolean },
 *   log: { info: (...a: any[]) => void, error: (...a: any[]) => void },
 *   clients: () => Iterable<any>,              // sockets del mando (para «ahora suena» en vivo)
 *   idle: () => { watching: () => boolean, setMusic: Function },   // la pantalla en reposo se crea después
 * }} deps
 */
module.exports = function createSpotify({ cdp, cfg, log, clients, idle }) {
  const CFG = cfg;
  // Spotify: spotifyd ("Salón") es el dispositivo Spotify Connect; se controla con la API web de Spotify (app propia, PKCE).
  // Los tokens se guardan en ./spotify.json (0600). Conexión: abrir /spotify/login?t=TOKEN desde cualquier dispositivo de la red.
  const SP_FILE = CFG.FILES.spotify;
  const { SP_DEVICE, PUBLIC_URL, DEBUG } = CFG;
  const SP_SCOPE = 'user-read-playback-state user-modify-playback-state user-read-currently-playing ' +
    'user-read-recently-played playlist-read-private playlist-read-collaborative user-library-read user-library-modify';
  const spImg = (list, want) => { const s = [...(list || [])].sort((a, b) => (a.width || 0) - (b.width || 0)); return (s.find(i => (i.width || 0) >= want) || s[s.length - 1] || {}).url || null; };
  let spMeId = '';
  async function spMe() { if (!spMeId) spMeId = (await spApi('GET', '/me')).id; return spMeId; }
  const spHasScopes = () => !!sp.scope && SP_SCOPE.split(' ').every(x => sp.scope.split(' ').includes(x));
  let sp = readJson(SP_FILE, {}) || {};
  const spSave = () => writeJson(SP_FILE, sp);
  const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const spPending = new Map(); // state -> {verifier, ts}

  async function spToken(form) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: sp.clientId, ...form }), signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || 'token ' + r.status);
    sp.access = j.access_token; sp.expires = Date.now() + (j.expires_in - 60) * 1000;
    if (j.refresh_token) sp.refresh = j.refresh_token;
    if (j.scope) sp.scope = j.scope;
    spSave();
  }
  async function spAccess() {
    if (!sp.clientId) throw new Error('Spotify sin configurar: falta el Client ID');
    if (!sp.refresh) throw new Error('Spotify sin conectar: abre /spotify/login en el navegador');
    if (!sp.access || Date.now() > sp.expires) await spToken({ grant_type: 'refresh_token', refresh_token: sp.refresh });
    return sp.access;
  }
  // Spotify limita las peticiones (429): hasta que pase su Retry-After no se le pide nada, para no alargar el bloqueo.
  // La espera se guarda en spotify.json (waitUntil): si el servidor se reinicia, no vuelve a preguntar antes de tiempo
  // (cada pregunta durante el castigo lo renovaba otra hora).
  let spWait = Number(sp.waitUntil) > Date.now() ? Number(sp.waitUntil) : 0;
  if (spWait) log.info(`spotify: sigo esperando ${Math.ceil((spWait - Date.now()) / 1000)} s por el límite de antes del reinicio`);
  else if (sp.waitUntil) { delete sp.waitUntil; spSave(); }
  // contador de peticiones reales a la Web API: con TV_DEBUG, una línea por minuto; sin él, solo si pasan de 30/min
  const spCount = { n: 0, by: {} };
  const spCounted = (method, p, status) => {
    const k = method + ' ' + p.split('?')[0].replace(/[A-Za-z0-9]{20,}/g, ':id') + (status === 429 ? ' (429)' : '');
    spCount.n++; spCount.by[k] = (spCount.by[k] || 0) + 1;
  };
  setInterval(() => {
    const { n, by } = spCount;
    if (n && (DEBUG || n > 30)) log.info(`spotify: ${n} peticiones en el último minuto (` + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') + ')');
    spCount.n = 0; spCount.by = {};
  }, 60_000).unref();
  function spWaitErr() { const e = /** @type {Error & { wait?: boolean }} */ (new Error(`Spotify pide esperar ${Math.ceil((spWait - Date.now()) / 1000)} s`)); e.wait = true; return e; }
  async function spApi(method, p, body) {
    if (Date.now() < spWait) throw spWaitErr();
    const doit = async () => {
      const r = await fetch('https://api.spotify.com/v1' + p, {
        method, headers: { Authorization: 'Bearer ' + await spAccess(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
      });
      spCounted(method, p, r.status); return r;
    };
    let r = await doit();
    if (r.status === 401) { sp.expires = 0; r = await doit(); }
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'));                  // segundos; sin cabecera, 30 s
      spWait = Date.now() + Math.min(Number.isFinite(ra) && ra > 0 ? ra : 30, 3600) * 1000;
      sp.waitUntil = spWait; spSave();
      log.info(`spotify: límite de peticiones, espero ${Math.ceil((spWait - Date.now()) / 1000)} s`);
      throw spWaitErr();
    }
    if (sp.waitUntil) { delete sp.waitUntil; spSave(); }               // ya responde: fuera la espera guardada
    if (r.status === 204 || r.status === 202) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || 'Spotify ' + r.status);
    return j;
  }
  function spLogin() { // -> URL de autorización de Spotify
    if (!sp.clientId) return null;
    const verifier = b64u(crypto.randomBytes(48)), state = b64u(crypto.randomBytes(12));
    for (const [k, v] of spPending) if (Date.now() - v.ts > 600_000) spPending.delete(k);
    spPending.set(state, { verifier, ts: Date.now() });
    return 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: sp.clientId, response_type: 'code', redirect_uri: PUBLIC_URL + '/spotify/callback', scope: SP_SCOPE,
      code_challenge_method: 'S256', code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), state,
    });
  }
  async function spCallback(url) {
    const st = spPending.get(url.searchParams.get('state'));
    spPending.delete(url.searchParams.get('state'));
    const code = url.searchParams.get('code');
    if (!st || !code) throw new Error('enlace caducado o no válido');
    await spToken({ grant_type: 'authorization_code', code, redirect_uri: PUBLIC_URL + '/spotify/callback', code_verifier: st.verifier });
  }
  async function spDevice() {
    const d = (await spApi('GET', '/me/player/devices')).devices || [];
    return d.find(x => x.name === SP_DEVICE) || null;
  }
  const spInfoNow = n => !n || n.empty || !n.track ? { status: 'sin reproducción' } : {        // resumen de spNow para el agente (MCP)
    status: n.playing ? 'reproduciendo' : 'en pausa', title: n.track.name, artist: n.artist,
    album: n.album?.name || '', device: n.device?.name, volume: n.device?.volume,
  };
  async function spotify(m) {
    try {
      const a = String(m.a || 'status');
      if (a === 'status') {
        if (!sp.clientId) return { connected: false, error: 'Spotify sin configurar: falta el Client ID' };
        if (!sp.refresh) return { connected: false, error: 'Spotify sin conectar: abre /spotify/login en el navegador' };
        const dev = await spDevice();
        return { connected: true, device: dev ? { name: dev.name, active: dev.is_active, volume: dev.volume_percent } : null, ...spInfoNow(await spNow.poll(3000)) };
      }
      const noDev = ['now', 'queue', 'playlists', 'playlist', 'recent'].includes(a); // lecturas: no necesitan el altavoz
      const dev = noDev ? null : await spDevice();
      if (!noDev && !dev) return { error: `el dispositivo «${SP_DEVICE}» no aparece en Spotify (¿está en marcha spotifyd?)` };
      const q = dev ? `?device_id=${encodeURIComponent(dev.id)}` : '';
      const wake = async () => { if (dev && !dev.is_active) await spApi('PUT', '/me/player', { device_ids: [dev.id], play: false }); };
      const after = async () => { await new Promise(r => setTimeout(r, 700)); return spInfoNow(await spNow.poll(300)); }; // se une a la consulta de kick()
      switch (a) {
        case 'activate': await spApi('PUT', '/me/player', { device_ids: [dev.id], play: false }); return { ok: 1 };
        case 'play': await wake(); await spApi('PUT', '/me/player/play' + q); spNow.kick(); return after();
        case 'pause': await spApi('PUT', '/me/player/pause' + q); spNow.kick(); return after();
        case 'playpause': {
          const st = await spNow.poll(3000);
          await spApi('PUT', '/me/player/' + (st?.playing ? 'pause' : 'play') + q); spNow.kick(); return after();
        }
        case 'next': await wake(); await spApi('POST', '/me/player/next' + q); spNow.kick(); return after();
        case 'prev': await wake(); await spApi('POST', '/me/player/previous' + q); spNow.kick(); return after();
        case 'volume': {
          const v = Math.min(100, Math.max(0, Math.round(Number(m.v))));
          if (!Number.isFinite(v)) return { error: 'volumen no válido' };
          await spApi('PUT', `/me/player/volume?volume_percent=${v}&device_id=${encodeURIComponent(dev.id)}`); spNow.kick(); return { ok: 1, volume: v };
        }
        case 'uri': case 'search_play': {
          let uri = String(m.uri || '').trim();
          if (a === 'search_play') {
            const type = ['track', 'album', 'artist', 'playlist'].includes(m.type) ? m.type : 'track';
            const q2 = String(m.query || '').trim().slice(0, 200);
            if (!q2) return { error: 'falta la búsqueda' };
            const r = await spApi('GET', `/search?type=${type}&limit=5&q=${encodeURIComponent(q2)}`);
            const item = (r[type + 's']?.items || []).find(Boolean);
            if (!item) return { error: 'no he encontrado nada con ese nombre' };
            uri = item.uri;
          }
          const w = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]{22})/.exec(uri);
          if (w) uri = `spotify:${w[1]}:${w[2]}`;
          if (uri === 'liked' || uri === 'spotify:collection') uri = `spotify:user:${await spMe()}:collection`; // «Tus me gusta»
          const mm = /^spotify:(track|album|playlist|artist|show|episode):[A-Za-z0-9]{22}$/.exec(uri) || /^spotify:user:[\w.-]+:(collection)$/.exec(uri);
          if (!mm) return { error: 'enlace o URI de Spotify no válido' };
          const single = mm[1] === 'track' || mm[1] === 'episode';
          if (m.asQueue) { // invitados en modo «a la cola»: la canción se añade a la cola en vez de sonar ya
            if (!single) return { error: 'Solo puedes pedir canciones sueltas' };
            await spApi('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${encodeURIComponent(dev.id)}`); spNow.kick();
            return { ok: 1, queued: true, uri };
          }
          await wake();
          let off = {};
          if (/^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(m.offset || '')) off = { offset: { uri: m.offset } };
          else if (m.shuffle && Number(m.total) > 1) off = { offset: { position: Math.floor(Math.random() * Math.min(Number(m.total), 10000)) } }; // aleatorio: empieza en cualquiera
          if (m.shuffle !== undefined && !single) await spApi('PUT', `/me/player/shuffle?state=${!!m.shuffle}&device_id=${encodeURIComponent(dev.id)}`).catch(() => {});
          try { await spApi('PUT', '/me/player/play' + q, single ? { uris: [uri] } : { context_uri: uri, ...off }); }
          catch (e) {
            if (!off.offset) throw e; // con offset puede fallar si la canción no está en esa lista: se reintenta sin él
            await spApi('PUT', '/me/player/play' + q, { context_uri: uri });
          }
          spNow.kick();
          return { uri, ...(await after()) };
        }
        case 'now': { const n = await spNow.poll(2000); return { ...(n || { empty: true }), needsLogin: !spHasScopes() }; }
        case 'seek': {
          const ms = Number.isFinite(+m.ms) ? +m.ms : Number.isFinite(+m.pos) ? Math.round(+m.pos * (spNow.get()?.duration || 0)) : NaN;
          if (!Number.isFinite(ms) || ms < 0) return { error: 'posición no válida' };
          await spApi('PUT', `/me/player/seek?position_ms=${Math.round(ms)}&device_id=${encodeURIComponent(dev.id)}`); spNow.kick(); return { ok: 1, ms: Math.round(ms) };
        }
        case 'shuffle': {
          const on = m.state === undefined ? !(spNow.get()?.shuffle) : !!m.state;
          await spApi('PUT', `/me/player/shuffle?state=${on}&device_id=${encodeURIComponent(dev.id)}`); spNow.kick(); return { ok: 1, shuffle: on };
        }
        case 'repeat': {
          const order = ['off', 'context', 'track'];
          const st = order.includes(m.state) ? m.state : order[(order.indexOf(spNow.get()?.repeat || 'off') + 1) % 3];
          await spApi('PUT', `/me/player/repeat?state=${st}&device_id=${encodeURIComponent(dev.id)}`); spNow.kick(); return { ok: 1, repeat: st };
        }
        case 'like': {
          const cur = spNow.get();
          const uri = /^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(m.uri || '') ? m.uri : cur?.track?.uri;
          if (!uri) return { error: 'no suena nada' };
          const on = m.state === undefined ? !(cur?.track?.uri === uri && cur.liked) : !!m.state;
          await spApi(on ? 'PUT' : 'DELETE', '/me/library?uris=' + encodeURIComponent(uri));
          spNow.forgetLiked(uri.split(':')[2]); spNow.kick(); return { ok: 1, liked: on };
        }
        case 'queue_add': {
          const uri = String(m.uri || '');
          if (!/^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(uri)) return { error: 'URI no válida' };
          await spApi('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${encodeURIComponent(dev.id)}`); spNow.kick(); return { ok: 1 };
        }
        case 'queue': { const n = await spNow.panelOpened(); return { queue: n?.queue || [] }; }      // cola fresca
        case 'playlists': {
          const me = await spMe();
          const out = [];
          for (let off = 0; off < 200; off += 50) { // todas (hasta 200)
            const j = await spApi('GET', `/me/playlists?limit=50&offset=${off}`);
            out.push(...(j.items || []).filter(Boolean));
            if (!j.next) break;
          }
          let liked = null;
          try { const t = await spApi('GET', '/me/tracks?limit=1'); liked = { name: 'Tus me gusta', uri: 'liked', by: 'Canciones que te gustan', image: null, liked: true, count: t.total ?? null, canList: true }; } catch {}
          return { items: [...(liked ? [liked] : []), ...out.map(p => ({
            name: p.name, uri: p.uri, by: p.owner?.display_name || '', image: spImg(p.images, 300),
            count: p.items?.total ?? p.tracks?.total ?? null, canList: p.owner?.id === me || !!p.collaborative,
          }))] };
        }
        case 'playlist': { // abrir una playlist (o «Tus me gusta») y ver sus canciones
          const off = Math.max(0, Number(m.offset) || 0), lim = 50;
          const map = t => t && ({ name: t.name, by: (t.artists || []).map(x => x.name).join(', ') || t.show?.name || '', uri: t.uri,
            image: spImg(t.album?.images || t.images, 64), duration: t.duration_ms || 0, explicit: !!t.explicit, playable: t.is_playable !== false && !t.is_local });
          if (m.uri === 'liked') {
            const j = await spApi('GET', `/me/tracks?limit=${lim}&offset=${off}`);
            return { name: 'Tus me gusta', by: 'Canciones que te gustan', uri: 'liked', image: null, liked: true, count: j.total, canList: true,
              items: (j.items || []).map(x => map(x.track)).filter(Boolean), next: j.next ? off + lim : null };
          }
          const id = (/^spotify:playlist:([A-Za-z0-9]{22})$/.exec(m.uri || '') || [])[1];
          if (!id) return { error: 'playlist no válida' };
          const p = await spApi('GET', `/playlists/${id}?fields=name,description,images,owner(id,display_name),collaborative,followers(total),items(total)`);
          const head = { name: p.name, by: p.owner?.display_name || '', uri: m.uri, image: spImg(p.images, 640), description: (p.description || '').replace(/<[^>]+>/g, ''),
            count: p.items?.total ?? null, followers: p.followers?.total ?? null };
          try {
            const j = await spApi('GET', `/playlists/${id}/items?limit=${lim}&offset=${off}&additional_types=track,episode`);
            return { ...head, canList: true, count: j.total ?? head.count, items: (j.items || []).map(x => map(x.item || x.track)).filter(Boolean), next: j.next ? off + lim : null };
          } catch (e) {
            // desde febrero de 2026, Spotify no deja leer las canciones de listas de otros (sí reproducirlas)
            return { ...head, canList: false, items: [], next: null, note: 'Spotify no deja ver las canciones de las listas de otras personas, pero puedes reproducirla.' };
          }
        }
        case 'recent': {
          const j = await spApi('GET', '/me/player/recently-played?limit=30');
          const seen = new Set(), items = [];
          for (const x of j.items || []) {
            const t = x.track; if (!t || seen.has(t.id)) continue; seen.add(t.id);
            items.push({ name: t.name, by: (t.artists || []).map(a => a.name).join(', '), uri: t.uri, image: (t.album?.images || []).slice(-1)[0]?.url || null, at: x.played_at, context: x.context?.uri || null });
          }
          return { items: items.slice(0, 20) };
        }
        case 'search': {
          const type = ['track', 'album', 'artist', 'playlist'].includes(m.type) ? m.type : 'track';
          const r = await spApi('GET', `/search?type=${type}&limit=5&q=${encodeURIComponent(String(m.query || '').slice(0, 200))}`);
          return { items: (r[type + 's']?.items || []).filter(Boolean).map(i => ({ name: i.name, by: (i.artists || []).map(x => x.name).join(', ') || i.owner?.display_name || '', uri: i.uri })) };
        }
        default: return { error: 'acción desconocida' };
      }
    } catch (e) { return { error: e.message }; }
  }

  // ───────────────────────── «ahora suena» completo (nowplaying.js): reposo, mando y agente
  // el mando renueva spwatch cada 15 s mientras se ve; un móvil bloqueado con el panel abierto deja de contar a los 40 s
  const spWatching = c => !!c.spWatch && Date.now() - c.spWatch < 40_000;
  function spBroadcast(n) {
    const s = JSON.stringify({ t: 'sp', now: n ? { ...n, needsLogin: !spHasScopes() } : null });
    for (const c of clients()) if (spWatching(c) && c.readyState === WebSocket.OPEN) c.send(s);
  }
  const spNow = require('../../nowplaying')({
    spApi, spReady: () => !!(sp.clientId && sp.refresh),
    watching: () => [...clients()].some(spWatching) ? 2 : idle().watching() ? 1 : 0,
    onChange: n => { idle().setMusic(n); spBroadcast(n); }, log: log.info,
  });

  // En la web de Spotify, la barra verde «Reproduciendo en Salón» sobra: «Salón» es la propia tele.
  // Se oculta el bloque de esa barra (nunca los controles). Con TV_SPOTIFY_BANNER=1 se deja como viene.
  function spotifyTweak() {
    if (location.hostname !== 'open.spotify.com' || window.__tvTweak) return;
    window.__tvTweak = 1;
    const RE = /^(Reproduciendo|Escuchando|Playing|Listening) (en|on) /i;
    const sweep = () => {
      const bar = document.querySelector('[data-testid="now-playing-bar"]');
      if (!bar) return;
      for (const b of bar.querySelectorAll('button')) {
        if (!RE.test((b.textContent || '').trim())) continue;
        let el = /** @type {HTMLElement} */ (b);
        while (el.parentElement && el.parentElement !== bar) el = el.parentElement;
        if (el !== b && !el.querySelector('[data-testid="player-controls"]') && el.style.display !== 'none') el.style.setProperty('display', 'none', 'important');
      }
    };
    new MutationObserver(sweep).observe(document, { childList: true, subtree: true });
    sweep();
  }

  // retoques de páginas concretas: en cada documento nuevo de la pestaña activa (al engancharla) o solo en el actual
  function spotifyRetouch(everyDocument) {
    const source = `(${spotifyTweak})()`;
    const bad = m => e => log.error('tweak', m, e.message);
    if (everyDocument) cdp.call('Page.addScriptToEvaluateOnNewDocument', { source }).catch(bad('addScript'));
    cdp.call('Runtime.evaluate', { expression: source }).catch(everyDocument ? bad('eval') : () => {});
  }
  // ganchos de la pestaña activa: al engancharla, en cada documento nuevo; al moverse dentro de Spotify, en el actual
  const page = {
    attached() { if (!CFG.SPOTIFY_BANNER) spotifyRetouch(true); },
    changed(url) { if (cdp.session && /^https:\/\/open\.spotify\.com\//.test(url) && !CFG.SPOTIFY_BANNER) spotifyRetouch(false); },
  };

  // permisos: la biblioteca es privada y pedir canciones depende del modo de música del dispositivo
  const spotifyPerm = (m, P) => {
    if (['playlists', 'playlist', 'recent', 'like'].includes(m.a) && !P.library) return 'La biblioteca de Spotify es privada';
    if (['uri', 'search_play', 'queue_add'].includes(m.a) && P.music === 'off') return 'Pedir canciones no está permitido';
    return null;
  };
  const spotifyClamp = (m, P) => {
    if (['uri', 'search_play'].includes(m.a) && P.music === 'queue') return { ...m, asQueue: true }; // solo puede encolar
    if (m.a === 'volume') return { ...m, v: Math.min(Number(m.v) || 0, P.volMax) };
    return m;
  };
  /** @type {import('../transport/commands').Command[]} */
  const commands = [
    { t: 'spotify', perm: spotifyPerm, clamp: spotifyClamp, run: m => spotify(m) },
    { t: 'spwatch', quiet: true, async run(m, { ws }) { // el panel de Spotify del mando pide (o deja de pedir) el estado en vivo
      if (!m.on) { if (ws) ws.spWatch = 0; return { ok: 1 }; }
      const was = ws ? spWatching(ws) : false;
      if (ws) ws.spWatch = Date.now();
      // solo al abrirse se pregunta a Spotify (cola y «me gusta» al día); los refrescos cada 15 s usan lo que hay
      const n = was && spNow.get() ? spNow.get() : await spNow.panelOpened();
      return { now: n ? { ...n, needsLogin: !spHasScopes() } : null };
    } },
  ];

  /**
   * Rutas HTTP para conectar la cuenta: /spotify/login?t=TOKEN (cualquier dispositivo de la red con token) lleva a
   * Spotify, y /spotify/callback vuelve de allí (se valida con `state`).
   * @param {{ blocked: (ip: string) => boolean, fail: (ip: string) => void, okToken: (t: any) => boolean }} auth
   */
  function httpRoutes({ blocked, fail, okToken }) {
    return [
      { path: '/spotify/login', run(req, res, { url, ip }) {
        if (blocked(ip)) return send(res, 429, 'demasiados intentos');
        if (!okToken(url.searchParams.get('t'))) { fail(ip); return send(res, 401, 'no autorizado'); }
        const to = spLogin();
        return to ? send(res, 302, '', { Location: to, 'Cache-Control': 'no-store' }) : send(res, 400, 'Falta el Client ID de Spotify en spotify.json');
      } },
      { path: '/spotify/callback', run(req, res, { url }) {
        const page = (t, m) => send(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#0b0d10;color:#f3f6fb;font:20px system-ui;display:grid;place-items:center;height:100vh;text-align:center"><div><h1>${t}</h1><p style="opacity:.7">${m}</p></div>`, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        return spCallback(url).then(() => page('Spotify conectado ✓', 'Ya puedes cerrar esta pestaña.'), e => page('No se pudo conectar', String(e.message).replace(/[<>&]/g, '')));
      } },
    ];
  }

  return { spotify, now: spNow, httpRoutes, login: spLogin, callback: spCallback, hasScopes: spHasScopes, page, commands };
};
