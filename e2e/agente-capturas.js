// Capturas y comprobaciones de la capa de conversación del diseño nuevo (remote/public/tv-agent.js), sin tele ni servidor.
// Uso: cd e2e && node agente-capturas.js [carpeta-salida] [--solo escena,escena]   (npm run agente; CHROME=/ruta para
// otro navegador). --solo limita las escenas (p. ej. --solo desborda,fallo) para una pasada rápida.
// Sirve remote/public con un servidor mínimo (el reposo con su CSP real) y dos páginas de ejemplo (una web clara con
// Trusted Types obligatorios y una con un <video> simulado), inyecta tv-agent.js como el servidor (agentSource: tokens
// delante; por evaluate, que es CDP como en la tele, así que la CSP de la página no lo bloquea) y llama a TVAgent.render
// con fotos de ejemplo, repetidas cada 100 ms como hace talk-view.js. Comprueba en cada una:
// - sin errores de consola ni de la página (ni violaciones de la CSP o de Trusted Types);
// - el contenido y el cristal dentro del área segura (5 % del ancho, 6 % del alto) y dentro de la pantalla;
// - los textos no desbordan su caja (salvo el detalle de una ficha, que lleva elipsis a propósito);
// - ningún ancestro del cristal tiene opacity/filter/transform/mask/clip-path/blend (romperían el backdrop-filter);
// - repetir la misma foto no quita, mueve ni recrea nodos (MutationObserver: solo pueden llegar palabras nuevas), así que
//   no reinicia animaciones; y una conversación que no cabe difumina el borde de arriba y deja ver la última palabra;
// - hide() quita la capa y para el rAF (_debug().rafRunning false);
// y además: un píxel del cristal sobre blanco contra el modelo de color de test/unit/agent-contrast.test.js, el nivel
// que elige glass:'auto', que con «más contraste» o colores forzados el nivel sea C, y que con un <video> a pantalla
// completa de verdad (requestFullscreen, antes y después de abrir la capa) el cristal se ve encima (capa superior).
// Las cajas del cristal se miden también mientras crece (el muelle se pasa: lo escrito no debe salir del área segura).
// Salida: e2e/capturas-agente/ (o la carpeta que se pase).
/* global window, document, getComputedStyle, innerWidth, innerHeight, requestAnimationFrame */
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'remote', 'public');
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = arg('--solo') ? arg('--solo').split(',') : null;
const outArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const OUT = path.resolve(outArg || path.join(__dirname, 'capturas-agente'));
const FRAUNCES = require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2');
fs.mkdirSync(OUT, { recursive: true });

// la fuente tal como la inyecta el servidor (tokens delante); si aún no existe agentSource, se arma igual que él
const tokens = require(path.join(ROOT, 'remote', 'src', 'tv', 'tokens.js'));
const SOURCE = tokens.agentSource ? tokens.agentSource(PUB)
  : 'var __TV_TOKENS=' + JSON.stringify(tokens.readTokens(PUB)) + ';\n' + fs.readFileSync(path.join(PUB, 'tv-agent.js'), 'utf8');
let IDLE_CSP = null;
try { ({ IDLE_CSP } = require(path.join(ROOT, 'remote', 'src', 'transport', 'static.js'))); } catch { console.warn('sin remote/src: reposo sin CSP'); }
// iconos de las fichas: los del servidor (agent-ui.js); si no está, uno genérico (la capa pinta un punto)
let KINDS = {};
try { ({ KINDS } = require(path.join(ROOT, 'remote', 'src', 'features', 'agent-ui.js'))); } catch { console.warn('sin agent-ui.js: fichas sin icono'); }

// área segura: margen de sobrebarrido que la tele puede comerse por cada lado
const SAFE = { x: 0.05, y: 0.06 };
const TOL = 1;        // px de redondeo
const GLASS_TOL = 3;  // px: el cristal ondula sus esquinas, pero su caja asentada coincide con la del contenido
const PIXEL_TOL = 3;  // /255 por canal, entre el píxel real y el modelo de color
const SETTLE_MS = 1800;
const STILL_MS = 4000;  // espera máxima a que la capa abierta y quieta pare su rAF
const BREATHE = ['listen', 'think']; // estados en los que la membrana late a propósito (el rAF no se para)
const FULLSCREEN_MIN_DIFF = 12; // /255: el cristal sobre el vídeo negro tiene que notarse (velo de tinta ≈ 30–45)
const HIDE_MS = 8000;  // espera máxima a que hide() termine
const SIZES = [{ n: '1280x720', w: 1280, h: 720, all: true }, { n: '1920x1080', w: 1920, h: 1080 }];

// ── páginas de ejemplo: una web clara (lo peor para el contraste) y una serie con un <video> simulado
const PAGES = {
  '/web.html': { csp: "default-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'", html: `<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>body{margin:0;font:400 20px/1.4 system-ui;background:#ecebe7;color:#2a2733}.bar{height:60px;background:#fff;display:flex;align-items:center;padding:0 64px;gap:32px}
h1{font:400 56px/1.05 Georgia,serif;margin:48px 64px 12px;max-width:640px}p{margin:0 64px;max-width:520px}.gal{display:flex;gap:20px;margin:40px 64px}
.gal i{display:block;width:220px;height:260px;border-radius:16px}.y{background:#ffd400}.w{background:#fff}.g{background:#8fae8b}</style></head>
<body><div class="bar"><b>Cocina de casa</b><span>Recetas</span><span>Menús</span></div><h1>Paella de verduras para cuatro</h1>
<p>Un sofrito lento de pimiento y tomate, arroz bomba y verduras de temporada. Sin prisas: el arroz no se remueve.</p>
<div class="gal"><i class="y"></i><i class="w"></i><i class="g"></i></div></body></html>` },
  '/video.html': { csp: "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'", html: `<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}.sc{position:fixed;inset:0;background:linear-gradient(180deg,#0a1a26,#14384a 48%,#2a3340 78%,#1a1a22)}
.sol{position:absolute;left:60%;top:46%;width:30vw;height:30vw;border-radius:50%;background:radial-gradient(closest-side,rgba(232,176,120,.8),transparent)}
video{position:fixed;inset:0;width:100%;height:100%;object-fit:cover}.meta{position:fixed;left:5vw;bottom:9vh;font:400 22px system-ui;color:rgba(255,255,255,.75)}</style></head>
<body><div class="sc"><i class="sol"></i></div><video muted playsinline></video><div class="meta">Una serie · T2 · episodio 4</div></body></html>` },
  '/blanco.html': { csp: "default-src 'none'; style-src 'unsafe-inline'", html: '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#fff}</style></head><body></body></html>' },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ART = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#2f7f8a"/><circle cx="300" cy="280" r="160" fill="#c98a5c"/></svg>';
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (PAGES[u]) { r.writeHead(200, { 'content-type': TYPES['.html'], 'content-security-policy': PAGES[u].csp }); return r.end(PAGES[u].html); }
  if (u.startsWith('/idle/art')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end(ART); }
  const f = path.join(PUB, u === '/' ? 'idle.html' : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...(IDLE_CSP && f.endsWith('.html') ? { 'content-security-policy': IDLE_CSP } : {}) });
  r.end(fs.readFileSync(f));
}).listen(0);
const base = () => `http://127.0.0.1:${srv.address().port}`;

// ── fotos de ejemplo (la forma la decide el contexto, como el servidor: vídeo → píldora)
const YOU = 'Pon algo tranquilo de jazz en el salón.';
const JOTA = 'Ahí va. Jazz tranquilo en el salón, empezando por Miles Davis.';
const LONG = 'Mañana, sol y veinticuatro grados en Elche. Por la tarde se levanta algo de viento de levante y por la noche refresca bastante, así que mejor llevar una chaqueta si sales a cenar.';
const tool = (id, kind, title, detail, status) => ({ id, kind, title, detail, status });
const turn = (id, o) => ({ id, you: YOU, youFinal: true, jota: '', tools: [], error: false, hint: '', ...o });
const SCENES = [
  { n: 'escucha', state: 'listen', live: true, turns: [turn(1, { you: 'Pon algo tranquilo de', youFinal: false })] },
  { n: 'pensando', state: 'think', live: true, turns: [turn(1)] },
  { n: 'herramienta', state: 'think', live: true, turns: [turn(1, { tools: [tool('a', 'music', 'Reproducir en el Salón', 'Spotify · jazz tranquilo', 'run')] })] },
  { n: 'check', state: 'talk', live: false, turns: [turn(1, { jota: JOTA, tools: [tool('a', 'music', 'Reproducir en el Salón', 'Spotify · jazz tranquilo', 'ok')] })] },
  { n: 'fallo', state: 'error', live: false, turns: [turn(1, { you: 'Enciende las luces del salón.', jota: 'No he podido conectar con la casa.', hint: 'Di «otra vez» para reintentar.',
    tools: [tool('h', 'home', 'Encender luces del salón', 'Casa · Salón', 'fail')] })] },
  { n: 'hablando', state: 'talk', live: true, turns: [turn(1, { you: '¿Qué tiempo hace mañana?', jota: LONG })] },
  { n: 'dos-turnos', state: 'talk', live: false, turns: [
    turn(1, { jota: JOTA, tools: [tool('a', 'music', 'Reproducir en el Salón', 'Spotify · jazz tranquilo', 'ok')] }),
    turn(2, { you: 'Y ponme un temporizador de diez minutos para la pasta.', jota: 'Hecho, diez minutos. Te aviso cuando termine.',
      tools: [tool('b', 'timer', 'Temporizador', '10 min · Pasta', 'ok'), tool('c', 'volume', 'Volumen', 'Volumen 30 %', 'ok')] })] },
  { n: 'noche', state: 'talk', live: false, night: true, turns: [turn(1, { jota: JOTA })] },
  { n: 'calm', state: 'think', live: true, calm: true, turns: [turn(1, { tools: [tool('a', 'music', 'Reproducir en el Salón', 'Spotify · jazz tranquilo', 'run')] })] },
  { n: 'nivel-c', state: 'talk', live: false, glass: 'C', turns: [turn(1, { jota: JOTA })] },
  { n: 'desborda', state: 'talk', live: false, overflows: true, turns: [
    turn(1, { you: '¿Qué tiempo hace mañana?', jota: LONG, tools: [tool('w', 'web', 'Consultar el tiempo', 'Elche · mañana', 'ok')] }),
    turn(2, { you: '¿Y el fin de semana? ¿Lloverá en la sierra?', jota: LONG + ' ' + LONG,
      tools: [tool('x', 'web', 'Consultar el tiempo', 'Elche · sábado y domingo', 'ok'), tool('y', 'web', 'Consultar el tiempo', 'Sierra de Aitana', 'ok')] })] },
];
const CONTEXTS = [
  { n: 'reposo', url: '/', ctx: 'idle' },
  { n: 'musica', url: '/', ctx: 'music', colors: ['#2f7f8a', '#c98a5c'], music: true },
  { n: 'web', url: '/web.html', ctx: 'web' },
  { n: 'video', url: '/video.html', ctx: 'video' },
];
const icons = turns => Object.fromEntries([...new Set(turns.flatMap(t => t.tools.map(x => x.kind)))].filter(k => KINDS[k]).map(k => [k, KINDS[k].icon]));
function snapFor(sc, c) {
  return { form: c.ctx === 'video' ? 'pill' : 'panel', ctx: c.ctx, state: sc.state, live: sc.live, night: !!sc.night, calm: !!sc.calm,
    glass: sc.glass || 'A', colors: c.colors || null, turns: sc.turns, icons: icons(sc.turns) };
}

// datos del reposo (como reposo-solapes.js): hora fija, con o sin música
const idleData = (now, c, night) => ({ now, profile: night ? 'night' : 'day', cfg: { dimMin: 0, rearrangeMin: 0, calm: true },
  weather: { code: 2, isDay: true, temp: 23, max: 23, min: 17, feels: 23, rainNext: 10, sunrise: now - 4 * 3600e3, sunset: now + 8 * 3600e3 },
  music: c.music ? { title: 'Blue in Green', artist: 'Miles Davis', playing: true, progress: 95e3, duration: 337e3, at: now, art: 'x', context: { type: 'playlist', name: 'Jazz' } } : null,
  acts: [] });

// ── en la página
// cajas del contenido y del cristal, desbordes de texto y propiedades que rompen el backdrop-filter en sus ancestros
function measure() {
  const h = document.getElementById('__tvagent');
  if (!h) return null;
  const r = h.shadowRoot, q = s => r.querySelector(s);
  const box = e => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom }; };
  const overflow = [...r.querySelectorAll('.u, .j, .hint, .tt')].filter(e => e.getClientRects().length)
    .filter(e => getComputedStyle(e).textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 1).map(e => e.className + ' «' + e.textContent.slice(0, 30) + '»');
  const sheet = box(q('.sheet'));
  const words = [...r.querySelectorAll('.wd')].filter(e => e.getClientRects().length).map(box).filter(b => b.r > sheet.r + 1 || b.x < sheet.x - 1).length;
  const bad = [];
  for (let n = q('.body').parentNode; n;) {
    if (n.nodeType === 1) {
      const s = getComputedStyle(n), name = n.id || n.className || n.tagName;
      const checks = { opacity: s.opacity !== '1', filter: s.filter !== 'none', transform: s.transform !== 'none', mask: (s.maskImage || s.webkitMaskImage || 'none') !== 'none',
        clipPath: s.clipPath !== 'none', mixBlendMode: s.mixBlendMode !== 'normal', backdropFilter: (s.backdropFilter || 'none') !== 'none', willChange: /opacity|filter|transform|mask|clip/.test(s.willChange) };
      for (const [k, on] of Object.entries(checks)) if (on) bad.push(`${name}: ${k}`);
    }
    n = n.parentNode || n.host || null;
  }
  return { vw: innerWidth, vh: innerHeight, sheet, glass: box(q('.body')), overflow, words, bad, tier: window.TVAgent._debug().tier };
}
// misma foto otra vez (5 veces, cada 100 ms): el árbol no cambia. Solo pueden llegar palabras nuevas (el revelado sigue
// en directo); quitar, mover o recrear un nodo reiniciaría sus animaciones y se cuenta como fallo
async function sameNodes(snap) {
  const r = document.getElementById('__tvagent').shadowRoot;
  const recs = [];
  const mo = new window.MutationObserver(l => recs.push(...l));
  mo.observe(r, { childList: true, subtree: true });
  for (let i = 0; i < 5; i++) { window.TVAgent.render(snap); await new Promise(f => setTimeout(f, 100)); }
  recs.push(...mo.takeRecords()); mo.disconnect();
  const wrong = recs.filter(x => x.removedNodes.length || [...x.addedNodes].some(n => !(n.classList && n.classList.contains('wd'))));
  return wrong.map(x => `${x.target.className || x.target.nodeName}: −${x.removedNodes.length} +${[...x.addedNodes].map(n => n.className || n.nodeName).join(',')}`);
}
// conversación más larga que la lámina: el borde de arriba se difumina y lo último se ve entero
function overflowState() {
  const r = document.getElementById('__tvagent').shadowRoot, log = r.querySelector('.log');
  const words = [...r.querySelectorAll('.tn:last-child .wd')], last = words[words.length - 1];
  const lb = log.getBoundingClientRect(), wb = last.getBoundingClientRect();
  return { over: log.classList.contains('over'), lastInside: wb.top >= lb.top - 1 && wb.bottom <= lb.bottom + 1 };
}

function checkGeometry(m) {
  const bad = [], f = n => Math.round(n);
  const safe = { x: m.vw * SAFE.x, y: m.vh * SAFE.y, r: m.vw * (1 - SAFE.x), b: m.vh * (1 - SAFE.y) };
  const out = (b, t) => b.x < safe.x - t || b.y < safe.y - t || b.r > safe.r + t || b.b > safe.b + t;
  const d = b => `[${f(b.x)},${f(b.y)}→${f(b.r)},${f(b.b)}] (seguro [${f(safe.x)},${f(safe.y)}→${f(safe.r)},${f(safe.b)}])`;
  if (out(m.sheet, TOL)) bad.push('contenido fuera del área segura ' + d(m.sheet));
  if (out(m.glass, GLASS_TOL)) bad.push('cristal fuera del área segura ' + d(m.glass));
  for (const k of ['x', 'y', 'r', 'b']) if (Math.abs(m.glass[k] - m.sheet[k]) > GLASS_TOL) { bad.push(`el cristal no abraza el contenido (${k}: ${f(m.glass[k])} vs ${f(m.sheet[k])})`); break; }
  if (m.overflow.length) bad.push('texto desbordado: ' + m.overflow.join(', '));
  if (m.words) bad.push(`${m.words} palabras fuera de la lámina`);
  if (m.bad.length) bad.push('ancestros del cristal que lo rompen: ' + m.bad.join(', '));
  return bad;
}

// el modelo de color de agent-contrast.test.js en el centro del cristal sobre blanco (nivel A, reposo, sin carátula):
// fondo filtrado (brillo en sRGB), velo de tinta, brillos de las esquinas (en el centro de un degradado a 135°/315° que se
// apaga al 55 %, cada uno vale el 9 % de su fuerza) y sombra de abajo (a media altura, del 38 % al 100 %)
function expectedCenter(LOOK) {
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const mix = (top, a, under) => top.map((c, i) => a * c + (1 - a) * under[i]);
  const sheet = hex(LOOK.sheet), k = 1 - 0.5 / 0.55;
  let px = [1, 1, 1].map(x => x * LOOK.ctx.idle.bright);
  px = mix(sheet, LOOK.ctx.idle.tint, px);
  px = mix(mix(hex(LOOK.orb[0]), LOOK.glow.color, sheet), LOOK.glow.a * k, px);
  px = mix(mix(hex(LOOK.orb[1]), LOOK.glow.color, sheet), LOOK.glow.b * k, px);
  px = mix([0, 0, 0], LOOK.glow.shade * (0.5 - 0.38) / (1 - 0.38), px);
  return px.map(x => Math.round(x * 255));
}
const LOOK = (() => {
  const m = fs.readFileSync(path.join(PUB, 'tv-agent.js'), 'utf8').match(/@look:inicio\s*\n\s*const LOOK = (\{[\s\S]*?\});\s*\n\s*\/\/ @look:fin/);
  return new Function('return (' + m[1] + ')')();
})();

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const fails = [], notes = [], shots = [];
  let n = 0;
  const NOW = Date.parse('2026-10-19T19:14:00+02:00');

  async function open(sz, c, night, opts = {}) {
    const ctx = await b.newContext({ viewport: { width: sz.w, height: sz.h }, timezoneId: 'Europe/Madrid', ...opts });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    // el reposo intenta abrir su WebSocket (aquí no hay servidor): ese error no es de la capa
    p.on('console', m => { if (m.type() === 'error' && !/WebSocket connection to/.test(m.text())) errs.push(m.text()); });
    await p.clock.setFixedTime(NOW);
    await p.addInitScript(() => { Math.random = () => 0.5; });
    await p.route(/fonts\.googleapis\.com/, x => x.fulfill({ contentType: 'text/css',
      body: "@font-face{font-family:Fraunces;font-weight:100 900;src:url(https://fonts.gstatic.com/fraunces.woff2) format('woff2')}" }));
    await p.route(/fonts\.gstatic\.com/, x => x.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(FRAUNCES) }));
    await p.goto(base() + c.url);
    if (c.url === '/') await p.evaluate(d => window.onData(d), idleData(NOW, c, night)); // onData: global de idle-app.js
    await p.evaluate(() => document.fonts.ready);
    await p.evaluate(SOURCE); // como el servidor por CDP (Runtime.evaluate): la CSP de la página no aplica
    return { ctx, p, errs };
  }
  // color de un píxel de la pantalla (captura de 1 px decodificada en una página en blanco: la CSP de la de prueba no deja data:)
  async function pixelAt(ctx, p, x, y) {
    const png = await p.screenshot({ clip: { x, y, width: 1, height: 1 } });
    const dec = await ctx.newPage();
    const got = await dec.evaluate(async b64 => {
      const img = new window.Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      return [...cx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, png.toString('base64')).catch(() => null);
    await dec.close();
    return got;
  }
  // como talk-view.js: la misma foto cada 100 ms durante un rato
  const feed = (p, snap, ms) => p.evaluate(async ([s, t]) => {
    for (let i = 0; i < t / 100; i++) { window.TVAgent.render(s); await new Promise(f => setTimeout(f, 100)); }
  }, [snap, ms]);

  for (const sz of SIZES) {
    for (const c of CONTEXTS) {
      const wanted = s => (sz.all || ['escucha', 'herramienta', 'dos-turnos', 'noche', 'fallo', 'desborda'].includes(s.n)) && (!ONLY || ONLY.includes(s.n));
      for (const sc of SCENES.filter(wanted)) {
        if (c.ctx === 'video' && sc.n === 'dos-turnos' && !sz.all) continue;
        const tag = `${sz.n}-${c.n}-${sc.n}`;
        const { ctx, p, errs } = await open(sz, c, !!sc.night);
        const snap = snapFor(sc, c);
        await feed(p, snap, sc.live ? 2400 : 1500);
        await p.waitForTimeout(SETTLE_MS);
        const m = await p.evaluate(measure);
        const bad = m ? checkGeometry(m) : ['sin capa'];
        const changed = await p.evaluate(sameNodes, snap);
        if (changed.length) bad.push('la misma foto cambió el árbol: ' + changed.join(' | '));
        if (sc.overflows) {
          const o = await p.evaluate(overflowState);
          if (!o.over) bad.push('la conversación no cabe y el log no difumina su borde (.over)');
          if (!o.lastInside) bad.push('la última palabra queda fuera del log');
        }
        // abierta, con la respuesta terminada y la misma foto repitiéndose: la membrana se asienta y el rAF se para
        if (!sc.live && !BREATHE.includes(sc.state)) {
          const still = await p.waitForFunction(() => window.TVAgent._debug().open && !window.TVAgent._debug().rafRunning, null, { timeout: STILL_MS }).then(() => true, () => false);
          if (!still) bad.push(`el rAF sigue en marcha ${STILL_MS} ms después con la capa abierta y quieta`);
        }
        const file = path.join(OUT, tag + '.png');
        await p.screenshot({ path: file });
        shots.push(file);
        // cierre: quita la capa y para el rAF
        await p.evaluate(() => window.TVAgent.hide());
        // tras asentarse (≤ 2 s en la capa; con margen para un equipo cargado, donde los temporizadores se retrasan)
        await p.waitForFunction(() => !window.TVAgent._debug().rafRunning && !document.getElementById('__tvagent'), null, { timeout: HIDE_MS }).catch(() => {});
        const end = await p.evaluate(() => ({ ...window.TVAgent._debug(), host: !!document.getElementById('__tvagent'), cls: document.documentElement.classList.contains('tv-agent-talk') }));
        if (end.rafRunning || end.host || end.cls || end.open) bad.push('hide() no cerró del todo: ' + JSON.stringify(end));
        if (errs.length) bad.push('errores de la página: ' + errs.join(' | '));
        n++;
        if (bad.length) fails.push(`✗ ${tag}\n    ` + bad.join('\n    '));
        await ctx.close();
      }
    }
  }

  // un píxel real del cristal sobre blanco contra el modelo de color de la prueba de contraste
  {
    const { ctx, p } = await open(SIZES[0], { url: '/blanco.html' });
    const snap = { form: 'panel', ctx: 'idle', state: 'done', live: false, night: false, calm: true, glass: 'A', colors: null, icons: {},
      turns: [{ id: 1, you: '', youFinal: true, jota: '', tools: [], error: false, hint: '' }] };
    await feed(p, snap, 300);
    await p.waitForTimeout(SETTLE_MS);
    const g = await p.evaluate(() => { const r = document.getElementById('__tvagent').shadowRoot.querySelector('.body').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
    const got = await pixelAt(ctx, p, g.x, g.y);
    const want = expectedCenter(LOOK);
    const diff = got ? Math.max(...got.map((v, i) => Math.abs(v - want[i]))) : Infinity;
    notes.push(`píxel del cristal sobre blanco: real ${got} · modelo ${want} (±${diff})`);
    if (!(diff <= PIXEL_TOL)) fails.push(`✗ modelo de color: el píxel real ${got} no coincide con el modelo ${want} (±${PIXEL_TOL})`);
    await ctx.close();
  }
  // glass:'auto' elige nivel por tiempo de frame (en headless suele ser software: solo se informa)
  {
    const { ctx, p } = await open(SIZES[0], CONTEXTS[0]);
    await feed(p, { ...snapFor(SCENES[1], CONTEXTS[0]), glass: 'auto' }, 3000);
    notes.push('glass:auto eligió el nivel ' + (await p.evaluate(() => window.TVAgent._debug().tier)));
    await ctx.close();
  }
  // <video> a pantalla completa de verdad: lo de pantalla completa va en la capa superior, por encima de cualquier z-index;
  // la capa también (popover) y debe verse encima, tanto si el vídeo entra antes de abrirla como después
  for (const order of ['video-antes', 'video-despues']) {
    const { ctx, p, errs } = await open(SIZES[0], CONTEXTS[3]);
    const snap = snapFor(SCENES[3], CONTEXTS[3]);
    await p.evaluate(() => document.querySelector('video').addEventListener('click', e => e.currentTarget.requestFullscreen()));
    const full = async () => {
      await p.click('video'); // un gesto real: requestFullscreen lo exige
      await p.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.tagName === 'VIDEO', null, { timeout: 3000 });
    };
    if (order === 'video-antes') { await full(); await feed(p, snap, 1500); } else { await feed(p, snap, 1500); await full(); await feed(p, snap, 300); }
    await p.waitForTimeout(SETTLE_MS);
    const g = await p.evaluate(() => {
      const r = document.getElementById('__tvagent').shadowRoot.querySelector('.body').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 6), out: Math.round(r.bottom + 60), top: window.TVAgent._debug().topLayer };
    });
    const inside = await pixelAt(ctx, p, g.x, g.y), outside = await pixelAt(ctx, p, g.x, g.out);
    const diff = inside && outside ? Math.max(...inside.map((v, i) => Math.abs(v - outside[i]))) : 0;
    notes.push(`pantalla completa (${order}): cristal ${inside} · vídeo ${outside} · capa superior ${g.top}`);
    if (!g.top || diff < FULLSCREEN_MIN_DIFF) fails.push(`✗ con el vídeo a pantalla completa (${order}) no se ve la capa: cristal ${inside} · vídeo ${outside}`);
    const file = path.join(OUT, `1280x720-pantalla-completa-${order}.png`);
    await p.screenshot({ path: file }); shots.push(file);
    if (errs.length) fails.push(`✗ pantalla completa (${order}): errores de la página: ${errs.join(' | ')}`);
    await ctx.close();
  }
  // mientras crece (2,5 s desde la primera foto, en cada frame): el cristal escrito no sale del área segura
  for (const c of [CONTEXTS[0], CONTEXTS[3]]) {
    const { ctx, p } = await open(SIZES[0], c);
    const worst = await p.evaluate(async ([s, safe]) => {
      window.TVAgent.render(s);
      const body = document.getElementById('__tvagent').shadowRoot.querySelector('.body');
      const lim = { x: innerWidth * safe.x, y: innerHeight * safe.y, r: innerWidth * (1 - safe.x), b: innerHeight * (1 - safe.y) };
      let w = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 2500) {
        await new Promise(f => requestAnimationFrame(f));
        const b = body.getBoundingClientRect();
        if (b.width > 2) w = Math.max(w, lim.x - b.left, lim.y - b.top, b.right - lim.r, b.bottom - lim.b);
      }
      return w;
    }, [snapFor(SCENES[6], c), SAFE]);
    notes.push(`entrada (${c.n}): el cristal sale del área segura como mucho ${worst.toFixed(1)} px`);
    if (worst > TOL) fails.push(`✗ entrada (${c.n}): el cristal sale ${worst.toFixed(1)} px del área segura mientras crece`);
    await ctx.close();
  }
  // más contraste y colores forzados: siempre nivel C
  for (const media of [{ contrast: 'more' }, { forcedColors: 'active' }]) {
    const { ctx, p } = await open(SIZES[0], CONTEXTS[2], false, media);
    await feed(p, snapFor(SCENES[3], CONTEXTS[2]), 300);
    const tier = await p.evaluate(() => window.TVAgent._debug().tier);
    if (tier !== 'C') fails.push(`✗ con ${JSON.stringify(media)} el nivel es ${tier}, no C`);
    if (media.contrast) { const f = path.join(OUT, '1280x720-web-mas-contraste.png'); await p.waitForTimeout(SETTLE_MS); await p.screenshot({ path: f }); shots.push(f); }
    await ctx.close();
  }

  await b.close(); srv.close();
  if (fails.length) console.error(fails.join('\n'));
  console.log(notes.join('\n'));
  console.log(`${n} combinaciones (tamaño × contexto × escena), ${fails.length} fallos; ${shots.length} capturas en ${OUT}`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
