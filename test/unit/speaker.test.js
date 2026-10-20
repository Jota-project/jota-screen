'use strict';
// Altavoz de la tele (remote/src/tv/speaker.js) con un spawn falso.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSpeaker, CMD } = require(path.join(__dirname, '..', '..', 'remote', 'src', 'tv', 'speaker'));

function fake() {
  const procs = [];
  const spawnImpl = (cmd, args, opt) => {
    const p = Object.assign(new EventEmitter(), { cmd, args, opt, written: [], killed: false, ended: false });
    p.stdin = Object.assign(new EventEmitter(), { write: b => p.written.push(b), end: () => { p.ended = true; }, destroy() {} });
    p.kill = () => { p.killed = true; };
    procs.push(p); return p;
  };
  return { procs, spawnImpl };
}

test('start lanza cmd con XDG_RUNTIME_DIR y write escribe en stdin; end cierra sin matar', () => {
  const f = fake();
  const s = createSpeaker({ runtimeDir: '/run/user/7', spawnImpl: f.spawnImpl });
  s.start();
  assert.equal(f.procs[0].cmd, 'pw-cat');
  assert.deepEqual(f.procs[0].args, CMD.slice(1));
  assert.ok(CMD.includes('--raw') && CMD.includes('24000'));
  assert.equal(f.procs[0].opt.env.XDG_RUNTIME_DIR, '/run/user/7');
  s.write(Buffer.from([1, 2])); s.write(Buffer.from([3]));
  assert.deepEqual(f.procs[0].written.map(b => [...b]), [[1, 2], [3]]);
  s.end();
  assert.equal(f.procs[0].ended, true);
  assert.equal(f.procs[0].killed, false, 'end deja vaciar');
  s.write(Buffer.from([9]));
  assert.equal(f.procs[0].written.length, 2, 'tras end no se escribe');
});

test('cmd propio: se lanza tal cual', () => {
  const f = fake();
  createSpeaker({ cmd: ['aplay', '-q'], spawnImpl: f.spawnImpl }).start();
  assert.equal(f.procs[0].cmd, 'aplay'); assert.deepEqual(f.procs[0].args, ['-q']);
});

test('start con otra reproducción viva la mata; stop corta', () => {
  const f = fake();
  const s = createSpeaker({ spawnImpl: f.spawnImpl });
  s.start(); s.start();
  assert.equal(f.procs.length, 2);
  assert.equal(f.procs[0].killed, true);
  assert.equal(f.procs[1].killed, false);
  s.stop();
  assert.equal(f.procs[1].killed, true);
  s.write(Buffer.from([1])); s.stop();   // sin proceso: no hace nada ni falla
});

test('un fallo al lanzar se avisa una vez y no lanza', () => {
  const warns = [];
  const s = createSpeaker({ spawnImpl: () => { throw new Error('ENOENT'); }, log: { warn: (...a) => warns.push(a) } });
  s.start(); s.write(Buffer.from([1])); s.end();
  assert.equal(warns.length, 1, 'una vez por reproducción');
  const f = fake();
  const s2 = createSpeaker({ spawnImpl: f.spawnImpl, log: { warn: (...a) => warns.push(a) } });
  s2.start(); f.procs[0].emit('error', new Error('spawn pw-cat ENOENT')); f.procs[0].emit('error', new Error('otra'));
  assert.equal(warns.length, 2, 'el error asíncrono también se avisa una vez');
  s2.write(Buffer.from([1]));
});

test('end deja la reproducción en el hueco de vaciado: start o stop aún la matan, y su exit lo libera', () => {
  const f = fake();
  const s = createSpeaker({ spawnImpl: f.spawnImpl });
  s.start(); s.end(); s.start();
  assert.equal(f.procs[0].killed, true, 'start mata la que vacía');
  s.end(); s.stop();
  assert.equal(f.procs[1].killed, true, 'stop mata la que vacía');
  s.start(); s.end(); f.procs[2].emit('exit');
  s.stop();
  assert.equal(f.procs[2].killed, false, 'tras su exit ya no hay nada que matar');
});

test('el aviso de fallo se repite una vez en la siguiente reproducción', () => {
  const warns = [];
  const s = createSpeaker({ spawnImpl: () => { throw new Error('x'); }, log: { warn: (...a) => warns.push(a) } });
  s.start(); s.start(); s.write(Buffer.from([1]));
  assert.equal(warns.length, 2, 'una vez por reproducción, no una por llamada');
});
