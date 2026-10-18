// Uso: node cdp-click.js "<regex del texto del botón>"
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
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  console.log('antes url:', await ev('location.href'));
  const re = JSON.stringify(process.argv[2]);
  const res = await ev(`(()=>{const re=new RegExp(${re},'i');const els=[...document.querySelectorAll('button,[role=button],a')];const b=els.find(e=>re.test((e.innerText||e.getAttribute('aria-label')||'').trim()));if(!b)return 'no_encontrado: '+els.slice(0,15).map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,30)).filter(Boolean).join(' | ');b.click();return 'click: '+(b.innerText||b.getAttribute('aria-label')).trim();})()`);
  console.log(res);
  await new Promise(r => setTimeout(r, 3000));
  console.log('despues url:', await ev('location.href'));
  console.log('title:', await ev('document.title'));
  ws.close(); process.exit(0);
})();
