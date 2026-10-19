'use strict';
// @ts-check
// Las conexiones WebSocket de los mandos vistas como sesiones de dispositivo: quién es cada socket, su ficha «me»,
// cuántos admins hay en línea y cómo avisarles. Es lo que el acceso (src/auth/access.js) necesita del transporte.
const { WebSocket } = require('ws');

/**
 * @param {{ clients: () => Iterable<any>, acc: () => any }} o   acc: el acceso se crea después (se usa al llamar)
 */
function createSessions({ clients, acc }) {
  const all = () => [...clients()];
  const devOf = c => (c && c.devId ? acc().byId(c.devId) : null);
  const adminSockets = () => all().filter(c => c.readyState === WebSocket.OPEN && acc().permsOf(devOf(c)).admin);
  function meOf(ws) {
    const d = devOf(ws), a = acc();
    return { t: 'me', id: d?.id || null, name: d?.name || 'Enlace maestro', role: d ? d.role : 'admin', expires: d?.expires || null, perms: a.permsOf(d), guestHours: a.settings().guestHours };
  }
  function pushMe(devId) { for (const c of all()) if (c.devId === devId && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(meOf(c))); }
  return {
    devOf, meOf, adminSockets,
    // interfaz que espera createAccess({ sessions })
    forAccess: {
      isOnline: id => all().some(c => c.devId === id),
      close: (id, code, reason) => { for (const c of all()) if (c.devId === id) c.close(code, reason); },
      pushMe,
      adminCount: () => adminSockets().length,
      notifyAdmins: msg => { const s = JSON.stringify(msg); for (const c of adminSockets()) c.send(s); },
    },
  };
}

module.exports = { createSessions };
