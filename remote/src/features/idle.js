'use strict';
// Capacidad «reposo»: la pantalla en reposo y las Live Activities. La lógica vive en remote/idle.js (reposo v2);
// aquí se le ponen sus órdenes, su ruta HTTP (carátulas) y su canal WebSocket, como al resto de capacidades.
const createIdleCore = require('../../idle');
const { send, isLocalTV } = require('../transport/http-util');

/** @param {Parameters<typeof createIdleCore>[0]} deps */
module.exports = function createIdle(deps) {
  const idle = createIdleCore(deps);
  return Object.assign(idle, {
    commands: [
      // Live Activities (el resto del escenario se registra desde src/features/stage.js)
      { t: 'activity', perm: 'stage', quiet: true, run: m => idle.activity(m) },
      // pantalla en reposo: verla y cambiarla (cambiarla, solo el administrador)
      { t: 'idle', perm: (m, P) => (m.op === 'set' && !P.admin ? 'Solo el administrador' : null), quiet: true, run: m => idle.run(m) },
    ],
    routes: [{ path: '/idle/art', run(req, res, { url }) { // carátulas de Spotify servidas desde aquí, para poder sacar sus colores
      if (!isLocalTV(req)) return send(res, 403, 'solo desde la tele');
      return idle.art(req, res, url, send);
    } }],
  });
};
