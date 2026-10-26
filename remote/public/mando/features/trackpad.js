// Trackpad: un dedo mueve el cursor (toque: clic; doble toque y arrastre: arrastrar), dos dedos desplazan (con
// inercia; toque con dos: clic derecho). Las rachas se juntan por fotograma. En modo Tele no hay puntero: el gesto
// entero, al soltar, es una flecha u OK de la cruceta (features/tele.js).
import { $ } from '../core/dom.js';
import { cfg, persist } from '../core/store.js';
import { send } from '../core/api.js';
import { buzz } from '../ui/haptics.js';
import { inTv, padGesture } from './tele.js';

const P = new Map();
let ax = 0, ay = 0, sxa = 0, sya = 0, raf = 0;
let downT = 0, moved = 0, maxN = 0, twoT = 0, twoMoved = 0, rcDone = false, dragging = false, tdArm = false, lastTap = 0;
let svy = 0, inertia = 0, x0 = 0, y0 = 0;
const r2 = n => Math.round(n * 100) / 100;
/* un halo malva sigue al dedo mientras toca (en vez de la onda) y la ayuda se esconde solo mientras se toca */
let haloId = null;
let pad, hint, halo;
/* la ayuda se retira para siempre tras HINT_USES gestos: es la pantalla que más se ve y ya se sabe usar */
const HINT_USES = 5;
let uses = 0;
function haloAt(e) { const b = pad.getBoundingClientRect(); halo.style.left = (e.clientX - b.left) + 'px'; halo.style.top = (e.clientY - b.top) + 'px'; }

function flush() {
  raf = 0;
  if (ax || ay) { send('m ' + r2(ax) + ' ' + r2(ay)); ax = ay = 0; }
  if (sxa || sya) { send('w ' + r2(sxa) + ' ' + r2(sya)); sxa = sya = 0; }
}
const sched = () => { if (!raf) raf = requestAnimationFrame(flush); };
function stopInertia() { if (inertia) { cancelAnimationFrame(inertia); inertia = 0; } }
function startInertia() {
  stopInertia();
  let v = svy;                                   // px por ms ya con el signo final
  if (Math.abs(v) < 0.35) return;
  let last = performance.now();
  const step = t => {
    const dt = Math.min(40, t - last); last = t;
    sya += v * dt; v *= Math.pow(0.0035, dt / 1000);   // frena en ~0,9 s
    sched();
    inertia = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
  };
  inertia = requestAnimationFrame(step);
}
function click(btn, p) { send('c ' + btn); buzz(btn === 3 ? 14 : 9); }

function up(e) {
  const p = P.get(e.pointerId); if (!p) return;
  const n = P.size; P.delete(e.pointerId);
  const ok = e.type === 'pointerup';
  if (e.pointerId === haloId) {                   // el halo pasa al dedo que queda o se apaga
    const rest = P.keys().next();
    haloId = rest.done ? null : rest.value;
    if (haloId === null) {
      halo.classList.remove('on'); hint.classList.remove('off');
      if (uses < HINT_USES) { persist.set('padUses', ++uses); hint.hidden = uses >= HINT_USES; }
    }
  }
  if (n === 1) {
    pad.classList.remove('on');
    if (dragging) { send('b 1 0'); dragging = false; }
    else if (inTv()) { if (ok && maxN === 1) padGesture(e.clientX - x0, e.clientY - y0); }
    else if (ok && maxN === 1 && e.timeStamp - downT < 240 && moved < 9) { click(1, p); lastTap = e.timeStamp; }
    maxN = 0;
  } else if (n === 2 && !inTv()) {
    if (ok && !rcDone && e.timeStamp - twoT < 280 && twoMoved < 10) { rcDone = true; click(3, p); }
    else if (twoMoved > 14) startInertia();
  }
}

export const trackpad = {
  name: 'trackpad',
  init() {
    pad = $('#pad'); hint = $('#hint'); halo = $('#halo');
    uses = +persist.get('padUses', 0) || 0; hint.hidden = uses >= HINT_USES;
    pad.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { pad.setPointerCapture(e.pointerId); } catch {}
      P.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (haloId === null) { haloId = e.pointerId; haloAt(e); halo.classList.add('on'); } hint.classList.add('off');
      if (P.size === 1) {
        stopInertia(); downT = e.timeStamp; x0 = e.clientX; y0 = e.clientY; moved = 0; maxN = 1; dragging = false; svy = 0;
        tdArm = e.timeStamp - lastTap < 240; pad.classList.add('on');
      } else if (P.size === 2) { maxN = 2; twoT = e.timeStamp; twoMoved = 0; rcDone = false; svy = 0; }
    });
    pad.addEventListener('pointermove', e => {
      const p = P.get(e.pointerId); if (!p) return;
      if (e.pointerId === haloId) haloAt(e);
      if (inTv() && !dragging) return;                // en la tele solo cuenta el gesto al soltar
      const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
      p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
      if (P.size === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        if (tdArm && !dragging && moved > 6) { dragging = true; send('b 1 1'); }
        const g = cfg.speed * (1 + Math.min(Math.hypot(dx, dy) / dt / 1.1, 2.6));   // aceleración según la velocidad
        ax += dx * g; ay += dy * g; sched();
      } else if (P.size === 2) {
        twoMoved += Math.abs(dx) + Math.abs(dy);
        const k = (cfg.natural ? -1 : 1) * cfg.scroll * 0.5;                          // cada dedo aporta la mitad
        sxa += dx * k; sya += dy * k; sched();
        svy = svy * 0.6 + (dy * k / dt) * 0.4;
      }
    });
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('contextmenu', e => e.preventDefault());
  },
};
