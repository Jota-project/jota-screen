'use strict';
// @ts-check
// Registro de órdenes (patrón Command): cada orden se declara una sola vez, con su permiso al lado.
//   { t: 'nav', perm: 'web', run: (m, ctx) => … }
//   perm   nombre de una política de src/auth/permissions.js o función (m, P, ctx) => error | null
//   clamp  (m, P, ctx) => m   ajusta la orden a lo permitido (volumen máximo, cola en vez de reproducir…)
//   quiet  true si la orden no cuenta como «uso» de la tele (consultas del mando: estado, dispositivos…)
// El mando (WebSocket), la API (/api/cmd), el MCP y el agente pasan todos por dispatch().
const { check } = require('../auth/permissions');

/**
 * @typedef {{ dev: any, ws?: any, P: import('../auth/permissions').Perms }} Ctx
 * @typedef {{ t: string, perm?: string | ((m: any, P: any, ctx: Ctx) => string | null | undefined),
 *             clamp?: (m: any, P: any, ctx: Ctx) => any, quiet?: boolean, run: (m: any, ctx: Ctx) => any }} Command
 */

/**
 * @param {{ permsOf: (dev: any) => any, onUse?: () => void, log?: { debug: Function } }} o
 */
function createCommands({ permsOf, onUse = () => {}, log = { debug() {} } }) {
  /** @type {Map<string, Command>} */
  const reg = new Map();

  /** @param {Command[]} list */
  function register(list) {
    for (const c of list) {
      if (!c || typeof c.t !== 'string' || typeof c.run !== 'function') throw new Error('orden mal declarada: ' + JSON.stringify(c && c.t));
      if (reg.has(c.t)) throw new Error('orden repetida: ' + c.t);
      reg.set(c.t, { perm: 'any', ...c });
    }
  }

  /**
   * @param {any} m
   * @param {{ dev?: any, ws?: any }} [where]
   */
  async function dispatch(m, { dev = null, ws } = {}) {
    if (!m || typeof m !== 'object') return { error: 'mensaje no válido' };
    const c = reg.get(m.t);
    const P = permsOf(dev);
    /** @type {Ctx} */
    const ctx = { dev, ws, P };
    if (c) {
      const no = check(c.perm || 'any', m, P, ctx);
      if (no) return no;
      if (c.clamp) m = c.clamp(m, P, ctx);
      if (m && m.error) return m;
    }
    // lo escrito en un campo (puede ser una contraseña) y lo preguntado al agente no va nunca al registro
    log.debug('cmd', JSON.stringify(m.t === 'field' ? { ...m, value: `(${String(m.value ?? '').length} caracteres)` } : m.t === 'ask' ? { ...m, text: `(${String(m.text ?? '').length} caracteres)` } : m));
    if (!c || !c.quiet) onUse();
    if (!c) return { error: 'orden desconocida' };
    try { return await c.run(m, ctx); } catch (e) { return { error: e.message }; }
  }

  return { register, dispatch, has: t => reg.has(t), list: () => [...reg.values()] };
}

module.exports = { createCommands };
