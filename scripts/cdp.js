#!/usr/bin/env node
'use strict';
// Herramienta de depuración: habla con el Chrome del kiosco por CDP (solo 127.0.0.1). Sin dependencias
// (Node 22+ trae fetch y WebSocket). Ver «node scripts/cdp.js --help».
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const USAGE = `Uso: node scripts/cdp.js [--port N] [--tab N] <orden> [argumento]

Órdenes:
  tabs            lista las pestañas (índice, tipo, título y URL)
  nav <url>       navega a la URL y espera a que cargue; imprime URL y título
  eval <js>       evalúa la expresión en la pestaña y imprime el resultado (JSON); admite promesas
  click <texto>   pulsa el primer botón o enlace cuyo texto (o aria-label) encaje con <texto>
                  (expresión regular, sin distinguir mayúsculas); imprime la URL antes y después

Opciones:
  --port N   puerto CDP (por defecto TV_CDP_PORT del entorno o de la config, o 9222)
  --tab N    índice de la pestaña (por defecto la primera de tipo «page»; ver «tabs»)
  -h, --help esta ayuda

La config se lee de TV_CONFIG o ~/.config/jota-screen/screen.env.`;

/** TV_CDP_PORT del entorno; si no, del fichero de config (KEY=valor); si no, 9222. */
function cdpPort(env = process.env) {
  if (env.TV_CDP_PORT) return Number(env.TV_CDP_PORT);
  const file = env.TV_CONFIG || path.join(os.homedir(), '.config', 'jota-screen', 'screen.env');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*TV_CDP_PORT\s*=\s*["']?(\d+)["']?\s*$/.exec(line);
      if (m) return Number(m[1]);
    }
  } catch {}
  return 9222;
}

function parseArgs(argv) {
  const o = { port: 0, tab: -1, cmd: '', arg: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.cmd = 'help';
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--tab') o.tab = Number(argv[++i]);
    else rest.push(a);
  }
  if (!o.cmd) [o.cmd = '', o.arg] = rest;
  return o;
}

async function connect(port, tab) {
  const base = `http://127.0.0.1:${port}`;
  const list = await fetch(base + '/json/list', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  const pages = list.filter(t => t.type === 'page');
  const page = tab >= 0 ? list[tab] : pages[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error(tab >= 0 ? `no hay pestaña ${tab}` : 'no hay ninguna página abierta');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method) for (const w of waiters.splice(0)) w(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no se pudo abrir el WebSocket de CDP')); });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(r.error.message);
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  const event = (name, ms) => new Promise(res => {
    const t = setTimeout(() => res(null), ms);
    const w = m => { if (m.method === name) { clearTimeout(t); res(m); } else waiters.push(w); };
    waiters.push(w);
  });
  return { ws, send, evaluate, event };
}

const CLICK = re => `(() => {
  const re = new RegExp(${JSON.stringify(re)}, 'i');
  const label = e => (e.innerText || e.getAttribute('aria-label') || '').trim();
  const els = [...document.querySelectorAll('button,[role=button],a')];
  const b = els.find(e => re.test(label(e)));
  if (!b) return 'no encontrado; hay: ' + els.slice(0, 15).map(e => label(e).slice(0, 30)).filter(Boolean).join(' | ');
  b.click();
  return 'click: ' + label(b);
})()`;

async function main(argv) {
  const o = parseArgs(argv);
  if (o.cmd === 'help' || !o.cmd) { console.log(USAGE); return o.cmd ? 0 : 2; }
  const port = o.port || cdpPort();
  if (o.cmd === 'tabs') {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
    list.forEach((t, i) => console.log(`${i}\t${t.type}\t${t.title}\t${t.url}`));
    return 0;
  }
  if (!['nav', 'eval', 'click'].includes(o.cmd)) { console.error(`orden desconocida: ${o.cmd}\n\n${USAGE}`); return 2; }
  if (o.arg === undefined) { console.error(`falta el argumento de «${o.cmd}»\n\n${USAGE}`); return 2; }
  const c = await connect(port, o.tab);
  try {
    if (o.cmd === 'eval') {
      console.log(JSON.stringify(await c.evaluate(o.arg)));
    } else if (o.cmd === 'nav') {
      await c.send('Page.enable');
      const loaded = c.event('Page.loadEventFired', 15000);
      const r = await c.send('Page.navigate', { url: o.arg });
      if (r.result?.errorText) throw new Error(r.result.errorText);
      if (!(await loaded)) console.error('aviso: la página no ha terminado de cargar en 15 s');
      console.log('url:', await c.evaluate('location.href'));
      console.log('título:', await c.evaluate('document.title'));
    } else {
      console.log('antes:', await c.evaluate('location.href'));
      console.log(await c.evaluate(CLICK(o.arg)));
      await new Promise(r => setTimeout(r, 2000));
      console.log('después:', await c.evaluate('location.href'));
      console.log('título:', await c.evaluate('document.title'));
    }
  } finally { c.ws.close(); }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => {
    const why = e.cause?.code === 'ECONNREFUSED' ? `nadie escucha en 127.0.0.1:${cdpPort()} (¿kiosco parado?)` : e.message;
    console.error('error:', why);
    process.exit(1);
  });
}

module.exports = { cdpPort, parseArgs };
