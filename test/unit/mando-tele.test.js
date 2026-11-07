'use strict';
// Unitarias del modo Tele del mando (remote/public/mando/features/tele.js): el gesto del trackpad hecho cruceta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const PUB = path.join(__dirname, '..', '..', 'remote', 'public');

test('mando tele: swipeDir: menos de 18 px es OK; si no, gana el eje mayor', async () => {
  // copia como paquete ESM (remote/ es CommonJS), como en mando.test.js
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-tele-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  try {
    const { swipeDir } = await import(pathToFileURL(path.join(tmp, 'mando', 'features', 'tele.js')).href);
    assert.equal(swipeDir(0, 5), 'ok');
    assert.equal(swipeDir(12, -12), 'ok', '17 px en diagonal');
    assert.equal(swipeDir(40, 10), 'right');
    assert.equal(swipeDir(-3, -60), 'up');
    assert.equal(swipeDir(-50, 20), 'left');
    assert.equal(swipeDir(5, 30), 'down');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mando tele: arrowAt: un toque sobre una flecha dibujada (con 20 px de margen) es esa flecha; fuera, null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mando-tele-'));
  fs.cpSync(path.join(PUB, 'mando'), path.join(tmp, 'mando'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  try {
    const { arrowAt } = await import(pathToFileURL(path.join(tmp, 'mando', 'features', 'tele.js')).href);
    const box = (l, t) => ({ left: l, top: t, right: l + 30, bottom: t + 30 });
    const B = { up: box(135, 22), down: box(135, 348), left: box(18, 185), right: box(252, 185) };   // pad de 300 x 400
    assert.equal(arrowAt(150, 37, B), 'up', 'en el centro de la flecha');
    assert.equal(arrowAt(150, 5, B), 'up', 'dentro del margen');
    assert.equal(arrowAt(10, 200, B), 'left');
    assert.equal(arrowAt(290, 200, B), 'right');
    assert.equal(arrowAt(150, 360, B), 'down');
    assert.equal(arrowAt(150, 200, B), null, 'el centro es OK');
    assert.equal(arrowAt(150, 80, B), null, 'pasado el margen');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
