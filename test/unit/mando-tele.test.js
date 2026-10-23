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
