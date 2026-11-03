'use strict';
// Unitarias de la inercia del trackpad del mando (remote/public/mando/features/trackpad.js), de la auditoría del scroll
// (TVC Auditoría - Scroll del mando): tocar para frenar no hace clic, parar y soltar no lanza la página, la inercia sale
// a la velocidad de la página y el dedo que queda de un gesto de dos no mueve el cursor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const PUB = path.join(__dirname, '..', '..', 'remote', 'public');

/** Navegador mínimo: WebSocket falso, fotogramas a mano y un trackpad de 300×400 sin carril. */
function fakes() {
  const g = globalThis, saved = {};
  const keys = ['WebSocket', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'navigator', 'performance'];
  for (const k of keys) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  let now = 1000, frames = [];
  const sockets = [];
  class WS {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(s); }
    close() { this.readyState = 3; }
  }
  const node = () => {
    const c = new Set();
    return { hidden: false, style: {}, h: {}, classList: { add: k => c.add(k), remove: k => c.delete(k), contains: k => c.has(k), toggle() {} },
      addEventListener(t, f) { this.h[t] = f; }, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, height: 300 }) };
  };
  const els = {};
  const doc = { hidden: false, addEventListener() {}, querySelector: s => (els[s] ||= node()) };
  const def = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  def('WebSocket', WS); def('document', doc); def('location', { protocol: 'http:', host: 'mando' });
  def('performance', { now: () => now });
  def('requestAnimationFrame', f => frames.push(f));
  def('cancelAnimationFrame', id => { frames[id - 1] = null; });
  def('localStorage', { getItem: () => null, setItem() {} }); def('navigator', {});
  /** avanza `ms` y corre los fotogramas pendientes */
  const frame = (ms = 16) => { now += ms; const run = frames; frames = []; for (const f of run) if (f) f(now); };
  const restore = () => { for (const k of keys) { const d = saved[k]; if (d) Object.defineProperty(g, k, d); else delete g[k]; } };
  els['#rail'] = node(); els['#rail'].classList.add('off');   // sin dato de scroll: sin carril, como en index.html
  return { sockets, frame, restore, pad: () => els['#pad'], thumb: () => els['#railT'], at: () => now, tick: ms => { now += ms; } };
}

async function setup() {
  const f = fakes();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-pad-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const api = await import(pathToFileURL(path.join(tmp, 'mando', 'core', 'api.js')).href);
  const { cfg } = await import(pathToFileURL(path.join(tmp, 'mando', 'core', 'store.js')).href);
  Object.assign(cfg, { speed: 1.6, scroll: 1, natural: true, haptic: false });   // los de store.js (los pone app.js al arrancar)
  const { trackpad, paintRail } = await import(pathToFileURL(path.join(tmp, 'mando', 'features', 'trackpad.js')).href);
  await api.connect(); const ws = f.sockets[0]; ws.readyState = 1; ws.onopen(); ws.onmessage({ data: "p" + f.at() });   // eco del sondeo: si no, send() calla
  trackpad.init();
  const h = f.pad().h;
  const ev = (type, id, x, y) => ({ type, pointerId: id, clientX: x, clientY: y, timeStamp: f.at(), preventDefault() {} });
  const down = (id, x, y) => h.pointerdown(ev('pointerdown', id, x, y));
  const move = (id, x, y) => h.pointermove(ev('pointermove', id, x, y));
  const up = (id, x, y) => h.pointerup(ev('pointerup', id, x, y));
  /** dos dedos bajan `d` px (10 por defecto) cada 16 ms, `n` veces; acaban en y0 + d·n */
  const swipe2 = (n, d = 10) => {
    down(1, 100, 100); down(2, 160, 100);
    for (let i = 1; i <= n; i++) { f.tick(16); move(1, 100, 100 + d * i); move(2, 160, 100 + d * i); f.frame(0); }
    return 100 + d * n;
  };
  const sent = () => { const s = ws.sent.slice(); ws.sent.length = 0; return s; };
  const wheel = s => s.filter(m => m.startsWith('w ')).map(m => +m.split(' ')[2]);
  return { f, tmp, down, move, up, swipe2, sent, wheel, paintRail };
}

test('mando trackpad: tocar para frenar la inercia no hace clic', async () => {
  const t = await setup();
  try {
    const y = t.swipe2(8); t.up(1, 100, y); t.up(2, 160, y);
    t.f.frame(); t.f.frame();
    assert.ok(t.wheel(t.sent()).length > 0, 'la inercia está en marcha');
    t.f.tick(16); t.down(3, 150, 200); t.f.tick(60); t.up(3, 150, 200); t.f.frame();
    assert.ok(!t.sent().includes('c 1'), 'el toque solo frena');
    t.f.tick(500); t.down(4, 150, 200); t.f.tick(60); t.up(4, 150, 200);
    assert.ok(t.sent().includes('c 1'), 'sin inercia, un toque sigue siendo clic');
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: parar y soltar no lanza la página', async () => {
  const t = await setup();
  try {
    const y = t.swipe2(8, 30); t.sent();   // deprisa: sin el arreglo, la velocidad vieja sí lanzaría la página
    t.f.tick(200); t.up(1, 100, y); t.up(2, 160, y);
    for (let i = 0; i < 5; i++) t.f.frame();
    assert.deepEqual(t.wheel(t.sent()), []);
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: la inercia sale a la velocidad de la página', async () => {
  const t = await setup();
  try {
    const y = t.swipe2(8);
    const drag = t.wheel(t.sent());                      // por fotograma de arrastre: 10 px de dedo, sentido natural
    assert.equal(drag.at(-1), -10);
    t.up(1, 100, y); t.up(2, 160, y);
    t.f.frame(16); t.f.frame(0);                          // primer paso de 16 ms y su envío
    const first = t.wheel(t.sent())[0];
    assert.ok(first < -8 && first >= -10, `primer paso ${first}: casi los 10 px del arrastre, no la mitad`);
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: el dedo que queda de un gesto de dos no mueve el cursor', async () => {
  const t = await setup();
  try {
    const y = t.swipe2(4); t.up(2, 160, y); t.sent();
    for (let i = 1; i <= 4; i++) { t.f.tick(16); t.move(1, 100 + 20 * i, y); t.f.frame(0); }
    assert.ok(!t.sent().some(m => m.startsWith('m ')), 'sin orden de cursor');
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: en la franja del carril, en horizontal es el cursor y en vertical desplaza', async () => {
  const t = await setup();
  try {
    t.paintRail({ pos: 0.5, size: 0.3 });                // carril a la vista: la franja son los 44 px de la derecha
    t.down(1, 280, 200);
    for (let i = 1; i <= 4; i++) { t.f.tick(16); t.move(1, 280 - 5 * i, 201); t.f.frame(0); }
    let s = t.sent();
    assert.ok(s.some(m => m.startsWith('m ')) && !s.some(m => m.startsWith('w ')), 'horizontal: cursor, sin rueda');
    t.up(1, 260, 201); t.sent();
    t.f.tick(500); t.down(2, 280, 200);
    for (let i = 1; i <= 4; i++) { t.f.tick(16); t.move(2, 281, 200 + 5 * i); t.f.frame(0); }
    s = t.sent();
    assert.ok(s.some(m => m.startsWith('w ')) && !s.some(m => m.startsWith('m ')), 'vertical: rueda, sin cursor');
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: en el extremo, el pulgar se aplasta mientras el dedo empuja y vuelve al soltar', async () => {
  const t = await setup();
  try {
    t.paintRail({ pos: 1, size: 0.5 });                  // ya abajo del todo
    t.down(1, 280, 100);
    for (let i = 1; i <= 6; i++) { t.f.tick(16); t.move(1, 280, 100 + 10 * i); t.f.frame(0); }
    const tr = t.f.thumb().style.transform, s = +/scaleY\(([\d.]+)\)/.exec(tr)[1];
    assert.ok(s < 1 && s >= 0.85, `aplastado sin pasar del 85 %: ${tr}`);
    assert.equal(t.f.thumb().style.transformOrigin, '50% 100%');
    t.up(1, 280, 160);
    assert.ok(!/scaleY/.test(t.f.thumb().style.transform), 'al soltar vuelve');
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: con el recorrido de la página, el pulgar sigue a lo enviado sin esperar a la tele', async () => {
  const t = await setup();
  try {
    t.paintRail({ pos: 0.5, size: 0.5, max: 1200 });     // translateY = 0,5·0,5/0,5·100 = 50 %
    assert.match(t.f.thumb().style.transform, /translateY\(50\.00%\)/);
    t.down(1, 280, 100);
    for (let i = 1; i <= 4; i++) { t.f.tick(100); t.move(1, 280, 100 + 15 * i); t.f.frame(0); }   // despacio: sin aceleración
    const y = +/translateY\(([\d.]+)%\)/.exec(t.f.thumb().style.transform)[1];
    // el primer movimiento ya arma (15 > 10 px): 60 px de dedo a 0,15 px/ms, con la aceleración del carril (1 + 0,15/1,1),
    // por 4 px de página por px de dedo, sobre 1.200 px de recorrido: pos 0,5 + 0,227 → translateY 72,7 %
    const want = (0.5 + 60 * (1 + 0.15 / 1.1) * 4 / 1200) * 100;
    assert.ok(Math.abs(y - want) < 0.5, `pulgar estimado en ${y} %, se esperaba ${want.toFixed(1)} %`);
    t.paintRail({ pos: 0.52, size: 0.5, max: 1200 });    // llega un dato viejo de la tele: no tira el pulgar hacia atrás
    assert.match(t.f.thumb().style.transform, new RegExp('translateY\\(' + y.toFixed(2) + '%\\)'));
    t.up(1, 280, 160);
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('mando trackpad: la inercia se corta a 0,2 px/ms, antes de que la rueda vaya a pulsos', async () => {
  const t = await setup();
  try {
    const y = t.swipe2(8); t.up(1, 100, y); t.up(2, 160, y); t.sent();
    const w = [];
    for (let i = 0; i < 120; i++) { t.f.frame(16); w.push(...t.wheel(t.sent())); }
    assert.ok(w.length > 5, 'hubo inercia');
    assert.ok(Math.abs(w.at(-1)) >= 0.2 * 16 * 0.95, `último paso ${w.at(-1)} px: no baja de 0,2 px/ms`);
  } finally { t.f.restore(); fs.rmSync(t.tmp, { recursive: true, force: true }); }
});
