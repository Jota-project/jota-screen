'use strict';
// @ts-check
// Bloqueo por intentos fallidos: tras `max` fallos desde una IP, se bloquea `ms` milisegundos.

/**
 * @param {{ max?: number, ms?: number, now?: () => number }} [o]
 */
function createRateLimiter({ max = 5, ms = 60_000, now = Date.now } = {}) {
  /** @type {Map<string, { n: number, until: number }>} */
  const fails = new Map();
  return {
    blocked: ip => (fails.get(ip)?.until || 0) > now(),
    fail(ip) {
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (++f.n >= max) { f.n = 0; f.until = now() + ms; }
      fails.set(ip, f);
    },
  };
}

module.exports = { createRateLimiter };
