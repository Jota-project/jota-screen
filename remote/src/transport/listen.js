'use strict';
// @ts-check
// Dónde escucha el mando: bucle local, red privada y Tailscale (nunca una IP pública ni las redes de Docker).
const http = require('node:http');
const os = require('node:os');

function bindAddrs(ifaces = os.networkInterfaces()) {
  const out = new Set(['127.0.0.1']);
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(lo|docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [p, q] = a.address.split('.').map(Number);
      const priv = p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q <= 31) || (p === 100 && q >= 64 && q <= 127);
      if (priv) out.add(a.address);
    }
  }
  return [...out];
}

/** @param {{ port: number, handler: any, onUpgrade: any, log: { info: Function, error: Function } }} o */
function listen({ port, handler, onUpgrade, log }) {
  return bindAddrs().map(addr => {
    const s = http.createServer(handler);
    s.on('upgrade', onUpgrade);
    s.on('error', e => log.error('no se pudo escuchar en', addr, /** @type {any} */ (e).code));
    s.listen(port, addr, () => log.info(`escuchando en http://${addr}:${port}/ (token maestro en TV_STATE_DIR/token; nunca se escribe en el registro)`));
    return s;
  });
}

module.exports = { bindAddrs, listen };
