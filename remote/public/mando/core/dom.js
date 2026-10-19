// Ayudas del DOM del mando. Sin efectos al cargarse (como todos los módulos salvo app.js).
export const $ = s => document.querySelector(s);
export const $$ = s => document.querySelectorAll(s);
/** Crea un elemento con clase y texto opcionales. */
export const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
/** Esconde (data-hide) o muestra lo que casa con el selector. */
export const hide = (sel, h) => $$(sel).forEach(e => { if (h) e.setAttribute('data-hide', ''); else e.removeAttribute('data-hide'); });
