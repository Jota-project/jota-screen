// Hojas (paneles que suben desde abajo): una abierta a la vez, con ganchos al abrir y cerrar por hoja.
// Son diálogos modales de verdad: al abrir, lo de detrás queda `inert` (ni el foco ni el lector de pantalla llegan) y el
// foco entra en la hoja; al cerrar, vuelve al botón que la abrió.
import { $ } from '../core/dom.js';

let sheet = null;
/** @type {HTMLElement | null} */ let opener = null;
const hooks = new Map();
// lo que queda detrás de una hoja abierta (el aviso de petición de acceso, .req, sigue a mano: va por encima)
const BEHIND = ['main.app2', '#offV', '#amb'];
function behind(on) {
  for (const s of BEHIND) { const e = document.querySelector(s); if (e) e.toggleAttribute('inert', on); }
}

/** Ganchos de una hoja: { open, close, keepEscInside } (keepEscInside: Esc dentro de la hoja no la cierra). */
export function registerSheet(id, h) {
  if (hooks.has(id)) throw new Error(`hoja «${id}» repetida`);
  hooks.set(id, h);
}
export function openSheet(id) {
  const from = /** @type {HTMLElement | null} */ (document.activeElement);
  closeSheet(false);
  opener = from && from !== document.body ? from : null;
  sheet = $('#' + id); sheet.classList.add('on'); $('#shade').classList.add('on');
  sheet.setAttribute('aria-modal', 'true');
  if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
  behind(true);
  const h = hooks.get(id); if (h && h.open) h.open();
  // si el gancho no ha puesto el foco en un campo, va a la hoja (sin abrir el teclado del móvil)
  if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true });
}
/** @param {boolean} [restore] devolver el foco al botón que abrió la hoja (no al pasar de una hoja a otra) */
export function closeSheet(restore = true) {
  if (!sheet) return;
  const h = hooks.get(sheet.id); if (h && h.close) h.close();
  sheet.classList.remove('on'); $('#shade').classList.remove('on');
  sheet.removeAttribute('aria-modal');
  behind(false);
  if (document.activeElement && /** @type {HTMLElement} */ (document.activeElement).blur) /** @type {HTMLElement} */ (document.activeElement).blur();
  sheet = null;
  const o = opener; opener = null;
  if (restore && o && o.isConnected && !o.closest('[inert],[hidden]')) o.focus({ preventScroll: true });
}
export function closeSheetSafe() { try { if (sheet) closeSheet(); } catch {} }
export const isOpen = id => document.getElementById(id).classList.contains('on');

export const sheets = {
  name: 'sheets',
  init() {
    $('#shade').addEventListener('pointerdown', e => { e.preventDefault(); closeSheet(); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !sheet) return;
      const h = hooks.get(sheet.id);
      if (!(h && h.keepEscInside && sheet.contains(document.activeElement))) closeSheet();
    });
    const vv = window.visualViewport;
    if (vv) {                                              // subir la hoja por encima del teclado del móvil
      // con zoom (pellizcar ya se puede) la ventana visual encoge sin teclado: entonces no se toca --kb
      const upd = () => { if (vv.scale > 1.01) return; document.documentElement.style.setProperty('--kb', Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px'); };
      vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd);
    }
  },
};
