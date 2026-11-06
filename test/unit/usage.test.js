'use strict';
// Registro de uso local (remote/src/features/usage.js): lo que estuvo en pantalla, 90 días, sin salir de la máquina.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const createUsage = require(path.join(__dirname, '..', '..', 'remote', 'src', 'features', 'usage'));

test('usage: apunta, junta la repetición seguida, poda a 90 días y respeta el interruptor', () => {
  let T = 100 * 864e5, on = true, saved = [];
  const u = createUsage({ store: { load: () => [], save: v => { saved = v; } }, now: () => T, enabled: () => on });
  u.add({ src: 'web', title: 'example.com', url: 'https://example.com/' });
  T += 60e3; u.add({ src: 'web', title: 'example.com', url: 'https://example.com/' });
  assert.equal(u.list().length, 1, 'la misma seguida: solo se actualiza la hora');
  assert.equal(u.list()[0].at, T);
  u.add({ src: 'netflix', title: 'Dark', url: 'https://www.netflix.com/watch/22' });
  assert.deepEqual(u.list().map(e => e.src), ['netflix', 'web']);
  T += 91 * 864e5; u.add({ src: 'spotify', title: 'Jazz' });
  assert.deepEqual(u.list().map(e => e.src), ['spotify'], 'lo de hace más de 90 días, fuera');
  on = false; u.add({ src: 'web', title: 'x' });
  assert.equal(u.list().length, 1, 'apagado: no apunta');
  assert.equal(saved.length, 1);
});

test('usage: recorta título y url a 200 y guarda solo src, title, url, at', () => {
  let saved = [];
  const u = createUsage({ store: { load: () => [], save: v => { saved = v; } }, now: () => 5, enabled: () => true });
  u.add({ src: 'web', title: 'x'.repeat(300), url: 'https://a/' + 'y'.repeat(300), extra: 1 });
  assert.equal(saved[0].title.length, 200);
  assert.equal(saved[0].url.length, 200);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['at', 'src', 'title', 'url']);
});
