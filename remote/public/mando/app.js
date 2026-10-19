'use strict';
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ── acceso: cada dispositivo tiene su propio token (se recuerda aquí y en una cookie). El maestro no se guarda nunca. ── */
const qs = new URLSearchParams(location.search);
let token = qs.get('t') || store.get('token', '');
const adminCode = (/[#&]admin=([0-9A-Za-z-]{6,24})/.exec(location.hash) || [])[1] || '';
if (qs.has('t') || adminCode) { qs.delete('t'); const q = qs.toString(); history.replaceState(null, '', location.pathname + (q ? '?' + q : '')); }
function addManifest() {
  if (!token || document.querySelector('link[rel=manifest]')) return;
  const m = document.createElement('link'); m.rel = 'manifest'; m.href = '/manifest.webmanifest?t=' + encodeURIComponent(token);
  document.head.appendChild(m);
}
function useToken(r) { token = r.token; store.set('token', token); store.set('devid', r.id); addManifest(); }
let pairNote = '';
async function settle() { // antes de conectar: canjea el código de admin o el token maestro y renueva la cookie
  if (adminCode) {
    const r = await post('/pair/admin', { code: adminCode, name: store.get('pname', '') || uaName(), cur: token });
    if (r.token) { useToken(r); setTimeout(() => pill('Ya eres administrador'), 600); return; }
    pairNote = r.error || 'No se pudo usar el enlace de administrador';
  }
  if (!token) return;
  const r = await post('/pair/me', { t: token });
  if (r.master) { // enlace maestro (o guardado por una versión anterior): se cambia por un dispositivo admin propio
    const master = token; store.set('token', ''); token = '';
    const q = await post('/pair/admin', { t: master, name: store.get('pname', '') || uaName() });
    if (q.token) useToken(q);
    return;
  }
  if (r.ok) { store.set('token', token); addManifest(); }
}

const cfg = Object.assign({ speed: 1.6, scroll: 1, natural: true, haptic: true, theme: 'oscuro', apps: ['spotify', 'netflix'] }, store.get('cfg', {}));

/* accesos del mando: salen de cfg.apps (M5 los hará configurables) */
const APPS = {
  spotify: { n: 'Spotify', at: { 'data-a': 'sp', 'data-click': '' }, svg: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>' },
  netflix: { n: 'Netflix', at: { 'data-url': 'https://www.netflix.com' }, svg: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7.5 4l3 5M13.5 4l3 5"/>' },
};
for (const k of Array.isArray(cfg.apps) ? cfg.apps : []) {
  const a = APPS[k]; if (!a) continue;
  const b = document.createElement('button'); b.className = 'b2'; b.setAttribute('aria-label', 'Abrir ' + a.n);
  for (const [n, v] of Object.entries(a.at)) b.setAttribute(n, v);
  b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a.svg}</svg>`;
  b.append(a.n); $('#apps2').appendChild(b);
}
function applyTheme() {                                // el <head> ya lo pone antes de pintar; esto lo cambia en caliente
  const light = cfg.theme === 'claro';
  document.documentElement.dataset.theme = light ? 'claro' : 'oscuro';
  document.querySelector('meta[name=theme-color]').content = light ? '#f6f3f0' : '#2a2433';
  document.querySelector('meta[name=color-scheme]').content = light ? 'light' : 'dark';
}
const saveCfg = () => store.set('cfg', cfg);
const buzz = n => { if (cfg.haptic && navigator.vibrate) navigator.vibrate(n || 8); };

/* ── conexión ── */
let ws, tries = 0, rtt = 0, lastState = null;
const dot = $('#dot'), t1 = $('#t1'), t2 = $('#t2');
const send = s => { if (ws && ws.readyState === 1) ws.send(s); };
const pend = new Map(); let rid = 0;
const rpc = o => new Promise(res => {                  // orden con respuesta (sin conexión, falla enseguida)
  if (!ws || ws.readyState !== 1) return res({ error: 'sin conexión' });
  const id = ++rid; pend.set(id, res); cmd({ ...o, id });
  setTimeout(() => { if (pend.delete(id)) res({ error: 'sin respuesta' }); }, 20000);
});
const cmd = o => send(JSON.stringify(o));

function paintDot() {
  const up = ws && ws.readyState === 1;
  dot.className = 'dot' + (up ? (rtt && rtt > 150 ? ' bad' : ' ok') : '');
  dot.setAttribute('aria-label', up ? 'Conectada' : 'Sin conexión');
}
/* tras varios intentos (o sin red) se dice «Sin conexión» y se puede reintentar a mano */
function offline2(on) { $('#sub2').hidden = on; $('#re2').hidden = !on; }
let retryT = 0;
let viaCookie = false;
async function connect() {
  clearTimeout(retryT);                                 // un solo intento a la vez (reintento a mano, visibilidad, temporizador)
  if (!token && !viaCookie) { // sin token guardado: quizá el navegador conserva la cookie de un emparejamiento anterior
    const r = await post('/pair/me', {});
    if (!r.ok) { showPair(); return; }
    if (r.master) { const q = await post('/pair/admin', { name: store.get('pname', '') || uaName() }); if (!q.token) { showPair(); return; } useToken(q); }
    else viaCookie = true;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws` + (token ? `?t=${encodeURIComponent(token)}` : ''));
  ws.onopen = () => { tries = 0; paintDot(); ping(); offline2(false); };
  ws.onmessage = e => {
    const d = e.data;
    if (d.charCodeAt(0) === 112) { const r = performance.now() - parseFloat(d.slice(1)); rtt = rtt ? rtt * 0.6 + r * 0.4 : r; paintDot(); return; }
    try { const j = JSON.parse(d); if (j.t === 'me') applyMe(j); else if (j.t === 'pairreq') showReq(j); else if (j.t === 'pairdone') hideReq(j.pid); else if (j.t === 'sp') { if (spOpen()) spPaint(j.now); } else if (j.t === 'ask') onAsk(j); else if (j.t === 'res') { const f = pend.get(j.id); if (f) { pend.delete(j.id); f(j.r || {}); } } else onState(j); } catch {}
  };
  ws.onclose = ev => {
    paintDot();
    if (ev.code === 4001 || ev.code === 4002) {
      store.set('token', ''); store.set('devid', ''); token = ''; viaCookie = false;
      showPair(ev.code === 4002 ? 'Tu acceso ha caducado. Pídelo de nuevo.' : 'No tienes acceso (o te lo han retirado). Pídelo de nuevo.'); return;
    }
    t1.textContent = 'Reconectando…'; t2.textContent = '';
    retryT = setTimeout(connect, Math.min(2000, 250 * ++tries));
    offline2(tries >= 4 || navigator.onLine === false);
  };
  ws.onerror = () => {};
  ws.addEventListener('message', e => { if (e.data.startsWith('{"t":"focus"')) try { onTvFocus(JSON.parse(e.data)); } catch {} }); // campo con foco en la tele
  ws.addEventListener('open', kbOnline); ws.addEventListener('close', () => kbPaint());
}
function ping() { if (ws && ws.readyState === 1 && !document.hidden) send('p' + performance.now()); }
setInterval(ping, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && (!ws || ws.readyState > 1)) connect(); });
$('#re2').addEventListener('click', () => { buzz(8); if (ws && ws.readyState <= 1) return; tries = 0; t1.textContent = 'Reconectando…'; offline2(false); connect(); });

let pillT;
function pill(txt) { const p = $('#pill'); p.textContent = txt; p.classList.add('on'); clearTimeout(pillT); pillT = setTimeout(() => p.classList.remove('on'), 1100); }
function onState(s) {
  if (s.t !== 'state') return;
  if (!s.cdp) { t1.textContent = 'Navegador no disponible'; t2.textContent = ''; }
  else if (!s.host) { t1.textContent = 'Inicio'; t2.textContent = ''; }
  else { t1.textContent = s.title || s.host; t2.textContent = s.host; }
  $('#pp').dataset.m = s.media;
  paint2(s);                                            // el volumen se ve en el balancín: sin aviso flotante
  lastState = s;
}
/* v2: número de volumen (el % real del servidor), silencio, play/pausa y carril con el scroll de la página de la tele */
function paint2(s) {
  const v = $('#vol2'), m = $('#mute2'), off = !!s.muted || typeof s.vol !== 'number';
  v.textContent = off ? '–' : String(s.vol); v.classList.toggle('off', off);
  v.setAttribute('aria-label', s.muted ? 'Volumen silenciado' : off ? 'Volumen desconocido' : 'Volumen ' + s.vol + ' %');
  m.setAttribute('aria-pressed', !!s.muted); m.setAttribute('aria-label', s.muted ? 'Activar sonido' : 'Silenciar');
  $('#pp').setAttribute('aria-label', s.media === 1 ? 'Pausar' : s.media === 0 ? 'Reproducir' : 'Reproducir o pausar');
  const sc = s.scroll, rail = $('#rail');
  rail.hidden = !sc;                                    // sin dato (o página sin scroll), sin carril
  if (sc) {
    const h = Math.max(0.08, Math.min(1, +sc.size || 0)), th = $('#railT');
    th.style.top = (Math.min(1, Math.max(0, +sc.pos || 0)) * (1 - h) * 100).toFixed(2) + '%'; th.style.height = (h * 100).toFixed(2) + '%';
  }
}

/* ── touchpad ── */
const pad = $('#pad'), hint = $('#hint');
const P = new Map();
let ax = 0, ay = 0, sxa = 0, sya = 0, raf = 0;
let downT = 0, moved = 0, maxN = 0, twoT = 0, twoMoved = 0, rcDone = false, dragging = false, tdArm = false, lastTap = 0;
let svy = 0, inertia = 0;
const r2 = n => Math.round(n * 100) / 100;
/* un halo malva sigue al dedo mientras toca (en vez de la onda) y la ayuda se esconde solo mientras se toca */
const halo = $('#halo');
let haloId = null;
function haloAt(e) { const b = pad.getBoundingClientRect(); halo.style.left = (e.clientX - b.left) + 'px'; halo.style.top = (e.clientY - b.top) + 'px'; }

function flush() {
  raf = 0;
  if (ax || ay) { send('m ' + r2(ax) + ' ' + r2(ay)); ax = ay = 0; }
  if (sxa || sya) { send('w ' + r2(sxa) + ' ' + r2(sya)); sxa = sya = 0; }
}
const sched = () => { if (!raf) raf = requestAnimationFrame(flush); };
function stopInertia() { if (inertia) { cancelAnimationFrame(inertia); inertia = 0; } }
function startInertia() {
  stopInertia();
  let v = svy;                                   // px por ms ya con el signo final
  if (Math.abs(v) < 0.35) return;
  let last = performance.now();
  const step = t => {
    const dt = Math.min(40, t - last); last = t;
    sya += v * dt; v *= Math.pow(0.0035, dt / 1000);   // frena en ~0,9 s
    sched();
    inertia = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
  };
  inertia = requestAnimationFrame(step);
}
function click(btn, p) { send('c ' + btn); buzz(btn === 3 ? 14 : 9); }

pad.addEventListener('pointerdown', e => {
  e.preventDefault();
  try { pad.setPointerCapture(e.pointerId); } catch {}
  P.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (haloId === null) { haloId = e.pointerId; haloAt(e); halo.classList.add('on'); } hint.classList.add('off');
  if (P.size === 1) {
    stopInertia(); downT = e.timeStamp; moved = 0; maxN = 1; dragging = false; svy = 0;
    tdArm = e.timeStamp - lastTap < 240; pad.classList.add('on');
  } else if (P.size === 2) { maxN = 2; twoT = e.timeStamp; twoMoved = 0; rcDone = false; svy = 0; }
});
pad.addEventListener('pointermove', e => {
  const p = P.get(e.pointerId); if (!p) return;
  if (e.pointerId === haloId) haloAt(e);
  const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
  p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
  if (P.size === 1) {
    moved += Math.abs(dx) + Math.abs(dy);
    if (tdArm && !dragging && moved > 6) { dragging = true; send('b 1 1'); }
    const g = cfg.speed * (1 + Math.min(Math.hypot(dx, dy) / dt / 1.1, 2.6));   // aceleración según la velocidad
    ax += dx * g; ay += dy * g; sched();
  } else if (P.size === 2) {
    twoMoved += Math.abs(dx) + Math.abs(dy);
    const k = (cfg.natural ? -1 : 1) * cfg.scroll * 0.5;                          // cada dedo aporta la mitad
    sxa += dx * k; sya += dy * k; sched();
    svy = svy * 0.6 + (dy * k / dt) * 0.4;
  }
});
function up(e) {
  const p = P.get(e.pointerId); if (!p) return;
  const n = P.size; P.delete(e.pointerId);
  const ok = e.type === 'pointerup';
  if (e.pointerId === haloId) {                   // el halo pasa al dedo que queda o se apaga
    const rest = P.keys().next();
    haloId = rest.done ? null : rest.value;
    if (haloId === null) { halo.classList.remove('on'); hint.classList.remove('off'); }
  }
  if (n === 1) {
    pad.classList.remove('on');
    if (dragging) { send('b 1 0'); dragging = false; }
    else if (ok && maxN === 1 && e.timeStamp - downT < 240 && moved < 9) { click(1, p); lastTap = e.timeStamp; }
    maxN = 0;
  } else if (n === 2) {
    if (ok && !rcDone && e.timeStamp - twoT < 280 && twoMoved < 10) { rcDone = true; click(3, p); }
    else if (twoMoved > 14) startInertia();
  }
}
pad.addEventListener('pointerup', up);
pad.addEventListener('pointercancel', up);
pad.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (!e.target.closest('.sheet,.pairV')) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());

/* ── botones ── */
const ACT = {
  home: () => cmd({ t: 'home' }), back: () => cmd({ t: 'back' }), fwd: () => cmd({ t: 'forward' }), reload: () => cmd({ t: 'reload' }),
  fs: () => cmd({ t: 'fs' }), pp: () => cmd({ t: 'pp' }),
  skb: () => cmd({ t: 'key', k: 'ArrowLeft' }), skf: () => cmd({ t: 'key', k: 'ArrowRight' }),
  vd: () => cmd({ t: 'vol', d: 'down' }), vu: () => cmd({ t: 'vol', d: 'up' }), vm: () => cmd({ t: 'vol', d: 'mute' }),
  s10b: () => seek10(-10), s10f: () => seek10(10),
};
/* ±10 s (v2): mueve el vídeo de la página; si no hay <video>, la flecha como en el v1 */
function seek10(s) { rpc({ t: 'seek', s }).then(r => { if (r && r.error) cmd({ t: 'key', k: s < 0 ? 'ArrowLeft' : 'ArrowRight' }); }); }
function fire(b) {
  const a = b.dataset.a;
  if (b.dataset.url) return cmd({ t: 'nav', url: b.dataset.url });
  if (a && a.startsWith('k:')) return cmd({ t: 'key', k: a.slice(2) });
  if (ACT[a]) ACT[a]();
}
let repT = 0, repI = 0, cur = null;
function stopRep() { clearTimeout(repT); clearInterval(repI); if (cur) { cur.classList.remove('dn'); cur = null; } }
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.bt,.b2'); if (!b || b.hasAttribute('data-click') || !(b.dataset.a || b.dataset.url)) return;
  e.preventDefault();                                   // no robar el foco al campo de texto
  stopRep(); cur = b; b.classList.add('dn'); buzz(7); fire(b);
  if (b.hasAttribute('data-rep')) repT = setTimeout(() => { repI = setInterval(() => fire(b), 85); }, 380);
});
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, stopRep));
document.addEventListener('mousedown', e => { if (e.target.closest('.kbK,.kbA')) e.preventDefault(); });
document.addEventListener('contextmenu', e => e.preventDefault());

/* ── hojas ── */
const spin = $('#spin'), shade = $('#shade'), gin = $('#gin'), agin = $('#agin'), rep = $('#rep');
let sheet = null;
function openSheet(id) {
  closeSheet();
  sheet = $('#' + id); sheet.classList.add('on'); shade.classList.add('on');
  if (id === 'kbS') kbOpen();
  if (id === 'goS') { gin.value = ''; gin.focus(); }
  if (id === 'agS') { agin.value = ''; agin.focus(); }
  if (id === 'spS') { spin.value = ''; }
}
function closeSheet() {
  if (!sheet) return;
  if (sheet.id === 'spS') cmd({ t: 'spwatch', on: false });
  if (sheet.id === 'kbS') kbClose();
  sheet.classList.remove('on'); shade.classList.remove('on');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  sheet = null;
}
shade.addEventListener('pointerdown', e => { e.preventDefault(); closeSheet(); });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-click]'); if (!b) return;
  buzz(7);
  ({ kb: () => openSheet('kbS'), go: () => openSheet('goS'), ag: () => openSheet('agS'), sp: spButton, more: () => { refreshSet(); if (ME && ME.role === 'admin') { refreshDevs(); idleLoad(); } openSheet('setS'); } })[b.dataset.a]();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet && !(sheet.id === 'kbS' && sheet.contains(document.activeElement))) closeSheet(); });
const vv = window.visualViewport;
if (vv) {                                              // subir la hoja por encima del teclado del móvil
  const upd = () => document.documentElement.style.setProperty('--kb', Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px');
  vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd);
}

/* escribir en la tele: el móvil tiene su propio editor y en cada cambio manda el texto entero y la selección
   (agrupado por fotograma); la tele lo aplica al campo con foco. De una contraseña, la tele nunca manda el valor. */
const kbV = $('#kbS'), kbTa = $('#kbTa'), kbPw = $('#kbPw'), kbPwB = $('#kbPwB'), kbE = $('#kbE');
let tvF = { kind: 'none', placeholder: '' };            // último foco que ha avisado la tele
let fSeq = 0, fAck = 0, fRaf = 0, fT = 0, fHold = false, fLast = '', fComp = false, fTyped = 0, fOk = null, fErr = '', fBlind = false;
let fSynced = false;                                     // ¿el editor tiene lo mismo que el campo de la tele? Si no, no se manda hasta que se escriba
const kbOn = () => kbV.classList.contains('on');
const kbEd = () => kbPwB.hidden ? kbTa : kbPw;
function kbMode(pw) {                                    // contraseña <-> texto; el foco pasa al editor que toque
  if (pw === !kbPwB.hidden) return;
  const had = document.activeElement === kbTa || document.activeElement === kbPw;
  kbPwB.hidden = !pw; kbTa.hidden = pw;
  kbPw.value = ''; kbPw.type = 'password'; kbRvPaint();
  $('#kbL').htmlFor = pw ? 'kbPw' : 'kbTa';
  if (had) kbEd().focus();
}
function kbFill(j, replace) {                            // pone en el editor lo que hay en el campo de la tele
  if (j.kind === 'none') return;                         // sin campo: el editor se queda como está
  kbMode(j.kind === 'password');
  if (!replace) return;
  // la tele no manda lo escrito (invitados, vista cerrada) ni el de una contraseña: el editor no sabe qué hay, así que
  // abrir o mover el cursor no manda nada (no se borra el campo); solo al escribir
  if (j.kind !== 'password' && !('value' in j)) { fSynced = false; return; }
  fSynced = j.kind !== 'password';
  const e = kbEd(), v = j.kind === 'password' ? '' : String(j.value);
  e.value = v;
  try { if (document.activeElement === e) e.setSelectionRange(v.length, v.length); } catch {}
  fLast = v.length + ':' + v.length + ':' + v.length + ':' + v; // ya está así en la tele: no hace falta mandarlo
}
function kbOpen() {
  kbEd().focus();                                        // dentro del toque: si no, iOS no abre el teclado
  kbFill(tvF, true); kbPaint();
  cmd({ t: 'focus', open: true });                       // el servidor manda lo que hay en el campo solo con la vista abierta
}
function kbClose() { kbPw.value = ''; kbPw.type = 'password'; kbRvPaint(); cmd({ t: 'focus', open: false }); }
function kbOnline() {                                    // al (re)conectar: lo escrito sin conexión se manda ahora
  fLast = ''; fAck = fSeq;
  if (kbOn()) { kbFlush(); cmd({ t: 'focus', open: true }); }
  kbPaint();
}
function onTvFocus(j) {
  // el aviso sin valor del mismo campo conserva lo que este mando ya había escrito
  tvF = 'value' in j || j.kind !== tvF.kind || j.placeholder !== tvF.placeholder || !('value' in tvF) ? j : { ...j, value: tvF.value };
  fOk = null; fBlind = false;
  // con la vista abierta se actualiza el editor, salvo que el usuario esté escribiendo (no se le pisa)
  if (kbOn()) kbFill(j, !(fComp || Date.now() - fTyped < 1500 || fAck < fSeq));
  kbPaint();
}
function kbPaint() {
  const pw = !kbPwB.hidden, v = kbEd().value, n = v.length;
  const none = fOk === false || (fOk === null && tvF.kind === 'none');
  const m = $('#tvM'), t = $('#tvT');
  m.classList.toggle('pw', pw); m.classList.toggle('none', none);
  const shown = none ? '' : pw ? '•'.repeat(Math.min(n, 40)) : (n > 60 ? '…' : '') + v.slice(-60).replace(/\s+/g, ' ');
  t.textContent = shown || (none ? 'Ningún campo seleccionado' : tvF.placeholder || (pw ? 'Contraseña' : 'Campo vacío'));
  t.classList.toggle('ph', !shown);
  m.setAttribute('aria-label', pw ? 'En la tele: contraseña oculta de ' + n + ' caracteres' : 'En la tele: ' + (none ? 'ningún campo' : v || 'campo vacío'));
  $('#kbN').textContent = n === 1 ? '1 carácter' : n + ' caracteres';
  kbE.classList.toggle('none', none);
  $('#kbL').textContent = none ? 'Toca un campo en la tele para escribir' : pw ? 'Contraseña, oculta en el móvil y en la tele' : 'Escribe, borra y corrige aquí';
  const st = $('#kbSt'), up = ws && ws.readyState === 1;
  const s = !up ? ['off', 'Sin conexión'] : fAck < fSeq ? ['busy', 'Enviando…'] : fErr ? ['off', 'No se ha podido escribir'] : none && fBlind ? ['off', 'Enviado sin ver el campo'] : none ? ['off', 'Sin campo en la tele'] : ['', 'Al día en la tele'];
  st.className = 'kbSt' + (s[0] ? ' ' + s[0] : ''); st.lastChild.textContent = s[1];
}
function kbSched() { if (!fRaf) { fRaf = requestAnimationFrame(kbFlush); fT = setTimeout(kbFlush, 120); } } // por fotograma (y por si no se pinta)
function kbFlush(force) {                                // manda el estado del editor si ha cambiado (texto o selección)
  if (fRaf) { cancelAnimationFrame(fRaf); clearTimeout(fT); fRaf = 0; }
  if (!fSynced) return;                                  // aún no se ha escrito nada sobre un campo desconocido
  if (!force && (fComp || fHold)) return;                // composición (IME, dictado) a medias: se manda al terminar
  const e = kbEd(), v = e.value, a = e.selectionStart ?? v.length, b = e.selectionEnd ?? a;
  const sig = v.length + ':' + a + ':' + b + ':' + v;
  if (sig === fLast) return;
  fLast = sig;
  const seq = ++fSeq; kbPaint();
  rpc({ t: 'field', value: v, selStart: a, selEnd: b, seq }).then(r => {
    fAck = Math.max(fAck, seq);
    if (seq === fSeq && !r.stale && !r.skipped) { fErr = r.error || ''; fOk = r.error ? fOk : r.blind ? null : !r.none; fBlind = !!r.blind; }
    if (r.ok && !r.skipped && (tvF.kind === 'text' || tvF.kind === 'search')) tvF = { ...tvF, value: v }; // al reabrir sale lo escrito (nunca una contraseña)
    kbPaint();
  });
}
function kbKey(k) {                                     // lo escrito llega antes que la tecla (el servidor la hace esperar)
  kbFlush(true); cmd({ t: 'key', k }); buzz(8);           // aunque haya una composición a medias: la última palabra va antes
  if (k === 'Tab' || k === 'Enter' || k === 'Escape') fTyped = 0; // cambiar de campo desde aquí no es estar escribiendo: que se rellene
}
for (const e of [kbTa, kbPw]) {
  e.addEventListener('input', ev => { fTyped = Date.now(); fSynced = true; kbPaint(); if (!ev.isComposing && !fComp) kbSched(); });
  e.addEventListener('compositionstart', () => { fComp = true; });
  e.addEventListener('compositionend', () => { fComp = false; fTyped = Date.now(); kbSched(); });
  e.addEventListener('select', kbSched);
  e.addEventListener('keydown', ev => {                  // teclado físico: Intro, Tab y Esc van a la tele (Mayús+Intro, salto de línea)
    if (ev.isComposing || fComp) return;
    if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Tab' || ev.key === 'Escape') { ev.preventDefault(); kbKey(ev.key); }
  });
}
document.addEventListener('selectionchange', () => {
  const a = document.activeElement;
  if (fHold && a === kbPw && (kbPw.selectionStart !== fHold.a || kbPw.selectionEnd !== fHold.b)) try { kbPw.setSelectionRange(fHold.a, fHold.b); } catch {}
  if ((a === kbTa || a === kbPw) && !fComp) kbSched();
});
// los botones no le quitan el foco al editor (así el teclado del móvil no se cierra)
kbV.addEventListener('pointerdown', e => { if (e.target.closest('.kbK button,.kbA button,.kbRv')) e.preventDefault(); });
kbV.addEventListener('touchmove', e => e.stopPropagation(), { passive: true }); // dejar desplazar el editor
$('#kbK').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) kbKey(b.dataset.k); });
$('#kbGo').addEventListener('click', () => kbKey('Enter'));
$('#kbClr').addEventListener('click', () => { const e = kbEd(); e.value = ''; fSynced = true; fTyped = Date.now(); buzz(10); kbPaint(); kbFlush(); });
$('#kbBk').addEventListener('click', () => { buzz(7); closeSheet(); });
function kbRvPaint() { const on = kbPw.type === 'text'; $('#kbRv').setAttribute('aria-pressed', on); $('#kbRv span').textContent = on ? 'Ocultar' : 'Mostrar'; }
$('#kbRv').addEventListener('click', () => {
  const a = kbPw.selectionStart, b = kbPw.selectionEnd;
  // Chrome lleva el cursor al principio un poco después: mientras, se repone y no se manda nada
  fHold = { a, b }; kbPw.type = kbPw.type === 'password' ? 'text' : 'password'; kbRvPaint();
  setTimeout(() => { try { kbPw.setSelectionRange(a, b); } catch {} fHold = false; kbSched(); }, 250);
});
if (vv) {                                              // la vista ocupa lo que se ve: la barra queda pegada encima del teclado
  const kbVV = () => { kbV.style.setProperty('--vt', vv.offsetTop + 'px'); kbV.style.setProperty('--vh', vv.height + 'px'); kbV.classList.toggle('kb', innerHeight - vv.height > 80); };
  vv.addEventListener('resize', kbVV); vv.addEventListener('scroll', kbVV); kbVV();
}
gin.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); const v = gin.value.trim();
  if (v) { cmd({ t: 'nav', url: v }); closeSheet(); }
});

/* agente: el texto (escrito o dictado con el teclado) va a OpenClaw; la respuesta llega por el WebSocket */
function onAsk(j) {
  if (j.stage === 'thinking') { rep.className = 'rep wait'; rep.textContent = 'Pensando'; return; }
  rep.className = 'rep'; rep.textContent = j.reply || 'No he recibido respuesta.'; buzz(12);
}
agin.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault(); const v = agin.value.trim();
  if (!v) return;
  cmd({ t: 'ask', text: v }); agin.value = ''; rep.className = 'rep wait'; rep.textContent = 'Pensando';
});

/* spotify: panel completo del dispositivo «Salón», con datos en vivo empujados por el servidor */
let spN = null, spRecv = 0, spVolT = 0, spTab = 'queue', spDrag = null;
const mmss = ms => { const t = Math.max(0, Math.floor((ms || 0) / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const spOpen = () => document.getElementById('spS').classList.contains('on');
function spButton() {
  openSheet('spS');
  rpc({ t: 'spwatch', on: true }).then(r => { if (r && 'now' in r) spPaint(r.now); });
  spLoadTab();
}
function spPos() { return !spN || spN.empty ? 0 : Math.min(spN.duration, spN.progress + (spN.playing ? Date.now() - spRecv : 0)); }
function spPaint(n) {
  spN = n; spRecv = Date.now();
  const S = $('#spS');
  $('#spLogin').hidden = !(n && n.needsLogin);
  $('#spLoginA').href = '/spotify/login?t=' + encodeURIComponent(token);
  if (!n || n.empty || !n.track) {
    $('#spT').textContent = 'Nada sonando'; $('#spA').textContent = 'Busca algo o elige una playlist'; $('#spCtx').textContent = '';
    $('#spArt').style.backgroundImage = ''; $('#spLike').hidden = true; S.classList.remove('tint'); spTick(); spList(); return;
  }
  $('#spT').textContent = n.track.name;
  $('#spA').textContent = n.artist;
  const c = n.context;
  $('#spCtx').textContent = c && c.name && c.type !== 'album' ? 'Desde ' + c.name : [n.album.name, n.album.year].filter(Boolean).join(' · ');
  const im = n.album.image && (n.album.image.m || n.album.image.l);
  $('#spArt').style.backgroundImage = im ? `url("${im}")` : '';
  if (n.colors) { S.style.setProperty('--spBg', n.colors.bg); S.style.setProperty('--spAc', n.colors.accent); S.classList.add('tint'); } else S.classList.remove('tint');
  $('#spLike').hidden = n.liked === null || n.liked === undefined; $('#spLike').classList.toggle('on', !!n.liked);
  $('#spShuf').classList.toggle('on', !!n.shuffle);
  $('#spRep').classList.toggle('on', n.repeat !== 'off'); $('#spRep').classList.toggle('one', n.repeat === 'track');
  $('#spS .big use').setAttribute('href', n.playing ? '#i-pause' : '#i-play');
  const v = n.device && n.device.volume; if (typeof v === 'number' && !spVolT) { $('#rSp').value = v; $('#spV').textContent = v + ' %'; }
  spTick();
  if (spTab === 'queue') spList();
}
function spTick() {
  const d = spN && !spN.empty ? spN.duration : 0;
  const p = spDrag !== null ? spDrag * d : spPos();
  $('#spP').textContent = mmss(p); $('#spD').textContent = mmss(d);
  $('#spFill').style.width = d ? (p / d * 100).toFixed(2) + '%' : '0';
}
setInterval(() => { if (spOpen()) spTick(); }, 500);
setInterval(() => { if (spOpen() && !document.hidden) cmd({ t: 'spwatch', on: true }); }, 15000); // por si el WebSocket se ha reconectado
// el servidor deja de contar el panel a los 40 s sin renovar (móvil bloqueado): al volver, se pide al momento
document.addEventListener('visibilitychange', () => { if (spOpen() && !document.hidden) rpc({ t: 'spwatch', on: true }).then(r => { if (r && 'now' in r) spPaint(r.now); }); });
const trk = $('#spTrk');
const frac = e => { const r = trk.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
trk.addEventListener('pointerdown', e => { if (!spN || spN.empty) return; trk.setPointerCapture(e.pointerId); trk.classList.add('drag'); spDrag = frac(e); spTick(); });
trk.addEventListener('pointermove', e => { if (spDrag === null) return; spDrag = frac(e); spTick(); });
trk.addEventListener('pointerup', e => {
  if (spDrag === null) return;
  const f = frac(e); spDrag = null; trk.classList.remove('drag'); buzz(8);
  if (spN && !spN.empty) { spN.progress = f * spN.duration; spRecv = Date.now(); spTick(); rpc({ t: 'spotify', a: 'seek', ms: Math.round(f * spN.duration) }); }
});
trk.addEventListener('pointercancel', () => { spDrag = null; trk.classList.remove('drag'); spTick(); });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-sp]'); if (!b) return;
  buzz(8);
  if (b.dataset.sp === 'playpause' && spN && !spN.empty) { spN.progress = spPos(); spRecv = Date.now(); spN.playing = !spN.playing; $('#spS .big use').setAttribute('href', spN.playing ? '#i-pause' : '#i-play'); }
  rpc({ t: 'spotify', a: b.dataset.sp }).then(r => { if (r && r.error) pill(r.error); });
});
$('#spShuf').addEventListener('click', () => { buzz(8); $('#spShuf').classList.toggle('on'); rpc({ t: 'spotify', a: 'shuffle' }); });
$('#spRep').addEventListener('click', () => { buzz(8); rpc({ t: 'spotify', a: 'repeat' }); });
$('#spLike').addEventListener('click', () => { buzz(12); $('#spLike').classList.toggle('on'); rpc({ t: 'spotify', a: 'like' }).then(r => { if (r && r.error) { pill(r.error); $('#spLike').classList.toggle('on'); } }); });
$('#spTv').addEventListener('click', () => { buzz(8); cmd({ t: 'nav', url: 'https://open.spotify.com/' }); cmd({ t: 'spotify', a: 'activate' }); closeSheet(); pill('Abriendo Spotify en la tele'); });
$('#rSp').addEventListener('input', e => {
  $('#spV').textContent = e.target.value + ' %';
  clearTimeout(spVolT); spVolT = setTimeout(() => { spVolT = 0; rpc({ t: 'spotify', a: 'volume', v: +e.target.value }); }, 250);
});
spin.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault(); const v = spin.value.trim(); if (!v) return;
  spin.value = ''; $('#spT').textContent = 'Buscando…'; $('#spA').textContent = v; spin.blur();
  rpc({ t: 'spotify', a: 'search_play', query: v, type: 'track' }).then(r => { if (r && r.error) { pill(r.error); spPaint(spN); } });
});
/* listas: a continuación, playlists (con su detalle) y recientes */
const spCache = {};
let spDetail = null; // playlist abierta: {uri, head, items, next, loading}
$('#spTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; buzz(7); if (spTab === b.dataset.tab && b.dataset.tab === 'playlists') spDetail = null; spTab = b.dataset.tab; spLoadTab(); });
async function spLoadTab() {
  $('#spTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === spTab));
  if (spTab === 'queue') return spList();
  if (spTab === 'playlists' && spDetail) return spList();
  if (spCache[spTab]) spList(); else spMsg('Cargando…');
  const r = await rpc({ t: 'spotify', a: spTab === 'playlists' ? 'playlists' : 'recent' });
  spCache[spTab] = r && r.items ? r.items : { error: r && r.error || 'error' };
  if (spCache[spTab].error && /403|scope|permis|Insufficient/i.test(spCache[spTab].error)) $('#spLogin').hidden = false;
  if (!(spTab === 'playlists' && spDetail)) spList();
}
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
function spMsg(t) { const box = $('#spList'); box.textContent = ''; box.appendChild(el('div', 'spEmpty', t)); }
function spCover(x, cls) {
  const im = el('div', cls || 'im');
  const src = typeof x.image === 'string' ? x.image : x.image && (x.image.m || x.image.s);
  if (x.liked) { im.classList.add('lk'); im.textContent = '♥'; }
  else if (src) im.style.backgroundImage = `url("${src}")`;
  else im.textContent = '♪';
  return im;
}
const spPlay = (o, label) => rpc({ t: 'spotify', ...o }).then(r => pill(r && r.error ? r.error : label || 'Reproduciendo'));
function spRow(x, sub, onTap, extra) {
  const it = el('div', 'spIt' + (x.playable === false ? ' off' : ''));
  const tx = el('div', 'tx'); tx.append(el('div', 'a', x.name), el('div', 'b', sub || ''));
  it.append(spCover(x), tx, extra || el('div', 'c', x.duration ? mmss(x.duration) : ''));
  it.addEventListener('click', e => { if (e.target.closest('.spMini')) return; buzz(10); it.classList.add('dn'); setTimeout(() => it.classList.remove('dn'), 250); onTap(); });
  return it;
}
function spMiniBtn(icon, label, fn) {
  const b = el('button', 'spMini'); b.setAttribute('aria-label', label);
  b.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  b.addEventListener('click', e => { e.stopPropagation(); buzz(10); fn(); });
  return b;
}
function spList() {
  const box = $('#spList'); box.textContent = '';
  if (spTab === 'playlists' && spDetail) return spRenderDetail(box);
  let items;
  if (spTab === 'queue') {
    items = (spN && spN.queue) || [];
    if (!items.length) return spMsg('No hay nada en cola.');
    // dentro de la playlist/álbum que suena, para no perder lo que viene después
    for (const x of items) box.appendChild(spRow(x, x.artist, () => spPlay(spN && spN.context && /^(playlist|album)$/.test(spN.context.type) ? { a: 'uri', uri: spN.context.uri, offset: x.uri } : { a: 'uri', uri: x.uri })));
    return;
  }
  const c = spCache[spTab]; if (!c) return;
  if (c.error) return spMsg(/403|scope|permis|Insufficient/i.test(c.error) ? 'Falta volver a conectar Spotify.' : c.error);
  if (!c.length) return spMsg('Nada por aquí.');
  if (spTab === 'playlists') {
    for (const x of c) box.appendChild(spRow(x, [x.by, x.count != null ? x.count + ' canciones' : ''].filter(Boolean).join(' · '),
      () => spOpenPl(x), spMiniBtn('i-shuf', 'Reproducir en aleatorio', () => spPlay({ a: 'uri', uri: x.uri, shuffle: true, total: x.count }, 'Aleatorio: ' + x.name))));
  } else {
    for (const x of c) box.appendChild(spRow(x, x.by, () => spPlay({ a: 'uri', uri: x.uri }),
      spMiniBtn('i-plus', 'Añadir a la cola', () => spPlay({ a: 'queue_add', uri: x.uri }, 'Añadida a la cola'))));
  }
}
async function spOpenPl(x) {
  spDetail = { uri: x.uri, head: x, items: [], next: 0, loading: true };
  spList(); $('#spList').scrollIntoView({ block: 'nearest' });
  await spMore();
}
async function spMore() {
  const d = spDetail; if (!d || d.next === null) return;
  d.loading = true; if (spTab === 'playlists') spList();
  const r = await rpc({ t: 'spotify', a: 'playlist', uri: d.uri, offset: d.next });
  if (spDetail !== d) return;
  d.loading = false;
  if (r.error) { d.error = r.error; d.next = null; }
  else { for (const [k, v] of Object.entries(r)) if (k !== 'items' && v !== null && v !== undefined) d.head[k] = v; d.items.push(...(r.items || [])); d.next = r.next; }
  if (spTab === 'playlists') spList();
}
function spRenderDetail(box) {
  const d = spDetail, h = d.head;
  const back = el('button', 'spBack', '‹ Playlists'); back.addEventListener('click', () => { buzz(7); spDetail = null; spList(); });
  const hd = el('div', 'spPl');
  const meta = el('div', 'm');
  meta.append(el('div', 'n', h.name), el('div', 'b', [h.by, h.count != null ? h.count + ' canciones' : ''].filter(Boolean).join(' · ')));
  if (h.description) meta.appendChild(el('div', 'd', h.description));
  hd.append(spCover(h, 'cv'), meta);
  const acts = el('div', 'spPlA');
  const pb = el('button', 'bt big', 'Reproducir'); pb.addEventListener('click', () => { buzz(10); spPlay({ a: 'uri', uri: d.uri, shuffle: false }, 'Reproduciendo ' + h.name); });
  const sb = el('button', 'bt', 'Aleatorio'); sb.addEventListener('click', () => { buzz(10); spPlay({ a: 'uri', uri: d.uri, shuffle: true, total: h.count }, 'Aleatorio: ' + h.name); });
  acts.append(pb, sb);
  box.append(back, hd, acts);
  if (d.error) return box.appendChild(el('div', 'spEmpty', d.error));
  if (h.canList === false) return box.appendChild(el('div', 'spEmpty', h.note || 'No se pueden ver sus canciones.'));
  d.items.forEach((x, i) => box.appendChild(spRow(x, x.by, () => spPlay({ a: 'uri', uri: d.uri, offset: x.uri }),
    spMiniBtn('i-plus', 'Añadir a la cola', () => spPlay({ a: 'queue_add', uri: x.uri }, 'Añadida a la cola')))));
  if (d.loading) box.appendChild(el('div', 'spEmpty', 'Cargando…'));
  else if (d.next !== null) { const m = el('button', 'bt spMore', 'Cargar más'); m.addEventListener('click', () => { buzz(7); spMore(); }); box.appendChild(m); }
}
/* emparejar: el código sale en la tele; con él este dispositivo recibe su propio acceso */
const pairV = $('#pairV'), p1 = $('#p1'), p2 = $('#p2'), pCode = $('#pCode'), pMsg = $('#pMsg');
const P_HELP = 'Pide acceso al administrador o escribe el código que aparecerá en la tele.';
let pid = null;
const uaName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Móvil Android' : 'Tablet Android') : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Navegador'; };
const pSay = (t, err) => { pMsg.textContent = t; pMsg.className = err ? 'err' : ''; };
async function post(u, b) { try { return await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch { return { error: 'No hay conexión con el mando' }; } }
let askT = 0;
function showPair(msg) {
  closeSheetSafe(); pairV.hidden = false; p1.hidden = false; p2.hidden = true; $('#p3').hidden = true; $('#p4').hidden = true; pid = null; clearTimeout(askT);
  post('/pair/info', {}).then(r => { $('#pAsk').hidden = !r.adminOnline; $('#pGo').className = r.adminOnline ? 'bt' : 'bt big'; });
  $('#pName').placeholder = 'Tu nombre (' + uaName() + ')'; $('#pName').value = store.get('pname', '');
  pSay(msg || pairNote || P_HELP); pairNote = '';
  t1.textContent = 'Sin acceso'; t2.textContent = '';
}
function closeSheetSafe() { try { if (sheet) closeSheet(); } catch {} }
function paired(r) {
  useToken(r);
  pairV.hidden = true; tries = 0; connect();
}
async function pairAskGo() {
  const typed = $('#pName').value.trim(); store.set('pname', typed);
  const r = await post('/pair/start', { name: typed || uaName(), mode: 'ask' });
  if (r.error) { if (r.noAdmin) $('#pAsk').hidden = true; return pSay(r.error, true); }
  pid = r.pid; p1.hidden = true; $('#p3').hidden = false; pSay('Esperando a que el administrador acepte en su móvil…');
  const t0 = Date.now();
  const poll = async () => {
    if (pid !== r.pid) return;
    const q = await post('/pair/poll', { pid });
    if (q.token) return paired(q);
    if (q.denied) return showPair('El administrador no ha aceptado. Puedes usar el código de la tele.');
    if (q.dead || Date.now() - t0 > 125000) return showPair('No ha habido respuesta. Prueba otra vez o usa el código de la tele.');
    askT = setTimeout(poll, 1500);
  };
  askT = setTimeout(poll, 1200);
}
$('#pAsk').addEventListener('click', pairAskGo);
$('#pCancel').addEventListener('click', () => showPair());
async function pairGo() {
  const typed = $('#pName').value.trim(); store.set('pname', typed);
  pSay('Pidiendo código…');
  const r = await post('/pair/start', { name: typed || uaName() });
  if (r.error) return pSay(r.error, true);
  pid = r.pid; p1.hidden = true; p2.hidden = false; pCode.value = ''; pSay('Mira la tele y escribe aquí el código de 4 cifras.'); pCode.focus();
}
$('#pGo').addEventListener('click', pairGo);
/* código de administrador (de un solo uso): lo da el agente, `node remote/admin-link.js` o otro admin */
async function adminGo(code, name) {
  const r = await post('/pair/admin', { code, name, cur: token });
  if (r.token) { useToken(r); return r; }
  return r;
}
$('#pAdm').addEventListener('click', () => { p1.hidden = true; $('#p4').hidden = false; pSay('Escribe el código de administrador. Sirve una sola vez y caduca en 10 minutos.'); $('#pAdmC').value = ''; $('#pAdmC').focus(); });
$('#pAdmBack').addEventListener('click', () => showPair());
async function pAdmSend() {
  const typed = $('#pName').value.trim(); store.set('pname', typed);
  const r = await adminGo($('#pAdmC').value, typed || uaName());
  if (r.token) { pairV.hidden = true; tries = 0; connect(); return; }
  pSay(r.error || 'Error', true);
}
$('#pAdmGo').addEventListener('click', pAdmSend);
$('#pAdmC').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pAdmSend(); } });
$('#clGo').addEventListener('click', async () => {
  const r = await adminGo($('#clCode').value, ME && ME.name);
  if (!r.token) return pill(r.error || 'Error');
  $('#clCode').value = ''; pill('Ya eres administrador');
  if (ws) ws.close(); // reconecta con el token (el mismo si se ha ascendido este dispositivo)
});
$('#alGo').addEventListener('click', async () => {
  buzz(8);
  const r = await rpc({ t: 'adminlink' });
  const box = $('#alBox'); box.hidden = false;
  if (r.error) { box.textContent = r.error; return; }
  box.textContent = '';
  const b = document.createElement('b'); b.textContent = r.code;
  box.append('Código ', b, ` · caduca en ${r.minutes} min y sirve una vez. Ábrelo en el otro dispositivo o escribe el código en «Tengo un código de administrador».`);
  try { if (navigator.share) await navigator.share({ title: 'Mando del salón (admin)', url: r.url }); else { await navigator.clipboard.writeText(r.url); pill('Enlace copiado'); } } catch {}
});
$('#pName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pairGo(); } });
$('#pBack').addEventListener('click', () => showPair());
pCode.addEventListener('input', async () => {
  pCode.value = pCode.value.replace(/\D/g, '').slice(0, 4);
  if (pCode.value.length < 4) return;
  const r = await post('/pair/confirm', { pid, code: pCode.value });
  if (r.token) return paired(r);
  pCode.value = '';
  if (r.dead || /caducado/.test(r.error || '')) return showPair(r.error);
  pSay(r.error || 'Error', true);
});

/* dispositivos con acceso (ajustes) */
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'ahora' : s < 5400 ? 'hace ' + Math.round(s / 60) + ' min' : s < 129600 ? 'hace ' + Math.round(s / 3600) + ' h' : 'hace ' + Math.round(s / 86400) + ' d'; };
const ROLE_N = { admin: 'Admin', member: 'Miembro', guest: 'Invitado' };
const left = ms => { const h = (ms - Date.now()) / 3600e3; return h <= 0 ? 'caducado' : h < 1 ? 'caduca en ' + Math.max(1, Math.round(h * 60)) + ' min' : h < 48 ? 'caduca en ' + Math.round(h) + ' h' : 'caduca en ' + Math.round(h / 24) + ' d'; };
let ME = null, ACC = null, acWho = 'guest';
async function refreshDevs() {
  if (!ME || ME.role !== 'admin') return;
  const r = await rpc({ t: 'devices' }); paintDevs(r);
}
function paintDevs(r) {
  if (r.access) { ACC = r.access; paintAccess(); }
  const box = $('#devs'); box.textContent = '';
  for (const d of r.devices || []) {
    const row = document.createElement('div'); row.className = 'fld';
    const sp = document.createElement('span'); sp.textContent = d.name + (d.id === ME.id ? ' (este)' : '');
    const ch = document.createElement('span'); ch.className = 'chip ' + d.role; ch.textContent = ROLE_N[d.role] || d.role; sp.appendChild(ch);
    if (d.online) { const on = document.createElement('span'); on.className = 'chip on'; on.textContent = '● conectado'; sp.appendChild(on); }
    const sm = document.createElement('small'); sm.textContent = 'Último uso ' + ago(d.seen) + (d.expires ? ' · ' + left(d.expires) : ''); sp.appendChild(sm);
    const bx = document.createElement('div'); bx.className = 'dvb';
    const sel = document.createElement('select'); sel.className = 'sel'; sel.setAttribute('aria-label', 'Rol de ' + d.name);
    for (const k of ['admin', 'member', 'guest']) sel.add(new Option(ROLE_N[k], k, false, k === d.role));
    sel.addEventListener('change', async () => { const q = await rpc({ t: 'role', dev: d.id, role: sel.value }); if (q.error) pill(q.error); paintDevs(q.devices ? q : await rpc({ t: 'devices' })); });
    bx.appendChild(sel);
    if (d.role === 'guest') { const x = document.createElement('button'); x.className = 'bt dv'; x.textContent = '+' + (ACC && ACC.guestHours || 24) + ' h'; x.addEventListener('click', async () => { buzz(8); paintDevs(await rpc({ t: 'extend', dev: d.id })); }); bx.appendChild(x); }
    const b = document.createElement('button'); b.className = 'bt dv'; b.textContent = 'Quitar';
    b.addEventListener('click', async () => {
      if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = '¿Seguro?'; setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Quitar'; }, 3000); return; }
      await rpc({ t: 'revoke', dev: d.id }); refreshDevs();
    });
    bx.appendChild(b);
    row.append(sp, bx); box.appendChild(row);
  }
  if (!(r.devices || []).length) { const e = document.createElement('div'); e.className = 'foot'; e.style.textAlign = 'left'; e.textContent = 'Nadie más todavía.'; box.appendChild(e); }
  $('#kickG').hidden = !(r.devices || []).some(d => d.role === 'guest');
}
$('#kickG').addEventListener('click', async () => {
  const b = $('#kickG');
  if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = '¿Quitar a todos los invitados?'; setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Quitar a todos los invitados'; }, 3000); return; }
  b.classList.remove('sure'); b.textContent = 'Quitar a todos los invitados'; paintDevs(await rpc({ t: 'kickguests' }));
});
/* qué pueden hacer invitados y miembros */
function paintAccess() {
  if (!ACC) return;
  const P = ACC[acWho];
  $('#acWho').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.w === acWho));
  $('#acHrs').hidden = acWho !== 'guest'; $('#acHours').value = String(ACC.guestHours);
  $('#acWeb').setAttribute('aria-pressed', !!P.web); $('#acLib').setAttribute('aria-pressed', !!P.library); $('#acStage').setAttribute('aria-pressed', !!P.stage);
  $('#acAgent').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === P.agent));
  $('#acMusic').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === P.music));
  $('#acVol').value = P.volMax; $('#acVolV').textContent = P.volMax + ' %';
}
let acT = 0;
function accSave() { clearTimeout(acT); acT = setTimeout(async () => { const r = await rpc({ t: 'access', op: 'set', cfg: ACC }); if (r.access) { ACC = r.access; paintAccess(); } }, 250); }
const acSet = (k, v) => { if (!ACC) return; ACC[acWho][k] = v; paintAccess(); accSave(); };
$('#acWho').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; buzz(7); acWho = b.dataset.w; paintAccess(); });
$('#acHours').addEventListener('change', e => { if (!ACC) return; ACC.guestHours = +e.target.value; accSave(); });
$('#acWeb').addEventListener('click', () => acSet('web', !ACC[acWho].web));
$('#acLib').addEventListener('click', () => acSet('library', !ACC[acWho].library));
$('#acStage').addEventListener('click', () => acSet('stage', !ACC[acWho].stage));
$('#acAgent').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { buzz(7); acSet('agent', b.dataset.v); } });
$('#acMusic').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { buzz(7); acSet('music', b.dataset.v); } });
$('#acVol').addEventListener('input', e => { $('#acVolV').textContent = e.target.value + ' %'; });
$('#acVol').addEventListener('change', e => acSet('volMax', +e.target.value));
/* el mando se adapta a lo que puede hacer cada uno */
function applyMe(j) {
  ME = j; const P = j.perms || {};
  if (j.id) store.set('devid', j.id);
  const hide = (sel, h) => document.querySelectorAll(sel).forEach(e => { if (h) e.setAttribute('data-hide', ''); else e.removeAttribute('data-hide'); });
  hide('[data-a=go],[data-url]', !P.web);
  hide('[data-a=ag]', P.agent === 'off');
  $('#admBox').hidden = j.role !== 'admin';
  $('#clBox').hidden = j.role === 'admin';
  hide('#spTabs [data-tab=playlists],#spTabs [data-tab=recent]', !P.library);
  if (!P.library && spTab !== 'queue') { spTab = 'queue'; if (spOpen()) spLoadTab(); }
  hide('#spLike', !P.library);
  hide('#spin', P.music === 'off');
  $('#spin').placeholder = P.music === 'queue' ? 'Pide una canción (va a la cola)…' : 'Busca y reproduce: artista, canción…';
  const mb = $('#meBox'); mb.textContent = '';
  const b = document.createElement('b'); b.textContent = j.name; mb.append('Estás como ', b, ' · ' + (ROLE_N[j.role] || j.role) + (j.expires ? ' · ' + left(j.expires) : ''));
  if (j.role === 'admin' && $('#setS').classList.contains('on')) refreshDevs();
}
/* peticiones de acceso que llegan al administrador */
let reqPid = null;
function showReq(j) { reqPid = j.pid; $('#reqName').textContent = j.name; $('#req').hidden = false; buzz(30); }
function hideReq(pid) { if (!pid || pid === reqPid) { $('#req').hidden = true; reqPid = null; } }
$('#req').addEventListener('click', async e => {
  const b = e.target.closest('[data-r]'); if (!b || !reqPid) return; buzz(10);
  const r = await rpc({ t: 'pairanswer', pid: reqPid, ok: b.dataset.r !== 'no', role: b.dataset.r });
  if (r.error) pill(r.error); else pill(b.dataset.r === 'no' ? 'Rechazado' : 'Acceso concedido');
  hideReq(); if ($('#setS').classList.contains('on')) refreshDevs();
});

/* ── ajustes ── */
function refreshSet() {
  $('#rSpeed').value = cfg.speed; $('#vSpeed').textContent = cfg.speed.toFixed(1) + '×';
  $('#rScroll').value = cfg.scroll; $('#vScroll').textContent = cfg.scroll.toFixed(1) + '×';
  $('#swNat').setAttribute('aria-pressed', cfg.natural); $('#swHap').setAttribute('aria-pressed', cfg.haptic);
  $('#swDark').setAttribute('aria-pressed', cfg.theme !== 'claro');
  $('#swFs').setAttribute('aria-pressed', !!document.fullscreenElement);
  $('#foot').textContent = (ws && ws.readyState === 1 ? 'Conectado' : 'Sin conexión') + (rtt ? ' · ' + Math.round(rtt) + ' ms' : '');
}
$('#rSpeed').addEventListener('input', e => { cfg.speed = +e.target.value; $('#vSpeed').textContent = cfg.speed.toFixed(1) + '×'; saveCfg(); });
$('#rScroll').addEventListener('input', e => { cfg.scroll = +e.target.value; $('#vScroll').textContent = cfg.scroll.toFixed(1) + '×'; saveCfg(); });
$('#swNat').addEventListener('click', () => { cfg.natural = !cfg.natural; saveCfg(); refreshSet(); });
$('#swHap').addEventListener('click', () => { cfg.haptic = !cfg.haptic; saveCfg(); refreshSet(); buzz(12); });
$('#swDark').addEventListener('click', () => { cfg.theme = cfg.theme === 'claro' ? 'oscuro' : 'claro'; saveCfg(); applyTheme(); refreshSet(); buzz(8); });
if (!document.documentElement.requestFullscreen) $('#fsRow').hidden = true;
$('#swFs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  setTimeout(refreshSet, 250);
});
setInterval(() => { if (sheet && sheet.id === 'setS') refreshSet(); }, 1000);

/* ── pantalla en reposo ── */
const DAYN = [['mon', 'Lun'], ['tue', 'Mar'], ['wed', 'Mié'], ['thu', 'Jue'], ['fri', 'Vie'], ['sat', 'Sáb'], ['sun', 'Dom']];
let icfg = null, iT = 0;
function idlePaint() {
  if (!icfg) return;
  $('#idMode').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === icfg.mode));
  $('#idBed').value = icfg.bed; $('#idWake').value = icfg.wake;
  $('#idPer').setAttribute('aria-pressed', !!icfg.perDay);
  $('#idIdle').value = String(icfg.idleMin); $('#idDim').value = String(icfg.dimMin);
  if (![...$('#idIdle').options].some(o => o.value === String(icfg.idleMin))) $('#idIdle').add(new Option(icfg.idleMin + ' min', icfg.idleMin, true, true));
  $('#idMus').setAttribute('aria-pressed', !!icfg.music);
  $('#idLay').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.l === (icfg.layout || 'rotar')));
  $('#idRe').value = String(icfg.rearrangeMin ?? 20);
  if (![...$('#idRe').options].some(o => o.value === String(icfg.rearrangeMin))) $('#idRe').add(new Option(icfg.rearrangeMin + ' min', icfg.rearrangeMin, true, true));
  $('#idCalm').setAttribute('aria-pressed', !!icfg.calm);
  const wk = $('#idWeek'); wk.hidden = !icfg.perDay; wk.textContent = '';
  if (icfg.perDay) for (const [k, n] of DAYN) {
    const w = icfg.week[k] || {};
    const l = document.createElement('span'); l.textContent = n;
    const a = Object.assign(document.createElement('input'), { type: 'time', className: 'tm', value: w.bed || icfg.bed }); a.setAttribute('aria-label', n + ' acostarse');
    const b = Object.assign(document.createElement('input'), { type: 'time', className: 'tm', value: w.wake || icfg.wake }); b.setAttribute('aria-label', n + ' levantarse');
    const chg = () => { icfg.week[k] = { bed: a.value, wake: b.value }; idleSave(); };
    a.addEventListener('change', chg); b.addEventListener('change', chg);
    wk.append(l, a, b);
  }
}
async function idleLoad() { const r = await rpc({ t: 'idle', op: 'get' }); if (r && r.cfg) { icfg = r.cfg; idlePaint(); } }
function idleSave() { clearTimeout(iT); iT = setTimeout(async () => { const r = await rpc({ t: 'idle', op: 'set', cfg: icfg }); if (r && r.cfg) icfg = r.cfg; }, 300); }
$('#idMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg) return; buzz(7); icfg.mode = b.dataset.m; idlePaint(); idleSave(); });
$('#idBed').addEventListener('change', e => { if (icfg && e.target.value) { icfg.bed = e.target.value; idleSave(); } });
$('#idWake').addEventListener('change', e => { if (icfg && e.target.value) { icfg.wake = e.target.value; idleSave(); } });
$('#idPer').addEventListener('click', () => { if (!icfg) return; icfg.perDay = !icfg.perDay; idlePaint(); idleSave(); });
$('#idIdle').addEventListener('change', e => { if (icfg) { icfg.idleMin = +e.target.value; idleSave(); } });
$('#idDim').addEventListener('change', e => { if (icfg) { icfg.dimMin = +e.target.value; idleSave(); } });
$('#idMus').addEventListener('click', () => { if (!icfg) return; icfg.music = !icfg.music; idlePaint(); idleSave(); });
$('#idLay').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg) return; buzz(7); icfg.layout = b.dataset.l; idlePaint(); idleSave(); });
$('#idRe').addEventListener('change', e => { if (icfg) { icfg.rearrangeMin = +e.target.value; idleSave(); } });
$('#idCalm').addEventListener('click', () => { if (!icfg) return; icfg.calm = !icfg.calm; idlePaint(); idleSave(); });
$('#idShow').addEventListener('click', () => { buzz(7); cmd({ t: 'idle', op: 'show' }); closeSheet(); });

settle().finally(connect);
