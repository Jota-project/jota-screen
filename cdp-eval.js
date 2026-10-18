// Uso: node cdp-eval.js "<expresión JS>"  -> imprime el resultado de evaluarla en la pestaña activa
const http = require('http');
const get = u => new Promise((r, j) => http.get(u, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d))); }).on('error', j));
(async () => {
  const tabs = await get('http://127.0.0.1:9222/json');
  const page = tabs.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  await new Promise(r => ws.onopen = r);
  const r = await send('Runtime.evaluate', { expression: process.argv[2], awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? r));
  ws.close(); process.exit(0);
})();
