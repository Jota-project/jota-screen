// Pantalla en reposo de la tele (ajustes, solo admin): modo, horario (también por día), tiempos, música, disposición
// y cómo se pinta el agente en la tele (diseño nuevo y nivel de cristal).
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
  $('#idMus').setAttribute('aria-pressed', !!icfg.music);
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
    $('#idMus').addEventListener('click', () => { if (!icfg) return; icfg.music = !icfg.music; idlePaint(); idleSave(); });
    $('#idLay').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !icfg) return; buzz(7); icfg.layout = b.dataset.l; idlePaint(); idleSave(); });
    $('#idRe').addEventListener('change', e => { if (icfg) { icfg.rearrangeMin = +e.target.value; idleSave(); } });
    $('#idCalm').addEventListener('click', () => { if (!icfg) return; icfg.calm = !icfg.calm; idlePaint(); idleSave(); });
    $('#idAgDes').addEventListener('click', () => { if (!icfg) return; icfg.agentDesign = icfg.agentDesign === DESIGN_ON ? DESIGN_OFF : DESIGN_ON; idlePaint(); idleSave(); });
    $('#idGlass').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setGlass(b.dataset.g); });
    $('#idGlass').addEventListener('keydown', glassKey);
    $('#idShow').addEventListener('click', () => { buzz(7); cmd({ t: 'idle', op: 'show' }); closeSheet(); });
  },
};
