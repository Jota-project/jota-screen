import { $, hide } from './core/dom.js';
import { persist, cfg, saveCfg, state, initSession, on } from './core/store.js';
import { rpc, post, connect, reconnect, resetTries, isUp, getRtt, handle, setGate, start } from './core/api.js';
import { buzz } from './ui/haptics.js';
import { pill } from './ui/pill.js';
import { applyTheme } from './ui/theme.js';
import { status, setTitle } from './ui/status.js';
import { sheets, registerSheet, openSheet, closeSheetSafe, isOpen } from './ui/sheets.js';
import { actions, registerAct, registerClick } from './ui/actions.js';
import { gestures } from './ui/gestures.js';
import { ROLE_N, left, applyMe } from './core/perms.js';
import { controls } from './features/controls.js';
import { trackpad } from './features/trackpad.js';
import { keyboard } from './features/keyboard.js';
import { go } from './features/go.js';
import { idle, idleLoad } from './features/idle.js';
import { spotify } from './features/spotify.js';
import { agent } from './features/agent.js';

/* registro: mensajes, hojas, acciones [data-click] y órdenes directas de cada parte (error si algo se repite) */
function register(list) {
  for (const f of list) {
    for (const [t, fn] of Object.entries(f.msgs || {})) handle(t, fn);
    for (const [id, h] of Object.entries(f.sheets || {})) registerSheet(id, h);
    for (const [a, fn] of Object.entries(f.clicks || {})) registerClick(a, fn);
    for (const [a, fn] of Object.entries(f.acts || {})) registerAct(a, fn);
  }
}

/* ── acceso: cada dispositivo tiene su propio token (se recuerda aquí y en una cookie). El maestro no se guarda nunca. ── */
initSession();
function addManifest() {
  if (!state.token || document.querySelector('link[rel=manifest]')) return;
  const m = document.createElement('link'); m.rel = 'manifest'; m.href = '/manifest.webmanifest?t=' + encodeURIComponent(state.token);
  document.head.appendChild(m);
}
function useToken(r) { state.token = r.token; persist.set('token', state.token); persist.set('devid', r.id); addManifest(); }
async function settle() { // antes de conectar: canjea el código de admin o el token maestro y renueva la cookie
  if (state.adminCode) {
    const r = await post('/pair/admin', { code: state.adminCode, name: persist.get('pname', '') || uaName(), cur: state.token });
    if (r.token) { useToken(r); setTimeout(() => pill('Ya eres administrador'), 600); return; }
    state.pairNote = r.error || 'No se pudo usar el enlace de administrador';
  }
  if (!state.token) return;
  const r = await post('/pair/me', { t: state.token });
  if (r.master) { // enlace maestro (o guardado por una versión anterior): se cambia por un dispositivo admin propio
    const master = state.token; persist.set('token', ''); state.token = '';
    const q = await post('/pair/admin', { t: master, name: persist.get('pname', '') || uaName() });
    if (q.token) useToken(q);
    return;
  }
  if (r.ok) { persist.set('token', state.token); addManifest(); }
}

register([controls]);
controls.init();

/* ── conexión ── */
setGate(() => {
  if (state.token || state.viaCookie) return true;
  return (async () => { // sin token guardado: quizá el navegador conserva la cookie de un emparejamiento anterior
    const r = await post('/pair/me', {});
    if (!r.ok) { showPair(); return false; }
    if (r.master) { const q = await post('/pair/admin', { name: persist.get('pname', '') || uaName() }); if (!q.token) { showPair(); return false; } useToken(q); }
    else state.viaCookie = true;
    return true;
  })();
});
on('auth:lost', code => {
  persist.set('token', ''); persist.set('devid', ''); state.token = ''; state.viaCookie = false;
  showPair(code === 4002 ? 'Tu acceso ha caducado. Pídelo de nuevo.' : 'No tienes acceso (o te lo han retirado). Pídelo de nuevo.');
});
handle('me', applyMe);
handle('pairreq', j => showReq(j));
handle('pairdone', j => hideReq(j.pid));
start();
status.init();

trackpad.init();
gestures.init();

actions.init();

/* ── hojas ── */
registerClick('more', () => { refreshSet(); if (state.me && state.me.role === 'admin') { refreshDevs(); idleLoad(); } openSheet('setS'); });
sheets.init();

keyboard.init();
register([keyboard, go, agent]);
go.init();
agent.init();

register([spotify]);
spotify.init();
/* emparejar: el código sale en la tele; con él este dispositivo recibe su propio acceso */
const pairV = $('#pairV'), p1 = $('#p1'), p2 = $('#p2'), pCode = $('#pCode'), pMsg = $('#pMsg');
const P_HELP = 'Pide acceso al administrador o escribe el código que aparecerá en la tele.';
let pid = null;
const uaName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Móvil Android' : 'Tablet Android') : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Navegador'; };
const pSay = (t, err) => { pMsg.textContent = t; pMsg.className = err ? 'err' : ''; };
let askT = 0;
function showPair(msg) {
  closeSheetSafe(); pairV.hidden = false; p1.hidden = false; p2.hidden = true; $('#p3').hidden = true; $('#p4').hidden = true; pid = null; clearTimeout(askT);
  post('/pair/info', {}).then(r => { $('#pAsk').hidden = !r.adminOnline; $('#pGo').className = r.adminOnline ? 'bt' : 'bt big'; });
  $('#pName').placeholder = 'Tu nombre (' + uaName() + ')'; $('#pName').value = persist.get('pname', '');
  pSay(msg || state.pairNote || P_HELP); state.pairNote = '';
  setTitle('Sin acceso', '');
}
function paired(r) {
  useToken(r);
  pairV.hidden = true; resetTries(); connect();
}
async function pairAskGo() {
  const typed = $('#pName').value.trim(); persist.set('pname', typed);
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
  const typed = $('#pName').value.trim(); persist.set('pname', typed);
  pSay('Pidiendo código…');
  const r = await post('/pair/start', { name: typed || uaName() });
  if (r.error) return pSay(r.error, true);
  pid = r.pid; p1.hidden = true; p2.hidden = false; pCode.value = ''; pSay('Mira la tele y escribe aquí el código de 4 cifras.'); pCode.focus();
}
$('#pGo').addEventListener('click', pairGo);
/* código de administrador (de un solo uso): lo da el agente, `node remote/admin-link.js` o otro admin */
async function adminGo(code, name) {
  const r = await post('/pair/admin', { code, name, cur: state.token });
  if (r.token) { useToken(r); return r; }
  return r;
}
$('#pAdm').addEventListener('click', () => { p1.hidden = true; $('#p4').hidden = false; pSay('Escribe el código de administrador. Sirve una sola vez y caduca en 10 minutos.'); $('#pAdmC').value = ''; $('#pAdmC').focus(); });
$('#pAdmBack').addEventListener('click', () => showPair());
async function pAdmSend() {
  const typed = $('#pName').value.trim(); persist.set('pname', typed);
  const r = await adminGo($('#pAdmC').value, typed || uaName());
  if (r.token) { pairV.hidden = true; resetTries(); connect(); return; }
  pSay(r.error || 'Error', true);
}
$('#pAdmGo').addEventListener('click', pAdmSend);
$('#pAdmC').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pAdmSend(); } });
$('#clGo').addEventListener('click', async () => {
  const r = await adminGo($('#clCode').value, state.me && state.me.name);
  if (!r.token) return pill(r.error || 'Error');
  $('#clCode').value = ''; pill('Ya eres administrador');
  reconnect(); // reconecta con el token (el mismo si se ha ascendido este dispositivo)
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
let ACC = null, acWho = 'guest';
async function refreshDevs() {
  if (!state.me || state.me.role !== 'admin') return;
  const r = await rpc({ t: 'devices' }); paintDevs(r);
}
function paintDevs(r) {
  if (r.access) { ACC = r.access; paintAccess(); }
  const box = $('#devs'); box.textContent = '';
  for (const d of r.devices || []) {
    const row = document.createElement('div'); row.className = 'fld';
    const sp = document.createElement('span'); sp.textContent = d.name + (d.id === state.me.id ? ' (este)' : '');
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
on('me', j => {
  const P = j.perms || {};
  hide('[data-a=go],[data-url]', !P.web);
  hide('[data-a=ag]', P.agent === 'off');
  $('#admBox').hidden = j.role !== 'admin';
  $('#clBox').hidden = j.role === 'admin';
  const mb = $('#meBox'); mb.textContent = '';
  const b = document.createElement('b'); b.textContent = j.name; mb.append('Estás como ', b, ' · ' + (ROLE_N[j.role] || j.role) + (j.expires ? ' · ' + left(j.expires) : ''));
  if (j.role === 'admin' && $('#setS').classList.contains('on')) refreshDevs();
});
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
  $('#foot').textContent = (isUp() ? 'Conectado' : 'Sin conexión') + (getRtt() ? ' · ' + Math.round(getRtt()) + ' ms' : '');
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
setInterval(() => { if (isOpen('setS')) refreshSet(); }, 1000);

register([idle]);
idle.init();

settle().finally(connect);
