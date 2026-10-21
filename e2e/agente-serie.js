// «Pon esta serie» y el formato por contenido: la capa del agente con el servidor de verdad (src/tv/talk-view.js +
// src/tv/page-poll.js + src/tv/agent-form.js) hablando por CDP con un Chromium de verdad, como en la tele. Sin tele, sin
// Gateway y sin red.
// Uso: cd e2e && node agente-serie.js [carpeta-salida] [--solo contenido,esqueleto,web,layout,arrastre,espera,tira]
//      [--tam 1280x720,1920x1080] [--videos carpeta]   (npm run agente:serie; CHROME=/ruta para otro navegador).
// La conversación la mueve esta prueba igual que talk.js (turn/you/tool/toolEnd/jota/done) y las navegaciones las hace
// Playwright (como tv_open); en cada una se llama a reset() como server.js al cambiar de URL, y el binding del arrastre
// (Runtime.bindingCalled) va a view.fromPage() como en server.js. La «app de contenido» es CONTENT_HOST, un host de
// pruebas que Chromium resuelve a 127.0.0.1 (--host-resolver-rules) y que se añade a CONTENT_HOSTS solo aquí. Páginas:
//   /            el reposo (idle.html) con su CSP real (en 127.0.0.1)
//   /catalogo    «catálogo» con un tráiler pequeño en autoplay; CSP con font-src 'none'
//   /watch       el reproductor: <video> a toda pantalla (de un canvas.captureStream: nada que descargar); font-src 'none'
//   /receta      una web normal con un botón y un campo (para ver que el arrastre no les roba clics ni foco)
//   /lenta       una web que tarda SLOW_PAGE_MS en responder
//   /esqueleto   el catálogo, pero primero un «Cargando…» sobre cajas grises y el contenido a los SKELETON_MS (como una app)
//   /sala        un <div> que se pone a pantalla completa (como el reproductor de YouTube o Netflix) con un botón
// Escenas:
//   contenido  reposo con el panel abierto y 2 turnos → catálogo en la app de contenido: la píldora llega SIN reproducción,
//              cuando la página nueva ya está pintada (+ MORPH_DELAY_MS) → /watch de la app (sigue en píldora) → play() +
//              requestFullscreen(). Comprueba: restore tras cada navegación (sin animaciones de entrada, la membrana en su
//              caja con el cristal ya opaco y sin transiciones, igual que en el documento anterior, hueco ≤ GAP_MAX_MS); el
//              paso en cada rAF (el log no cambia mientras sale el contenido) (ningún salto de más de MAX_STEP del ancho, termina abrazando
//              la píldora dentro del área segura en < MORPH_MAX_MS); host y orbe iguales tras la pantalla completa; Fraunces
//              (la suya) con font-src 'none'; tras PILL_DWELL se cierra y pausar no la reabre. Vídeo: contenido-<tam>.webm.
//   esqueleto  reposo → app de contenido que pinta primero un esqueleto: el paso no empieza hasta que se ve el contenido.
//   web        reposo → web normal: sigue el panel (aunque pase el respiro) y se cierra a su hora normal.
//   layout     reposo → web normal abierta con layout:'pill' (agentLayout, como tv_open): la píldora llega igual.
//   arrastre   en la app de contenido (píldora) con el ratón de Playwright (puntero de verdad): a la derecha → panel; el
//              panel hacia arriba y al centro → píldora; goma durante el arrastre (sin salir del área segura); el servidor
//              lo sabe (binding); un clic fuera de la membrana llega a la web, uno en la membrana no sube a sus oyentes
//              normales; un arrastre no quita el foco al campo de la web; con un <div> a pantalla completa también se
//              arrastra (el host se mete dentro). Vídeo: arrastre-<tam>.webm.
//   espera     un turno que abre una web lenta: no se cierra a su hora normal mientras la página no llega; llegada y pintada,
//              se ve AFTER_PAINT_MIN_MS encima y se cierra.
//   tira       el paso por reproducción (reserva) fotograma a fotograma (CDP Page.startScreencast): PNG cada ~TIRA_STEP_MS
//              en <salida>/tira-<tamaño>/ y una hoja de contactos tira-<tamaño>.png.
// Salida: e2e/capturas-agente/serie/ (o la carpeta que se pase); vídeos en --videos (por defecto, la misma).
/* global window, document, performance, requestAnimationFrame, innerWidth, innerHeight, MutationObserver, ResizeObserver, PerformanceObserver, getComputedStyle */
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'remote', 'public');
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = arg('--solo') ? arg('--solo').split(',') : null;
const outArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const OUT = path.resolve(outArg || path.join(__dirname, 'capturas-agente', 'serie'));
const VIDEOS = path.resolve(arg('--videos') || OUT);
const FRAUNCES = require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(VIDEOS, { recursive: true });

const TV = (...p) => require(path.join(ROOT, 'remote', 'src', 'tv', ...p));
const { createTalkView, CLOSE_BASE_MS, CLOSE_PER_CHAR_MS, PILL_DWELL_BASE_MS, PILL_DWELL_PER_CHAR_MS, MORPH_DELAY_MS, AFTER_PAINT_MIN_MS,
  AWAIT_PAGE_MS } = TV('talk-view.js');
const { createPagePoll } = TV('page-poll.js');
const { CONTENT_HOSTS } = TV('agent-form.js');
const { FORM_BINDING } = TV('agent-contract.js');
const { IDLE_CSP } = require(path.join(ROOT, 'remote', 'src', 'transport', 'static.js'));

// ── umbrales (todos revisables)
const CONTENT_HOST = 'netflix-e2e.test'; // «app de contenido» de la prueba (solo aquí: --host-resolver-rules y contentHosts)
const GAP_MAX_MS = 20;         // ms entre la primera pintada del documento nuevo y el cristal pintado (≈ 1 frame; 0 lo esperado)
// Saltos de la membrana. El muelle de crecer (K 230 / C 21) llega en su punto más rápido a unos 95-115 px por frame en un
// viaje de ~700 px a 1920 (5-6 % del ancho): eso es velocidad, no un salto. Un salto es un frame mucho más largo que el
// anterior (la membrana se teletransporta) o un paso por encima del tope absoluto.
const MAX_STEP = 0.08;         // tope absoluto de un borde por frame de 60 Hz, en fracción del ancho
const JUMP_RATIO = 2.5;        // un frame más largo que esto por el anterior (si el anterior ya se movía) es un salto
const MOVING_PX = 2;           // un frame que mueve menos que esto no cuenta como «ya se movía»
const JUMP_MIN = 0.02;         // por debajo de esto (fracción del ancho) un frame no cuenta como salto aunque acelere
const FRAME_MS = 1000 / 60;
const MORPH_MAX_MS = 2200;     // desde que el contenido empieza a salir hasta la membrana asentada en su forma nueva
const PAINT_SLACK_MS = 60;     // el paso no empieza antes de pintada + MORPH_DELAY_MS (menos esto: relojes de dos procesos)
const GLASS_TOL = 3;           // px: cristal asentado = caja del contenido
const SAFE = { x: 0.05, y: 0.06 };
const SETTLE_TOL_FRAMES = 6;   // frames seguidos dentro de la tolerancia para dar la membrana por asentada
const SETTLE_WAIT_MS = 1400;   // tras el paso, lo que se espera antes de leer las muestras (la membrana aún se asienta)
const TRAILER_WATCH_MS = 3000; // en una web normal con tráiler: tiempo tras el respiro en el que el panel no debe moverse
const CLOSE_SLACK_MS = 1500;   // margen para dar por cerrada la capa a su hora
const SLOW_PAGE_MS = 7000;     // lo que tarda /lenta en responder (más que el cierre normal de la escena)
const DRAG_STEPS = 24;         // pasos del ratón en un arrastre (cada uno, DRAG_STEP_MS)
const DRAG_STEP_MS = 25;
const DRAG_PX = { x: 380, up: -230, left: -330 }; // arrastres de la prueba (px de la página de 1280: más que DRAG.swap)
const BAND_MAX = 0.2;          // la goma nunca deja ir el contenido más de esto del ancho durante el arrastre
const TIRA_STEP_MS = 100;
const SAMPLES_MAX = 4000;      // muestras de la membrana que guarda cada documento
const REVEAL_WAIT_MS = 1600;   // tras done, lo que tardan en entrar las últimas palabras (vaciado ≤ 1,2 s + su animación)
const SKELETON_MS = 1500;      // lo que tarda /esqueleto en enseñar su contenido (antes: «Cargando…» y cajas grises)
const CONTINUITY_TOL = 4;      // px: la membrana en el primer frame del documento nuevo, donde estaba en el anterior
const SIZES = (arg('--tam') || '1280x720,1920x1080').split(',').map(s => { const [w, h] = s.split('x').map(Number); return { n: s, w, h }; });
const ENTRY = ['wIn', 'wInCalm', 'fadeIn', 'bud'];

// ── páginas de prueba
const STREAM = `function stream(v,hue,label){const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let f=0;
(function d(){f++;const g=x.createLinearGradient(0,0,640,360);g.addColorStop(0,'hsl('+((hue+f)%360)+' 45% 22%)');g.addColorStop(1,'hsl('+((hue+f+60)%360)+' 50% 38%)');
x.fillStyle=g;x.fillRect(0,0,640,360);x.fillStyle='rgba(255,255,255,.85)';x.font='600 34px sans-serif';x.fillText(label+' · '+f,36,320);requestAnimationFrame(d)})();
v.srcObject=c.captureStream(30)}`;
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'none'; media-src 'self' blob:";
const PAGES = {
  '/catalogo': `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>html,body{margin:0;background:#141414;color:#e5e5e5;font:500 18px sans-serif;overflow:hidden}
.top{height:8vh;display:flex;align-items:center;gap:3vw;padding:0 4vw;background:linear-gradient(#000,#14141400)}.top b{color:#e50914;font-size:28px}
.bill{position:absolute;left:4vw;top:12vh;width:36vw;height:20.25vw;border-radius:6px;overflow:hidden}.bill video{width:100%;height:100%;object-fit:cover}
h1{position:absolute;left:44vw;top:14vh;font:700 4vw/1.05 sans-serif;margin:0;max-width:40vw}.row{position:absolute;left:4vw;right:0;bottom:8vh;display:flex;gap:1vw}
.row i{flex:none;width:16vw;height:9vw;border-radius:4px;background:#2a2a2a}.row i:nth-child(2n){background:#3a2f2f}</style></head>
<body><div class="top"><b>SERIES</b><span>Inicio</span><span>Series</span><span>Películas</span></div>
<div class="bill"><video id="tr" muted playsinline autoplay></video></div><h1>Una serie que te va a gustar</h1>
<div class="row"><i></i><i></i><i></i><i></i><i></i><i></i></div>
<script>${STREAM};const v=document.getElementById('tr');stream(v,200,'Tráiler');v.play().catch(()=>{})</script></body></html>`,
  '/watch': `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
video{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:#000}.t{position:fixed;left:5vw;bottom:9vh;font:500 22px sans-serif;color:rgba(255,255,255,.8)}</style></head>
<body><video id="ep" muted playsinline></video><div class="t">Una serie · T1 · episodio 1</div>
<script>${STREAM};const v=document.getElementById('ep');stream(v,20,'Episodio 1');
v.addEventListener('click',()=>{v.play();v.requestFullscreen().catch(()=>{})})</script></body></html>`,
  // botón y campo a la izquierda (lejos del panel y de la píldora); cuenta los clics del botón y los del documento
  '/receta': `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#f4efe6;color:#2b2118;font:400 20px Georgia,serif;overflow:hidden}
h1{position:absolute;left:6vw;top:22vh;margin:0;font-size:5vw}#b{position:absolute;left:6vw;bottom:14vh;font:600 22px sans-serif;padding:16px 28px;border-radius:12px;border:0;background:#c2542d;color:#fff}
#q{position:absolute;left:6vw;top:42vh;width:24vw;font:22px sans-serif;padding:10px}</style></head>
<body><h1>Paella de verduras</h1><input id="q" placeholder="Buscar receta"><button id="b">Siguiente paso</button>
<script>window.__clicks=0;window.__docClicks=0;document.getElementById('b').addEventListener('click',()=>window.__clicks++);
document.addEventListener('click',()=>window.__docClicks++)</script></body></html>`,
};
// el catálogo detrás de un esqueleto: «Cargando…» y cajas grises; a los SKELETON_MS, el contenido (window.__shown)
PAGES['/esqueleto'] = PAGES['/catalogo']
  .replace('<body>', '<body><div id="sk" style="position:fixed;inset:0;z-index:9;background:#141414"><p style="position:absolute;left:0;right:0;top:46vh;text-align:center;margin:0">Cargando…</p>'
    + '<i style="position:absolute;left:4vw;top:12vh;width:36vw;height:20vw;background:#222;border-radius:6px"></i><i style="position:absolute;left:44vw;top:14vh;width:30vw;height:6vh;background:#222"></i></div>')
  .replace(';v.play().catch(()=>{})', `;setTimeout(()=>{document.getElementById('sk').remove();window.__shown=performance.now();v.play().catch(()=>{})},${SKELETON_MS})`);
// un <div> a pantalla completa (el patrón de los reproductores de verdad, no el <video> solo) con su botón abajo a la izquierda
PAGES['/sala'] = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000;color:#ddd;font:500 22px sans-serif;overflow:hidden}
#fs{position:fixed;inset:0;background:linear-gradient(135deg,#1b2a3a,#3a1b2a)}#fs h1{position:absolute;left:6vw;top:30vh;margin:0;font-size:5vw}
#go{position:absolute;left:6vw;bottom:12vh;font:600 22px sans-serif;padding:16px 28px;border-radius:12px;border:0;background:#2d6cc2;color:#fff}</style></head>
<body><div id="fs"><h1>Sala de cine</h1><button id="go">Pantalla completa</button></div>
<script>document.getElementById('go').addEventListener('click',()=>document.getElementById('fs').requestFullscreen().catch(()=>{}))</script></body></html>`;
PAGES['/fotos'] = PAGES['/receta'].replace('Paella de verduras', 'Álbum: vacaciones');
PAGES['/lenta'] = PAGES['/receta'].replace('Paella de verduras', 'Una web que tarda');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (PAGES[u]) {
    const send = () => { r.writeHead(200, { 'content-type': TYPES['.html'], 'content-security-policy': PAGE_CSP }); r.end(PAGES[u]); };
    return u === '/lenta' ? setTimeout(send, SLOW_PAGE_MS) : send();
  }
  const f = path.join(PUB, u === '/' ? 'idle.html' : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...(f.endsWith('.html') ? { 'content-security-policy': IDLE_CSP } : {}) });
  r.end(fs.readFileSync(f));
}).listen(0);
const base = () => `http://127.0.0.1:${srv.address().port}`;
const app = () => `http://${CONTENT_HOST}:${srv.address().port}`;
const NOW = Date.parse('2026-10-21T21:40:00+02:00');
const idleData = now => ({ now, profile: 'day', cfg: { dimMin: 0, rearrangeMin: 0, calm: true },
  weather: { code: 2, isDay: false, temp: 19, max: 23, min: 15, feels: 19, rainNext: 0, sunrise: now - 14 * 3600e3, sunset: now - 2 * 3600e3 },
  music: null, acts: [] });

// ── instrumentación de cada documento (solo medida; la capa la pone el servidor por CDP, no esto):
// frames, cuándo aparece el host, primer frame con el cristal pintado (ResizeObserver: tras el layout, antes de pintar),
// las animaciones de entrada que corren en ese momento y, en cada rAF, la caja de la membrana (window.__samples)
function probe(max) {
  const P = window.__e2e = { frames: 0, hostFrame: -1, glassFrame: -1, glassAt: -1, paint: -1, glass: null, sheet: null, anims: null, trans: null, opacity: '' };
  // primera pintada del documento (lo que se ve en cuanto Chrome deja de enseñar la página anterior)
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-paint' && P.paint < 0) P.paint = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch { /* sin paint timing */ }
  const ENTRY_N = ['wIn', 'wInCalm', 'fadeIn', 'bud'];
  const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  window.__samples = [];
  let prev = 0;
  // cuándo se escribió la geometría que se lee: este rAF puede correr antes o después del de la capa en el mismo frame
  // (va antes: lee lo que la capa escribió en el frame anterior), así que su `dt` no es el del paso que mide. Un
  // MutationObserver del style del cristal (microtarea tras el rAF que escribe) apunta el instante de ese frame (wt)
  let bodyEl = null, wt = 0;
  const wmo = new MutationObserver(() => { wt = document.timeline.currentTime; });
  const tick = now => {
    P.frames++;
    const h = document.getElementById('__tvagent');
    if (h && h.shadowRoot && window.TVAgent && window.__samples.length < max) {
      const r = h.shadowRoot, body = r.querySelector('.body');
      if (body !== bodyEl) { wmo.disconnect(); wmo.observe(body, { attributes: true, attributeFilter: ['style'] }); bodyEl = body; wt = 0; }
      const b = body.getBoundingClientRect(), s = r.querySelector('.sheet').getBoundingClientRect();
      const d = window.TVAgent._debug();
      const tns = [...r.querySelectorAll('.tn')].filter(x => x.getClientRects().length);   // turnos que se ven
      window.__samples.push({ t: now, dt: prev ? now - prev : 1000 / 60, l: b.left, tp: b.top, r: b.right, b: b.bottom,
        sl: s.left, st: s.top, sr: s.right, sb: s.bottom, form: d.form, morph: d.morph, drag: d.drag, vw: innerWidth, vh: innerHeight,
        tn: tns.length, wt });
    }
    prev = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const mo = new MutationObserver(() => {
    const h = document.getElementById('__tvagent');
    if (!h || P.hostFrame >= 0) return;
    P.hostFrame = P.frames;
    const root = h.shadowRoot, body = root && root.querySelector('.body');
    if (!body) return;
    const ro = new ResizeObserver(() => {
      if (P.glassFrame >= 0 || body.getBoundingClientRect().width < 2) return;
      P.glassFrame = P.frames; P.glassAt = performance.now(); P.glass = box(body); P.sheet = box(root.querySelector('.sheet'));
      P.anims = root.getAnimations().map(a => a.animationName).filter(n => ENTRY_N.includes(n));
      // un fundido del cristal (transición de opacidad) dejaría el texto restaurado un instante sin cristal detrás
      P.trans = root.getAnimations().filter(a => a.transitionProperty === 'opacity' || a.transitionProperty === 'background-color')
        .map(a => (a.effect && a.effect.target ? a.effect.target.className : '?') + ':' + a.transitionProperty);
      P.opacity = getComputedStyle(body).opacity;
      ro.disconnect();
    });
    ro.observe(body);
    mo.disconnect();
  });
  mo.observe(document, { childList: true, subtree: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // un navegador por tamaño, con la ventana de ese tamaño: a pantalla completa la página pasa al tamaño de la ventana
  // (en headless, 800×600 por defecto) y la grabación y los fotogramas saldrían recortados
  const browsers = new Map();
  const browserFor = async sz => {
    if (!browsers.has(sz.n)) {
      browsers.set(sz.n, await chromium.launch({ args: [`--window-size=${sz.w},${sz.h}`, `--host-resolver-rules=MAP ${CONTENT_HOST} 127.0.0.1`],
        ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) }));
    }
    return browsers.get(sz.n);
  };
  const fails = [], notes = [], files = [];
  const want = n => !ONLY || ONLY.includes(n);

  /** Contexto + página + servidor de verdad (talk-view y page-poll) contra su sesión CDP. */
  async function rig(sz, { video = false } = {}) {
    // screen = viewport: en headless la pantalla por defecto es 800×600 y a pantalla completa la página pasaría a ese tamaño
    const b = await browserFor(sz);
    const ctx = await b.newContext({ viewport: { width: sz.w, height: sz.h }, screen: { width: sz.w, height: sz.h }, timezoneId: 'Europe/Madrid',
      ...(video ? { recordVideo: { dir: path.join(OUT, 'tmp-video'), size: { width: sz.w, height: sz.h } } } : {}) });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/WebSocket connection to/.test(m.text())) errs.push(m.text()); });
    // sin reloj fijo: el hueco tras navegar se mide con performance.now() contra el paint timing (los dos de verdad)
    await p.addInitScript(probe, SAMPLES_MAX);
    await p.route(/fonts\.googleapis\.com/, x => x.fulfill({ contentType: 'text/css',
      body: "@font-face{font-family:Fraunces;font-weight:100 900;src:url(https://fonts.gstatic.com/fraunces.woff2) format('woff2')}" }));
    await p.route(/fonts\.gstatic\.com/, x => x.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(FRAUNCES) }));
    const s = await ctx.newCDPSession(p);
    const cdp = { ready: true, session: 'e2e', call: (m, params) => s.send(m, params) };
    const state = { media: -1, scroll: null, url: base() + '/', path: '/' };
    const ev = [];
    const t0 = Date.now();
    const mark = (k, v) => ev.push({ at: Date.now() - t0, k, v });
    // como server.js: la página (URL, sin escenario, ¿reposo?) decide el formato; playback de page-poll, la reserva
    const context = () => ({ ctx: state.playback ? 'video' : state.path === '/' ? 'idle' : 'web', playback: state.playback === true,
      page: { url: state.url, stage: null, idle: state.path === '/' && state.url.startsWith(base()) },
      night: false, calm: false, glass: 'A', colors: null });
    const view = createTalkView({ cdp, pub: PUB, context, log: m => errs.push('servidor: ' + m), contentHosts: [...CONTENT_HOSTS, CONTENT_HOST] });
    view.onHide(() => mark('hide'));
    view.onForm((f, can) => mark('form', `${f}:${can}`));
    const poll = createPagePoll({ cdp, state, broadcast() {}, watched: () => false, active: () => view.watching(),
      onPlayback: on => { mark('playback', on); view.playback(on); } });
    poll.start();
    // como server.js (onBinding): el arrastre con el puntero de la tele llega por el binding
    s.on('Runtime.bindingCalled', e => { if (e.name === FORM_BINDING) { mark('binding', e.payload); view.fromPage(e.payload); } });
    // como server.js (onPage): al cambiar de URL, primero la URL nueva; luego la reproducción de cero y la capa se reinyecta
    p.on('framenavigated', f => {
      if (f !== p.mainFrame()) return;
      state.url = f.url(); state.path = new URL(f.url()).pathname;
      mark('nav', state.path); poll.reset(); view.reset();
    });
    return { ctx, p, s, cdp, state, view, poll, errs, ev, mark, t0 };
  }
  async function idle(r) {
    await r.p.goto(base() + '/');
    await r.p.evaluate(d => window.onData(d), idleData(NOW));
    await r.p.evaluate(() => document.fonts.ready);
  }
  /** Respuesta por trozos, como llega del Gateway. */
  async function say(view, text, ms = 70) {
    const w = text.split(' ');
    for (let i = 1; i <= w.length; i++) { view.jota(w.slice(0, i).join(' ') + (i < w.length ? ' ' : '')); await sleep(ms); }
  }
  const dbg = p => p.evaluate(() => window.TVAgent ? window.TVAgent._debug() : null);
  const settled = (p, form, timeout = 6000) => p.waitForFunction(f => window.TVAgent && window.TVAgent._debug().form === f && !window.TVAgent._debug().morph,
    form, { timeout }).then(() => true, () => false);
  const gone = (p, timeout) => p.waitForFunction(() => !document.getElementById('__tvagent'), null, { timeout }).then(() => true, () => false);
  const at = (r, k, v) => { const e = r.ev.find(x => x.k === k && (v === undefined || x.v === v)); return e ? e.at : null; };
  /** La membrana ahora (antes de navegar: el restore la tiene que poner en el mismo sitio). */
  const glassNow = p => p.evaluate(() => { const x = window.__samples.at(-1); return x ? { l: x.l, t: x.tp, r: x.r, b: x.b } : null; });
  const restoreCheck = async (r, tag, before = null) => {
    const P = await r.p.waitForFunction(() => window.__e2e && window.__e2e.glassFrame >= 0 && window.__e2e.paint >= 0 && window.__e2e, null, { timeout: 4000 }).then(h => h.jsonValue()).catch(() => null);
    const bad = [];
    if (!P) { bad.push('la capa no vuelve tras navegar (o sin first-paint)'); return bad; }
    // hasta la primera pintada Chrome sigue enseñando la página anterior (con su capa): el hueco cuenta desde ahí
    const gap = Math.max(0, P.glassAt - P.paint);
    notes.push(`${tag}: host en el rAF ${P.hostFrame}, cristal con tamaño en el rAF ${P.glassFrame} a los ${P.glassAt.toFixed(0)} ms; primera pintada a los ${P.paint.toFixed(0)} ms → hueco ${gap.toFixed(0)} ms; animaciones de entrada: ${P.anims.length}`);
    if (gap > GAP_MAX_MS) bad.push(`hueco de ${gap.toFixed(0)} ms sin capa tras navegar (máx. ${GAP_MAX_MS})`);
    if (P.anims.length) bad.push('restore con animaciones de entrada: ' + P.anims.join(','));
    if (P.trans.length || P.opacity !== '1') bad.push(`restore con transiciones de entrada (${P.trans.join(',') || 'ninguna'}; opacidad del cristal ${P.opacity})`);
    if (before) {
      const d = Math.max(...['l', 't', 'r', 'b'].map(k => Math.abs(P.glass[k] - before[k])));
      notes.push(`${tag}: la membrana del documento nuevo nace a ${d.toFixed(1)} px de donde estaba en el anterior`);
      if (d > CONTINUITY_TOL) bad.push(`la membrana salta ${d.toFixed(0)} px al cambiar de documento (antes ${JSON.stringify(before)}, después ${JSON.stringify(P.glass)})`);
    }
    for (const k of ['l', 't', 'r', 'b']) if (Math.abs(P.glass[k] - P.sheet[k]) > GLASS_TOL) { bad.push(`la membrana no nace en su caja (${k}: ${P.glass[k].toFixed(0)} vs ${P.sheet[k].toFixed(0)})`); break; }
    return bad;
  };
  // fuente con la que se pintó de verdad una palabra de la última respuesta (atraviesa el shadow DOM; en la píldora el
  // turno anterior va oculto y no tiene fuente)
  async function renderedFont(s) {
    await s.send('DOM.enable'); await s.send('CSS.enable');
    const { root } = await s.send('DOM.getDocument', { depth: -1, pierce: true });
    let found = null;
    (function walk(n, inJ) {
      if (found || !n) return;
      const cls = n.attributes ? (n.attributes[n.attributes.indexOf('class') + 1] || '') : '';
      const isJ = n.nodeName === 'P' && /\bj\b/.test(cls);
      if (inJ && n.nodeName === 'SPAN' && /\bwd\b/.test(cls)) { found = n.nodeId; return; }
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])].reverse()) walk(c, inJ || isJ);
    })(root, false);
    if (!found) return null;
    const r = await s.send('CSS.getPlatformFontsForNode', { nodeId: found });
    return r.fonts.map(f => f.familyName).join(', ');
  }
  /** El paso medido en las muestras de la página: sin saltos, dentro del área segura y a tiempo. */
  async function checkMorph(r, sz, tag, bad, form) {
    await sleep(SETTLE_WAIT_MS);                       // el paso ya acabó; la membrana se asienta un poco después
    const S = await r.p.evaluate(() => window.__samples);
    const m = morphStats(S, form);
    if (m.step > MAX_STEP * sz.w) notes.push(`${tag}: salto máximo entre ${JSON.stringify(m.at)}`);
    notes.push(`${tag}: paso a ${form} en ${m.ms.toFixed(0)} ms (${m.frames} frames, ${m.slow} lentos); salto máximo ${m.step.toFixed(1)} px/frame (${(m.step / sz.w * 100).toFixed(1)} % del ancho); fuera del área segura ${m.out.toFixed(1)} px`);
    if (!m.started) bad.push(`no se vio el paso a ${form} (sin fase out en las muestras)`);
    if (m.step > MAX_STEP * sz.w) bad.push(`la membrana salta ${m.step.toFixed(1)} px en un frame (máx. ${(MAX_STEP * sz.w).toFixed(0)})`);
    if (m.jump) bad.push(`la membrana salta ${m.jump.toFixed(1)} px en un frame, más de ${JUMP_RATIO}× el anterior: ${JSON.stringify(m.jumpAt)}`);
    if (!(m.ms < MORPH_MAX_MS)) bad.push(`el paso tarda ${m.ms.toFixed(0)} ms (máx. ${MORPH_MAX_MS})`);
    if (m.out > 1) bad.push(`la membrana sale ${m.out.toFixed(1)} px del área segura`);
    if (m.logJump) bad.push(`el log cambia mientras sale el contenido (antes del viaje): ${m.logJump}`);
    if (!m.hugs) {
      const x = S[S.length - 1] || {};
      bad.push(`la membrana no acaba abrazando el contenido (${form}); última muestra: ${JSON.stringify(x)}`);
    }
    return m;
  }
  async function saveVideo(r, name) {
    const vid = r.p.video();
    await r.ctx.close();
    if (!vid) return;
    const dst = path.join(VIDEOS, name);
    fs.renameSync(await vid.path(), dst); files.push(dst);
  }
  const report = (tag, r, bad) => {
    if (r.errs.length) bad.push('errores: ' + r.errs.join(' | '));
    notes.push(`${tag}: eventos ${r.ev.map(e => `${e.at} ${e.k}${e.v !== undefined ? ':' + e.v : ''}`).join(' · ')}`);
    if (bad.length) fails.push(`✗ ${tag}\n    ` + bad.join('\n    '));
  };

  // ───────────────────────────── contenido: la píldora llega al entrar en la app, sin reproducción
  for (const sz of SIZES.filter(() => want('contenido'))) {
    const tag = `contenido ${sz.n}`;
    const r = await rig(sz, { video: true });
    const { p, view, s } = r;
    const bad = [];
    await idle(r);
    // turno 1, en el reposo: el panel se abre
    view.turn('panel', { voice: true }); await sleep(600);
    view.you('Hola', false); await sleep(250); view.you('Hola Jota', true); await sleep(400);
    await say(view, 'Hola, Sito. ¿Qué te apetece ver esta noche?'); view.done();
    await sleep(1800);
    // turno 2: «ponme esta serie de Netflix»
    view.turn('panel', { voice: true }); await sleep(500);
    for (const t of ['Ponme', 'Ponme esta', 'Ponme esta serie', 'Ponme esta serie de Netflix']) { view.you(t, false); await sleep(220); }
    view.you('Ponme esta serie de Netflix', true); await sleep(700);
    view.tool({ id: 'n1', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', opens: true }); await sleep(900);
    if ((await dbg(p)).form !== 'panel') bad.push('en el reposo no es panel');
    // el agente abre la app: el catálogo (con su tráiler pequeño). La capa vuelve como panel y pasa a píldora sin vídeo
    const before = await glassNow(p);
    await p.goto(app() + '/catalogo');
    bad.push(...(await restoreCheck(r, `${tag} → catálogo`, before)).map(x => 'catálogo: ' + x));
    const restored = (await p.evaluate(() => window.__samples.slice(0, 3).map(x => x.form)));
    if (restored[0] !== 'panel') bad.push(`la página nueva no se restaura como panel antes del paso (${restored.join(',')})`);
    if (!(await settled(p, 'pill'))) bad.push('no pasó a píldora al entrar en la app de contenido');
    notes.push(`${tag}: píldora en el catálogo con playback ${r.state.playback}`);
    if (r.state.playback || at(r, 'playback', true) !== null) bad.push('la píldora llegó por una reproducción, no por el contenido');
    const P = await p.evaluate(() => ({ paint: window.__e2e.paint, out: (window.__samples.find(x => x.morph === 'out') || {}).t }));
    notes.push(`${tag}: el paso empieza ${(P.out - P.paint).toFixed(0)} ms tras la primera pintada (respiro ${MORPH_DELAY_MS} ms)`);
    if (!(P.out - P.paint >= MORPH_DELAY_MS - PAINT_SLACK_MS)) bad.push(`el paso empieza antes de pintada + respiro (${(P.out - P.paint).toFixed(0)} ms)`);
    await checkMorph(r, sz, tag, bad, 'pill');
    await p.screenshot({ path: path.join(OUT, `contenido-${sz.n}-catalogo.png`) }); files.push(path.join(OUT, `contenido-${sz.n}-catalogo.png`));
    // busca y pulsa: /watch dentro de la app (sigue en píldora: se restaura ya como píldora, sin paso)
    await p.goto(app() + '/watch');
    bad.push(...(await restoreCheck(r, `${tag} → /watch`)).map(x => 'watch: ' + x));
    await sleep(MORPH_DELAY_MS + 400);
    const w = await p.evaluate(() => ({ forms: [...new Set(window.__samples.map(x => x.form))], morph: window.__samples.some(x => x.morph) }));
    if (w.forms.join() !== 'pill' || w.morph) bad.push(`en /watch no se queda en píldora (${w.forms.join(',')}${w.morph ? ', con paso' : ''})`);
    view.toolEnd({ id: 'n1', ok: true }); await sleep(300);
    const reply = 'Ahí la tienes. Empieza el primer episodio.';
    await say(view, reply, 90); view.done();
    if (view.awaiting()) bad.push('la página ya estaba pintada y aun así espera');
    await sleep(REVEAL_WAIT_MS);                      // las palabras de la respuesta acaban de entrar
    const font = await renderedFont(s);
    notes.push(`${tag}: fuente pintada en /watch (font-src 'none'): ${font}`);
    if (!font || !/Fraunces/i.test(font)) bad.push(`la capa no usa Fraunces con font-src 'none' (${font})`);
    // identidad antes y después de la pantalla completa
    await p.evaluate(() => { const h = document.getElementById('__tvagent'); window.__h = h; window.__o = h.shadowRoot.querySelector('.orbe'); });
    await p.click('video');                       // play() + requestFullscreen() (gesto real)
    await p.waitForFunction(() => document.fullscreenElement, null, { timeout: 3000 }).catch(() => bad.push('no entró a pantalla completa'));
    await sleep(800);
    const ident = await p.evaluate(ENTRY_N => {
      const h = document.getElementById('__tvagent');
      return { host: h === window.__h, orb: !!h && h.shadowRoot.querySelector('.orbe') === window.__o, top: window.TVAgent._debug().topLayer,
        entry: h ? h.shadowRoot.getAnimations().map(a => a.animationName).filter(n => ENTRY_N.includes(n)).length : -1, form: window.TVAgent._debug().form };
    }, ENTRY);
    notes.push(`${tag}: tras la pantalla completa host igual ${ident.host}, orbe igual ${ident.orb}, capa superior ${ident.top}, animaciones de entrada ${ident.entry}`);
    if (!ident.host || !ident.orb) bad.push('la pantalla completa recreó el host o el orbe');
    if (!ident.top) bad.push('a pantalla completa la capa no está en la capa superior');
    if (ident.entry > 0) bad.push(`la pantalla completa reanimó ${ident.entry} entradas`);
    if (ident.form !== 'pill') bad.push('a pantalla completa no es píldora');
    await p.screenshot({ path: path.join(OUT, `contenido-${sz.n}-pildora.png`) }); files.push(path.join(OUT, `contenido-${sz.n}-pildora.png`));
    const pillFont = await renderedFont(s);
    if (!pillFont || !/Fraunces/i.test(pillFont)) bad.push(`la píldora no usa Fraunces (${pillFont})`);
    // se cierra tras PILL_DWELL (contado desde el fin del turno); pausar no la reabre
    const dwell = PILL_DWELL_BASE_MS + PILL_DWELL_PER_CHAR_MS * reply.length;
    if (!(await gone(p, dwell + 4000))) bad.push(`la píldora no se cierra tras PILL_DWELL (${dwell} ms)`);
    const hideEv = r.ev.filter(e => e.k === 'hide').length;
    await p.evaluate(() => document.exitFullscreen().catch(() => {}));
    await p.evaluate(() => document.getElementById('ep').pause());
    await sleep(2500);
    if (await p.evaluate(() => !!document.getElementById('__tvagent')) || r.ev.filter(e => e.k === 'hide').length !== hideEv || view.watching()) bad.push('pausar volvió a abrir la capa');
    r.poll.stop();
    await saveVideo(r, `contenido-${sz.n}.webm`);
    report(tag, r, bad);
  }

  // ───────────────────────────── esqueleto: la app pinta primero un «Cargando…»; el paso espera a ver su contenido
  if (want('esqueleto')) {
    const sz = SIZES[0], tag = `esqueleto ${sz.n}`;
    const r = await rig(sz);
    const bad = [];
    await idle(r);
    r.view.turn('panel', { voice: false }); r.view.you('Ponme esta serie de Netflix', true); await sleep(500);
    r.view.tool({ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', opens: true }); await sleep(400);
    await r.p.goto(app() + '/esqueleto');
    if (!(await settled(r.p, 'pill', SKELETON_MS + 6000))) bad.push('no pasó a píldora en la app de contenido');
    const P = await r.p.evaluate(() => ({ shown: window.__shown, paint: window.__e2e.paint, out: (window.__samples.find(x => x.morph === 'out') || {}).t }));
    notes.push(`${tag}: primera pintada a los ${P.paint.toFixed(0)} ms, contenido a los ${P.shown ? P.shown.toFixed(0) : '?'} ms, el paso empieza a los ${P.out ? P.out.toFixed(0) : '?'} ms (respiro ${MORPH_DELAY_MS} ms)`);
    if (!P.shown || !(P.out - P.shown >= MORPH_DELAY_MS - PAINT_SLACK_MS)) bad.push(`el paso empieza con el esqueleto aún en pantalla (${(P.out - P.shown).toFixed(0)} ms tras el contenido)`);
    r.view.toolEnd({ id: 'n', ok: true }); r.view.jota('Ahí la tienes.'); r.view.done();
    r.poll.stop(); await r.ctx.close();
    report(tag, r, bad);
  }

  // ───────────────────────────── web normal: sigue el panel y se cierra a su hora
  if (want('web')) {
    const sz = SIZES[0], tag = `web ${sz.n}`;
    const r = await rig(sz);
    const bad = [];
    await idle(r);
    const reply = 'La tienes en pantalla.';
    r.view.turn('panel', { voice: false }); r.view.you('Abre la receta de la paella', true); await sleep(500);
    r.view.tool({ id: 'w', kind: 'web', title: 'Abrir en la tele', detail: 'series.example', opens: true }); await sleep(400);
    // el catálogo en una web normal: su tráiler pequeño en autoplay no es una reproducción de verdad (no hace píldora)
    await r.p.goto(base() + '/catalogo');
    bad.push(...(await restoreCheck(r, `${tag} → catálogo`)).map(x => 'catálogo: ' + x));
    await sleep(MORPH_DELAY_MS + TRAILER_WATCH_MS);
    const w = await r.p.evaluate(() => ({ forms: [...new Set(window.__samples.map(x => x.form))], morph: window.__samples.some(x => x.morph),
      playing: !document.getElementById('tr').paused }));
    notes.push(`${tag}: tráiler sonando ${w.playing}, playback ${r.state.playback}, formas ${w.forms.join(',')}`);
    if (!w.playing) bad.push('el tráiler del catálogo no suena (la prueba no prueba nada)');
    if (r.state.playback || at(r, 'playback', true) !== null) bad.push('el tráiler pequeño cuenta como reproducción');
    if (w.forms.join() !== 'panel' || w.morph) bad.push(`en una web normal no se queda el panel (${w.forms.join(',')})`);
    r.view.toolEnd({ id: 'w', ok: true }); await say(r.view, reply); r.view.done();
    const doneAt = Date.now(), normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * reply.length;
    if (r.view.awaiting()) bad.push('la página ya estaba pintada y aun así espera');
    const ok = await gone(r.p, normal + CLOSE_SLACK_MS);
    const t = Date.now() - doneAt;
    notes.push(`${tag}: cerrada a los ${t} ms del fin (normal ${normal} ms)`);
    if (!ok || t < normal - 300) bad.push(`no se cierra a su hora normal (${t} ms, normal ${normal})`);
    r.poll.stop(); await r.ctx.close();
    report(tag, r, bad);
  }

  // ───────────────────────────── layout: Jota abre una web normal pidiendo la píldora
  if (want('layout')) {
    const sz = SIZES[0], tag = `layout ${sz.n}`;
    const r = await rig(sz);
    const bad = [];
    await idle(r);
    r.view.turn('panel', { voice: false }); r.view.you('Enséñame las fotos de las vacaciones', true); await sleep(500);
    r.view.tool({ id: 'f', kind: 'web', title: 'Abrir en la tele', detail: 'fotos', opens: true });
    r.view.agentLayout('pill', base() + '/fotos');           // como control.nav con m.layout (tv_open)
    await sleep(MORPH_DELAY_MS + 300);
    if ((await dbg(r.p)).form !== 'panel') bad.push('cambió antes de llegar a la página pedida');
    await r.p.goto(base() + '/fotos');
    if (!(await settled(r.p, 'pill'))) bad.push('layout:pill no llega a píldora en una web normal');
    if (r.state.playback) bad.push('hubo reproducción (la prueba no prueba el layout)');
    await checkMorph(r, sz, tag, bad, 'pill');
    r.poll.stop(); await r.ctx.close();
    report(tag, r, bad);
  }

  // ───────────────────────────── arrastre con el puntero de la tele (ratón de Playwright)
  for (const sz of SIZES.filter(() => want('arrastre'))) {
    const tag = `arrastre ${sz.n}`;
    const r = await rig(sz, { video: true });
    const { p, view } = r;
    const bad = [];
    await p.goto(app() + '/receta');                  // una página de la app de contenido: la capa nace píldora
    await p.waitForFunction(() => window.__e2e && document.readyState === 'complete');
    view.turn('panel', { voice: true }); await sleep(400);
    view.you('¿De qué va esta serie?', true); await sleep(500);
    await say(view, 'Es un thriller de época en Madrid: tres hermanas y un secreto de familia.');
    if (!(await settled(p, 'pill'))) bad.push('en la app de contenido no nace píldora');
    const k = sz.w / 1280;                             // los arrastres de la prueba, a la escala de la página
    const glass = () => p.evaluate(() => { const b = document.getElementById('__tvagent').shadowRoot.querySelector('.body').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, t: b.top, w: b.width, h: b.height }; });
    /** Arrastre de verdad: baja, se mueve en DRAG_STEPS pasos y suelta; a mitad mira la goma. */
    async function dragBy(dx, dy) {
      const g = await glass();
      await p.mouse.move(g.x, g.y); await p.mouse.down();
      let mid = null;
      for (let i = 1; i <= DRAG_STEPS; i++) {
        await p.mouse.move(g.x + dx * i / DRAG_STEPS, g.y + dy * i / DRAG_STEPS); await sleep(DRAG_STEP_MS);
        if (i === DRAG_STEPS) mid = await p.evaluate(() => { const r = document.getElementById('__tvagent').shadowRoot, s = r.querySelector('.sheet'); return { drag: window.TVAgent._debug().drag, tf: s.style.transform, b: r.querySelector('.body').getBoundingClientRect().left }; });
      }
      await p.mouse.up();
      return { g, mid };
    }
    // píldora → a la derecha → panel
    const a = await dragBy(DRAG_PX.x * k, 20 * k);
    const tx = Number((a.mid.tf.match(/-?[\d.]+/) || [0])[0]);
    notes.push(`${tag}: arrastrando ${Math.round(DRAG_PX.x * k)} px el contenido va ${tx.toFixed(0)} px (goma); membrana de ${a.g.l.toFixed(0)} a ${a.mid.b.toFixed(0)}`);
    if (!a.mid.drag) bad.push('el arrastre no se reconoce (¿la membrana no recibe el puntero?)');
    if (!(tx > 0 && tx < DRAG_PX.x * k && tx <= BAND_MAX * sz.w)) bad.push(`sin goma: el contenido va ${tx} px por ${DRAG_PX.x * k} de dedo`);
    if (!(a.mid.b > a.g.l + 1)) bad.push('la membrana no sigue al dedo');
    if (!(await settled(p, 'panel'))) bad.push('arrastrada a la derecha no pasa a panel');
    if (view.form().form !== 'panel' || at(r, 'binding', 'panel') === null) bad.push('el servidor no se entera del arrastre (binding)');
    await checkMorph(r, sz, tag + ' → panel', bad, 'panel');
    await sleep(800);
    if ((await dbg(p)).form !== 'panel') bad.push('el panel no se mantiene sobre el contenido tras el arrastre');
    await p.screenshot({ path: path.join(OUT, `arrastre-${sz.n}-panel.png`) }); files.push(path.join(OUT, `arrastre-${sz.n}-panel.png`));
    // panel → hacia arriba y al centro → píldora
    await p.evaluate(() => { window.__samples.length = 0; });
    await dragBy(DRAG_PX.left * k, DRAG_PX.up * k);
    if (!(await settled(p, 'pill'))) bad.push('arrastrado hacia el centro no vuelve a píldora');
    if (view.form().form !== 'pill') bad.push('el servidor no se entera del segundo arrastre');
    await checkMorph(r, sz, tag + ' → píldora', bad, 'pill');
    // un clic fuera de la membrana llega a la web; uno en la membrana, no
    const btn = await p.evaluate(() => { const b = document.getElementById('b').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await p.mouse.click(btn.x, btn.y);
    const g = await glass();
    await p.mouse.click(g.x, g.y);
    const clicks = await p.evaluate(() => [window.__clicks, window.__docClicks]);
    notes.push(`${tag}: clics en el botón ${clicks[0]}, en el documento ${clicks[1]} (uno fuera de la membrana y uno dentro)`);
    if (clicks[0] !== 1) bad.push('el clic fuera de la membrana no llega a la web');
    if (clicks[1] !== 1) bad.push('el clic en la membrana llega al documento de la web');
    // tv_click_at de Jota debajo de la membrana: como control.clickAt (la capa deja pasar el puntero mientras pulsa)
    const AGENT_PASS = on => `window.TVAgent&&window.TVAgent.pass&&window.TVAgent.pass(${on})`;
    await r.s.send('Runtime.evaluate', { expression: AGENT_PASS(true) });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await r.s.send('Input.dispatchMouseEvent', { type, x: g.x, y: g.y, button: 'left', clickCount: 1 });
    await r.s.send('Runtime.evaluate', { expression: AGENT_PASS(false) });
    if ((await p.evaluate(() => window.__docClicks)) !== 2) bad.push('un clic de Jota (tv_click_at) debajo de la membrana no llega a la web');
    await p.mouse.click(g.x, g.y);
    if ((await p.evaluate(() => window.__docClicks)) !== 2) bad.push('tras el clic de Jota la membrana no vuelve a recibir el puntero');
    // el arrastre no quita el foco al campo en el que se escribe
    await p.click('#q'); await p.keyboard.type('paella');
    await dragBy(-60 * k, 0);
    await sleep(500);
    const focus = await p.evaluate(() => [document.activeElement && document.activeElement.id, document.getElementById('q').value]);
    if (focus[0] !== 'q' || focus[1] !== 'paella') bad.push(`el arrastre quita el foco o el texto del campo (${focus.join(', ')})`);
    if ((await dbg(p)).form !== 'pill') bad.push('un arrastre corto cambió el formato');
    // un <div> a pantalla completa (el reproductor de YouTube o Netflix): lo de fuera es inerte, así que el host se mete
    // dentro y la membrana se sigue arrastrando
    await p.goto(app() + '/sala');
    if (!(await settled(p, 'pill'))) bad.push('en la sala no sigue la píldora (override del contenido)');
    const goBtn = await p.evaluate(() => { const b = document.getElementById('go').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await p.mouse.click(goBtn.x, goBtn.y);
    if (!(await p.waitForFunction(() => document.fullscreenElement, null, { timeout: 3000 }).then(() => true, () => false))) bad.push('la sala no entra a pantalla completa');
    await sleep(600);
    const fsHost = await p.evaluate(() => ({ inside: document.getElementById('__tvagent').parentNode === document.fullscreenElement, top: window.TVAgent._debug().topLayer }));
    const nb = r.ev.filter(e => e.k === 'binding').length;
    await dragBy(DRAG_PX.x * k, 20 * k);
    const fsOk = await settled(p, 'panel');
    notes.push(`${tag}: con un <div> a pantalla completa el host está dentro ${fsHost.inside} (capa superior ${fsHost.top}); arrastrada a la derecha → ${fsOk ? 'panel' : 'sin cambio'}`);
    if (!fsHost.inside || !fsHost.top) bad.push(`a pantalla completa de un <div> el host no está dentro y arriba (${JSON.stringify(fsHost)})`);
    if (!fsOk || r.ev.filter(e => e.k === 'binding').length !== nb + 1) bad.push('a pantalla completa de un <div> la membrana no se arrastra');
    await p.screenshot({ path: path.join(OUT, `arrastre-${sz.n}-pantalla-completa.png`) }); files.push(path.join(OUT, `arrastre-${sz.n}-pantalla-completa.png`));
    await p.evaluate(() => document.exitFullscreen().catch(() => {}));
    view.done();
    await gone(p, PILL_DWELL_BASE_MS + 8000);
    r.poll.stop();
    await saveVideo(r, `arrastre-${sz.n}.webm`);
    report(tag, r, bad);
  }

  // ───────────────────────────── espera: una web lenta no deja cerrar la capa antes de llegar
  if (want('espera')) {
    const sz = SIZES[0], tag = `espera ${sz.n}`;
    const r = await rig(sz);
    const bad = [];
    await idle(r);
    const reply = 'La tienes en pantalla.';
    r.view.turn('panel', { voice: false }); r.view.you('Abre esa web', true); await sleep(500);
    r.view.tool({ id: 'w', kind: 'web', title: 'Abrir en la tele', detail: 'lenta.example', opens: true });
    const navAt = Date.now();
    const nav = r.p.goto(base() + '/lenta').catch(e => bad.push('navegación: ' + e.message));
    await sleep(300);
    r.view.toolEnd({ id: 'w', ok: true }); await say(r.view, reply); r.view.done();
    const normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * reply.length;
    if (!r.view.awaiting()) bad.push('con la página aún sin llegar no espera');
    await sleep(Math.min(normal + 500, SLOW_PAGE_MS - 1000 - (Date.now() - navAt)));
    if (r.ev.some(e => e.k === 'hide')) bad.push(`se cerró a su hora normal (${normal} ms) sin esperar a la página`);
    await nav;
    const ok = await gone(r.p, AFTER_PAINT_MIN_MS + CLOSE_SLACK_MS + 2000);
    const t = Date.now() - navAt;
    notes.push(`${tag}: página a los ${at(r, 'nav', '/lenta') - (navAt - r.t0)} ms, cerrada a los ${t} ms de abrirla (lenta ${SLOW_PAGE_MS} ms + ${AFTER_PAINT_MIN_MS} ms encima; tope ${AWAIT_PAGE_MS} ms)`);
    if (!ok) bad.push('no se cierra tras llegar la página');
    if (t < SLOW_PAGE_MS + AFTER_PAINT_MIN_MS - 300) bad.push(`se cerró antes de verse un rato sobre la página nueva (${t} ms)`);
    r.poll.stop(); await r.ctx.close();
    report(tag, r, bad);
  }

  // ───────────────────────────── tira de fotogramas del paso por reproducción (reserva, en una web normal)
  for (const sz of SIZES.filter(() => want('tira'))) {
    const tag = `tira ${sz.n}`;
    const r = await rig(sz);
    const { p, view, s } = r;
    await p.goto(base() + '/watch');
    await p.waitForFunction(() => window.__e2e && document.readyState === 'complete');
    view.turn('panel', { voice: false }); view.you('Ponme esta serie de Netflix', true); await sleep(500);
    view.tool({ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix' }); await sleep(500);
    view.toolEnd({ id: 'n', ok: true }); await say(view, 'Ahí la tienes. Empieza el primer episodio.'); view.done();
    await sleep(2200);
    const dir = path.join(OUT, `tira-${sz.n}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    s.on('Page.screencastFrame', f => { frames.push({ t: f.metadata.timestamp * 1000, data: f.data }); s.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
    await s.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: sz.w, maxHeight: sz.h });
    await p.click('video');
    if (!(await settled(p, 'pill'))) fails.push(`✗ ${tag}: no pasó a píldora al reproducir`);
    await sleep(1200);
    await s.send('Page.stopScreencast');
    // desde el último frame con el panel quieto: uno cada TIRA_STEP_MS
    const picked = [];
    for (const f of frames) if (!picked.length || f.t - picked[picked.length - 1].t >= TIRA_STEP_MS) picked.push(f);
    const keep = picked.slice(-Math.min(picked.length, 30));
    keep.forEach((f, i) => fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), Buffer.from(f.data, 'base64')));
    notes.push(`${tag}: ${frames.length} fotogramas, ${keep.length} en ${dir}`);
    // hoja de contactos: 5 columnas, con el tiempo de cada uno
    const sheet = await r.ctx.newPage();
    const cols = 5, cw = 384, ch = Math.round(cw * sz.h / sz.w);
    await sheet.setViewportSize({ width: cols * cw, height: Math.ceil(keep.length / cols) * (ch + 22) });
    await sheet.evaluate(async ([list, cols, cw, ch]) => {
      const c = document.createElement('canvas'); c.width = cols * cw; c.height = Math.ceil(list.length / cols) * (ch + 22);
      document.body.style.margin = '0'; document.body.appendChild(c);
      const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, c.width, c.height); x.font = '14px sans-serif';
      for (let i = 0; i < list.length; i++) {
        const img = new window.Image(); img.src = 'data:image/png;base64,' + list[i].data; await img.decode();
        const cx = (i % cols) * cw, cy = Math.floor(i / cols) * (ch + 22);
        x.drawImage(img, cx, cy, cw - 4, ch); x.fillStyle = '#ddd'; x.fillText(`+${Math.round(list[i].t - list[0].t)} ms`, cx + 6, cy + ch + 16);
      }
    }, [keep, cols, cw, ch]);
    const sheetFile = path.join(OUT, `tira-${sz.n}.png`);
    await sheet.screenshot({ path: sheetFile, fullPage: true }); files.push(sheetFile, dir);
    if (r.errs.length) fails.push(`✗ ${tag}: errores: ${r.errs.join(' | ')}`);
    r.poll.stop(); await r.ctx.close();
  }

  for (const b of browsers.values()) await b.close();
  srv.close();
  fs.rmSync(path.join(OUT, 'tmp-video'), { recursive: true, force: true });
  if (fails.length) console.error(fails.join('\n'));
  console.log(notes.join('\n'));
  console.log(`archivos:\n  ${files.join('\n  ')}`);
  console.log(`${fails.length} fallos`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/**
 * Del muestreo por rAF: desde el primer frame con el contenido saliendo hasta que la membrana abraza el contenido quieto
 * en la forma `form`. step: paso máximo de un borde por frame de 60 Hz (un frame lento cuenta como varios); jump: el mayor
 * frame que es más de JUMP_RATIO veces el anterior (un salto, no velocidad); out: lo que
 * más sale del área segura (también arrastrando: la goma no la saca); logJump: cambiaron los turnos que se ven mientras
 * el contenido salía, antes del viaje (se vería un corte, no un pliegue).
 */
function morphStats(S, form) {
  const i0 = S.findIndex(x => x.morph === 'out');
  const res = { started: i0 >= 0, ms: Infinity, frames: 0, slow: 0, step: 0, jump: 0, out: 0, hugs: false, logJump: '' };
  for (const x of S) {                                 // arrastrando, antes del paso
    if (!x.drag) continue;
    const safe = { l: x.vw * SAFE.x, t: x.vh * SAFE.y, r: x.vw * (1 - SAFE.x), b: x.vh * (1 - SAFE.y) };
    res.out = Math.max(res.out, safe.l - x.l, safe.t - x.tp, x.r - safe.r, x.b - safe.b);
  }
  if (i0 < 0) return res;
  // contra el último frame antes del paso (si el log cambia en el mismo render que empieza el paso, el primer frame 'out'
  // ya sale cortado): los turnos que se ven no cambian hasta el viaje
  const base = S[i0 - 1];
  for (let i = i0; base && i < S.length && S[i].morph === 'out'; i++) {
    if (S[i].tn !== base.tn) { res.logJump = `${base.tn}→${S[i].tn} turnos a la vista a los ${Math.round(S[i].t - S[i0].t)} ms de empezar`; break; }
  }
  let still = 0, end = -1, prevSt = 0, prev2 = 0;
  for (let i = i0; i < S.length; i++) {
    const a = S[i - 1], x = S[i];
    if (a && i > i0) {
      // el paso se reparte en el tiempo entre las dos escrituras que se leen (wt), no en el del muestreo: con frames de
      // 33 y 17 ms alternos, el dt del muestreo va un frame desfasado y un paso normal de 33 ms parece un salto en 17
      const wdt = x.wt && a.wt && x.wt > a.wt ? x.wt - a.wt : x.dt;
      const k = Math.max(1, wdt / FRAME_MS);
      if (x.dt > FRAME_MS * 1.5) res.slow++;
      const st = Math.max(...['l', 'tp', 'r', 'b'].map(p => Math.abs(x[p] - a[p]) / k));
      const at = () => [a, x].map(y => [y.t - S[i0].t, y.l, y.tp, y.r, y.b, y.morph].map(v => (typeof v === 'number' ? Math.round(v) : v)));
      if (st > res.step) { res.step = st; res.at = at(); }
      // salto: mucho más que el frame anterior, y no un arranque desde parado (los DOS primeros frames con movimiento: con
      // frames de 17 y 33 ms alternos, el segundo del arranque de un muelle sale hasta ~2,9× el primero; ver agente-pestanas.js)
      if (prevSt > MOVING_PX && prev2 > MOVING_PX && st > JUMP_RATIO * prevSt && st > JUMP_MIN * x.vw && st > res.jump) { res.jump = st; res.jumpAt = at(); }
      prev2 = prevSt; prevSt = st;
    }
    const safe = { l: x.vw * SAFE.x, t: x.vh * SAFE.y, r: x.vw * (1 - SAFE.x), b: x.vh * (1 - SAFE.y) };
    res.out = Math.max(res.out, safe.l - x.l, safe.t - x.tp, x.r - safe.r, x.b - safe.b);
    const hug = x.form === form && !x.morph && Math.abs(x.l - x.sl) <= GLASS_TOL && Math.abs(x.tp - x.st) <= GLASS_TOL && Math.abs(x.r - x.sr) <= GLASS_TOL && Math.abs(x.b - x.sb) <= GLASS_TOL;
    still = hug ? still + 1 : 0;
    if (still >= SETTLE_TOL_FRAMES && end < 0) { end = i - SETTLE_TOL_FRAMES + 1; break; }
  }
  if (end >= 0) { res.hugs = true; res.ms = S[end].t - S[i0].t; res.frames = end - i0; }
  return res;
}
