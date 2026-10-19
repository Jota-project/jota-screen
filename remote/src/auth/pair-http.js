'use strict';
// @ts-check
// Rutas HTTP de emparejar (/pair/*): pedir y confirmar el código de la tele, pedir permiso a un admin, comprobar el
// dispositivo y canjear un enlace de admin o el token maestro. Todas con freno de intentos y cookie del dispositivo.
const { send, json, readBody, cookieTok, setCookie } = require('../transport/http-util');

/**
 * @param {{
 *   acc: any,                                                   // src/auth/access.js
 *   limiter: { blocked: (ip: string) => boolean, fail: (ip: string) => void },
 *   adminOnline: () => boolean, tvReady: () => boolean,
 * }} deps
 */
module.exports = function createPairRoutes({ acc, limiter, adminOnline, tvReady }) {
  const { blocked, fail } = limiter;
  async function pair(req, res, { p, ip }) {
    if (req.method !== 'POST') return send(res, 405, '');
    if (blocked(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera un minuto.' });
    const body = await readBody(req, 2048);
    if (body === null) return send(res, 413, '', { Connection: 'close' });
    let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
    if (p === '/pair/info') return json(res, 200, { adminOnline: adminOnline(), tv: tvReady() });
    if (p === '/pair/start') { const r = await acc.pairing.start(ip, b.name, b.mode); return json(res, r.error && !r.noAdmin ? 429 : 200, r); }
    if (p === '/pair/confirm') {
      const r = acc.pairing.confirm(b.pid, b.code);
      if (r.error) fail(ip);
      return json(res, r.error ? 403 : 200, r, r.token ? setCookie(r.token, r.expires) : {});
    }
    if (p === '/pair/poll') { const r = acc.pairing.poll(b.pid); return json(res, 200, r, r.token ? setCookie(r.token, r.expires) : {}); }
    if (p === '/pair/me') { // ¿sigue valiendo este dispositivo? (token del navegador o cookie); renueva la cookie
      const t = (typeof b.t === 'string' && b.t) || cookieTok(req);
      if (!acc.okToken(t)) return json(res, 200, { ok: false });
      if (acc.isMaster(t)) return json(res, 200, { ok: true, master: true }); // el maestro no se guarda nunca en el navegador
      const d = acc.tokenDev(t);
      return json(res, 200, { ok: true, role: d.role, name: d.name, expires: d.expires || null }, setCookie(t, d.expires));
    }
    if (p === '/pair/admin') { // canjear un código de admin, o el token maestro, por un dispositivo admin propio
      const cur = (typeof b.cur === 'string' && b.cur) || cookieTok(req);
      let r;
      if (acc.isMaster(b.t) || (!b.code && acc.isMaster(cur))) r = acc.admin.device(b.name, cur); // también el maestro que una versión anterior dejó en la cookie
      else if (b.code) r = acc.admin.claim(b.code, b.name, cur);
      else r = { error: 'Falta el código' };
      if (r.error) fail(ip);
      return json(res, r.error ? 403 : 200, r, r.token ? setCookie(r.token, r.expires) : {});
    }
    send(res, 404, '');
  }
  return [{ prefix: '/pair/', anyMethod: true, run: pair }];
};
