'use strict';
// Chrome falso: habla lo justo del protocolo CDP para que el servidor del mando se conecte, enganche una pestaña
// y le mande órdenes. Apunta todo lo que recibe (calls) y deja emitir eventos como si vinieran de la página.
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require(path.join(__dirname, '..', '..', 'remote', 'node_modules', 'ws'));

/**
 * @param {{ pages?: any[], evaluate?: (expr: string, msg: any) => any }} [o]
 */
async function startFakeCdp({ pages = [{ targetId: 'P1', type: 'page', url: 'https://example.com/', title: 'Página de prueba' }], evaluate = () => undefined } = {}) {
  const calls = [];
  let conn = null, connections = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/version') return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.address().port}/devtools/browser/fake` }));
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server: srv });
  const event = (method, params, sessionId) => conn && conn.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  wss.on('connection', c => {
    conn = c; connections++;
    c.on('message', d => {
      const m = JSON.parse(d.toString());
      calls.push(m);
      let result = {};
      switch (m.method) {
        case 'Target.setDiscoverTargets': setTimeout(() => pages.forEach(t => event('Target.targetCreated', { targetInfo: t })), 10); break;
        case 'Target.attachToTarget': result = { sessionId: 'S-' + m.params.targetId }; break;
        case 'Page.createIsolatedWorld': result = { executionContextId: 7 }; break;
        case 'Page.getNavigationHistory': result = { currentIndex: 1, entries: [{ id: 11, url: 'https://a/' }, { id: 12, url: 'https://b/' }, { id: 13, url: 'https://c/' }] }; break;
        case 'Runtime.evaluate': result = { result: { value: evaluate(m.params.expression, m) } }; break;
      }
      if (m.id) c.send(JSON.stringify({ id: m.id, result }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const fake = {
    port: srv.address().port, calls, event,
    connections: () => connections,
    find: method => calls.filter(c => c.method === method),
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const hit = calls.find(pred); if (hit) return hit;
        if (Date.now() - t0 > ms) throw new Error('el Chrome falso no recibió lo esperado');
        await new Promise(r => setTimeout(r, 20));
      }
    },
    disconnect() { if (conn) conn.terminate(); },
    close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(); srv.close(() => r()); }),
  };
  return fake;
}

module.exports = { startFakeCdp };
