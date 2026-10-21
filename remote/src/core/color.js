'use strict';
// @ts-check
// Color compartido por el servidor: lo usan los colores de la carátula de «ahora suena» (nowplaying.js) y los que
// el reposo pasa al agente (idle.js). tv-agent.js solo admite hex o rgb() en `colors`, por eso sale en #rrggbb.

/**
 * HSL → #rrggbb (conversión estándar por sectores de 30°, redondeada a 0–255 por canal).
 * @param {number} h tono en grados, ya en [0, 360] (con uno negativo el módulo de k(n) se va de rango: normalízalo antes)
 * @param {number} s saturación de 0 a 1
 * @param {number} l luz de 0 a 1
 * @returns {string}
 */
function hslHex(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
}

module.exports = { hslHex };
