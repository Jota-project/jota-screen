// Mando principal: accesos (Spotify, Netflix…), botones de orden directa, ±10 s y lo que se ve del estado de la tele
// (cabecera y ambiente, volumen, play/pausa y carril de scroll).
import { $, el, hide } from '../core/dom.js';
import { cfg, state, on, emit } from '../core/store.js';
import { cmd, rpc } from '../core/api.js';
import { paintAmbient } from './ambient.js';
import { inTv, tvRpc } from './tele.js';

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
  paintPlay(s);
  paint2(s);                                            // el volumen se ve en el balancín: sin aviso flotante
  state.lastState = s;
  emit('state', s);                                     // otras hojas (Spotify) reaccionan al estado
}
/* play/pausa y silencio cambian al pulsar (lo previsto, g), sin esperar a la tele; manda el servidor en cuanto lo confirma,
   y si en GUESS_MS no lo confirma, se vuelve a lo que dice (la tele por ADB tarda hasta ~2 s en silenciar) */
const GUESS_MS = 2500;
let ppG = null, muG = null, gT = 0;
/** Lo previsto, mientras el servidor no diga eso mismo y no haya caducado; si no, null. */
const keep = (g, real) => (g && real !== g.v && performance.now() - g.at < GUESS_MS ? g : null);
function paintPlay(s) {
  ppG = keep(ppG, s.media);
  const m = ppG ? ppG.v : s.media, pp = $('#pp');
  pp.dataset.m = m;
  pp.setAttribute('aria-label', m === 1 ? 'Pausar' : m === 0 ? 'Reproducir' : 'Reproducir o pausar');
}
function guessed() {
  const s = state.lastState; if (!s) return;
  paintPlay(s); paint2(s);
  clearTimeout(gT); gT = setTimeout(() => { if (state.lastState) { paintPlay(state.lastState); paint2(state.lastState); } }, GUESS_MS + 50);
}
function guessPlay() {
  const s = state.lastState; if (!s || inTv()) return;            // en modo Tele es una tecla de la tele: no hay estado que prever
  const cur = ppG ? ppG.v : s.media; if (cur !== 0 && cur !== 1) return;
  ppG = { v: 1 - cur, at: performance.now() }; guessed();
}
function guessMute() {
  const s = state.lastState; if (!s) return;
  muG = { v: !(muG ? muG.v : !!s.muted), at: performance.now() }; guessed();
}
/* v2: número de volumen (el % real del servidor), silencio, play/pausa y carril con el scroll de la página de la tele.
   Silenciado se ve el número atenuado (no se pierde el nivel); sin dato, «–» en gris: no es lo mismo */
function paint2(s) {
  muG = keep(muG, !!s.muted);
  const v = $('#vol2'), m = $('#mute2'), muted = muG ? muG.v : !!s.muted, unknown = typeof s.vol !== 'number';
  volDigit(unknown ? '–' : String(s.vol), unknown ? 0 : s.vol);
  v.classList.toggle('muted', muted && !unknown); v.classList.toggle('unknown', unknown);
  v.setAttribute('aria-label', muted ? 'Volumen silenciado' + (unknown ? '' : ', ' + s.vol + ' %') : unknown ? 'Volumen desconocido' : 'Volumen ' + s.vol + ' %');
  m.setAttribute('aria-pressed', String(muted)); m.setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar');
  const sc = s.scroll, rail = $('#rail');
  rail.hidden = !sc;                                    // sin dato (o página sin scroll), sin carril
  if (sc) {
    const h = Math.max(0.08, Math.min(1, +sc.size || 0)), th = $('#railT');
    th.style.top = (Math.min(1, Math.max(0, +sc.pos || 0)) * (1 - h) * 100).toFixed(2) + '%'; th.style.height = (h * 100).toFixed(2) + '%';
  }
}
/* el número del volumen cae (o sube) al cambiar, como los minutos del reposo: el nuevo entra desde arriba si sube */
let volN = null, volT = 0, volAt = 0;
function volDigit(txt, n) {
  const v = $('#vol2'), cur = /** @type {HTMLElement | null} */ (v.querySelector('.vn:not(.vout)'));
  if (cur && cur.textContent === txt) return;
  const up = volN === null || n >= volN; volN = n;
  const now = performance.now(), quick = now - volAt < 450; volAt = now;   // mantenido (se repite cada 85 ms tras 380): sin rueda, que se lea
  v.classList.toggle('w3', txt.length > 2);
  const nx = el('span', 'vn', txt);
  if (!cur || quick || matchMedia('(prefers-reduced-motion: reduce)').matches) { clearTimeout(volT); v.replaceChildren(nx); return; }
  for (const o of v.querySelectorAll('.vout')) o.remove();
  cur.classList.add('vout', up ? 'dn' : 'up');
  nx.classList.add(up ? 'up' : 'dn'); v.append(nx);
  void nx.offsetWidth;                                  // que pinte la posición de salida antes de animar
  nx.classList.remove('up', 'dn');
  clearTimeout(volT); volT = setTimeout(() => { for (const o of v.querySelectorAll('.vout')) o.remove(); }, 350);
}
/* ±10 s (v2): mueve el vídeo de la página; si no hay <video>, la flecha como en el v1 */
function seek10(s) { rpc({ t: 'seek', s }).then(r => { if (r && r.error) cmd({ t: 'key', k: s < 0 ? 'ArrowLeft' : 'ArrowRight' }); }); }
/* en modo Tele, atrás, inicio, play/pausa y ±10 s son teclas de la tele; el volumen, con respuesta (la tele puede no responder) */
const tvOr = (k, f) => () => (inTv() ? tvRpc({ t: 'tvkey', k }) : f());
const vol = d => () => (inTv() ? tvRpc : cmd)({ t: 'vol', d });

export const controls = {
  name: 'controls',
  msgs: { state: onState },
  acts: {
    home: tvOr('home', () => cmd({ t: 'home' })), back: tvOr('back', () => cmd({ t: 'back' })), fwd: () => cmd({ t: 'forward' }), reload: () => cmd({ t: 'reload' }),
    fs: () => cmd({ t: 'fs' }), pp: tvOr('pp', () => { guessPlay(); cmd({ t: 'pp' }); }),
    skb: () => cmd({ t: 'key', k: 'ArrowLeft' }), skf: () => cmd({ t: 'key', k: 'ArrowRight' }),
    vd: vol('down'), vu: vol('up'), vm: () => { guessMute(); vol('mute')(); },
    s10b: tvOr('rew', () => seek10(-10)), s10f: tvOr('ff', () => seek10(10)),
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
