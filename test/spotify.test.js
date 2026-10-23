'use strict';
// Spotify: la espera por límite de peticiones (429) sobrevive a un reinicio del servidor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { start } = require('./helpers/server');

const cmd = (s, body) => s.api('/api/cmd', s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const conectado = extra => ({ clientId: 'cliente', refresh: 'refresco', access: 'acceso', expires: Date.now() + 3600e3, ...extra });

test('con una espera guardada, al arrancar no pregunta a Spotify hasta que pase', async () => {
  const s = await start({ files: { 'spotify.json': conectado({ waitUntil: Date.now() + 10 * 60e3 }) } });
  try {
    await new Promise(r => setTimeout(r, 200));
    assert.match(s.logs(), /spotify: sigo esperando \d+ s/);
    const r = await (await cmd(s, { t: 'spotify', a: 'status' })).json();
    assert.match(JSON.stringify(r), /Spotify pide esperar (5\d\d|600) s/);
  } finally { await s.stop(); }
});

test('una espera ya vencida se borra al arrancar', async () => {
  const s = await start({ files: { 'spotify.json': conectado({ waitUntil: Date.now() - 1000 }) } });
  try {
    await new Promise(r => setTimeout(r, 200));
    assert.doesNotMatch(s.logs(), /sigo esperando/);
    const saved = JSON.parse(fs.readFileSync(path.join(s.state, 'spotify.json'), 'utf8'));
    assert.equal(saved.waitUntil, undefined);
    assert.equal(saved.refresh, 'refresco', 'el resto de spotify.json no se toca');
  } finally { await s.stop(); }
});

test('con la tele por ADB, el volumen de Spotify es el de la tele y no toca la Web API', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-adb-'));
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'adb'), `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
  const spy = '--require ' + path.join(__dirname, 'helpers', 'fetch-spy.js');
  const s = await start({ files: { 'spotify.json': conectado() }, env: { TV_ADB: '127.0.0.1:9', TV_INPUT: 'x/HW4', PATH: bin + path.delimiter + process.env.PATH, NODE_OPTIONS: spy } });
  try {
    const r = await (await cmd(s, { t: 'spotify', a: 'volume', v: 40 })).json();
    assert.deepEqual(r, { ok: 1, volume: 40 });
    assert.match(fs.readFileSync(calls, 'utf8'), /volume --stream 3 --set 40/);
    assert.doesNotMatch(s.logs(), /fetch-spy: spotify PUT/);
  } finally { await s.stop(); fs.rmSync(bin, { recursive: true, force: true }); }
});
