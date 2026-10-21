// Administración (ajustes, solo admin): dispositivos con acceso (rol, +horas, quitar), qué pueden hacer invitados y
// miembros, peticiones de acceso que llegan, hacer admin a otro dispositivo y canjear un código de admin.
import { $ } from '../core/dom.js';
import { state } from '../core/store.js';
import { reconnect, rpc } from '../core/api.js';
import { ROLE_N, left } from '../core/perms.js';
import { buzz } from '../ui/haptics.js';
import { pill } from '../ui/pill.js';
import { segOn, segPaint } from '../ui/seg.js';
import { adminGo } from './pair.js';

const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'ahora' : s < 5400 ? 'hace ' + Math.round(s / 60) + ' min' : s < 129600 ? 'hace ' + Math.round(s / 3600) + ' h' : 'hace ' + Math.round(s / 86400) + ' d'; };
let acWho = 'guest', devN = 0, devGuests = 0;
/** Resúmenes de la portada de Ajustes ('' hasta que lleguen los datos). */
export const devSum = () => devN ? devN + ' con acceso' + (devGuests ? ' · ' + devGuests + (devGuests > 1 ? ' invitados' : ' invitado') : '') : '';
export const permSum = () => state.acc ? 'Los invitados entran ' + (state.acc.guestHours ? state.acc.guestHours + ' h' : 'sin límite') : '';
export async function refreshDevs() {
  if (!state.me || state.me.role !== 'admin') return;
  const r = await rpc({ t: 'devices' }); paintDevs(r);
}
function paintDevs(r) {
  if (r.access) { state.acc = r.access; paintAccess(); }
  const box = $('#devs'); box.textContent = '';
  devN = (r.devices || []).length; devGuests = (r.devices || []).filter(d => d.role === 'guest').length;
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
    if (d.role === 'guest') { const x = document.createElement('button'); x.className = 'bt dv'; x.textContent = '+' + (state.acc && state.acc.guestHours || 24) + ' h'; x.addEventListener('click', async () => { buzz(8); paintDevs(await rpc({ t: 'extend', dev: d.id })); }); bx.appendChild(x); }
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
/* qué pueden hacer invitados y miembros */
function paintAccess() {
  if (!state.acc) return;
  const P = state.acc[acWho];
  segPaint($('#acWho'), 'w', acWho);
  $('#acHrs').hidden = acWho !== 'guest';
  const hs = $('#acHours'), h = String(state.acc.guestHours);   // un valor puesto fuera del mando sale como opción más
  if (![...hs.options].some(o => o.value === h)) hs.add(new Option(h + ' h', h));
  hs.value = h;
  $('#acWeb').setAttribute('aria-pressed', !!P.web); $('#acLib').setAttribute('aria-pressed', !!P.library); $('#acStage').setAttribute('aria-pressed', !!P.stage);
  segPaint($('#acAgent'), 'v', P.agent);
  segPaint($('#acMusic'), 'v', P.music);
  $('#acVol').value = P.volMax; $('#acVolV').textContent = P.volMax + ' %';
}
let acT = 0;
function accSave() { clearTimeout(acT); acT = setTimeout(async () => { const r = await rpc({ t: 'access', op: 'set', cfg: state.acc }); if (r.access) { state.acc = r.access; paintAccess(); } }, 250); }
const acSet = (k, v) => { if (!state.acc || state.acc[acWho][k] === v) return; buzz(7); state.acc[acWho][k] = v; paintAccess(); accSave(); };
/* peticiones de acceso que llegan al administrador */
let reqPid = null;
function showReq(j) { reqPid = j.pid; $('#reqName').textContent = j.name; $('#req').hidden = false; buzz(30); }
function hideReq(pid) { if (!pid || pid === reqPid) { $('#req').hidden = true; reqPid = null; } }

export const admin = {
  name: 'admin',
  msgs: { pairreq: showReq, pairdone: j => hideReq(j.pid) },
  init() {
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
      box.append('Código ', b, ` · caduca en ${r.minutes} min y sirve una vez. Ábrelo en el otro dispositivo o escribe el código en «Tengo un código de administrador» (si ya tiene acceso, en «¿Tienes un código de administrador?» de sus Ajustes).`);
      try { if (navigator.share) await navigator.share({ title: document.title + ' (admin)', url: r.url }); else { await navigator.clipboard.writeText(r.url); pill('Enlace copiado'); } } catch {}
    });
    $('#kickG').addEventListener('click', async () => {
      const b = $('#kickG');
      if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = '¿Quitar a todos los invitados?'; setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Quitar a todos los invitados'; }, 3000); return; }
      b.classList.remove('sure'); b.textContent = 'Quitar a todos los invitados'; paintDevs(await rpc({ t: 'kickguests' }));
    });
    segOn($('#acWho'), 'w', w => { if (w === acWho) return; buzz(7); acWho = w; paintAccess(); });
    $('#acHours').addEventListener('change', e => { if (!state.acc) return; buzz(7); state.acc.guestHours = +e.target.value; accSave(); });
    $('#acWeb').addEventListener('click', () => acSet('web', !state.acc[acWho].web));
    $('#acLib').addEventListener('click', () => acSet('library', !state.acc[acWho].library));
    $('#acStage').addEventListener('click', () => acSet('stage', !state.acc[acWho].stage));
    segOn($('#acAgent'), 'v', v => acSet('agent', v));
    segOn($('#acMusic'), 'v', v => acSet('music', v));
    $('#acVol').addEventListener('input', e => { $('#acVolV').textContent = e.target.value + ' %'; });
    $('#acVol').addEventListener('change', e => acSet('volMax', +e.target.value));
    $('#req').addEventListener('click', async e => {
      const b = e.target.closest('[data-r]'); if (!b || !reqPid) return; buzz(10);
      const r = await rpc({ t: 'pairanswer', pid: reqPid, ok: b.dataset.r !== 'no', role: b.dataset.r });
      if (r.error) pill(r.error); else pill(b.dataset.r === 'no' ? 'Rechazado' : 'Acceso concedido');
      hideReq(); if ($('#setS').classList.contains('on')) refreshDevs();
    });
  },
};
