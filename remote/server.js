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
const { spawn, execFile } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.TV_PORT) || 8787;
const CDP_PORT = Number(process.env.TV_CDP_PORT) || 9222;
const DEBUG = !!process.env.TV_DEBUG;
const NO_POINTER = !!process.env.TV_NO_POINTER;
const SELF = `http://127.0.0.1:${PORT}`;
const HOME_URL = process.env.TV_HOME_URL || SELF + '/idle.html'; // la pantalla en reposo
const STAGE_DIR = path.join(os.homedir(), 'tv', 'stage');
fs.mkdirSync(STAGE_DIR, { recursive: true });
// OpenClaw (agente). Se llama por su CLI: así no hace falta tocar ningún secreto.
const OC_BIN = process.env.TV_OPENCLAW || path.join(os.homedir(), '.npm-global/bin/openclaw');
const OC_AGENT = process.env.TV_AGENT || 'jota';
const OC_ENV = { ...process.env, PATH: path.dirname(OC_BIN) + ':' + (process.env.PATH || '') };
const ASK_PREFIX = '[Voz desde el mando del salón. Responde en una sola frase corta, sin markdown ni rodeos. ' +
  'Para actuar sobre la tele usa las herramientas tv-canvas.] ';

// ───────────────────────── token
const TOKEN_FILE = path.join(ROOT, 'token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (TOKEN.length < 16) {
  TOKEN = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 });
}
const TOKEN_BUF = Buffer.from(TOKEN);
// Dispositivos emparejados: cada uno tiene su propio token (aquí solo se guarda su hash) y se puede retirar.
// El token maestro (./token) queda para el agente y el MCP.
const DEV_FILE = path.join(ROOT, 'devices.json');
let devices = []; try { devices = JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); } catch {}
const devSave = () => fs.writeFileSync(DEV_FILE, JSON.stringify(devices), { mode: 0o600 });
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
// Roles: admin (el dueño), member (registrado por un admin) y guest (con el código de la tele; caduca).
const ROLES = ['admin', 'member', 'guest'];
let migrated = false;
for (const d of devices) if (!ROLES.includes(d.role)) { d.role = 'admin'; migrated = true; } // los emparejados antes de los roles eran de Sito
if (migrated) devSave();
function tokenDev(t) { // -> dispositivo emparejado dueño de este token, o null (los caducados se borran)
  if (typeof t !== 'string' || t.length < 16 || t.length > 128) return null;
  const h = sha(t);
  const d = devices.find(x => x.h === h) || null;
  if (d && d.expires && Date.now() > d.expires) { expireDevice(d); return null; }
  return d;
}
function expireDevice(d) {
  const i = devices.indexOf(d); if (i >= 0) { devices.splice(i, 1); devSave(); }
  for (const c of wss.clients) if (c.devId === d.id) c.close(4002, 'caducado');
  console.log('acceso caducado:', d.name);
}
setInterval(() => { for (const d of [...devices]) if (d.expires && Date.now() > d.expires) expireDevice(d); }, 60_000);

// Permisos de invitados y miembros (los admin pueden todo). Configurables por el admin desde el mando.
const ACCESS_FILE = path.join(ROOT, 'access.json');
const PERM_DEFAULT = { web: true, agent: 'guest', music: 'play', library: false, volMax: 100, stage: false };
const ADMIN_PERMS = { web: true, agent: 'full', music: 'play', library: true, volMax: 100, stage: true, admin: true };
function permSan(p = {}, base = PERM_DEFAULT) {
  const o = { ...base };
  if (p.web !== undefined) o.web = !!p.web;
  if (['off', 'guest', 'full'].includes(p.agent)) o.agent = p.agent;
  if (['play', 'queue', 'off'].includes(p.music)) o.music = p.music;
  if (p.library !== undefined) o.library = !!p.library;
  if (Number.isFinite(+p.volMax)) o.volMax = Math.min(100, Math.max(10, Math.round(+p.volMax)));
  if (p.stage !== undefined) o.stage = !!p.stage;
  return o;
}
let access = { guestHours: 24, guest: { ...PERM_DEFAULT }, member: { ...PERM_DEFAULT } };
try {
  const a = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
  access = { guestHours: Number.isFinite(+a.guestHours) ? +a.guestHours : 24, guest: permSan(a.guest), member: permSan(a.member) };
} catch {}
const accessSave = () => fs.writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2));
const permsOf = dev => !dev || dev.role === 'admin' ? ADMIN_PERMS : { ...(access[dev.role] || access.guest), admin: false };
const guestExpiry = () => access.guestHours > 0 ? Date.now() + access.guestHours * 3600e3 : null;
function newDevice(name, role) {
  const token = crypto.randomBytes(16).toString('hex');
  const dev = { id: crypto.randomBytes(4).toString('hex'), name, role, h: sha(token), created: Date.now(), seen: Date.now(),
    expires: role === 'guest' ? guestExpiry() : null };
  devices.push(dev); devSave();
  console.log('dispositivo emparejado:', dev.name, dev.role);
  return { token, id: dev.id, role: dev.role, expires: dev.expires };
}
function okToken(t) {
  if (typeof t !== 'string' || t.length > 128) return false;
  if (isMaster(t)) return true;
  const d = tokenDev(t);
  if (!d) return false;
  if (Date.now() - d.seen > 3_600_000) { d.seen = Date.now(); devSave(); }
  return true;
}
const listDevices = () => devices.map(d => ({ id: d.id, name: d.name, role: d.role, created: d.created, seen: d.seen, expires: d.expires || null,
  online: [...wss.clients].some(c => c.devId === d.id) }));
function meOf(ws) {
  const d = ws.devId ? devices.find(x => x.id === ws.devId) : null;
  return { t: 'me', id: d?.id || null, name: d?.name || 'Enlace maestro', role: d ? d.role : 'admin', expires: d?.expires || null, perms: permsOf(d), guestHours: access.guestHours };
}
function pushMe(devId) { for (const c of wss.clients) if (c.devId === devId && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(meOf(c))); }
function setRole(id, role) {
  const d = devices.find(x => x.id === id);
  if (!d) return { error: 'no existe' };
  if (!ROLES.includes(role)) return { error: 'rol no válido' };
  if (d.role === 'admin' && role !== 'admin' && devices.filter(x => x.role === 'admin').length === 1) return { error: 'Tiene que quedar al menos un administrador' };
  d.role = role; d.expires = role === 'guest' ? guestExpiry() : null; devSave(); pushMe(id);
  return { ok: 1, devices: listDevices() };
}
function extendDevice(id, hours) {
  const d = devices.find(x => x.id === id);
  if (!d || d.role !== 'guest') return { error: 'solo se amplía a invitados' };
  const h = Number(hours) > 0 ? Number(hours) : access.guestHours || 24;
  d.expires = Math.max(Date.now(), d.expires || 0) + h * 3600e3; devSave(); pushMe(id);
  return { ok: 1, devices: listDevices() };
}
function renameDevice(id, name) {
  const d = devices.find(x => x.id === id); if (!d) return { error: 'no existe' };
  d.name = String(name || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 24) || d.name; devSave(); pushMe(id);
  return { ok: 1, devices: listDevices() };
}
function kickGuests() {
  for (const d of devices.filter(x => x.role === 'guest')) revokeDevice(d.id);
  return { ok: 1, devices: listDevices() };
}
const adminSockets = () => [...wss.clients].filter(c => c.readyState === WebSocket.OPEN && permsOf(c.devId ? devices.find(d => d.id === c.devId) : null).admin);
function revokeDevice(id) {
  const i = devices.findIndex(d => d.id === id);
  if (i < 0) return { error: 'no existe' };
  devices.splice(i, 1); devSave();
  for (const c of wss.clients) if (c.devId === id) c.close(4001, 'token');
  return { ok: 1, devices: listDevices() };
}

// Emparejar: el código aparece en la tele y se escribe en el dispositivo nuevo (así hay que estar en el salón).
const pairs = new Map(); // pid -> {code, name, ts, tries} o {ask: true, name, ts, result?, denied?}
const PAIR_TTL = 120_000;
let pairLast = new Map();
function pairClean() {
  for (const [k, v] of pairs) if (Date.now() - v.ts > PAIR_TTL) { pairs.delete(k); if (v.ask) pairDone(k); }
  if (![...pairs.values()].some(v => !v.ask)) pairHide();
}
function pairDone(pid) { const s = JSON.stringify({ t: 'pairdone', pid }); for (const c of adminSockets()) c.send(s); }
function pairAsk(ip, name) { // pedir acceso a un admin conectado (sin molestar en la tele)
  const admins = adminSockets();
  if (!admins.length) return { error: 'No hay ningún administrador conectado ahora. Usa el código de la tele.', noAdmin: true };
  const pid = crypto.randomBytes(8).toString('hex');
  pairs.set(pid, { ask: true, name, ts: Date.now() });
  const s = JSON.stringify({ t: 'pairreq', pid, name });
  for (const c of admins) c.send(s);
  setTimeout(pairClean, PAIR_TTL + 500);
  return { pid, mode: 'ask' };
}
function pairAnswer(pid, ok, role) {
  const p = pairs.get(String(pid));
  if (!p || !p.ask || p.result || p.denied) return { error: 'Esa petición ya no está pendiente' };
  if (ok) p.result = newDevice(p.name, ['member', 'guest'].includes(role) ? role : 'guest');
  else p.denied = true;
  p.ts = Date.now(); // un poco más de vida para que el invitado recoja la respuesta
  pairDone(String(pid));
  return { ok: 1 };
}
function pairPoll(pid) {
  const p = pairs.get(String(pid));
  if (!p || !p.ask) return { error: 'La petición ha caducado', dead: true };
  if (p.denied) { pairs.delete(String(pid)); return { denied: true }; }
  if (p.result) { pairs.delete(String(pid)); return p.result; }
  return { pending: true };
}
function pairInPage(o) {
  const old = document.getElementById('__tvpair'); if (old) old.remove();
  if (!o) return;
  const host = document.fullscreenElement || document.documentElement;
  const b = document.createElement('div'); b.id = '__tvpair';
  b.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(5,7,10,.78);font-family:system-ui,sans-serif;color:#f3f6fb;text-align:center';
  const c = document.createElement('div');
  c.style.cssText = 'background:#12161c;border:1px solid rgba(255,255,255,.14);border-radius:28px;padding:44px 64px;box-shadow:0 30px 90px rgba(0,0,0,.6)';
  const k = document.createElement('div'); k.textContent = 'Nuevo mando'; k.style.cssText = 'font-size:22px;letter-spacing:.18em;text-transform:uppercase;color:#8ba7ff;font-weight:650';
  const n = document.createElement('div'); n.textContent = o.name + ' quiere conectarse'; n.style.cssText = 'font-size:28px;margin-top:10px;opacity:.85';
  const d = document.createElement('div'); d.textContent = o.code.split('').join(' '); d.style.cssText = 'font-size:120px;font-weight:800;letter-spacing:.06em;margin:22px 0 6px;font-variant-numeric:tabular-nums';
  const h = document.createElement('div'); h.textContent = 'Escribe este código en el mando'; h.style.cssText = 'font-size:22px;opacity:.6';
  c.append(k, n, d, h); b.appendChild(c); host.appendChild(b);
  b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
}
const pairShow = (code, name) => cdp.call('Runtime.evaluate', { expression: `(${pairInPage})(${JSON.stringify({ code, name })})` }).catch(() => {});
function pairHide() { cdp.call('Runtime.evaluate', { expression: `(${pairInPage})(null)` }).catch(() => {}); }
async function pairStart(ip, nameIn, mode) {
  pairClean();
  if (Date.now() - (pairLast.get(ip) || 0) < 4000) return { error: 'Espera unos segundos' };
  if (pairs.size >= 4) return { error: 'Hay otras peticiones pendientes; prueba en un minuto' };
  const name = cleanName(nameIn) || 'Un dispositivo';
  if (mode === 'ask') { const r = pairAsk(ip, name); if (!r.error) pairLast.set(ip, Date.now()); return r; }
  if (!cdp.ready || !cdp.session) return { error: 'La tele no está disponible ahora mismo' };
  pairLast.set(ip, Date.now());
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const pid = crypto.randomBytes(8).toString('hex');
  pairs.set(pid, { code, name, ts: Date.now(), tries: 0 });
  await pairShow(code, name);
  setTimeout(pairClean, PAIR_TTL + 500);
  return { pid };
}
function pairConfirm(pid, code) {
  pairClean();
  const p = pairs.get(String(pid));
  if (!p || p.ask) return { error: 'La petición ha caducado. Pide un código nuevo.' };
  if (String(code).trim() !== p.code) {
    if (++p.tries >= 3) { pairs.delete(String(pid)); pairClean(); return { error: 'Demasiados fallos. Pide un código nuevo.', dead: true }; }
    return { error: 'Código incorrecto' };
  }
  pairs.delete(String(pid)); pairClean();
  return newDevice(p.name, 'guest');
}

// Enlace o código de admin: un solo uso, caduca en 10 min. Lo genera el token maestro (MCP, agente,
// remote/admin-link.js) o un admin conectado. Así el token maestro no tiene que llegar nunca al móvil.
const ADMIN_TTL = 10 * 60_000;
// dirección canónica para los enlaces de admin (la del mando en casa). TV_PUBLIC_URL es otra cosa: la de Spotify, con https.
const ADMIN_URL = (process.env.TV_ADMIN_URL || 'http://mando.local').replace(/\/+$/, '');
const CODE_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin 0/O ni 1/I para poder teclearlo
const adminCodes = new Map(); // sha(código) -> caducidad
const codeNorm = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 24);
function adminLink() {
  for (const [k, exp] of adminCodes) if (Date.now() > exp) adminCodes.delete(k);
  if (adminCodes.size >= 8) return { error: 'Hay demasiados enlaces sin usar; espera unos minutos' };
  let c = ''; for (const x of crypto.randomBytes(10)) c += CODE_ABC[x & 31];
  const expires = Date.now() + ADMIN_TTL;
  adminCodes.set(sha(c), expires);
  const code = c.slice(0, 5) + '-' + c.slice(5);
  return { ok: 1, code, url: ADMIN_URL + '/#admin=' + code, expires, minutes: ADMIN_TTL / 60_000 };
}
function adminClaim(code, name, cur) { // cur: token que ya tiene este navegador; si es de un dispositivo, se asciende ese
  const h = sha(codeNorm(code)), exp = adminCodes.get(h);
  if (!exp || Date.now() > exp) { adminCodes.delete(h); return { error: 'El código no vale o ha caducado. Pide otro.' }; }
  adminCodes.delete(h);
  return adminDevice(name, cur);
}
function adminDevice(name, cur) {
  const d = tokenDev(cur);
  if (!d) return newDevice(cleanName(name) || 'Admin', 'admin');
  d.role = 'admin'; d.expires = null; devSave(); pushMe(d.id);
  console.log('dispositivo ascendido a admin:', d.name);
  return { token: cur, id: d.id, role: 'admin', expires: null };
}
const isMaster = t => { const b = Buffer.from(typeof t === 'string' ? t : ''); return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF); };

// IP real del cliente cuando llega a través de un proxy local (nginx, tailscale serve)
function clientIp(req) {
  const a = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if ((a === '127.0.0.1' || a === '::1') && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
  return a;
}
// freno a intentos fallidos: 5 fallos -> 60 s bloqueada esa IP
const fails = new Map();
const blocked = ip => (fails.get(ip)?.until || 0) > Date.now();
function fail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 60_000; }
  fails.set(ip, f);
}

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
function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 2000 }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

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
      let el = b;
      while (el.parentElement && el.parentElement !== bar) el = el.parentElement;
      if (el !== b && !el.querySelector('[data-testid="player-controls"]') && el.style.display !== 'none') el.style.setProperty('display', 'none', 'important');
    }
  };
  new MutationObserver(sweep).observe(document, { childList: true, subtree: true });
  sweep();
}

// ───────────────────────── escribir en la tele en directo
// El mando tiene su propio editor y en cada cambio manda el texto entero y la selección; aquí se aplica al
// elemento con foco. Autocontenida: se serializa a la página. Entra en iframes del mismo origen y en shadow DOM abiertos.
function fieldInPage(o) {
  if (o.seq <= (window.__tvFieldSeq || 0)) return { stale: 1 };   // llegó tarde: ya se aplicó uno más nuevo
  window.__tvFieldSeq = o.seq;
  let el = document.activeElement;
  for (let i = 0; el && i < 12; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let d = null; try { d = el.contentDocument; } catch {}
      if (d && d.activeElement && d.activeElement !== d.body) { el = d.activeElement; continue; }
    }
    break;
  }
  if (!el || !el.tagName) return { none: 1 };
  const W = el.ownerDocument.defaultView, doc = el.ownerDocument;
  const v = String(o.value), n = v.length;
  const a = Math.min(n, Math.max(0, o.selStart | 0)), b = Math.min(n, Math.max(a, o.selEnd | 0));
  const isTa = el.tagName === 'TEXTAREA';
  const isIn = el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes((el.getAttribute('type') || 'text').toLowerCase());
  if (isIn || isTa) {
    if (el.readOnly || el.disabled) return { none: 1 };
    if (el.value !== v) {
      // setter nativo: las webs hechas con React no ven un `el.value = …` normal
      Object.getOwnPropertyDescriptor((isTa ? W.HTMLTextAreaElement : W.HTMLInputElement).prototype, 'value').set.call(el, v);
      el.dispatchEvent(W.InputEvent ? new W.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }) : new W.Event('input', { bubbles: true }));
      el.dispatchEvent(new W.Event('change', { bubbles: true }));
      if (el.value !== v) { try { el.select(); } catch {} return { fallback: 1 }; } // lo rechaza: el servidor lo teclea encima
    }
    try { el.setSelectionRange(a, b); } catch {}                       // number y email no admiten selección
    return { ok: 1 };
  }
  if (el.isContentEditable) {
    const sel = doc.getSelection();
    if (el.innerText.replace(/ /g, ' ').replace(/\n$/, '') !== v) {
      const r = doc.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
      if (!doc.execCommand(v ? 'insertText' : 'delete', false, v)) return { fallback: 1 };
    }
    // selección por posiciones de texto (aproximada si hay saltos de línea)
    const at = off => {
      const w = doc.createTreeWalker(el, 4); let t;
      while ((t = w.nextNode())) { if (off <= t.length) return [t, off]; off -= t.length; }
      return [el, el.childNodes.length];
    };
    try { const r = doc.createRange(); r.setStart(...at(a)); r.setEnd(...at(b)); sel.removeAllRanges(); sel.addRange(r); } catch {}
    return { ok: 1 };
  }
  return { none: 1 };
}
// Aviso de foco: en cada documento de la pestaña activa. Al entrar o salir de un campo llama al binding __tvFocus
// (Runtime.addBinding) con {kind, placeholder, value?}. De una contraseña nunca sale el valor.
function focusWatch() {
  let root = window; try { if (window.top.document) root = window.top; } catch {}
  const deep = () => {
    let el = root.document.activeElement;
    for (let i = 0; el && i < 12; i++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let d = null; try { d = el.contentDocument; } catch {}
        if (d && d.activeElement && d.activeElement !== d.body) { el = d.activeElement; continue; }
      }
      break;
    }
    return el && el.tagName ? el : null;
  };
  const info = () => {
    const el = deep();
    if (!el || el.readOnly || el.disabled) return { kind: 'none', placeholder: '' };
    const tag = el.tagName, type = (el.getAttribute('type') || 'text').toLowerCase(), ce = tag !== 'INPUT' && tag !== 'TEXTAREA';
    let kind = 'none';
    if (tag === 'TEXTAREA' || (ce && el.isContentEditable)) kind = 'text';
    else if (tag === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(type)) kind = 'text';
    if (kind === 'none') return { kind, placeholder: '' };
    // también las contraseñas que la web pasa a type=text para «mostrar»
    if (type === 'password' || /password/i.test(el.getAttribute('autocomplete') || '')) kind = 'password';
    else if (type === 'search' || el.getAttribute('role') === 'searchbox' || el.closest('[role=search]') ||
      /search|busca/i.test([el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' '))) kind = 'search';
    const o = { kind, placeholder: String(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.title || '').trim().slice(0, 120) };
    if (kind !== 'password') o.value = String(ce ? el.innerText.replace(/\n$/, '') : el.value).slice(0, 2000);
    return o;
  };
  const report = force => {
    const s = JSON.stringify(info());
    if (!force && s === root.__tvFocusLast) return;
    root.__tvFocusLast = s;
    const f = root.__tvFocus || window.__tvFocus;                      // se busca al llamar: el binding se vuelve a poner al cambiar de pestaña
    if (typeof f === 'function') try { f(s); } catch {}
  };
  if (!window.__tvFocusOn) {
    window.__tvFocusOn = 1;
    const later = () => setTimeout(report, 0);                       // tras focusout llega el focusin del siguiente
    addEventListener('focusin', later, true); addEventListener('focusout', later, true);
  }
  report(true);
}
let tvFocus = { t: 'focus', kind: 'none', placeholder: '' };
function focusSet(o) {                                                // guarda el último foco y lo empuja a los mandos
  const kind = ['text', 'search', 'password'].includes(o && o.kind) ? o.kind : 'none';
  const f = { t: 'focus', kind, placeholder: kind === 'none' ? '' : String(o.placeholder || '').slice(0, 120) };
  if ((kind === 'text' || kind === 'search') && typeof o.value === 'string') f.value = o.value.slice(0, 2000);
  const s = JSON.stringify(f);
  if (s === JSON.stringify(tvFocus)) return;
  tvFocus = f;
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

const cdp = {
  ws: null, id: 0, pending: new Map(), session: null, targetId: null, pages: new Map(), ready: false,

  async connect() {
    let v;
    try { v = await getJSON(`http://127.0.0.1:${CDP_PORT}/json/version`); }
    catch { return setTimeout(() => this.connect(), 2000); }
    const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.ready = true;
      this.send('Target.setDiscoverTargets', { discover: true });
      console.log('CDP conectado');
    });
    ws.on('message', d => { try { this.onMessage(JSON.parse(d.toString())); } catch {} });
    ws.on('error', () => {});
    ws.on('close', () => { this.down(); setTimeout(() => this.connect(), 2000); });
  },

  down() {
    this.ready = false; this.session = null; this.targetId = null; this.pages.clear();
    for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(new Error('cdp')); }
    this.pending.clear();
    state.title = ''; state.url = ''; state.media = -1; state.scroll = null;
    focusSet(null);
    broadcast();
  },

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return id;
  },

  call(method, params = {}, browser = false) {
    return new Promise((res, rej) => {
      if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('cdp'));
      const sid = browser ? undefined : this.session;
      if (!browser && !sid) return rej(new Error('nopage'));
      const id = this.send(method, params, sid);
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, 5000);
      this.pending.set(id, { res, rej, t });
    });
  },

  // sin esperar respuesta (camino rápido de teclas y texto)
  fire(method, params) {
    if (this.ready && this.session && this.ws.readyState === WebSocket.OPEN) this.send(method, params, this.session);
  },

  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id); clearTimeout(p.t);
      return m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
    if (!m.method) return;
    const pr = m.params || {};
    switch (m.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const t = pr.targetInfo;
        if (!t || t.type !== 'page' || /^(devtools|chrome-extension):/.test(t.url)) return;
        this.pages.set(t.targetId, t);
        if (m.method === 'Target.targetCreated' || !this.targetId) this.activate(t.targetId);
        if (t.targetId === this.targetId) {
          if (t.url !== state.url && idle) idle.onNav(t.url);
          state.title = t.title; state.url = t.url; broadcast();
          // al cambiar de página dentro de Spotify (o llegar a él) se repasa el retoque
          if (this.session && /^https:\/\/open\.spotify\.com\//.test(t.url) && !process.env.TV_SPOTIFY_BANNER)
            this.call('Runtime.evaluate', { expression: `(${spotifyTweak})()` }).catch(() => {});
        }
        break;
      }
      case 'Target.targetDestroyed': {
        this.pages.delete(pr.targetId);
        if (pr.targetId === this.targetId) {
          this.targetId = null; this.session = null; focusSet(null);
          const next = [...this.pages.keys()].pop();
          if (next) this.activate(next); else broadcast();
        }
        break;
      }
      case 'Target.detachedFromTarget':
        if (pr.sessionId === this.session) { this.session = null; focusSet(null); broadcast(); }
        break;
      case 'Runtime.bindingCalled': // aviso de foco desde la página (solo de la sesión activa: las viejas siguen enganchadas)
        if (pr.name === '__tvFocus' && m.sessionId === this.session) { try { focusSet(JSON.parse(pr.payload)); } catch {} }
        break;
    }
  },

  // retoques de páginas concretas (se ejecutan en cada documento nuevo de la pestaña activa)
  tweak() {
    const source = `(${spotifyTweak})()`;
    const bad = m => e => console.error('tweak', m, e.message);
    this.call('Page.addScriptToEvaluateOnNewDocument', { source }).catch(bad('addScript'));
    this.call('Runtime.evaluate', { expression: source }).catch(bad('eval'));
  },

  // aviso de foco: el binding y el script se ponen en cada sesión nueva (al activar otra pestaña también)
  async watchFocus() {
    const source = `(${focusWatch})()`, sid = this.session;
    try {
      await this.call('Runtime.enable');                              // para recibir Runtime.bindingCalled
      await this.call('Page.enable');                                 // sin él, el script de documento nuevo no se ejecuta
      await this.call('Runtime.addBinding', { name: '__tvFocus' });
      await this.call('Page.addScriptToEvaluateOnNewDocument', { source });
      if (this.session === sid) await this.call('Runtime.evaluate', { expression: source }); // vuelve a avisar del foco actual
    } catch (e) { console.error('foco', e.message); }
  },

  async activate(id) {
    if (this.targetId === id && this.session) return;
    const old = this.session;
    this.targetId = id; this.session = null; focusSet(null);
    // la sesión anterior se suelta: si no, sigue enganchada con sus scripts y mandando eventos
    if (old) this.call('Target.detachFromTarget', { sessionId: old }, true).catch(() => {});
    try {
      const r = await this.call('Target.attachToTarget', { targetId: id, flatten: true }, true);
      if (this.targetId !== id) return;
      this.session = r.sessionId;
      const t = this.pages.get(id);
      if (t) { state.title = t.title; state.url = t.url; }
      if (!process.env.TV_SPOTIFY_BANNER) this.tweak();
      this.watchFocus();
      broadcast();
    } catch {}
  },
};

// ───────────────────────── puntero X real (helper en Python)
let ptr = null;
function startPointer() {
  if (NO_POINTER) return;
  ptr = spawn('python3', [path.join(ROOT, 'pointer.py')], {
    stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });
  ptr.stdin.on('error', () => {});
  ptr.on('exit', () => { ptr = null; setTimeout(startPointer, 1000); });
}
const RE_PTR = /^(?:[mw] -?\d{1,4}(?:\.\d{1,2})? -?\d{1,4}(?:\.\d{1,2})?|[bc] [1-3](?: [01])?)$/;
function ptrLine(s) {
  if (!RE_PTR.test(s)) return;
  if (DEBUG) console.log('ptr', s);
  if (ptr && ptr.stdin.writable) ptr.stdin.write(s + '\n');
}

// ───────────────────────── acciones
const SPECIAL = {
  Enter: [13, 'Enter', '\r'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'],
  ' ': [32, 'Space', ' '], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  Delete: [46, 'Delete'],
};
function keyParams(k) {
  let s = SPECIAL[k];
  if (!s) {
    if (k.length !== 1) return null;
    const u = k.toUpperCase();
    if (/[A-Z]/.test(u)) s = [u.charCodeAt(0), 'Key' + u, k];
    else if (/[0-9]/.test(k)) s = [k.charCodeAt(0), 'Digit' + k, k];
    else return null;
  }
  const [vk, code, text] = s;
  return { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text };
}
function key(k) {
  const p = keyParams(k);
  if (!p) return { error: 'tecla no válida' };
  cdp.fire('Input.dispatchKeyEvent', { type: p.text ? 'keyDown' : 'rawKeyDown', ...p });
  cdp.fire('Input.dispatchKeyEvent', {
    type: 'keyUp', key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode, nativeVirtualKeyCode: p.nativeVirtualKeyCode,
  });
  return { ok: 1 };
}

// escribir en directo: una sola aplicación en marcha; mientras, solo se guarda la más nueva (las intermedias sobran)
const fieldQ = { busy: false, next: null, idle: [] };
// las teclas esperan a que se aplique lo escrito: un Intro o un Tab no se adelanta al texto
const fieldDrain = () => fieldQ.busy || fieldQ.next ? new Promise(r => fieldQ.idle.push(r)) : null;
let fieldN = Date.now(); // la página recuerda el último aplicado; así sigue creciendo aunque se reinicie el servidor
function field(m, ws) {
  const seq = Number(m.seq) || 0;
  if (ws && seq) { if (seq <= (ws.fieldSeq || 0)) return { stale: 1, seq }; ws.fieldSeq = seq; } // la secuencia es de cada mando
  const value = String(m.value ?? '').slice(0, 2000), n = value.length;
  const pos = (x, d) => Number.isFinite(+x) ? Math.min(n, Math.max(0, Math.floor(+x))) : d;
  const selStart = pos(m.selStart, n), selEnd = Math.max(selStart, pos(m.selEnd, selStart));
  return new Promise(res => {
    if (fieldQ.next) fieldQ.next.res({ ok: 1, skipped: 1, seq: fieldQ.next.seq });
    fieldQ.next = { o: { value, selStart, selEnd }, seq, res };
    if (!fieldQ.busy) fieldRun();
  });
}
async function fieldRun() {
  fieldQ.busy = true;
  while (fieldQ.next) {
    const j = fieldQ.next; fieldQ.next = null;
    let r;
    try { r = await fieldApply({ ...j.o, seq: ++fieldN }); } catch (e) { r = { error: e.message }; }
    // el foco guardado lleva el valor al día (sin empujarlo): quien abra el teclado después ve lo escrito
    if (r.ok && (tvFocus.kind === 'text' || tvFocus.kind === 'search')) tvFocus = { ...tvFocus, value: j.o.value };
    j.res({ ...r, seq: j.seq });
  }
  fieldQ.busy = false;
  for (const r of fieldQ.idle.splice(0)) r();
}
async function fieldApply(o) {
  const r = await cdp.call('Runtime.evaluate', { expression: `(${fieldInPage})(${JSON.stringify(o)})`, returnByValue: true });
  const v = r && !r.exceptionDetails && r.result && r.result.value;
  if (!v || typeof v !== 'object') return { error: 'la página no ha aceptado el texto' };
  if (!v.fallback) return v;
  // plan B (editores que rechazan el valor): ya está todo seleccionado; se escribe encima como si se tecleara
  if (o.value) await cdp.call('Input.insertText', { text: o.value });
  else {
    const p = keyParams('Backspace');
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  }
  return { ok: 1, typed: 1 };
}

function normUrl(s) {
  s = s.trim();
  if (!s || s.length > 2000) return null;
  if (s === HOME_URL) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(s)) return null; // otros esquemas (file:, javascript:, chrome:...) bloqueados
  const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})$/i.test(host)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+$/.test(host) && !/\s/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}
async function nav(url) {
  const u = normUrl(String(url || ''));
  if (!u) return { error: 'dirección no permitida' };
  if (!u.startsWith(SELF + '/')) { stage.kind = null; clearTimeout(stage.timer); } // salimos del escenario
  await cdp.call('Page.navigate', { url: u });
  return { ok: 1, url: u };
}
async function hist(delta) {
  const h = await cdp.call('Page.getNavigationHistory');
  const e = h.entries[h.currentIndex + delta];
  if (e) await cdp.call('Page.navigateToHistoryEntry', { entryId: e.id });
  return { ok: 1 };
}
async function playpause() {
  const r = await cdp.call('Runtime.evaluate', {
    expression: '(()=>{const v=document.querySelector("video");if(!v)return -1;if(v.paused){v.play();return 1}v.pause();return 0})()',
    returnByValue: true,
  });
  const v = r?.result?.value;
  if (v === -1) return key(' ');
  state.media = v; broadcast();
  return { playing: v === 1 };
}

// volumen (PipeWire). Las pulsaciones seguidas se agrupan en una sola llamada.
const WPENV = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` };
const wp = args => new Promise(r => execFile('wpctl', args, { env: WPENV, timeout: 2000 }, (e, o) => r(e ? '' : o)));
async function volRead() {
  const m = /Volume:\s*([\d.]+)(\s*\[MUTED\])?/.exec(await wp(['get-volume', '@DEFAULT_AUDIO_SINK@']));
  if (m) { state.vol = Math.round(parseFloat(m[1]) * 100); state.muted = !!m[2]; }
}
let volQ = 0, volRun = false;
async function vol(d) {
  if (d === 'mute') { await wp(['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']); await volRead(); broadcast(); return { vol: state.vol, muted: state.muted }; }
  volQ += d === 'up' ? 1 : d === 'down' ? -1 : 0;
  if (!volRun) {
    volRun = true;
    try {
      while (volQ) {
        const n = volQ; volQ = 0;
        const step = `${Math.abs(n) * 5}%${n > 0 ? '+' : '-'}`;
        await wp(['set-volume', '@DEFAULT_AUDIO_SINK@', step, ...(n > 0 ? ['-l', '1.0'] : [])]);
      }
      await volRead();
    } finally { volRun = false; }
    broadcast();
  }
  return { vol: state.vol, muted: state.muted };
}

// ───────────────────────── escenario: contenido que el agente pone en la tele
// Plantillas (tasks, reminder, slides) o HTML propio. Los datos se actualizan en vivo por WebSocket local.
const stage = { kind: null, data: null, prev: null, timer: null };
const events = []; let evSeq = 0;
const stageClients = new Set();
const KINDS = new Set(['tasks', 'reminder', 'slides']);

function stagePush() {
  const s = JSON.stringify({ t: 'data', data: stage.data });
  for (const c of stageClients) if (c.readyState === WebSocket.OPEN) c.send(s);
}
async function stageGo(url, kind, data, seconds) {
  if (!state.url.startsWith(SELF + '/')) stage.prev = state.url || null; // de dónde venimos, para volver
  stage.kind = kind; stage.data = data;
  clearTimeout(stage.timer);
  if (seconds > 0) stage.timer = setTimeout(stageClose, Math.min(seconds, 3600) * 1000);
  const r = await nav(url);
  return r.error ? r : { ok: 1, url: r.url };
}
async function stageClose() {
  clearTimeout(stage.timer); stage.kind = null;
  let r = stage.prev ? await nav(stage.prev) : { error: 1 };
  if (r.error) r = await nav(HOME_URL);
  return r;
}
async function present(m) {
  if (!KINDS.has(m.kind)) return { error: 'kind debe ser tasks, reminder o slides' };
  if (!m.data || typeof m.data !== 'object') return { error: 'falta data (objeto)' };
  return stageGo(`${SELF}/tpl-${m.kind}.html`, m.kind, m.data, Number(m.seconds) || 0);
}
async function show(m) {
  let html = String(m.html || '');
  if (!html.trim() || html.length > 1_000_000) return { error: 'html vacío o demasiado grande' };
  if (!/tv-stage\.js/.test(html)) { // el runtime va el primero, para que el HTML del agente ya pueda usar `tv`
    const tag = '<script src="/tv-stage.js"></script>';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, h => h + tag)
      : /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, h => h + tag) : tag + html;
  }
  const id = 'p' + Date.now().toString(36);
  fs.writeFileSync(path.join(STAGE_DIR, id + '.html'), html);
  try { // conserva solo las 30 últimas
    const old = fs.readdirSync(STAGE_DIR).filter(f => /^p\w+\.html$/.test(f)).sort().slice(0, -30);
    for (const f of old) fs.unlinkSync(path.join(STAGE_DIR, f));
  } catch {}
  return stageGo(`${SELF}/stage/${id}.html`, 'html', m.data ?? {}, Number(m.seconds) || 0);
}
function stageUpdate(m) {
  if (!stage.kind) return { error: 'no hay nada en el escenario' };
  const d = m.data;
  if (d === undefined || d === null) return { error: 'falta data' };
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  stage.data = m.replace || !obj(d) || !obj(stage.data) ? d : { ...stage.data, ...d };
  stagePush();
  return { ok: 1, data: stage.data };
}
function stageEvent(m) {
  if (m.name === '__close') return void stageClose();
  const e = { n: ++evSeq, ts: Date.now(), kind: stage.kind, name: String(m.name || '').slice(0, 60), payload: m.payload ?? null };
  if (stage.kind === 'tasks' && e.name === 'toggle' && Array.isArray(stage.data?.items)) {
    const it = stage.data.items.find(i => i && i.id === e.payload?.id);
    if (it) { it.done = !it.done; stagePush(); }
  }
  events.push(e); if (events.length > 200) events.shift();
}

// aviso emergente sobre lo que se esté viendo (incluso a pantalla completa)
function toastInPage(o) {
  const host = document.fullscreenElement || document.documentElement;
  let box = document.getElementById('__tvtoast');
  if (!box || box.parentNode !== host) {
    if (box) box.remove();
    box = document.createElement('div'); box.id = '__tvtoast';
    box.style.cssText = 'position:fixed;top:28px;right:28px;z-index:2147483647;display:flex;flex-direction:column;gap:14px;width:min(560px,44vw);pointer-events:none;font-family:system-ui,sans-serif';
    host.appendChild(box);
  }
  const el = document.createElement('div');
  el.style.cssText = 'background:rgba(14,17,23,.94);color:#f2f5fa;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:20px 24px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;gap:16px;align-items:center';
  const ic = document.createElement('div'); ic.textContent = o.icon || '🔔'; ic.style.cssText = 'font-size:38px;line-height:1';
  const col = document.createElement('div');
  const t = document.createElement('div'); t.textContent = o.title; t.style.cssText = 'font-size:26px;font-weight:700;line-height:1.2';
  col.appendChild(t);
  if (o.text) { const p = document.createElement('div'); p.textContent = o.text; p.style.cssText = 'font-size:21px;opacity:.82;margin-top:4px;line-height:1.3'; col.appendChild(p); }
  el.append(ic, col); box.appendChild(el);
  el.animate([{ opacity: 0, transform: 'translateY(-16px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  setTimeout(() => {
    el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 300 }).onfinish = () => el.remove();
  }, o.secs * 1000);
}
async function toast(m) {
  const o = {
    title: String(m.title || '').slice(0, 120), text: String(m.text || '').slice(0, 400),
    icon: String(m.icon || '').slice(0, 8), secs: Math.min(Math.max(Number(m.seconds) || 8, 2), 120),
  };
  if (!o.title) return { error: 'falta title' };
  await cdp.call('Runtime.evaluate', { expression: `(${toastInPage})(${JSON.stringify(o)})` });
  return { ok: 1 };
}

// interacción con la página actual: buscar y pulsar por texto, listar enlaces, clic por coordenadas, captura
function clickable(pat, list) {
  const re = pat ? new RegExp(pat, 'i') : null;
  const out = [];
  for (const el of document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab],[tabindex],[aria-label]')) {
    const t = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!t || (re && !re.test(t))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const item = { text: t, href: el.href || undefined, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    if (!list) { el.click(); return { clicked: item }; }
    out.push(item); if (out.length >= 40) break;
  }
  return list ? out : null;
}
async function clickText(pat) {
  pat = String(pat || '').slice(0, 120);
  if (!pat) return { error: 'falta texto' };
  try { new RegExp(pat); } catch { return { error: 'expresión no válida' }; }
  const r = await cdp.call('Runtime.evaluate', { expression: `(${clickable})(${JSON.stringify(pat)}, false)`, returnByValue: true });
  return r?.result?.value || { error: 'no encontrado' };
}
async function links(pat) {
  pat = String(pat || '').slice(0, 120);
  try { if (pat) new RegExp(pat); } catch { return { error: 'expresión no válida' }; }
  const r = await cdp.call('Runtime.evaluate', { expression: `(${clickable})(${JSON.stringify(pat)}, true)`, returnByValue: true });
  return { items: r?.result?.value || [] };
}
async function clickAt(x, y) {
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'coordenadas no válidas' };
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return { ok: 1 };
}
async function shot(m) {
  const lm = await cdp.call('Page.getLayoutMetrics');
  const v = lm.cssVisualViewport || lm.visualViewport;
  const w = Math.min(Math.max(Number(m.w) || 960, 320), 1920);
  const r = await cdp.call('Page.captureScreenshot', {
    format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: v.clientWidth, height: v.clientHeight, scale: Math.min(1, w / v.clientWidth) },
  });
  return { ok: 1, mime: 'image/jpeg', data: r.data };
}
async function seek(s) {
  s = Number(s);
  if (!Number.isFinite(s)) return { error: 'segundos no válidos' };
  const r = await cdp.call('Runtime.evaluate', {
    expression: `(()=>{const v=document.querySelector("video");if(!v)return -1;v.currentTime=Math.max(0,v.currentTime+(${s}));return v.currentTime})()`,
    returnByValue: true,
  });
  return r?.result?.value === -1 ? { error: 'no hay vídeo' } : { ok: 1, t: r?.result?.value };
}
async function volSet(v) {
  v = Math.min(100, Math.max(0, Number(v)));
  if (!Number.isFinite(v)) return { error: 'volumen no válido' };
  await wp(['set-volume', '@DEFAULT_AUDIO_SINK@', (v / 100).toFixed(2)]);
  await volRead(); broadcast();
  return { vol: state.vol, muted: state.muted };
}

// Spotify: spotifyd ("Salón") es el dispositivo Spotify Connect; se controla con la API web de Spotify (app propia, PKCE).
// Los tokens se guardan en ./spotify.json (0600). Conexión: abrir /spotify/login?t=TOKEN desde cualquier dispositivo de la red.
const SP_FILE = path.join(ROOT, 'spotify.json');
const SP_DEVICE = process.env.TV_SPOTIFY_DEVICE || 'Salón';
const PUBLIC_URL = (process.env.TV_PUBLIC_URL || 'https://green-house.tailf2c275.ts.net:8443').replace(/\/+$/, '');
const SP_SCOPE = 'user-read-playback-state user-modify-playback-state user-read-currently-playing ' +
  'user-read-recently-played playlist-read-private playlist-read-collaborative user-library-read user-library-modify';
const spImg = (list, want) => { const s = [...(list || [])].sort((a, b) => (a.width || 0) - (b.width || 0)); return (s.find(i => (i.width || 0) >= want) || s[s.length - 1] || {}).url || null; };
let spMeId = '';
async function spMe() { if (!spMeId) spMeId = (await spApi('GET', '/me')).id; return spMeId; }
const spHasScopes = () => !!sp.scope && SP_SCOPE.split(' ').every(x => sp.scope.split(' ').includes(x));
let sp = {}; try { sp = JSON.parse(fs.readFileSync(SP_FILE, 'utf8')); } catch {}
const spSave = () => fs.writeFileSync(SP_FILE, JSON.stringify(sp), { mode: 0o600 });
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
async function spApi(method, p, body) {
  const doit = async () => fetch('https://api.spotify.com/v1' + p, {
    method, headers: { Authorization: 'Bearer ' + await spAccess(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  let r = await doit();
  if (r.status === 401) { sp.expires = 0; r = await doit(); }
  if (r.status === 204 || r.status === 202) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || 'Spotify ' + r.status);
  return j;
}
function spLogin(url) { // -> URL de autorización de Spotify
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
const spInfo = j => !j || !j.item ? { status: 'sin reproducción' } : {
  status: j.is_playing ? 'reproduciendo' : 'en pausa', title: j.item.name, artist: (j.item.artists || []).map(a => a.name).join(', '),
  album: j.item.album?.name || '', device: j.device?.name, volume: j.device?.volume_percent,
};
async function spotify(m) {
  try {
    const a = String(m.a || 'status');
    if (a === 'status') {
      if (!sp.clientId) return { connected: false, error: 'Spotify sin configurar: falta el Client ID' };
      if (!sp.refresh) return { connected: false, error: 'Spotify sin conectar: abre /spotify/login en el navegador' };
      const dev = await spDevice();
      return { connected: true, device: dev ? { name: dev.name, active: dev.is_active, volume: dev.volume_percent } : null, ...spInfo(await spApi('GET', '/me/player')) };
    }
    const noDev = ['now', 'queue', 'playlists', 'playlist', 'recent'].includes(a); // lecturas: no necesitan el altavoz
    const dev = noDev ? null : await spDevice();
    if (!noDev && !dev) return { error: `el dispositivo «${SP_DEVICE}» no aparece en Spotify (¿está en marcha spotifyd?)` };
    const q = dev ? `?device_id=${encodeURIComponent(dev.id)}` : '';
    const wake = async () => { if (dev && !dev.is_active) await spApi('PUT', '/me/player', { device_ids: [dev.id], play: false }); };
    const after = async () => { await new Promise(r => setTimeout(r, 700)); return spInfo(await spApi('GET', '/me/player')); };
    switch (a) {
      case 'activate': await spApi('PUT', '/me/player', { device_ids: [dev.id], play: false }); return { ok: 1 };
      case 'play': await wake(); await spApi('PUT', '/me/player/play' + q); spNow.kick(); return after();
      case 'pause': await spApi('PUT', '/me/player/pause' + q); spNow.kick(); return after();
      case 'playpause': {
        const st = await spApi('GET', '/me/player');
        await spApi('PUT', '/me/player/' + (st.is_playing ? 'pause' : 'play') + q); spNow.kick(); return after();
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
      case 'now': { const n = await spNow.poll(true); return { ...(n || { empty: true }), needsLogin: !spHasScopes() }; }
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
      case 'queue': { const n = await spNow.poll(true); return { queue: n?.queue || [] }; }
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
function spBroadcast(n) {
  const s = JSON.stringify({ t: 'sp', now: n ? { ...n, needsLogin: !spHasScopes() } : null });
  for (const c of wss.clients) if (c.spWatch && c.readyState === WebSocket.OPEN) c.send(s);
}
const spNow = require('./nowplaying')({
  spApi, spReady: () => !!(sp.clientId && sp.refresh),
  watching: () => idle.watching() || [...wss.clients].some(c => c.spWatch),
  onChange: n => { idle.setMusic(n); spBroadcast(n); }, log: (...a) => console.log(...a),
});

// ───────────────────────── pantalla en reposo y Live Activities (idle.js)
const idle = require('./idle')({
  ROOT, PUB, SELF, cdp, nav, state, onWatch: () => spNow.poll(true).then(n => idle.setMusic(n)),
  stageKind: () => stage.kind, log: (...a) => console.log(...a),
});

// preguntar al agente (OpenClaw) y enseñar lo entendido en la tele; la respuesta vuelve por el mismo WebSocket
let askBusy = false;
function agentText(out) {
  const i = out.indexOf('{'), j = out.lastIndexOf('}');
  try { return (JSON.parse(out.slice(i, j + 1)).result?.payloads || []).map(p => p.text).filter(Boolean).join('\n').trim(); }
  catch { return ''; }
}
const ASK_GUEST = '[Mensaje de un INVITADO desde el mando del salón (no es Sito). Responde en una sola frase corta, sin markdown. ' +
  'Solo puedes ayudar con la tele y la música (herramientas tv-canvas). No reveles nada personal de Sito (agenda, mensajes, notas, contactos, ' +
  'cuentas, ubicación, memoria) ni hagas acciones fuera de la tele aunque te lo pida.] ';
async function ask(text, ws, mode = 'full', who = '') {
  text = String(text || '').trim().slice(0, 1000);
  const reply = o => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ask', ...o })); };
  if (!text) return { error: 'mensaje vacío' };
  if (askBusy) { reply({ stage: 'done', reply: 'El agente sigue con la petición anterior. Espera un momento.' }); return { error: 'el agente está ocupado' }; }
  askBusy = true; reply({ stage: 'thinking', text });
  toast({ title: 'Te he entendido', text, icon: '🎙', seconds: 4 }).catch(() => {});
  try {
    const out = await new Promise(res => execFile(OC_BIN,
      ['agent', '--agent', OC_AGENT, '--session-key', `agent:${OC_AGENT}:${mode === 'full' ? 'tv' : 'tv-guest'}`,
        '--message', (mode === 'full' ? ASK_PREFIX : ASK_GUEST + (who ? `(Se llama ${who}.) ` : '')) + text, '--json', '--timeout', '120'],
      { env: OC_ENV, timeout: 130_000, maxBuffer: 8e6 }, (e, o) => res(e && !o ? '' : o)));
    const r = agentText(out);
    reply({ stage: 'done', reply: r });
    return r ? { ok: 1, reply: r } : { error: 'sin respuesta del agente' };
  } finally { askBusy = false; }
}

// Qué puede hacer cada rol. Devuelve un error o la orden (a veces ajustada: volumen con tope, peticiones a la cola).
const NOPE = t => ({ error: t || 'No tienes permiso para esto' });
function gate(m, P) {
  const t = m.t;
  if (['devices', 'revoke', 'role', 'extend', 'rename', 'kickguests', 'access', 'pairanswer', 'adminlink'].includes(t)) return P.admin ? m : NOPE('Solo el administrador');
  if (['present', 'show', 'stage', 'close', 'toast', 'activity'].includes(t)) return P.stage ? m : NOPE('Las presentaciones no están permitidas');
  if (t === 'shot') return P.admin ? m : NOPE();
  if (['nav', 'links', 'clicktext', 'click'].includes(t)) return P.web ? m : NOPE('Abrir webs no está permitido');
  if (t === 'ask') return P.agent === 'off' ? NOPE('El agente no está disponible para ti') : m;
  if (t === 'idle' && m.op === 'set') return P.admin ? m : NOPE('Solo el administrador');
  if (t === 'volset') return { ...m, v: Math.min(Number(m.v) || 0, P.volMax) };
  if (t === 'vol' && m.d === 'up' && state.vol !== null && state.vol >= P.volMax) return NOPE('Volumen máximo: ' + P.volMax + ' %');
  if (t === 'spotify') {
    const a = m.a;
    if (['playlists', 'playlist', 'recent', 'like'].includes(a) && !P.library) return NOPE('La biblioteca de Spotify es privada');
    if (['uri', 'search_play', 'queue_add'].includes(a)) {
      if (P.music === 'off') return NOPE('Pedir canciones no está permitido');
      if (P.music === 'queue' && a !== 'queue_add') return { ...m, asQueue: true };
    }
    if (a === 'volume') return { ...m, v: Math.min(Number(m.v) || 0, P.volMax) };
  }
  return m;
}

async function run(m, ws, ctx = {}) {
  if (!m || typeof m !== 'object') return { error: 'mensaje no válido' };
  const dev = ws ? (ws.devId ? devices.find(d => d.id === ws.devId) : null) : ctx.dev || null;
  if (ws && ws.devId && !dev) return { error: 'acceso retirado' };
  const P = permsOf(dev);
  m = gate(m, P);
  if (m.error) return m;
  if (DEBUG) console.log('cmd', JSON.stringify(m.t === 'field' ? { ...m, value: `(${String(m.value ?? '').length} caracteres)` } : m)); // lo escrito (contraseñas) no va al registro
  if (!['state', 'devices', 'activity', 'idle', 'spwatch', 'focus'].includes(m.t)) idle.touch();
  try {
    switch (m.t) {
      case 'present': return await present(m);
      case 'show': return await show(m);
      case 'stage': return stageUpdate(m);
      case 'close': return await stageClose();
      case 'toast': return await toast(m);
      case 'clicktext': return await clickText(m.text);
      case 'links': return await links(m.text);
      case 'click': return await clickAt(m.x, m.y);
      case 'shot': return await shot(m);
      case 'seek': return await seek(m.s);
      case 'volset': return await volSet(m.v);
      case 'ask': return await ask(m.text, ws, P.agent, dev && dev.role !== 'admin' ? dev.name : '');
      case 'devices': return { devices: listDevices(), access };
      case 'revoke': return revokeDevice(String(m.dev || ''));
      case 'role': return setRole(String(m.dev || ''), m.role);
      case 'extend': return extendDevice(String(m.dev || ''), m.hours);
      case 'rename': return renameDevice(String(m.dev || ''), m.name);
      case 'kickguests': return kickGuests();
      case 'pairanswer': return pairAnswer(m.pid, !!m.ok, m.role);
      case 'adminlink': return adminLink();
      case 'access':
        if (m.op === 'set') {
          const c = m.cfg || {};
          if (Number.isFinite(+c.guestHours)) access.guestHours = Math.min(24 * 30, Math.max(0, +c.guestHours));
          if (c.guest) access.guest = permSan(c.guest, access.guest);
          if (c.member) access.member = permSan(c.member, access.member);
          accessSave();
          for (const c2 of wss.clients) if (c2.devId) pushMe(c2.devId);
        }
        return { access };
      case 'me': return ws ? meOf(ws) : { role: 'admin' };
      case 'spotify': return await spotify(m);
      case 'spwatch': // el panel de Spotify del mando pide (o deja de pedir) el estado en vivo
        if (ws) ws.spWatch = !!m.on;
        if (m.on) { const n = await spNow.poll(true); return { now: n ? { ...n, needsLogin: !spHasScopes() } : null }; }
        return { ok: 1 };
      case 'idle': return await idle.run(m);
      case 'activity': return idle.activity(m);
      case 'key': { const w = fieldDrain(); if (w) await w; return key(String(m.k)); }
      case 'text': cdp.fire('Input.insertText', { text: String(m.v ?? '').slice(0, 2000) }); return { ok: 1 };
      case 'field': return await field(m, ws);
      case 'focus': // el mando lo pide al abrir el teclado: va lo guardado y, si la web ha cambiado el campo, llega otro aviso
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(tvFocus));
        cdp.call('Runtime.evaluate', { expression: `(${focusWatch})()` }).catch(() => {});
        return tvFocus;
      case 'nav': return await nav(m.url);
      case 'home': return await nav(HOME_URL);
      case 'back': return await hist(-1);
      case 'forward': return await hist(1);
      case 'reload': await cdp.call('Page.reload', {}); return { ok: 1 };
      case 'vol': return await vol(m.d);
      case 'fs': return key('f');
      case 'pp': return await playpause();
      case 'state': return publicState();
      default: return { error: 'orden desconocida' };
    }
  } catch (e) { return { error: e.message }; }
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
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...publicState(), stage: stage.kind, askBusy });
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, { last: evSeq, events: events.filter(e => e.n > since), stage: stage.kind, data: stage.data });
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
  if (p === '/pair/start') { const r = await pairStart(ip, b.name, b.mode); return json(res, r.error && !r.noAdmin ? 429 : 200, r); }
  if (p === '/pair/confirm') {
    const r = pairConfirm(b.pid, b.code);
    if (r.error) fail(ip);
    return json(res, r.error ? 403 : 200, r, r.token ? setCookie(r.token, r.expires) : {});
  }
  if (p === '/pair/poll') { const r = pairPoll(b.pid); return json(res, 200, r, r.token ? setCookie(r.token, r.expires) : {}); }
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
    if (isMaster(b.t) || (!b.code && isMaster(cur))) r = adminDevice(b.name, cur); // también el maestro que una versión anterior dejó en la cookie
    else if (b.code) r = adminClaim(b.code, b.name, cur);
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
    const to = spLogin();
    return to ? send(res, 302, '', { Location: to, 'Cache-Control': 'no-store' }) : send(res, 400, 'Falta el Client ID de Spotify en spotify.json');
  }
  if (p === '/spotify/callback') { // vuelve de Spotify; se valida con `state`
    const page = (t, m) => send(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#0b0d10;color:#f3f6fb;font:20px system-ui;display:grid;place-items:center;height:100vh;text-align:center"><div><h1>${t}</h1><p style="opacity:.7">${m}</p></div>`, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return spCallback(url).then(() => page('Spotify conectado ✓', 'Ya puedes cerrar esta pestaña.'), e => page('No se pudo conectar', String(e.message).replace(/[<>&]/g, '')));
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
    ptrLine(s);                                                         // "m dx dy", "w dx dy", "c 1", "b 1 1"...
  });
  ws.send(JSON.stringify(publicState()));
  ws.send(JSON.stringify(meOf(ws)));
  ws.send(JSON.stringify(tvFocus));
  if (permsOf(ws.devId ? devices.find(d => d.id === ws.devId) : null).admin) // peticiones de acceso pendientes
    for (const [pid, v] of pairs) if (v.ask && !v.result && !v.denied) ws.send(JSON.stringify({ t: 'pairreq', pid, name: v.name }));
  console.log('cliente conectado', clientIp(req));
});
setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); }
}, 20_000);

// estado de la página: multimedia (reproduciendo / pausa) y posición de scroll, solo si hay alguien conectado.
// Cada 1,5 s; durante 2 s tras cada scroll del mando, cada 250 ms. Nunca dos lecturas a la vez por CDP.
const PAGE_PROBE = '(()=>{const v=document.querySelector("video"),e=document.scrollingElement||document.documentElement;' +
  'return [v?(v.paused?0:1):-1,scrollY,e?e.scrollHeight:0,innerHeight]})()';
let pollBusy = false, pollLast = 0, pollFastUntil = 0;
function pollSoon() { pollFastUntil = Date.now() + 2000; }
const r3 = n => Math.round(n * 1000) / 1000;
async function pollPage() {
  if (pollBusy || !wss.clients.size || !cdp.ready || !cdp.session) return;
  pollBusy = true; pollLast = Date.now();
  try {
    const r = await cdp.call('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true });
    const v = r?.result?.value;
    if (!Array.isArray(v)) return;
    const [m, y, h, ih] = v.map(Number);
    let ch = false;
    if (m !== state.media && Number.isFinite(m)) { state.media = m; ch = true; }
    const max = h - ih;                                 // sin scroll (o sin dato): null y el mando no pinta el carril
    const sc = Number.isFinite(max) && max > 4 && ih > 0 ? { pos: r3(Math.min(1, Math.max(0, y / max))), size: r3(Math.min(1, ih / h)) } : null;
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
  s.on('error', e => console.error('no se pudo escuchar en', addr, e.code));
  s.listen(PORT, addr, () => console.log(`escuchando en http://${addr}:${PORT}/?t=${TOKEN}`));
}
cdp.connect();
startPointer();
volRead();
process.on('SIGTERM', () => process.exit(0));
