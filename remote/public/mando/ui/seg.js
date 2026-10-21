// Segmentos de las hojas (role=radiogroup): el elegido lleva aria-checked, solo él entra con Tab (foco itinerante) y las
// flechas, Inicio y Fin mueven el foco y eligen a la vez (patrón ARIA de radiogroup). key es el data-<key> de cada botón.
const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
const btns = el => [...el.querySelectorAll('button')];

/** Marca el botón cuyo data-<key> vale val (si ninguno, el primero queda enfocable). */
export function segPaint(el, key, val) {
  const bs = btns(el); let any = false;
  for (const b of bs) { const on = b.dataset[key] === String(val); any ||= on; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
  if (!any && bs[0]) bs[0].tabIndex = 0;
}

/** Llama a pick(valor) al tocar un botón o al moverse con el teclado dentro del grupo. */
export function segOn(el, key, pick) {
  el.addEventListener('click', e => { const b = /** @type {HTMLElement} */ (e.target).closest('button'); if (b && el.contains(b)) pick(b.dataset[key]); });
  el.addEventListener('keydown', e => {
    const bs = btns(el), i = bs.indexOf(/** @type {HTMLButtonElement} */ (e.target));
    if (i < 0) return;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : e.key in STEP ? (i + STEP[e.key] + bs.length) % bs.length : -1;
    if (j < 0) return;
    e.preventDefault(); bs[j].focus(); pick(bs[j].dataset[key]);
  });
}
