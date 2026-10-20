// Prueba de la geometría de la pantalla en reposo (remote/public/idle.html) en muchos tamaños de pantalla.
// Uso: cd e2e && node reposo-solapes.js [--capturas carpeta] [--solo 1280x720,…]   (CHROME=/ruta para otro navegador)
// Para cada tamaño × distribución × escena × datos (mañana, sin música, tarde, noche) mide con getBoundingClientRect
// las cajas visibles de cada widget (textos, carátula, anillos) y falla si alguna se sale del área segura, si se sale de
// su celda de la rejilla, si dos widgets distintos se tocan o si un texto recortado queda en una columna absurda.
// Determinista: hora fija, Math.random fijo, sin animaciones (las escenas se colocan al momento con TVIdle.place).
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

// REPOSO_PUBLIC=/otra/remote/public prueba otra copia (p. ej. la de main, para sacar capturas de antes y después)
const PUB = path.resolve(process.env.REPOSO_PUBLIC || path.join(__dirname, '..', 'remote', 'public'));
let IDLE_CSP = null;
try { ({ IDLE_CSP } = require(path.join(__dirname, '..', 'remote', 'src', 'transport', 'static.js'))); } catch { console.warn('sin remote/src: prueba sin CSP'); }
const FRAUNCES = require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2');
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--capturas') ? path.resolve(arg('--capturas')) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// área segura: margen de sobrebarrido (overscan) que la tele puede comerse por cada lado
const SAFE = 0.03;
// un texto recortado con elipsis necesita al menos esta anchura (en em de su propia letra) para leerse
const MIN_EM = 5;

// tamaños en píxeles CSS (w×h) y escala del dispositivo: la tele del kiosco va a 1920×1080 con --force-device-scale-factor=1.5
const SIZES = [
  { n: '1280x720', w: 1280, h: 720 },
  { n: '1366x768', w: 1366, h: 768 },
  { n: '1920x1080', w: 1920, h: 1080 },
  { n: '2560x1440', w: 2560, h: 1440 },
  { n: '3840x2160', w: 3840, h: 2160 },
  { n: '1920x1080@1.5', w: 1280, h: 720, s: 1.5 },
  { n: '1920x1080@2', w: 960, h: 540, s: 2 },
  { n: '1024x768', w: 1024, h: 768 },   // 4:3
  { n: '2560x1080', w: 2560, h: 1080 }, // 21:9
];

const ART = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#2a1a5e"/><stop offset="1" stop-color="#9a3a8a"/></linearGradient></defs>' +
  '<rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="280" r="160" fill="#f07a5a"/><rect y="430" width="600" height="170" fill="#14284e"/></svg>';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u.startsWith('/idle/art')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end(ART); }
  const f = path.join(PUB, u === '/' ? 'idle.html' : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...(IDLE_CSP && f.endsWith('.html') ? { 'content-security-policy': IDLE_CSP } : {}) });
  r.end(fs.readFileSync(f));
}).listen(0);

// datos realistas: hora de cada momento del día, título y artista largos, Live Activities y tiempo con lluvia
const at = s => Date.parse(s);
const wx = (now, o) => ({ code: 2, isDay: true, temp: 23, max: 23, min: 17, feels: 23, rainNext: 10, sunrise: now - 4 * 3600e3, sunset: now + 8 * 3600e3, ...o });
const song = (now, o) => ({ title: 'Nightsout', artist: 'I Am Waiting For You Last Summer', playing: true, progress: 95e3, duration: 243e3, at: now, art: 'x', context: { type: 'playlist', name: 'Mi lista n.º 55' }, ...o });
const timer = now => ({ id: 't1', title: 'Pasta', subtitle: 'escurrir y servir', endsAt: now + 444e3, duration: 600e3, updated: now });
const wash = now => ({ id: 't2', title: 'Lavadora', subtitle: 'centrifugado', progress: 0.62, value: '62 %', updated: now });
const VARIANTS = [
  { n: 'manana', now: at('2026-10-19T11:14:00+02:00'), d: now => ({ profile: 'day', weather: wx(now), music: song(now), acts: [timer(now)] }) },
  { n: 'sinmusica', now: at('2026-10-19T11:14:00+02:00'), d: now => ({ profile: 'day', weather: wx(now), music: null, acts: [] }) },
  { n: 'tarde', now: at('2026-09-30T20:48:00+02:00'), d: now => ({ profile: 'evening', weather: wx(now, { code: 61, temp: 18, rainNext: 60 }),
    music: song(now, { title: 'Un título de canción muy largo que no cabe de ninguna manera', artist: 'Florence + The Machine' }), acts: [timer(now), wash(now)] }) },
  { n: 'noche', now: at('2026-10-19T23:16:00+02:00'), d: now => ({ profile: 'night', weather: wx(now), music: song(now, { playing: false }), acts: [] }) },
];
const LAYOUTS = ['margen', 'zonas', 'apilada'];

// en la página: las cajas visibles de cada widget. Para un texto, la caja de su tinta: en horizontal la de su texto (un
// Range); en vertical, de la línea de base, la altura real de los glifos (measureText de un canvas), no el área de la
// fuente, que en Fraunces es mucho más alta que las cifras. Recortada a la del elemento si este recorta (overflow hidden).
function measure() {
  const box = r => ({ x: r.left, y: r.top, r: r.right, b: r.bottom });
  const cut = (a, c) => ({ x: Math.max(a.x, c.x), y: Math.max(a.y, c.y), r: Math.min(a.r, c.r), b: Math.min(a.b, c.b) });
  const cx = document.createElement('canvas').getContext('2d');
  const ink = (rg, s, text) => {
    const lines = [...rg.getClientRects()].filter(r => r.width > 0.5);
    if (!lines.length) return null;
    cx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const m = cx.measureText(text);
    const b = { x: Math.min(...lines.map(r => r.left)), r: Math.max(...lines.map(r => r.right)), y: Infinity, b: -Infinity };
    for (const l of lines) { // área de la fuente: de base − ascendente a base + descendente
      const base = l.top + m.fontBoundingBoxAscent;
      b.y = Math.min(b.y, base - m.actualBoundingBoxAscent); b.b = Math.max(b.b, base + m.actualBoundingBoxDescent);
    }
    return b;
  };
  const out = { vw: innerWidth, vh: innerHeight, gap: parseFloat(getComputedStyle(document.getElementById('grid')).rowGap) || 0, widgets: [] };
  for (const sec of document.querySelectorAll('#grid > .w')) {
    const cs = getComputedStyle(sec);
    if (cs.display === 'none' || sec.classList.contains('off') || Number(cs.opacity) === 0) continue;
    const w = { id: sec.id, cell: box(sec.getBoundingClientRect()), parts: [] };
    for (const el of sec.querySelectorAll('*')) {
      if (!el.getClientRects().length) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden') continue;
      const texts = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
      const solid = el.matches('.art, .act svg, .pb .tr');
      if (!texts.length && !solid) continue;
      let b = box(el.getBoundingClientRect());
      if (texts.length) {
        const rg = document.createRange(); rg.setStartBefore(texts[0]); rg.setEndAfter(texts[texts.length - 1]);
        const t = ink(rg, s, texts.map(n => n.textContent).join('').trim());
        if (!t) continue;
        b = s.overflowX === 'hidden' || s.overflow === 'hidden' ? cut(t, b) : t;
      }
      if (b.r - b.x < 0.5 || b.b - b.y < 0.5) continue;
      const tag = (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '') || el.tagName.toLowerCase();
      // líneas de texto que se ven: las cajas del Range a distinta altura (sin las que esconde un line-clamp)
      const lr = document.createRange(); lr.selectNodeContents(el);
      const lines = texts.length ? new Set([...lr.getClientRects()].filter(r => r.width > 0.5 && (s.overflowY !== 'hidden' || (r.top + r.bottom) / 2 < el.getBoundingClientRect().bottom))
        .map(r => Math.round(r.top))).size : 0;
      w.parts.push({ tag, text: texts.map(n => n.textContent).join('').trim().slice(0, 30), ...b, fs: parseFloat(s.fontSize), lines,
        // recortado: el elemento recorta (elipsis o line-clamp) y su texto no cabe
        trunc: texts.length > 0 && s.overflowX === 'hidden' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1), cw: el.clientWidth });
    }
    out.widgets.push(w);
  }
  return out;
}

function check(m) {
  const bad = [], f = n => Math.round(n);
  const safe = { x: m.vw * SAFE, y: m.vh * SAFE, r: m.vw * (1 - SAFE), b: m.vh * (1 - SAFE) };
  const T = 1; // tolerancia de redondeo, en px
  const half = m.gap / 2; // un widget puede asomar a la separación de la rejilla, hasta la mitad: así nunca toca al vecino
  const desc = (w, p) => `${w.id} ${p.tag}${p.text ? ` «${p.text}»` : ''} [${f(p.x)},${f(p.y)}→${f(p.r)},${f(p.b)}]`;
  for (const w of m.widgets) {
    for (const p of w.parts) {
      if (p.x < safe.x - T || p.y < safe.y - T || p.r > safe.r + T || p.b > safe.b + T) bad.push(`fuera del área segura: ${desc(w, p)}`);
      else if (p.x < w.cell.x - half - T || p.y < w.cell.y - half - T || p.r > w.cell.r + half + T || p.b > w.cell.b + half + T) bad.push(`fuera de su celda [${f(w.cell.x)},${f(w.cell.y)}→${f(w.cell.r)},${f(w.cell.b)}]: ${desc(w, p)}`);
      if (p.trunc && p.cw < MIN_EM * p.fs) bad.push(`texto en una columna estrecha (${f(p.cw)} px = ${(p.cw / p.fs).toFixed(1)} em): ${desc(w, p)}`);
      if (p.lines > 2) bad.push(`texto partido en ${p.lines} líneas: ${desc(w, p)}`);
    }
  }
  for (let i = 0; i < m.widgets.length; i++) for (let j = i + 1; j < m.widgets.length; j++) {
    const A = m.widgets[i], B = m.widgets[j];
    for (const a of A.parts) for (const b of B.parts)
      if (Math.min(a.r, b.r) - Math.max(a.x, b.x) > T && Math.min(a.b, b.b) - Math.max(a.y, b.y) > T) bad.push(`solape: ${desc(A, a)} con ${desc(B, b)}`);
  }
  return bad;
}

(async () => {
  const only = arg('--solo') ? arg('--solo').split(',') : null;
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const fails = [], errs = [];
  let n = 0;
  for (const sz of SIZES.filter(s => !only || only.includes(s.n))) {
    for (const v of VARIANTS) {
      const ctx = await b.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.s || 1, timezoneId: 'Europe/Madrid' });
      const p = await ctx.newPage();
      const tag = `${sz.n} ${v.n}`;
      await p.clock.setFixedTime(v.now);
      await p.addInitScript(() => { Math.random = () => 0.5; });
      p.on('pageerror', e => errs.push(tag + ': ' + e.message));
      p.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errs.push(tag + ': ' + m.text()); });
      await p.route(/fonts\.googleapis\.com/, x => x.fulfill({ contentType: 'text/css',
        body: "@font-face{font-family:Fraunces;font-weight:100 900;src:url(https://fonts.gstatic.com/fraunces.woff2) format('woff2')}" }));
      await p.route(/fonts\.gstatic\.com/, x => x.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(FRAUNCES) }));
      await p.goto(`http://127.0.0.1:${srv.address().port}/`);
      // «rotar» (la distribución con la que arranca, así que no hay reacomodo animado) recorre las 9 escenas:
      // margen 0–2, zonas 0–2 y apilada 0–2; TVIdle.place coloca cada una al momento
      await p.evaluate(d => { d.now = Date.now(); onData(d); }, { ...v.d(v.now), cfg: { dimMin: 0, rearrangeMin: 0, layout: 'rotar', calm: true } }); // eslint-disable-line no-undef
      await p.evaluate(() => document.fonts.ready);
      await p.waitForFunction(() => !window.TVIdle.now().moving);
      for (let sc = 0; sc < 3 * LAYOUTS.length; sc++) {
        const name = `${LAYOUTS[Math.floor(sc / 3)]}-${sc % 3}`;
        await p.evaluate(s => window.TVIdle.place ? window.TVIdle.place(s) : place(L.rotar[s]), sc); // eslint-disable-line no-undef
        await p.waitForTimeout(100);
        const bad = check(await p.evaluate(measure));
        n++;
        if (bad.length) fails.push(`✗ ${sz.n} ${name} ${v.n}\n    ` + bad.join('\n    '));
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${sz.n}-${name}-${v.n}.png`), animations: 'disabled' });
      }
      await ctx.close();
    }
  }
  await b.close(); srv.close();
  if (fails.length) console.error(fails.join('\n'));
  console.log(`${n} combinaciones (tamaño × distribución × escena × datos), ${fails.length} con fallos` + (SHOTS ? `; capturas en ${SHOTS}` : ''));
  if (errs.length) console.error('Errores de la página:\n' + errs.join('\n'));
  process.exit(fails.length || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
