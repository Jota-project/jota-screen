'use strict';
// Pantalla en reposo y Live Activities.
//  - Reposo: página /idle.html con fondo animado según el momento del día (o los colores de la canción),
//    hora y tiempo siempre visibles y «ahora suena». Se abre sola tras N minutos sin uso.
//  - Live Activities: píldoras por encima de lo que se esté viendo (también en el reposo), en tiempo real.
// Config en idle.json (junto al servidor): ciudad, horario de sueño (fijo o por día), minutos sin uso…
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { writeJson } = require('./src/core/json-store');
const { islandSource } = require('./src/tv/tokens');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MODES = ['auto', 'day', 'evening', 'night', 'cinema'];
const LAYOUTS = ['rotar', 'margen', 'zonas', 'apilada']; // distribuciones del reposo v2
const DEFAULTS = {
  city: 'Elche', lat: 38.2669, lon: -0.6983, tz: 'Europe/Madrid',
  mode: 'auto',                 // auto | day | evening | night | cinema
  bed: '23:30', wake: '07:30',  // horario fijo de sueño
  perDay: false, week: {},      // si perDay: { mon: {bed, wake}, … } (bed de la noche de ese día, wake de la mañana de ese día)
  idleMin: 10,                  // minutos sin uso hasta pasar al reposo (0 = nunca)
  dimMin: 20,                   // de noche: minutos hasta dejar solo la hora, muy tenue (0 = nunca)
  music: true,                  // mostrar lo que suena en Spotify
  layout: 'rotar',              // rotar | margen | zonas | apilada
  rearrangeMin: 20,             // minutos entre reacomodos de los widgets (0 = nunca); también evita el quemado
  calm: false,                  // movimiento reducido: luces y ecualizador quietos
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

module.exports = function createIdle(o) {
  const { ROOT, PUB, SELF, cdp, nav, state, stageKind, log = () => {} } = o;
  const URL_IDLE = SELF + '/idle.html';
  const CFG_FILE = path.join(ROOT, 'idle.json');
  let cfg = { ...DEFAULTS };
  try { cfg = sanitize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }); } catch {}
  const save = () => writeJson(CFG_FILE, cfg, { pretty: true }); // atómico y 0600 (src/core/json-store.js)

  const isIdle = u => typeof u === 'string' && u.startsWith(URL_IDLE);
  let lastUse = Date.now();
  let weather = null, music = null, profile = 'day';
  const acts = new Map(); let actSeq = 0;
  const timers = new Map();
  const clients = new Set();

  // ───────── config
  function sanitize(c) {
    const out = { ...DEFAULTS };
    if (typeof c.city === 'string') out.city = c.city.slice(0, 60);
    for (const k of ['lat', 'lon']) if (Number.isFinite(+c[k])) out[k] = +c[k];
    if (typeof c.tz === 'string' && c.tz.length < 60) out.tz = c.tz;
    if (MODES.includes(c.mode)) out.mode = c.mode;
    if (HHMM.test(c.bed)) out.bed = c.bed;
    if (HHMM.test(c.wake)) out.wake = c.wake;
    out.perDay = !!c.perDay;
    out.week = {};
    if (c.week && typeof c.week === 'object') for (const d of DAYS) {
      const w = c.week[d]; if (!w) continue;
      const e = {}; if (HHMM.test(w.bed)) e.bed = w.bed; if (HHMM.test(w.wake)) e.wake = w.wake;
      if (e.bed || e.wake) out.week[d] = e;
    }
    for (const k of ['idleMin', 'dimMin']) if (Number.isFinite(+c[k])) out[k] = Math.min(600, Math.max(0, Math.round(+c[k])));
    if (c.music !== undefined) out.music = !!c.music;
    if (LAYOUTS.includes(c.layout)) out.layout = c.layout;
    if (Number.isFinite(+c.rearrangeMin)) out.rearrangeMin = Math.min(120, Math.max(0, Math.round(+c.rearrangeMin)));
    if (c.calm !== undefined) out.calm = !!c.calm;
    return out;
  }

  // ───────── momento del día
  function local(date = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map(x => [x.type, x.value]));
    return { min: +p.hour * 60 + +p.minute, day: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
  }
  const sched = d => {
    const w = cfg.perDay ? cfg.week[DAYS[(d + 7) % 7]] || {} : {};
    return { bed: toMin(w.bed || cfg.bed), wake: toMin(w.wake || cfg.wake) };
  };
  function asleep() {
    const { min: t, day: d } = local();
    const today = sched(d), yest = sched(d - 1);
    // la noche de ayer: si se acostó antes de medianoche, dura hasta el despertar de hoy; si fue de madrugada, desde esa hora
    if (t < today.wake && (yest.bed >= 720 || t >= yest.bed)) return true;
    return today.bed >= 720 && t >= today.bed;
  }
  function computeProfile() {
    if (cfg.mode !== 'auto') return cfg.mode;
    if (asleep()) return 'night';
    const now = Date.now();
    if (weather?.sunrise && weather?.sunset) {
      if (now < weather.sunrise - 20 * 60e3 || now > weather.sunset + 40 * 60e3) return 'evening';
      return 'day';
    }
    const { min } = local();
    return min >= 7 * 60 && min < 20 * 60 ? 'day' : 'evening';
  }

  // ───────── tiempo (Open-Meteo, sin clave)
  async function fetchWeather() {
    try {
      const q = new URLSearchParams({
        latitude: cfg.lat, longitude: cfg.lon, timezone: cfg.tz, forecast_days: 2, timeformat: 'unixtime',
        current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
        daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,weather_code',
        hourly: 'precipitation_probability', forecast_hours: 6,
      });
      const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      if (!j.current) throw new Error('sin datos');
      const rain = (j.hourly?.precipitation_probability || []).slice(0, 6);
      weather = {
        temp: Math.round(j.current.temperature_2m), feels: Math.round(j.current.apparent_temperature),
        code: j.current.weather_code, isDay: !!j.current.is_day, wind: Math.round(j.current.wind_speed_10m),
        max: Math.round(j.daily.temperature_2m_max[0]), min: Math.round(j.daily.temperature_2m_min[0]),
        rainMax: j.daily.precipitation_probability_max?.[0] ?? null, rainNext: rain.length ? Math.max(...rain) : null,
        sunrise: j.daily.sunrise[0] * 1000, sunset: j.daily.sunset[0] * 1000,
        sunriseNext: j.daily.sunrise[1] * 1000, ts: Date.now(),
      };
      tick(true);
    } catch (e) { log('tiempo:', e.message); }
  }

  // ───────── música: llega ya montada desde nowplaying.js (solo se consulta mientras el reposo está abierto)
  function setMusic(n) {
    const next = !cfg.music || !n || n.empty || !n.track ? null : {
      title: n.track.name, artist: n.artist, album: n.album?.name || '', art: n.album?.image?.l || '',
      playing: n.playing, progress: n.progress, duration: n.duration, at: n.at, device: n.device?.name || '',
      colors: n.colors?.hsl || null, accent: n.colors?.accent || null, liked: n.liked,
      context: n.context ? { type: n.context.type, name: n.context.name } : null,
      next: n.queue?.[0] ? { name: n.queue[0].name, artist: n.queue[0].artist } : null,
      artistImage: n.artistInfo?.image?.m || null,
    };
    music = next; push();
  }

  // ───────── Live Activities
  const pub = a => ({ id: a.id, kind: a.kind, title: a.title, subtitle: a.subtitle, icon: a.icon, accent: a.accent,
    progress: a.progress, endsAt: a.endsAt, startAt: a.startAt, duration: a.duration, done: a.done, priority: a.priority,
    updated: a.updated, quiet: a.quiet, value: a.value });
  const actList = () => [...acts.values()].sort((a, b) => (b.done - a.done) || (b.priority - a.priority) || (b.updated - a.updated)).map(pub);
  const str = (v, n) => String(v ?? '').slice(0, n);
  function clearTimers(id) { for (const k of ['end', 'ttl']) { const t = timers.get(id + k); if (t) { clearTimeout(t); timers.delete(id + k); } } }
  function actSet(m) {
    const id = str(m.id, 40).replace(/[^\w-]/g, '') || 'a' + (++actSeq).toString(36);
    const prev = acts.get(id);
    const a = prev ? { ...prev } : { id, kind: 'generic', title: '', subtitle: '', icon: '', accent: '#ffffff', progress: null,
      endsAt: null, startAt: null, duration: null, done: false, priority: 0, quiet: false, value: '', created: Date.now() };
    if (m.kind !== undefined) a.kind = ['generic', 'timer', 'progress', 'live', 'music'].includes(m.kind) ? m.kind : 'generic';
    if (m.title !== undefined) a.title = str(m.title, 80);
    if (m.subtitle !== undefined) a.subtitle = str(m.subtitle, 140);
    if (m.icon !== undefined) a.icon = str(m.icon, 8);
    if (m.value !== undefined) a.value = str(m.value, 16);
    if (m.accent !== undefined && /^#[0-9a-f]{3,8}$/i.test(m.accent)) a.accent = m.accent;
    if (m.progress !== undefined) a.progress = m.progress === null ? null : Math.min(1, Math.max(0, Number(m.progress) || 0));
    if (m.priority !== undefined) a.priority = Math.min(10, Math.max(-10, Number(m.priority) || 0));
    if (m.quiet !== undefined) a.quiet = !!m.quiet;
    if (m.elapsed) { a.startAt = Date.now() - Math.max(0, Number(m.elapsed) || 0) * 1000; }
    if (m.seconds !== undefined && Number(m.seconds) > 0) { // cuenta atrás
      const s = Math.min(Number(m.seconds), 24 * 3600);
      a.kind = m.kind || (prev?.kind === 'generic' || !prev ? 'timer' : prev.kind);
      a.duration = s * 1000; a.endsAt = Date.now() + s * 1000; a.done = false;
      clearTimeout(timers.get(id + 'end'));
      timers.set(id + 'end', setTimeout(() => {
        const x = acts.get(id); if (!x) return;
        x.done = true; x.progress = 1; x.subtitle = str(m.doneText, 140) || '¡Tiempo!'; x.updated = Date.now(); x.quiet = false;
        push();
        timers.set(id + 'ttl', setTimeout(() => actEnd(id), (Number(m.doneSeconds) || 90) * 1000));
      }, s * 1000));
    }
    if (!a.title) return { error: 'falta title' };
    a.updated = Date.now();
    acts.set(id, a);
    if (m.ttl !== undefined && Number(m.ttl) > 0) {
      clearTimeout(timers.get(id + 'ttl'));
      timers.set(id + 'ttl', setTimeout(() => actEnd(id), Math.min(Number(m.ttl), 24 * 3600) * 1000));
    }
    if (acts.size > 12) actEnd([...acts.values()].sort((x, y) => x.updated - y.updated)[0].id); // tope
    push();
    return { ok: 1, id };
  }
  function actEnd(id) {
    clearTimers(id);
    const had = acts.delete(String(id));
    if (had) push();
    return had ? { ok: 1 } : { error: 'no existe esa actividad' };
  }

  // ───────── difusión: a la página de reposo (WS) y, sobre cualquier otra página, la isla inyectada por CDP
  // los tokens de shared/tokens-tv.css van delante como texto: la isla no puede cargar CSS nuestro dentro de una web ajena
  const islandSrc = () => { try { return islandSource(PUB); } catch (e) { log('isla: ' + e.message); return ''; } };
  let overlayOn = false;
  function payload() {
    return JSON.stringify({ t: 'idle', now: Date.now(), profile, cfg: { city: cfg.city, dimMin: cfg.dimMin, mode: cfg.mode, music: cfg.music, layout: cfg.layout, rearrangeMin: cfg.rearrangeMin, calm: cfg.calm }, weather, music, acts: actList() });
  }
  let pTimer = null;
  function push() {
    if (pTimer) return;
    pTimer = setTimeout(() => {
      pTimer = null;
      const s = payload();
      for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
      overlay();
    }, 40);
  }
  function overlay() {
    if (!cdp.session || isIdle(state.url)) return;
    if (!acts.size && !overlayOn) return;
    overlayOn = acts.size > 0;
    const src = islandSrc(); if (!src) return;
    const expr = `(()=>{${src}\n;window.TVIsland&&window.TVIsland.render(${JSON.stringify(actList())},${Date.now()})})()`;
    cdp.call('Runtime.evaluate', { expression: expr }).catch(() => {});
  }
  let navT = [];
  function onNav(url) {
    for (const t of navT) clearTimeout(t);
    navT = [];
    if (!acts.size || isIdle(url)) { if (isIdle(url)) overlayOn = false; return; }
    overlayOn = true;
    navT = [700, 2500, 6000].map(ms => setTimeout(overlay, ms)); // la página nueva puede tardar en estar lista
  }

  // ───────── paso automático al reposo
  function touch() { lastUse = Date.now(); }
  async function mediaPlaying() {
    try {
      const r = await cdp.call('Runtime.evaluate', { expression: '[...document.querySelectorAll("video,audio")].some(m=>!m.paused&&!m.ended)', returnByValue: true });
      return !!r?.result?.value;
    } catch { return true; } // ante la duda, no se toca nada
  }
  let busy = false;
  async function autoIdle() {
    if (busy || !cfg.idleMin || !cdp.session) return;
    if (Date.now() - lastUse < cfg.idleMin * 60e3) return;
    if (isIdle(state.url) || stageKind()) return;
    busy = true;
    try {
      if (await mediaPlaying()) { lastUse = Date.now() - (cfg.idleMin - 1) * 60e3; return; } // se vuelve a mirar en un minuto
      lastUse = Date.now();
      log('sin uso: paso al reposo');
      await nav(URL_IDLE);
    } finally { busy = false; }
  }

  function tick(force) {
    const p = computeProfile();
    if (p !== profile || force) { profile = p; push(); }
  }

  // ───────── HTTP/WS (solo desde la propia tele)
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
  wss.on('connection', ws => {
    clients.add(ws);
    ws.on('error', () => {});
    ws.on('close', () => clients.delete(ws));
    ws.send(payload());
    o.onWatch && o.onWatch();
  });
  const artCache = new Map();
  async function art(req, res, url, send) {
    const u = url.searchParams.get('u') || '';
    if (!/^https:\/\/i\.scdn\.co\/image\/[a-f0-9]{20,64}$/.test(u)) return send(res, 400, 'no');
    try {
      let b = artCache.get(u);
      if (!b) {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return send(res, 502, '');
        b = { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
        artCache.set(u, b); if (artCache.size > 20) artCache.delete(artCache.keys().next().value);
      }
      send(res, 200, b.buf, { 'Content-Type': b.type, 'Cache-Control': 'public, max-age=86400' });
    } catch { send(res, 502, ''); }
  }

  // ───────── órdenes
  function run(m) {
    const op = String(m.op || 'get');
    if (op === 'get') return { cfg, profile, weather, url: URL_IDLE, idle: isIdle(state.url), idleInMin: cfg.idleMin ? Math.max(0, Math.round((cfg.idleMin * 60e3 - (Date.now() - lastUse)) / 60e3)) : null };
    if (op === 'set') {
      const prevLoc = cfg.lat + ',' + cfg.lon;
      cfg = sanitize({ ...cfg, ...(m.cfg || {}) });
      save();
      if (cfg.lat + ',' + cfg.lon !== prevLoc) fetchWeather();
      tick(true);
      return { ok: 1, cfg, profile };
    }
    if (op === 'show') return nav(URL_IDLE);
    return { error: 'op debe ser get, set o show' };
  }
  function activity(m) {
    const op = String(m.op || 'set');
    if (op === 'set') return actSet(m);
    if (op === 'end') return actEnd(m.id);
    if (op === 'clear') { for (const id of [...acts.keys()]) clearTimers(id); acts.clear(); push(); return { ok: 1 }; }
    if (op === 'list') return { acts: actList() };
    return { error: 'op debe ser set, end, clear o list' };
  }

  fetchWeather();
  setInterval(fetchWeather, 15 * 60e3);
  setInterval(() => { tick(); autoIdle(); }, 20_000);
  tick(true);

  return {
    URL_IDLE, isIdle, touch, onNav, run, activity, art, setMusic, watching: () => clients.size > 0 && cfg.music,
    upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)),
    info: () => ({ profile, idle: isIdle(state.url), acts: acts.size }),
  };
};
