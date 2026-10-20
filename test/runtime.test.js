'use strict';
// Producto replicable: el servidor arranca sin configuración personal (estado en TV_STATE_DIR, sin
// tiempo si no hay ubicación), toma la ubicación del entorno y trae el estado de las ubicaciones antiguas.
// Las peticiones a Open-Meteo las intercepta test/helpers/fetch-spy.js: nunca se sale a internet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./helpers/server');

const SPY = { NODE_OPTIONS: '--require ' + path.join(__dirname, 'helpers', 'fetch-spy.js') };
const cmd = async (s, body) => (await s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { const v = await fn(); if (v) return v; }
  return fn();
}

test('sin configuración: estado privado en TV_STATE_DIR y el reposo sin tiempo (no lo pide)', async () => {
  const s = await start({ env: SPY });
  try {
    assert.equal(fs.statSync(s.state).mode & 0o777, 0o700);
    await sleep(400);
    const r = await cmd(s, { t: 'idle', op: 'get' });
    assert.equal(r.weather, null);
    assert.equal(r.cfg.lat, null);
    assert.equal(r.cfg.lon, null);
    assert.equal(r.cfg.city, '');
    assert.doesNotMatch(s.logs(), /fetch-spy: open-meteo/, 'sin lat/lon no se pide el tiempo');
    assert.doesNotMatch(s.logs(), /tiempo:/, 'ni sale un error del tiempo');
    // poner una ubicación desde el mando sí lo pide; quitarla lo borra
    const set = await cmd(s, { t: 'idle', op: 'set', cfg: { city: 'Lugo', lat: 43.01, lon: -7.55 } });
    assert.equal(set.ok, 1);
    assert.ok(await until(async () => (await cmd(s, { t: 'idle', op: 'get' })).weather), 'llega el tiempo');
    assert.match(s.logs(), /fetch-spy: open-meteo 43.01,-7.55/);
    await cmd(s, { t: 'idle', op: 'set', cfg: { lat: null, lon: null } });
    assert.equal((await until(async () => { const g = await cmd(s, { t: 'idle', op: 'get' }); return g.weather === null && g; })).weather, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.state, 'idle.json'), 'utf8')).lat, null, 'idle.json en TV_STATE_DIR');
  } finally { await s.stop(); }
});

test('TV_CITY, TV_LAT, TV_LON y TV_TZ del entorno', async () => {
  const s = await start({ env: { ...SPY, TV_CITY: 'Lugo', TV_LAT: '43.01', TV_LON: '-7.55', TV_TZ: 'Atlantic/Canary' } });
  try {
    const r = await until(async () => { const g = await cmd(s, { t: 'idle', op: 'get' }); return g.weather && g; });
    assert.deepEqual([r.cfg.city, r.cfg.lat, r.cfg.lon, r.cfg.tz], ['Lugo', 43.01, -7.55, 'Atlantic/Canary']);
    assert.equal(r.weather.temp, 21);
    assert.match(s.logs(), /fetch-spy: open-meteo 43.01,-7.55/);
  } finally { await s.stop(); }
});

test('migración: el estado de junto a server.js pasa a TV_STATE_DIR al arrancar', async () => {
  const s = await start({ legacy: true, files: { 'access.json': { guestHours: 6 } } });
  try {
    for (const f of ['token', 'access.json']) {
      assert.ok(fs.existsSync(path.join(s.state, f)), f + ' en TV_STATE_DIR');
      assert.equal(fs.statSync(path.join(s.state, f)).mode & 0o777, 0o600, f);
      assert.ok(!fs.existsSync(path.join(s.root, f)), f + ' ya no está junto a server.js');
    }
    assert.equal(fs.statSync(s.state).mode & 0o777, 0o700);
    const r = await cmd(s, { t: 'access', op: 'get' });
    assert.equal(r.access?.guestHours, 6, 'el token y access.json movidos siguen valiendo: ' + JSON.stringify(r));
    assert.match(s.logs(), /estado: movido .*token -> /);
    assert.ok(!s.logs().includes(s.token), 'el token no sale en el registro');
  } finally { await s.stop(); }
});
