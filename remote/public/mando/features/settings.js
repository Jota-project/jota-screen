// Ajustes de este móvil (velocidad, desplazamiento, vibración, tema, pantalla completa, orbe mientras Jota habla) y la hoja de ajustes, que también
// enseña quién eres y, a un admin, los dispositivos, los permisos y el reposo.
import { $ } from '../core/dom.js';
import { cfg, saveCfg, state, on } from '../core/store.js';
import { getRtt, isUp } from '../core/api.js';
import { ROLE_N, left } from '../core/perms.js';
import { buzz } from '../ui/haptics.js';
import { openSheet, isOpen } from '../ui/sheets.js';
import { applyTheme } from '../ui/theme.js';
import { paintAmbient } from './ambient.js';
import { refreshDevs } from './admin.js';
import { idleLoad } from './idle.js';

function refreshSet() {
  $('#rSpeed').value = cfg.speed; $('#vSpeed').textContent = cfg.speed.toFixed(1) + '×';
  $('#rScroll').value = cfg.scroll; $('#vScroll').textContent = cfg.scroll.toFixed(1) + '×';
  $('#swNat').setAttribute('aria-pressed', cfg.natural); $('#swHap').setAttribute('aria-pressed', cfg.haptic);
  $('#swDark').setAttribute('aria-pressed', cfg.theme !== 'claro');
  $('#swFs').setAttribute('aria-pressed', !!document.fullscreenElement);
  $('#segIntr').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === (cfg.voiceInterrupt !== false))));
  $('#foot').textContent = (isUp() ? 'Conectado' : 'Sin conexión') + (getRtt() ? ' · ' + Math.round(getRtt()) + ' ms' : '');
}

export const settings = {
  name: 'settings',
  clicks: { more: () => { refreshSet(); if (state.me && state.me.role === 'admin') { refreshDevs(); idleLoad(); } openSheet('setS'); } },
  init() {
    $('#rSpeed').addEventListener('input', e => { cfg.speed = +e.target.value; $('#vSpeed').textContent = cfg.speed.toFixed(1) + '×'; saveCfg(); });
    $('#rScroll').addEventListener('input', e => { cfg.scroll = +e.target.value; $('#vScroll').textContent = cfg.scroll.toFixed(1) + '×'; saveCfg(); });
    $('#swNat').addEventListener('click', () => { cfg.natural = !cfg.natural; saveCfg(); refreshSet(); });
    $('#swHap').addEventListener('click', () => { cfg.haptic = !cfg.haptic; saveCfg(); refreshSet(); buzz(12); });
    // al pulsar el orbe mientras Jota habla: interrumpir (por defecto) o esperar
    $('#segIntr').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; cfg.voiceInterrupt = b.dataset.v === '1'; saveCfg(); refreshSet(); buzz(7); });
    $('#swDark').addEventListener('click', () => { cfg.theme = cfg.theme === 'claro' ? 'oscuro' : 'claro'; saveCfg(); applyTheme(); paintAmbient(); refreshSet(); buzz(8); });
    if (!document.documentElement.requestFullscreen) $('#fsRow').hidden = true;
    $('#swFs').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
      setTimeout(refreshSet, 250);
    });
    setInterval(() => { if (isOpen('setS')) refreshSet(); }, 1000);
    on('me', j => {                                       // quién soy; lo de admin, solo a un admin
      $('#admBox').hidden = j.role !== 'admin';
      $('#clBox').hidden = j.role === 'admin';
      const mb = $('#meBox'); mb.textContent = '';
      const b = document.createElement('b'); b.textContent = j.name; mb.append('Estás como ', b, ' · ' + (ROLE_N[j.role] || j.role) + (j.expires ? ' · ' + left(j.expires) : ''));
      if (j.role === 'admin' && $('#setS').classList.contains('on')) refreshDevs();
    });
  },
};
