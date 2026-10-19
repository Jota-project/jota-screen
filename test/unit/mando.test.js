'use strict';
// Unitarias de los módulos ES del mando (remote/public/mando): el grafo de importaciones desde app.js (sin ciclos, capas
// en un solo sentido, cada ruta servida por el servidor y ningún módulo suelto) y que ningún módulo salvo app.js haga
// nada al cargarse (ni listeners, ni temporizadores, ni tocar el DOM o el almacenamiento).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const PUB = path.join(__dirname, '..', '..', 'remote', 'public');
const { createStatic } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'transport', 'static'));

const ENTRY = '/mando/app.js';
const CLASSIC = new Set(['/mando/theme.js']); // script clásico del <head>, no es un módulo

// especificadores de import/export … from '…' e import '…' (sin comentarios)
function specifiers(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s*(['"])([^'"]+)\1|^\s*import\s*(['"])([^'"]+)\3/gm)) out.push(m[2] || m[4]);
  return out;
}
const resolve = (from, spec) => new URL(spec, 'http://mando' + from).pathname;

function graph() {
  const statics = createStatic({ dir: PUB });
  const edges = new Map(), bad = [];
  const visit = p => {
    if (edges.has(p)) return;
    edges.set(p, []);
    const src = fs.readFileSync(path.join(PUB, p), 'utf8');
    for (const s of specifiers(src)) {
      if (!/^\.\.?\//.test(s)) { bad.push(`${p}: «${s}» no es relativa`); continue; }
      if (!s.endsWith('.js')) bad.push(`${p}: «${s}» sin .js`);
      const q = resolve(p, s);
      if (!statics.has(q)) { bad.push(`${p}: «${s}» → ${q} no lo sirve el servidor`); continue; }
      edges.get(p).push(q);
      visit(q);
    }
  };
  visit(ENTRY);
  return { edges, bad };
}
const layer = p => (p === ENTRY ? 'app' : p.split('/')[2]);

test('mando: cada importación existe y la sirve el servidor (rutas relativas, .js, hasta 2 niveles)', () => {
  const { edges, bad } = graph();
  assert.deepEqual(bad, []);
  assert.ok(edges.size > 10, 'app.js importa los módulos');
  // y no queda ningún módulo suelto (todo .js de mando/ salvo theme.js se alcanza desde app.js)
  const all = [];
  const walk = d => { for (const f of fs.readdirSync(path.join(PUB, d))) { const r = d + '/' + f; if (fs.statSync(path.join(PUB, r)).isDirectory()) walk(r); else if (f.endsWith('.js')) all.push(r); } };
  walk('/mando');
  assert.deepEqual(all.filter(p => !CLASSIC.has(p) && !edges.has(p)), []);
});

test('mando: sin ciclos y capas en un solo sentido (core ← ui ← features ← app)', () => {
  const { edges } = graph();
  const state = new Map(), cycles = [];
  const dfs = (p, stack) => {
    state.set(p, 1); stack.push(p);
    for (const q of edges.get(p)) {
      if (state.get(q) === 1) cycles.push([...stack.slice(stack.indexOf(q)), q].join(' → '));
      else if (!state.has(q)) dfs(q, stack);
    }
    stack.pop(); state.set(p, 2);
  };
  dfs(ENTRY, []);
  assert.deepEqual(cycles, []);
  const allowed = { core: ['core'], ui: ['core', 'ui'], features: ['core', 'ui', 'features'], app: ['core', 'ui', 'features'] };
  const wrong = [];
  for (const [p, qs] of edges) for (const q of qs) if (!allowed[layer(p)].includes(layer(q))) wrong.push(`${p} → ${q}`);
  assert.deepEqual(wrong, []);
});

test('mando: ningún módulo salvo app.js hace nada al cargarse', async () => {
  const { edges } = graph();
  // copia como paquete ESM (remote/ es CommonJS) y se importan con globales espía
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-mod-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const NAMES = ['document', 'window', 'localStorage', 'sessionStorage', 'location', 'history', 'navigator', 'fetch', 'WebSocket',
    'addEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'visualViewport', 'innerHeight', 'performance'];
  const saved = NAMES.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  const touched = [];
  try {
    for (const n of NAMES) Object.defineProperty(globalThis, n, { configurable: true, get() { touched.push(n); return undefined; } });
    for (const p of edges.keys()) {
      if (p === ENTRY) continue;
      const before = touched.length;
      try { await import(pathToFileURL(path.join(tmp, p)).href); } catch (e) { touched.push(`error: ${e.message}`); }
      if (touched.length > before) touched.push(`← al cargar ${p} (o lo que importa)`);
    }
  } finally {
    for (const [n, d] of saved) { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(touched, []);
});

test('mando: cada módulo de index.html tiene su modulepreload, y nada más', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const pre = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]).sort();
  const mods = [...graph().edges.keys()].filter(p => p !== ENTRY).sort();
  assert.deepEqual(pre, mods);
});
