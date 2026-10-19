'use strict';
// @ts-check
// Roles y permisos. Los admin pueden todo; invitados y miembros, lo que el admin configure en el mando.
// Las órdenes declaran qué permiso necesitan (`perm`) y este módulo decide; ver src/transport/commands.js.

/** @typedef {'admin' | 'member' | 'guest'} Role */
/** @typedef {{ web: boolean, agent: 'off' | 'guest' | 'full', music: 'play' | 'queue' | 'off', library: boolean, volMax: number, stage: boolean, admin?: boolean }} Perms */

const ROLES = /** @type {const} */ (['admin', 'member', 'guest']);
/** @type {Perms} */
const PERM_DEFAULT = Object.freeze({ web: true, agent: 'guest', music: 'play', library: false, volMax: 100, stage: false });
/** @type {Perms} */
const ADMIN_PERMS = Object.freeze({ web: true, agent: 'full', music: 'play', library: true, volMax: 100, stage: true, admin: true });

/**
 * Sanea unos permisos que llegan de fuera (fichero o mando) sobre una base.
 * @param {any} [p]
 * @param {Perms} [base]
 * @returns {Perms}
 */
function permSan(p = {}, base = PERM_DEFAULT) {
  const o = { ...base };
  if (p.web !== undefined) o.web = !!p.web;
  if (['off', 'guest', 'full'].includes(p.agent)) o.agent = p.agent;
  if (['play', 'queue', 'off'].includes(p.music)) o.music = p.music;
  if (p.library !== undefined) o.library = !!p.library;
  if (Number.isFinite(+p.volMax)) o.volMax = Math.min(100, Math.max(10, Math.round(+p.volMax)));
  if (p.stage !== undefined) o.stage = !!p.stage;
  return o;
}

const NOPE = (/** @type {string} */ t) => ({ error: t || 'No tienes permiso para esto' });

/**
 * Políticas con nombre que pueden usar las órdenes en `perm`. Devuelven el texto del error o null si se permite.
 * @type {Record<string, (P: Perms) => string | null>}
 */
const POLICIES = {
  any: () => null,
  admin: P => (P.admin ? null : 'Solo el administrador'),
  adminQuiet: P => (P.admin ? null : ''),                      // sin explicación (p. ej. capturas de pantalla)
  stage: P => (P.stage ? null : 'Las presentaciones no están permitidas'),
  web: P => (P.web ? null : 'Abrir webs no está permitido'),
  agent: P => (P.agent === 'off' ? 'El agente no está disponible para ti' : null),
};

/**
 * Comprueba el permiso de una orden: `perm` es el nombre de una política o una función (m, P, ctx) => error | null.
 * @param {string | ((m: any, P: Perms, ctx: any) => string | null | undefined)} perm
 * @returns {{ error: string } | null}
 */
function check(perm, m, P, ctx) {
  let err;
  if (typeof perm === 'function') err = perm(m, P, ctx);
  else {
    const f = POLICIES[perm];
    if (!f) throw new Error('política desconocida: ' + perm);
    err = f(P);
  }
  return err === null || err === undefined ? null : NOPE(err);
}

module.exports = { ROLES, PERM_DEFAULT, ADMIN_PERMS, POLICIES, permSan, check, NOPE };
