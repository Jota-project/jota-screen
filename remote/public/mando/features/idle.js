// Pantalla en reposo de la tele (ajustes, solo admin): momento, horario (también por día), tiempos, «Seguir viendo» (fuentes
// en orden, aspecto, cuántas a la vez; la fila de Spotify es `music`), distribución y el cristal del panel de Jota en la tele.
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
// «Seguir viendo»: las fuentes que conoce el mando (el servidor manda el orden en cfg.suggest.sources)
const SG_SRC = { netflix: ['Netflix', 'Series a medias'], spotify: ['Spotify', 'Lo último que sonó'], youtube: ['YouTube', 'Pronto'] };
const SG_SOON = new Set(['youtube']);                    // aún sin datos: se ordena, pero no se enciende
const SG_LOOK = { discreto: 'Una fila de series pequeñas', destacado: 'Una serie en grande', auto: 'En grande si últimamente ves sobre todo una' };

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
  sgPaint();
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
const sgOn = x => (x.id === 'spotify' ? !!icfg.music : !!x.on);
function sgPaint() {
  const sg = icfg.suggest;
  $('#sgOn').setAttribute('aria-pressed', !!(sg && sg.on));
  $('#sgSrc').textContent = '';
  if (!sg) return;                                       // un servidor de antes: sin «Seguir viendo» configurable
  sg.sources.filter(x => SG_SRC[x.id]).forEach((x, i, all) => {
    const [n, h] = SG_SRC[x.id], on = sgOn(x);
    const r = document.createElement('div'); r.className = 'sgRow' + (on ? '' : ' off'); r.setAttribute('role', 'listitem');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = n;
    const sm = document.createElement('small'); sm.textContent = h; nm.append(sm);
    const mv = document.createElement('span'); mv.className = 'mv';
    for (const [d, t] of /** @type {[number, string][]} */ ([[-1, '↑'], [1, '↓']])) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.dataset.mv = String(d); b.dataset.id = x.id;
      b.setAttribute('aria-label', (d < 0 ? 'Subir ' : 'Bajar ') + n); b.disabled = d < 0 ? i === 0 : i === all.length - 1; mv.append(b);
    }
    const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'sw'; sw.dataset.id = x.id;
    sw.setAttribute('aria-pressed', String(on)); sw.setAttribute('aria-label', n + (SG_SOON.has(x.id) ? ' (pronto)' : '')); sw.disabled = SG_SOON.has(x.id);
    r.append(logo(x.id), nm, mv, sw); $('#sgSrc').append(r);
  });
  segPaint($('#sgLook'), 'v', sg.look || 'discreto');
  $('#sgLookH').textContent = SG_LOOK[sg.look] || SG_LOOK.discreto;
  segPaint($('#sgMax'), 'v', String(sg.max || 2));
}
/** subir/bajar una fuente (se queda el foco en el mismo botón) o encenderla; Spotify es el interruptor de la música */
function sgClick(e) {
  const b = e.target.closest('button'); if (!b || !icfg || !icfg.suggest) return;
  const list = icfg.suggest.sources, i = list.findIndex(x => x.id === b.dataset.id);
  if (i < 0) return;
  buzz(7);
  if (b.dataset.mv) {
    const j = i + Number(b.dataset.mv); if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    sgPaint(); idleSave();
    const again = $('#sgSrc').querySelector(`button[data-id="${b.dataset.id}"][data-mv="${b.dataset.mv}"]`);
    (again && !again.disabled ? again : $('#sgSrc').querySelector(`button.sw[data-id="${b.dataset.id}"]`)).focus();
    return;
  }
  if (b.dataset.id === 'spotify') icfg.music = !icfg.music; else list[i].on = !list[i].on;
  sgPaint(); idleSave();
}
// cambia un ajuste de «Seguir viendo», vibra, repinta y guarda
function sgPut(k, v) { if (!icfg || !icfg.suggest || icfg.suggest[k] === v) return; buzz(7); icfg.suggest[k] = v; sgPaint(); idleSave(); }
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
    $('#sgOn').addEventListener('click', () => icfg && icfg.suggest && sgPut('on', !icfg.suggest.on));
    $('#sgSrc').addEventListener('click', sgClick);
    segOn($('#sgLook'), 'v', v => sgPut('look', v));
    segOn($('#sgMax'), 'v', v => sgPut('max', +v));
    $('#idCalm').addEventListener('click', () => icfg && put('calm', !icfg.calm));
    $('#idShow').addEventListener('click', () => { buzz(7); cmd({ t: 'idle', op: 'show' }); closeSheet(); });
  },
};
