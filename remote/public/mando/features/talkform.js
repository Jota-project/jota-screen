// Formato de la conversación en la tele (panel a la derecha o píldora arriba), desde la hoja de Jota. Mientras la tele
// enseña la conversación y el servidor deja cambiarla (`talk` {ev:'form', form, canSwitch}), la tarjeta de la
// conversación (#agCard: la frase y la respuesta) se desliza en horizontal: hacia la derecha, panel (a ese lado vive en
// la tele); hacia la izquierda, píldora. Sigue al dedo, se resiste en el sentido que no cambia nada y al soltar vuelve a
// su sitio con un pequeño rebote. Para quien no puede deslizar, el botón #agForm («Ampliar en la tele» / «Hacer
// píldora»: su texto es la acción, así que no lleva aria-pressed, que con ese texto diría lo contrario de lo que hay; el
// cambio, cuando el servidor lo confirma, se anuncia en la región viva #agFs). Las dos cosas mandan {t:'talkform', form};
// lo que se pinta es siempre lo último que dijo el servidor (nada se da por hecho antes de que conteste). Sin
// conversación en la tele (`hidden`) o con canSwitch false, no hay control. No es un módulo del mando: lo llama agent.js,
// dueño de la hoja `agS` y de `talk`.
import { $ } from '../core/dom.js';
import { rpc, onWs } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { pill } from '../ui/pill.js';

/** Formatos de la capa en la tele: copia de FORMS de remote/src/tv/agent-contract.js (test/unit/mando.test.js lo comprueba). */
export const FORMS = Object.freeze(['pill', 'panel']);
export const SWIPE_MIN_PX = 64;                         // recorrido horizontal que cambia el formato al soltar
export const SWIPE_MIN_VEL = 0.45;                      // px/ms: un golpe rápido también lo cambia…
export const FLICK_MIN_PX = 24;                         // …si recorre al menos esto (un temblor rápido no cuenta)
export const LOCK_PX = 10;                              // holgura antes de decidir si el gesto es horizontal o vertical
export const RUBBER = 0.3;                              // resistencia: en el sentido que no cambia nada y pasado el umbral
export const VEL_WINDOW_MS = 90;                        // la velocidad al soltar, sobre los últimos ms del gesto
// sentido que lleva a cada formato (como en la tele: el panel está a la derecha)
const DIR = { panel: 1, pill: -1 };
// lo que hace el botón según lo que hay ahora en la tele
const LABEL = { pill: 'Ampliar en la tele', panel: 'Hacer píldora' };
// lo que se anuncia (#agFs) cuando el servidor confirma un cambio de formato
const SAID = { pill: 'En la tele: píldora', panel: 'En la tele: panel grande' };
const IGNORED = 'sin respuesta';                        // rpc sin contestar: el evento `form` dirá cómo quedó

/** El otro formato. @param {string} form */
const other = form => (form === 'pill' ? 'panel' : 'pill');

/**
 * Qué formato pide un deslizamiento al soltar, o null si ninguno: solo el sentido del otro formato, pasado el umbral o
 * con un golpe rápido de recorrido mínimo.
 * @param {string} form el formato que hay ahora en la tele
 * @param {number} dx recorrido horizontal (px, positivo hacia la derecha)
 * @param {number} vx velocidad horizontal al soltar (px/ms)
 * @returns {'pill' | 'panel' | null}
 */
export function decide(form, dx, vx) {
  if (!FORMS.includes(form)) return null;
  const to = other(form), d = dx * DIR[to], v = vx * DIR[to];
  return d >= SWIPE_MIN_PX || (v >= SWIPE_MIN_VEL && d >= FLICK_MIN_PX) ? to : null;
}

/**
 * Cuánto se mueve la tarjeta para un recorrido del dedo: igual hasta el umbral en el sentido que cambia el formato y con
 * resistencia pasado el umbral o en el sentido contrario (encaja, no se suelta libre).
 * @param {string} form @param {number} dx @returns {number}
 */
export function rubber(form, dx) {
  const s = DIR[other(form)] || 1, d = dx * s;
  if (d <= 0) return d * RUBBER * s;
  return (d <= SWIPE_MIN_PX ? d : SWIPE_MIN_PX + (d - SWIPE_MIN_PX) * RUBBER) * s;
}

/**
 * Velocidad horizontal al soltar (px/ms) con los puntos de los últimos VEL_WINDOW_MS antes de soltar: deslizar deprisa,
 * pararse y levantar el dedo no es un golpe.
 * @param {{ x: number, t: number }[]} pts posiciones del gesto, en orden (con la de soltar) @param {number} tUp
 * @returns {number}
 */
export function releaseVel(pts, tUp) {
  const w = pts.filter(p => tUp - p.t <= VEL_WINDOW_MS);
  if (w.length < 2) return 0;
  const p = w[0], q = w[w.length - 1];
  return q.t > p.t ? (q.x - p.x) / (q.t - p.t) : 0;
}

/**
 * Eje del gesto tras la holgura: 'x' (cambia el formato), 'y' (es desplazar la hoja: se suelta) o null (aún no se sabe).
 * @param {number} dx @param {number} dy @returns {'x' | 'y' | null}
 */
export function axis(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** @type {{ form: string, canSwitch: boolean } | null} */
let got = null;                                         // lo último que dijo el servidor (null: la tele no enseña la conversación)
/** @type {string | null} */
let pend = null;                                        // el formato pedido, hasta que el servidor conteste
let asked = 0;                                          // número de la petición: la respuesta de una ya sustituida no se pinta
/** @type {{ id: number, x0: number, y0: number, ax: 'x' | 'y' | null, dx: number, pts: { x: number, t: number }[] } | null} */
let drag = null;

const active = () => !!got && got.canSwitch && FORMS.includes(got.form);

/** Tarjeta, pista y botón según lo último recibido (y lo pedido, en la pista). */
function paint() {
  const card = $('#agCard'), b = $('#agForm'), h = $('#agFh'), on = active();
  if (!on) release();
  if (on) card.dataset.sw = got.form; else delete card.dataset.sw;
  h.hidden = !on;
  b.hidden = !on;
  if (!on) return;
  b.textContent = LABEL[got.form];
  arm(pend);
}
/** La pista marca el formato actual y, si lo hay, el que se va a pedir (o ya se pidió). @param {string | null} to */
function arm(to) {
  for (const s of /** @type {NodeListOf<HTMLElement>} */ ($('#agFh').querySelectorAll('[data-f]'))) {
    s.classList.toggle('on', !!got && s.dataset.f === got.form);
    s.classList.toggle('arm', s.dataset.f === to);
  }
}

/** Pide el formato a la tele. @param {string} form */
function send(form) {
  if (!active() || form === got.form) return;
  buzz(10); pend = form; arm(pend);
  const me = ++asked;
  rpc({ t: 'talkform', form }).then(r => {
    if (me !== asked) return;
    pend = null; if (active()) arm(null);
    if (r && r.error && r.error !== IGNORED) pill(r.error);   // sin permiso, ocupado…: se queda como estaba
  });
}

/** La tarjeta vuelve a su sitio (con la transición de encaje del CSS). */
function release() {
  if (!drag) return;
  const card = $('#agCard');
  drag = null;
  card.classList.remove('drag');
  card.style.removeProperty('--dx');
}

function down(e) {
  if (!active() || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (drag) { if (!e.isPrimary) return; release(); }     // un segundo dedo no cuenta; uno nuevo sustituye a uno perdido
  if (/** @type {Element} */ (e.target).closest('button,input,a')) return;
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ax: null, dx: 0, pts: [] };
}
function move(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const card = $('#agCard'), dx = e.clientX - drag.x0;
  if (!drag.ax) {
    drag.ax = axis(dx, e.clientY - drag.y0);
    if (!drag.ax) return;
    if (drag.ax === 'y') { drag = null; return; }       // desplazar la hoja: el gesto es del navegador
    try { card.setPointerCapture(e.pointerId); } catch {}   // el dedo ya no está (o es sintético): sigue sin captura
    card.classList.add('drag');
    const sel = window.getSelection(); if (sel) sel.removeAllRanges();   // con ratón, el arrastre no selecciona texto
  }
  drag.dx = dx;
  const now = e.timeStamp;
  drag.pts.push({ x: e.clientX, t: now });
  while (drag.pts.length > 2 && now - drag.pts[0].t > VEL_WINDOW_MS) drag.pts.shift();
  card.style.setProperty('--dx', rubber(got.form, dx).toFixed(1) + 'px');
  arm(decide(got.form, dx, 0) || pend);
}
function up(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  d.pts.push({ x: e.clientX, t: e.timeStamp });
  const to = d.ax === 'x' && active() ? decide(got.form, d.dx, releaseVel(d.pts, e.timeStamp)) : null;
  release();
  if (to) send(to); else if (active()) arm(pend);
}
/** El navegador se quedó el gesto (p. ej. desplazar): vuelve sin pedir nada. */
function cancel(e) {
  if (!drag || e.pointerId !== drag.id) return;
  release();
  if (active()) arm(pend);
}

export const talkForm = {
  /**
   * Lo que dice el servidor: `talk` {ev:'form'} con el formato y si se puede cambiar, o null si la tele ya no enseña la
   * conversación (`hidden`).
   * @param {{ form?: string, canSwitch?: boolean } | null} j
   */
  got(j) {
    const was = got && got.form;
    got = j && FORMS.includes(j.form) ? { form: j.form, canSwitch: j.canSwitch === true } : null;
    pend = null;
    // solo un cambio de verdad: ni al aparecer, ni el mismo formato otra vez (reconexión, otro turno); sin
    // conversación se vacía para no dejar un anuncio viejo
    const fs = $('#agFs');
    if (!got) fs.textContent = '';
    else if (was && was !== got.form) fs.textContent = SAID[got.form];
    paint();
  },
  init() {
    const card = $('#agCard');
    card.addEventListener('pointerdown', down);
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', cancel);
    // solo la captura de la propia tarjeta: al capturar, el toque deja la implícita de la frase o la respuesta y ese
    // lostpointercapture sube hasta aquí (no es soltar)
    card.addEventListener('lostpointercapture', e => { if (e.target === card) cancel(e); });
    $('#agForm').addEventListener('click', () => { if (active()) send(other(got.form)); });
    // sin conexión no se sabe qué enseña la tele: el control se va hasta el próximo `form`
    onWs('close', () => talkForm.got(null));
  },
};
