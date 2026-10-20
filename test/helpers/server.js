'use strict';
// Arranca el servidor del mando de verdad, pero aislado: copia de remote/ en una carpeta temporal,
// HOME temporal, estado en <tmp>/state (TV_STATE_DIR), puerto libre, sin Chrome (CDP a un puerto cerrado), sin puntero X
// y con un agente falso. Sin TV_LAT/TV_LON, así que el reposo no sale a internet a por el tiempo.
// Así las pruebas comprueban el contrato desde fuera (HTTP y WebSocket) y valen igual antes y después de refactorizar.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const REMOTE = path.join(__dirname, '..', '..', 'remote');
const WS = require(path.join(REMOTE, 'node_modules', 'ws'));

const freePort = () => new Promise((ok, ko) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }).on('error', ko);
});

function copyRemote(dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(REMOTE)) {
    if (['node_modules', 'token', 'devices.json', 'spotify.json', 'idle.json', 'access.json'].includes(f)) continue;
    fs.cpSync(path.join(REMOTE, f), path.join(dst, f), { recursive: true });
  }
  fs.symlinkSync(path.join(REMOTE, 'node_modules'), path.join(dst, 'node_modules'), 'dir');
}

/**
 * @param {{ files?: object, cdpPort?: number, env?: object, legacy?: boolean }} [o]
 *   files: estado inicial, { 'spotify.json': {...} }, en TV_STATE_DIR (o, con legacy, donde estaba antes: junto a server.js)
 *   cdpPort: puerto de un Chrome falso (test/helpers/fake-cdp.js); env: variables de más (TV_NAME…)
 */
async function start({ files = {}, cdpPort, env = {}, legacy = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-test-'));
  const root = path.join(tmp, 'remote');
  const state = path.join(tmp, 'state');
  copyRemote(root);
  const dir = legacy ? root : state;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v), { mode: 0o600 });
  const port = await freePort();
  const out = [];
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: tmp, TV_PORT: String(port), TV_CDP_PORT: String(cdpPort || await freePort()),
      TV_NO_POINTER: '1', TV_OPENCLAW: '/bin/false', XDG_RUNTIME_DIR: tmp, TV_STATE_DIR: state, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => out.push(d.toString()));
  proc.stderr.on('data', d => out.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { // hasta 10 s para que escuche
    try { await fetch(base + '/index.html'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const srv = {
    base, port, token, root, state, home: tmp, logs: () => out.join(''),
    async stop() { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); fs.rmSync(tmp, { recursive: true, force: true }); },
    get: (p, opts = {}) => fetch(base + p, opts),
    api: (p, tok = token, opts = {}) => fetch(base + p, { ...opts, headers: { Authorization: 'Bearer ' + tok, ...(opts.headers || {}) } }),
    post: (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    ws: tok => openWs(`ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(tok)}`),
  };
  return srv;
}

// Cliente WebSocket con rpc(id) y espera de mensajes por tipo
function openWs(url) {
  return new Promise((ok, ko) => {
    const ws = new WS(url);
    const seen = [], waiters = [];
    let seq = 0;
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      seen.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.ok(m); }
    });
    ws.on('close', (code, reason) => { ws.closed = { code, reason: reason.toString() }; });
    ws.on('error', ko);
    const c = {
      raw: ws, seen,
      wait(pred, ms = 3000) {
        const hit = seen.find(pred); if (hit) return Promise.resolve(hit);
        return new Promise((y, n) => { const w = { pred, ok: y }; waiters.push(w); setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); n(new Error('timeout esperando mensaje')); } }, ms); });
      },
      async rpc(m) { const id = ++seq; ws.send(JSON.stringify({ ...m, id })); return (await c.wait(x => x.t === 'res' && x.id === id)).r; },
      close() { ws.close(); },
    };
    ws.on('open', () => ok(c));
    ws.on('close', code => { if (code === 4001) ok(c); });
  });
}

module.exports = { start };
