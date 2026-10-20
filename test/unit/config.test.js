'use strict';
// Unitarias de la configuración (remote/src/core/config.js) y de la carpeta de estado (remote/src/core/state-dir.js):
// valores por defecto sin nada personal, la regla de TV_ADMIN_URL, OpenClaw en PATH y la migración del estado antiguo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = path.join(__dirname, '..', '..', 'remote', 'src');
const { loadConfig } = require(path.join(R, 'core', 'config'));
const { prepareStateDir } = require(path.join(R, 'core', 'state-dir'));
const { prompts } = require(path.join(R, 'features', 'agent'));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-cfg-'));
const PERSONAL = /sito|sal[oó]n|elche|green-house|ts\.net|tailf2c|madrid|38\.26|-0\.69|192\.168/i;

test('config: sin entorno, valores por defecto del contrato y nada personal', () => {
  const home = tmpDir();
  try {
    const d = loadConfig({ HOME: home, PATH: '' }, { hostname: 'caja' });
    assert.equal(d.NAME, 'Pantalla');
    assert.equal(d.SP_DEVICE, 'Pantalla', 'el altavoz de Spotify se llama como la pantalla');
    assert.equal(d.PORT, 8787);
    assert.equal(d.CDP_PORT, 9222);
    assert.equal(d.PUBLIC_URL, 'http://127.0.0.1:8787');
    assert.equal(d.ADMIN_URL, 'http://mando.local');
    assert.equal(d.HOME_URL, 'http://127.0.0.1:8787/idle.html');
    assert.equal(d.STATE_DIR, path.join(home, '.local', 'state', 'jota-screen'));
    assert.equal(d.STAGE_DIR, path.join(d.STATE_DIR, 'stage'));
    for (const f of Object.values(d.FILES)) assert.equal(path.dirname(f), d.STATE_DIR, f);
    assert.equal(d.OC_BIN, path.join(home, '.npm-global', 'bin', 'openclaw'));
    assert.equal(d.OC_AGENT, 'jota');
    assert.equal(d.OWNER, '');
    assert.deepEqual({ ...d.PLACE }, { city: '', lat: null, lon: null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
    // OC_ENV copia el entorno, la zona horaria es la del sistema y las rutas del código dependen de dónde esté el repo;
    // lo demás es lo que decide la configuración
    const rest = { ...d }; delete rest.OC_ENV;
    const seen = JSON.stringify({ ...rest, PLACE: { ...d.PLACE, tz: '' } }).replaceAll(d.ROOT, '<repo>').replaceAll(home, '~');
    assert.doesNotMatch(seen, PERSONAL);
    assert.doesNotMatch(JSON.stringify(prompts(d.NAME, d.OWNER)), PERSONAL, 'las instrucciones del agente son genéricas');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('config: las variables del contrato mandan', () => {
  const c = loadConfig({
    HOME: '/h', TV_NAME: ' Cocina ', TV_STATE_DIR: '/var/x/', TV_PUBLIC_URL: 'https://tv.example:8443/', TV_SPOTIFY_DEVICE: 'Altavoz',
    TV_CITY: 'Lugo', TV_LAT: '43.01', TV_LON: '-7.55', TV_TZ: 'Atlantic/Canary', TV_OWNER: 'Ana', TV_OPENCLAW: '/opt/oc',
  });
  assert.equal(c.NAME, 'Cocina');
  assert.equal(c.SP_DEVICE, 'Altavoz');
  assert.equal(c.STATE_DIR, '/var/x');
  assert.equal(c.FILES.token, '/var/x/token');
  assert.equal(c.PUBLIC_URL, 'https://tv.example:8443');
  assert.deepEqual({ ...c.PLACE }, { city: 'Lugo', lat: 43.01, lon: -7.55, tz: 'Atlantic/Canary' });
  assert.equal(c.OWNER, 'Ana');
  assert.equal(c.OC_BIN, '/opt/oc');
  assert.equal(loadConfig({ HOME: '/h', TV_NAME: 'Cocina' }).SP_DEVICE, 'Cocina');
  assert.equal(loadConfig({ HOME: '/h', TV_LAT: '', TV_LON: 'x' }).PLACE.lat, null, 'lat vacía o no numérica: sin tiempo');
});

test('config: regla de TV_ADMIN_URL', () => {
  const at = (env, port) => loadConfig({ HOME: '/h', ...(port ? { TV_PORT: String(port) } : {}), ...env }, { hostname: 'caja' }).ADMIN_URL;
  assert.equal(at({}), 'http://mando.local', 'por defecto, el alias mDNS');
  assert.equal(at({ TV_MDNS_NAME: 'tele.local' }), 'http://tele.local');
  assert.equal(at({ TV_MDNS_NAME: '' }), 'http://caja.local:8787', 'sin alias: <hostname>.local y el puerto');
  assert.equal(at({ TV_MDNS_NAME: '' }, 9000), 'http://caja.local:9000');
  assert.equal(at({ TV_MDNS_NAME: '', TV_ADMIN_URL: 'http://m.example/' }), 'http://m.example', 'TV_ADMIN_URL gana siempre');
});

test('config: OpenClaw se busca en PATH', () => {
  const d = tmpDir();
  try {
    const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'openclaw'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(d, 'openclaw'), 'no ejecutable', { mode: 0o644 });
    const c = loadConfig({ HOME: '/h', PATH: [d, bin].join(path.delimiter) });
    assert.equal(c.OC_BIN, path.join(bin, 'openclaw'), 'el primero ejecutable');
    assert.ok(c.OC_ENV.PATH.startsWith(bin + ':'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── carpeta de estado
function legacySetup() {
  const d = tmpDir();
  const root = path.join(d, 'remote'); fs.mkdirSync(root);
  const cfg = loadConfig({ HOME: d, TV_STATE_DIR: path.join(d, 'state') });
  const LEGACY = { files: ['token', 'devices.json', 'access.json', 'spotify.json', 'idle.json'].map(f => path.join(root, f)), stage: path.join(d, 'tv', 'stage') };
  return { d, root, cfg: { STATE_DIR: cfg.STATE_DIR, LEGACY }, done: () => fs.rmSync(d, { recursive: true, force: true }) };
}

test('estado: crea la carpeta con 0700 (y la cierra si ya existía abierta)', () => {
  const s = legacySetup();
  try {
    const lines = [];
    const r = prepareStateDir(s.cfg, (...a) => lines.push(a.join(' ')));
    assert.equal(fs.statSync(s.cfg.STATE_DIR).mode & 0o777, 0o700);
    assert.deepEqual(r, { moved: [], kept: [] });
    assert.deepEqual(lines, [], 'sin nada antiguo, no dice nada');
    fs.chmodSync(s.cfg.STATE_DIR, 0o755);
    prepareStateDir(s.cfg);
    assert.equal(fs.statSync(s.cfg.STATE_DIR).mode & 0o777, 0o700);
  } finally { s.done(); }
});

test('estado: mueve lo antiguo con permisos privados y registra sin contenido', () => {
  const s = legacySetup();
  try {
    const SECRET = 'a'.repeat(32);
    fs.writeFileSync(path.join(s.root, 'token'), SECRET + '\n', { mode: 0o644 });
    fs.writeFileSync(path.join(s.root, 'devices.json'), '[{"h":"' + SECRET + '"}]', { mode: 0o600 });
    fs.mkdirSync(s.cfg.LEGACY.stage, { recursive: true });
    fs.writeFileSync(path.join(s.cfg.LEGACY.stage, 'p1.html'), '<p>hola', { mode: 0o644 });
    fs.mkdirSync(path.join(s.cfg.STATE_DIR, 'stage'), { recursive: true }); // una carpeta nueva vacía no impide mover
    const lines = [];
    const r = prepareStateDir(s.cfg, (...a) => lines.push(a.join(' ')));
    const S = s.cfg.STATE_DIR;
    assert.equal(fs.readFileSync(path.join(S, 'token'), 'utf8'), SECRET + '\n');
    assert.equal(fs.statSync(path.join(S, 'token')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(S, 'devices.json')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(S, 'stage', 'p1.html'), 'utf8'), '<p>hola');
    assert.equal(fs.statSync(path.join(S, 'stage')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(S, 'stage', 'p1.html')).mode & 0o777, 0o600);
    for (const f of ['token', 'devices.json']) assert.ok(!fs.existsSync(path.join(s.root, f)), 'se mueve, no se copia: ' + f);
    assert.ok(!fs.existsSync(s.cfg.LEGACY.stage));
    assert.equal(r.moved.length, 3);
    assert.equal(lines.length, 3);
    assert.ok(lines.every(l => /^estado: movido /.test(l) && !l.includes(SECRET)), lines.join('\n'));
    // segunda vez: ya no hay nada que mover
    assert.deepEqual(prepareStateDir(s.cfg), { moved: [], kept: [] });
  } finally { s.done(); }
});

test('estado: nunca sobrescribe lo que ya está en la carpeta nueva', () => {
  const s = legacySetup();
  try {
    const S = s.cfg.STATE_DIR;
    fs.mkdirSync(path.join(S, 'stage'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(S, 'token'), 'nuevo\n', { mode: 0o600 });
    fs.writeFileSync(path.join(S, 'stage', 'p2.html'), 'nuevo');
    fs.writeFileSync(path.join(s.root, 'token'), 'viejo\n');
    fs.writeFileSync(path.join(s.root, 'idle.json'), '{"city":"X"}');
    fs.mkdirSync(s.cfg.LEGACY.stage, { recursive: true });
    fs.writeFileSync(path.join(s.cfg.LEGACY.stage, 'p1.html'), 'viejo');
    const lines = [];
    const r = prepareStateDir(s.cfg, (...a) => lines.push(a.join(' ')));
    assert.equal(fs.readFileSync(path.join(S, 'token'), 'utf8'), 'nuevo\n');
    assert.equal(fs.readFileSync(path.join(s.root, 'token'), 'utf8'), 'viejo\n', 'el antiguo se queda donde estaba');
    assert.deepEqual(fs.readdirSync(path.join(S, 'stage')), ['p2.html']);
    assert.ok(fs.existsSync(path.join(s.cfg.LEGACY.stage, 'p1.html')));
    assert.equal(fs.readFileSync(path.join(S, 'idle.json'), 'utf8'), '{"city":"X"}', 'lo que falta sí se mueve');
    assert.deepEqual(r.kept.sort(), [path.join(s.root, 'token'), s.cfg.LEGACY.stage].sort());
    assert.ok(lines.some(l => /no se mueve, ya existe/.test(l) && !/viejo|nuevo\n/.test(l)));
  } finally { s.done(); }
});
