// Modos del mando según la tele (state.tv; solo con TV_ADB): J-Screen (el mando de siempre), Tele (el trackpad es la
// cruceta del Google TV) y Apagada (queda el botón de encender). Pinta la fila «J-Screen | Tele» y ⏻, manda power, src
// y tvkey, y avisa con la píldora de lo que cambia sin una orden de este mando. Clases en <html>: tele, tv, off, waking y tvq
// (la tele no responde). Lo leen controls (botones a tvkey) y trackpad (gesto a la cruceta) con inTv() y padGesture().
import { $ } from '../core/dom.js';
import { on } from '../core/store.js';
import { rpc } from '../core/api.js';
import { pill } from '../ui/pill.js';
import { buzz } from '../ui/haptics.js';
import { segOn, segPaint } from '../ui/seg.js';

/** Dirección de un gesto del trackpad: menos de 18 px de recorrido es OK; si no, gana el eje mayor. */
export function swipeDir(dx, dy) {
  if (Math.hypot(dx, dy) < 18) return 'ok';
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}
const HIT = { up: '.cu', down: '.cd', left: '.cl', right: '.cr', ok: '.cross .ok' };
/* la flecha dibujada mide 30 px; se acepta el toque hasta ARROW_SLOP px fuera (70 px de diana, por encima de los 44 de mínimo) */
const ARROW_SLOP = 20;

/** Un toque en (x, y) cae sobre una flecha dibujada: su dirección; si no, null (el toque es OK).
 *  @param {Record<string, {left: number, top: number, right: number, bottom: number}>} boxes */
export function arrowAt(x, y, boxes) {
  for (const [k, b] of Object.entries(boxes)) {
    if (x >= b.left - ARROW_SLOP && x <= b.right + ARROW_SLOP && y >= b.top - ARROW_SLOP && y <= b.bottom + ARROW_SLOP) return k;
  }
  return null;
}

let mode = 'j';            // lo que enseña el mando: 'j' | 'tv' | 'off'
let last = null;           // último state.tv
let expect = null;         // orden propia en curso ({ power } o { src }): hasta ver la tele así (o 4 s tras la respuesta), el estado no la deshace
let quietUntil = 0;        // tras una orden propia, lo que cambie no se avisa (la tele tarda en asentarse)
let known = null;          // último encendido conocido (sin null: una tele dormida a fondo no responde)
let bootUntil = 0;         // recién encendida: el servidor la lleva a J-Screen (como mucho 6 s); el lanzador no cuenta
let swapT = 0, homeT = 0, offT = 0, wakeT = 0;
let padLabel = '';
let home = false;          // el reposo está delante (state.amb): en J-Screen el trackpad es la cruceta del inicio (foco, A2)
const CROSS_LABEL = 'Cruceta: desliza hacia un lado o toca una flecha para moverte, toca en el centro para elegir';

/** ¿El mando está en modo Tele? (los botones y el trackpad van a la tele) */
export const inTv = () => mode === 'tv';
/** ¿El trackpad es la cruceta del inicio? (reposo delante y mando en J-Screen; el gesto mueve el foco de la tele) */
export const inHome = () => mode === 'j' && home;
const padAria = () => $('#pad').setAttribute('aria-label', mode === 'tv' || home ? CROSS_LABEL : padLabel);

/** Orden a la tele con respuesta, sin esperarla (las flechas van seguidas): si falla, la píldora lo dice. */
export function tvRpc(o) { rpc(o).then(r => { if (r && r.error) pill('La tele no responde'); }); }

/** Al soltar el trackpad en modo Tele: la flecha (u OK) a la tele y el chevrón se ilumina. Un toque sobre una flecha
 *  dibujada es esa flecha: se ve un botón y se pulsa como tal, sin obligar a deslizar. (x, y): donde se soltó. */
export function padGesture(dx, dy, x, y) {
  let k = swipeDir(dx, dy);
  if (k === 'ok') {
    const boxes = /** @type {Record<string, DOMRect>} */ ({});
    for (const d of ['up', 'down', 'left', 'right']) boxes[d] = $(HIT[d]).getBoundingClientRect();
    k = arrowAt(x, y, boxes) || 'ok';
  }
  const e = $(HIT[k]);
  if (mode === 'tv') tvRpc({ t: 'tvkey', k });
  else rpc({ t: 'idle', op: 'focus', k }).then(r => { if (r && r.error) pill(r.error); });
  buzz(9);
  e.classList.add('hit'); setTimeout(() => e.classList.remove('hit'), 260);
}

const modeOf = t => (t.power === 'off' ? 'off' : t.src === 'tv' && Date.now() > bootUntil ? 'tv' : 'j');
const matches = t => (expect.power ? t.power === expect.power && (expect.power === 'off' || t.src === 'j') : t.power === 'on' && t.src === expect.src);

/* el resaltado de la píldora J-Screen | Tele se desliza al botón elegido (con la fila oculta no hay medidas) */
function ind() {
  const b = /** @type {HTMLElement} */ ($('#srcSeg [aria-checked=true]')), i = $('#srcInd');
  if (!b || !b.offsetWidth) return;
  i.style.width = b.offsetWidth + 'px'; i.style.transform = 'translateX(' + (b.offsetLeft - 3) + 'px)';
}
function unwake() { document.documentElement.classList.remove('waking'); $('#offS').textContent = 'Toca para encender'; }

function view(v) {
  clearTimeout(offT);                                     // un apagado de fuera aún por enseñar ya no vale
  if (v === mode) return;
  const r = document.documentElement, was = mode;
  mode = v;
  if (v !== 'off') { segPaint($('#srcSeg'), 'src', v); ind(); }
  r.classList.toggle('off', v === 'off');
  if (was === 'off') { clearTimeout(wakeT); setTimeout(unwake, 900); }   // el orbe lleno mientras vuelve el mando
  // la ayuda sale, cambia el modo y entra la nueva
  if ((v === 'tv') !== r.classList.contains('tv')) {
    const h = $('#hint'); h.classList.add('swap'); clearTimeout(swapT);
    swapT = setTimeout(() => { r.classList.toggle('tv', mode === 'tv'); h.classList.remove('swap'); }, 220);
  }
  padAria();
  // lo que no se ve tampoco se alcanza con el teclado
  $('#offV').inert = v !== 'off'; $('main.app2').inert = v === 'off';
  for (const b of document.querySelectorAll('.j-only')) /** @type {HTMLElement} */ (b).inert = v === 'tv';
}

/** Reposo delante o no: la ayuda sale, cambia y entra, como al cambiar de modo. */
function setHome(h) {
  if (h === home) return;
  home = h; padAria();
  const h2 = $('#hint'); h2.classList.add('swap'); clearTimeout(homeT);   // su propio temporizador: view() no lo pisa
  homeT = setTimeout(() => { document.documentElement.classList.toggle('home', home); h2.classList.remove('swap'); }, 220);
}

function paint(s) {
  setHome(!!s.amb);
  const t = s.tv || null, r = document.documentElement, row = $('#srcRow');
  const wasHidden = row.hidden;
  row.hidden = !t; r.classList.toggle('tele', !!t);   // tele: hay tele por ADB (el CSS nuevo solo vale entonces)
  if (wasHidden && t) ind();
  const lost = !!t && t.power === null;
  r.classList.toggle('tvq', lost);
  for (const b of row.querySelectorAll('button')) { if (lost) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); }
  const prev = last; last = t;
  if (!t) { known = null; view('j'); return; }                          // sin tele configurada: el mando de siempre
  if (lost) return;                                       // sin respuesta: se queda como estaba
  const wasOff = known === 'off'; known = t.power;
  if (wasOff && t.power === 'on') {
    quietUntil = bootUntil = Date.now() + 6000;
    setTimeout(() => { if (last && last.power === 'on' && !expect) view(modeOf(last)); }, 6100);   // si se quedó en Tele
  }
  if (expect) { if (matches(t)) { expect = null; view(modeOf(t)); } return; }
  // lo que cambia sin una orden de este mando se dice (no al conectar, ni al volver de «sin respuesta»)
  let note = '';
  if (prev && prev.power === 'on' && Date.now() > quietUntil) {
    if (t.power === 'off') note = 'Han apagado la tele';
    else if (prev.src && t.src && prev.src !== t.src) note = t.src === 'tv' ? 'La tele se ha ido a Google TV' : 'La tele ha vuelto a J-Screen';
  }
  if (note) pill(note);
  const v = modeOf(t);
  if (note && v === 'off') { clearTimeout(offT); offT = setTimeout(() => view('off'), 700); }   // primero se lee el aviso
  else view(v);
}

/** Orden propia de power o src: el mando cambia ya y, si falla, vuelve a lo que diga la tele y lo cuenta. */
function order(o, want) {
  expect = want;
  const back = () => { if (expect === want) expect = null; if (last && last.power !== null) view(modeOf(last)); };
  return rpc(o).then(res => {
    quietUntil = Date.now() + 4000;
    if (res.error) { pill(res.error); back(); }
    // la lectura de justo después puede ser aún la de antes (la tecla Inicio, el reposo): se espera a ver la tele así
    else setTimeout(() => { if (expect === want) back(); }, 4000);
    return res;
  });
}
const usable = () => !!last && last.power !== null;

export const tele = {
  name: 'tele',
  clicks: {
    pwoff: () => { if (!usable() || mode === 'off') return; order({ t: 'power', on: false }, { power: 'off' }); view('off'); },
    pwon: () => {
      const r = document.documentElement;
      if (mode !== 'off' || r.classList.contains('waking')) return;
      r.classList.add('waking'); $('#offS').textContent = 'Encendiendo…';
      clearTimeout(wakeT); wakeT = setTimeout(() => { unwake(); pill('La tele no responde'); }, 10000);
      order({ t: 'power', on: true }, { power: 'on' }).then(res => { if (res.error) { clearTimeout(wakeT); unwake(); } });
    },
  },
  init() {
    padLabel = $('#pad').getAttribute('aria-label');
    // --o: orden de arriba abajo de los bloques, para la cascada al apagar y encender
    document.querySelectorAll('.app2>:not(.dock2),.dock2>*').forEach((e, i) => /** @type {HTMLElement} */ (e).style.setProperty('--o', String(i)));
    $('#offV').inert = true;
    segOn($('#srcSeg'), 'src', s => {
      if (!usable() || mode === 'off' || s === mode) return;
      buzz(7); view(s); order({ t: 'src', s }, { src: s });
    });
    on('state', paint);
    addEventListener('resize', ind);
    document.fonts.ready.then(ind);
  },
};
