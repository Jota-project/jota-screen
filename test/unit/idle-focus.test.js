'use strict';
// Foco del inicio (remote/public/shared/focus.js): a qué widget salta el foco con cada flecha.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nextFocus } = require(path.join(__dirname, '..', '..', 'remote', 'public', 'shared', 'focus.js'));

test('nextFocus: sin vecino en esa dirección se queda; si no, el más cercano (el eje cruzado pesa el doble)', () => {
  assert.equal(nextFocus([], 0, 'right'), 0, 'sin widgets');
  assert.equal(nextFocus([{ x: 100, y: 100 }], 0, 'left'), 0, 'uno solo');
  const two = [{ x: 400, y: 800 }, { x: 1500, y: 900 }];        // tarjeta abajo a la izquierda, música a la derecha
  assert.equal(nextFocus(two, 0, 'right'), 1);
  assert.equal(nextFocus(two, 1, 'left'), 0);
  assert.equal(nextFocus(two, 0, 'left'), 0, 'no hay nada a la izquierda');
  assert.equal(nextFocus(two, 0, 'down'), 1, 'la música está algo más abajo');
  const three = [{ x: 500, y: 500 }, { x: 900, y: 520 }, { x: 700, y: 100 }];
  assert.equal(nextFocus(three, 0, 'right'), 1, 'el de su fila antes que el de arriba');
  assert.equal(nextFocus(three, 0, 'up'), 2);
  assert.equal(nextFocus(three, 2, 'down'), 0, 'empate de distancia: el primero');
});
