// Botones del mando: los de [data-click] (abren algo; un dueño por acción) y los de orden directa (data-a, data-url),
// que se mandan al pulsar (sin esperar al clic) y se repiten mientras se mantienen si llevan data-rep.
import { cmd } from '../core/api.js';
import { buzz } from './haptics.js';

const clicks = new Map(), acts = new Map();
export function registerClick(name, fn) {
  if (clicks.has(name)) throw new Error(`acción «${name}» repetida`);
  clicks.set(name, fn);
}
export function registerAct(name, fn) {
  if (acts.has(name)) throw new Error(`orden «${name}» repetida`);
  acts.set(name, fn);
}
export function fire(b) {
  const a = b.dataset.a;
  if (b.dataset.url) return cmd({ t: 'nav', url: b.dataset.url });
  if (a && a.startsWith('k:')) return cmd({ t: 'key', k: a.slice(2) });
  const f = acts.get(a); if (f) f();
}
let repT = 0, repI = 0, cur = null;
function stopRep() { clearTimeout(repT); clearInterval(repI); if (cur) { cur.classList.remove('dn'); cur = null; } }

export const actions = {
  name: 'actions',
  init() {
    document.addEventListener('pointerdown', e => {
      const b = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest('.bt,.b2')); if (!b || b.hasAttribute('data-click') || !(b.dataset.a || b.dataset.url)) return;
      e.preventDefault();                                   // no robar el foco al campo de texto
      stopRep(); cur = b; b.classList.add('dn'); buzz(7); fire(b);
      if (b.hasAttribute('data-rep')) repT = setTimeout(() => { repI = setInterval(() => fire(b), 85); }, 380);
    });
    ['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, stopRep));
    document.addEventListener('click', e => {
      const b = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest('[data-click]')); if (!b) return;
      buzz(7);
      clicks.get(b.dataset.a)();
    });
  },
};
