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
let inertia = 0, inertiaEnd = null, x0 = 0, y0 = 0;
/* caught: el dedo cayó con la inercia en marcha (ese toque solo frena, no hace clic) */
let caught = false;
/* Velocidad de salida: lo que se ha desplazado la página en los últimos VWIN ms, no una media por evento (que cambia con
   los Hz de la pantalla y pesa de más el frenazo al levantar el dedo). Ventana vacía: los dedos estaban quietos, sin inercia */
const VWIN = 80;
let vs = [];
/** Un desplazamiento de `d` px de página en el movimiento que acaba en `t` (y empezó `dt` ms antes). */
function track(t, d, dt) { vs.push({ t, d, dt }); while (vs[0].t <= t - VWIN) vs.shift(); }
/** px por ms al soltar en `t`; vacía la ventana. */
function releaseV(t) {
  const w = vs.filter(s => s.t > t - VWIN); vs = [];
  if (!w.length) return 0;
  return w.reduce((a, s) => a + s.d, 0) / Math.max(1, t - w[0].t + Math.min(w[0].dt, VWIN));
}
const r2 = n => Math.round(n * 100) / 100;
/* un halo malva sigue al dedo mientras toca (en vez de la onda) y la ayuda se esconde solo mientras se toca */
let haloId = null;
let pad, hint, halo;
/* la ayuda se retira para siempre tras HINT_USES gestos: es la pantalla que más se ve y ya se sabe usar */
const HINT_USES = 5;
let uses = 0;
function haloAt(e) { const b = pad.getBoundingClientRect(); halo.style.left = (e.clientX - b.left) + 'px'; halo.style.top = (e.clientY - b.top) + 'px'; }

/* Carril: la franja de RAIL_ZONE px del borde derecho, solo si se ve el carril (hay dato de scroll) y fuera del modo Tele.
   El gesto es del carril si el primer dedo cae en ella. Toque corto: clic, como en el resto. Pasados RAIL_ARM px se decide el
   eje: en horizontal (|dx| > 1,5·|dy|) el gesto pasa al cursor; si no, arrastre: desplazamiento relativo con aceleración e
   inercia, en el sentido de una barra (bajar el pulgar baja la página), sea cual sea «Desplazamiento natural». Activo, crece
   y el pulgar se enciende en malva. Sin halo: con el mapeo relativo el dedo no está sobre el pulgar, y un halo a su lado diría
   que sí. En un extremo, si el dedo sigue empujando, el pulgar se aplasta contra el borde (rubber-banding) */
const RAIL_ZONE = 44, RAIL_ARM = 10, RAIL_HOLD = 600, VMAX = 8;   // VMAX: px por ms, tope de la inercia
/* Medido en la tele el 2026-11-03 (Chrome 155 del kiosco, DPR 1,5): un golpe de rueda XTest desplaza 120 px CSS, que Chromium
   anima en ~165 ms. pointer.py da un golpe cada 30 px de dedo (TICK), así que la página va a WHEEL_PX px por px de dedo.
   INERTIA_MIN: a 0,2 px/ms sale un golpe cada 150 ms y sus animaciones aún se solapan; más despacio, la página iría a pulsos.
   shortcut: valores de esa tele y ese Chrome; si cambia TICK, el navegador o su escala, hay que volver a medirlos */
const WHEEL_PX = 120 / 30, INERTIA_MIN = 0.2;
/* Pulgar estimado: mientras el mando desplaza, el pulgar sigue a lo enviado (Δpos = px de dedo · WHEEL_PX / max) sin esperar
   al sondeo (250 ms más lo que tarde la tele). EST_HOLD ms después del último envío vuelve a mandar el dato de la tele */
const EST_HOLD = 700;
let rail, railT, railId = null, railDrag = false, railOff = 0, railPos = -1, railBuzzed = false;
let railY = 0, railOver = 0, railBack = 0;   // posición del pulgar (% de su alto) y lo que el dedo empuja pasado el extremo
let railH = 1, railMax = 0, railSc = null, estPos = -1, estT = 0;
/** Dónde se ve el pulgar: lo estimado mientras se desplaza; si no, lo que dice la tele. */
const shownPos = () => (estPos >= 0 ? estPos : railPos);
/** El mando acaba de mandar `d` px de dedo de rueda: el pulgar se adelanta a la tele. */
function railEstimate(d) {
  if (railPos < 0 || !railMax) return;
  estPos = Math.min(1, Math.max(0, shownPos() + d * WHEEL_PX / railMax));
  railY = estPos * (1 - railH) / railH * 100; railT.classList.add('live'); thumb();
  clearTimeout(estT); estT = setTimeout(() => { estPos = -1; railT.classList.remove('live'); paintRail(railSc); }, EST_HOLD);
}
const inRail = e => !rail.classList.contains('off') && !inTv() && e.clientX >= pad.getBoundingClientRect().right - RAIL_ZONE;
/** Resistencia de Apple: cuanto más se pasa del borde, menos sigue. */
const rubberband = (o, d, c = 0.55) => (o * d * c) / (d + c * o);
/** Pinta el pulgar: posición y, si el dedo empuja contra un extremo, aplastado hacia ese borde (como mucho al 85 %). */
function thumb() {
  const H = railOver ? rail.getBoundingClientRect().height : 1;
  const s = railOver ? 1 - Math.min(0.15, rubberband(railOver, H) / H) : 1;
  railT.style.transformOrigin = shownPos() >= 0.5 ? '50% 100%' : '50% 0';
  railT.style.transform = 'translateY(' + railY.toFixed(2) + '%)' + (s < 1 ? ' scaleY(' + s.toFixed(3) + ')' : '');
}
/** Suelta lo aplastado: vuelve con la curva de las hojas, sin rebote. */
function railRelease() {
  if (!railOver) return;
  railOver = 0; railT.classList.remove('rb'); railT.classList.add('back'); thumb();
  clearTimeout(railBack); railBack = setTimeout(() => railT.classList.remove('back'), 300);
}
/** Vuelve a reposo tras `ms` (0: ya). */
function railRest(ms) {
  clearTimeout(railOff);
  railOff = setTimeout(() => { rail.classList.remove('on'); railDrag = false; }, ms);
}

function flush() {
  raf = 0;
  if (ax || ay) { send('m ' + r2(ax) + ' ' + r2(ay)); ax = ay = 0; }
  if (sxa || sya) { send('w ' + r2(sxa) + ' ' + r2(sya)); if (sya) railEstimate(sya); sxa = sya = 0; }
}
const sched = () => { if (!raf) raf = requestAnimationFrame(flush); };
function endInertia() { const f = inertiaEnd; inertiaEnd = null; if (f) f(); }
function stopInertia() { if (inertia) { cancelAnimationFrame(inertia); inertia = 0; } endInertia(); }
/** @param {number} v0 px por ms, ya con el signo final @param {() => void} [onEnd] al acabar (o al pararla otro toque);
 *  también si no llega a arrancar */
function startInertia(v0, onEnd) {
  stopInertia();
  inertiaEnd = onEnd || null;
  let v = Math.max(-VMAX, Math.min(VMAX, v0));   // tope: un toque raro no lanza la página
  if (Math.abs(v) < 0.35) { endInertia(); return; }
  let last = performance.now();
  const step = t => {
    const dt = Math.min(40, t - last); last = t;
    sya += v * dt; v *= Math.pow(0.0035, dt / 1000);   // frena en ~0,9 s
    sched();
    // se corta a INERTIA_MIN y no antes: por debajo, los golpes de rueda llegan más espaciados que lo que dura su animación
    inertia = Math.abs(v) > INERTIA_MIN ? requestAnimationFrame(step) : 0;
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
  hintBack(); pad.classList.remove('on'); railRelease();
  if (railDrag) { startInertia(releaseV(e.timeStamp), () => railRest(RAIL_HOLD)); return; }
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
    else if (inTv()) { if (ok && maxN === 1) padGesture(e.clientX - x0, e.clientY - y0, e.clientX, e.clientY); }
    else if (ok && maxN === 1 && !caught && e.timeStamp - downT < 240 && moved < 9) { click(1, p); lastTap = e.timeStamp; }
    maxN = 0;
  } else if (n === 2 && !inTv()) {
    if (ok && !rcDone && e.timeStamp - twoT < 280 && twoMoved < 10) { rcDone = true; click(3, p); }
    else if (twoMoved > 14) startInertia(releaseV(e.timeStamp));
  }
}

/** Pinta el carril con la posición que manda la tele ({pos, size} de 0 a 1, o null: sin scroll y sin carril). Al llegar
 *  a un extremo durante un arrastre del carril (o su inercia), vibra una vez. @param {{pos?: number, size?: number, max?: number} | null} sc */
export function paintRail(sc) {
  if (!rail) { rail = $('#rail'); railT = $('#railT'); }  // puede llegar antes que init()
  const off = rail.classList.contains('off');
  railSc = sc;
  if (!sc) { railPos = -1; railOver = 0; estPos = -1; rail.classList.add('off'); return; }
  const pos = Math.min(1, Math.max(0, +sc.pos || 0)), h = Math.max(0.08, Math.min(1, +sc.size || 0));
  const edge = p => p <= 0.001 || p >= 0.999;
  if (railDrag && !railBuzzed && edge(pos) && railPos >= 0 && !edge(railPos)) { railBuzzed = true; buzz(10); }
  if (!edge(pos) && estPos < 0) railRelease();
  railPos = pos; railH = h; railMax = +sc.max || 0;
  // alto sin transición (solo cambia con la longitud de la página); la posición, con transform sobre el alto del propio
  // pulgar. Mientras se estima, manda lo estimado: el dato de la tele llega con retraso
  railT.style.height = (h * 100).toFixed(2) + '%'; if (estPos < 0) railY = pos * (1 - h) / h * 100; thumb();
  if (off) { void railT.offsetWidth; rail.classList.remove('off'); }   // al aparecer, el pulgar ya está en su sitio: solo funde
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
        railId = e.pointerId; railDrag = false; railBuzzed = false; vs = [];
        downT = e.timeStamp; x0 = e.clientX; y0 = e.clientY; moved = 0;
        hint.classList.add('off');
        rail.classList.add('on'); pad.classList.add('on');
        return;
      }
      P.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (haloId === null) { haloId = e.pointerId; haloAt(e); halo.classList.add('on'); } hint.classList.add('off');
      if (P.size === 1) {
        caught = !!inertia; stopInertia(); downT = e.timeStamp; x0 = e.clientX; y0 = e.clientY; moved = 0; maxN = 1; dragging = false; vs = [];
        tdArm = e.timeStamp - lastTap < 240; pad.classList.add('on');
      } else if (P.size === 2) { maxN = 2; twoT = e.timeStamp; twoMoved = 0; rcDone = false; vs = []; }
    });
    pad.addEventListener('pointermove', e => {
      const p = P.get(e.pointerId); if (!p) return;
      if (e.pointerId === railId) {
        const dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
        moved += Math.abs(e.clientX - p.x) + Math.abs(dy);
        p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
        if (!railDrag) {
          const ddx = e.clientX - x0, ddy = e.clientY - y0;
          if (Math.hypot(ddx, ddy) <= RAIL_ARM) return;
          if (Math.abs(ddx) > 1.5 * Math.abs(ddy)) {      // en horizontal: era el cursor; se lleva lo recorrido hasta aquí
            railId = null; railRest(0); maxN = 1; dragging = false; tdArm = false;
            haloId = e.pointerId; haloAt(e); halo.classList.add('on');
            ax += ddx * cfg.speed; ay += ddy * cfg.speed; sched();
            return;
          }
          railDrag = true; buzz(8);
        }
        const v = dy * cfg.scroll * (1 + Math.min(Math.abs(dy) / dt / 1.1, 2.6));   // la misma aceleración que el cursor
        sya += v; sched(); track(e.timeStamp, v, dt);
        const at = shownPos();
        if (at >= 0 && ((at <= 0.001 && dy < 0) || (at >= 0.999 && dy > 0))) {   // empuja contra el extremo
          if (!railOver) railT.classList.add('rb');
          railOver += Math.abs(dy); thumb();
        } else if (dy) railRelease();
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
        sxa += dx * k; sya += dy * k; sched(); track(e.timeStamp, dy * k, dt);       // los dos dedos suman en la ventana
      }
    });
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('contextmenu', e => e.preventDefault());
  },
};
