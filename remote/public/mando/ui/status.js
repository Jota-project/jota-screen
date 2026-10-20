// Cabecera: punto de conexión, título (página de la tele) y «Sin conexión · Reintentar».
import { $ } from '../core/dom.js';
import { connect, getRtt, getTries, isLive, isUp, onWs, resetTries } from '../core/api.js';
import { buzz } from './haptics.js';

export function paintDot() {
  const up = isUp(), rtt = getRtt(), dot = $('#dot');
  dot.className = 'dot' + (up ? (rtt && rtt > 150 ? ' bad' : ' ok') : '');
  dot.setAttribute('aria-label', up ? 'Conectada' : 'Sin conexión');
}
/** Tras varios intentos (o sin red) se dice «Sin conexión» y se puede reintentar a mano. */
export function offline2(on) { $('#sub2').hidden = on; $('#re2').hidden = !on; }
let fadeT = 0, pend = /** @type {string[] | null} */ (null);
/**
 * Título y subtítulo de la cabecera (sin b, el subtítulo se queda como está). Al cambiar, lo viejo sale con un fundido
 * y entra lo nuevo (sin fundido con movimiento reducido, o si aún no había nada).
 */
export function setTitle(a, b) {
  const t1 = $('#t1'), t2 = $('#t2'), sub = $('#sub2');
  const nb = b !== undefined ? b : pend ? pend[1] : t2.textContent;
  const now = pend || [t1.textContent, t2.textContent];
  if (now[0] === a && now[1] === nb) return;
  const apply = () => { pend = null; t1.textContent = a; t2.textContent = nb; sub.classList.remove('out'); };
  clearTimeout(fadeT);
  if (sub.hidden || /…$/.test(t1.textContent) || matchMedia('(prefers-reduced-motion: reduce)').matches) return apply();
  pend = [a, nb]; sub.classList.add('out'); fadeT = setTimeout(apply, 320);
}

export const status = {
  name: 'status',
  init() {
    onWs('open', () => { paintDot(); offline2(false); });
    onWs('rtt', paintDot);
    onWs('close', (ev, lost) => {
      paintDot();
      if (lost) return;                                   // la pantalla de emparejar ya lo dice
      setTitle('Reconectando…', '');
      offline2(getTries() >= 4 || navigator.onLine === false);
    });
    $('#re2').addEventListener('click', () => { buzz(8); if (isLive()) return; resetTries(); setTitle('Reconectando…'); offline2(false); connect(); });
  },
};
