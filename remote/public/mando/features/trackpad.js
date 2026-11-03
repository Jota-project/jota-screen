// Trackpad: un dedo mueve el cursor (toque: clic; doble toque y arrastre: arrastrar), dos dedos desplazan (con
// inercia; toque con dos: clic derecho). Las rachas se juntan por fotograma. En modo Tele no hay puntero: el gesto
// entero, al soltar, es una flecha u OK de la cruceta (features/tele.js). Con el carril a la vista, el borde derecho es
// el carril: arrastrándolo se desplaza la página (TVC Diseño - Carril de desplazamiento).
import { $ } from '../core/dom.js';
import { cfg, persist } from '../core/store.js';
import { send } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { inTv, padGesture } from './tele.js';

const P = new Map();
let ax = 0, ay = 0, sxa = 0, sya = 0, raf = 0;
let downT = 0, moved = 0, maxN = 0, twoT = 0, twoMoved = 0, rcDone = false, dragging = false, tdArm = false, lastTap = 0;
let svy = 0, inertia = 0, inertiaEnd = null, x0 = 0, y0 = 0;
/* caught: el dedo cayó con la inercia en marcha (ese toque solo frena, no hace clic); lastMv: último movimiento que
   desplaza. Si al soltar han pasado más de STALE ms, los dedos estaban quietos y no hay inercia */
let caught = false, lastMv = 0;
const STALE = 80;
const r2 = n => Math.round(n * 100) / 100;
/* un halo malva sigue al dedo mientras toca (en vez de la onda) y la ayuda se esconde solo mientras se toca */
let haloId = null;
let pad, hint, halo;
/* la ayuda se retira para siempre tras HINT_USES gestos: es la pantalla que más se ve y ya se sabe usar */
const HINT_USES = 5;
let uses = 0;
function haloAt(e) { const b = pad.getBoundingClientRect(); halo.style.left = (e.clientX - b.left) + 'px'; halo.style.top = (e.clientY - b.top) + 'px'; }

/* Carril: la franja de RAIL_ZONE px del borde derecho, solo si se ve el carril (hay dato de scroll) y fuera del modo Tele.
   El gesto es del carril si el primer dedo cae en ella. Toque corto: clic, como en el resto. Arrastre (más de RAIL_ARM px en
   vertical): desplazamiento relativo con aceleración e inercia, en el sentido de una barra (bajar el pulgar baja la página),
   sea cual sea «Desplazamiento natural». Activo, crece y el pulgar se enciende en malva. Sin halo: con el mapeo relativo el
   dedo no está sobre el pulgar, y un halo a su lado diría que sí. */
const RAIL_ZONE = 44, RAIL_ARM = 6, RAIL_HOLD = 600, VMAX = 8;   // VMAX: px por ms, tope de la inercia
let rail, railT, railId = null, railDrag = false, railOff = 0, railPos = -1, railBuzzed = false;
const inRail = e => !rail.hidden && !inTv() && e.clientX >= pad.getBoundingClientRect().right - RAIL_ZONE;
/** Vuelve a reposo tras `ms` (0: ya). */
function railRest(ms) {
  clearTimeout(railOff);
  railOff = setTimeout(() => { rail.classList.remove('on'); railDrag = false; }, ms);
}

function flush() {
  raf = 0;
  if (ax || ay) { send('m ' + r2(ax) + ' ' + r2(ay)); ax = ay = 0; }
  if (sxa || sya) { send('w ' + r2(sxa) + ' ' + r2(sya)); sxa = sya = 0; }
}
const sched = () => { if (!raf) raf = requestAnimationFrame(flush); };
function endInertia() { const f = inertiaEnd; inertiaEnd = null; if (f) f(); }
function stopInertia() { if (inertia) { cancelAnimationFrame(inertia); inertia = 0; } endInertia(); }
/** @param {() => void} [onEnd] al acabar (o al pararla otro toque); también si no llega a arrancar */
function startInertia(onEnd) {
  stopInertia();
  inertiaEnd = onEnd || null;
  let v = Math.max(-VMAX, Math.min(VMAX, svy));  // px por ms ya con el signo final; tope: un toque raro no lanza la página
  if (Math.abs(v) < 0.35) { endInertia(); return; }
  let last = performance.now();
  const step = t => {
    const dt = Math.min(40, t - last); last = t;
    sya += v * dt; v *= Math.pow(0.0035, dt / 1000);   // frena en ~0,9 s
    sched();
    inertia = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
    if (!inertia) endInertia();
  };
  inertia = requestAnimationFrame(step);
}
function click(btn, p) { send('c ' + btn); buzz(btn === 3 ? 14 : 9); }

function hintBack() {
  hint.classList.remove('off');
  if (uses < HINT_USES) { persist.set('padUses', ++uses); hint.hidden = uses >= HINT_USES; }
}

function railUp(e) {
  P.delete(e.pointerId); railId = null;
  hintBack(); pad.classList.remove('on');
  if (railDrag) { if (e.timeStamp - lastMv > STALE) svy = 0; startInertia(() => railRest(RAIL_HOLD)); return; }
  if (e.type === 'pointerup' && !caught && e.timeStamp - downT < 240 && moved < 9) click(1);
  railRest(0);
}

function up(e) {
  if (e.pointerId === railId) { railUp(e); return; }
  const p = P.get(e.pointerId); if (!p) return;
  const n = P.size; P.delete(e.pointerId);
  const ok = e.type === 'pointerup';
  if (e.pointerId === haloId) {                   // el halo pasa al dedo que queda o se apaga
    const rest = P.keys().next();
    haloId = rest.done ? null : rest.value;
    if (haloId === null) {
      halo.classList.remove('on'); hintBack();
    }
  }
  if (n === 1) {
    pad.classList.remove('on');
    if (dragging) { send('b 1 0'); dragging = false; }
    else if (inTv()) { if (ok && maxN === 1) padGesture(e.clientX - x0, e.clientY - y0); }
    else if (ok && maxN === 1 && !caught && e.timeStamp - downT < 240 && moved < 9) { click(1, p); lastTap = e.timeStamp; }
    maxN = 0;
  } else if (n === 2 && !inTv()) {
    if (ok && !rcDone && e.timeStamp - twoT < 280 && twoMoved < 10) { rcDone = true; click(3, p); }
    else if (twoMoved > 14) { if (e.timeStamp - lastMv > STALE) svy = 0; startInertia(); }
  }
}

/** Pinta el carril con la posición que manda la tele ({pos, size} de 0 a 1, o null: sin scroll y sin carril). Al llegar
 *  a un extremo durante un arrastre del carril (o su inercia), vibra una vez. @param {{pos?: number, size?: number} | null} sc */
export function paintRail(sc) {
  if (!rail) { rail = $('#rail'); railT = $('#railT'); }  // puede llegar antes que init()
  rail.hidden = !sc;
  if (!sc) { railPos = -1; return; }
  const pos = Math.min(1, Math.max(0, +sc.pos || 0)), h = Math.max(0.08, Math.min(1, +sc.size || 0));
  railT.style.top = (pos * (1 - h) * 100).toFixed(2) + '%'; railT.style.height = (h * 100).toFixed(2) + '%';
  const edge = p => p <= 0.001 || p >= 0.999;
  if (railDrag && !railBuzzed && edge(pos) && railPos >= 0 && !edge(railPos)) { railBuzzed = true; buzz(10); }
  railPos = pos;
}

export const trackpad = {
  name: 'trackpad',
  init() {
    pad = $('#pad'); hint = $('#hint'); halo = $('#halo'); rail = $('#rail'); railT = $('#railT');
    uses = +persist.get('padUses', 0) || 0; hint.hidden = uses >= HINT_USES;
    pad.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (railId !== null) return;                    // con el carril en marcha, los demás dedos no cuentan
      try { pad.setPointerCapture(e.pointerId); } catch {}
      if (!P.size && inRail(e)) {
        caught = !!inertia; stopInertia(); clearTimeout(railOff);
        P.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
        railId = e.pointerId; railDrag = false; railBuzzed = false; svy = 0;
        downT = e.timeStamp; x0 = e.clientX; y0 = e.clientY; moved = 0;
        hint.classList.add('off');
        rail.classList.add('on'); pad.classList.add('on');
        return;
      }
      P.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (haloId === null) { haloId = e.pointerId; haloAt(e); halo.classList.add('on'); } hint.classList.add('off');
      if (P.size === 1) {
        caught = !!inertia; stopInertia(); downT = e.timeStamp; x0 = e.clientX; y0 = e.clientY; moved = 0; maxN = 1; dragging = false; svy = 0;
        tdArm = e.timeStamp - lastTap < 240; pad.classList.add('on');
      } else if (P.size === 2) { maxN = 2; twoT = e.timeStamp; twoMoved = 0; rcDone = false; svy = 0; }
    });
    pad.addEventListener('pointermove', e => {
      const p = P.get(e.pointerId); if (!p) return;
      if (e.pointerId === railId) {
        const dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
        moved += Math.abs(e.clientX - p.x) + Math.abs(dy);
        p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
        if (!railDrag) {
          if (Math.abs(e.clientY - y0) <= RAIL_ARM) return;
          railDrag = true; buzz(8);
        }
        const v = dy * cfg.scroll * (1 + Math.min(Math.abs(dy) / dt / 1.1, 2.6));   // la misma aceleración que el cursor
        sya += v; sched(); lastMv = e.timeStamp;
        svy = svy * 0.6 + Math.max(-VMAX, Math.min(VMAX, v / dt)) * 0.4;   // tope: un toque raro no lanza la página
        return;
      }
      if (e.pointerId === haloId) haloAt(e);
      if (inTv() && !dragging) return;                // en la tele solo cuenta el gesto al soltar
      const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
      p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
      if (P.size === 1) {
        if (maxN === 2) return;                       // queda un dedo de un gesto de dos: no es el cursor
        moved += Math.abs(dx) + Math.abs(dy);
        if (tdArm && !dragging && moved > 6) { dragging = true; send('b 1 1'); }
        const g = cfg.speed * (1 + Math.min(Math.hypot(dx, dy) / dt / 1.1, 2.6));   // aceleración según la velocidad
        ax += dx * g; ay += dy * g; sched();
      } else if (P.size === 2) {
        twoMoved += Math.abs(dx) + Math.abs(dy);
        const k = (cfg.natural ? -1 : 1) * cfg.scroll * 0.5;                          // cada dedo aporta la mitad
        sxa += dx * k; sya += dy * k; sched(); lastMv = e.timeStamp;
        svy = svy * 0.6 + (dy * k * 2 / dt) * 0.4;                                    // la página va a la velocidad de un dedo
      }
    });
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('contextmenu', e => e.preventDefault());
  },
};
