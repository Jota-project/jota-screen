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
  await send('Page.navigate', { url: process.argv[2] || 'https://www.youtube.com' });
  await new Promise(r => setTimeout(r, 6000));
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  console.log('url:', await ev('location.href'));
  console.log('title:', await ev('document.title'));
  console.log('widevine:', await ev(`navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"',robustness:'SW_SECURE_DECODE'}]}]).then(()=>'ok').catch(e=>'fail: '+e.message)`));
  ws.close(); process.exit(0);
})();
