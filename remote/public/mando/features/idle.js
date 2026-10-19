// Pantalla en reposo de la tele (ajustes, solo admin): modo, horario (también por día), tiempos, música y disposición.
import { $ } from '../core/dom.js';
import { cmd, rpc } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { closeSheet } from '../ui/sheets.js';

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
export async function idleLoad() { const r = await rpc({ t: 'idle', op: 'get' }); if (r && r.cfg) { icfg = r.cfg; idlePaint(); } }
function idleSave() { clearTimeout(iT); iT = setTimeout(async () => { const r = await rpc({ t: 'idle', op: 'set', cfg: icfg }); if (r && r.cfg) icfg = r.cfg; }, 300); }

export const idle = {
  name: 'idle',
  init() {
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
  },
};
