// Capturas de lo que la tele enseña fuera del reposo y del mando: las plantillas del escenario (tpl-*.html, con datos
// fijos y sin servidor: el WebSocket de tv-stage.js es de mentira), la isla de Live Activities (recogida, expandida, con
// más actividades y debajo del panel del agente) y el código de emparejar. Para comparar antes/después de un cambio
// visual (K3 de la auditoría de experiencia).
//   node tele-capturas.js [carpeta]     (por defecto e2e/capturas-tele)
// Avisa de errores de la página y de la CSP; los cuenta en la última línea.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'remote', 'public');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'capturas-tele'));
const { STAGE_CSP } = require(path.join(ROOT, 'remote', 'src', 'transport', 'static.js'));
const { islandSource, agentSource } = require(path.join(ROOT, 'remote', 'src', 'tv', 'tokens.js'));
const { pairInPage } = require(path.join(ROOT, 'remote', 'src', 'tv', 'devices.js'));
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };
// una página vacía con el fondo del reposo, para la isla y el emparejamiento (que se pintan encima de cualquier web)
const BLANK = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;background:linear-gradient(160deg,#2a2338,#15111c)"></body></html>';
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/blank') { r.writeHead(200, { 'content-type': TYPES['.html'] }); return r.end(BLANK); }
  const f = path.join(PUB, u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); return r.end(); }
  const csp = /^\/tpl-[\w-]+\.html$/.test(u) ? { 'content-security-policy': STAGE_CSP } : {};
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...csp });
  r.end(fs.readFileSync(f));
}).listen(0);
const base = () => `http://127.0.0.1:${srv.address().port}`;

const now = Date.now();
const STAGE = [
  { name: 'recordatorio', tpl: 'tpl-reminder.html', data: { icon: '⏰', kicker: 'Recordatorio', title: 'Sacar la ropa de la lavadora', text: 'Ha terminado el programa de algodón', time: '19:30' } },
  { name: 'diapositiva-lista', tpl: 'tpl-slides.html', data: { auto: 0, slides: [{ kicker: 'Viaje a Lisboa', title: 'Tres días por la ciudad', subtitle: 'Lo esencial, sin prisas', bullets: ['Alfama y el castillo', 'Pastéis en Belém', 'Atardecer en el mirador'] }] } },
  { name: 'diapositiva-cifra', tpl: 'tpl-slides.html', data: { auto: 0, slides: [{ kicker: 'Este mes', big: '42 km', title: 'Has caminado más que en marzo', subtitle: '+18 % respecto al mes pasado' }] } },
  { name: 'tareas', tpl: 'tpl-tasks.html', data: { kicker: 'Hoy', title: 'Lista de la compra', subtitle: '2 de 4 hechas', items: [
    { text: 'Pan', done: true }, { text: 'Tomates de rama', done: true, tag: 'mercado' }, { text: 'Aceite de oliva', due: 'hoy' }, { text: 'Café en grano', tag: 'súper' }] } },
];
const timer = { id: 't1', kind: 'timer', title: 'Pasta', subtitle: 'escurrir y servir', icon: '🍝', accent: '#e8b26a', endsAt: now + 444e3, duration: 600e3, updated: now };
const music = { id: 'm1', kind: 'music', title: 'Midnight City', subtitle: 'M83', icon: '🎵', accent: '#c3b7e3', progress: 0.4, updated: now };
const live = { id: 'l1', kind: 'live', title: 'Partido', subtitle: 'Segunda parte', icon: '⚽', accent: '#8fa8d8', updated: now };
const PANEL = { form: 'panel', ctx: 'idle', state: 'talk', live: false, night: false, calm: true, glass: 'A', colors: null, icons: {},
  turns: [{ id: 1, you: 'Pon un temporizador de diez minutos para la pasta', youFinal: true, jota: 'Hecho, diez minutos. Te aviso cuando termine.', tools: [], error: false, hint: '' }] };

const errs = [];
async function stage(b, vp, s) {
  const p = await b.newPage({ viewport: vp });
  p.on('pageerror', e => errs.push(`${s.name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errs.push(`${s.name}: ${m.text()}`); });
  // sin servidor del escenario: el WebSocket no conecta nunca y los datos se dan a mano
  await p.addInitScript(() => { window.WebSocket = class { send() {} close() {} }; });
  await p.goto(`${base()}/${s.tpl}`);
  await p.evaluate(d => { window.tv.data = d; for (const f of window.tv._h) f(d); }, s.data);
  await p.waitForTimeout(2000);
  await p.screenshot({ path: path.join(OUT, `${vp.width}x${vp.height}-escenario-${s.name}.png`) });
  await p.close();
}
async function overlay(b, vp, name, fn) {
  const p = await b.newPage({ viewport: vp });
  p.on('pageerror', e => errs.push(`${name}: ${e.message}`));
  await p.goto(`${base()}/blank`);
  await fn(p);
  await p.screenshot({ path: path.join(OUT, `${vp.width}x${vp.height}-${name}.png`) });
  await p.close();
}
const island = (p, acts) => p.evaluate(([src, a, t]) => { (0, eval)(src); window.TVIsland.render(a, t); }, [islandSource(PUB), acts, now]);

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  let n = 0;
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    for (const s of STAGE) { await stage(b, vp, s); n++; }
    await overlay(b, vp, 'isla-expandida', async p => { await island(p, [timer]); await p.waitForTimeout(1200); }); n++;
    await overlay(b, vp, 'isla-recogida', async p => { await island(p, [timer, music, live]); await p.waitForTimeout(7000); }); n++;
    await overlay(b, vp, 'isla-con-panel', async p => {
      await p.evaluate(([src, s]) => { (0, eval)(src); window.TVAgent.render(s); }, [agentSource(PUB), PANEL]);
      await island(p, [timer]); await p.waitForTimeout(1500);
    }); n++;
    await overlay(b, vp, 'emparejar', async p => { await p.evaluate(`(${pairInPage})(${JSON.stringify({ code: '4821', name: 'iPhone de Ana' })})`); await p.waitForTimeout(400); }); n++;
  }
  await b.close(); srv.close();
  for (const e of errs) console.log('✗ ' + e);
  console.log(`${n} capturas en ${OUT}; ${errs.length} errores`);
  process.exit(errs.length ? 1 : 0);
})();
