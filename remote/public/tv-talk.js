// Conversación con Jota en la tele: lo que dices y lo que contesta, en directo, encima de cualquier web (también a
// pantalla completa). La inyecta el servidor por CDP una vez por página (src/tv/talk-view.js) y luego solo llama a
// render({ mode, lines, live }) y hide(). Dos formatos: `island` (hay vídeo: arriba en el centro, donde la isla de
// actividades, con tu frase encima y la respuesta debajo, 3 líneas como mucho) y `panel` (columna a la derecha con las
// últimas frases; las anteriores atenuadas y la actual con cursor mientras Jota habla).
// Como tv-island.js: shadow DOM, solo createElement/textContent (Trusted Types) y los tokens de Jota Dusk en __TV_TOKENS.
// Los estilos van en una hoja construida (adoptedStyleSheets): la CSP de algunas páginas (el reposo) bloquea <style>.
(function () {
  if (window.TVTalk) return; // ya inyectada en esta página
  const TOK = typeof __TV_TOKENS === 'string' ? __TV_TOKENS : '';
  const CSS = `
:host{all:initial;${TOK}}
.w{font-family:var(--tv-sans);color:var(--tv-text);-webkit-font-smoothing:antialiased;transition:opacity .4s}
.w.gone{opacity:0}
.isl{position:fixed;top:40px;left:50%;transform:translateX(-50%);width:min(780px,calc(100vw - 80px));box-sizing:border-box;
  background:var(--tv-surface);border-radius:36px;padding:18px 32px 20px;box-shadow:var(--tv-shadow-float);
  display:flex;flex-direction:column;gap:6px;animation:in .5s var(--tv-ease) both}
.pan{position:fixed;top:32px;right:32px;bottom:32px;width:34%;box-sizing:border-box;
  background:color-mix(in srgb,var(--tv-surface) 94%,transparent);border-radius:32px;padding:26px 30px 30px;
  box-shadow:var(--tv-shadow-float);display:flex;flex-direction:column;animation:side .5s var(--tv-ease) both}
.hd{flex:none;display:flex;align-items:center;gap:10px;font-family:var(--tv-serif);font-size:24px;color:var(--tv-accent);margin-bottom:18px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--tv-accent)}
.live .dot{animation:pulse var(--tv-pulse) ease-in-out infinite}
.ls{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:14px;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,black 60px);mask-image:linear-gradient(to bottom,transparent 0,black 60px)}
.l{line-height:1.3;letter-spacing:-.005em;overflow-wrap:anywhere;transition:opacity .4s}
.you{font-size:21px;color:var(--tv-text-soft)}
.jota{font-size:25px}
.isl .l{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.isl .you{font-size:20px}
.isl .jota{font-size:26px}
.old{opacity:.42}
.cur:after{content:"";display:inline-block;width:3px;height:1em;margin-left:4px;vertical-align:-.12em;border-radius:2px;
  background:var(--tv-accent);animation:caret 1s steps(1) infinite}
.wait{color:var(--tv-text-soft)}
@keyframes caret{50%{opacity:0}}
@keyframes pulse{50%{opacity:.35}}
@keyframes in{from{opacity:0;transform:translateX(-50%) scale(.85)}to{opacity:1;transform:translateX(-50%)}}
@keyframes side{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
`;
  let host, root, box, last = null, goneT = null;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  function ensure() {
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (host && host.isConnected && host.parentNode === parent) return;
    if (host) host.remove();
    host = document.createElement('div');
    host.id = '__tvtalk';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible';
    root = host.attachShadow({ mode: 'open' }); // (en el host nuevo el marco se vuelve a crear)
    try { const sh = new CSSStyleSheet(); sh.replaceSync(CSS); root.adoptedStyleSheets = [sh]; }
    catch { const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st); }
    box = el('div', 'w'); root.appendChild(box);
    parent.appendChild(host);
  }
  // el marco (isla o panel) se crea una vez por formato: así la animación de entrada no se repite con cada palabra
  function frame(mode) {
    if (box.firstChild && box.firstChild.dataset.mode === mode) return box.firstChild;
    box.replaceChildren();
    const p = el('div', mode === 'island' ? 'isl' : 'pan');
    p.dataset.mode = mode;
    if (mode === 'panel') { const hd = el('div', 'hd'); hd.append(el('span', 'dot'), el('span', null, 'Jota')); p.append(hd, el('div', 'ls')); }
    box.appendChild(p);
    return p;
  }
  function draw() {
    const { mode, lines, live } = last;
    ensure();
    box.className = 'w' + (live ? ' live' : '');
    if (mode === 'island' && !lines.length) { box.replaceChildren(); return; } // aún no hay nada que decir
    const ls = lines.slice();
    // mientras Jota piensa, un hueco con cursor para la respuesta
    if (live && (!ls.length || ls[ls.length - 1].who === 'you')) ls.push({ who: 'jota', text: '', wait: true });
    const f = frame(mode);
    const list = mode === 'island' ? f : f.querySelector('.ls');
    let start = 0; // la conversación actual empieza en tu última frase; lo anterior va atenuado
    if (mode === 'panel') for (let i = ls.length - 1; i >= 0; i--) if (ls[i].who === 'you') { start = i; break; }
    list.replaceChildren(...ls.map((x, i) => { const e = line(x, live && i === ls.length - 1); if (i < start) e.classList.add('old'); return e; }));
  }
  const line = (x, cur) => el('div', 'l ' + (x.who === 'you' ? 'you' : 'jota') + (cur ? ' cur' : '') + (x.wait ? ' wait' : ''), String(x.text || ''));
  window.TVTalk = {
    render(o) {
      clearTimeout(goneT); goneT = null;
      last = { mode: o && o.mode === 'island' ? 'island' : 'panel', lines: Array.isArray(o && o.lines) ? o.lines : [], live: !!(o && o.live) };
      draw();
    },
    hide() {
      last = null;
      if (!host) return;
      box.classList.add('gone');
      clearTimeout(goneT);
      goneT = setTimeout(() => { if (!last && host) { host.remove(); host = null; } }, 450);
    },
  };
  document.addEventListener('fullscreenchange', () => { if (last) { host && host.remove(); host = null; draw(); } });
})();
