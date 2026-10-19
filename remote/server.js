'use strict';
// Mando web para la tele.
// HTTP + WebSocket  ->  Chrome (CDP: teclas, texto, navegación)  +  puntero X real (pointer.py)  +  volumen (wpctl)
// Escucha solo en loopback, red privada y Tailscale. Todo requiere token (fichero ./token).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { loadConfig } = require('./src/core/config');
const { createLog } = require('./src/core/log');
const { createRateLimiter } = require('./src/auth/ratelimit');
const { createAccess } = require('./src/auth/access');
const { createCommands } = require('./src/transport/commands');
const createAgent = require('./src/features/agent');
const createStage = require('./src/features/stage');
const createKeyboard = require('./src/features/keyboard');
const createControl = require('./src/features/control');
const createSpotify = require('./src/features/spotify');
const { createCdp } = require('./src/tv/cdp');
const { createPointer, createAudio, createPairScreen, PAGE_PROBE, parseProbe } = require('./src/tv/devices');

// configuración (entorno y rutas): src/core/config.js
const CFG = loadConfig();
const { ROOT, PUB, PORT, CDP_PORT, DEBUG, NO_POINTER, SELF, STAGE_DIR } = CFG;
fs.mkdirSync(STAGE_DIR, { recursive: true });

// ───────────────────────── acceso: token maestro, dispositivos, roles y emparejamiento (src/auth/access.js)
let acc = null;
// registro con redacción: el token maestro, los ?t= y los Bearer nunca llegan al journal (src/core/log.js)
const log = createLog({ secrets: () => (acc ? [acc.masterToken()] : []), debug: DEBUG });
// lo que el acceso necesita de las conexiones del mando y de la tele (wss y cdp se crean más abajo; se usan al llamar)
const devOf = c => (c && c.devId ? acc.byId(c.devId) : null);
const adminSockets = () => [...wss.clients].filter(c => c.readyState === WebSocket.OPEN && acc.permsOf(devOf(c)).admin);
function meOf(ws) {
  const d = devOf(ws);
  return { t: 'me', id: d?.id || null, name: d?.name || 'Enlace maestro', role: d ? d.role : 'admin', expires: d?.expires || null, perms: acc.permsOf(d), guestHours: acc.settings().guestHours };
}
function pushMe(devId) { for (const c of wss.clients) if (c.devId === devId && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(meOf(c))); }
const sessions = {
  isOnline: id => [...wss.clients].some(c => c.devId === id),
  close: (id, code, reason) => { for (const c of wss.clients) if (c.devId === id) c.close(code, reason); },
  pushMe,
  adminCount: () => adminSockets().length,
  notifyAdmins: msg => { const s = JSON.stringify(msg); for (const c of adminSockets()) c.send(s); },
};
// el código de emparejar se pinta encima de lo que haya en la tele (src/tv/devices.js)
const pairScreen = { ready: () => !!(cdp.ready && cdp.session), showCode: (c, n) => tvPair.showCode(c, n), hideCode: () => tvPair.hideCode() };
acc = createAccess({ files: CFG.FILES, adminUrl: CFG.ADMIN_URL, log, sessions,
  tv: pairScreen });
acc.start();
const { isMaster, tokenDev, okToken, permsOf } = acc;

// IP real del cliente cuando llega a través de un proxy local (nginx, tailscale serve)
function clientIp(req) {
  const a = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if ((a === '127.0.0.1' || a === '::1') && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
  return a;
}
// freno a intentos fallidos: 5 fallos -> 60 s bloqueada esa IP (src/auth/ratelimit.js)
const { blocked, fail } = createRateLimiter({ max: 5, ms: 60_000 });

// ───────────────────────── estado compartido
const state = { title: '', url: '', vol: null, muted: false, media: -1, scroll: null }; // scroll: {pos, size} de 0 a 1, o null
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
function publicState() {
  return {
    t: 'state', title: state.title, url: state.url, host: hostOf(state.url),
    vol: state.vol, muted: state.muted, media: state.media, cdp: !!(cdp.ready && cdp.session), scroll: state.scroll,
  };
}
let bTimer = null;
function broadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    const s = JSON.stringify(publicState());
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }, 30);
}

// ───────────────────────── CDP (Chrome DevTools Protocol), conexión persistente
const cdp = createCdp({ port: CDP_PORT, log, hooks: {
  onDown() { state.title = ''; state.url = ''; state.media = -1; state.scroll = null; focusSet(null); broadcast(); },
  onActivating() { focusSet(null); },
  onAttached(t) {
    if (t) { state.title = t.title; state.url = t.url; }
    spotifyF.page.attached();
    watchFocus();
    broadcast();
  },
  onPage(t) {
    if (t.url !== state.url && idle) idle.onNav(t.url);
    state.title = t.title; state.url = t.url; broadcast();
    spotifyF.page.changed(t.url); // al cambiar de página dentro de Spotify (o llegar a él) se repasa el retoque
  },
  onActiveGone(hasNext) { focusSet(null); if (!hasNext) broadcast(); },
  onDetached() { focusSet(null); broadcast(); },
  onBinding(name, payload) { // aviso de foco desde la página (solo de la sesión activa)
    if (name === '__tvFocus') { try { focusSet(JSON.parse(payload)); } catch {} }
  },
} });
const tvPair = createPairScreen(cdp);

// teclado y aviso de foco (src/features/keyboard.js)
const keyboard = createKeyboard({ cdp, log, clients: () => wss.clients, devOf });
const { key, focusFor, focusSet, watchFocus } = keyboard;

// ───────────────────────── puntero X real (helper en Python)
const pointer = createPointer({ script: path.join(ROOT, 'pointer.py'), display: CFG.DISPLAY, disabled: NO_POINTER, log });

// ───────────────────────── control: navegar, vídeo, volumen, pulsar y capturar (src/features/control.js)
const audio = createAudio({ runtimeDir: CFG.XDG_RUNTIME_DIR });      // src/tv/devices.js
const control = createControl({ cdp, state, broadcast: () => broadcast(), key, audio, cfg: CFG, leaveStage: () => stageF.leave() });
const { nav, volRead } = control;

// ───────────────────────── escenario (src/features/stage.js)
const stageF = createStage({ cdp, state, cfg: CFG, nav: u => nav(u) });
const { stage, events, toast, clients: stageClients, event: stageEvent } = stageF;

// ───────────────────────── Spotify y «ahora suena» (src/features/spotify.js)
const spotifyF = createSpotify({ cdp, cfg: CFG, log, clients: () => wss.clients, idle: () => idle });
const spNow = spotifyF.now;

// ───────────────────────── pantalla en reposo y Live Activities (idle.js)
const idle = require('./idle')({
  ROOT, PUB, SELF, cdp, nav, state, onWatch: () => spNow.poll(5000).then(n => idle.setMusic(n)),
  stageKind: () => stage.kind, log: log.info,
});

// agente (src/features/agent.js)
const agent = createAgent({ cfg: CFG, toast: m => toast(m) });

// Qué puede hacer cada rol. Devuelve un error o la orden (a veces ajustada: volumen con tope, peticiones a la cola).
// ───────────────────────── órdenes (src/transport/commands.js): cada una con su permiso al lado
const devArg = m => String(m.dev || '');
const commands = createCommands({ permsOf, onUse: () => idle.touch(), log });
commands.register(agent.commands);
commands.register(stageF.commands);
commands.register(keyboard.commands);
commands.register(control.commands);
commands.register(spotifyF.commands);
commands.register([
  // Live Activities (el resto del escenario se registra desde src/features/stage.js)
  { t: 'activity', perm: 'stage', quiet: true, run: m => idle.activity(m) },
  // pantalla en reposo
  { t: 'idle', perm: (m, P) => (m.op === 'set' && !P.admin ? 'Solo el administrador' : null), quiet: true, run: m => idle.run(m) },
  // acceso (solo admin)
  { t: 'devices', perm: 'admin', quiet: true, run: () => ({ devices: acc.devices.list(), access: acc.settings() }) },
  { t: 'revoke', perm: 'admin', run: m => acc.devices.revoke(devArg(m)) },
  { t: 'role', perm: 'admin', run: m => acc.devices.setRole(devArg(m), m.role) },
  { t: 'extend', perm: 'admin', run: m => acc.devices.extend(devArg(m), m.hours) },
  { t: 'rename', perm: 'admin', run: m => acc.devices.rename(devArg(m), m.name) },
  { t: 'kickguests', perm: 'admin', run: () => acc.devices.kickGuests() },
  { t: 'pairanswer', perm: 'admin', run: m => acc.pairing.answer(m.pid, !!m.ok, m.role) },
  { t: 'adminlink', perm: 'admin', run: () => acc.admin.link() },
  { t: 'access', perm: 'admin', run: m => ({ access: m.op === 'set' ? acc.setAccess(m.cfg || {}) : acc.settings() }) },
  { t: 'me', run: (m, { ws }) => (ws ? meOf(ws) : { role: 'admin' }) },
  { t: 'state', quiet: true, run: () => publicState() },
]);

async function run(m, ws, ctx = {}) { // mando (ws), API y MCP (ctx.dev)
  if (!m || typeof m !== 'object') return { error: 'mensaje no válido' };
  const dev = ws ? devOf(ws) : ctx.dev || null;
  if (ws && ws.devId && !dev) return { error: 'acceso retirado' };
  return commands.dispatch(m, { dev, ws });
}

// ───────────────────────── HTTP (estáticos + API para agentes)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
};
const assets = new Map();
for (const f of fs.readdirSync(PUB)) {
  const buf = fs.readFileSync(path.join(PUB, f));
  const ext = path.extname(f);
  assets.set('/' + f, {
    buf, gz: ext === '.html' ? zlib.gzipSync(buf, { level: 9 }) : null, type: TYPES[ext] || 'application/octet-stream',
    etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
  });
}
// el mando: todo en línea; solo las fuentes de Jota Dusk (Fraunces, Inter) vienen de Google, como en el reposo
const CSP = "default-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: https://*.scdn.co https://*.spotifycdn.com; manifest-src 'self'; base-uri 'none'; form-action 'none'";
// páginas del escenario: pueden cargar imágenes, fuentes, vídeo y librerías de internet, pero no hablar con otros servicios
const STAGE_CSP = "default-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; " +
  "img-src * data: blob:; media-src * data: blob:; font-src * data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const IDLE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
  "script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws:; base-uri 'none'; form-action 'none'";
// solo el navegador de la propia tele (bucle local, sin pasar por el proxy de Tailscale)
function isLocalTV(req) {
  const a = req.socket.remoteAddress || '';
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loop && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['tailscale-user-login'];
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}
const json = (res, code, obj, h = {}) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h });
// cookie con el token del dispositivo: si el navegador pierde su almacenamiento, sigue entrando sin volver a emparejar
const cookieTok = req => (/(?:^|;\s*)tvt=([a-f0-9]{32})/.exec(req.headers.cookie || '') || [])[1] || '';
const setCookie = (t, exp) => ({ 'Set-Cookie': `tvt=${t}; Path=/; Max-Age=${exp ? Math.max(60, Math.round((exp - Date.now()) / 1000)) : 400 * 86400}; HttpOnly; SameSite=Lax` });

async function api(req, res, url, ip) {
  if (blocked(ip)) return send(res, 429, 'demasiados intentos');
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || cookieTok(req);
  if (!okToken(tok)) { fail(ip); return send(res, 401, 'no autorizado'); }
  const apiDev = tokenDev(tok);
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...publicState(), stage: stage.kind, askBusy: agent.busy() });
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, { last: stageF.lastEvent(), events: events.filter(e => e.n > since), stage: stage.kind, data: stage.data });
  }
  if (req.method === 'POST' && url.pathname === '/api/cmd') {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 1_200_000) return send(res, 413, 'demasiado grande'); chunks.push(c); }
    let m; try { m = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'JSON no válido' }); }
    const r = await run(m, null, { dev: apiDev });
    return json(res, r.error ? 400 : 200, r);
  }
  send(res, 404, 'no encontrado');
}

async function pairHttp(req, res, p, ip) {
  if (req.method !== 'POST') return send(res, 405, '');
  if (blocked(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera un minuto.' });
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2048) return send(res, 413, ''); chunks.push(c); }
  let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
  if (p === '/pair/info') return json(res, 200, { adminOnline: adminSockets().length > 0, tv: !!(cdp.ready && cdp.session) });
  if (p === '/pair/start') { const r = await acc.pairing.start(ip, b.name, b.mode); return json(res, r.error && !r.noAdmin ? 429 : 200, r); }
  if (p === '/pair/confirm') {
    const r = acc.pairing.confirm(b.pid, b.code);
    if (r.error) fail(ip);
    return json(res, r.error ? 403 : 200, r, r.token ? setCookie(r.token, r.expires) : {});
  }
  if (p === '/pair/poll') { const r = acc.pairing.poll(b.pid); return json(res, 200, r, r.token ? setCookie(r.token, r.expires) : {}); }
  if (p === '/pair/me') { // ¿sigue valiendo este dispositivo? (token del navegador o cookie); renueva la cookie
    const t = (typeof b.t === 'string' && b.t) || cookieTok(req);
    if (!okToken(t)) return json(res, 200, { ok: false });
    if (isMaster(t)) return json(res, 200, { ok: true, master: true }); // el maestro no se guarda nunca en el navegador
    const d = tokenDev(t);
    return json(res, 200, { ok: true, role: d.role, name: d.name, expires: d.expires || null }, setCookie(t, d.expires));
  }
  if (p === '/pair/admin') { // canjear un código de admin, o el token maestro, por un dispositivo admin propio
    const cur = (typeof b.cur === 'string' && b.cur) || cookieTok(req);
    let r;
    if (isMaster(b.t) || (!b.code && isMaster(cur))) r = acc.admin.device(b.name, cur); // también el maestro que una versión anterior dejó en la cookie
    else if (b.code) r = acc.admin.claim(b.code, b.name, cur);
    else r = { error: 'Falta el código' };
    if (r.error) fail(ip);
    return json(res, r.error ? 403 : 200, r, r.token ? setCookie(r.token, r.expires) : {});
  }
  send(res, 404, '');
}

function handler(req, res) {
  const ip = clientIp(req);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p.startsWith('/api/')) return api(req, res, url, ip).catch(() => send(res, 500, 'error'));
  if (p.startsWith('/pair/')) return pairHttp(req, res, p, ip).catch(() => send(res, 500, 'error'));
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '');
  if (p === '/spotify/login') {
    if (blocked(ip)) return send(res, 429, 'demasiados intentos');
    if (!okToken(url.searchParams.get('t'))) { fail(ip); return send(res, 401, 'no autorizado'); }
    const to = spotifyF.login();
    return to ? send(res, 302, '', { Location: to, 'Cache-Control': 'no-store' }) : send(res, 400, 'Falta el Client ID de Spotify en spotify.json');
  }
  if (p === '/spotify/callback') { // vuelve de Spotify; se valida con `state`
    const page = (t, m) => send(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#0b0d10;color:#f3f6fb;font:20px system-ui;display:grid;place-items:center;height:100vh;text-align:center"><div><h1>${t}</h1><p style="opacity:.7">${m}</p></div>`, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return spotifyF.callback(url).then(() => page('Spotify conectado ✓', 'Ya puedes cerrar esta pestaña.'), e => page('No se pudo conectar', String(e.message).replace(/[<>&]/g, '')));
  }

  // manifiesto dinámico: si llega el token de un dispositivo, el acceso directo instalado lo conserva (el maestro, nunca)
  if (p === '/manifest.webmanifest' && assets.has(p)) {
    const man = JSON.parse(assets.get(p).buf.toString());
    const mt = url.searchParams.get('t'); if (tokenDev(mt)) man.start_url = '/?t=' + encodeURIComponent(mt);
    return send(res, 200, JSON.stringify(man), { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store' });
  }
  // páginas HTML que el agente ha puesto en el escenario (solo las pide el Chrome de la tele)
  const sm = /^\/stage\/(p\w+)\.html$/.exec(p);
  if (sm) {
    if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
    let buf; try { buf = fs.readFileSync(path.join(STAGE_DIR, sm[1] + '.html')); } catch { return send(res, 404, 'no encontrado'); }
    return send(res, 200, req.method === 'HEAD' ? '' : buf, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': STAGE_CSP });
  }
  if (p === '/idle/art') { // carátulas de Spotify servidas desde aquí, para poder sacar sus colores
    if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
    return idle.art(req, res, url, send);
  }
  const a = assets.get(p);
  if (!a) return send(res, 404, 'no encontrado');
  const h = { 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': p === '/index.html' || /^\/(tpl-|tv-stage|tv-island|idle|stage\.css)/.test(p) ? 'no-cache' : 'public, max-age=86400' };
  if (p === '/index.html') h['Content-Security-Policy'] = CSP;
  else if (p.startsWith('/tpl-')) h['Content-Security-Policy'] = STAGE_CSP;
  else if (p === '/idle.html') h['Content-Security-Policy'] = IDLE_CSP;
  if (req.headers['if-none-match'] === a.etag) return send(res, 304, '', h);
  if (a.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; return send(res, 200, req.method === 'HEAD' ? '' : a.gz, h); }
  send(res, 200, req.method === 'HEAD' ? '' : a.buf, h);
}

// ───────────────────────── WebSocket
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
function onUpgrade(req, socket, head) {
  const ip = clientIp(req);
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/idle-ws') { // datos de la pantalla en reposo (solo la tele)
    if (!isLocalTV(req)) return socket.destroy();
    return idle.upgrade(req, socket, head);
  }
  if (url.pathname === '/stage-ws') { // canal de las páginas del escenario (solo la tele, sin token)
    if (!isLocalTV(req)) return socket.destroy();
    return stageWss.handleUpgrade(req, socket, head, ws => stageWss.emit('connection', ws));
  }
  if (blocked(ip) || url.pathname !== '/ws') return socket.destroy();
  const tok = url.searchParams.get('t') || cookieTok(req);
  if (!okToken(tok)) {
    fail(ip);
    return wss.handleUpgrade(req, socket, head, ws => ws.close(4001, 'token'));
  }
  const dev = tokenDev(tok);
  wss.handleUpgrade(req, socket, head, ws => { ws.devId = dev ? dev.id : null; wss.emit('connection', ws, req); });
}
const stageWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
stageWss.on('connection', ws => {
  stageClients.add(ws);
  ws.on('error', () => {});
  ws.on('close', () => stageClients.delete(ws));
  ws.on('message', (d, bin) => { if (bin) return; try { const m = JSON.parse(d.toString()); if (m.t === 'event') stageEvent(m); } catch {} });
  if (stage.data) ws.send(JSON.stringify({ t: 'data', data: stage.data }));
});
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const s = data.toString();
    const c = s.charCodeAt(0);
    if (c === 112) return ws.send(s);                                  // "p<ts>": eco para medir latencia
    if (c === 123) {
      let m; try { m = JSON.parse(s); } catch { return; }
      return void run(m, ws).then(r => { // con `id`, el resultado vuelve a quien lo pidió (sin imágenes)
        if (m.id !== undefined && ws.readyState === WebSocket.OPEN && !(r && r.data)) ws.send(JSON.stringify({ t: 'res', id: m.id, r }));
      }).catch(() => {});
    }
    idle.touch();
    if (c === 119) pollSoon();                                          // "w": scroll desde el mando, el carril se sondea más a menudo
    pointer.line(s);                                                       // "m dx dy", "w dx dy", "c 1", "b 1 1"...
  });
  ws.send(JSON.stringify(publicState()));
  ws.send(JSON.stringify(meOf(ws)));
  ws.send(JSON.stringify(focusFor(ws)));
  if (permsOf(devOf(ws)).admin) // peticiones de acceso pendientes
    for (const p of acc.pairing.pendingAsks()) ws.send(JSON.stringify({ t: 'pairreq', ...p }));
  log.info('cliente conectado', clientIp(req));
});
setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); }
}, 20_000);

// estado de la página: multimedia (reproduciendo / pausa) y posición de scroll, solo si hay alguien conectado.
// Cada 1,5 s; durante 2 s tras cada scroll del mando, cada 250 ms. Nunca dos lecturas a la vez por CDP.
let pollBusy = false, pollLast = 0, pollFastUntil = 0;
function pollSoon() { pollFastUntil = Date.now() + 2000; }
async function pollPage() {
  if (pollBusy || !wss.clients.size || !cdp.ready || !cdp.session) return;
  pollBusy = true; pollLast = Date.now();
  try {
    const r = await cdp.call('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true });
    const pr = parseProbe(r?.result?.value);                  // src/tv/devices.js
    if (!pr) return;
    let ch = false;
    if (pr.media !== null && pr.media !== state.media) { state.media = pr.media; ch = true; }
    const sc = pr.scroll;                                       // sin scroll (o sin dato): null y el mando no pinta el carril
    if (JSON.stringify(sc) !== JSON.stringify(state.scroll)) { state.scroll = sc; ch = true; }
    if (ch) broadcast();
  } catch {} finally { pollBusy = false; }
}
setInterval(() => { const now = Date.now(); if (now - pollLast >= (now < pollFastUntil ? 250 : 1500)) pollPage(); }, 250);

// ───────────────────────── arranque
function bindAddrs() {
  const out = new Set(['127.0.0.1']);
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [p, q] = a.address.split('.').map(Number);
      const priv = p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q <= 31) || (p === 100 && q >= 64 && q <= 127);
      if (priv) out.add(a.address);
    }
  }
  return [...out];
}
for (const addr of bindAddrs()) {
  const s = http.createServer(handler);
  s.on('upgrade', onUpgrade);
  s.on('error', e => log.error('no se pudo escuchar en', addr, e.code));
  s.listen(PORT, addr, () => log.info(`escuchando en http://${addr}:${PORT}/ (token maestro en remote/token; nunca se escribe en el registro)`));
}
cdp.connect();
pointer.start();
volRead();
process.on('SIGTERM', () => process.exit(0));
