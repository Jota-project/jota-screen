'use strict';
// @ts-check
// Órdenes de acceso: gestionar dispositivos, roles, emparejamientos y ajustes de invitados (solo admin), y «me».
/**
 * @param {{ acc: any, meOf: (ws: any) => object }} o
 * @returns {import('../transport/commands').Command[]}
 */
module.exports = function createAccessCommands({ acc, meOf }) {
  const devArg = m => String(m.dev || '');
  return [
    { t: 'devices', perm: 'admin', quiet: true, run: () => ({ devices: acc.devices.list(), access: acc.settings() }) },
    { t: 'revoke', perm: 'admin', run: m => acc.devices.revoke(devArg(m)) },
    { t: 'role', perm: 'admin', run: m => acc.devices.setRole(devArg(m), m.role) },
    { t: 'extend', perm: 'admin', run: m => acc.devices.extend(devArg(m), m.hours) },
    { t: 'rename', perm: 'admin', run: m => acc.devices.rename(devArg(m), m.name) },
    { t: 'kickguests', perm: 'admin', run: () => acc.devices.kickGuests() },
    { t: 'pairanswer', perm: 'admin', run: m => acc.pairing.answer(m.pid, !!m.ok, m.role) },
    { t: 'adminlink', perm: 'admin', run: () => acc.admin.link() },
    { t: 'access', perm: 'admin', run: m => ({ access: m.op === 'set' ? acc.setAccess(m.cfg || {}) : acc.settings() }) },
    { t: 'me', run: (m, { ws }) => (ws ? meOf(ws) : { role: 'admin' }) },
  ];
};
