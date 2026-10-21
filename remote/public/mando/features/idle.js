// Pantalla en reposo de la tele (ajustes, solo admin): momento, horario (también por día), tiempos, música, distribución
// y el cristal del panel de Jota en la tele.
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
  $('#idMus').setAttribute('aria-pressed', !!icfg.music);
  $('#idNfx').setAttribute('aria-pressed', icfg.netflix === 'on');
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
export async function idleLoad() { const r = await rpc({ t: 'idle', op: 'get' }); if (r && r.cfg) { icfg = r.cfg; idlePaint(); } }
function idleSave() { clearTimeout(iT); iT = setTimeout(async () => { const r = await rpc({ t: 'idle', op: 'set', cfg: icfg }); if (r && r.cfg) icfg = r.cfg; }, 300); }
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
    $('#idMus').addEventListener('click', () => icfg && put('music', !icfg.music));
    $('#idNfx').addEventListener('click', () => icfg && put('netflix', icfg.netflix === 'on' ? 'off' : 'on'));
    $('#idCalm').addEventListener('click', () => icfg && put('calm', !icfg.calm));
    $('#idShow').addEventListener('click', () => { buzz(7); cmd({ t: 'idle', op: 'show' }); closeSheet(); });
  },
};
