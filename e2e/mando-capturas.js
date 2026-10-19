// Red de seguridad del mando (remote/public/index.html): capturas deterministas de cada pantalla y hoja, y registro de
// las órdenes que manda por WebSocket (y de los POST /pair/*) en un recorrido fijo. Sirve para comparar antes/después
// de un refactor con e2e/mando-compara.py.
//
// Uso:  node e2e/mando-capturas.js [carpeta-salida]       (por defecto e2e/capturas-mando)
//       NODE_PATH=/ruta/a/node_modules si playwright no está en e2e/node_modules; CHROME=/ruta para otro navegador.
//
// Arranca el servidor real aislado (test/helpers/server.js) con un Chrome falso (test/helpers/fake-cdp.js) y un wpctl
// falso (volumen 35 %), y abre el mando en un móvil de 390×844 a 2x, en tema oscuro y claro. Determinista: hora fija,
// Math.random fijo, movimiento reducido y animaciones desactivadas en la captura, fuentes de Google servidas en local, sin
// el eco de latencia («p<ts>», no se manda). Todo se maneja desde fuera (roles y nombres accesibles, texto visible y
// mensajes del servidor inyectados en el WebSocket), así que vale igual con el script en línea o partido en módulos.
// Falla si la página lanza un error (pageerror) o hay una violación de la CSP.
'use strict';
/* global localStorage, PointerEvent */ // se usan dentro de la página
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { start } = require('../test/helpers/server');
const { startFakeCdp } = require('../test/helpers/fake-cdp');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'capturas-mando'));
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.(png|txt)$/.test(f)) fs.rmSync(path.join(OUT, f));

// hora fija, en el futuro: los dispositivos de devices.json no caducan con el reloj real del servidor y, como su «último uso»
// queda por delante del reloj real, el servidor no lo renueva (así «hace 2 h» sale siempre igual). Por eso el admin también
// va en devices.json: uno emparejado ahora con POST /pair/admin tendría la fecha real y su «último uso» cambiaría cada día.
const NOW = Date.parse('2030-01-15T10:00:00+01:00');
const H = 3600e3;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const GUEST_TOKEN = 'e2e0guest0000000000000000000000a';
const MEMBER_TOKEN = 'e2e0member000000000000000000000b';
const ADMIN_TOKEN = 'e2e0admin0000000000000000000000c';
const DEVICES = [
  { id: 'e2e00000', name: 'Móvil de Sito', role: 'admin', h: sha(ADMIN_TOKEN), created: NOW - 90 * 24 * H, seen: NOW - 5 * 60e3, expires: null },
  { id: 'e2e00001', name: 'Tablet de la cocina', role: 'member', h: sha(MEMBER_TOKEN), created: NOW - 30 * 24 * H, seen: NOW - 26 * H, expires: null },
  { id: 'e2e00002', name: 'Móvil de Ana', role: 'guest', h: sha(GUEST_TOKEN), created: NOW - 3 * H, seen: NOW - 2 * H, expires: NOW + 20 * H },
];
// invitados con poco permiso: sin webs, sin agente, canciones a la cola, sin biblioteca y volumen hasta el 60 %
const ACCESS = { guestHours: 24, guest: { web: false, agent: 'off', music: 'queue', library: false, volMax: 60, stage: false },
  member: { web: true, agent: 'guest', music: 'play', library: false, volMax: 100, stage: false } };

const PAGE = { targetId: 'P1', type: 'page', url: 'https://www.youtube.com/watch?v=e2e', title: 'Lo-fi para estudiar · Directo - YouTube' };
const SID = 'S-P1';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const FRAUNCES = require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2', { paths: [__dirname, ...(process.env.NODE_PATH || '').split(':').filter(Boolean)] });
const ART = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#2a1a5e"/><stop offset="1" stop-color="#9a3a8a"/></linearGradient></defs>' +
  '<rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="140" r="80" fill="#f07a5a"/><rect y="215" width="300" height="85" fill="#14284e"/></svg>';

// estado de Spotify de ejemplo (lo que empuja el servidor con una cuenta conectada)
const SP_NOW = {
  track: { name: 'Midnight City' }, artist: 'M83', playing: true, progress: 95e3, duration: 243e3, shuffle: true, repeat: 'off', liked: true,
  album: { name: "Hurry Up, We're Dreaming", year: 2011, image: { m: 'https://i.scdn.co/image/e2e-art', l: 'https://i.scdn.co/image/e2e-art' } },
  context: { type: 'playlist', name: 'Mi lista n.º 55', uri: 'spotify:playlist:e2e' }, colors: { bg: '#3a2450', accent: '#f07a5a' },
  device: { volume: 62 }, needsLogin: false,
  queue: [
    { name: 'Wait', artist: 'M83', uri: 'spotify:track:e2e1', duration: 343e3, image: 'https://i.scdn.co/image/e2e-art' },
    { name: 'Outro', artist: 'M83', uri: 'spotify:track:e2e2', duration: 247e3, image: 'https://i.scdn.co/image/e2e-art' },
    { name: 'Un título de canción muy largo que no cabe de ninguna manera', artist: 'Alguien con un nombre largo', uri: 'spotify:track:e2e3', duration: 61e3 },
  ],
};

const wait = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
const logs = [];      // órdenes: líneas por escena
const raw = [];       // lo mismo sin normalizar (solo informativo)

// wpctl falso: guarda el volumen en un fichero a su lado
function fakeWpctl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-e2e-bin-'));
  fs.writeFileSync(path.join(dir, 'wpctl'), `#!${process.execPath}
const fs = require('fs'), f = __dirname + '/vol.json'; let s = { v: 0.35, m: false }; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
const a = process.argv.slice(2);
if (a[0] === 'get-volume') { console.log('Volume: ' + s.v.toFixed(2) + (s.m ? ' [MUTED]' : '')); process.exit(0); }
if (a[0] === 'set-mute') s.m = !s.m;
if (a[0] === 'set-volume') { const m = /^(\\d+)%([+-])$/.exec(a[2]); s.v = m ? s.v + (m[2] === '+' ? 1 : -1) * m[1] / 100 : +a[2]; s.v = Math.round(Math.min(1, Math.max(0, s.v)) * 100) / 100; }
fs.writeFileSync(f, JSON.stringify(s));
`, { mode: 0o755 });
  return dir;
}

// antes de cada página: hora y azar fijos, registro de lo que se manda por WebSocket, inyección de mensajes del servidor
function initScript({ token, cfg }) {
  Math.random = () => 0.5;
  try {
    localStorage.clear();
    if (token) localStorage.setItem('token', JSON.stringify(token));
    if (cfg) localStorage.setItem('cfg', JSON.stringify(cfg));
  } catch {}
  const W = window.WebSocket, socks = [];
  window.__wsLog = [];
  const send = W.prototype.send;
  W.prototype.send = function (d) {
    if (typeof d === 'string' && d.charCodeAt(0) === 112) return; // «p<ts>»: el eco de latencia no se manda (sin ms en pantalla)
    window.__wsLog.push(String(d));
    return send.call(this, d);
  };
  class WS extends W { constructor(...a) { super(...a); socks.push(this); } }
  window.WebSocket = WS;
  // como si el servidor mandase este mensaje por el WebSocket abierto
  window.__wsInject = o => { const s = socks.filter(x => x.readyState === 1).pop(); if (!s) throw new Error('sin WebSocket abierto'); s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(o) })); };
  document.addEventListener('securitypolicyviolation', e => console.error('[CSP] ' + e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sourceFile || '') + ':' + (e.lineNumber || '')));
}

// normaliza: tokens y pids fuera; las rachas de puntero («m dx dy», «w dx dy») se juntan en una con el signo
// (cuántas líneas salen depende de los fotogramas, y el tamaño de la aceleración por tiempo)
function normalize(lines) {
  const out = [];
  const red = s => s.replace(/\b[0-9a-f]{32}\b/g, '<token>').replace(/"pid":"[0-9a-f]+"/g, '"pid":"<pid>"');
  let run = null;
  const sg = n => (n > 0 ? '+' : n < 0 ? '-' : '0');
  const flush = () => { if (run) { out.push(`${run.k} ${sg(run.x)} ${sg(run.y)}  (movimiento)`); run = null; } };
  for (const l of lines) {
    const m = /^([mw]) (-?[\d.]+) (-?[\d.]+)$/.exec(l);
    if (m) {
      if (run && run.k !== m[1]) flush();
      run = run || { k: m[1], x: 0, y: 0 };
      run.x += +m[2]; run.y += +m[3];
      continue;
    }
    flush();
    if (l === '{"t":"spwatch","on":true}') continue; // renovación cada 15 s con el panel abierto: depende de cuándo cae el temporizador
    out.push(red(l));
  }
  flush();
  return out;
}

let browser, srv, cdp, binDir;
const scenes = [];

async function newPage({ token, theme, name }) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA,
    locale: 'es-ES', timezoneId: 'Europe/Madrid', reducedMotion: 'reduce', colorScheme: theme === 'claro' ? 'light' : 'dark',
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await ctx.addInitScript(initScript, { token: token || '', cfg: theme === 'claro' ? { theme: 'claro' } : null });
  page.on('pageerror', e => errors.push(`${name}: pageerror: ${e.message}`));
  page.on('console', m => { if (/^\[CSP\] /.test(m.text())) errors.push(`${name}: CSP: ${m.text().slice(6)}`); }); // del aviso securitypolicyviolation
  page.__http = [];
  page.on('request', q => {
    const u = new URL(q.url());
    if (q.method() === 'POST' && u.host === new URL(srv.base).host) page.__http.push(`POST ${u.pathname} ${q.postData() || ''}`);
  });
  await ctx.route(/fonts\.googleapis\.com/, r => r.fulfill({ contentType: 'text/css',
    body: "@font-face{font-family:Fraunces;font-weight:100 900;src:url(https://fonts.gstatic.com/fraunces.woff2) format('woff2')}" }));
  await ctx.route(/fonts\.gstatic\.com/, r => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(FRAUNCES) }));
  await ctx.route(/i\.scdn\.co/, r => r.fulfill({ contentType: 'image/svg+xml', body: ART }));
  return page;
}

async function open(page, { connected = true } = {}) {
  await page.goto(srv.base + '/');
  if (connected) await page.getByRole('img', { name: 'Conectada', exact: true }).waitFor({ state: 'attached' });
  await settle(page);
}

async function settle(page, ms = 600) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))));
}

async function shot(page, name) {
  await settle(page, 250);
  await page.screenshot({ path: path.join(OUT, name + '.png'), animations: 'disabled', caret: 'hide' });
  scenes.push(name);
}

async function takeLog(page, section) {
  const ws = await page.evaluate(() => window.__wsLog.splice(0)).catch(() => []);
  const http = page.__http.splice(0);
  raw.push(`## ${section}`, ...http, ...ws, '');
  logs.push(`## ${section}`, ...normalize([...http.map(h => h), ...ws]), '');
}

const btn = (page, name) => page.getByRole('button', { name, exact: true });
const tap = async (page, name, ms = 400) => { await btn(page, name).tap(); await page.waitForTimeout(ms); };
const inject = (page, o) => page.evaluate(m => window.__wsInject(m), o);
const shade = async page => { await page.touchscreen.tap(195, 30); await page.waitForTimeout(400); };
const focusTv = async o => { cdp.event('Runtime.bindingCalled', { name: '__tvFocus', payload: JSON.stringify(o) }, SID); await wait(150); };
const scrollTo = (page, text) => page.getByText(text, { exact: true }).evaluate(e => e.scrollIntoView({ block: 'start' }));
const pairInfo = async () => (await (await srv.post('/pair/info', {})).json());
async function noAdminOnline() { for (let i = 0; i < 50 && (await pairInfo()).adminOnline; i++) await wait(100); }

// gestos en el trackpad con PointerEvent sintéticos (cada dispatch, un paso)
async function padGesture(page, steps) {
  const pad = page.getByRole('region', { name: /^Trackpad/ });
  await pad.evaluate((el, st) => {
    const b = el.getBoundingClientRect();
    for (const [type, id, x, y] of st) el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true, cancelable: true, clientX: b.left + x, clientY: b.top + y }));
  }, steps);
}

// ───────────────────────── escenas
async function adminScenes(theme, admin) {
  const T = s => `${theme}-${s}`;
  const run = async (name, fn) => { const p = await newPage({ token: admin, theme, name: T(name) }); try { await open(p); await fn(p); } finally { await takeLog(p, T(name)); await p.context().close(); } };

  await run('principal', p => shot(p, T('principal')));
  await run('trackpad-tocando', async p => { await padGesture(p, [['pointerdown', 1, 150, 200]]); await shot(p, T('trackpad-tocando')); await padGesture(p, [['pointerup', 1, 150, 200]]); });
  await run('teclado-sin-campo', async p => { await focusTv({ kind: 'none' }); await tap(p, 'Escribir en la tele', 700); await shot(p, T('teclado-sin-campo')); });
  await run('teclado-texto', async p => {
    await focusTv({ kind: 'search', placeholder: 'Buscar en YouTube', value: '' });
    await tap(p, 'Escribir en la tele', 700);
    await p.keyboard.type('gatos graciosos', { delay: 60 });
    await p.waitForTimeout(800);
    await shot(p, T('teclado-texto'));
  });
  await run('teclado-contrasena', async p => {
    await focusTv({ kind: 'password', placeholder: 'Contraseña' });
    await tap(p, 'Escribir en la tele', 700);
    await p.keyboard.type('secreta1', { delay: 60 });
    await p.waitForTimeout(800);
    await shot(p, T('teclado-contrasena'));
  });
  await focusTv({ kind: 'none' });
  await run('hoja-direccion', async p => { await tap(p, 'Abrir una dirección'); await p.keyboard.type('elpais.com'); await shot(p, T('hoja-direccion')); });
  await run('hoja-agente', async p => {
    await tap(p, 'Hablar con Jota'); await shot(p, T('hoja-agente'));
    await inject(p, { t: 'ask', stage: 'done', reply: 'Hecho: he puesto «Lo-fi para estudiar» en YouTube a pantalla completa.' });
    await shot(p, T('hoja-agente-respuesta'));
  });
  await run('spotify', async p => {
    await tap(p, 'Abrir Spotify', 900); await shot(p, T('spotify-sin-cuenta'));
    await inject(p, { t: 'sp', now: SP_NOW }); await shot(p, T('spotify-ejemplo'));
    await tap(p, 'Playlists', 900); await shot(p, T('spotify-playlists'));
  });
  await run('ajustes', async p => {
    await tap(p, 'Ajustes', 1000); await shot(p, T('ajustes'));
    await scrollTo(p, 'Pantalla en reposo'); await shot(p, T('ajustes-reposo'));
    await scrollTo(p, 'Personas con acceso'); await shot(p, T('ajustes-acceso'));
    await scrollTo(p, 'Qué pueden hacer'); await shot(p, T('ajustes-permisos'));
  });
}

// emparejar (sin token), con petición de acceso a un admin conectado que la rechaza
async function pairScenes(theme, admin) {
  const T = s => `${theme}-${s}`;
  await noAdminOnline();
  const p = await newPage({ theme, name: T('emparejar') });
  try {
    await open(p, { connected: false });
    await btn(p, 'Mostrar un código en la tele').waitFor();
    await shot(p, T('emparejar'));
    await tap(p, 'Tengo un código de administrador'); await shot(p, T('emparejar-codigo-admin'));
    await tap(p, 'Cancelar');
    await wait(4200);                                                 // /pair/start: uno cada 4 s por IP
    await tap(p, 'Mostrar un código en la tele', 800); await shot(p, T('emparejar-codigo-tele'));
    await p.getByRole('button', { name: 'Cancelar', exact: true }).tap(); await p.waitForTimeout(500);
    await takeLog(p, T('emparejar'));

    const a = await newPage({ token: admin, theme, name: T('admin-peticion') });
    try {
      await open(a);
      await wait(4200);
      await tap(p, 'Tengo un código de administrador'); await tap(p, 'Cancelar', 600); // vuelve a preguntar si hay admin
      await btn(p, 'Pedir acceso al administrador').waitFor();
      await p.getByPlaceholder(/^Tu nombre/).fill('Ana');
      await shot(p, T('emparejar-con-admin'));
      await tap(p, 'Pedir acceso al administrador', 900); await shot(p, T('emparejar-esperando'));
      await a.getByText('Quiere usar el mando').waitFor();
      await shot(a, T('peticion-acceso'));
      await tap(a, 'Rechazar', 300);
      await p.getByText(/no ha aceptado/).waitFor({ timeout: 5000 });
      await shot(p, T('emparejar-rechazado'));
    } finally { await takeLog(a, T('admin-peticion')); await a.context().close(); }
  } finally { await takeLog(p, T('emparejar-pedir')); await p.context().close(); }
}

async function guestScenes(theme) {
  const T = s => `${theme}-${s}`;
  const run = async (name, fn) => { const p = await newPage({ token: GUEST_TOKEN, theme, name: T(name) }); try { await open(p); await fn(p); } finally { await takeLog(p, T(name)); await p.context().close(); } };
  await run('invitado', p => shot(p, T('invitado')));
  await run('invitado-spotify', async p => { await tap(p, 'Abrir Spotify', 900); await inject(p, { t: 'sp', now: { ...SP_NOW, liked: null } }); await shot(p, T('invitado-spotify')); });
  await run('invitado-ajustes', async p => { await tap(p, 'Ajustes', 800); await shot(p, T('invitado-ajustes')); });
}

// recorrido fijo de interacciones: lo que importa es qué órdenes salen, en qué orden
async function walk(admin) {
  const name = 'recorrido';
  const p = await newPage({ token: admin, theme: 'oscuro', name });
  try {
    await open(p);
    await takeLog(p, 'recorrido: al abrir');
    for (const b of ['Atrás', 'Inicio', 'Pantalla completa', 'Pausar', 'Retroceder 10 segundos', 'Adelantar 10 segundos', 'Subir volumen', 'Subir volumen', 'Bajar volumen', 'Silenciar', 'Abrir Netflix']) await tap(p, b, 350);
    await p.waitForTimeout(500);
    await takeLog(p, 'recorrido: botones');
    await padGesture(p, [['pointerdown', 1, 100, 150], ['pointerup', 1, 100, 150]]);           // toque: clic
    await p.waitForTimeout(400);
    await padGesture(p, [['pointerdown', 1, 100, 150], ['pointermove', 1, 120, 160], ['pointermove', 1, 140, 170], ['pointermove', 1, 160, 180], ['pointerup', 1, 160, 180]]);
    await p.waitForTimeout(400);
    await padGesture(p, [['pointerdown', 1, 100, 150], ['pointerdown', 2, 160, 150], ['pointerup', 2, 160, 150], ['pointerup', 1, 100, 150]]); // dos dedos: clic derecho
    await p.waitForTimeout(400);
    await padGesture(p, [['pointerdown', 1, 100, 250], ['pointerdown', 2, 160, 250], ['pointermove', 1, 100, 240], ['pointermove', 2, 160, 240], ['pointermove', 1, 100, 230], ['pointermove', 2, 160, 230], ['pointerup', 1, 100, 230], ['pointerup', 2, 160, 230]]);
    await p.waitForTimeout(1500);                                                                // inercia
    await takeLog(p, 'recorrido: trackpad');
    await tap(p, 'Abrir una dirección'); await p.keyboard.type('elpais.com'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    await takeLog(p, 'recorrido: dirección');
    await focusTv({ kind: 'text', placeholder: 'Buscar', value: '' });
    await tap(p, 'Escribir en la tele', 700);
    await p.keyboard.type('hola', { delay: 200 }); await p.waitForTimeout(400);
    for (const k of ['Abajo', 'Derecha', 'Tabulador']) await tap(p, k, 300);
    await tap(p, 'Pulsar Intro en la tele', 300);
    await tap(p, 'Borrar todo', 400);
    await tap(p, 'Volver al mando', 400);
    await focusTv({ kind: 'none' });
    await takeLog(p, 'recorrido: teclado');
    await tap(p, 'Abrir Spotify', 900);
    await inject(p, { t: 'sp', now: SP_NOW });
    await tap(p, 'Siguiente', 400); await tap(p, 'Aleatorio', 400); await tap(p, 'Recientes', 900);
    await shade(p);
    await takeLog(p, 'recorrido: spotify');
    await tap(p, 'Hablar con Jota'); await p.keyboard.type('pon música tranquila'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
    await shade(p);
    await takeLog(p, 'recorrido: agente');
    await tap(p, 'Ajustes', 1000);
    await tap(p, 'Recargar', 300);
    await tap(p, 'Desplazamiento natural', 300); await tap(p, 'Desplazamiento natural', 300);
    await scrollTo(p, 'Pantalla en reposo'); await tap(p, 'Noche', 700);
    await scrollTo(p, 'Qué pueden hacer'); await tap(p, 'Miembros', 300); await tap(p, 'Presentaciones', 700); await tap(p, 'Presentaciones', 700);
    await shade(p);
    await takeLog(p, 'recorrido: ajustes');
  } finally { await takeLog(p, 'recorrido: final'); await p.context().close(); }
}

(async () => {
  binDir = fakeWpctl();
  process.env.PATH = binDir + ':' + process.env.PATH;                 // el servidor hereda PATH: usa este wpctl
  cdp = await startFakeCdp({
    pages: [PAGE],
    evaluate: expr => (expr.includes('scrollingElement') ? [1, 900, 4000, 1000]   // sondeo: vídeo reproduciendo y scroll a un tercio
      : expr.includes('"boot":"') ? { ok: 1 } : undefined),                        // escribir en el campo: aplicado
  });
  srv = await start({ cdpPort: cdp.port, files: { 'devices.json': DEVICES, 'access.json': ACCESS } });
  try {
    await cdp.waitFor(m => m.method === 'Runtime.addBinding' && m.params.name === '__tvFocus', 10000);
    const r = { token: ADMIN_TOKEN };
    browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    for (const theme of ['oscuro', 'claro']) {
      await adminScenes(theme, r.token);
      await pairScenes(theme, r.token);
      await guestScenes(theme);
    }
    await walk(r.token);
  } finally {
    if (browser) await browser.close();
    await srv.stop(); await cdp.close();
    fs.rmSync(binDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, 'ordenes.txt'), logs.join('\n'));
  fs.writeFileSync(path.join(OUT, 'ordenes-crudas.txt'), raw.join('\n'));
  fs.writeFileSync(path.join(OUT, 'errores.txt'), errors.join('\n'));
  console.log(`${scenes.length} capturas y registro de órdenes en ${OUT}`);
  if (errors.length) { console.error('Errores de la página:\n' + errors.join('\n')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
