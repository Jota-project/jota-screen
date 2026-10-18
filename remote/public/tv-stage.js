// Runtime de las páginas del escenario de la tele.
//   tv.onData(fn)       fn(data) se llama al cargar y cada vez que el agente actualiza los datos
//   tv.emit(name, obj)  envía un evento al agente (lo lee con tv_events)
//   tv.close()          cierra el escenario y vuelve a lo que se veía antes
(() => {
  const tv = (window.tv = { data: null, _h: [], _q: [] });
  let ws;
  function open() {
    ws = new WebSocket('ws://' + location.host + '/stage-ws');
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'data') { tv.data = m.data; for (const f of tv._h) f(m.data); }
    };
    ws.onopen = () => { for (const s of tv._q.splice(0)) ws.send(s); };
    ws.onclose = () => setTimeout(open, 800);
  }
  tv.onData = f => { tv._h.push(f); if (tv.data) f(tv.data); };
  tv.emit = (name, payload) => {
    const s = JSON.stringify({ t: 'event', name, payload });
    if (ws && ws.readyState === 1) ws.send(s); else tv._q.push(s);
  };
  tv.close = () => tv.emit('__close');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') tv.close(); });
  open();
})();
