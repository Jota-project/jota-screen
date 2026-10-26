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
// módulos de AudioWorklet: no los importa nadie, los carga audioWorklet.addModule (voice.js) por su ruta
const WORKLETS = new Map([['/mando/features/mic-worklet.js', '/mando/features/voice.js']]);

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
  assert.ok(edges.has('/mando/features/tele.js'), 'el modo Tele (features/tele.js) está en el grafo');
  // y no queda ningún módulo suelto (todo .js de mando/ salvo theme.js se alcanza desde app.js)
  const all = [];
  const walk = d => { for (const f of fs.readdirSync(path.join(PUB, d))) { const r = d + '/' + f; if (fs.statSync(path.join(PUB, r)).isDirectory()) walk(r); else if (f.endsWith('.js')) all.push(r); } };
  walk('/mando');
  assert.deepEqual(all.filter(p => !CLASSIC.has(p) && !WORKLETS.has(p) && !edges.has(p)), []);
  // cada worklet lo sirve el servidor y lo carga su módulo por esa misma ruta
  const statics = createStatic({ dir: PUB });
  for (const [w, by] of WORKLETS) {
    assert.ok(statics.has(w), w);
    assert.ok(edges.has(by) && fs.readFileSync(path.join(PUB, by), 'utf8').includes(`addModule('${w}')`), `${by} carga ${w}`);
  }
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

test('mando: cada hoja tiene un solo dueño (registerSheet lanza con una hoja repetida y el mando no arrancaría)', async () => {
  // app.js registra las capacidades en orden; si dos registran la misma hoja (como agent y voice con agS), todo cae
  const app = fs.readFileSync(path.join(PUB, 'mando', 'app.js'), 'utf8');
  const list = /register\(\[([^\]]+)\]\)/.exec(app)[1].split(',').map(s => s.trim());
  const imports = new Map([...app.matchAll(/import \{ ([^}]+) \} from '\.\/(features\/[^']+)'/g)]
    .flatMap(m => m[1].split(',').map(n => [n.trim(), m[2]])));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-hojas-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  try {
    const owner = new Map(), dup = [];
    for (const name of list) {
      const mod = await import(pathToFileURL(path.join(tmp, 'mando', imports.get(name))).href);
      for (const id of Object.keys(mod[name].sheets || {})) { if (owner.has(id)) dup.push(`${id}: ${owner.get(id)} y ${name}`); else owner.set(id, name); }
    }
    assert.deepEqual(dup, []);
    assert.ok(owner.has('agS') && owner.has('spS'), 'encuentra las hojas');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mando: salto a https para la voz (core/secure.js): solo desde http fuera del bucle local, con el token en el fragmento', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-secure-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  try {
    const { secureTarget } = await import(pathToFileURL(path.join(tmp, 'mando', 'core', 'secure.js')).href);
    const at = u => { const x = new URL(u); return { protocol: x.protocol, hostname: x.hostname, origin: x.origin, pathname: x.pathname, search: x.search, hash: x.hash }; };
    const S = 'https://tele.example.ts.net:8443';
    assert.equal(secureTarget(at('http://mando.local/'), S, 'abc123abc123abc123'), S + '/#t=abc123abc123abc123');
    assert.equal(secureTarget(at('http://192.168.1.19:8787/?x=1#admin=ABCDEF'), S, ''), S + '/?x=1#admin=ABCDEF', 'conserva ruta, consulta y el código de admin');
    assert.equal(secureTarget(at('http://mando.local/#admin=ABCDEF'), S, 'tok0tok0tok0tok0'), S + '/#admin=ABCDEF&t=tok0tok0tok0tok0');
    for (const u of ['http://127.0.0.1:8787/', 'http://localhost:8787/', 'http://[::1]:8787/', S + '/', 'https://otro.example/'])
      assert.equal(secureTarget(at(u), S, 'tok0tok0tok0tok0'), '', u);
    for (const s of ['', 'http://inseguro.example', 'no es una url'])
      assert.equal(secureTarget(at('http://mando.local/'), s, 'tok0tok0tok0tok0'), '', `sin destino https: ${s}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mando: el orbe de la voz no deja el gesto al navegador (touch-action:none; si no, un temblor del dedo cancela la grabación)', () => {
  const css = fs.readFileSync(path.join(PUB, 'mando', 'styles', 'mando.css'), 'utf8');
  const rules = [...css.matchAll(/(?:^|})\s*\.vzOrb\{([^}]*)\}/g)].map(m => m[1]).join(';');
  assert.match(rules, /touch-action:none/);
  assert.doesNotMatch(rules, /touch-action:(manipulation|pan|auto)/);
});

test('mando: hoja de ajustes: cada #id de settings, idle y admin existe, cada fila abre su página y los segmentos son radiogroups', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const f of ['settings', 'idle', 'admin']) {
    const js = fs.readFileSync(path.join(PUB, 'mando', 'features', f + '.js'), 'utf8');
    assert.deepEqual([...new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))].filter(id => !ids.has(id)), [], f);
  }
  const sheet = /<div class="sheet" id="setS"[\s\S]*?\n<\/div>\n/.exec(html)[0];
  const pages = [...sheet.matchAll(/class="sp" data-p="(\w+)"/g)].map(m => m[1]);
  assert.equal(pages[0], 'home');
  assert.deepEqual([...new Set([...sheet.matchAll(/data-go="(\w+)"/g)].map(m => m[1]))].sort(), pages.slice(1).sort(), 'una fila por página');
  assert.equal((sheet.match(/data-back/g) || []).length, pages.length - 1, 'cada página tiene «Volver»');
  // sin interruptor de versión: la tele solo tiene los paneles vivos
  assert.doesNotMatch(html, /idAgDes|Diseño nuevo|aria-disabled/);
  // todos los segmentos: radiogroup con nombre y radios (aria-pressed en un radio no es ARIA válido)
  const groups = [...sheet.matchAll(/<div class="(?:seg|pick)" id="(\w+)" role="radiogroup" aria-label="[^"]+">([\s\S]*?)<\/div>/g)];   // dentro de un grupo no hay <div>
  assert.deepEqual(groups.map(g => g[1]).sort(), ['acAgent', 'acMusic', 'acWho', 'idGlass', 'idLay', 'idMode', 'segIntr', 'segTheme', 'sgLook', 'sgMax']);
  for (const [, id, body] of groups) {
    const bs = body.match(/<button[^>]*>/g);
    assert.ok(bs.every(b => b.includes('role="radio"') && !b.includes('aria-pressed')), id);
  }
  const glass = groups.find(g => g[1] === 'idGlass')[2];
  assert.deepEqual([...glass.matchAll(/data-g="([^"]+)">.*?<b>([^<]+)<\/b>/g)].map(m => [m[1], m[2]]), [['auto', 'Automático'], ['A', 'Completo'], ['B', 'Ligero'], ['C', 'Opaco']]);
  const css = fs.readFileSync(path.join(PUB, 'mando', 'styles', 'mando.css'), 'utf8');
  assert.match(css, /\.seg button\[aria-checked=true\]/);
  assert.match(css, /\.pick button\[aria-checked=true\]/);
});

/** Grupo de radios falso: los atributos se guardan como texto (como en el DOM) y cada botón lleva su data-g. */
function fakeGroup() {
  const ls = {};
  const buttons = ['auto', 'A', 'B', 'C'].map(g => ({ attrs: {}, dataset: { g }, tabIndex: 0, setAttribute(k, v) { this.attrs[k] = String(v); }, focus() { grp.focused = this; } }));
  const grp = { buttons, focused: null, querySelectorAll: () => buttons, contains: () => true, addEventListener: (t, f) => { ls[t] = f; }, fire: (t, e) => ls[t](e) };
  return grp;
}

test('mando: segmentos (ui/seg.js): aria-checked, foco itinerante y flechas que eligen', async () => {
  const { segPaint, segOn } = await import(pathToFileURL(path.join(PUB, 'mando', 'ui', 'seg.js')).href);
  const grp = fakeGroup();
  const state = () => grp.buttons.map(b => [b.dataset.g, b.attrs['aria-checked'], b.tabIndex]);
  segPaint(grp, 'g', 'B');
  assert.deepEqual(state(), [['auto', 'false', -1], ['A', 'false', -1], ['B', 'true', 0], ['C', 'false', -1]]);
  segPaint(grp, 'g', 'nada');                              // valor desconocido: ninguno marcado, el primero entra con Tab
  assert.deepEqual(state().map(c => c[2]), [0, -1, -1, -1]);
  const picked = [];
  segOn(grp, 'g', v => picked.push(v));
  const key = (k, i) => { let prevented = false; grp.fire('keydown', { key: k, target: grp.buttons[i], preventDefault: () => { prevented = true; } }); return prevented; };
  assert.equal(key('ArrowRight', 3), true); assert.equal(key('ArrowLeft', 0), true);
  key('Home', 2); key('End', 0);
  assert.equal(key('a', 1), false, 'otras teclas no se tocan');
  assert.deepEqual(picked, ['auto', 'C', 'auto', 'C']);
  assert.equal(grp.focused, grp.buttons[3]);
  grp.fire('click', { target: { closest: () => grp.buttons[1] } });
  assert.deepEqual(picked.at(-1), 'A');
});

test('pcm-player: PCM16 LE se pasa a Float32 y el frame sin 0xA1 ni seq no suena', async () => {
  const { pcm16ToFloat32, createPcmPlayer } = await import(pathToFileURL(path.join(PUB, 'mando', 'features', 'pcm-player.js')).href);
  const b = new Uint8Array([0xA1, 0, 5, 0x00, 0x80, 0xFF, 0x7F, 0, 0]).buffer;   // -32768, 32767, 0
  const f = pcm16ToFloat32(b, 3);
  assert.deepEqual([...f], [-1, 32767 / 32768, 0]);
  const srcs = [], ctx = { state: 'running', currentTime: 1, destination: {}, resume() { return Promise.resolve(); },
    createBuffer: (_c, n, r) => ({ duration: n / r, copyToChannel() {} }),
    createBufferSource: () => { const s = { connect() {}, disconnect() {}, start(at) { s.at = at; }, stop() { s.stopped = true; } }; srcs.push(s); return s; } };
  const p = createPcmPlayer(() => ctx);
  p.play(b);                                               // seq 5: abre el turno
  p.play(new Uint8Array([0xA1, 0, 6, 1, 0]).buffer);       // seq 6: se descarta
  p.play(new Uint8Array([0x00, 0, 5, 1, 0]).buffer);       // sin 0xA1: se descarta
  p.play(new Uint8Array([0xA1, 0, 5, 1, 0]).buffer);       // seq 5: detrás del anterior
  assert.equal(srcs.length, 2);
  assert.ok(srcs[1].at > srcs[0].at, 'back-to-back');
  p.stop();
  assert.ok(srcs.every(s => s.stopped));
  p.play(new Uint8Array([0xA1, 0, 6, 1, 0]).buffer);       // tras stop, otro turno vale
  assert.equal(srcs.length, 3);
});

test('pcm-player: pos() son los ms del turno ya sonados según ctx.currentTime (con huecos y atascos); stop o otro turno, de cero', async () => {
  const { createPcmPlayer } = await import(pathToFileURL(path.join(PUB, 'mando', 'features', 'pcm-player.js')).href);
  const srcs = [], ctx = { state: 'running', currentTime: 10, destination: {}, resume() { return Promise.resolve(); },
    createBuffer: (_c, n, r) => ({ duration: n / r, copyToChannel() {} }),
    createBufferSource: () => { const s = { connect() {}, disconnect() {}, start(at) { s.at = at; }, stop() {} }; srcs.push(s); return s; } };
  const frame = (seq, ms) => { const b = new Uint8Array(3 + ms * 48); b[0] = 0xA1; b[2] = seq; return b.buffer; };
  const p = createPcmPlayer(() => ctx);
  assert.equal(p.pos(), 0, 'nada programado');
  p.play(frame(5, 200)); p.play(frame(5, 100));             // empieza en 10,05 s: 200 ms y 100 ms seguidos
  assert.equal(p.pos(), 0, 'aún no suena (LEAD)');
  ctx.currentTime = 10.15;
  assert.ok(Math.abs(p.pos() - 100) < 1e-6);
  ctx.currentTime = 10.30;
  assert.ok(Math.abs(p.pos() - 250) < 1e-6, 'ya en el segundo trozo');
  ctx.currentTime = 11;
  assert.ok(Math.abs(p.pos() - 300) < 1e-6, 'acabado: todo lo programado');
  srcs.forEach(s => s.onended && s.onended());              // se vacía (atasco): el mismo turno sigue contando
  p.play(frame(5, 100));                                    // tras el hueco, en 11,05 s
  ctx.currentTime = 11.1;
  assert.ok(Math.abs(p.pos() - 350) < 1e-6);
  srcs.forEach(s => s.onended && s.onended());
  p.play(frame(6, 100));                                    // otro turno: de cero
  ctx.currentTime = 11.2;
  assert.ok(Math.abs(p.pos() - 50) < 1e-6);
  p.stop();
  assert.equal(p.pos(), 0);
});

test('mando: la voz sincronizada usa el mismo reloj que el servidor (voice-sync.js charAt) y enseña hasta el fin de la frase en curso', async () => {
  const { spokenAt, voiceWords } = await import(pathToFileURL(path.join(PUB, 'mando', 'features', 'agent.js')).href);
  const { charAt } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'voice-sync'));
  const a = [[100, 0], [400, 5], [700, 6]];
  for (const t of [-5, 0, 100, 250, 400, 550, 700, 800, 5000]) assert.equal(spokenAt(a, 50, t, 40), charAt(a, 50, t, 40), 't=' + t);
  assert.equal(spokenAt([], 50, 800, 7), 0);
  const text = 'Hola, Sito. Hoy hace sol. Mañana llueve.';
  assert.deepEqual(voiceWords(text, 0), { words: ['Hola,', 'Sito.'], said: 0 });
  assert.deepEqual(voiceWords(text, 6.5), { words: ['Hola,', 'Sito.'], said: 1 });
  assert.deepEqual(voiceWords(text, 12), { words: ['Hola,', 'Sito.', 'Hoy', 'hace', 'sol.'], said: 2 });
  assert.deepEqual(voiceWords(text, text.length).said, 7);
  assert.deepEqual(voiceWords('Frase aún sin cerrar', 0).words, ['Frase', 'aún', 'sin', 'cerrar'], 'sin punto: lo que haya');
});

// ── formato de la conversación en la tele desde la hoja de Jota (features/talkform.js, contrato r3 §3) ──
const talkform = () => import(pathToFileURL(path.join(PUB, 'mando', 'features', 'talkform.js')).href);

test('mando: los formatos de la conversación son los del contrato (agent-contract.js FORMS)', async () => {
  const { FORMS } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'agent-contract'));
  assert.deepEqual([...(await talkform()).FORMS], [...FORMS]);
});

test('mando: deslizar la tarjeta pide el otro formato (derecha → panel, izquierda → píldora) solo pasado el umbral o con golpe', async () => {
  const { decide, SWIPE_MIN_PX: T, SWIPE_MIN_VEL: V, FLICK_MIN_PX: F } = await talkform();
  const cases = [
    ['pill', T, 0, 'panel'], ['pill', T - 1, 0, null], ['pill', -T * 2, 0, null],          // de píldora solo hacia la derecha
    ['panel', -T, 0, 'pill'], ['panel', -(T - 1), 0, null], ['panel', T * 2, 0, null],      // de panel solo hacia la izquierda
    ['pill', F, V, 'panel'], ['pill', F - 1, V * 3, null], ['pill', F, V - 0.01, null],     // golpe: velocidad y recorrido mínimos
    ['panel', -F, -V, 'pill'], ['panel', -F, V, null],                                      // golpe hacia el otro lado
    ['pill', T, -V * 3, 'panel'],                                                           // pasado el umbral vale aunque frene
    ['otro', T * 3, V * 3, null], [undefined, -T * 3, 0, null],
  ];
  for (const [form, dx, vx, want] of cases) assert.equal(decide(form, dx, vx), want, `${form} dx=${dx} vx=${vx}`);
});

test('mando: la tarjeta sigue al dedo hasta el umbral y se resiste después y en el sentido que no cambia nada; el eje se decide tras la holgura', async () => {
  const { rubber, axis, SWIPE_MIN_PX: T, RUBBER: R, LOCK_PX: L } = await talkform();
  assert.equal(rubber('pill', T / 2), T / 2);
  assert.equal(rubber('pill', T + 100), T + 100 * R);
  assert.equal(rubber('pill', -100), -100 * R);
  assert.equal(rubber('panel', -T / 2), -T / 2);
  assert.equal(rubber('panel', -(T + 100)), -(T + 100 * R));
  assert.equal(rubber('panel', 100), 100 * R);
  assert.equal(axis(L - 1, 0), null);
  assert.equal(axis(L, 3), 'x');
  assert.equal(axis(-L, -3), 'x');
  assert.equal(axis(3, L), 'y', 'vertical: es desplazar la hoja');
  assert.equal(axis(L, L), 'y', 'en la diagonal manda desplazar');
});

test('mando: la velocidad del golpe es la de justo antes de soltar (deprisa, pararse y soltar no cambia el formato)', async () => {
  const { releaseVel, decide, VEL_WINDOW_MS: Wn, SWIPE_MIN_VEL: V, FLICK_MIN_PX: F } = await talkform();
  const fast = [{ x: 0, t: 0 }, { x: 20, t: 16 }, { x: 40, t: 32 }];
  assert.equal(releaseVel([...fast, { x: 40, t: 40 }], 40), 40 / 40);
  assert.ok(releaseVel([...fast, { x: 40, t: 40 }], 40) >= V);
  // deprisa hasta 40 px, quieto medio segundo y soltar: ya no es golpe
  const still = [...fast, { x: 40, t: 532 }];
  assert.equal(releaseVel(still, 532), 0);
  assert.equal(decide('pill', 40, releaseVel(still, 532)), null);
  assert.equal(decide('pill', 40, releaseVel([...fast, { x: 40, t: 40 }], 40)), 'panel', `golpe de ${F}+ px`);
  // un solo punto en la ventana: sin velocidad
  assert.equal(releaseVel([{ x: 0, t: 0 }, { x: 10, t: Wn + 50 }], Wn + 50), 0);
});

test('mando: hoja de Jota: cada #id de agent.js y talkform.js existe; botón de formato accesible y tarjeta sin robar el desplazamiento', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const f of ['agent.js', 'talkform.js']) {
    const js = fs.readFileSync(path.join(PUB, 'mando', 'features', f), 'utf8');
    assert.deepEqual([...new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))].filter(id => !ids.has(id)), [], f);
  }
  // botón: de partida oculto (sin conversación en la tele) y en la fila de 48 px de Parar / Quitar. Su texto es la acción
  // (cambia con el formato), así que no lleva aria-pressed: «Hacer píldora, activado» diría lo contrario de lo que hay
  assert.match(html, /<div class="vzA">[^\n]*<button class="b2" id="agForm" type="button" hidden>Ampliar en la tele<\/button><\/div>/);
  assert.doesNotMatch(html, /id="agForm"[^>]*aria-pressed/);
  // el cambio confirmado se anuncia en su propia región viva (#agSt es del estado de la conversación), visible para el
  // lector de pantalla desde el principio: ni hidden ni display:none
  assert.match(html, /<div class="vzSr" id="agFs" role="status"><\/div>/);
  const sr = /(?:^|})\s*\.vzSr\{([^}]*)\}/m.exec(fs.readFileSync(path.join(PUB, 'mando', 'styles', 'mando.css'), 'utf8'));
  assert.ok(sr, '.vzSr en mando.css');
  assert.match(sr[1], /clip-path:inset\(50%\)/);
  assert.doesNotMatch(sr[1], /display:none|visibility:hidden/);
  // la tarjeta envuelve la frase y la respuesta
  assert.match(html, /<div class="vzCard" id="agCard">\s*<p class="vzQ" id="agQ"><\/p>\s*<div class="rep" id="rep"><\/div>/);
  const css = fs.readFileSync(path.join(PUB, 'mando', 'styles', 'mando.css'), 'utf8');
  assert.match(css, /\.vzA \.b2\{height:48px/);
  const card = [...css.matchAll(/(?:^|})\s*\.vzCard(?:\[[^\]]+\]|\.[\w-]+)?\{([^}]*)\}/gm)].map(m => m[1]).join(';');
  assert.match(card, /touch-action:pan-y/, 'el vertical sigue siendo del navegador (la hoja se desplaza)');
  assert.doesNotMatch(card, /touch-action:none/);
});

/** Hoja de Jota falsa para talkForm: tarjeta, pista y botón con lo justo del DOM. */
function fakeAgentSheet() {
  const node = extra => Object.assign({ hidden: false, attrs: {}, dataset: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = String(v); },
    classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
    style: { removeProperty() {}, setProperty() {} } }, extra);
  const spans = ['pill', 'panel'].map(f => node({ dataset: { f } }));
  const els = { '#agCard': node(), '#agForm': node({ hidden: true }), '#agFh': node({ hidden: true, querySelectorAll: () => spans }),
    '#agFs': node() };
  return { els, spans };
}

test('mando: el control de formato pinta lo último del servidor y se va con canSwitch false o sin conversación (hidden)', async () => {
  const { talkForm } = await talkform();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const { els, spans } = fakeAgentSheet();
  const b = els['#agForm'], fs_ = els['#agFs'], on = () => spans.filter(s => s.classList.set.has('on')).map(s => s.dataset.f);
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: s => els[s] || null } });
    talkForm.got({ ev: 'form', form: 'pill', canSwitch: true });
    assert.equal(b.hidden, false);
    assert.equal(b.textContent, 'Ampliar en la tele');
    assert.equal('aria-pressed' in b.attrs, false, 'etiqueta de acción: sin aria-pressed');
    assert.equal(fs_.textContent, '', 'al aparecer no se anuncia nada');
    assert.equal(els['#agCard'].dataset.sw, 'pill');
    assert.equal(els['#agFh'].hidden, false);
    assert.deepEqual(on(), ['pill']);
    talkForm.got({ ev: 'form', form: 'panel', canSwitch: true });
    assert.equal(b.textContent, 'Hacer píldora');
    assert.equal('aria-pressed' in b.attrs, false);
    assert.deepEqual(on(), ['panel']);
    assert.equal(fs_.textContent, 'En la tele: panel grande', 'el cambio confirmado se anuncia');
    talkForm.got({ ev: 'form', form: 'pill', canSwitch: true });
    assert.equal(fs_.textContent, 'En la tele: píldora');
    talkForm.got({ ev: 'form', form: 'panel', canSwitch: true });
    talkForm.got({ ev: 'form', form: 'panel', canSwitch: true });   // el mismo otra vez (reconexión, otro turno)
    assert.equal(fs_.textContent, 'En la tele: panel grande');
    talkForm.got({ ev: 'form', form: 'panel', canSwitch: false });
    assert.equal(b.hidden, true, 'canSwitch false: sin control');
    assert.equal(els['#agFh'].hidden, true);
    assert.equal(els['#agCard'].dataset.sw, undefined, 'sin control, la tarjeta no se desliza');
    talkForm.got({ ev: 'form', form: 'pill', canSwitch: true });
    talkForm.got(null);                                    // hidden: la tele ya no enseña la conversación
    assert.equal(b.hidden, true);
    assert.equal(fs_.textContent, '', 'sin conversación no queda un anuncio viejo');
    talkForm.got({ ev: 'form', form: 'panel', canSwitch: true });
    assert.equal(fs_.textContent, '', 'una conversación nueva no es un cambio');
    talkForm.got({ ev: 'form', form: 'raro', canSwitch: true });
    assert.equal(b.hidden, true, 'un formato desconocido no pinta nada');
    // canSwitch tiene que ser true de verdad
    talkForm.got({ ev: 'form', form: 'pill' });
    assert.equal(b.hidden, true);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document;
  }
});

test('mando: agent.js pasa los `form` y `hidden` de talk al control de formato y la orden es talkform', () => {
  const js = fs.readFileSync(path.join(PUB, 'mando', 'features', 'agent.js'), 'utf8');
  assert.match(js, /j\.ev === 'form'\) \{ talkForm\.got\(j\)/);
  assert.match(js, /j\.ev === 'hidden'\) \{[^}]*talkForm\.got\(null\)/);
  const tf = fs.readFileSync(path.join(PUB, 'mando', 'features', 'talkform.js'), 'utf8');
  assert.match(tf, /rpc\(\{ t: 'talkform', form \}\)/);
  // al capturar, el lostpointercapture de la captura implícita (la frase o la respuesta) sube a la tarjeta: no es soltar
  assert.match(tf, /addEventListener\('lostpointercapture', e => \{ if \(e\.target === card\)/);
});
