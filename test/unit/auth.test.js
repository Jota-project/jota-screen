'use strict';
// Unitarias de acceso (src/auth) y del registro de órdenes (src/transport/commands), con dobles de las sesiones y de la tele.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = path.join(__dirname, '..', '..', 'remote', 'src');
const { permSan, check, ADMIN_PERMS, PERM_DEFAULT } = require(path.join(R, 'auth', 'permissions'));
const { createAccess } = require(path.join(R, 'auth', 'access'));
const { createCommands } = require(path.join(R, 'transport', 'commands'));

const GUEST = { ...PERM_DEFAULT, admin: false };

test('permisos: políticas con nombre y funciones', () => {
  assert.equal(check('any', {}, GUEST), null);
  assert.equal(check('admin', {}, ADMIN_PERMS), null);
  assert.match(check('admin', {}, GUEST).error, /administrador/);
  assert.equal(check('adminQuiet', {}, GUEST).error, 'No tienes permiso para esto');
  assert.match(check('stage', {}, GUEST).error, /presentaciones/);
  assert.equal(check('web', {}, GUEST), null);
  assert.match(check('web', {}, { ...GUEST, web: false }).error, /webs/);
  assert.match(check('agent', {}, { ...GUEST, agent: 'off' }).error, /agente/);
  assert.equal(check((m, P) => (m.x > P.volMax ? 'mucho' : null), { x: 5 }, GUEST), null);
  assert.equal(check((m, P) => (m.x > P.volMax ? 'mucho' : null), { x: 500 }, GUEST).error, 'mucho');
  assert.throws(() => check('inventada', {}, GUEST), /política desconocida/);
});

test('permisos: permSan acota y respeta la base', () => {
  assert.equal(permSan({ volMax: 3 }).volMax, 10);
  assert.equal(permSan({ volMax: 400 }).volMax, 100);
  assert.equal(permSan({ agent: 'raro' }).agent, 'guest');
  assert.equal(permSan({ music: 'queue', stage: 1 }).stage, true);
  assert.equal(permSan({}, { ...PERM_DEFAULT, library: true }).library, true);
});

test('órdenes: permiso, ajuste, uso, desconocidas, errores y duplicados', async () => {
  let uses = 0, ran = [];
  const cmds = createCommands({ permsOf: dev => (dev ? GUEST : ADMIN_PERMS), onUse: () => uses++ });
  cmds.register([
    { t: 'solo', perm: 'admin', run: () => (ran.push('solo'), { ok: 1 }) },
    { t: 'vol', clamp: (m, P) => ({ ...m, v: Math.min(m.v, P.volMax - 50) }), run: m => ({ v: m.v }) },
    { t: 'mira', quiet: true, run: () => ({ ok: 1 }) },
    { t: 'rompe', run: () => { throw new Error('se rompió'); } },
  ]);
  const guest = { id: 'g' };
  assert.match((await cmds.dispatch({ t: 'solo' }, { dev: guest })).error, /administrador/);
  assert.deepEqual(ran, [], 'sin permiso no se ejecuta');
  assert.equal(uses, 0, 'una orden denegada no cuenta como uso');
  assert.deepEqual(await cmds.dispatch({ t: 'solo' }), { ok: 1 });
  assert.deepEqual(await cmds.dispatch({ t: 'vol', v: 90 }, { dev: guest }), { v: 50 });
  const before = uses; await cmds.dispatch({ t: 'mira' }); assert.equal(uses, before, 'quiet no cuenta como uso');
  assert.deepEqual(await cmds.dispatch({ t: 'nada' }), { error: 'orden desconocida' });
  assert.deepEqual(await cmds.dispatch({ t: 'rompe' }), { error: 'se rompió' });
  assert.deepEqual(await cmds.dispatch(null), { error: 'mensaje no válido' });
  assert.throws(() => cmds.register([{ t: 'solo', run() {} }]), /repetida/);
  assert.throws(() => cmds.register([{ t: 'x' }]), /mal declarada/);
});

test('órdenes: lo escrito en un campo no va al registro', async () => {
  const lines = [];
  const cmds = createCommands({ permsOf: () => ADMIN_PERMS, log: { debug: (...a) => lines.push(a.join(' ')) } });
  cmds.register([{ t: 'field', run: () => ({ ok: 1 }) }]);
  await cmds.dispatch({ t: 'field', value: 'contraseña-secreta' });
  assert.ok(!lines.join('\n').includes('contraseña-secreta'));
  assert.match(lines.join('\n'), /18 caracteres/);
});

// ── acceso con dobles
function setup({ admins = 1, tvReady = true, t0 = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-acc-'));
  const files = { token: path.join(dir, 'token'), devices: path.join(dir, 'devices.json'), access: path.join(dir, 'access.json') };
  const ev = { closed: [], pushed: [], admin: [], shown: [], hidden: 0 };
  let now = t0;
  const sessions = {
    isOnline: () => false,
    close: (id, code) => ev.closed.push([id, code]),
    pushMe: id => ev.pushed.push(id),
    adminCount: () => admins,
    notifyAdmins: m => ev.admin.push(m),
  };
  const tv = { ready: () => tvReady, showCode: (code, name) => { ev.shown.push({ code, name }); }, hideCode: () => { ev.hidden++; } };
  const make = () => createAccess({ files, adminUrl: 'http://mando.local', log: { info() {} }, sessions, tv, now: () => now });
  return { dir, files, ev, make, tick: ms => { now += ms; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('acceso: token maestro creado con 0600 y comparación segura', () => {
  const s = setup(); const a = s.make();
  const t = a.masterToken();
  assert.match(t, /^[a-f0-9]{32}$/);
  assert.equal(fs.statSync(s.files.token).mode & 0o777, 0o600);
  assert.ok(a.isMaster(t) && a.okToken(t));
  assert.ok(!a.isMaster(t.slice(0, -1) + 'x') && !a.isMaster(null) && !a.okToken('x'.repeat(200)));
  assert.equal(s.make().masterToken(), t, 'se reutiliza el del fichero');
  s.done();
});

test('acceso: dispositivos, roles y último admin', () => {
  const s = setup(); const a = s.make();
  const adm = a.devices.newDevice('Ana', 'admin');
  const g = a.devices.newDevice('Visita', 'guest');
  assert.equal(a.tokenDev(adm.token).role, 'admin');
  assert.equal(a.permsOf(a.tokenDev(g.token)).admin, false);
  assert.ok(g.expires > 0, 'los invitados caducan');
  assert.match(a.devices.setRole(adm.id, 'guest').error, /al menos un administrador/);
  assert.equal(a.devices.setRole(g.id, 'member').ok, 1);
  assert.equal(a.byId(g.id).expires, null, 'un miembro no caduca');
  assert.ok(s.ev.pushed.includes(g.id), 'se avisa al dispositivo de su rol nuevo');
  assert.equal(a.devices.rename(g.id, '<b>Ana</b>').devices.find(d => d.id === g.id).name, 'bAnab');
  assert.equal(a.devices.revoke(g.id).ok, 1);
  assert.deepEqual(s.ev.closed.at(-1), [g.id, 4001]);
  assert.equal(a.tokenDev(g.token), null);
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(s.files.devices, 'utf8'))).includes(adm.token), 'solo se guarda el hash');
  s.done();
});

test('acceso: un invitado caducado se borra y se le cierra la sesión', () => {
  const s = setup(); const a = s.make();
  const g = a.devices.newDevice('Visita', 'guest');
  s.tick(25 * 3600e3);
  assert.equal(a.okToken(g.token), false);
  assert.deepEqual(s.ev.closed.at(-1), [g.id, 4002]);
  s.done();
});

test('acceso: emparejar con el código de la tele (3 fallos y fuera)', async () => {
  const s = setup(); const a = s.make();
  const r = await a.pairing.start('1.1.1.1', 'Móvil de Ana');
  assert.ok(r.pid);
  assert.equal(s.ev.shown[0].name, 'Móvil de Ana');
  const code = s.ev.shown[0].code;
  assert.match(code, /^\d{4}$/);
  const wrong = code === '0000' ? '1111' : '0000';
  assert.equal(a.pairing.confirm(r.pid, wrong).error, 'Código incorrecto');
  assert.match((await a.pairing.start('1.1.1.1', 'otra')).error, /Espera/);
  const ok = a.pairing.confirm(r.pid, code);
  assert.equal(ok.role, 'guest');
  assert.equal(a.tokenDev(ok.token).name, 'Móvil de Ana');
  s.tick(5000);
  const r2 = await a.pairing.start('1.1.1.1', 'Otro');
  const c2 = s.ev.shown[1].code, bad = c2 === '0000' ? '1111' : '0000';
  a.pairing.confirm(r2.pid, bad); a.pairing.confirm(r2.pid, bad);
  assert.equal(a.pairing.confirm(r2.pid, bad).dead, true);
  assert.match(a.pairing.confirm(r2.pid, c2).error, /caducado/);
  s.done();
});

test('acceso: sin tele no hay código; sin admins no se puede pedir permiso', async () => {
  const s = setup({ admins: 0, tvReady: false }); const a = s.make();
  assert.match((await a.pairing.start('2.2.2.2', 'x')).error, /tele no está disponible/);
  s.tick(5000);
  const r = await a.pairing.start('3.3.3.3', 'x', 'ask');
  assert.equal(r.noAdmin, true);
  s.done();
});

test('acceso: pedir permiso a un admin y que lo deniegue', async () => {
  const s = setup(); const a = s.make();
  const r = await a.pairing.start('4.4.4.4', 'Primo', 'ask');
  assert.deepEqual(s.ev.admin.at(-1), { t: 'pairreq', pid: r.pid, name: 'Primo' });
  assert.deepEqual(a.pairing.pendingAsks(), [{ pid: r.pid, name: 'Primo' }]);
  assert.equal(a.pairing.answer(r.pid, false).ok, 1);
  assert.deepEqual(a.pairing.poll(r.pid), { denied: true });
  assert.equal(a.pairing.poll(r.pid).dead, true);
  s.done();
});

test('acceso: enlace de admin de un solo uso, que caduca, y ascenso del dispositivo actual', () => {
  const s = setup(); const a = s.make();
  const l = a.admin.link();
  assert.match(l.code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  assert.equal(l.url, 'http://mando.local/#admin=' + l.code);
  const g = a.devices.newDevice('Móvil', 'guest');
  const up = a.admin.claim(l.code.toLowerCase(), 'x', g.token);
  assert.equal(up.token, g.token, 'se asciende el que ya tenía');
  assert.equal(a.byId(g.id).role, 'admin');
  assert.match(a.admin.claim(l.code, 'x').error, /no vale/);
  const l2 = a.admin.link(); s.tick(11 * 60_000);
  assert.match(a.admin.claim(l2.code, 'x').error, /caducado/);
  s.done();
});

test('acceso: los dispositivos sin rol (de antes de los roles) pasan a admin', () => {
  const s = setup();
  fs.writeFileSync(s.files.devices, JSON.stringify([{ id: 'a1', name: 'Viejo', h: 'x', created: 1, seen: 1 }]));
  const a = s.make();
  assert.equal(a.byId('a1').role, 'admin');
  assert.equal(JSON.parse(fs.readFileSync(s.files.devices, 'utf8'))[0].role, 'admin');
  s.done();
});

test('acceso: ajustes de invitados acotados y avisados', () => {
  const s = setup(); const a = s.make();
  const g = a.devices.newDevice('Visita', 'guest');
  const acc = a.setAccess({ guestHours: 99999, guest: { volMax: 50, library: true } });
  assert.equal(acc.guestHours, 720);
  assert.equal(a.permsOf(a.byId(g.id)).volMax, 50);
  assert.ok(s.ev.pushed.includes(g.id));
  assert.equal(fs.statSync(s.files.access).mode & 0o777, 0o600);
  s.done();
});
