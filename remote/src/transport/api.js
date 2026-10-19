'use strict';
// @ts-check
// API HTTP para agentes y el MCP (/api/*): estado, eventos del escenario y órdenes (las mismas que el mando, con los
// permisos del dispositivo dueño del token; el token maestro es admin).
const { send, json, readBody, reqToken } = require('./http-util');

/**
 * @param {{
 *   limiter: { blocked: (ip: string) => boolean, fail: (ip: string) => void },
 *   auth: { okToken: (t: any) => boolean, tokenDev: (t: any) => any },
 *   run: (m: any, ws: any, ctx: { dev: any }) => Promise<any>,
 *   publicState: () => object,
 *   stage: { stage: { kind: any, data: any }, events: any[], lastEvent: () => number },
 *   agentBusy: () => boolean,
 * }} deps
 */
module.exports = function createApiRoutes({ limiter, auth, run, publicState, stage, agentBusy }) {
  async function api(req, res, { url, ip }) {
    if (limiter.blocked(ip)) return send(res, 429, 'demasiados intentos');
    const tok = reqToken(req, url);
    if (!auth.okToken(tok)) { limiter.fail(ip); return send(res, 401, 'no autorizado'); }
    const apiDev = auth.tokenDev(tok);
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...publicState(), stage: stage.stage.kind, askBusy: agentBusy() });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, 200, { last: stage.lastEvent(), events: stage.events.filter(e => e.n > since), stage: stage.stage.kind, data: stage.stage.data });
    }
    if (req.method === 'POST' && url.pathname === '/api/cmd') {
      const body = await readBody(req, 1_200_000);
      if (body === null) return send(res, 413, 'demasiado grande', { Connection: 'close' }); // el resto del cuerpo no se lee: se cierra la conexión
      let m; try { m = JSON.parse(body); } catch { return json(res, 400, { error: 'JSON no válido' }); }
      const r = await run(m, null, { dev: apiDev });
      return json(res, r.error ? 400 : 200, r);
    }
    send(res, 404, 'no encontrado');
  }
  return [{ prefix: '/api/', anyMethod: true, run: api }];
};
