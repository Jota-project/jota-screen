// Hojas (paneles que suben desde abajo): una abierta a la vez, con ganchos al abrir y cerrar por hoja.
import { $ } from '../core/dom.js';

let sheet = null;
const hooks = new Map();

/** Ganchos de una hoja: { open, close, keepEscInside } (keepEscInside: Esc dentro de la hoja no la cierra). */
export function registerSheet(id, h) {
  if (hooks.has(id)) throw new Error(`hoja «${id}» repetida`);
  hooks.set(id, h);
}
export function openSheet(id) {
  closeSheet();
  sheet = $('#' + id); sheet.classList.add('on'); $('#shade').classList.add('on');
  const h = hooks.get(id); if (h && h.open) h.open();
}
export function closeSheet() {
  if (!sheet) return;
  const h = hooks.get(sheet.id); if (h && h.close) h.close();
  sheet.classList.remove('on'); $('#shade').classList.remove('on');
  if (document.activeElement && /** @type {HTMLElement} */ (document.activeElement).blur) /** @type {HTMLElement} */ (document.activeElement).blur();
  sheet = null;
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
      const upd = () => document.documentElement.style.setProperty('--kb', Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px');
      vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd);
    }
  },
};
