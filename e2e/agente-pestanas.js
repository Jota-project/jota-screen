// Netflix en su propia pestaña: la capa del agente con el servidor de verdad (src/tv/talk-view.js + src/tv/page-poll.js)
// y el enganche de verdad (src/tv/cdp.js: createCdp con una sola sesión CDP; show() engancha la de destino, espera a que
// la capa esté pintada en ella, Target.activateTarget, quita la capa de la que deja y la suelta) contra un Chromium de Playwright lanzado con --remote-debugging-port. Sin tele, sin
// Gateway y sin red.
// Uso: cd e2e && node agente-pestanas.js [carpeta-salida] [--solo abrir,abierta,espera] [--videos carpeta]
//      (npm run agente:pestanas; CHROME=/ruta para otro navegador).
// Los ganchos de createCdp se cablean como en remote/server.js: onAttached (otra pestaña delante) y onPage (otra URL) →
// primero la URL nueva, luego pagePoll.reset() + talkView.reset() (en onAttached, reset({ tab: true }), cuya promesa
// devuelve: show() la espera antes de traer la pestaña al frente); onLeft → talkView.leave() (la que se deja); el binding
// del arrastre va a talkView.fromPage().
// «Abrir Netflix» es lo que hace la orden netflix (server.js + features/netflix.js): talkView.navigating() y cdp.show()
// de su pestaña (ya cargada, o una nueva: ctx.newPage() + show + Page.navigate, como netflix.front con newTab; newTab()
// de cdp.js crea la pestaña en el contexto por defecto, que Playwright no ve: sin sonda ni vídeo). «Salir» es
// netflix.leave: pausa el vídeo y cdp.show() de la otra pestaña. La «app de contenido» es CONTENT_HOST, un host de pruebas
// que Chromium resuelve a 127.0.0.1 (--host-resolver-rules) y que se añade a CONTENT_HOSTS solo aquí.
// Escenas:
//   abrir    (casos 1 y 2) reposo con el panel abierto y una conversación → «abrir Netflix» = traer al frente la segunda
//            pestaña, ya cargada (/catalogo): la capa aparece en ella en modo restore (sin animaciones de entrada ni
//            transiciones, la membrana en su caja y donde estaba en la otra), con un hueco ≤ TAB_GAP_MAX_MS desde el cambio,
//            y pasa a píldora tras el respiro sin saltos (MAX_STEP, JUMP_RATIO). La conversación se cierra en Netflix →
//            se vuelve a la pestaña de siempre (netflix.leave): no queda ningún panel huérfano (TVAgent._debug().open false
//            y sin membrana a la vista; el que se quedó pintado, quieto ≤ STALE_MAX_MS y fundido ≤ FADE_MAX_MS). Vídeo:
//            abrir-reposo.webm y abrir-netflix.webm (cada pestaña) y abrir-tele.webm (lo que enseña la tele, empalmado
//            con ffmpeg si está en el PATH).
//   abierta  (caso 3) con la conversación aún abierta y algo nuevo dicho en Netflix, volver a la pestaña de siempre: la
//            capa pasa al estado actual (lo dicho en Netflix y su forma) en ≤ STALE_MAX_MS, sin hueco (≤ TAB_GAP_MAX_MS) y
//            sin saltos, y acaba con todo lo dicho a la vista en la forma de ahora.
//   espera   (caso 4) sin eventos de herramienta, solo navigating() de la orden netflix: Netflix en una pestaña nueva que
//            tarda en llegar; el cierre no corre hasta que la página está pintada y la capa se ve encima al menos
//            AFTER_PAINT_MIN_MS; talk-view no deja de esperar (awaiting) antes de que se pinte la página de verdad. Con
//            SLOW_TAB_MS (por debajo de PAINT_WAIT_MS) y SLOW_TAB_LONG_MS (por encima), desde el reposo (panel: al llegar, el
//            paso a píldora vuelve a armar el cierre) y desde una app de contenido (ya en píldora: solo cuenta la espera).
// Limitación: en headless las pestañas de detrás siguen «visibles» (visibilityState y rAF) y pintando; en el kiosco se
// congelan. El hueco se mide con el reloj de pared desde justo antes de show() hasta el primer rAF de la pestaña nueva
// con la membrana a la vista; lo que se ve al volver a una pestaña es lo que se quedó pintado en ella al salir.
// Salida: e2e/capturas-agente/pestanas/ (o la carpeta que se pase); vídeos en --videos (por defecto, la misma).
// probe() y morphStats() son copia de agente-serie.js (con el instante de pared de cada muestra, si la membrana se ve y
// cada muestra atribuida al frame en que la membrana la escribió: ver probe).
/* global window, document, location, performance, requestAnimationFrame, innerWidth, innerHeight, MutationObserver, ResizeObserver, PerformanceObserver, getComputedStyle */
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'remote', 'public');
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = arg('--solo') ? arg('--solo').split(',') : null;
const outArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const OUT = path.resolve(outArg || path.join(__dirname, 'capturas-agente', 'pestanas'));
const VIDEOS = path.resolve(arg('--videos') || OUT);
const FRAUNCES = require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(VIDEOS, { recursive: true });

const SRC = (...p) => require(path.join(ROOT, 'remote', 'src', ...p));
const { createCdp } = SRC('tv', 'cdp.js');
const { createTalkView, CLOSE_BASE_MS, CLOSE_PER_CHAR_MS, PILL_DWELL_BASE_MS, PILL_DWELL_PER_CHAR_MS, MORPH_DELAY_MS, AFTER_PAINT_MIN_MS,
  PAINT_WAIT_MS } = SRC('tv', 'talk-view.js');
const { createPagePoll } = SRC('tv', 'page-poll.js');
const { CONTENT_HOSTS } = SRC('tv', 'agent-form.js');
const { FORM_BINDING } = SRC('tv', 'agent-contract.js');
const { IDLE_CSP } = SRC('transport', 'static.js');

// ── umbrales (todos revisables)
const CONTENT_HOST = 'netflix-e2e.test';
const SZ = { w: 1280, h: 720 };
// Hueco al cambiar de pestaña. En la misma pestaña el requisito es ≈ 1 frame (GAP_MAX_MS de agente-serie.js: el script de
// documento nuevo la pinta antes de la primera pintada). Con Netflix en otra pestaña ya cargada no hay documento nuevo: la
// pinta el primer flush tras onAttached (Target.attachToTarget + batchMs + un Runtime.evaluate con la fuente entera, fuentes
// incluidas). Tope: 50 ms (≈ 3 frames): el de la misma pestaña más el enganche y una llamada; esperar a batchMs (100 ms)
// ya no cabe (y se ve como un parpadeo de la capa).
const TAB_GAP_MAX_MS = 50;
// Lo que se quedó pintado en la pestaña a la que se vuelve (panel viejo o estado viejo), quieto, hasta que llegue lo de
// ahora (reset → HIDE, o la foto nueva, que empieza su paso o su fundido): el mismo camino que el hueco (enganche +
// batchMs + evaluate). 300 ms: una foto vieja más tiempo ya se lee. Después, el fundido de salida (≤ FADE_MAX_MS).
const STALE_MAX_MS = 300;
const FADE_MAX_MS = 600;
// saltos de la membrana: los mismos que agente-serie.js
const MAX_STEP = 0.08;         // tope absoluto de un borde por frame de 60 Hz, en fracción del ancho
const JUMP_RATIO = 2.5;        // un frame más largo que esto por el anterior (si el anterior ya se movía) es un salto
const JUMP_MIN = 0.02;         // por debajo de esto (fracción del ancho) un frame no cuenta como salto aunque acelere
// El arranque desde parado no es un salto. agente-serie.js lo exime con «el frame anterior ya se movía» (> 2 px); aquí, con
// frames de 17 y 33 ms alternos (headless con dos pestañas), el segundo frame del arranque ya sale hasta ~2,9× el primero
// (muelle desde parado: 17 ms y luego 33 ms dan (17+33)·33 / 17² / 2 ≈ 2,85): el arranque son los DOS primeros frames
// con movimiento. MAX_STEP y JUMP_RATIO, los mismos.
const MOVING_PX = 2;
const FRAME_MS = 1000 / 60;
const MORPH_MAX_MS = 2200;
const PAINT_SLACK_MS = 60;     // relojes de dos procesos
const GLASS_TOL = 3;
const SAFE = { x: 0.05, y: 0.06 };
const SETTLE_TOL_FRAMES = 6;
const SETTLE_WAIT_MS = 1400;
const CONTINUITY_TOL = 4;      // px: la membrana nace en la pestaña nueva donde estaba en la anterior
const SAMPLES_MAX = 6000;      // muestras por documento (se vacían antes de cada cambio de pestaña)
const SLOW_TAB_MS = 3000;      // lo que tarda en responder la página de la pestaña nueva (caso 4)…
const SLOW_TAB_LONG_MS = 4800; // …y la que tarda más que PAINT_WAIT_MS (Page.navigate de cdp.js corta a los 5 s)
const CLOSE_SLACK_MS = 300;

// ── páginas de prueba (en CONTENT_HOST, con font-src 'none' como una app de verdad)
const STREAM = `function stream(v,hue,label){const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let f=0;
(function d(){f++;const g=x.createLinearGradient(0,0,640,360);g.addColorStop(0,'hsl('+((hue+f)%360)+' 45% 22%)');g.addColorStop(1,'hsl('+((hue+f+60)%360)+' 50% 38%)');
x.fillStyle=g;x.fillRect(0,0,640,360);x.fillStyle='rgba(255,255,255,.85)';x.font='600 34px sans-serif';x.fillText(label+' · '+f,36,320);requestAnimationFrame(d)})();
v.srcObject=c.captureStream(30)}`;
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'none'; media-src 'self' blob:";
const CATALOGO = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>html,body{margin:0;background:#141414;color:#e5e5e5;font:500 18px sans-serif;overflow:hidden}
.top{height:8vh;display:flex;align-items:center;gap:3vw;padding:0 4vw;background:linear-gradient(#000,#14141400)}.top b{color:#e50914;font-size:28px}
.bill{position:absolute;left:4vw;top:12vh;width:36vw;height:20.25vw;border-radius:6px;overflow:hidden}.bill video{width:100%;height:100%;object-fit:cover}
h1{position:absolute;left:44vw;top:14vh;font:700 4vw/1.05 sans-serif;margin:0;max-width:40vw}.row{position:absolute;left:4vw;right:0;bottom:8vh;display:flex;gap:1vw}
.row i{flex:none;width:16vw;height:9vw;border-radius:4px;background:#2a2a2a}.row i:nth-child(2n){background:#3a2f2f}</style></head>
<body><div class="top"><b>SERIES</b><span>Inicio</span><span>Series</span><span>Películas</span></div>
<div class="bill"><video id="tr" muted playsinline autoplay></video></div><h1>Una serie que te va a gustar</h1>
<div class="row"><i></i><i></i><i></i><i></i><i></i><i></i></div>
<script>${STREAM};const v=document.getElementById('tr');stream(v,200,'Tráiler');v.play().catch(()=>{})</script></body></html>`;
const PAGES = { '/catalogo': CATALOGO, '/lenta': CATALOGO.replace('Una serie que te va a gustar', 'Una app que tarda'),
  '/lenta-larga': CATALOGO.replace('Una serie que te va a gustar', 'Una app que tarda más') };
const DELAY = { '/lenta': SLOW_TAB_MS, '/lenta-larga': SLOW_TAB_LONG_MS };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (PAGES[u]) {
    const send = () => { r.writeHead(200, { 'content-type': TYPES['.html'], 'content-security-policy': PAGE_CSP }); r.end(PAGES[u]); };
    return DELAY[u] ? setTimeout(send, DELAY[u]) : send();
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

// ── instrumentación de cada documento (copia de agente-serie.js; solo mide): en cada rAF el instante de pared (e), si la
// membrana se ve (vis), su caja y la del contenido, forma, paso, abierta y el texto de los turnos a la vista; y el primer
// frame con el cristal pintado (con las animaciones y transiciones que corren en ese momento)
function probe(max) {
  const P = window.__e2e = { frames: 0, hostFrame: -1, glassFrame: -1, glassAt: -1, paint: -1, glass: null, sheet: null, anims: null, trans: null, opacity: '' };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-paint' && P.paint < 0) P.paint = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch { /* sin paint timing */ }
  const ENTRY_N = ['wIn', 'wInCalm', 'fadeIn', 'bud'];
  const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  window.__samples = [];
  // La sonda se registra al cargar el documento y su bucle no para nunca; el de la membrana se (re)arranca después (al
  // pintar o despertar), así que en cada frame la sonda corre ANTES que la membrana: lo que lee al empezar el frame N+1 es
  // lo que la membrana escribió en el N. La muestra lleva el instante y el dt del frame N (sin esto, con frames de 17 y
  // 33 ms alternos, como en headless con dos pestañas pintando, cada paso se divide por el dt del frame equivocado y salen
  // «saltos» que no existen; a 60 Hz constantes da igual)
  let prev = 0, prevDt = 1000 / 60;
  const tick = now => {
    P.frames++;
    const S = window.__samples, t = prev, e = performance.timeOrigin + prev, dt = prevDt;
    if (prev) prevDt = now - prev;
    prev = now;
    requestAnimationFrame(tick);
    if (!t || S.length >= max) return;
    const h = document.getElementById('__tvagent'), r = h && h.shadowRoot, body = r && r.querySelector('.body');
    if (!body || !window.TVAgent) { S.push({ t, e, dt, vis: 0, host: !!h }); return; }
    const b = body.getBoundingClientRect(), s = r.querySelector('.sheet').getBoundingClientRect();
    const d = window.TVAgent._debug(), op = Number(getComputedStyle(body).opacity);
    const tns = [...r.querySelectorAll('.tn')].filter(x => x.getClientRects().length);
    S.push({ t, e, dt, host: true, vis: b.width > 2 && op > 0.05 ? 1 : 0, op, off: body.classList.contains('off'), // se ve: tamaño y opacidad (también fundiéndose)
      l: b.left, tp: b.top, r: b.right, b: b.bottom, sl: s.left, st: s.top, sr: s.right, sb: s.bottom,
      form: d.form, morph: d.morph, drag: d.drag, open: d.open, vw: innerWidth, vh: innerHeight, tn: tns.length,
      txt: tns.map(x => x.textContent).join(' | ') });
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
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const waitFor = async (fn, ms, every = 20) => { const t0 = Date.now(); for (;;) { if (fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(every); } };
const r0 = n => Math.round(n);

(async () => {
  const fails = [], notes = [], files = [], measures = [];
  const want = n => !ONLY || ONLY.includes(n);

  /**
   * Navegador con puerto de depuración, contexto (con sonda, fuentes y vídeo si se pide), las pestañas `tabs` ya cargadas
   * y el servidor de verdad (createCdp + talk-view + page-poll) cableado como server.js.
   * @param {{ key: string, url: string }[]} tabs
   */
  async function rig(tabs, { video = false } = {}) {
    const port = await freePort();
    const browser = await chromium.launch({ args: [`--window-size=${SZ.w},${SZ.h}`, `--host-resolver-rules=MAP ${CONTENT_HOST} 127.0.0.1`, `--remote-debugging-port=${port}`],
      ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({ viewport: { width: SZ.w, height: SZ.h }, screen: { width: SZ.w, height: SZ.h }, timezoneId: 'Europe/Madrid',
      ...(video ? { recordVideo: { dir: path.join(OUT, 'tmp-video'), size: { width: SZ.w, height: SZ.h } } } : {}) });
    await ctx.addInitScript(probe, SAMPLES_MAX);
    await ctx.route(/fonts\.googleapis\.com/, x => x.fulfill({ contentType: 'text/css',
      body: "@font-face{font-family:Fraunces;font-weight:100 900;src:url(https://fonts.gstatic.com/fraunces.woff2) format('woff2')}" }));
    await ctx.route(/fonts\.gstatic\.com/, x => x.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(FRAUNCES) }));
    const errs = [], ev = [], t0 = Date.now();
    const mark = (k, v) => ev.push({ at: Date.now(), k, v });
    const R = { browser, ctx, errs, ev, mark, t0, tabs: /** @type {Record<string, any>} */ ({}) };
    /** Pestaña de Playwright → su targetId (para cdp.show). */
    R.addTab = async (key, url) => {
      const p = await ctx.newPage();
      const born = Date.now();
      p.on('pageerror', e => errs.push(`${key}: ${e.message}`));
      p.on('console', m => { if (m.type() === 'error' && !/WebSocket connection to|ERR_CONNECTION_REFUSED|404/.test(m.text())) errs.push(`${key}: ${m.text()}`); });
      const s = await ctx.newCDPSession(p);
      const { targetInfo } = await s.send('Target.getTargetInfo');
      await s.detach();
      R.tabs[key] = { key, p, born, id: targetInfo.targetId };
      if (url) await p.goto(url);
      return R.tabs[key];
    };
    for (const t of tabs) await R.addTab(t.key, t.url);
    const keyOf = id => (Object.values(R.tabs).find(t => t.id === id) || {}).key || id;

    // como server.js: state.url con la pestaña activa; la página decide el formato
    const state = { media: -1, scroll: null, url: '', path: '/' };
    const setUrl = u => { state.url = u; try { state.path = new URL(u).pathname; } catch { state.path = ''; } };
    const context = () => ({ ctx: state.playback ? 'video' : state.path === '/' && state.url.startsWith(base()) ? 'idle' : 'web', playback: state.playback === true,
      page: { url: state.url, stage: null, idle: state.path === '/' && state.url.startsWith(base()) },
      night: false, calm: false, glass: 'A', colors: null });
    /** @type {any} */ let view = null, poll = null;
    const cdp = createCdp({ port, retryMs: 300, log: { info() {}, error: m => errs.push('cdp: ' + m) }, hooks: {
      onDown() { if (poll) poll.reset(); if (view) view.reset(); },
      onAttached(t, from) {
        mark('attached', t ? keyOf(t.targetId) : '?');
        if (t) setUrl(t.url);
        poll.reset();
        return view.reset({ tab: true, from });  // como server.js: cdp.show espera a que la capa esté pintada en ella
      },
      onLeft(call) { mark('left'); return view.leave(call); },
      onPage(t) {
        if (t.url === state.url) return;
        setUrl(t.url); mark('nav', `${keyOf(t.targetId)} ${state.path}`);
        poll.reset(); view.reset();
      },
      onBinding(name, payload) { if (name === FORM_BINDING) view.fromPage(payload); },
    } });
    // registro (sin cambiar nada): cuándo sale y llega cada foto de la capa, con o sin la fuente
    const call = cdp.call.bind(cdp);
    cdp.call = (m, p, b) => {
      const x = call(m, p, b);
      if (process.env.DEBUG_CDP) { const id = `${m}${b ? ' (navegador)' : ''} ${keyOf(cdp.targetId)} ${String(cdp.session).slice(0, 6)} ${p && p.expression ? p.expression.length : ''}`; mark('call', id); x.then(() => mark('ok', id), e => mark('ko', id + ' ' + e.message)); }
      if (m === 'Runtime.evaluate' && p && /TVAgent\.render\(/.test(p.expression || '')) {
        const big = p.expression.length > 20000, tab = keyOf(cdp.targetId);
        mark('render', `${tab}${big ? ' +fuente' : ''}`);
        x.then(() => mark('rendered', `${tab}${big ? ' +fuente' : ''}`), () => {});
      }
      return x;
    };
    view = createTalkView({ cdp, pub: PUB, context, log: m => errs.push('servidor: ' + m), contentHosts: [...CONTENT_HOSTS, CONTENT_HOST] });
    view.onHide(() => mark('hide', keyOf(cdp.targetId)));
    view.onForm((f, can) => mark('form', `${f}:${can}`));
    poll = createPagePoll({ cdp, state, broadcast() {}, watched: () => false, active: () => view.watching(),
      onPlayback: on => { mark('playback', on); view.playback(on); } });
    poll.start();
    cdp.connect();
    // al conectar, Chrome avisa de todas las pestañas y cdp.js las engancha en cadena: se espera a que acabe
    if (!(await waitFor(() => cdp.ready && cdp.session && !cdp.attaching, 8000))) throw new Error('createCdp no engancha ninguna pestaña');
    await sleep(300);
    Object.assign(R, { cdp, view, poll, state, keyOf });
    R.close = async () => { try { poll.stop(); } catch { /* ya parado */ } cdp.stop(); await ctx.close().catch(() => {}); await browser.close().catch(() => {}); };
    return R;
  }

  /** Trae una pestaña al frente como la tele (cdp.show) y comprueba que queda enganchada. Devuelve el instante del cambio. */
  async function front(R, key) {
    const t = R.tabs[key];
    await t.p.evaluate(() => { window.__samples.length = 0; });     // la sonda de la de destino, desde el cambio
    const at = Date.now();
    R.mark('show', key);
    await R.cdp.show(t.id);
    if (R.cdp.targetId !== t.id || !R.cdp.session) throw new Error('cdp.show no deja enganchada ' + key);
    return at;
  }
  /** netflix.leave: pausa lo que suene en Netflix y trae al frente la otra pestaña. */
  async function leave(R, key) {
    await R.cdp.call('Runtime.evaluate', { expression: 'for(const m of document.querySelectorAll("video,audio"))m.pause();1' }).catch(() => {});
    return front(R, key);
  }
  async function idle(t) {
    await t.p.evaluate(d => window.onData(d), idleData(NOW));
    await t.p.evaluate(() => document.fonts.ready);
  }
  async function say(view, text, ms = 70) {
    const w = text.split(' ');
    for (let i = 1; i <= w.length; i++) { view.jota(w.slice(0, i).join(' ') + (i < w.length ? ' ' : '')); await sleep(ms); }
  }
  const dbg = p => p.evaluate(() => window.TVAgent ? window.TVAgent._debug() : null);
  const settled = (p, form, timeout = 6000) => p.waitForFunction(f => window.TVAgent && window.TVAgent._debug().form === f && !window.TVAgent._debug().morph,
    form, { timeout }).then(() => true, () => false);
  /** ¿lo dicho está en el texto de la capa? (las palabras van en spans: sin espacios) */
  const has = (txt, s) => !!txt && txt.replace(/\s+/g, '').includes(s.replace(/\s+/g, ''));
  const glassNow = p => p.evaluate(() => { const x = [...window.__samples].reverse().find(s => s.vis); return x ? { l: x.l, t: x.tp, r: x.r, b: x.b } : null; });
  const samples = p => p.evaluate(() => window.__samples);
  const at = (R, k, v, after = 0) => { const e = R.ev.find(x => x.at >= after && x.k === k && (v === undefined || x.v === v)); return e ? e.at : null; };
  /** Tras un cambio de pestaña en `at`: primer frame con la membrana a la vista y frames sin ella hasta entonces. */
  function gapOf(S, at) {
    const after = S.filter(x => x.e >= at - 1);
    const i = after.findIndex(x => x.vis);
    return { first: after.length ? after[0].e - at : null, gap: i >= 0 ? after[i].e - at : Infinity, frames: i >= 0 ? i : after.length, n: after.length, x: i >= 0 ? after[i] : null };
  }
  /** El paso medido en las muestras (como en agente-serie.js): sin saltos, dentro del área segura y a tiempo. */
  function checkMorph(S, tag, bad, form) {
    const m = morphStats(S, form);
    notes.push(`${tag}: paso a ${form} en ${m.ms.toFixed(0)} ms (${m.frames} frames, ${m.slow} lentos); salto máximo ${m.step.toFixed(1)} px/frame (${(m.step / SZ.w * 100).toFixed(1)} % del ancho); fuera del área segura ${m.out.toFixed(1)} px`);
    if (!m.started) bad.push(`no se vio el paso a ${form} (sin fase out en las muestras)`);
    if (m.step > MAX_STEP * SZ.w) bad.push(`la membrana salta ${m.step.toFixed(1)} px en un frame (máx. ${(MAX_STEP * SZ.w).toFixed(0)}): ${JSON.stringify(m.at)}`);
    if (m.jump) bad.push(`la membrana salta ${m.jump.toFixed(1)} px en un frame, más de ${JUMP_RATIO}× el anterior: ${JSON.stringify(m.jumpAt)}`);
    if (m.started && !(m.ms < MORPH_MAX_MS)) bad.push(`el paso tarda ${m.ms.toFixed(0)} ms (máx. ${MORPH_MAX_MS})`);
    if (m.out > 1) bad.push(`la membrana sale ${m.out.toFixed(1)} px del área segura`);
    if (m.logJump) bad.push(`el log cambia mientras sale el contenido (antes del viaje): ${m.logJump}`);
    if (m.started && !m.hugs) bad.push(`la membrana no acaba abrazando el contenido (${form})`);
    return m;
  }
  /** Saltos de la membrana en cualquier tramo (no solo en un paso): el mismo criterio que morphStats. */
  function jumpsOf(S) {
    let step = 0, jump = 0, prevSt = 0, prev2 = 0, where = null, jumpAt = null;
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], x = S[i];
      if (!a.vis || !x.vis) { prevSt = 0; prev2 = 0; continue; }
      const k = Math.max(1, x.dt / FRAME_MS);
      const st = Math.max(...['l', 'tp', 'r', 'b'].map(p => Math.abs(x[p] - a[p]) / k));
      if (st > step) { step = st; where = [a, x].map(y => [r0(y.e - S[0].e), r0(y.l), r0(y.tp), r0(y.r), r0(y.b), y.form, y.morph]); }
      if (prevSt > MOVING_PX && prev2 > MOVING_PX && st > JUMP_RATIO * prevSt && st > JUMP_MIN * x.vw && st > jump) { jump = st; jumpAt = [S[i - 2], a, x].map(y => [r0(y.e - S[0].e), r0(y.l), r0(y.tp), r0(y.r), r0(y.b), y.form, y.morph]); }
      prev2 = prevSt; prevSt = st;
    }
    return { step, jump, where, jumpAt };
  }
  const report = (tag, R, bad) => {
    // «nopage» del servidor: una llamada de talk-view (scripts de documento nuevo) que cae justo mientras cdp.js cambia de
    // sesión; inocua (la pestaña nueva se registra de cero), se apunta pero no cuenta como fallo
    const benign = R.errs.filter(e => /^servidor: conversación: nopage$/.test(e));
    if (benign.length) notes.push(`${tag}: ${benign.length} aviso(s) «nopage» del servidor al cambiar de pestaña (inocuo)`);
    const errs = R.errs.filter(e => !benign.includes(e));
    if (errs.length) bad.push('errores: ' + errs.join(' | '));
    notes.push(`${tag}: eventos ${R.ev.map(e => `${e.at - R.t0} ${e.k}${e.v !== undefined ? ':' + e.v : ''}`).join(' · ')}`);
    if (bad.length) fails.push(`✗ ${tag}\n    ` + bad.join('\n    '));
  };

  // ───────────────────────────── abrir (casos 1 y 2)
  if (want('abrir')) {
    const tag = 'abrir';
    const bad = [];
    const R = await rig([{ key: 'reposo', url: base() + '/' }, { key: 'netflix', url: app() + '/catalogo' }], { video: true });
    const { view } = R, A = R.tabs.reposo, B = R.tabs.netflix;
    let sw1 = 0, sw2 = 0, end = 0;
    try {
      await front(R, 'reposo');
      await idle(A);
      // turno 1, en el reposo: el panel se abre
      view.turn('panel', { voice: true }); await sleep(600);
      view.you('Hola', false); await sleep(250); view.you('Hola Jota', true); await sleep(400);
      await say(view, 'Hola, Sito. ¿Qué te apetece ver esta noche?'); view.done();
      await sleep(1800);
      // turno 2: «abre Netflix» (con su ficha, y navigating() como la orden netflix)
      view.turn('panel', { voice: true }); await sleep(500);
      for (const t of ['Abre', 'Abre Netflix']) { view.you(t, false); await sleep(220); }
      view.you('Abre Netflix', true); await sleep(600);
      view.tool({ id: 'n1', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', opens: true }); await sleep(900);
      if ((await dbg(A.p)).form !== 'panel') bad.push('en el reposo no es panel');
      const before = await glassNow(A.p);
      view.navigating();
      sw1 = await front(R, 'netflix');
      // la capa en la pestaña de Netflix: restore, en su caja, donde estaba
      const P = await B.p.waitForFunction(() => window.__e2e && window.__e2e.glassFrame >= 0 && window.__e2e, null, { timeout: 4000 }).then(h => h.jsonValue()).catch(() => null);
      if (!P) bad.push('la capa no aparece en la pestaña de Netflix');
      else {
        if (P.anims.length) bad.push('restore con animaciones de entrada: ' + P.anims.join(','));
        if (P.trans.length || P.opacity !== '1') bad.push(`restore con transiciones de entrada (${P.trans.join(',') || 'ninguna'}; opacidad del cristal ${P.opacity})`);
        for (const k of ['l', 't', 'r', 'b']) if (Math.abs(P.glass[k] - P.sheet[k]) > GLASS_TOL) { bad.push(`la membrana no nace en su caja (${k}: ${P.glass[k].toFixed(0)} vs ${P.sheet[k].toFixed(0)})`); break; }
        if (before) {
          const d = Math.max(...['l', 't', 'r', 'b'].map(k => Math.abs(P.glass[k] - before[k])));
          notes.push(`${tag}: la membrana nace en la pestaña de Netflix a ${d.toFixed(1)} px de donde estaba en el reposo`);
          if (d > CONTINUITY_TOL) bad.push(`la membrana salta ${d.toFixed(0)} px al cambiar de pestaña (antes ${JSON.stringify(before)}, después ${JSON.stringify(P.glass)})`);
        }
      }
      if (!(await settled(B.p, 'pill'))) bad.push('no pasó a píldora en la pestaña de Netflix');
      await sleep(SETTLE_WAIT_MS);
      let S = await samples(B.p);
      const g = gapOf(S, sw1);
      const restored = S.filter(x => x.vis).slice(0, 3).map(x => x.form);
      if (restored[0] !== 'panel') bad.push(`la pestaña nueva no se restaura como panel antes del paso (${restored.join(',')})`);
      const out = S.find(x => x.morph === 'out');
      const m = checkMorph(S, tag + ' → píldora', bad, 'pill');
      const pillMs = out && m.hugs ? out.e + m.ms - sw1 : Infinity;
      const attachMs = at(R, 'attached', 'netflix', sw1), renderMs = at(R, 'rendered', 'netflix +fuente', sw1);
      notes.push(`${tag}: cambio de pestaña → primer frame a los ${g.first === null ? '?' : r0(g.first)} ms, enganchada a los ${attachMs ? attachMs - sw1 : '?'} ms, ` +
        `foto con la fuente devuelta a los ${renderMs ? renderMs - sw1 : '?'} ms, membrana a la vista a los ${r0(g.gap)} ms (${g.frames} frames sin capa)`);
      notes.push(`${tag}: el paso empieza a los ${out ? r0(out.e - sw1) : '?'} ms del cambio (${out && g.x ? r0(out.e - g.x.e) : '?'} ms tras verse; respiro ${MORPH_DELAY_MS} ms); píldora asentada a los ${r0(pillMs)} ms`);
      if (!(g.gap <= TAB_GAP_MAX_MS)) bad.push(`hueco de ${r0(g.gap)} ms sin capa al cambiar de pestaña (máx. ${TAB_GAP_MAX_MS})`);
      if (out && g.x && !(out.e - g.x.e >= MORPH_DELAY_MS - PAINT_SLACK_MS)) bad.push(`el paso empieza antes del respiro (${r0(out.e - g.x.e)} ms tras verse)`);
      const j = jumpsOf(S);
      measures.push({ caso: 1, hueco: r0(g.gap), framesSinCapa: g.frames, pildora: r0(pillMs), saltoMax: +j.step.toFixed(1), saltoMorph: +m.step.toFixed(1) });
      if (j.step > MAX_STEP * SZ.w) bad.push(`la membrana salta ${j.step.toFixed(1)} px en un frame en la pestaña de Netflix: ${JSON.stringify(j.where)}`);
      if (j.jump) bad.push(`salto de ${j.jump.toFixed(1)} px (más de ${JUMP_RATIO}× el frame anterior) en la pestaña de Netflix: ${JSON.stringify(j.jumpAt)}`);
      await B.p.screenshot({ path: path.join(OUT, 'abrir-pildora.png') }); files.push(path.join(OUT, 'abrir-pildora.png'));

      // caso 2: la conversación se cierra en Netflix y se vuelve a la pestaña de siempre
      view.toolEnd({ id: 'n1', ok: true }); await sleep(300);
      const reply = 'Ahí lo tienes.';
      await say(view, reply, 90); view.done();
      const dwell = PILL_DWELL_BASE_MS + PILL_DWELL_PER_CHAR_MS * reply.length;
      if (!(await waitFor(() => R.ev.some(e => e.k === 'hide'), dwell + 6000, 50))) bad.push('la píldora no se cierra en la pestaña de Netflix');
      await sleep(1200);
      const staleA = await dbg(A.p);
      notes.push(`${tag}: al cerrarse en Netflix, la pestaña del reposo (detrás) sigue con la capa ${staleA && staleA.open ? 'ABIERTA' : 'cerrada'} (${staleA ? staleA.form : '-'})`);
      sw2 = await leave(R, 'reposo');
      await sleep(2500);
      S = await samples(A.p);
      const after = S.filter(x => x.e >= sw2 - 1);
      const lastVis = [...after].reverse().find(x => x.vis);
      const goneMs = lastVis ? lastVis.e - sw2 + lastVis.dt : 0;                  // hasta que no se ve nada (fundido incluido)
      const still = after.find(x => !x.vis || x.off);                              // el panel viejo deja de estar quieto: se empieza a ir
      const staleMs = after.length && after[0].vis ? (still ? still.e - sw2 : Infinity) : 0;
      const hideAt = at(R, 'attached', 'reposo', sw2);
      const fin = await A.p.evaluate(() => ({ open: window.TVAgent ? window.TVAgent._debug().open : false, host: !!document.getElementById('__tvagent'),
        vis: (window.__samples.at(-1) || {}).vis || 0 }));
      notes.push(`${tag}: de vuelta en el reposo (enganchada a los ${hideAt ? hideAt - sw2 : '?'} ms): panel viejo quieto a la vista ${r0(staleMs)} ms, y fundiéndose hasta los ${r0(goneMs)} ms (${after.filter(x => x.vis).length} frames); al final open ${fin.open}, host ${fin.host}, membrana a la vista ${!!fin.vis}`);
      measures.push({ caso: 2, panelViejoQuietoMs: r0(staleMs), panelViejoHastaIrseMs: r0(goneMs), framesConPanel: after.filter(x => x.vis).length });
      if (fin.open || fin.vis) bad.push(`queda un panel huérfano en la pestaña de siempre (open ${fin.open}, a la vista ${!!fin.vis})`);
      if (!(staleMs <= STALE_MAX_MS)) bad.push(`el panel viejo se ve quieto ${r0(staleMs)} ms al volver a la pestaña de siempre (máx. ${STALE_MAX_MS})`);
      if (!(goneMs <= STALE_MAX_MS + FADE_MAX_MS)) bad.push(`el panel viejo tarda ${r0(goneMs)} ms en irse al volver a la pestaña de siempre (máx. ${STALE_MAX_MS + FADE_MAX_MS})`);
      const finB = await dbg(B.p);
      if (finB && finB.open) bad.push('la capa sigue abierta en la pestaña de Netflix');
      end = Date.now();
    } finally {
      await R.close();
    }
    // vídeos: uno por pestaña y, con ffmpeg, lo que enseña la tele (reposo → Netflix → reposo)
    const vids = {};
    for (const t of [A, B]) {
      const v = t.p.video();
      if (!v) continue;
      const dst = path.join(VIDEOS, `abrir-${t.key}.webm`);
      try { fs.renameSync(await v.path(), dst); vids[t.key] = dst; files.push(dst); } catch (e) { notes.push('vídeo: ' + e.message); }
    }
    if (vids.reposo && vids.netflix && sw1 && sw2) {
      const s = x => (x / 1000).toFixed(3);
      const tele = path.join(VIDEOS, 'abrir-tele.webm');
      const fc = `[0:v]split[a0][a1];[a0]trim=0:${s(sw1 - A.born)},setpts=PTS-STARTPTS[x];[1:v]trim=${s(sw1 - B.born)}:${s(sw2 - B.born)},setpts=PTS-STARTPTS[y];` +
        `[a1]trim=${s(sw2 - A.born)}:${s(end - A.born)},setpts=PTS-STARTPTS[z];[x][y][z]concat=n=3:v=1[o]`;
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vids.reposo, '-i', vids.netflix, '-filter_complex', fc, '-map', '[o]', '-c:v', 'libvpx', '-b:v', '3M', '-r', '25', tele]);
        files.push(tele);
      } catch (e) { notes.push('sin vídeo empalmado (ffmpeg): ' + String(e.message).split('\n')[0]); }
    }
    report(tag, R, bad);
  }

  // ───────────────────────────── abierta (caso 3): volver a la pestaña de siempre con la conversación abierta
  if (want('abierta')) {
    const tag = 'abierta';
    const bad = [];
    const R = await rig([{ key: 'reposo', url: base() + '/' }, { key: 'netflix', url: app() + '/catalogo' }]);
    const { view } = R, A = R.tabs.reposo, B = R.tabs.netflix;
    const MARK = 'Vale, te dejo la serie a medias';
    const NEW = 'Vale,';            // la primera palabra de lo dicho en Netflix: la foto de ahora ya está en la página
    try {
      await front(R, 'reposo');
      await idle(A);
      view.turn('panel', { voice: false }); view.you('¿Qué hay en Netflix?', true); await sleep(400);
      await say(view, 'Te lo abro.'); await sleep(300);
      view.tool({ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', opens: true }); await sleep(600);
      view.navigating();
      await front(R, 'netflix');
      if (!(await settled(B.p, 'pill'))) bad.push('no pasó a píldora en la pestaña de Netflix');
      view.toolEnd({ id: 'n', ok: true });
      // algo nuevo, dicho ya en Netflix (con el turno aún abierto)
      await say(view, MARK + ', vuelvo a lo de antes.'); await sleep(900);
      const cur = view.form().form;
      const before = await glassNow(B.p);                 // lo que se ve en Netflix justo antes de volver
      const sw = await front(R, 'reposo');                // sin cerrar el turno: la conversación sigue
      await sleep(600 + SETTLE_WAIT_MS);
      const S = await samples(A.p);
      const g = gapOf(S, sw);
      const after = S.filter(x => x.e >= sw - 1);
      const first = after[0] || {};
      // estado actual: la foto de ahora (su texto empieza a entrar y la forma va a la de ahora); el resto de palabras entran
      // con su animación (en esta pestaña son nuevas) y la membrana hace su paso
      const nowAt = after.find(x => x.vis && has(x.txt, NEW));
      const okAt = after.find(x => x.vis && has(x.txt, MARK) && x.form === cur && !x.morph);
      const marked = after.find(x => x.vis && has(x.txt, MARK));
      const staleFrames = after.filter(x => x.vis && !has(x.txt, NEW)).length;
      const nowMs = nowAt ? nowAt.e - sw : Infinity, ms = okAt ? okAt.e - sw : Infinity;
      notes.push(`${tag}: de vuelta con la conversación abierta: primer frame ${first.vis ? 'con' : 'sin'} capa (${first.form || '-'}, ${has(first.txt, MARK) ? 'estado actual' : 'estado viejo'}); ` +
        `hueco ${r0(g.gap)} ms (${g.frames} frames); estado viejo ${staleFrames} frames, la foto de ahora a los ${r0(nowMs)} ms; lo dicho en Netflix entero a la vista a los ${marked ? r0(marked.e - sw) : '?'} ms; ` +
        `forma actual (${cur}) asentada a los ${r0(ms)} ms`);
      if (process.env.DUMP) fs.writeFileSync(path.join(OUT, 'abierta-muestras.json'), JSON.stringify(after.map(x => ({ ms: r0(x.e - sw), vis: x.vis, op: x.op, form: x.form, morph: x.morph,
        l: x.l && r0(x.l), t: x.tp && r0(x.tp), r: x.r && r0(x.r), b: x.b && r0(x.b), actual: has(x.txt, NEW), txt: (x.txt || '').slice(-60) }))));
      const fv = after.find(x => x.vis);
      const cont = fv && before ? Math.max(Math.abs(fv.l - before.l), Math.abs(fv.tp - before.t), Math.abs(fv.r - before.r), Math.abs(fv.b - before.b)) : Infinity;
      notes.push(`${tag}: la membrana se ve en la pestaña de siempre a ${r0(cont)} px de donde estaba en Netflix (antes ${JSON.stringify(before && Object.fromEntries(Object.entries(before).map(([k, v]) => [k, r0(v)])))}, ` +
        `primer frame ${fv ? JSON.stringify({ l: r0(fv.l), t: r0(fv.tp), r: r0(fv.r), b: r0(fv.b), forma: fv.form }) : '-'})`);
      if (!(cont <= CONTINUITY_TOL)) bad.push(`al volver, la membrana se ve primero a ${r0(cont)} px de donde estaba en Netflix (${fv ? fv.form : '-'} viejo en vez de ${cur}): la capa que se quedó pintada en la pestaña de siempre hace su paso desde allí; la forma de ahora asentada a los ${r0(ms)} ms`);
      else if (fv && fv.form !== cur) bad.push(`al volver, el primer frame es ${fv.form} (ahora es ${cur})`);
      const m = morphStats(S, cur);
      const j = jumpsOf(after);
      notes.push(`${tag}: ${m.started ? `paso a ${cur} en la pestaña de siempre (${r0(m.ms)} ms)` : 'sin paso'}; salto máximo ${j.step.toFixed(1)} px/frame`);
      measures.push({ caso: 3, hueco: r0(g.gap), desfasePx: r0(cont), estadoViejoMs: r0(nowMs), framesViejos: staleFrames, textoEnteroMs: marked ? r0(marked.e - sw) : null, formaAsentadaMs: r0(ms), saltoMax: +j.step.toFixed(1) });
      if (!(g.gap <= TAB_GAP_MAX_MS)) bad.push(`hueco de ${r0(g.gap)} ms sin capa al volver (máx. ${TAB_GAP_MAX_MS})`);
      if (!(nowMs <= STALE_MAX_MS)) bad.push(`la capa enseña el estado viejo ${r0(nowMs)} ms al volver (máx. ${STALE_MAX_MS}; ${staleFrames} frames)`);
      if (!okAt) bad.push(`la capa no acaba en el estado actual (lo dicho en Netflix, en ${cur})`);
      if (j.step > MAX_STEP * SZ.w) bad.push(`la membrana salta ${j.step.toFixed(1)} px en un frame al volver: ${JSON.stringify(j.where)}`);
      if (j.jump) bad.push(`salto de ${j.jump.toFixed(1)} px (más de ${JUMP_RATIO}× el frame anterior) al volver: [ms, l, t, r, b, forma, paso] ${JSON.stringify(j.jumpAt)}`);
      const d = await dbg(A.p);
      if (!d || !d.open) bad.push('la capa no está abierta en la pestaña de siempre');
      view.done();
    } finally {
      await R.close();
    }
    report(tag, R, bad);
  }

  // ───────────────────────────── espera (caso 4): sin fichas, navigating(); Netflix en una pestaña nueva que tarda
  // desde el reposo (panel: al llegar, el paso a píldora vuelve a armar el cierre) y desde una app de contenido en la pestaña
  // de siempre (ya en píldora: nada vuelve a armarlo y el cierre depende solo de la espera)
  const ESPERAS = [[SLOW_TAB_MS, '/lenta', 'panel'], [SLOW_TAB_LONG_MS, '/lenta-larga', 'panel'], [SLOW_TAB_MS, '/lenta', 'pill'], [SLOW_TAB_LONG_MS, '/lenta-larga', 'pill']];
  for (const [slow, route, from] of ESPERAS.filter(() => want('espera'))) {
    const tag = `espera ${slow} ms desde ${from === 'pill' ? 'una app (píldora)' : 'el reposo (panel)'}`;
    const bad = [];
    const R = await rig([{ key: 'siempre', url: from === 'pill' ? app() + '/catalogo' : base() + '/' }]);
    const { view } = R, A = R.tabs.siempre;
    try {
      await front(R, 'siempre');
      if (from === 'panel') await idle(A);
      const reply = 'Hecho.';
      view.turn('panel', { voice: false }); view.you('Pon Netflix', true); await sleep(500);
      if (view.form().form !== from) bad.push(`la conversación no empieza en ${from} (${view.form().form})`);
      view.navigating();                                // la orden netflix, sin eventos de herramienta del Gateway
      // netflix.front sin pestaña: una nueva al frente y Page.navigate (la de Playwright, para tener sonda; ver arriba)
      const t = await R.addTab('netflix', null);
      const sw = await front(R, 'netflix');
      const navAt = Date.now();
      R.cdp.call('Page.navigate', { url: app() + route }).catch(e => R.mark('navigate', e.message));
      await say(view, reply); view.done();
      const doneAt = Date.now(), normal = CLOSE_BASE_MS + CLOSE_PER_CHAR_MS * reply.length;
      if (!view.awaiting()) bad.push('tras done() con la pestaña nueva sin pintar no espera (awaiting false)');
      // cuándo deja de esperar (talk-view da la página por pintada)
      let waitEnd = view.awaiting() ? 0 : doneAt;
      const iv = setInterval(() => { if (!waitEnd && !view.awaiting()) { waitEnd = Date.now(); R.mark('espera fin'); } }, 20);
      await waitFor(() => R.ev.some(e => e.k === 'hide'), slow + AFTER_PAINT_MIN_MS + PILL_DWELL_BASE_MS + 9000, 50);
      clearInterval(iv);
      const hideAt = at(R, 'hide');
      const P = await t.p.evaluate(() => ({ paint: window.__e2e.paint, origin: performance.timeOrigin, href: location.href,
        glass: window.__e2e.glassAt, forms: [...new Set(window.__samples.filter(x => x.vis).map(x => x.form))] })).catch(() => null);
      const paintAt = P && P.paint >= 0 && /lenta/.test(P.href) ? P.origin + P.paint : null;
      // la capa en la pestaña nueva: la foto a la pestaña en blanco no vuelve hasta que llega la página (ver eventos), así
      // que hasta entonces la tele enseña la pestaña nueva sin conversación
      const layerAt = P && P.glass >= 0 && /lenta/.test(P.href) ? P.origin + P.glass : null;
      notes.push(`${tag}: la capa se ve en la pestaña nueva a los ${layerAt ? r0(layerAt - sw) : '?'} ms del cambio (sin capa hasta entonces)`);
      notes.push(`${tag}: cambio de pestaña a los 0 ms, done a los ${doneAt - sw} ms (cierre normal a los ${doneAt - sw + normal} ms), ` +
        `página pintada a los ${paintAt ? r0(paintAt - sw) : '?'} ms, deja de esperar a los ${waitEnd ? waitEnd - sw : '?'} ms, cerrada a los ${hideAt ? hideAt - sw : '?'} ms (${paintAt && hideAt ? r0(hideAt - paintAt) : '?'} ms sobre la página; mínimo ${AFTER_PAINT_MIN_MS}); formas ${P ? P.forms.join(',') : '?'}`);
      measures.push({ caso: 4, lenta: slow, desde: from, capaEnPestanaNueva: layerAt ? r0(layerAt - sw) : null, finEspera: waitEnd ? waitEnd - sw : null, pintada: paintAt ? r0(paintAt - sw) : null, cerrada: hideAt ? hideAt - sw : null, sobreLaPagina: paintAt && hideAt ? r0(hideAt - paintAt) : null });
      if (!hideAt) bad.push('no se cierra');
      if (waitEnd && paintAt && waitEnd < paintAt - PAINT_SLACK_MS) bad.push(`deja de esperar a los ${waitEnd - sw} ms, antes de que se pinte la página de la pestaña nueva (${r0(paintAt - sw)} ms): da por pintada la pestaña en blanco`);
      if (!paintAt) bad.push('la página de la pestaña nueva no llegó a pintarse');
      if (hideAt && paintAt && hideAt < paintAt) bad.push(`se cerró a los ${hideAt - sw} ms, antes de que la pestaña nueva se pintara (${r0(paintAt - sw)} ms)`);
      else if (hideAt && paintAt && hideAt - paintAt < AFTER_PAINT_MIN_MS - CLOSE_SLACK_MS) bad.push(`se cerró ${r0(hideAt - paintAt)} ms después de pintarse la pestaña nueva (mín. ${AFTER_PAINT_MIN_MS})`);
      if (P && !P.forms.includes('pill')) bad.push('en la pestaña de Netflix no llegó a píldora');
      if (P && from === 'pill' && P.forms.includes('panel')) bad.push('venía en píldora y en Netflix se vio el panel');
      if (navAt - sw > 200) notes.push(`${tag}: (Page.navigate salió ${navAt - sw} ms tras el cambio)`);
      notes.push(`${tag}: (PAINT_WAIT_MS ${PAINT_WAIT_MS} ms)`);
    } finally {
      await R.close();
    }
    report(tag, R, bad);
  }

  srv.close();
  fs.rmSync(path.join(OUT, 'tmp-video'), { recursive: true, force: true });
  if (fails.length) console.error(fails.join('\n'));
  console.log(notes.join('\n'));
  console.log('medidas: ' + JSON.stringify(measures));
  console.log(`archivos:\n  ${files.join('\n  ')}`);
  console.log(`${fails.length} fallos`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/**
 * Copia de agente-serie.js (salvo el arranque: ver MOVING_PX). Del muestreo por rAF: desde el primer frame con el contenido saliendo hasta que la membrana
 * abraza el contenido quieto en la forma `form`. step: paso máximo de un borde por frame de 60 Hz; jump: el mayor frame que
 * es más de JUMP_RATIO veces el anterior; out: lo que más sale del área segura; logJump: cambiaron los turnos que se ven
 * mientras el contenido salía, antes del viaje.
 */
function morphStats(S, form) {
  const i0 = S.findIndex(x => x.morph === 'out');
  const res = { started: i0 >= 0, ms: Infinity, frames: 0, slow: 0, step: 0, jump: 0, out: 0, hugs: false, logJump: '' };
  for (const x of S) {
    if (!x.drag) continue;
    const safe = { l: x.vw * SAFE.x, t: x.vh * SAFE.y, r: x.vw * (1 - SAFE.x), b: x.vh * (1 - SAFE.y) };
    res.out = Math.max(res.out, safe.l - x.l, safe.t - x.tp, x.r - safe.r, x.b - safe.b);
  }
  if (i0 < 0) return res;
  const base = S[i0 - 1];
  for (let i = i0; base && i < S.length && S[i].morph === 'out'; i++) {
    if (S[i].tn !== base.tn) { res.logJump = `${base.tn}→${S[i].tn} turnos a la vista a los ${Math.round(S[i].t - S[i0].t)} ms de empezar`; break; }
  }
  let still = 0, end = -1, prevSt = 0, prev2 = 0;
  for (let i = i0; i < S.length; i++) {
    const a = S[i - 1], x = S[i];
    if (a && i > i0) {
      const k = Math.max(1, x.dt / FRAME_MS);
      if (x.dt > FRAME_MS * 1.5) res.slow++;
      const st = Math.max(...['l', 'tp', 'r', 'b'].map(p => Math.abs(x[p] - a[p]) / k));
      const at = () => [a, x].map(y => [y.t - S[i0].t, y.l, y.tp, y.r, y.b, y.morph].map(v => (typeof v === 'number' ? Math.round(v) : v)));
      if (st > res.step) { res.step = st; res.at = at(); }
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
