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
/** Título y subtítulo de la cabecera (sin b, el subtítulo se queda como está). */
export function setTitle(a, b) { $('#t1').textContent = a; if (b !== undefined) $('#t2').textContent = b; }

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
