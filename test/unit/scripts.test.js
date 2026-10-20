'use strict';
// Scripts de sistema (scripts/lib.sh, install.sh, kiosk-session.sh, mdns-alias.sh, doctor.sh, update.sh, cdp.js).
// Nada toca el sistema: cada prueba usa un HOME temporal, una copia del repo y órdenes falsas en el PATH
// (systemctl, loginctl, sudo, npm, xrandr, chrome…) que solo apuntan lo que reciben.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const LIB = path.join(REPO, 'scripts', 'lib.sh');
const SCRIPTS = ['scripts/lib.sh', 'scripts/install.sh', 'scripts/doctor.sh', 'scripts/update.sh', 'scripts/spotifyd-run.sh', 'kiosk-session.sh', 'mdns-alias.sh'];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jsc-'));

/** Entorno limpio: HOME temporal y sin variables de jota-screen heredadas. */
function cleanEnv(home, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TV_|XDG_|JSC_|DISPLAY$)/.test(k)) env[k] = v;
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), TMPDIR: home, LC_ALL: 'C.UTF-8', ...extra };
}

/** Ejecuta bash con lib.sh cargada. */
function lib(script, { input = '', env = {}, home = tmp() } = {}) {
  return execFileSync('bash', ['-c', `. "${LIB}"; ${script}`], { input, env: cleanEnv(home, env), encoding: 'utf8' });
}

/** Carpeta con órdenes falsas que apuntan sus argumentos en $STUB_LOG. */
function stubs(extra = {}) {
  const dir = tmp();
  const log = path.join(dir, 'calls.log');
  const mk = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/bash\necho "${name} $*" >>"${log}"\n${body}\n`, { mode: 0o755 });
  const base = {
    systemctl: 'exit 1', loginctl: 'exit 1', sudo: 'exit 1', journalctl: 'exit 0', npm: 'exit 0',
    'google-chrome': 'exit 0', xinit: 'exit 0', xrandr: 'exit 0', xset: 'exit 0', openbox: 'exit 0',
    ...extra,
  };
  for (const [n, b] of Object.entries(base)) if (b !== null) mk(n, b);
  return { dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

/** Copia lo que usa el instalador a una carpeta nueva (para no escribir nada en el repo). */
function repoCopy() {
  const dst = tmp();
  for (const p of ['scripts', 'systemd', 'config', 'kiosk-session.sh', 'mdns-alias.sh', 'home.html']) fs.cpSync(path.join(REPO, p), path.join(dst, p), { recursive: true });
  fs.mkdirSync(path.join(dst, 'remote'));
  for (const f of ['package-lock.json', 'nginx-mando.conf']) fs.copyFileSync(path.join(REPO, 'remote', f), path.join(dst, 'remote', f));
  return dst;
}

const listAll = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];

// ───────────────────────────────────────────────────────────────── sintaxis
test('scripts de bash: sintaxis (y shellcheck si está)', () => {
  for (const s of SCRIPTS) execFileSync('bash', ['-n', path.join(REPO, s)]);
  const sc = spawnSync('shellcheck', ['--version']);
  if (sc.status !== 0) return;
  const r = spawnSync('shellcheck', ['-x', ...SCRIPTS], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ───────────────────────────────────────────────────────────────── detección
const XRANDR = `Screen 0: minimum 8 x 8, current 1920 x 1080, maximum 32767 x 32767
DVI-D-0 disconnected (normal left inverted right x axis y axis)
HDMI-A-1 connected 1920x1080+0+0 (normal left inverted right x axis y axis) 1600mm x 900mm
   3840x2160     30.00 +  25.00    24.00
   1920x1080     60.00*   59.94    50.00
   1280x720      60.00    50.00
DP-3 connected primary 2560x1440+1920+0 (normal left inverted right x axis y axis) 600mm x 340mm
   2560x1440     59.95 +  143.97*
   1920x1080     60.00
`;

test('xrandr: salida conectada (la primaria si la hay) y su modo preferido', () => {
  assert.equal(lib('jsc_parse_xrandr_output', { input: XRANDR }).trim(), 'DP-3');
  const noPrimary = XRANDR.replace(' primary', '');
  assert.equal(lib('jsc_parse_xrandr_output', { input: noPrimary }).trim(), 'HDMI-A-1', 'sin primaria: la primera conectada');
  assert.equal(lib('jsc_parse_xrandr_mode HDMI-A-1', { input: XRANDR }).trim(), '3840x2160 30.00', 'el modo con «+»');
  assert.equal(lib('jsc_parse_xrandr_mode DP-3', { input: XRANDR }).trim(), '2560x1440 59.95');
  const noPlus = XRANDR.replace('30.00 +', '30.00  ');
  assert.equal(lib('jsc_parse_xrandr_mode HDMI-A-1', { input: noPlus }).trim(), '1920x1080 60.00', 'sin «+»: el actual');
  assert.equal(lib('jsc_parse_xrandr_mode NADA', { input: XRANDR }).trim(), '');
  assert.equal(lib('jsc_parse_xrandr_output', { input: 'Screen 0: …\nHDMI-1 disconnected (normal)\n' }).trim(), '', 'nada conectado');
  assert.equal(lib('jsc_parse_xrandr_output', { input: '' }).trim(), '');
});

test('ip route: interfaz de la ruta por defecto (la de menor métrica)', () => {
  const routes = `default via 192.168.1.1 dev wlp2s0 proto dhcp src 192.168.1.50 metric 600
default via 192.168.1.1 dev enp3s0 proto dhcp src 192.168.1.51 metric 100
`;
  assert.equal(lib('jsc_parse_default_iface', { input: routes }).trim(), 'enp3s0');
  assert.equal(lib('jsc_parse_default_iface', { input: 'default via 10.0.0.1 dev eth0\n' }).trim(), 'eth0');
  assert.equal(lib('jsc_parse_default_iface', { input: '10.0.0.0/24 dev eth0 proto kernel scope link\n' }).trim(), '');
});

test('config: valores por defecto, fichero y alias vacío', () => {
  const home = tmp();
  const out = lib('jsc_load_config; echo "$TV_NAME|$TV_PORT|$TV_CDP_PORT|$TV_STATE_DIR|$TV_SCALE|$TV_SPOTIFY_DEVICE|$TV_MDNS_NAME|$DISPLAY"', { home });
  assert.equal(out.trim(), `Pantalla|8787|9222|${home}/.local/state/jota-screen|1.5|Pantalla|mando.local|:0`);
  const cfg = path.join(home, '.config', 'jota-screen');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'screen.env'), 'TV_NAME="Tele del salón"\nTV_PORT=9000\nTV_MDNS_NAME=\n');
  const out2 = lib('jsc_load_config; echo "$TV_NAME|$TV_PORT|$TV_SPOTIFY_DEVICE|[$TV_MDNS_NAME]"', { home });
  assert.equal(out2.trim(), 'Tele del salón|9000|Tele del salón|[]');
  const other = path.join(home, 'otra.env');
  fs.writeFileSync(other, 'TV_CDP_PORT=9333\n');
  assert.equal(lib('jsc_load_config; echo $TV_CDP_PORT', { home, env: { TV_CONFIG: other } }).trim(), '9333');
});

test('urlencode', () => {
  assert.equal(lib('jsc_urlencode "Tele del salón & más"').trim(), 'Tele%20del%20sal%C3%B3n%20%26%20m%C3%A1s');
  assert.equal(lib('jsc_urlencode "http://127.0.0.1:8787/idle.html"').trim(), 'http%3A%2F%2F127.0.0.1%3A8787%2Fidle.html');
});

test('perfil de Chrome: se mueve a la carpeta de estado y nunca se sobrescribe', () => {
  const home = tmp();
  const old = path.join(home, 'tv', 'chrome-profile');
  fs.mkdirSync(path.join(old, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(old, 'Default', 'Cookies'), 'viejo');
  const out = lib('jsc_load_config; jsc_migrate_chrome_profile 2>&1', { home });
  const dest = path.join(home, '.local', 'state', 'jota-screen', 'chrome-profile');
  assert.match(out, /perfil de Chrome movido/);
  assert.equal(fs.readFileSync(path.join(dest, 'Default', 'Cookies'), 'utf8'), 'viejo');
  assert.ok(!fs.existsSync(old));
  assert.equal(fs.statSync(path.dirname(dest)).mode & 0o777, 0o700);
  // otro perfil antiguo: no pisa el nuevo
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'otro'), 'x');
  const out2 = lib('jsc_load_config; jsc_migrate_chrome_profile 2>&1', { home });
  assert.match(out2, /no lo muevo/);
  assert.ok(fs.existsSync(path.join(old, 'otro')));
  assert.equal(fs.readFileSync(path.join(dest, 'Default', 'Cookies'), 'utf8'), 'viejo');
  // segunda pasada sin antiguos: nada que decir
  fs.rmSync(old, { recursive: true });
  assert.equal(lib('jsc_load_config; jsc_migrate_chrome_profile 2>&1', { home }).trim(), '');
});

// ───────────────────────────────────────────────────────────────── plantillas
const TEMPLATES = ['systemd/user/jota-screen.service', 'systemd/user/jota-screen-mdns.service', 'systemd/user/jota-screen-spotify.service',
  'systemd/system/jota-screen-kiosk.service', 'systemd/spotifyd.conf.example', 'remote/nginx-mando.conf'];
const PERSONAL = /sito|green-house|tailf2c275|HDMI-0|eno2|192\.168\.|Elche|Salón/;

test('plantillas: sin nada personal y con todos los marcadores rellenos', () => {
  for (const t of [...TEMPLATES, ...SCRIPTS, 'config/screen.env.example', 'home.html', 'scripts/cdp.js', 'systemd/README.md']) {
    const src = fs.readFileSync(path.join(REPO, t), 'utf8');
    assert.doesNotMatch(src, PERSONAL, t);
  }
  const home = tmp();
  for (const t of TEMPLATES) {
    const out = lib(`jsc_render "${path.join(REPO, t)}"`, { home, env: { JSC_USER: 'ana', JSC_NODE: '/opt/node/bin/node' } });
    assert.doesNotMatch(out, /@[A-Z_]+@/, t);
  }
  const unit = lib(`jsc_render "${path.join(REPO, 'systemd/user/jota-screen.service')}"`, { home, env: { JSC_NODE: '/opt/node/bin/node' } });
  assert.match(unit, new RegExp(`EnvironmentFile=-${home}/.config/jota-screen/screen.env`));
  assert.match(unit, new RegExp(`WorkingDirectory=${REPO}/remote`));
  assert.match(unit, /ExecStart=\/opt\/node\/bin\/node server\.js/);
  const kiosk = lib(`jsc_render "${path.join(REPO, 'systemd/system/jota-screen-kiosk.service')}"`, { home, env: { JSC_USER: 'ana' } });
  assert.match(kiosk, /^User=ana$/m);
  assert.match(kiosk, new RegExp(`xinit ${REPO}/kiosk-session.sh`));
  // los «&» de una ruta no se interpretan (bash 5.2: patsub_replacement)
  const odd = lib(`jsc_render "${path.join(REPO, 'systemd/user/jota-screen.service')}"`, { home, env: { JSC_NODE: '/a&b/node' } });
  assert.match(odd, /ExecStart=\/a&b\/node server\.js/);
});

// ───────────────────────────────────────────────────────────────── instalador
test('install.sh --help y --dry-run: no cambia nada', () => {
  const help = execFileSync('bash', [path.join(REPO, 'scripts/install.sh'), '--help'], { encoding: 'utf8' });
  assert.match(help, /--dry-run/);
  const home = tmp();
  const st = stubs();
  const app = repoCopy();
  const before = listAll(app);
  const r = spawnSync('bash', [path.join(app, 'scripts/install.sh'), '--dry-run'],
    { env: cleanEnv(home, { PATH: `${st.dir}:${process.env.PATH}` }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /MODO SIMULADO/);
  assert.match(r.stdout, /\[simulado\] crearía .*jota-screen\.service/);
  assert.match(r.stdout, /sudo install -m 0644 .*jota-screen-kiosk\.service \/etc\/systemd\/system\/jota-screen-kiosk\.service/);
  assert.deepEqual(listAll(home), [], 'el HOME sigue vacío');
  assert.deepEqual(listAll(app), before, 'la copia del repo no cambia');
  assert.doesNotMatch(st.calls(), /^npm /m, 'no ejecuta npm');
});

test('install.sh de verdad sin systemd de usuario: genera, avisa y es idempotente', () => {
  const home = tmp();
  const st = stubs();
  const app = repoCopy();
  const env = cleanEnv(home, { PATH: `${st.dir}:${process.env.PATH}` });
  const run = () => spawnSync('bash', [path.join(app, 'scripts/install.sh')], { env, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no hay systemd de usuario/);
  const cfg = path.join(home, '.config', 'jota-screen', 'screen.env');
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, '.local', 'state', 'jota-screen')).mode & 0o777, 0o700);
  const units = path.join(home, '.config', 'systemd', 'user');
  for (const u of ['jota-screen', 'jota-screen-mdns', 'jota-screen-spotify']) {
    const txt = fs.readFileSync(path.join(units, u + '.service'), 'utf8');
    assert.doesNotMatch(txt, /@[A-Z_]+@/, u);
    assert.match(txt, new RegExp(app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const kiosk = fs.readFileSync(path.join(home, '.config', 'jota-screen', 'generated', 'jota-screen-kiosk.service'), 'utf8');
  assert.match(kiosk, new RegExp(`^User=${os.userInfo().username}$`, 'm'));
  assert.match(st.calls(), /^npm ci --omit=dev/m);

  // segunda vez: la config del usuario no se toca, npm no se repite, las unidades están al día
  fs.appendFileSync(cfg, 'TV_NAME=Mía\n');
  const before = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(st.log, '');
  const r2 = run();
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
  assert.match(r2.stdout, /ya existe .*screen\.env/);
  assert.match(r2.stdout, /jota-screen\.service al día/);
  assert.match(r2.stdout, /nombre «Mía»/);
  assert.doesNotMatch(st.calls(), /^npm /m);
  // nada fuera del HOME y de la copia
  assert.doesNotMatch(st.calls(), /^sudo /m);
});

test('install.sh: se para si falta algo obligatorio y dice cómo instalarlo', () => {
  const home = tmp();
  const st = stubs({ 'google-chrome': null, xinit: null, xrandr: null });
  const app = repoCopy();
  // PATH sin navegador ni X reales: solo los falsos, node y lo básico del sistema
  const PATH = [st.dir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'xinit', 'xrandr']) {
    for (const d of ['/usr/bin', '/bin']) if (fs.existsSync(path.join(d, b))) return; // con X de verdad no se puede simular
  }
  const r = spawnSync('bash', [path.join(app, 'scripts/install.sh')], { env: cleanEnv(home, { PATH }), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /falta Chrome o Chromium/);
  assert.match(r.stdout, /sudo apt install .*xinit/);
  assert.match(r.stdout, /x11-xserver-utils/);
  assert.ok(!fs.existsSync(path.join(home, '.config', 'systemd')), 'no genera unidades');
});

// ───────────────────────────────────────────────────────────────── kiosco y alias
test('kiosk-session.sh: detecta salida y modo, perfil en el estado y CDP solo en 127.0.0.1', () => {
  const home = tmp();
  const fixture = path.join(home, 'xrandr.txt');
  fs.writeFileSync(fixture, XRANDR);
  const st = stubs({ xrandr: `[ "$1" = --query ] && cat "${fixture}"; exit 0` });
  const app = repoCopy();
  fs.mkdirSync(path.join(home, 'tv', 'chrome-profile'), { recursive: true });
  const r = spawnSync('bash', [path.join(app, 'kiosk-session.sh')],
    { env: cleanEnv(home, { PATH: `${st.dir}:${process.env.PATH}`, TV_CDP_PORT: '9333', TV_NAME: 'Tele' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = st.calls();
  assert.match(calls, /^xrandr --output DP-3 --mode 2560x1440 --rate 59\.95$/m);
  const chrome = calls.split('\n').find(l => l.startsWith('google-chrome '));
  assert.ok(chrome, calls);
  assert.match(chrome, /--remote-debugging-port=9333 /);
  assert.match(chrome, /--remote-debugging-address=127\.0\.0\.1 /);
  assert.match(chrome, new RegExp(`--user-data-dir=${home}/.local/state/jota-screen/chrome-profile `));
  assert.match(chrome, new RegExp(`file://${app}/home\\.html#port=8787&name=Tele$`));
  assert.match(r.stdout, /perfil de Chrome movido/);
  assert.ok(!fs.existsSync(path.join(home, 'tv', 'chrome-profile')));
});

test('kiosk-session.sh: sin salidas en xrandr sigue igual; la config manda', () => {
  const home = tmp();
  const st = stubs({ xrandr: '[ "$1" = --query ] && echo "Screen 0: minimum 8 x 8"; exit 0' });
  const app = repoCopy();
  const r = spawnSync('bash', [path.join(app, 'kiosk-session.sh')],
    { env: cleanEnv(home, { PATH: `${st.dir}:${process.env.PATH}`, TV_HOME_URL: 'http://127.0.0.1:8787/x.html' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ninguna salida conectada/);
  assert.doesNotMatch(st.calls(), /^xrandr --output/m);
  assert.match(st.calls(), /&home=http%3A%2F%2F127\.0\.0\.1%3A8787%2Fx\.html$/m);

  const st2 = stubs();
  const r2 = spawnSync('bash', [path.join(app, 'kiosk-session.sh')],
    { env: cleanEnv(home, { PATH: `${st2.dir}:${process.env.PATH}`, TV_DISPLAY_OUTPUT: 'HDMI-2', TV_DISPLAY_MODE: '1280x720', TV_SCALE: '1' }), encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(st2.calls(), /^xrandr --output HDMI-2 --mode 1280x720$/m);
  assert.match(st2.calls(), /--force-device-scale-factor=1 /);
});

test('mdns-alias.sh: alias vacío = no hace nada y sale con 0', () => {
  const home = tmp();
  const r = spawnSync('bash', [path.join(REPO, 'mdns-alias.sh')], { env: cleanEnv(home, { TV_MDNS_NAME: '' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no publico ningún alias/);
});

test('doctor.sh y update.sh: ayuda', () => {
  assert.match(execFileSync('bash', [path.join(REPO, 'scripts/doctor.sh'), '--help'], { encoding: 'utf8' }), /Nunca enseña el token/);
  assert.match(execFileSync('bash', [path.join(REPO, 'scripts/update.sh'), '--help'], { encoding: 'utf8' }), /--ff-only/);
});

test('doctor.sh: falla (≠0) con ✗ cuando no hay nada instalado', () => {
  const home = tmp();
  const st = stubs({ ss: 'exit 0' });
  const r = spawnSync('bash', [path.join(REPO, 'scripts/doctor.sh')],
    { env: cleanEnv(home, { PATH: `${st.dir}:${process.env.PATH}`, TV_PORT: '1', TV_MDNS_NAME: '' }), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ no está .*screen\.env/);
  assert.match(r.stdout, /comprobaciones fallidas/);
});

// ───────────────────────────────────────────────────────────────── cdp.js
test('cdp.js: puerto de la config, ayuda y órdenes contra un Chrome falso', async () => {
  const { cdpPort, parseArgs } = require(path.join(REPO, 'scripts', 'cdp.js'));
  const home = tmp();
  const cfg = path.join(home, 's.env');
  fs.writeFileSync(cfg, '# x\nTV_CDP_PORT="9444"\n');
  assert.equal(cdpPort({ TV_CONFIG: cfg }), 9444);
  assert.equal(cdpPort({ TV_CDP_PORT: '9555', TV_CONFIG: cfg }), 9555);
  assert.equal(cdpPort({ TV_CONFIG: path.join(home, 'no') }), 9222);
  assert.deepEqual(parseArgs(['--port', '1', 'eval', '1+1']), { port: 1, tab: -1, cmd: 'eval', arg: '1+1' });
  const h = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'cdp.js'), '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /nav <url>/);

  const { WebSocketServer } = require(path.join(REPO, 'remote', 'node_modules', 'ws'));
  const got = [];
  const srv = http.createServer((req, res) => {
    const p = srv.address().port;
    res.end(JSON.stringify([{ type: 'page', title: 'Reposo', url: 'http://127.0.0.1/idle.html', webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/1` }]));
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', c => c.on('message', d => {
    const m = JSON.parse(String(d));
    got.push(m);
    if (m.method === 'Page.navigate') setTimeout(() => c.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} })), 20);
    const value = m.method === 'Runtime.evaluate' ? (m.params.expression === 'location.href' ? 'http://x/' : 42) : undefined;
    c.send(JSON.stringify({ id: m.id, result: m.method === 'Runtime.evaluate' ? { result: { value } } : {} }));
  }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = String(srv.address().port);
  const cli = args => new Promise(res => {
    const { execFile } = require('node:child_process');
    execFile(process.execPath, [path.join(REPO, 'scripts', 'cdp.js'), '--port', port, ...args], (e, out, err) => res({ code: e ? e.code : 0, out, err }));
  });
  try {
    const tabs = await cli(['tabs']);
    assert.equal(tabs.code, 0, tabs.err);
    assert.match(tabs.out, /^0\tpage\tReposo\thttp:\/\/127\.0\.0\.1\/idle\.html$/m);
    const ev = await cli(['eval', '6*7']);
    assert.equal(ev.code, 0, ev.err);
    assert.equal(ev.out.trim(), '42');
    const nav = await cli(['nav', 'https://example.com/']);
    assert.equal(nav.code, 0, nav.err);
    assert.ok(got.some(m => m.method === 'Page.navigate' && m.params.url === 'https://example.com/'));
    assert.match(nav.out, /url: http:\/\/x\//);
    const bad = await cli(['borra']);
    assert.equal(bad.code, 2);
  } finally {
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise(r => srv.close(r));
  }
});
