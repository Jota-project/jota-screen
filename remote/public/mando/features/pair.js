// Acceso y emparejar: cada dispositivo tiene su propio token (se recuerda aquí y en una cookie; el maestro no se guarda
// nunca). Sin acceso, la pantalla de emparejar: pedírselo a un admin, el código de 4 cifras que sale en la tele o un código
// de administrador.
import { $ } from '../core/dom.js';
import { persist, state, on } from '../core/store.js';
import { connect, post, resetTries, setGate } from '../core/api.js';
import { pill } from '../ui/pill.js';
import { closeSheetSafe } from '../ui/sheets.js';
import { setTitle } from '../ui/status.js';

function addManifest() {
  if (!state.token || document.querySelector('link[rel=manifest]')) return;
  const m = document.createElement('link'); m.rel = 'manifest'; m.href = '/manifest.webmanifest?t=' + encodeURIComponent(state.token);
  document.head.appendChild(m);
}
function useToken(r) { state.token = r.token; persist.set('token', state.token); persist.set('devid', r.id); addManifest(); }
export async function settle() { // antes de conectar: canjea el código de admin o el token maestro y renueva la cookie
  // el acceso directo arranca con el ?t= con el que se instaló; si ese ya no vale (dispositivo quitado), manda el guardado
  const saved = persist.get('token', '');
  if (state.token && saved && saved !== state.token && !(await post('/pair/me', { t: state.token })).ok) state.token = saved;
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
let pairV, p1, p2, pCode, pMsg;
const P_HELP = 'Pide acceso al administrador o escribe el código que aparecerá en la tele.';
let pid = null;
export const uaName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Móvil Android' : 'Tablet Android') : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Navegador'; };
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
async function pairGo() {
  const typed = $('#pName').value.trim(); persist.set('pname', typed);
  pSay('Pidiendo código…');
  const r = await post('/pair/start', { name: typed || uaName() });
  if (r.error) return pSay(r.error, true);
  pid = r.pid; p1.hidden = true; p2.hidden = false; pCode.value = ''; pSay('Mira la tele y escribe aquí el código de 4 cifras.'); pCode.focus();
}
/* código de administrador (de un solo uso): lo da el agente, `node remote/admin-link.js` o otro admin */
export async function adminGo(code, name) {
  const r = await post('/pair/admin', { code, name, cur: state.token });
  if (r.token) { useToken(r); return r; }
  return r;
}
async function pAdmSend() {
  const typed = $('#pName').value.trim(); persist.set('pname', typed);
  const r = await adminGo($('#pAdmC').value, typed || uaName());
  if (r.token) { pairV.hidden = true; resetTries(); connect(); return; }
  pSay(r.error || 'Error', true);
}

export const pair = {
  name: 'pair',
  init() {
    pairV = $('#pairV'); p1 = $('#p1'); p2 = $('#p2'); pCode = $('#pCode'); pMsg = $('#pMsg');
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
    $('#pAsk').addEventListener('click', pairAskGo);
    $('#pCancel').addEventListener('click', () => showPair());
    $('#pGo').addEventListener('click', pairGo);
    $('#pAdm').addEventListener('click', () => { p1.hidden = true; $('#p4').hidden = false; pSay('Escribe el código de administrador. Sirve una sola vez y caduca en 10 minutos.'); $('#pAdmC').value = ''; $('#pAdmC').focus(); });
    $('#pAdmBack').addEventListener('click', () => showPair());
    $('#pAdmGo').addEventListener('click', pAdmSend);
    $('#pAdmC').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pAdmSend(); } });
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
  },
};
