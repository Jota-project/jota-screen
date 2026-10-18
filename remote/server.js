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
const OC_BIN = process.env.TV_OPENCLAW || path.join(os.homedir(), '.nvm/versions/node/v24.22.0/bin/openclaw');
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
function tokenDev(t) { // -> dispositivo emparejado dueño de este token, o null
  if (typeof t !== 'string' || t.length < 16 || t.length > 128) return null;
  const h = sha(t);
  return devices.find(d => d.h === h) || null;
}
function okToken(t) {
  if (typeof t !== 'string' || t.length > 128) return false;
  const b = Buffer.from(t);
  if (b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF)) return true;
  const d = tokenDev(t);
  if (!d) return false;
  if (Date.now() - d.seen > 3_600_000) { d.seen = Date.now(); devSave(); }
  return true;
}
const listDevices = () => devices.map(d => ({ id: d.id, name: d.name, created: d.created, seen: d.seen }));
function revokeDevice(id) {
  const i = devices.findIndex(d => d.id === id);
  if (i < 0) return { error: 'no existe' };
  devices.splice(i, 1); devSave();
  for (const c of wss.clients) if (c.devId === id) c.close(4001, 'token');
  return { ok: 1, devices: listDevices() };
}

// Emparejar: el código aparece en la tele y se escribe en el dispositivo nuevo (así hay que estar en el salón).
const pairs = new Map(); // pid -> {code, name, ts, tries}
const PAIR_TTL = 120_000;
let pairLast = new Map();
function pairClean() { for (const [k, v] of pairs) if (Date.now() - v.ts > PAIR_TTL) pairs.delete(k); if (!pairs.size) pairHide(); }
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
async function pairStart(ip, nameIn) {
  pairClean();
  if (!cdp.ready || !cdp.session) return { error: 'La tele no está disponible ahora mismo' };
  if (Date.now() - (pairLast.get(ip) || 0) < 4000) return { error: 'Espera unos segundos' };
  if (pairs.size >= 3) return { error: 'Hay otras peticiones pendientes; prueba en un minuto' };
  pairLast.set(ip, Date.now());
  const name = String(nameIn || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 24) || 'Un dispositivo';
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
  if (!p) return { error: 'La petición ha caducado. Pide un código nuevo.' };
  if (String(code).trim() !== p.code) {
    if (++p.tries >= 3) { pairs.delete(String(pid)); pairClean(); return { error: 'Demasiados fallos. Pide un código nuevo.', dead: true }; }
    return { error: 'Código incorrecto' };
  }
  pairs.delete(String(pid)); pairClean();
  const token = crypto.randomBytes(16).toString('hex');
  const dev = { id: crypto.randomBytes(4).toString('hex'), name: p.name, h: sha(token), created: Date.now(), seen: Date.now() };
  devices.push(dev); devSave();
  console.log('dispositivo emparejado:', dev.name);
  return { token, id: dev.id };
}

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
const state = { title: '', url: '', vol: null, muted: false, media: -1 };
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
function publicState() {
  return {
    t: 'state', title: state.title, url: state.url, host: hostOf(state.url),
    vol: state.vol, muted: state.muted, media: state.media, cdp: !!(cdp.ready && cdp.session),
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
    state.title = ''; state.url = ''; state.media = -1;
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
          this.targetId = null; this.session = null;
          const next = [...this.pages.keys()].pop();
          if (next) this.activate(next); else broadcast();
        }
        break;
      }
      case 'Target.detachedFromTarget':
        if (pr.sessionId === this.session) { this.session = null; broadcast(); }
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

  async activate(id) {
    if (this.targetId === id && this.session) return;
    this.targetId = id; this.session = null;
    try {
      const r = await this.call('Target.attachToTarget', { targetId: id, flatten: true }, true);
      if (this.targetId !== id) return;
      this.session = r.sessionId;
      const t = this.pages.get(id);
      if (t) { state.title = t.title; state.url = t.url; }
      if (!process.env.TV_SPOTIFY_BANNER) this.tweak();
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
    const noDev = ['now', 'queue', 'playlists', 'recent'].includes(a); // lecturas: no necesitan el altavoz
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
        const mm = /^spotify:(track|album|playlist|artist|show|episode):[A-Za-z0-9]{22}$/.exec(uri);
        if (!mm) return { error: 'enlace o URI de Spotify no válido' };
        await wake();
        const off = /^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(m.offset || '') ? { offset: { uri: m.offset } } : {};
        await spApi('PUT', '/me/player/play' + q, mm[1] === 'track' || mm[1] === 'episode' ? { uris: [uri] } : { context_uri: uri, ...off });
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
        const j = await spApi('GET', '/me/playlists?limit=40');
        return { items: (j.items || []).filter(Boolean).map(p => ({ name: p.name, uri: p.uri, by: p.owner?.display_name || '', image: (p.images || []).slice(-1)[0]?.url || (p.images || [])[0]?.url || null, count: p.items?.total ?? p.tracks?.total ?? null })) };
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
async function ask(text, ws) {
  text = String(text || '').trim().slice(0, 1000);
  const reply = o => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ask', ...o })); };
  if (!text) return { error: 'mensaje vacío' };
  if (askBusy) { reply({ stage: 'done', reply: 'El agente sigue con la petición anterior. Espera un momento.' }); return { error: 'el agente está ocupado' }; }
  askBusy = true; reply({ stage: 'thinking', text });
  toast({ title: 'Te he entendido', text, icon: '🎙', seconds: 4 }).catch(() => {});
  try {
    const out = await new Promise(res => execFile(OC_BIN,
      ['agent', '--agent', OC_AGENT, '--session-key', `agent:${OC_AGENT}:tv`, '--message', ASK_PREFIX + text, '--json', '--timeout', '120'],
      { env: OC_ENV, timeout: 130_000, maxBuffer: 8e6 }, (e, o) => res(e && !o ? '' : o)));
    const r = agentText(out);
    reply({ stage: 'done', reply: r });
    return r ? { ok: 1, reply: r } : { error: 'sin respuesta del agente' };
  } finally { askBusy = false; }
}

async function run(m, ws) {
  if (!m || typeof m !== 'object') return { error: 'mensaje no válido' };
  if (DEBUG) console.log('cmd', JSON.stringify(m));
  if (!['state', 'devices', 'activity', 'idle', 'spwatch'].includes(m.t)) idle.touch();
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
      case 'ask': return await ask(m.text, ws);
      case 'devices': return { devices: listDevices() };
      case 'revoke': return revokeDevice(String(m.dev || ''));
      case 'spotify': return await spotify(m);
      case 'spwatch': // el panel de Spotify del mando pide (o deja de pedir) el estado en vivo
        if (ws) ws.spWatch = !!m.on;
        if (m.on) { const n = await spNow.poll(true); return { now: n ? { ...n, needsLogin: !spHasScopes() } : null }; }
        return { ok: 1 };
      case 'idle': return await idle.run(m);
      case 'activity': return idle.activity(m);
      case 'key': return key(String(m.k));
      case 'text': cdp.fire('Input.insertText', { text: String(m.v ?? '').slice(0, 2000) }); return { ok: 1 };
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
const CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: https://*.scdn.co https://*.spotifycdn.com; manifest-src 'self'; base-uri 'none'; form-action 'none'";
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
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

async function api(req, res, url, ip) {
  if (blocked(ip)) return send(res, 429, 'demasiados intentos');
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t');
  if (!okToken(tok)) { fail(ip); return send(res, 401, 'no autorizado'); }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...publicState(), stage: stage.kind, askBusy });
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, { last: evSeq, events: events.filter(e => e.n > since), stage: stage.kind, data: stage.data });
  }
  if (req.method === 'POST' && url.pathname === '/api/cmd') {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 1_200_000) return send(res, 413, 'demasiado grande'); chunks.push(c); }
    let m; try { m = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'JSON no válido' }); }
    const r = await run(m);
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
  if (p === '/pair/start') { const r = await pairStart(ip, b.name); return json(res, r.error ? 429 : 200, r); }
  if (p === '/pair/confirm') {
    const r = pairConfirm(b.pid, b.code);
    if (r.error) fail(ip);
    return json(res, r.error ? 403 : 200, r);
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

  // manifiesto dinámico: si llega el token, el acceso directo instalado lo conserva
  if (p === '/manifest.webmanifest' && assets.has(p)) {
    const man = JSON.parse(assets.get(p).buf.toString());
    const mt = url.searchParams.get('t'); if (okToken(mt)) man.start_url = '/?t=' + encodeURIComponent(mt);
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
  if (!okToken(url.searchParams.get('t'))) {
    fail(ip);
    return wss.handleUpgrade(req, socket, head, ws => ws.close(4001, 'token'));
  }
  const dev = tokenDev(url.searchParams.get('t'));
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
    ptrLine(s);                                                         // "m dx dy", "w dx dy", "c 1", "b 1 1"...
  });
  ws.send(JSON.stringify(publicState()));
  console.log('cliente conectado', clientIp(req));
});
setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); }
}, 20_000);

// estado multimedia (reproduciendo / pausa), solo si hay alguien conectado
setInterval(async () => {
  if (!wss.clients.size || !cdp.ready || !cdp.session) return;
  try {
    const r = await cdp.call('Runtime.evaluate', {
      expression: '(()=>{const v=document.querySelector("video");return v?(v.paused?0:1):-1})()', returnByValue: true,
    });
    const m = r?.result?.value;
    if (typeof m === 'number' && m !== state.media) { state.media = m; broadcast(); }
  } catch {}
}, 1500);

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
