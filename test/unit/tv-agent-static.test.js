'use strict';
// Capa de conversación (remote/public/tv-agent.js), sin navegador:
// - reglas del fuente: nada de innerHTML y compañía (Trusted Types/CSP), medidas solo en calc(N * var(--u)) y los valores
//   de aspecto solo en el objeto LOOK (los vigila agent-contrast.test.js);
// - se evalúa en un vm con un DOM falso mínimo y se comprueba la interfaz (render/hide/_debug), que repetir la misma foto
//   no recrea nodos, que las palabras salen de una en una y que hide() para el rAF.
// La prueba con navegador real (capturas, área segura, animaciones) es e2e/agente-capturas.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'remote', 'public', 'tv-agent.js'), 'utf8');
// el objeto LOOK evaluado (como agent-contrast.test.js)
const lookOf = src => new Function('return (' + src.match(/@look:inicio\s*\n\s*const LOOK = (\{[\s\S]*?\});\s*\n\s*\/\/ @look:fin/)[1] + ')')();

test('solo createElement/textContent: sin innerHTML, outerHTML, insertAdjacentHTML, document.write ni eval', () => {
  assert.doesNotMatch(SRC, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|\beval\(|new Function\b/);
  assert.doesNotMatch(SRC, /setAttribute\(\s*['"]style['"]/, 'estilos por CSSOM: la CSP bloquea el atributo style');
});

test('medidas en calc(N * var(--u)): los únicos px literales son 0px, 1px y .5px (filos finos, justificados al lado)', () => {
  const bad = [];
  SRC.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/(?<![\w.$-])(-?\d*\.?\d+)px\b/g)) {
      const n = m[1];
      if (n === '0' || n === '1') continue;
      if (n === '.5' && /\/\*|\/\//.test(l + SRC.split('\n')[i - 1])) continue; // .5px con su comentario en la línea o la anterior
      bad.push(`${i + 1}: ${m[0]} → ${l.trim().slice(0, 100)}`);
    }
  });
  assert.deepEqual(bad, [], 'medidas fuera de --u:\n' + bad.join('\n'));
  assert.match(SRC, /--u:min\(calc\(100vw \/ 1920\), calc\(100vh \/ 1080\)\)/);
  // el área segura, en la hoja ya construida (sale de la constante SAFE, que también usa el rAF para el cristal)
  const p = loadPage();
  p.win.TVAgent.render(snap());
  const css = p.host().shadowRoot.adoptedStyleSheets[0].css;
  assert.match(css, /--mx:max\([^;]*, 5vw\)/, 'área segura: 5 % del ancho');
  assert.match(css, /--my:max\([^;]*, 6vh\)/, 'área segura: 6 % del alto');
});

test('los velos y brillos del contexto viven solo en LOOK (no hay copias sueltas que la prueba de contraste no vea)', () => {
  const i = SRC.indexOf('// @look:fin');
  assert.ok(i > 0);
  const rest = SRC.slice(i);
  for (const v of ['0.76', '0.88', '0.90', '0.97', '#a39cad', '#6e6e6e', '#0c0c0c', '#2a2233', '#ddd6d0'])
    assert.ok(!rest.includes(v) && !rest.includes(v.replace(/^0\./, '.')), `«${v}» aparece fuera de LOOK`);
});

// ── DOM falso mínimo: lo justo para que tv-agent.js monte su árbol y responda a render/hide
class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.doc = doc; this.childNodes = []; this.parentNode = null; this.attrs = new Map();
    this._text = ''; this.className = ''; this.dataset = {}; this.scrollHeight = 0; this.clientHeight = 0;
    const st = new Map();
    this.style = new Proxy({ setProperty: (k, v) => st.set(k, v), getPropertyValue: k => st.get(k) || '' }, {
      set: (o, k, v) => { o[k] = v; return true; },
    });
    const self = this;
    this.classList = {
      _s() { return new Set(self.className.split(/\s+/).filter(Boolean)); },
      add(...c) { const s = this._s(); c.forEach(x => s.add(x)); self.className = [...s].join(' '); },
      remove(...c) { const s = this._s(); c.forEach(x => s.delete(x)); self.className = [...s].join(' '); },
      contains(c) { return this._s().has(c); },
      toggle(c, on) { const has = this.contains(c); const want = on === undefined ? !has : !!on; if (want !== has) (want ? this.add(c) : this.remove(c)); return want; },
    };
  }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.doc.documentElement || !!n.host && n.host.isConnected; }
  get textContent() { return this._text + this.childNodes.map(c => c.textContent).join(''); }
  set textContent(t) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this._text = String(t); }
  appendChild(c) { return this.insertBefore(c, null); }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  insertBefore(c, ref) {
    if (c.parentNode) c.remove();
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this; this.doc.mutations++;
    return c;
  }
  remove() { if (!this.parentNode) return; const p = this.parentNode; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; this.doc.mutations++; }
  replaceChildren(...cs) { [...this.childNodes].forEach(c => c.remove()); this.append(...cs); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  toggleAttribute(k, on) { if (on) this.attrs.set(k, ''); else this.attrs.delete(k); return !!on; }
  attachShadow() { const r = new FakeNode('#shadow', this.doc); r.host = this; r.adoptedStyleSheets = []; this.shadowRoot = r; return r; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  getBoundingClientRect() { return this.doc.rect || { left: 1200, top: 80, right: 1800, bottom: 400, width: 600, height: 320 }; }
  all() { return [this, ...this.childNodes.flatMap(c => c.all())]; }
  // eventos: los que registra la capa y un `fire` para las pruebas (devuelve el evento: se ve si se paró o se canceló)
  addEventListener(k, f) { (this.ls || (this.ls = {}))[k] = [...((this.ls || {})[k] || []), f]; }
  fire(k, o = {}) {
    const e = { type: k, pointerId: 1, button: 0, timeStamp: 0, stopped: false, prevented: false, ...o };
    e.stopPropagation = () => { e.stopped = true; }; e.preventDefault = () => { e.prevented = true; };
    for (const f of (this.ls && this.ls[k]) || []) f(e);
    return e;
  }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
}

function loadPage(src = SRC, prep = null) {
  const timers = [], frames = [], observers = [];
  let now = 0, seq = 0, frameMs = 16;
  const doc = { mutations: 0, fullscreenElement: null, listeners: {} };
  doc.documentElement = new FakeNode('html', doc);
  doc.body = new FakeNode('body', doc);
  doc.documentElement.appendChild(doc.body);
  doc.createElement = t => new FakeNode(t, doc);
  doc.createElementNS = (ns, t) => new FakeNode(t, doc);
  doc.addEventListener = (k, f) => { doc.listeners[k] = f; };
  const win = {
    document: doc, innerWidth: 1280, innerHeight: 720, performance: { now: () => now },
    matchMedia: () => ({ matches: false }), CSS: { supports: () => true },
    CSSStyleSheet: class { replaceSync(css) { this.css = css; } },
    addEventListener() {},
    MutationObserver: class { constructor(f) { this.f = f; this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } fire() { if (this.on) this.f([]); } },
    setTimeout: (f, ms) => { const id = ++seq; timers.push({ id, at: now + (ms || 0), f }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: f => { const id = ++seq; frames.push({ id, f }); return id; },
    cancelAnimationFrame: id => { const i = frames.findIndex(t => t.id === id); if (i >= 0) frames.splice(i, 1); },
  };
  win.window = win;
  if (prep) prep(win);
  vm.runInNewContext(src, win, { filename: 'tv-agent.js' });
  // avanza el reloj: timers por orden y un frame cada `frameMs` (16 ms, o lo que pida la prueba: un equipo lento)
  const advance = ms => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + frameMs);
      for (let t; (t = timers.filter(x => x.at <= now).sort((a, b) => a.at - b.at)[0]);) { timers.splice(timers.indexOf(t), 1); t.f(); }
      frames.splice(0).forEach(fr => fr.f(now));
    }
  };
  return { win, doc, advance, observers, setFrameMs: ms => { frameMs = ms; }, host: () => doc.body.childNodes.find(n => n.attrs && n.tagName === 'DIV') };
}

const snap = o => ({ form: 'panel', ctx: 'idle', state: 'talk', live: true, night: false, calm: false, glass: 'A', colors: null, icons: {},
  turns: [{ id: 1, you: '¿Qué tiempo hace mañana?', youFinal: true, jota: 'Mañana sol y veinticuatro grados. ', tools: [], error: false, hint: '' }], ...o });

test('carga: TVAgent con render/hide/_debug, sin dibujar nada hasta la primera foto, y no se reinyecta', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  assert.equal(typeof A.render, 'function'); assert.equal(typeof A.hide, 'function');
  assert.deepEqual({ ...A._debug() }, { open: false, tier: 'A', rafRunning: false, topLayer: false, form: '', morph: '', drag: false });
  assert.equal(p.doc.body.childNodes.length, 0);
  vm.runInNewContext(SRC, p.win);
  assert.equal(p.win.TVAgent, A, 'segunda inyección: no hace nada');
});

test('render: monta el host fijo, devuelve true, marca html.tv-agent-talk y la región accesible', () => {
  const p = loadPage();
  assert.equal(p.win.TVAgent.render(snap()), true);
  const h = p.host();
  assert.ok(h && h.shadowRoot, 'host con shadow DOM');
  assert.match(h.style.cssText, /position:fixed;inset:0;z-index:2147483647;pointer-events:none/);
  assert.ok(p.doc.documentElement.classList.contains('tv-agent-talk'));
  assert.ok(h.shadowRoot.adoptedStyleSheets[0].css.includes('backdrop-filter'));
  const all = h.shadowRoot.all();
  assert.ok(all.some(n => n.getAttribute('role') === 'log' && n.getAttribute('aria-live') === 'polite'));
  assert.ok(all.some(n => n.getAttribute('role') === 'alert'));
  assert.ok(p.win.TVAgent._debug().open && p.win.TVAgent._debug().rafRunning);
});

test('la misma foto cada 100 ms no recrea nodos; las palabras salen de una en una a su ritmo', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap());
  const words = () => p.host().shadowRoot.all().filter(n => n.className.split(' ').includes('wd'));
  p.advance(400);
  const first = words()[0];
  assert.ok(first, 'la primera palabra ya está');
  const n1 = words().length;
  for (let i = 0; i < 5; i++) { A.render(snap()); p.advance(100); }
  assert.strictEqual(words()[0], first, 'el mismo nodo: su animación de entrada no se reinicia');
  assert.ok(words().length > n1, 'siguen saliendo palabras');
  // tu frase entera (4) + la respuesta (5) con live:false: la cola se vacía en ≤ 1,2 s
  A.render(snap({ live: false, state: 'done' }));
  p.advance(1250);
  assert.equal(words().length, 4 + 5);
  const before = p.doc.mutations;
  A.render(snap({ live: false, state: 'done' })); p.advance(100);
  assert.equal(p.doc.mutations, before, 'sin cambios en el DOM con la misma foto');
});

test('fichas: se crean una vez por tool.id y solo cambia su estado (giro → check)', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const tool = st => ({ id: 'c1', kind: 'web', title: 'Abrir en la tele', detail: 'cocina.example', status: st });
  const icons = { web: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18' }], ['script', { src: 'x' }], ['path', { onload: 'x', d: 'M1 1' }]] };
  A.render(snap({ state: 'think', icons, turns: [{ ...snap().turns[0], jota: '', tools: [tool('run')] }] }));
  const card = () => p.host().shadowRoot.all().find(n => n.className === 'tc');
  const c = card();
  assert.ok(c.all().some(n => n.className === 'spin'));
  const svgEls = c.all().filter(n => ['CIRCLE', 'PATH', 'SCRIPT'].includes(n.tagName));
  assert.deepEqual(svgEls.map(n => n.tagName), ['CIRCLE', 'PATH', 'PATH'], 'solo primitivas permitidas');
  assert.ok(!svgEls.some(n => n.hasAttribute('onload')), 'sin atributos fuera de la lista');
  A.render(snap({ icons, turns: [{ ...snap().turns[0], tools: [tool('ok')] }] }));
  assert.strictEqual(card(), c, 'la misma ficha');
  assert.equal(c.dataset.status, 'ok');
  assert.ok(!c.all().some(n => n.className === 'spin'));
});

test('fallo: role=alert con el título y la pista; la respuesta final va al role=log una sola vez', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const t = { ...snap().turns[0], jota: 'No he podido.', hint: 'Di «otra vez» para reintentar.', tools: [{ id: 'h', kind: 'home', title: 'Luces del salón', detail: '', status: 'fail' }] };
  A.render(snap({ state: 'error', live: false, turns: [t] }));
  A.render(snap({ state: 'error', live: false, turns: [t] }));
  const all = p.host().shadowRoot.all();
  const alert = all.find(n => n.getAttribute('role') === 'alert');
  assert.match(alert.textContent, /Luces del salón.*otra vez/);
  const log = all.find(n => n.getAttribute('role') === 'log');
  assert.deepEqual(log.childNodes.map(n => n.textContent), ['Tú: ¿Qué tiempo hace mañana?', 'Jota: No he podido.']);
});

test('dos turnos como mucho; el que sale se quita y el actual no se mueve', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const t = (id, jota) => ({ id, you: 'hola', youFinal: true, jota, tools: [], error: false, hint: '' });
  A.render(snap({ turns: [t(1, 'uno. ')] }));
  A.render(snap({ turns: [t(1, 'uno. '), t(2, 'dos. ')] }));
  const log = () => p.host().shadowRoot.all().find(n => n.className.startsWith('log'));
  const second = log().childNodes[1];
  A.render(snap({ turns: [t(1, 'uno. '), t(2, 'dos. '), t(3, 'tres. ')] }));
  assert.equal(log().childNodes.length, 2);
  assert.strictEqual(log().childNodes[0], second);
});

test('hide(): quita la clase del reposo, funde, para el rAF y quita la capa; un render a tiempo la recupera', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap()); p.advance(200);
  A.hide();
  assert.ok(!p.doc.documentElement.classList.contains('tv-agent-talk'));
  assert.equal(A._debug().open, false);
  p.advance(100);
  A.render(snap()); // vuelve antes de quitarse: la misma capa
  assert.ok(p.host());
  A.hide();
  p.advance(2500);
  assert.equal(A._debug().rafRunning, false, 'rAF parado');
  assert.equal(p.host(), undefined, 'capa quitada');
});

test('calma: con la capa abierta y quieta el rAF también se para (y una foto nueva lo despierta)', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap({ calm: true, live: false, state: 'done' }));
  p.advance(3000);
  assert.equal(A._debug().rafRunning, false);
  A.render(snap({ calm: true, live: false, state: 'done', turns: [{ ...snap().turns[0], hint: 'algo' }] }));
  assert.equal(A._debug().rafRunning, true);
});

// ── Accesibilidad, cierre y fluidez (hallazgos de la revisión)
const findRole = (p, role) => p.host().shadowRoot.all().find(n => n.getAttribute('role') === role);
const failTurn = { id: 1, you: 'Enciende la luz', youFinal: true, jota: 'No he podido.', error: false, hint: 'Di «otra vez» para reintentar.',
  tools: [{ id: 'h', kind: 'home', title: 'Luces', detail: '', status: 'fail' }] };

test('al reabrir, el turno anterior no se vuelve a anunciar (ni su fallo por role=alert)', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap({ state: 'error', live: false, turns: [failTurn] }));
  A.hide(); p.advance(3000);
  assert.equal(p.host(), undefined, 'capa quitada');
  const t2 = { id: 2, you: 'Pon', youFinal: false, jota: '', tools: [], error: false, hint: '' };
  A.render(snap({ state: 'listen', live: true, turns: [failTurn, t2] }));
  assert.equal(findRole(p, 'alert').textContent, '', 'sin el fallo viejo');
  assert.deepEqual(findRole(p, 'log').childNodes.map(n => n.textContent), [], 'el turno anterior ya se anunció');
});

test('un turno nuevo en la misma capa limpia el aviso del fallo anterior', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap({ state: 'error', live: false, turns: [failTurn] }));
  assert.match(findRole(p, 'alert').textContent, /Luces/);
  A.render(snap({ state: 'listen', live: true, turns: [failTurn, { id: 2, you: '', youFinal: false, jota: '', tools: [], error: false, hint: '' }] }));
  assert.equal(findRole(p, 'alert').textContent, '');
});

test('fuera de calma, la capa abierta y quieta también para el rAF; escuchando sigue latiendo', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap({ live: false, state: 'done' }));
  p.advance(6000);
  assert.equal(A._debug().open, true);
  assert.equal(A._debug().rafRunning, false, 'asentada: sin rAF');
  A.render(snap({ live: false, state: 'done' }));
  assert.equal(A._debug().rafRunning, false, 'la misma foto no lo despierta');
  A.render(snap({ live: true, state: 'listen', turns: [{ ...snap().turns[0], jota: '', youFinal: false }] }));
  p.advance(6000);
  assert.equal(A._debug().rafRunning, true, 'escuchando: late');
});

test('hide() a mitad de turno (escuchando o pensando) termina por la vía normal, antes del temporizador de seguridad', () => {
  for (const state of ['listen', 'think']) {
    const p = loadPage();
    const A = p.win.TVAgent;
    A.render(snap({ state, live: true })); p.advance(1500);
    A.hide(); p.advance(1900);
    assert.equal(p.host(), undefined, `${state}: capa quitada al asentarse`);
  }
});

test('la respuesta en directo no encoge de letra a media lectura; un turno pasado sí usa la letra menor', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const t = jota => ({ ...snap().turns[0], jota });
  const jEl = () => p.host().shadowRoot.all().filter(n => n.tagName === 'P' && n.className.split(' ').includes('j'));
  A.render(snap({ turns: [t('a '.repeat(55))] }));
  assert.ok(!jEl()[0].className.includes('sm'));
  A.render(snap({ turns: [t('a '.repeat(65))] }));
  assert.ok(!jEl()[0].className.includes('sm'), 'mismo turno en directo: mismo tamaño');
  A.render(snap({ turns: [t('a '.repeat(65)), { ...snap().turns[0], id: 2, jota: '' }] }));
  assert.ok(jEl()[0].className.includes('sm'), 'ya es el anterior: letra menor');
});

test('el cristal no invade el área segura mientras crece (el muelle se pasa, la caja escrita no)', () => {
  const p = loadPage();
  // la caja del contenido pegada al borde seguro de 1280×720 (mx = 64, my = 43,2)
  p.doc.rect = { left: 829, top: 48, right: 1216, bottom: 389, width: 387, height: 341 };
  const A = p.win.TVAgent;
  A.render(snap());
  const body = p.host().shadowRoot.all().find(n => n.className.split(' ').includes('body'));
  let worst = 0;
  for (let i = 0; i < 150; i++) {
    p.advance(16);
    const l = parseFloat(body.style.left), t = parseFloat(body.style.top), w = parseFloat(body.style.width);
    worst = Math.max(worst, l + w - 1216, 43.2 - t);
  }
  assert.ok(worst <= 0.2, `se sale ${worst.toFixed(1)} px`);
});

test('capa superior: popover manual, se muestra al abrir y se vuelve a subir al cambiar la pantalla completa', () => {
  const p = loadPage();
  const calls = [];
  const mk = p.doc.createElement;
  p.doc.createElement = t => {
    const n = mk(t);
    let on = false;
    n.showPopover = () => { calls.push('show'); on = true; };
    n.hidePopover = () => { calls.push('hide'); on = false; };
    n.matches = q => q === ':popover-open' && on;
    return n;
  };
  const A = p.win.TVAgent;
  A.render(snap());
  assert.equal(p.host().popover, 'manual');
  assert.match(p.host().style.cssText, /margin:0/, 'sin los estilos de [popover] del navegador');
  assert.deepEqual(calls, ['show']);
  assert.equal(A._debug().topLayer, true);
  A.render(snap());
  assert.deepEqual(calls, ['show'], 'ya arriba: no se repite');
  p.doc.listeners.fullscreenchange();
  assert.deepEqual(calls, ['show', 'hide', 'show'], 'vuelve a entrar la última en la capa superior');
});

test('nivel C y noche sin backdrop-filter: la regla sale de LOOK.tiers (filter:false), no de nombres fijos', () => {
  // con el LOOK real y con uno en el que B tampoco filtra: la hoja sigue a LOOK (lo mismo que mira agent-contrast)
  const mutated = SRC.replace(/B: \{ blur: 20, sat: 1, filter: true \}/, 'B: { blur: 20, sat: 1, filter: false }');
  assert.notEqual(mutated, SRC);
  for (const src of [SRC, mutated]) {
    const p = loadPage(src);
    p.win.TVAgent.render(snap());
    const css = p.host().shadowRoot.adoptedStyleSheets[0].css;
    const rule = css.split('}').find(r => /backdrop-filter:none/.test(r));
    assert.ok(rule, 'hay regla sin backdrop-filter');
    for (const [k, v] of Object.entries(lookOf(src).tiers)) assert.equal(rule.includes(`[data-tier=${k}]`), !v.filter, `nivel ${k}`);
    assert.ok(rule.includes('[data-night]'));
  }
});

test("glass:'auto': el nivel medido entra al empezar el turno siguiente, no a media frase", () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const listen = id => snap({ glass: 'auto', state: 'listen', turns: [{ ...snap().turns[0], id, jota: '', youFinal: false }] });
  p.setFrameMs(30); // más de AUTO_TIER.b (24 ms) de media: nivel B
  A.render(listen(1)); p.advance(4000);
  assert.equal(A._debug().tier, 'A', 'medido, pero el turno sigue');
  A.render(listen(2));
  assert.equal(A._debug().tier, 'B');
});

test("glass:'auto': una medida a medias no se suma a la conversación siguiente", () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const listen = id => snap({ glass: 'auto', state: 'listen', turns: [{ ...snap().turns[0], id, jota: '', youFinal: false }] });
  p.setFrameMs(40);
  A.render(listen(1)); p.advance(50 * 40); // unos 50 frames lentos y se cierra antes de acabar la medida
  A.hide(); p.advance(3000);
  p.setFrameMs(16);
  A.render(listen(2)); p.advance(3000);
  A.render(listen(3));
  assert.equal(A._debug().tier, 'A', 'solo cuentan los frames de esta conversación');
});

test('ningún color de LOOK aparece copiado fuera de LOOK (en hex ni en r,g,b; blanco y negro aparte)', () => {
  const LOOK = lookOf(SRC);
  const rest = SRC.slice(SRC.indexOf('// @look:fin'));
  const hexes = new Set();
  (function walk(o) { for (const v of Object.values(o)) if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) hexes.add(v.toLowerCase()); else if (v && typeof v === 'object') walk(v); })(LOOK);
  const bad = [];
  for (const h of hexes) {
    if (h === '#ffffff' || h === '#000000') continue; // filos de luz y máscaras: blanco y negro no son de la paleta
    const rgb = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',\\s*');
    if (rest.toLowerCase().includes(h) || new RegExp(`\\(${rgb}\\b`).test(rest)) bad.push(h);
  }
  assert.deepEqual(bad, [], 'copias sueltas: ' + bad.join(', '));
});

// ── Lo que manda el servidor de verdad (snapshot de talk-view.js) en la capa de verdad
const view = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'talk-view.js'));
const { KINDS } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'agent-ui.js'));
const constOf = (src, name) => { const m = src.match(new RegExp(`const ${name} = ([^;\\n]+);`)); assert.ok(m, `${name} en el fuente`); return m[1].trim(); };
const VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'talk-view.js'), 'utf8');

test('servidor y página comparten los enumerados de la foto (src/tv/agent-contract.js), KEEP_TURNS y las fuentes', () => {
  const C = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'agent-contract.js'));
  const val = name => new Function('return ' + constOf(SRC, name))();
  assert.equal(Number(constOf(SRC, 'KEEP_TURNS')), view.KEEP_TURNS);
  assert.equal(constOf(SRC, 'COLOR_RE'), String(C.COLOR_RE));
  assert.deepEqual(val('FORMS'), [...C.FORMS]);
  assert.deepEqual(val('STATES'), [...C.STATES]);
  assert.deepEqual(val('ENTERS'), [...C.ENTERS]);
  assert.deepEqual(['auto', ...val('TIERS')], [...C.GLASS]);
  assert.deepEqual(Object.keys(lookOf(SRC).ctx).sort(), [...C.CTXS].sort(), 'contextos: los de LOOK.ctx');
  assert.equal(val('FONT_SERIF'), C.FONT_SERIF);
  assert.equal(val('FONT_SANS'), C.FONT_SANS);
  assert.ok(!/\bconst (FORMS|STATES|CTXS|GLASS|COLOR_RE) =/.test(VIEW_SRC), 'talk-view.js no lleva copias: las toma del módulo');
});

test('una foto real de snapshot() se pinta entera: turnos, fichas de cada tipo e iconos con todas sus primitivas', () => {
  const kinds = Object.keys(KINDS);
  const tools = kinds.map((k, i) => ({ id: 't' + i, kind: k, title: KINDS[k].title, detail: 'x', status: 'ok' }));
  const t = id => ({ id, you: 'hola', youFinal: true, jota: 'vale. ', tools: id === 2 ? tools : [], error: false, hint: '' });
  const s = view.snapshot({ form: 'panel', ctx: 'web', state: 'done', live: false,
    look: { ctx: 'web', night: false, calm: false, glass: 'B', colors: ['#2f7f8a', 'rgb(201, 138, 92)'] }, turns: [t(1), t(2)] });
  const p = loadPage();
  p.win.TVAgent.render(s);
  const all = p.host().shadowRoot.all();
  const w = all.find(n => n.className === 'w');
  assert.equal(w.dataset.tier, 'B'); assert.equal(w.dataset.ctx, 'web');
  assert.equal(w.style.getPropertyValue('--la'), '#2f7f8a', 'colores de la carátula aceptados');
  assert.equal(all.filter(n => n.className === 'tn').length, view.KEEP_TURNS);
  const cards = all.filter(n => n.className === 'tc');
  assert.equal(cards.length, kinds.length);
  cards.forEach((c, i) => {
    const svgEl = c.childNodes[0].childNodes[0];
    assert.equal(svgEl.childNodes.length, KINDS[kinds[i]].icon.length, `icono de ${kinds[i]} entero`);
  });
});

// ── Ronda 2: restaurar tras navegar, panel → píldora y fuentes propias
const cls = n => n.className.split(' ');
const byCls = (p, c) => p.host().shadowRoot.all().filter(n => cls(n).includes(c));

test("enter:'restore' en un documento nuevo: lo dicho a la vista de golpe, sin entradas (.sd), membrana ya en su caja y sin re-anunciar", () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const tools = [{ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', status: 'ok' }];
  const prev = { id: 1, you: 'Hola', youFinal: true, jota: 'Hola, Sito.', tools: [], error: false, hint: '' };
  const cur = { id: 2, you: 'Ponme esta serie', youFinal: true, jota: 'Ahí la tienes en Netflix.', tools, error: false, hint: '' };
  A.render(snap({ enter: 'restore', live: false, state: 'done', turns: [prev, cur] }));
  const words = byCls(p, 'wd');
  assert.equal(words.length, 1 + 2 + 3 + 5, 'todas las palabras ya están (sin revelado)');
  assert.ok(words.every(w => cls(w).includes('sd')), 'sin animación de palabra');
  assert.ok(byCls(p, 'tc').every(c => cls(c).includes('sd')), 'fichas sin brote');
  assert.ok(cls(byCls(p, 'hd')[0]).includes('sd') && cls(byCls(p, 'log')[0]).includes('sd'), 'contenido sin fundido de entrada');
  p.advance(16);
  const body = byCls(p, 'body')[0];
  assert.deepEqual([parseFloat(body.style.left), parseFloat(body.style.top), parseFloat(body.style.width)], [1200, 80, 600], 'la membrana nace en la caja, no desde el centro');
  assert.deepEqual(findRole(p, 'log').childNodes.map(n => n.textContent), [], 'lo ya dicho no se vuelve a anunciar');
  assert.equal(A._debug().form, 'panel');
});

test("enter:'restore' con la capa ya montada no cambia nada; las palabras nuevas entran como siempre", () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap()); p.advance(400);
  const n = byCls(p, 'wd').length;
  A.render(snap({ enter: 'restore' }));
  assert.equal(byCls(p, 'wd').length, n, 'no vacía la cola de golpe');
  p.advance(400);
  assert.ok(byCls(p, 'wd').slice(n).every(w => !cls(w).includes('sd')));
});

test('panel → píldora con la capa abierta: sale el contenido, cambia la forma, viaja y entra (fases y tiempos de MORPH)', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const t = { ...snap().turns[0], tools: [{ id: 'n', kind: 'video', title: 'Abrir en la tele', detail: 'Netflix', status: 'ok' }] };
  A.render(snap({ live: false, state: 'done', turns: [t] })); p.advance(500);
  A.render(snap({ form: 'pill', live: false, state: 'done', turns: [t] }));
  const w = p.host().shadowRoot.all().find(n => n.className === 'w');
  assert.deepEqual([A._debug().form, A._debug().morph, w.dataset.morph], ['panel', 'out', 'out'], 'primero sale el contenido, aún en el panel');
  A.render(snap({ form: 'pill', live: false, state: 'done', turns: [t] }));
  assert.equal(A._debug().form, 'panel', 'las fotos repetidas no adelantan el paso');
  p.advance(260);
  assert.deepEqual([A._debug().form, A._debug().morph], ['pill', 'travel']);
  assert.ok(byCls(p, 'tc')[0].hasAttribute('data-d'), 'la ficha marca que tiene detalle (en la píldora dice «Netflix»)');
  p.advance(900 - 300);
  assert.equal(A._debug().morph, 'in', 'entra solapada al final del viaje');
  assert.equal(w.dataset.morph, undefined);
  p.advance(320);
  assert.equal(A._debug().morph, '');
  A.render(snap({ form: 'panel', state: 'listen', turns: [t, { ...snap().turns[0], id: 2, jota: '' }] }));
  assert.deepEqual([A._debug().form, A._debug().morph], ['pill', 'out'], 'de vuelta (ronda 3): también con paso');
  p.advance(260);
  assert.deepEqual([A._debug().form, A._debug().morph], ['panel', 'travel']);
  p.advance(1000);
  assert.deepEqual([A._debug().form, A._debug().morph], ['panel', '']);
});

test('panel → píldora: cerrar a mitad del paso lo termina y la capa se quita igual', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap({ live: false, state: 'done' })); p.advance(300);
  A.render(snap({ form: 'pill', live: false, state: 'done' })); p.advance(100);
  A.hide();
  assert.equal(A._debug().morph, '');
  p.advance(2500);
  assert.equal(p.host(), undefined);
});

test('sin documentElement (script de documento nuevo): espera a que exista y pinta la última foto que llegó', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const html = p.doc.documentElement;
  html.remove(); p.doc.documentElement = null; p.doc.body = null;
  assert.equal(A.render(snap({ enter: 'restore' })), true);
  A.render(snap({ enter: 'restore', turns: [{ ...snap().turns[0], jota: 'Otra cosa. ' }] }));
  assert.equal(p.observers.length, 1, 'un solo observador');
  p.doc.documentElement = html;
  p.observers[0].fire();
  const h = html.childNodes.find(n => n.tagName === 'DIV');
  assert.ok(h && h.shadowRoot, 'montada en <html> en cuanto existe');
  assert.match(h.shadowRoot.all().filter(n => cls(n).includes('j'))[0].textContent, /Otra/);
  assert.equal(p.observers[0].on, false, 'deja de observar');
});

test('fuentes: __TV_FONTS se registra una vez con FontFace desde los bytes, con el nombre propio de la capa', () => {
  const faces = [];
  const p = loadPage('var __TV_FONTS=[{family:"TV Fraunces",weight:"100 900",data:"AAEC"},{family:7}];\n' + SRC, win => {
    win.atob = b => Buffer.from(b, 'base64').toString('binary');
    win.FontFace = class { constructor(f, buf, d) { Object.assign(this, { family: f, bytes: [...buf], d }); } load() { return Promise.resolve(this); } };
    win.document.fonts = { add: f => faces.push(f) };
  });
  assert.equal(faces.length, 1, 'la mal formada se ignora');
  assert.deepEqual([faces[0].family, faces[0].bytes, faces[0].d.weight], ['TV Fraunces', [0, 1, 2], '100 900']);
  p.win.TVAgent.render(snap());
  const css = p.host().shadowRoot.adoptedStyleSheets[0].css;
  assert.match(css, /--tv-serif:"TV Fraunces","Fraunces",Georgia,serif/);
  assert.match(css, /--tv-sans:"TV Inter",system-ui/, 'misma reserva de palo seco en todas partes (sin «Inter» suelta)');
});

// ── Ronda 3: arrastre con el puntero de la tele (solo la membrana) y aviso al servidor por el binding
test('solo la membrana (.body) recibe el puntero: el host y el resto de la capa no capturan nada; cerrándose, tampoco ella', () => {
  const p = loadPage();
  p.win.TVAgent.render(snap());
  const css = p.host().shadowRoot.adoptedStyleSheets[0].css;
  assert.match(p.host().style.cssText, /pointer-events:none/);
  const autos = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^}]*pointer-events:auto/g)].map(m => m[1].trim());
  assert.deepEqual(autos, ['.body'], 'pointer-events:auto solo en .body');
  assert.match(css, /\.body\.off,\.w\[data-pass\] \.body\{pointer-events:none\}/);
  assert.equal(constOf(SRC, 'FORM_BINDING'), JSON.stringify(require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'agent-contract.js')).FORM_BINDING).replace(/"/g, "'"));
});

// cajas del contenido en 1280×720 (área segura: 64 × 48 px): la píldora arriba en el centro y el panel a la derecha
const BOX = { pill: { left: 340, top: 48, right: 940, bottom: 160, width: 600, height: 112 },
  panel: { left: 829, top: 48, right: 1216, bottom: 389, width: 387, height: 341 } };
/** Capa abierta con la forma dada, asentada, y la función del binding que guarda lo que se le diga. */
function dragRig(form) {
  const told = [];
  const p = loadPage(SRC, win => { win.__tvAgentForm = f => told.push(f); });
  p.doc.rect = BOX[form];
  const A = p.win.TVAgent;
  A.render(snap({ form, live: false, state: 'done' })); p.advance(800);
  return { p, A, told, body: byCls(p, 'body')[0], sheet: byCls(p, 'sheet')[0], w: p.host().shadowRoot.all().find(n => n.className === 'w') };
}

test('píldora arrastrada a la derecha: goma mientras se arrastra, al soltar pasa a panel (con paso) y avisa por el binding', () => {
  const { p, A, told, body, sheet, w } = dragRig('pill');
  assert.equal(A._debug().form, 'pill');
  const down = body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 1000 });
  assert.equal(body.captured, 1, 'captura el puntero');
  assert.ok(down.stopped, 'la web no ve el pointerdown');
  body.fire('pointermove', { clientX: 900, clientY: 110, timeStamp: 1200 });
  assert.equal(A._debug().drag, true);
  assert.ok(w.hasAttribute('data-drag'));
  const [tx, ty] = sheet.style.transform.match(/-?[\d.]+/g).map(Number);
  const U = Math.min(1280 / 1920, 720 / 1080);
  assert.ok(tx > 0 && tx < 300 && tx < 240 * U, `goma: ${tx} px por 300 de dedo, nunca más de DRAG.band`);
  assert.ok(ty > 0 && ty < 10);
  p.advance(32);
  const g = byCls(p, 'body')[0].style;
  assert.ok(Math.abs(parseFloat(g.left) - BOX.pill.left) < 1, 'la membrana sigue al contenido (la caja falsa no se mueve con el transform)');
  body.fire('pointerup', { clientX: 900, clientY: 110, timeStamp: 1220 });
  assert.notEqual(sheet.style.transform, '', 'el contenido sale desde donde lo soltó el dedo…');
  assert.deepEqual(told, ['panel']);
  assert.deepEqual([A._debug().drag, A._debug().morph], [false, 'out']);
  A.render(snap({ form: 'pill', live: false, state: 'done' }));   // foto vieja (el servidor aún no lo sabe)
  p.advance(260);
  assert.deepEqual([A._debug().form, A._debug().morph], ['panel', 'travel'], 'manda lo elegido hasta que la foto lo confirme');
  assert.equal(sheet.style.transform, '', '…y vuelve a su sitio ya oculto, al empezar el viaje');
  p.advance(1000);
  A.render(snap({ form: 'pill', live: false, state: 'done' }));
  assert.equal(A._debug().form, 'panel', 'aún dentro de DRAG.hold: sin vuelta atrás');
  A.render(snap({ form: 'panel', live: false, state: 'done' }));
  p.advance(2000);
  A.render(snap({ form: 'panel', live: false, state: 'done' }));
  assert.deepEqual([A._debug().form, A._debug().morph], ['panel', '']);
});

test('panel arrastrado hacia arriba (o hacia el centro) → píldora; un arrastre corto vuelve a su sitio y no avisa', () => {
  const a = dragRig('panel');
  a.body.fire('pointerdown', { clientX: 1500, clientY: 300, timeStamp: 0 });
  a.body.fire('pointermove', { clientX: 1490, clientY: 60, timeStamp: 400 });
  a.body.fire('pointerup', { clientX: 1490, clientY: 60, timeStamp: 420 });
  assert.deepEqual(a.told, ['pill']);
  assert.equal(a.A._debug().morph, 'out');
  const b = dragRig('panel');
  b.body.fire('pointerdown', { clientX: 1500, clientY: 300, timeStamp: 0 });
  b.body.fire('pointermove', { clientX: 1440, clientY: 290, timeStamp: 600 });
  assert.notEqual(b.sheet.style.transform, '');
  b.body.fire('pointerup', { clientX: 1440, clientY: 290, timeStamp: 620 });
  assert.deepEqual(b.told, []);
  assert.deepEqual([b.A._debug().form, b.A._debug().morph, b.sheet.style.transform], ['panel', '', '']);
  const c = dragRig('pill');                         // hacia la izquierda en la píldora: no hay destino
  c.body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 0 });
  c.body.fire('pointermove', { clientX: 200, clientY: 100, timeStamp: 300 });
  c.body.fire('pointerup', { clientX: 200, clientY: 100, timeStamp: 320 });
  assert.deepEqual(c.told, []);
  const d = dragRig('pill');                         // un gesto rápido corto también vale
  d.body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 0 });
  d.body.fire('pointermove', { clientX: 700, clientY: 100, timeStamp: 50 });
  d.body.fire('pointerup', { clientX: 700, clientY: 100, timeStamp: 60 });
  assert.deepEqual(d.told, ['panel']);
});

test('el arrastre no molesta a la web: eventos parados en la membrana, mousedown sin acción (no quita el foco); cancelado o cerrada, nada', () => {
  const { A, told, body } = dragRig('pill');
  for (const k of ['pointermove', 'pointerup', 'click', 'mouseup', 'wheel']) assert.ok(body.fire(k).stopped, k);
  const md = body.fire('mousedown');
  assert.ok(md.stopped && md.prevented, 'mousedown: ni sube a la web ni mueve el foco');
  body.fire('pointerdown', { clientX: 600, clientY: 100 });
  body.fire('pointermove', { clientX: 1000, clientY: 100, timeStamp: 100 });
  body.fire('pointercancel', { clientX: 1000, clientY: 100, timeStamp: 120 });
  assert.deepEqual(told, [], 'cancelado: vuelve sin cambiar');
  assert.equal(A._debug().drag, false);
  body.fire('pointerdown', { clientX: 600, clientY: 100 });
  body.fire('pointermove', { clientX: 1000, clientY: 100, timeStamp: 100 });
  A.hide();
  assert.equal(A._debug().drag, false, 'cerrar suelta el arrastre');
  body.fire('pointerup', { clientX: 1000, clientY: 100, timeStamp: 120 });
  body.fire('pointerdown', { clientX: 600, clientY: 100 });
  assert.deepEqual(told, []);
  assert.equal(A._debug().drag, false, 'cerrándose no empieza otro');
});

test('pass(): la membrana deja pasar el puntero mientras Jota pulsa por coordenadas (tv_click_at) y luego lo recupera', () => {
  const { A, w } = dragRig('pill');
  assert.equal(A.pass(true), true);
  assert.ok(w.hasAttribute('data-pass'));
  A.pass(false);
  assert.ok(!w.hasAttribute('data-pass'));
  assert.match(SRC, /\.w\[data-pass\] \.body\{pointer-events:none\}/);
});

test('goma dentro del área segura: el contenido nunca sale de ella arrastrando (panel arriba: no sube; píldora: ni a la derecha del todo)', () => {
  const U = Math.min(1280 / 1920, 720 / 1080), sx = 64, sy = 48;
  const a = dragRig('panel');
  a.body.fire('pointerdown', { clientX: 1000, clientY: 200, timeStamp: 0 });
  a.body.fire('pointermove', { clientX: 1000, clientY: -400, timeStamp: 300 });   // muy arriba (fuera de la pantalla)
  const [ax, ay] = a.sheet.style.transform.match(/-?[\d.]+/g).map(Number);
  assert.deepEqual([ax, ay], [0, 0], 'el panel ya está en el borde seguro de arriba: no se mueve hacia arriba');
  a.body.fire('pointermove', { clientX: 2000, clientY: 200, timeStamp: 400 });    // a la derecha: tampoco hay sitio
  assert.equal(Number(a.sheet.style.transform.match(/-?[\d.]+/)[0]), 0);
  a.body.fire('pointermove', { clientX: 200, clientY: 900, timeStamp: 500 });     // al centro y abajo: sí, con goma
  const [cx, cy] = a.sheet.style.transform.match(/-?[\d.]+/g).map(Number);
  assert.ok(cx < 0 && cx > -240 * U && cy > 0 && cy < 720 - sy - BOX.panel.bottom, `${cx}, ${cy}`);
  const b = dragRig('pill');
  b.body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 0 });
  b.body.fire('pointermove', { clientX: 5000, clientY: 100, timeStamp: 300 });
  const bx = Number(b.sheet.style.transform.match(/-?[\d.]+/)[0]);
  assert.ok(bx > 0 && BOX.pill.right + bx <= 1280 - sx, `la píldora se sale ${BOX.pill.right + bx - (1280 - sx)} px por la derecha`);
});

test('golpe rápido: se mide en la ventana de los últimos ms antes de soltar y con recorrido mínimo (DRAG.win, DRAG.flickMin)', () => {
  // deprisa, quieto 400 ms y suelta: no es un golpe (60 px < DRAG.swap)
  const a = dragRig('pill');
  a.body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 0 });
  for (let i = 1; i <= 4; i++) a.body.fire('pointermove', { clientX: 600 + 15 * i, clientY: 100, timeStamp: 8 * i });
  a.body.fire('pointerup', { clientX: 660, clientY: 100, timeStamp: 432 });
  assert.deepEqual([a.told, a.A._debug().form], [[], 'pill'], 'moverse deprisa, pararse y soltar no cambia');
  // un temblor al pulsar (7 px a los 5 ms): tampoco
  const b = dragRig('pill');
  b.body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 0 });
  b.body.fire('pointermove', { clientX: 607, clientY: 100, timeStamp: 5 });
  b.body.fire('pointerup', { clientX: 607, clientY: 100, timeStamp: 5 });
  assert.deepEqual(b.told, [], 'un temblor no es un golpe');
  // el mismo recorrido corto, pero soltando en marcha: sí
  const c = dragRig('pill');
  c.body.fire('pointerdown', { clientX: 600, clientY: 100, timeStamp: 0 });
  for (let i = 1; i <= 4; i++) c.body.fire('pointermove', { clientX: 600 + 15 * i, clientY: 100, timeStamp: 8 * i });
  c.body.fire('pointerup', { clientX: 668, clientY: 100, timeStamp: 40 });
  assert.deepEqual(c.told, ['panel']);
});

test("restore: el cristal nace ya visible (sin la clase off: no hay fundido que deje el texto un instante sin cristal); al abrir, sí funde", () => {
  const p = loadPage();
  p.win.TVAgent.render(snap({ enter: 'restore', live: false, state: 'done' }));
  assert.ok(!cls(byCls(p, 'body')[0]).includes('off') && !cls(byCls(p, 'halo')[0]).includes('off'));
  // al abrir normal nace con off y se le quita en la misma foto (la transición de opacidad es su entrada)
  const q = loadPage();
  const made = [];
  const mk = q.doc.createElement;
  q.doc.createElement = t => { const n = mk(t); made.push(n); return n; };
  q.win.TVAgent.render(snap());
  assert.ok(made.some(n => /\bbody\b/.test(n.className)), 'monta la membrana');
  assert.match(SRC, /const off = restoring \? '' : ' off';/);
  assert.match(SRC, /\.body\{transition:opacity [^}]*background-color/, 'el velo cambia de tinte con transición, no de golpe');
});

test('pantalla completa de un elemento: el host se mete dentro aunque esté en la capa superior (fuera, todo es inerte); un <video>, no', () => {
  const p = loadPage();
  const calls = [];
  const mk = p.doc.createElement;
  p.doc.createElement = t => {
    const n = mk(t);
    let on = false;
    n.showPopover = () => { calls.push('show'); on = true; };
    n.hidePopover = () => { calls.push('hide'); on = false; };
    n.matches = q => q === ':popover-open' && on;
    return n;
  };
  const A = p.win.TVAgent;
  A.render(snap());
  const h = p.host();
  const fs = p.doc.createElement('div');
  p.doc.body.appendChild(fs);
  p.doc.fullscreenElement = fs;
  p.doc.listeners.fullscreenchange();
  assert.equal(h.parentNode, fs, 'dentro del elemento a pantalla completa');
  assert.equal(A._debug().topLayer, true, 'y otra vez en la capa superior');
  p.doc.fullscreenElement = null;
  p.doc.listeners.fullscreenchange();
  assert.equal(h.parentNode, p.doc.body, 'al salir, otra vez en body');
  const v = p.doc.createElement('video');
  p.doc.body.appendChild(v);
  p.doc.fullscreenElement = v;
  p.doc.listeners.fullscreenchange();
  assert.equal(h.parentNode, p.doc.body, 'un <video> no pinta hijos: se queda en body');
});

test('el id del host es el de src/tv/agent-contract.js (talk-view.js lo salta al mirar si la página nueva ya se ve)', () => {
  const C = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'agent-contract.js'));
  assert.equal(constOf(SRC, 'HOST_ID'), `'${C.HOST_ID}'`);
  const p = loadPage();
  p.win.TVAgent.render(snap());
  assert.equal(p.host().id, C.HOST_ID);
});

// ── Netflix en su pestaña: volver a una pestaña con la capa de antes aún pintada, y dejarla
test("cambio de pestaña (restore + tab) con una capa vieja montada: se retira en seco y se restaura sin entradas ni revelado", () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap()); p.advance(400);                       // el panel viejo, con palabras aún por salir
  const old = p.host();
  const cur = { id: 2, you: 'Pon la serie', youFinal: true, jota: 'Vale, te dejo la serie a medias, vuelvo a lo de antes.', tools: [], error: false, hint: '' };
  A.render(snap({ form: 'pill', enter: 'restore', tab: true, live: true, turns: [snap().turns[0], cur] }));
  assert.notEqual(p.host(), old, 'el host viejo se quita');
  assert.ok(!old.isConnected);
  assert.equal(p.doc.body.childNodes.filter(n => n.attrs && n.tagName === 'DIV').length, 1, 'una sola capa');
  assert.deepEqual([A._debug().form, A._debug().morph], ['pill', ''], 'en la forma de ahora, sin paso desde la vieja');
  const words = byCls(p, 'wd');
  assert.equal(words.length, 4 + 5 + 3 + 12, 'lo dicho, a la vista de golpe (sin revelado)');
  assert.ok(words.every(w => cls(w).includes('sd')), 'sin animación de palabra');
  assert.ok(cls(byCls(p, 'body')[0]).every(c => c !== 'off'), 'el cristal ya está (sin fundido de entrada)');
  assert.deepEqual(findRole(p, 'log').childNodes.map(n => n.textContent), [], 'no se vuelve a anunciar');
  // la foto siguiente (ya la de esta pestaña) no la rehace
  const h = p.host();
  A.render(snap({ form: 'pill', ctx: 'web', turns: [snap().turns[0], cur] }));
  assert.equal(p.host(), h);
});

test('hide(true): la capa se quita en seco (la pestaña que se deja), sin fundido', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  A.render(snap()); p.advance(300);
  A.hide(true);
  assert.equal(p.host(), undefined, 'fuera al momento');
  assert.equal(A._debug().open, false);
  assert.equal(p.doc.documentElement.classList.contains('tv-agent-talk'), false);
  A.render(snap({ enter: 'restore' }));                    // al volver: restaurada de cero
  assert.ok(byCls(p, 'wd').every(w => cls(w).includes('sd')));
});

test("cambio de pestaña con `shown`: restaura las palabras que se veían en la otra (sin entrada) y revela el resto como siempre; revealed() las cuenta", () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  assert.equal(A.revealed(), null, 'sin capa');
  const cur = { id: 2, you: 'Pon la serie', youFinal: true, jota: 'Vale, te dejo la serie a medias. ', tools: [], error: false, hint: '' };
  A.render(snap({ enter: 'restore', tab: true, live: true, turns: [snap().turns[0], cur], shown: { 2: [3, 2] } }));
  const words = () => byCls(p, 'wd');
  assert.equal(words().length, 4 + 5 + 3 + 2, 'el turno anterior entero; del actual, lo que se veía');
  assert.ok(words().every(w => cls(w).includes('sd')));
  assert.deepEqual({ ...A.revealed() }, { 1: [4, 5], 2: [3, 2] });
  p.advance(3000);
  assert.equal(words().length, 4 + 5 + 3 + 7, 'el resto sale');
  assert.ok(words().slice(-5).every(w => !cls(w).includes('sd')), 'con su entrada (en esta pestaña son nuevas)');
});

test('restaurada, una foto que llega antes de su primer frame espera a ese frame (nace en su caja); el motor sigue con un solo rAF', () => {
  let pending = 0;
  const p = loadPage(SRC, win => {
    const raf = win.requestAnimationFrame;
    win.requestAnimationFrame = f => { pending++; return raf(t => { pending--; f(t); }); };
  });
  const A = p.win.TVAgent;
  A.render(snap({ enter: 'restore', ctx: 'idle', live: false, state: 'done' }));
  const w = byCls(p, 'w')[0];
  A.render(snap({ ctx: 'web', live: false, state: 'done' }));   // documento lento: aún no ha corrido ningún frame
  assert.equal(w.dataset.ctx, 'idle', 'la foto nueva espera al primer frame');
  p.advance(16);
  assert.equal(w.dataset.ctx, 'web', 'tras el primer frame (ya en su caja), la foto nueva');
  for (let i = 0; i < 20; i++) { p.advance(16); assert.ok(pending <= 1, `un solo rAF del motor pendiente (frame ${i}: ${pending})`); }
});

test('tarjeta de Netflix: lista o «poner» con su ▶; pulsarlo no rehace la tarjeta', () => {
  const p = loadPage();
  const A = p.win.TVAgent;
  const play = { key: 'nfx-play-1', kind: 'play', state: 'idle', items: [{ title: 'La serie', sub: 'T1 · E2', left: 'quedan 20 min', frac: 0.3, img: 'http://127.0.0.1:8787/idle/nfx?u=a', still: 'http://127.0.0.1:8787/idle/nfx?u=b' }] };
  const t1 = { id: 1, you: 'Pon la serie', youFinal: true, jota: 'Vale. ', tools: [], error: false, hint: '', media: play };
  A.render(snap({ turns: [t1] }));
  const root = p.host().shadowRoot;
  const find = (n, cls) => { if (n.className && n.className.split(' ').includes(cls)) return n; for (const c of n.childNodes || []) { const r = find(c, cls); if (r) return r; } return null; };
  const md = find(root, 'md'), card = find(root, 'mp');
  assert.ok(card && find(card, 'mplay') && find(card, 'ms'), 'imagen, fotograma del capítulo y ▶');
  assert.equal(find(card, 'mt').textContent, 'La serie');
  A.render(snap({ turns: [{ ...t1, media: { ...play, state: 'press' } }] }));
  assert.equal(find(root, 'mp'), card, 'el ▶ no rehace la tarjeta');
  assert.ok(md.attrs.has('data-press') || md.hasAttribute?.('data-press'), 'se pulsa');
  // lista: una fila por título
  const list = { key: 'nfx-list-1', kind: 'list', state: 'idle', items: [1, 2, 3].map(i => ({ title: 'Serie ' + i, sub: 'T1 · E' + i, frac: 0.1 * i, img: '' }))};
  A.render(snap({ turns: [{ ...t1, id: 2, media: list }] }));
  const ml = find(root, 'ml');
  assert.equal(ml.childNodes.length, 3);
  // sin tarjeta, nada
  A.render(snap({ turns: [{ ...t1, id: 3, media: null }] }));
  assert.equal(find(root, 'mp'), null); assert.equal(find(root, 'ml'), null);
});
