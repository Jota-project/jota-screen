'use strict';
// Acceso de admin de un solo uso y bloqueo por intentos fallidos (cada caso con su propio servidor:
// el bloqueo es por IP y todas las pruebas llegan desde 127.0.0.1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server');

const cmd = (s, body) => s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('el enlace de admin de un solo uso funciona una vez', async () => {
  const s = await start();
  try {
    const link = await (await cmd(s, { t: 'adminlink' })).json();
    assert.ok(link.code && link.url, JSON.stringify(link));
    assert.ok(!link.url.includes(s.token), 'el enlace no lleva el token maestro');
    const one = await s.post('/pair/admin', { code: link.code, name: 'Móvil' });
    assert.equal(one.status, 200);
    assert.equal((await one.json()).role, 'admin');
    assert.equal((await s.post('/pair/admin', { code: link.code, name: 'Otra vez' })).status, 403);
  } finally { await s.stop(); }
});

test('cinco intentos fallidos bloquean la IP un minuto (429), también con el token bueno', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.api('/api/state', 'f'.repeat(32))).status, 401);
    assert.equal((await s.api('/api/state')).status, 429);
    assert.equal((await s.post('/pair/admin', { code: 'X' })).status, 429);
  } finally { await s.stop(); }
});
