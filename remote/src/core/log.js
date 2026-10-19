'use strict';
// @ts-check
// Registro del servidor con redacción de secretos: nada de lo que pase por aquí puede llevar un token
// al journal. Oculta los secretos conocidos (el token maestro), los ?t=… de las URLs y las cabeceras Bearer.
const MASK = '«oculto»';

/**
 * @param {{ secrets?: () => string[], debug?: boolean, out?: Pick<Console, 'log' | 'error' | 'warn'> }} [o]
 */
function createLog({ secrets = () => [], debug = false, out = console } = {}) {
  /** @param {unknown} v */
  function redact(v) {
    if (typeof v !== 'string') {
      if (v instanceof Error) return redact(v.message);
      if (v && typeof v === 'object') { try { return redact(JSON.stringify(v)); } catch { return '[objeto]'; } }
      return v;
    }
    let s = v;
    for (const x of secrets()) if (x && x.length >= 8) s = s.split(x).join(MASK);
    return s
      .replace(/([?&](?:t|token)=)[^&\s"']{8,}/gi, '$1' + MASK)
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1' + MASK);
  }
  const clean = a => a.map(redact);
  return {
    redact,
    info: (...a) => out.log(...clean(a)),
    warn: (...a) => out.warn(...clean(a)),
    error: (...a) => out.error(...clean(a)),
    debug: (...a) => { if (debug) out.log(...clean(a)); },
    debugOn: debug,
  };
}

module.exports = { createLog, MASK };
