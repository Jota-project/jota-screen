// Capturas de la pantalla en reposo (remote/public/idle.html) con datos de ejemplo, sin servidor ni tele.
// Uso: cd e2e && npm install && node reposo-capturas.js [carpeta-salida]   (CHROME=/ruta para otro navegador)
// Saca cada distribución en sus tres escenas, más sin música, título largo, tarde y noche, a 1920×1080.
// Fraunces e Inter salen de remote/public/fonts (shared/fonts.css), como en la tele.
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const PUB = path.join(__dirname, '..', 'remote', 'public');
// la misma CSP que pone el servidor: si algo del reposo necesitara estilos o scripts en línea, la captura falla
let IDLE_CSP = null;
try { ({ IDLE_CSP } = require(path.join(__dirname, '..', 'remote', 'src', 'transport', 'static.js'))); } catch { console.warn('sin remote/src: capturas sin CSP'); }
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'capturas'));
fs.mkdirSync(OUT, { recursive: true });

// carátula sintética: un SVG con un sol, para no depender de imágenes reales
const ART = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#2a1a5e"/><stop offset="1" stop-color="#9a3a8a"/></linearGradient></defs>' +
  '<rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="280" r="160" fill="#f07a5a"/><rect y="430" width="600" height="170" fill="#14284e"/></svg>';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u.startsWith('/idle/art')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end(ART); }
  const f = path.join(PUB, u === '/' ? 'idle.html' : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...(IDLE_CSP && f.endsWith('.html') ? { 'content-security-policy': IDLE_CSP } : {}) });
  r.end(fs.readFileSync(f));
}).listen(0);

const now = Date.now();
const weather = { code: 2, isDay: true, temp: 23, max: 26, min: 15, feels: 23, rainNext: 10, sunrise: now - 6 * 3600e3, sunset: now + 5 * 3600e3 };
const music = { title: 'Midnight City', artist: 'M83', playing: true, progress: 95e3, duration: 243e3, at: now, art: 'x', context: { type: 'playlist', name: 'Mi lista n.º 55' } };
const timer = { id: 't1', title: 'Pasta', subtitle: 'escurrir y servir', endsAt: now + 444e3, duration: 600e3, updated: now };
const base = o => ({ profile: 'day', weather, music, acts: [timer], ...o, cfg: { dimMin: 20, rearrangeMin: 0, ...(o.cfg || {}) } });

const RUNS = [];
for (const lay of ['margen', 'zonas', 'apilada']) for (const s of [0, 1, 2]) RUNS.push({ name: `${lay}-${s}`, data: base({ cfg: { layout: lay } }), scene: s });
RUNS.push({ name: 'margen-0-sinmusica', data: base({ music: null, acts: [], cfg: { layout: 'margen' } }), scene: 0 });
RUNS.push({ name: 'margen-0-titulolargo', data: base({ music: { ...music, title: 'Un título de canción muy largo que no cabe de ninguna manera' }, cfg: { layout: 'margen' } }), scene: 0 });
RUNS.push({ name: 'zonas-0-tarde', data: base({ profile: 'evening', cfg: { layout: 'zonas' } }), scene: 0 });
RUNS.push({ name: 'apilada-0-noche', data: base({ profile: 'night', acts: [], music: { ...music, playing: false }, cfg: { layout: 'apilada' } }), scene: 0 });

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {}); // CHROME=/ruta/a/chrome para usar otro navegador
  const errs = [];
  for (const r of RUNS) {
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    p.on('pageerror', e => errs.push(r.name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errs.push(r.name + ': ' + m.text()); });
    await p.goto(`http://127.0.0.1:${srv.address().port}/`);
    await p.evaluate(d => { d.now = Date.now(); onData(d); }, r.data); // eslint-disable-line no-undef
    await p.waitForTimeout(3000);
    if (r.scene) { await p.evaluate(n => TVIdle.scene(n), r.scene); await p.waitForTimeout(3200); } // eslint-disable-line no-undef
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(OUT, r.name + '.png') });
    await p.close();
  }
  await b.close(); srv.close();
  console.log(`${RUNS.length} capturas en ${OUT}`);
  if (errs.length) { console.error('Errores de la página:\n' + errs.join('\n')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
