// Foco del inicio (TVC Plan - Reposo contextual A2): a qué widget salta el foco con una flecha. Script clásico para
// idle.html (deja `nextFocus` global) y módulo CommonJS para las pruebas.
/* global module */
(function (g) {
  /**
   * El más cercano en la dirección `k` desde `i`, midiendo entre centros (el eje cruzado pesa el doble); sin ninguno, `i`.
   * @param {{x: number, y: number}[]} pts centros @param {number} i @param {'up'|'down'|'left'|'right'} k
   */
  function nextFocus(pts, i, k) {
    const a = pts[i]; if (!a) return i;
    const h = k === 'left' || k === 'right', s = k === 'right' || k === 'down' ? 1 : -1;
    let best = i, bd = Infinity;
    pts.forEach((b, j) => {
      const along = ((h ? b.x - a.x : b.y - a.y) * s), cross = Math.abs(h ? b.y - a.y : b.x - a.x);
      if (j === i || along <= 0) return;
      const d = along + 2 * cross;
      if (d < bd) { bd = d; best = j; }
    });
    return best;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { nextFocus };
  else g.nextFocus = nextFocus;
})(this);
