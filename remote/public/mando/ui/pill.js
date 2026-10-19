import { $ } from '../core/dom.js';

let pillT;
/** Aviso flotante breve. */
export function pill(txt) { const p = $('#pill'); p.textContent = txt; p.classList.add('on'); clearTimeout(pillT); pillT = setTimeout(() => p.classList.remove('on'), 1100); }
