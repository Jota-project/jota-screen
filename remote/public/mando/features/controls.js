// Mando principal: accesos (Spotify, Netflix…), botones de orden directa, ±10 s y lo que se ve del estado de la tele
// (cabecera y ambiente, volumen, play/pausa y carril de scroll).
import { $, el, hide } from '../core/dom.js';
import { cfg, state, on } from '../core/store.js';
import { cmd, rpc } from '../core/api.js';
import { paintAmbient } from './ambient.js';

/* accesos del mando: salen de cfg.apps (M5 los hará configurables), con el logo de cada servicio (símbolos l-* de index.html) */
const APPS = {
  spotify: { n: 'Spotify', at: { 'data-a': 'sp', 'data-click': '' } },
  netflix: { n: 'Netflix', at: { 'data-url': 'https://www.netflix.com' } },
  youtube: { n: 'YouTube', at: { 'data-url': 'https://www.youtube.com' } },
};
const SVG = 'http://www.w3.org/2000/svg';
/** El logo de un acceso, como <svg><use href="#l-…"></svg>. @param {string} k */
function logo(k) {
  const s = document.createElementNS(SVG, 'svg'), u = document.createElementNS(SVG, 'use');
  s.setAttribute('class', 'logo'); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', '#l-' + k);
  s.append(u); return s;
}

function onState(s) {
  if (s.t !== 'state') return;
  paintAmbient(s);                                      // cabecera (qué hay en la tele) y color de las luces
  $('#pp').dataset.m = s.media;
  paint2(s);                                            // el volumen se ve en el balancín: sin aviso flotante
  state.lastState = s;
}
/* v2: número de volumen (el % real del servidor), silencio, play/pausa y carril con el scroll de la página de la tele */
function paint2(s) {
  const v = $('#vol2'), m = $('#mute2'), off = !!s.muted || typeof s.vol !== 'number';
  volDigit(off ? '–' : String(s.vol), off ? 0 : s.vol); v.classList.toggle('off', off);
  v.setAttribute('aria-label', s.muted ? 'Volumen silenciado' : off ? 'Volumen desconocido' : 'Volumen ' + s.vol + ' %');
  m.setAttribute('aria-pressed', !!s.muted); m.setAttribute('aria-label', s.muted ? 'Activar sonido' : 'Silenciar');
  $('#pp').setAttribute('aria-label', s.media === 1 ? 'Pausar' : s.media === 0 ? 'Reproducir' : 'Reproducir o pausar');
  const sc = s.scroll, rail = $('#rail');
  rail.hidden = !sc;                                    // sin dato (o página sin scroll), sin carril
  if (sc) {
    const h = Math.max(0.08, Math.min(1, +sc.size || 0)), th = $('#railT');
    th.style.top = (Math.min(1, Math.max(0, +sc.pos || 0)) * (1 - h) * 100).toFixed(2) + '%'; th.style.height = (h * 100).toFixed(2) + '%';
  }
}
/* el número del volumen cae (o sube) al cambiar, como los minutos del reposo: el nuevo entra desde arriba si sube */
let volN = null, volT = 0;
function volDigit(txt, n) {
  const v = $('#vol2'), cur = /** @type {HTMLElement | null} */ (v.querySelector('.vn:not(.vout)'));
  if (cur && cur.textContent === txt) return;
  const up = volN === null || n >= volN; volN = n;
  v.classList.toggle('w3', txt.length > 2);
  const nx = el('span', 'vn', txt);
  if (!cur || matchMedia('(prefers-reduced-motion: reduce)').matches) { v.replaceChildren(nx); return; }
  for (const o of v.querySelectorAll('.vout')) o.remove();
  cur.classList.add('vout', up ? 'dn' : 'up');
  nx.classList.add(up ? 'up' : 'dn'); v.append(nx);
  void nx.offsetWidth;                                  // que pinte la posición de salida antes de animar
  nx.classList.remove('up', 'dn');
  clearTimeout(volT); volT = setTimeout(() => { for (const o of v.querySelectorAll('.vout')) o.remove(); }, 650);
}
/* ±10 s (v2): mueve el vídeo de la página; si no hay <video>, la flecha como en el v1 */
function seek10(s) { rpc({ t: 'seek', s }).then(r => { if (r && r.error) cmd({ t: 'key', k: s < 0 ? 'ArrowLeft' : 'ArrowRight' }); }); }

export const controls = {
  name: 'controls',
  msgs: { state: onState },
  acts: {
    home: () => cmd({ t: 'home' }), back: () => cmd({ t: 'back' }), fwd: () => cmd({ t: 'forward' }), reload: () => cmd({ t: 'reload' }),
    fs: () => cmd({ t: 'fs' }), pp: () => cmd({ t: 'pp' }),
    skb: () => cmd({ t: 'key', k: 'ArrowLeft' }), skf: () => cmd({ t: 'key', k: 'ArrowRight' }),
    vd: () => cmd({ t: 'vol', d: 'down' }), vu: () => cmd({ t: 'vol', d: 'up' }), vm: () => cmd({ t: 'vol', d: 'mute' }),
    s10b: () => seek10(-10), s10f: () => seek10(10),
  },
  init() {
    for (const k of Array.isArray(cfg.apps) ? cfg.apps : []) {
      const a = APPS[k]; if (!a) continue;
      const b = el('button', 'b2 acc2'); b.setAttribute('aria-label', 'Abrir ' + a.n);
      for (const [n, v] of Object.entries(a.at)) b.setAttribute(n, v);
      b.append(logo(k), el('span', '', a.n)); $('#apps2').appendChild(b);
    }
    on('me', j => {                                     // el mando se adapta a lo que puede hacer cada uno
      const P = j.perms || {};
      hide('[data-a=go],[data-url]', !P.web);
      hide('[data-a=ag]', P.agent === 'off');
    });
  },
};
