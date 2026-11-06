// Pantalla en reposo de la tele (ajustes, solo admin): privacidad (modo visitas), momento, horario (también por día), tiempos,
// «Seguir viendo» (fuentes; la fila de Spotify es `music`), distribución y el cristal del panel de Jota en la tele.
import { $ } from '../core/dom.js';
import { cmd, rpc } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { segOn, segPaint } from '../ui/seg.js';
import { closeSheet } from '../ui/sheets.js';

const DAYN = [['mon', 'Lun'], ['tue', 'Mar'], ['wed', 'Mié'], ['thu', 'Jue'], ['fri', 'Vie'], ['sat', 'Sáb'], ['sun', 'Dom']];
const MODE_N = { auto: 'automático', day: 'día', evening: 'tarde', night: 'noche', cinema: 'cine' };
const LAY_N = { rotar: 'Ir cambiando', margen: 'Margen', zonas: 'Zonas', apilada: 'Apilada' };
const GLASS_N = { auto: 'automático', A: 'completo', B: 'ligero', C: 'opaco' };
let icfg = null, iT = 0;
// «Seguir viendo»: las fuentes que conoce el mando (el servidor manda la lista en cfg.suggest.sources)
const SG_SRC = { netflix: ['Netflix', 'Lo que estabas viendo'], spotify: ['Spotify', 'Lo último que sonó'], youtube: ['YouTube', 'Pronto'] };
const SG_SOON = new Set(['youtube']);                    // aún sin datos: no se enciende
// modo visitas: lo que se puede dejar ver igualmente
const PV_SRC = { netflix: ['Netflix', 'Lo que estabas viendo'], spotify: ['Spotify', 'Lo que suena y lo último que sonó'] };

/** Resúmenes de la portada de Ajustes ('' hasta que lleguen los ajustes). */
export const idleSum = () => icfg ? `${LAY_N[icfg.layout] || LAY_N.rotar} · ${MODE_N[icfg.mode] || icfg.mode} · duerme ${icfg.bed}` : '';
export const glassSum = () => icfg ? 'Cristal ' + (GLASS_N[icfg.glass] || GLASS_N.auto) : '';

// un valor guardado que no está en la lista (puesto por tv_idle) sale como opción más
function selPaint(sel, v) {
  const s = $(sel), val = String(v);
  if (![...s.options].some(o => o.value === val)) s.add(new Option(val + ' min', val));
  s.value = val;
}
function idlePaint() {
  if (!icfg) return;
  segPaint($('#idMode'), 'm', icfg.mode);
  $('#idBed').value = icfg.bed; $('#idWake').value = icfg.wake;
  $('#idPer').setAttribute('aria-pressed', !!icfg.perDay);
  selPaint('#idIdle', icfg.idleMin); selPaint('#idDim', icfg.dimMin); selPaint('#idRe', icfg.rearrangeMin ?? 20);
  sgPaint(); pvPaint();
  segPaint($('#idLay'), 'l', icfg.layout || 'rotar');
  $('#idCalm').setAttribute('aria-pressed', !!icfg.calm);
  segPaint($('#idGlass'), 'g', icfg.glass || 'auto');
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
/** El nodo <svg><use href="#l-…"></svg> del logo de una fuente (símbolos de index.html). @param {string} k */
function logo(k) {
  const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), u = document.createElementNS(NS, 'use');
  s.setAttribute('class', 'logo'); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', '#l-' + k); s.append(u);
  return s;
}
/** Una fila con logo, nombre, explicación e interruptor (data-id). */
function srcRow(id, [n, h], on, disabled = false) {
  const r = document.createElement('div'); r.className = 'sgRow' + (on ? '' : ' off'); r.setAttribute('role', 'listitem');
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = n;
  const sm = document.createElement('small'); sm.textContent = h; nm.append(sm);
  const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'sw'; sw.dataset.id = id;
  sw.setAttribute('aria-pressed', String(on)); sw.setAttribute('aria-label', n + (disabled ? ' (pronto)' : '')); sw.disabled = disabled;
  r.append(logo(id), nm, sw);
  return r;
}
const sgOn = x => (x.id === 'spotify' ? !!icfg.music : !!x.on);
function sgPaint() {
  const sg = icfg.suggest;
  $('#sgOn').setAttribute('aria-pressed', !!(sg && sg.on));
  $('#sgSrc').textContent = '';
  if (!sg) return;                                       // un servidor de antes: sin «Seguir viendo» configurable
  for (const x of sg.sources) if (SG_SRC[x.id]) $('#sgSrc').append(srcRow(x.id, SG_SRC[x.id], sgOn(x), SG_SOON.has(x.id)));
}
/** encender o apagar una fuente; Spotify es el interruptor de la música */
function sgClick(e) {
  const b = e.target.closest('button'); if (!b || !icfg || !icfg.suggest) return;
  const x = icfg.suggest.sources.find(s => s.id === b.dataset.id); if (!x) return;
  buzz(7);
  if (x.id === 'spotify') icfg.music = !icfg.music; else x.on = !x.on;
  sgPaint(); idleSave();
}
const hhmm = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
function pvPaint() {
  const pv = icfg.privacy;
  $('#pvOn').setAttribute('aria-pressed', !!(pv && pv.on));
  // shortcut: la hora del móvil; si la tele estuviera en otra zona horaria, la de la tele (tz) sería la buena
  $('#pvH').textContent = pv && pv.on ? (pv.until ? 'Se quita sola a las ' + hhmm(pv.until) : 'Activa') : 'Oculta lo personal de la tele';
  $('#pvShow').textContent = '';
  if (!pv || !pv.on) return;                             // apagada (o un servidor de antes): sin la lista
  for (const id of Object.keys(PV_SRC)) $('#pvShow').append(srcRow(id, PV_SRC[id], pv.show.includes(id)));
}
function pvClick(e) {
  const b = e.target.closest('button'); if (!b || !icfg || !icfg.privacy) return;
  const show = icfg.privacy.show, id = b.dataset.id;
  buzz(7);
  icfg.privacy.show = show.includes(id) ? show.filter(x => x !== id) : [...show, id];
  pvPaint(); idleSave();
}
// cambia un ajuste de «Seguir viendo», vibra, repinta y guarda
function sgPut(k, v) { if (!icfg || !icfg.suggest || icfg.suggest[k] === v) return; buzz(7); icfg.suggest[k] = v; sgPaint(); idleSave(); }
export async function idleLoad() { const r = await rpc({ t: 'idle', op: 'get' }); if (r && r.cfg) { icfg = r.cfg; idlePaint(); } }
function idleSave() { clearTimeout(iT); iT = setTimeout(async () => { const r = await rpc({ t: 'idle', op: 'set', cfg: icfg }); if (r && r.cfg) { icfg = r.cfg; pvPaint(); } }, 300); }
// cambia un ajuste, vibra, repinta y guarda (todos los controles igual)
function put(k, v) { if (!icfg || icfg[k] === v) return; buzz(7); icfg[k] = v; idlePaint(); idleSave(); }

export const idle = {
  name: 'idle',
  init() {
    segOn($('#idMode'), 'm', v => put('mode', v));
    segOn($('#idLay'), 'l', v => put('layout', v));
    segOn($('#idGlass'), 'g', v => put('glass', v));
    $('#idBed').addEventListener('change', e => { if (e.target.value) put('bed', e.target.value); });
    $('#idWake').addEventListener('change', e => { if (e.target.value) put('wake', e.target.value); });
    $('#idPer').addEventListener('click', () => icfg && put('perDay', !icfg.perDay));
    $('#idIdle').addEventListener('change', e => put('idleMin', +e.target.value));
    $('#idDim').addEventListener('change', e => put('dimMin', +e.target.value));
    $('#idRe').addEventListener('change', e => put('rearrangeMin', +e.target.value));
    $('#sgOn').addEventListener('click', () => icfg && icfg.suggest && sgPut('on', !icfg.suggest.on));
    $('#sgSrc').addEventListener('click', sgClick);
    $('#pvOn').addEventListener('click', () => { if (!icfg || !icfg.privacy) return; buzz(7); icfg.privacy = { ...icfg.privacy, on: !icfg.privacy.on }; pvPaint(); idleSave(); });
    $('#pvShow').addEventListener('click', pvClick);
    $('#idCalm').addEventListener('click', () => icfg && put('calm', !icfg.calm));
    $('#idShow').addEventListener('click', () => { buzz(7); cmd({ t: 'idle', op: 'show' }); closeSheet(); });
  },
};
