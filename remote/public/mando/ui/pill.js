import { $ } from '../core/dom.js';

let pillT;
/** Aviso flotante breve (lo anuncia el lector de pantalla: role=status); dura lo que se tarda en leerlo. */
export function pill(txt) { const p = $('#pill'); p.textContent = txt; p.classList.add('on'); clearTimeout(pillT); pillT = setTimeout(() => p.classList.remove('on'), Math.max(2000, 60 * txt.length)); }
