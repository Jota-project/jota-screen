// «Isla» de Live Activities: píldora negra arriba en el centro que se expande cuando algo cambia.
// Funciona en el reposo y, inyectada por CDP, encima de cualquier web (también a pantalla completa).
// Solo usa createElement/textContent (algunas webs, como YouTube, prohíben innerHTML con Trusted Types).
// Los colores y medidas son los tokens de Jota Dusk (public/shared/tokens-tv.css): el servidor los antepone como texto en
// __TV_TOKENS (src/tv/tokens.js) y aquí van en :host, dentro del shadow DOM, sin pedir nada a la red desde la web ajena.
(function () {
  if (window.TVIsland) return; // ya inyectada en esta página: solo se vuelve a llamar a render()
  const TOK = typeof __TV_TOKENS === 'string' ? __TV_TOKENS : '';
  // iconos de trazo por tipo de actividad (los de las fichas del agente, src/features/agent-ui.js): [[etiqueta, atributos]]
  const ICONS = typeof __TV_ICONS === 'object' && __TV_ICONS ? __TV_ICONS : {};
  const u = n => `calc(${n} * var(--u))`;  // 1 px de la tele de 1920×1080 (--u, de los tokens)
  const CSS = `
:host{all:initial;${TOK}}
.row{position:fixed;top:max(${u(72)}, 6vh);left:50%;transform:translateX(-50%);transition:opacity .8s,left .55s var(--tv-ease);display:flex;align-items:flex-start;gap:${u(10)};
  font-family:var(--tv-sans);
  -webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1;color:var(--tv-text)}
/* con el panel del agente abierto (a la derecha, hasta ${u(640)} más su margen): centrada en lo que queda a la izquierda */
.row.side{left:calc((100vw - max(${u(96)}, 5vw) - ${u(672)}) / 2)}
.pill{position:relative;background:var(--tv-surface);border-radius:${u(30)};height:${u(60)};min-width:${u(260)};max-width:${u(360)};padding:0 ${u(14)} 0 ${u(10)};
  display:flex;align-items:center;gap:${u(14)};overflow:hidden;box-shadow:var(--tv-shadow-float);
  transition:height .55s var(--tv-ease),max-width .55s var(--tv-ease),min-width .55s var(--tv-ease),
  border-radius .55s var(--tv-ease),padding .55s var(--tv-ease);will-change:height,max-width}
.pill.exp{height:${u(120)};min-width:${u(720)};max-width:${u(780)};border-radius:${u(60)};padding:0 ${u(32)} 0 ${u(22)};gap:${u(20)}}
.ic svg,.mini .mi svg{width:58%;height:58%;fill:none;stroke:var(--a);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ic{flex:none;width:${u(42)};height:${u(42)};border-radius:50%;display:grid;place-items:center;font-size:${u(24)};line-height:1;
  background:color-mix(in srgb,var(--a) 22%,transparent);transition:width .55s var(--tv-ease),height .55s var(--tv-ease),font-size .55s}
.exp .ic{width:${u(76)};height:${u(76)};font-size:${u(38)}}
.tx{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.t{font-size:${u(24)};font-weight:500;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:font-size .55s}
.exp .t{font-size:${u(30)}}
.s{font-size:0;opacity:0;color:var(--tv-text-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .4s,font-size .55s}
.exp .s{font-size:${u(26)};opacity:1;margin-top:${u(4)}}
.v{flex:none;font-family:var(--tv-serif);font-size:${u(28)};font-weight:400;color:var(--a);letter-spacing:-.01em;display:flex;align-items:center;gap:${u(8)};transition:font-size .55s}
.exp .v{font-size:${u(48)};font-weight:380}
.ring{width:${u(32)};height:${u(32)};transform:rotate(-90deg);transition:width .55s,height .55s}
.exp .ring{width:${u(52)};height:${u(52)}}
.ring circle{fill:none;stroke-width:3.2}
.ring .bg{stroke:rgba(246,243,240,.14)}.ring .fg{stroke:var(--a);stroke-linecap:round;transition:stroke-dashoffset calc(var(--tv-tick) * .9) linear}
.bar{position:absolute;left:${u(18)};right:${u(18)};bottom:${u(10)};height:${u(3)};border-radius:var(--tv-track-radius);background:var(--tv-track-2);opacity:0;transition:opacity .4s}
.exp .bar.on{opacity:1}
.bar i{display:block;height:100%;width:0;border-radius:var(--tv-track-radius);background:var(--a);transition:width calc(var(--tv-tick) * .9) linear}
.done .ic{animation:pulse var(--tv-pulse) ease-in-out 3}
.done .v{animation:blink var(--tv-pulse) ease-in-out 3}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--a) 50%,transparent)}50%{box-shadow:0 0 0 ${u(10)} transparent}}
@keyframes blink{50%{opacity:.55}}
.mini{width:${u(60)};height:${u(60)};border-radius:50%;background:var(--tv-surface);display:grid;place-items:center;font-size:${u(24)};position:relative;
  box-shadow:var(--tv-shadow-float)}
.mini>.ring{position:absolute;inset:${u(4)};width:${u(52)};height:${u(52)};transform:rotate(-90deg)}
.mini .mi{display:grid;place-items:center;width:100%;height:100%}
.mini .mi svg{width:42%;height:42%}
.in{animation:in .6s var(--tv-ease) both}
.out{animation:out .35s ease-in both}
@keyframes in{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:none}}
@keyframes out{to{opacity:0;transform:scale(.6)}}
`;
  const NS = 'http://www.w3.org/2000/svg';
  let host, root, row, list = [], off = 0, timer = null, dim = 1, side = false;
  // si la capa del agente ya pidió apartarla antes de que existiera (talk-view.js la deja en __tvIslandDim), se respeta
  if (Array.isArray(window.__tvIslandDim)) { dim = Number(window.__tvIslandDim[0]) || 0; side = !!window.__tvIslandDim[1]; }
  const nodes = new Map();   // id -> {el, kind:'pill'|'mini'}
  const expUntil = new Map(); // id -> ms
  const seen = new Map();     // id -> updated

  function ensure() {
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (host && host.isConnected && host.parentNode === parent) return;
    if (host) host.remove();
    nodes.clear();
    host = document.createElement('div');
    host.id = '__tvisland';
    host.style.cssText = 'position:fixed;inset:0 0 auto 0;height:0;z-index:2147483647;pointer-events:none;overflow:visible';
    root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
    row = document.createElement('div'); row.className = side ? 'row side' : 'row'; row.style.opacity = dim; root.appendChild(row);
    parent.appendChild(host);
  }
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  function ring(r) {
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 40 40'); s.setAttribute('class', 'ring');
    for (const c of ['bg', 'fg']) {
      const k = document.createElementNS(NS, 'circle');
      k.setAttribute('cx', '20'); k.setAttribute('cy', '20'); k.setAttribute('r', String(r)); k.setAttribute('class', c);
      if (c === 'fg') { const L = 2 * Math.PI * r; k.style.strokeDasharray = L; k.style.strokeDashoffset = L; }
      s.appendChild(k);
    }
    return s;
  }
  const fmt = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  };
  function frac(a, now) {
    if (a.done) return 1;
    if (a.endsAt && a.duration) return Math.min(1, Math.max(0, 1 - (a.endsAt + off - now) / a.duration));
    return a.progress == null ? null : a.progress;
  }
  function valText(a, now) {
    if (a.done) return a.endsAt ? '0:00' : (a.value || '✓');
    if (a.endsAt) return fmt(a.endsAt + off - now);
    if (a.startAt) return fmt(now - (a.startAt + off));
    if (a.value) return a.value;
    if (a.progress != null) return Math.round(a.progress * 100) + '%';
    return '';
  }
  function buildPill(a) {
    const p = el('div', 'pill in');
    const ic = el('div', 'ic');
    const tx = el('div', 'tx'); tx.append(el('div', 't'), el('div', 's'));
    const v = el('div', 'v'); v.append(el('span', 'vt'), ring(16));
    const bar = el('div', 'bar'); bar.append(el('i'));
    p.append(ic, tx, v, bar);
    return p;
  }
  function buildMini(a) {
    const m = el('div', 'mini in');
    m.append(el('span', 'mi'));
    m.append(ring(17));
    return m;
  }
  /** El icono de su tipo (trazo, en el color de la actividad) o, si no tiene, el emoji que mandó el agente. Solo se
   *  rehace si cambia. */
  function setIcon(box, a) {
    const p = ICONS[a.kind], key = p ? 'k:' + a.kind : 'e:' + (a.icon || '•');
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    if (!p) { box.textContent = a.icon || '•'; return; }
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    for (const [tag, at] of p) { const n = document.createElementNS(NS, tag); for (const k in at) n.setAttribute(k, String(at[k])); s.appendChild(n); }
    box.replaceChildren(s);
  }
  function setRing(svg, f) {
    const c = svg && svg.querySelector('circle:last-child'); if (!c) return;
    const L = 2 * Math.PI * Number(c.getAttribute('r'));
    svg.style.display = f == null ? 'none' : '';
    c.style.strokeDashoffset = f == null ? L : L * (1 - f);
  }
  function update() {
    ensure();
    const now = Date.now();
    const want = list.map((a, i) => ({ a, kind: i === 0 ? 'pill' : 'mini' })).slice(0, 4);
    const ids = new Set(want.map(w => w.a.id));
    for (const [id, n] of nodes) if (!ids.has(id) || want.find(w => w.a.id === id).kind !== n.kind) {
      nodes.delete(id); const e = n.el; e.classList.remove('in'); e.classList.add('out'); setTimeout(() => e.remove(), 340);
    }
    want.forEach(({ a, kind }, i) => {
      let n = nodes.get(a.id);
      if (!n) { n = { el: kind === 'pill' ? buildPill(a) : buildMini(a), kind }; nodes.set(a.id, n); }
      const e = n.el;
      if (e.parentNode !== row || row.children[i] !== e) row.insertBefore(e, row.children[i] || null);
      e.style.setProperty('--a', a.accent || 'var(--tv-accent)');
      const f = frac(a, now);
      if (kind === 'pill') {
        setIcon(e.querySelector('.ic'), a);
        e.querySelector('.t').textContent = a.title;
        e.querySelector('.s').textContent = a.subtitle || '';
        e.querySelector('.vt').textContent = valText(a, now);
        setRing(e.querySelector('.v svg'), (a.endsAt || a.progress != null || a.done) && !a.startAt ? f : null);
        const bar = e.querySelector('.bar'); bar.classList.toggle('on', f != null); bar.firstChild.style.width = ((f || 0) * 100) + '%';
        e.classList.toggle('exp', a.done || (expUntil.get(a.id) || 0) > now);
        e.classList.toggle('done', !!a.done);
      } else {
        setIcon(e.querySelector('.mi'), a);
        setRing(e.querySelector('.ring'), f);   // el anillo, no el icono
      }
    });
    clearTimeout(timer);
    if (list.length) timer = setTimeout(update, 1000 - (Date.now() % 1000) + 20);
  }
  window.TVIsland = {
    render(acts, srvNow) {
      off = srvNow ? Date.now() - srvNow : 0;
      list = Array.isArray(acts) ? acts : [];
      const now = Date.now();
      for (const a of list) { // se expande al aparecer o al cambiar (salvo `quiet`)
        if (seen.get(a.id) !== a.updated) { if (!a.quiet || !seen.has(a.id)) expUntil.set(a.id, now + 6000); seen.set(a.id, a.updated); }
      }
      for (const id of [...seen.keys()]) if (!list.find(a => a.id === id)) { seen.delete(id); expUntil.delete(id); }
      update();
      if (!list.length) setTimeout(() => { if (!list.length && host) { host.remove(); host = null; nodes.clear(); } }, 500);
    },
    /** Opacidad de la isla y, con `aside`, a la izquierda del panel del agente (que va a la derecha). */
    dim(x, aside) { dim = x; side = !!aside; if (row) { row.style.opacity = x; row.classList.toggle('side', side); } },
  };
  document.addEventListener('fullscreenchange', () => { if (list.length) { host && host.remove(); host = null; update(); } });
})();
