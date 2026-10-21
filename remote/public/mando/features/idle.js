// Pantalla en reposo de la tele (ajustes, solo admin): modo, horario (también por día), tiempos, «Seguir viendo» (fuentes
// en orden, aspecto, cuántas a la vez; la fila de Spotify es `music`), disposición y cómo se pinta el agente en la tele.
import { $ } from '../core/dom.js';
import { cmd, rpc } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { closeSheet } from '../ui/sheets.js';

const DAYN = [['mon', 'Lun'], ['tue', 'Mar'], ['wed', 'Mié'], ['thu', 'Jue'], ['fri', 'Vie'], ['sat', 'Sáb'], ['sun', 'Dom']];
// agente en la tele: cfg.agentDesign ('v1' viejo | 'v2' nuevo) y cfg.glass (auto | A completo | B ligero | C opaco);
// si el servidor aún no los manda, se pinta lo de por defecto
const DESIGN_OFF = 'v1', DESIGN_ON = 'v2';
const GLASS_DEFAULT = 'auto';
// teclas del grupo de radios «Cristal» → paso dentro del grupo (Inicio/Fin van a los extremos)
const RADIO_STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
let icfg = null, iT = 0;
// «Seguir viendo»: las fuentes que conoce el mando (el servidor manda el orden en cfg.suggest.sources)
const SG_SRC = { netflix: ['Netflix', 'Series a medias'], spotify: ['Spotify', 'Lo último que sonó'], youtube: ['YouTube', 'Pronto'] };
const SG_SOON = new Set(['youtube']);                    // aún sin datos: se ordena, pero no se enciende
const SG_LOOK = { discreto: 'Una fila de series pequeñas', destacado: 'Una serie en grande', auto: 'En grande si últimamente ves sobre todo una' };
/** El nivel de cristal solo pinta con el diseño nuevo: con el viejo (o sin ajustes) el selector queda inoperable. */
export const glassActive = c => !!c && c.agentDesign === DESIGN_ON;
// segmento de botones con aria-pressed: marca el que lleva data-<key> igual a val
const segPaint = (sel, key, val) => $(sel).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset[key] === val));
// grupo de radios «Cristal»: aria-checked, foco itinerante (solo el marcado entra con Tab) y aria-disabled con el
// diseño viejo (sigue enfocable para que el lector de pantalla lo encuentre y diga por qué no responde). Apagado
// conserva el nivel guardado: se sigue viendo marcado y vuelve a mandar al pasar al diseño nuevo.
/** @param {{ agentDesign?: string, glass?: string }} [c] ajustes del reposo (por defecto, los cargados) */
export function glassPaint(c = icfg) {
  const g = c.glass || GLASS_DEFAULT;
  $('#idGlass').setAttribute('aria-disabled', !glassActive(c));
  $('#idGlass').querySelectorAll('button').forEach(b => { const on = b.dataset.g === g; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
}
function idlePaint() {
  if (!icfg) return;
  segPaint('#idMode', 'm', icfg.mode);
  $('#idBed').value = icfg.bed; $('#idWake').value = icfg.wake;
  $('#idPer').setAttribute('aria-pressed', !!icfg.perDay);
  $('#idIdle').value = String(icfg.idleMin); $('#idDim').value = String(icfg.dimMin);
  if (![...$('#idIdle').options].some(o => o.value === String(icfg.idleMin))) $('#idIdle').add(new Option(icfg.idleMin + ' min', icfg.idleMin, true, true));
  sgPaint();
  segPaint('#idLay', 'l', icfg.layout || 'rotar');
  $('#idRe').value = String(icfg.rearrangeMin ?? 20);
  if (![...$('#idRe').options].some(o => o.value === String(icfg.rearrangeMin))) $('#idRe').add(new Option(icfg.rearrangeMin + ' min', icfg.rearrangeMin, true, true));
  $('#idCalm').setAttribute('aria-pressed', !!icfg.calm);
  $('#idAgDes').setAttribute('aria-pressed', icfg.agentDesign === DESIGN_ON);
  glassPaint();
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
  segPaint('#sgLook', 'v', sg.look || 'discreto');
  $('#sgLookH').textContent = SG_LOOK[sg.look] || SG_LOOK.discreto;
  segPaint('#sgMax', 'v', String(sg.max || 2));
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

export async function idleLoad() { const r = await rpc({ t: 'idle', op: 'get' }); if (r && r.cfg) { icfg = r.cfg; idlePaint(); } }
function idleSave() { clearTimeout(iT); iT = setTimeout(async () => { const r = await rpc({ t: 'idle', op: 'set', cfg: icfg }); if (r && r.cfg) icfg = r.cfg; }, 300); }
function setGlass(g) { if (!glassActive(icfg) || !g || g === (icfg.glass || GLASS_DEFAULT)) return; buzz(7); icfg.glass = g; idlePaint(); idleSave(); }
// flechas, Inicio y Fin dentro del grupo de radios: mueven el foco y eligen a la vez (patrón ARIA de radiogroup)
function glassKey(e) {
  if (!glassActive(icfg)) return;
  const bs = [...$('#idGlass').querySelectorAll('button')], i = bs.indexOf(e.target);
  if (i < 0) return;
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : e.key in RADIO_STEP ? (i + RADIO_STEP[e.key] + bs.length) % bs.length : -1;
  if (j < 0) return;
  e.preventDefault(); bs[j].focus(); setGlass(bs[j].dataset.g);
}

export const idle = {
  name: 'idle',
  init() {
    $('#idMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg) return; buzz(7); icfg.mode = b.dataset.m; idlePaint(); idleSave(); });
    $('#idBed').addEventListener('change', e => { if (icfg && e.target.value) { icfg.bed = e.target.value; idleSave(); } });
    $('#idWake').addEventListener('change', e => { if (icfg && e.target.value) { icfg.wake = e.target.value; idleSave(); } });
    $('#idPer').addEventListener('click', () => { if (!icfg) return; icfg.perDay = !icfg.perDay; idlePaint(); idleSave(); });
    $('#idIdle').addEventListener('change', e => { if (icfg) { icfg.idleMin = +e.target.value; idleSave(); } });
    $('#idDim').addEventListener('change', e => { if (icfg) { icfg.dimMin = +e.target.value; idleSave(); } });
    $('#sgOn').addEventListener('click', () => { if (!icfg || !icfg.suggest) return; buzz(7); icfg.suggest.on = !icfg.suggest.on; sgPaint(); idleSave(); });
    $('#sgSrc').addEventListener('click', sgClick);
    $('#sgLook').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg || !icfg.suggest) return; buzz(7); icfg.suggest.look = b.dataset.v; sgPaint(); idleSave(); });
    $('#sgMax').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg || !icfg.suggest) return; buzz(7); icfg.suggest.max = +b.dataset.v; sgPaint(); idleSave(); });
    $('#idLay').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg) return; buzz(7); icfg.layout = b.dataset.l; idlePaint(); idleSave(); });
    $('#idRe').addEventListener('change', e => { if (icfg) { icfg.rearrangeMin = +e.target.value; idleSave(); } });
    $('#idCalm').addEventListener('click', () => { if (!icfg) return; icfg.calm = !icfg.calm; idlePaint(); idleSave(); });
    $('#idAgDes').addEventListener('click', () => { if (!icfg) return; icfg.agentDesign = icfg.agentDesign === DESIGN_ON ? DESIGN_OFF : DESIGN_ON; idlePaint(); idleSave(); });
    $('#idGlass').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setGlass(b.dataset.g); });
    $('#idGlass').addEventListener('keydown', glassKey);
    $('#idShow').addEventListener('click', () => { buzz(7); cmd({ t: 'idle', op: 'show' }); closeSheet(); });
  },
};
