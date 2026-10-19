// Mando principal: accesos (Spotify, Netflix…), botones de orden directa, ±10 s y lo que se ve del estado de la tele
// (título, volumen, play/pausa y carril de scroll).
import { $, hide } from '../core/dom.js';
import { cfg, state, on } from '../core/store.js';
import { cmd, rpc } from '../core/api.js';
import { setTitle } from '../ui/status.js';

/* accesos del mando: salen de cfg.apps (M5 los hará configurables) */
const APPS = {
  spotify: { n: 'Spotify', at: { 'data-a': 'sp', 'data-click': '' }, svg: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>' },
  netflix: { n: 'Netflix', at: { 'data-url': 'https://www.netflix.com' }, svg: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7.5 4l3 5M13.5 4l3 5"/>' },
};

function onState(s) {
  if (s.t !== 'state') return;
  if (!s.cdp) setTitle('Navegador no disponible', '');
  else if (!s.host) setTitle('Inicio', '');
  else setTitle(s.title || s.host, s.host);
  $('#pp').dataset.m = s.media;
  paint2(s);                                            // el volumen se ve en el balancín: sin aviso flotante
  state.lastState = s;
}
/* v2: número de volumen (el % real del servidor), silencio, play/pausa y carril con el scroll de la página de la tele */
function paint2(s) {
  const v = $('#vol2'), m = $('#mute2'), off = !!s.muted || typeof s.vol !== 'number';
  v.textContent = off ? '–' : String(s.vol); v.classList.toggle('off', off);
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
      const b = document.createElement('button'); b.className = 'b2'; b.setAttribute('aria-label', 'Abrir ' + a.n);
      for (const [n, v] of Object.entries(a.at)) b.setAttribute(n, v);
      b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a.svg}</svg>`;
      b.append(a.n); $('#apps2').appendChild(b);
    }
    on('me', j => {                                     // el mando se adapta a lo que puede hacer cada uno
      const P = j.perms || {};
      hide('[data-a=go],[data-url]', !P.web);
      hide('[data-a=ag]', P.agent === 'off');
    });
  },
};
