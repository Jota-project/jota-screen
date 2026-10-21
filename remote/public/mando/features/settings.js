// Hoja de ajustes: portada por alcance (este móvil, la tele, personas) con un resumen por fila y una página por tema.
// Aquí viven los ajustes de este móvil (tema, pantalla completa, puntero, vibración, orbe mientras Jota habla), el perfil de
// Netflix y quién eres; a un admin, además, el reposo, Jota en la tele, los dispositivos y los permisos.
import { $ } from '../core/dom.js';
import { cfg, saveCfg, state, on } from '../core/store.js';
import { getRtt, isUp, rpc } from '../core/api.js';
import { ROLE_N, left } from '../core/perms.js';
import { buzz } from '../ui/haptics.js';
import { segOn, segPaint } from '../ui/seg.js';
import { openSheet, isOpen } from '../ui/sheets.js';
import { applyTheme } from '../ui/theme.js';
import { paintAmbient } from './ambient.js';
import { refreshDevs, devSum, permSum } from './admin.js';
import { idleLoad, idleSum, glassSum } from './idle.js';

const x = n => n.toFixed(1).replace('.', ',') + '×';
const isAdmin = () => !!state.me && state.me.role === 'admin';

function refreshSet() {
  $('#rSpeed').value = cfg.speed; $('#vSpeed').textContent = x(cfg.speed);
  $('#rScroll').value = cfg.scroll; $('#vScroll').textContent = x(cfg.scroll);
  $('#swNat').setAttribute('aria-pressed', cfg.natural); $('#swHap').setAttribute('aria-pressed', cfg.haptic);
  segPaint($('#segTheme'), 'v', cfg.theme === 'claro' ? 'claro' : 'oscuro');
  $('#swFs').setAttribute('aria-pressed', !!document.fullscreenElement);
  segPaint($('#segIntr'), 'v', cfg.voiceInterrupt !== false ? '1' : '0');
  $('#foot').textContent = (isUp() ? 'Conectado' : 'Sin conexión') + (getRtt() ? ' · ' + Math.round(getRtt()) + ' ms' : '');
  $('#footDot').className = 'dot' + (isUp() ? ' ok' : ' bad');
  // resúmenes de la portada
  $('#sumMovil').textContent = (cfg.theme === 'claro' ? 'Claro' : 'Oscuro') + ' · puntero ' + x(cfg.speed) + ' · ' + (cfg.haptic ? 'vibra' : 'sin vibrar');
  $('#sumReposo').textContent = idleSum(); $('#sumJota').textContent = glassSum();
  $('#sumNetflix').textContent = $('#nfProf').value ? 'Perfil ' + $('#nfProf').value : '';
  $('#sumDevs').textContent = devSum(); $('#sumPerms').textContent = permSum();
  $('#teleSh').hidden = !isAdmin() && $('#nfBox').hidden;
}

// perfil de Netflix (lo ven quienes pueden abrir webs, salvo invitados; sale cuando la tele ya conoce los perfiles)
async function netflixLoad() {
  const box = $('#nfBox');
  if (!state.me || state.me.role === 'guest') { box.hidden = true; return; }
  const r = await rpc({ t: 'netflix', op: 'profiles' });
  const list = (r && r.profiles) || [];
  box.hidden = !list.length;
  if (!list.length) return;
  const sel = $('#nfProf'); sel.textContent = '';
  for (const n of list) sel.add(new Option(n, n, false, n === r.profile));
}

// páginas de la hoja: una a la vez; al entrar se enfoca «Volver» y al volver, la fila de la que se vino
const ADMIN_PAGES = ['reposo', 'jota', 'personas', 'permisos'];
let from = null;
function page(p) {
  for (const s of $('#setS').querySelectorAll('.sp')) s.hidden = s.dataset.p !== p;
  $('#setS').scrollTop = 0;
  if (p !== 'home') $(`#setS .sp[data-p="${p}"] [data-back]`).focus({ preventScroll: true });
  else if (from) { from.focus({ preventScroll: true }); from = null; }
}

export const settings = {
  name: 'settings',
  clicks: { more: () => { page('home'); refreshSet(); netflixLoad(); if (isAdmin()) { refreshDevs(); idleLoad(); } openSheet('setS'); } },
  init() {
    $('#setS').addEventListener('click', e => {
      const t = /** @type {HTMLElement} */ (e.target);
      const g = /** @type {HTMLElement} */ (t.closest('[data-go]')); if (g) { buzz(7); from = g; page(g.dataset.go); return; }
      if (t.closest('[data-back]')) { buzz(7); page('home'); }
    });
    $('#rSpeed').addEventListener('input', e => { cfg.speed = +e.target.value; $('#vSpeed').textContent = x(cfg.speed); saveCfg(); });
    $('#rScroll').addEventListener('input', e => { cfg.scroll = +e.target.value; $('#vScroll').textContent = x(cfg.scroll); saveCfg(); });
    $('#swNat').addEventListener('click', () => { cfg.natural = !cfg.natural; saveCfg(); refreshSet(); buzz(7); });
    $('#swHap').addEventListener('click', () => { cfg.haptic = !cfg.haptic; saveCfg(); refreshSet(); buzz(12); });
    // al pulsar el orbe mientras Jota habla: interrumpir (por defecto) o esperar
    segOn($('#segIntr'), 'v', v => { cfg.voiceInterrupt = v === '1'; saveCfg(); refreshSet(); buzz(7); });
    segOn($('#segTheme'), 'v', v => { if (cfg.theme === v) return; cfg.theme = v; saveCfg(); applyTheme(); paintAmbient(); refreshSet(); buzz(7); });
    $('#nfProf').addEventListener('change', async e => { buzz(7); refreshSet(); const r = await rpc({ t: 'netflix', op: 'setprofile', profile: e.target.value }); if (!r || r.error) netflixLoad(); });
    if (!document.documentElement.requestFullscreen) $('#fsRow').hidden = true;
    $('#swFs').addEventListener('click', () => {
      buzz(7);
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
      setTimeout(refreshSet, 250);
    });
    setInterval(() => { if (isOpen('setS')) refreshSet(); }, 1000);
    on('me', j => {                                       // quién soy; lo de admin, solo a un admin
      for (const el of $('#setS').querySelectorAll('.adm')) /** @type {HTMLElement} */ (el).hidden = j.role !== 'admin';
      $('#clBox').hidden = j.role === 'admin';
      const mb = $('#meBox'); mb.textContent = '';
      const b = document.createElement('b'); b.textContent = j.name; mb.append(b, ' · ' + (ROLE_N[j.role] || j.role) + (j.expires ? ' · ' + left(j.expires) : ''));
      const cur = /** @type {HTMLElement} */ ($('#setS').querySelector('.sp:not([hidden])'));
      if (j.role !== 'admin' && cur && ADMIN_PAGES.includes(cur.dataset.p)) page('home');   // le han quitado el admin con la página abierta
      if (j.role === 'admin' && isOpen('setS')) refreshDevs();
    });
  },
};
