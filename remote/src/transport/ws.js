'use strict';
// @ts-check
// WebSocket: el canal del mando (/ws, con token), y los canales locales de la tele (/idle-ws del reposo y /stage-ws
// del escenario, sin token pero solo desde el propio Chrome). En /ws, además de órdenes JSON, llegan líneas cortas:
// «p<ts>» (eco para medir latencia) y las del puntero («m dx dy», «w dx dy», «c 1», «b 1 1»…).
const { WebSocketServer, WebSocket } = require('ws');
const { clientIp, isLocalTV, cookieTok } = require('./http-util');

const OPTS = { noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 };

/** Los servidores WebSocket se crean pronto (otros módulos necesitan ver los clientes); se cablean con wire(). */
function createWs() {
  const wss = new WebSocketServer(OPTS);
  const stageWss = new WebSocketServer(OPTS);
  let beat = null;

  /**
   * @param {{
   *   log: { info: Function },
   *   limiter: { blocked: (ip: string) => boolean, fail: (ip: string) => void },
   *   auth: { okToken: (t: any) => boolean, tokenDev: (t: any) => any },
   *   run: (m: any, ws: any) => Promise<any>,
   *   local: Record<string, (req: any, socket: any, head: any) => void>,   // canales de la tele: ruta -> upgrade
   *   onStageSocket: (ws: any) => void,
   *   onLine: (s: string, ws: any) => void,                               // líneas que no son JSON ni eco
   *   greet: (ws: any) => any[],                                           // mensajes al conectarse un mando
   * }} d
   */
  function wire(d) {
    const local = { ...d.local, '/stage-ws': (req, socket, head) => stageWss.handleUpgrade(req, socket, head, ws => stageWss.emit('connection', ws)) };
    stageWss.on('connection', ws => d.onStageSocket(ws));
    wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.on('error', () => {});
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const s = data.toString();
        const c = s.charCodeAt(0);
        if (c === 112) return ws.send(s);                                  // "p<ts>": eco para medir latencia
        if (c === 123) {
          let m; try { m = JSON.parse(s); } catch { return; }
          return void d.run(m, ws).then(r => { // con `id`, el resultado vuelve a quien lo pidió (sin imágenes)
            if (m.id !== undefined && ws.readyState === WebSocket.OPEN && !(r && r.data)) ws.send(JSON.stringify({ t: 'res', id: m.id, r }));
          }).catch(() => {});
        }
        d.onLine(s, ws);
      });
      for (const msg of d.greet(ws)) ws.send(JSON.stringify(msg));
      d.log.info('cliente conectado', clientIp(req));
    });
    return function onUpgrade(req, socket, head) {
      const ip = clientIp(req);
      const url = new URL(req.url, 'http://x');
      if (local[url.pathname]) {
        if (!isLocalTV(req)) return socket.destroy();
        return local[url.pathname](req, socket, head);
      }
      if (d.limiter.blocked(ip) || url.pathname !== '/ws') return socket.destroy();
      const tok = url.searchParams.get('t') || cookieTok(req);
      if (!d.auth.okToken(tok)) {
        d.limiter.fail(ip);
        return wss.handleUpgrade(req, socket, head, ws => ws.close(4001, 'token'));
      }
      const dev = d.auth.tokenDev(tok);
      wss.handleUpgrade(req, socket, head, ws => { ws.devId = dev ? dev.id : null; wss.emit('connection', ws, req); });
    };
  }

  return {
    wss, stageWss, wire,
    clients: () => wss.clients,
    /** latido: los mandos que no responden en 20 s se cierran */
    start() { beat = setInterval(() => { for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); } }, 20_000); },
    stop() { clearInterval(beat); },
  };
}

module.exports = { createWs };
