'use strict';
// @ts-check
// Servidor HTTP del mando: una tabla de rutas que aportan las capacidades (API, emparejar, Spotify, escenario, reposo)
// y, si ninguna encaja, los estáticos. Las rutas con `anyMethod` (API, emparejar) van primero; el resto solo GET/HEAD.
const { send, clientIp } = require('./http-util');

/**
 * @typedef {{ url: URL, p: string, ip: string, match: RegExpExecArray | null }} RouteCtx
 * @typedef {{
 *   path?: string, prefix?: string, re?: RegExp,     // cómo encaja (ruta exacta, prefijo o expresión)
 *   anyMethod?: boolean,                               // acepta POST y demás (si no, solo GET/HEAD)
 *   run: (req: any, res: any, ctx: RouteCtx) => any,
 * }} Route
 */

/** @param {Route} r @param {string} p */
function matches(r, p) {
  if (r.path !== undefined) return r.path === p ? /** @type {any} */ ([]) : null;
  if (r.prefix !== undefined) return p.startsWith(r.prefix) ? /** @type {any} */ ([]) : null;
  return r.re ? r.re.exec(p) : null;
}

/**
 * @param {{ routes: Route[], fallback: (req: any, res: any, p: string) => any }} o
 */
function createHttp({ routes, fallback }) {
  const open = routes.filter(r => r.anyMethod), getOnly = routes.filter(r => !r.anyMethod);
  function go(r, req, res, ctx) {
    try {
      const out = r.run(req, res, ctx);
      if (out && typeof out.catch === 'function') out.catch(() => { if (!res.headersSent) send(res, 500, 'error'); });
    } catch { if (!res.headersSent) send(res, 500, 'error'); }
  }
  return function handler(req, res) {
    const ip = clientIp(req);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    for (const r of open) { const m = matches(r, p); if (m) return go(r, req, res, { url, p, ip, match: m.length ? m : null }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '');
    for (const r of getOnly) { const m = matches(r, p); if (m) return go(r, req, res, { url, p, ip, match: m.length ? m : null }); }
    fallback(req, res, p);
  };
}

module.exports = { createHttp };
