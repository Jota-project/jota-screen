'use strict';
// Color compartido del servidor (remote/src/core/color.js): HSL → #rrggbb con valores conocidos, y que el reposo
// (idle.js) y «ahora suena» (nowplaying.js) usan esta y no una copia suya.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'remote');
const { hslHex } = require(path.join(ROOT, 'src', 'core', 'color'));

test('hslHex: primarios, grises y extremos', () => {
  assert.equal(hslHex(0, 1, 0.5), '#ff0000');
  assert.equal(hslHex(120, 1, 0.5), '#00ff00');
  assert.equal(hslHex(240, 1, 0.5), '#0000ff');
  assert.equal(hslHex(60, 1, 0.5), '#ffff00');
  assert.equal(hslHex(0, 0, 0), '#000000');
  assert.equal(hslHex(0, 0, 1), '#ffffff');
  assert.equal(hslHex(0, 0, 0.5), '#808080', 'redondeo (127,5 → 128)');
  assert.equal(hslHex(200, 1, 0.02), '#00070a', 'canales de una cifra con su cero delante');
  assert.equal(hslHex(360, 0.7, 0.4), hslHex(0, 0.7, 0.4), '360° es 0°');
});

test('hslHex: siempre #rrggbb en minúsculas', () => {
  for (let h = 0; h < 360; h += 15) for (const s of [0, 0.35, 0.85, 1]) for (const l of [0, 0.16, 0.62, 1])
    assert.match(hslHex(h, s, l), /^#[0-9a-f]{6}$/, `${h} ${s} ${l}`);
});

test('idle.js y nowplaying.js usan src/core/color.js y no llevan su propia conversión', () => {
  for (const f of ['idle.js', 'nowplaying.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /const \{ hslHex \} = require\('\.\/src\/core\/color'\);/, f);
    assert.doesNotMatch(src, /\(n \+ h \/ 30\) % 12/, `${f} sin copia de la fórmula`);
  }
});
