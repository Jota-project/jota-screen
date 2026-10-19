'use strict';
// @ts-check
// Acceso al mando: token maestro, dispositivos emparejados (cada uno con su token; aquí solo su hash),
// roles, ajustes de acceso, emparejamiento (código en la tele o pedir permiso a un admin) y enlaces de admin
// de un solo uso. No sabe nada de WebSocket ni de Chrome: lo recibe por `sessions` y `tv`.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('../core/json-store');
const { ROLES, PERM_DEFAULT, ADMIN_PERMS, permSan } = require('./permissions');

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 24);
const PAIR_TTL = 120_000;
const ADMIN_TTL = 10 * 60_000;
const CODE_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin 0/O ni 1/I para poder teclearlo
const codeNorm = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/**
 * @typedef {{ id: string, name: string, role: import('./permissions').Role, h: string, created: number, seen: number, expires: number | null }} Device
 * @typedef {{ isOnline(id: string): boolean, close(id: string, code: number, reason: string): void, pushMe(id: string): void,
 *             adminCount(): number, notifyAdmins(msg: object): void }} Sessions
 * @typedef {{ ready(): boolean, showCode(code: string, name: string): Promise<void> | void, hideCode(): void }} TvScreen
 */

/**
 * @param {{ files: { token: string, devices: string, access: string }, adminUrl: string, log: { info: Function },
 *           sessions: Sessions, tv: TvScreen, now?: () => number }} o
 */
function createAccess({ files, adminUrl, log, sessions, tv, now = Date.now }) {
  // ── token maestro (para el agente y el MCP)
  let TOKEN = '';
  try { TOKEN = fs.readFileSync(files.token, 'utf8').trim(); } catch {}
  if (TOKEN.length < 16) {
    TOKEN = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(files.token, TOKEN + '\n', { mode: 0o600 });
  }
  const TOKEN_BUF = Buffer.from(TOKEN);
  const isMaster = t => { const b = Buffer.from(typeof t === 'string' ? t : ''); return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF); };

  // ── dispositivos
  /** @type {Device[]} */
  let devices = readJson(files.devices, []); if (!Array.isArray(devices)) devices = [];
  const devSave = () => writeJson(files.devices, devices);
  let migrated = false;
  for (const d of devices) if (!ROLES.includes(d.role)) { d.role = 'admin'; migrated = true; } // los emparejados antes de los roles eran de Sito
  if (migrated) devSave();
  const byId = id => devices.find(x => x.id === id) || null;

  // ── ajustes de acceso de invitados y miembros
  let access = { guestHours: 24, guest: { ...PERM_DEFAULT }, member: { ...PERM_DEFAULT } };
  {
    const a = readJson(files.access, null);
    if (a) access = { guestHours: Number.isFinite(+a.guestHours) ? +a.guestHours : 24, guest: permSan(a.guest), member: permSan(a.member) };
  }
  const accessSave = () => writeJson(files.access, access, { pretty: true });
  /** @param {Device | null} dev */
  const permsOf = dev => !dev || dev.role === 'admin' ? ADMIN_PERMS : { ...(access[dev.role] || access.guest), admin: false };
  const guestExpiry = () => access.guestHours > 0 ? now() + access.guestHours * 3600e3 : null;

  function expire(d) {
    const i = devices.indexOf(d); if (i >= 0) { devices.splice(i, 1); devSave(); }
    sessions.close(d.id, 4002, 'caducado');
    log.info('acceso caducado:', d.name);
  }
  function tokenDev(t) { // -> dispositivo dueño de este token, o null (los caducados se borran)
    if (typeof t !== 'string' || t.length < 16 || t.length > 128) return null;
    const h = sha(t);
    const d = devices.find(x => x.h === h) || null;
    if (d && d.expires && now() > d.expires) { expire(d); return null; }
    return d;
  }
  function okToken(t) {
    if (typeof t !== 'string' || t.length > 128) return false;
    if (isMaster(t)) return true;
    const d = tokenDev(t);
    if (!d) return false;
    if (now() - d.seen > 3_600_000) { d.seen = now(); devSave(); }
    return true;
  }
  function newDevice(name, role) {
    const token = crypto.randomBytes(16).toString('hex');
    /** @type {Device} */
    const dev = { id: crypto.randomBytes(4).toString('hex'), name, role, h: sha(token), created: now(), seen: now(),
      expires: role === 'guest' ? guestExpiry() : null };
    devices.push(dev); devSave();
    log.info('dispositivo emparejado:', dev.name, dev.role);
    return { token, id: dev.id, role: dev.role, expires: dev.expires };
  }
  const list = () => devices.map(d => ({ id: d.id, name: d.name, role: d.role, created: d.created, seen: d.seen, expires: d.expires || null,
    online: sessions.isOnline(d.id) }));
  function setRole(id, role) {
    const d = byId(id);
    if (!d) return { error: 'no existe' };
    if (!ROLES.includes(role)) return { error: 'rol no válido' };
    if (d.role === 'admin' && role !== 'admin' && devices.filter(x => x.role === 'admin').length === 1) return { error: 'Tiene que quedar al menos un administrador' };
    d.role = role; d.expires = role === 'guest' ? guestExpiry() : null; devSave(); sessions.pushMe(id);
    return { ok: 1, devices: list() };
  }
  function extend(id, hours) {
    const d = byId(id);
    if (!d || d.role !== 'guest') return { error: 'solo se amplía a invitados' };
    const h = Number(hours) > 0 ? Number(hours) : access.guestHours || 24;
    d.expires = Math.max(now(), d.expires || 0) + h * 3600e3; devSave(); sessions.pushMe(id);
    return { ok: 1, devices: list() };
  }
  function rename(id, name) {
    const d = byId(id); if (!d) return { error: 'no existe' };
    d.name = cleanName(name) || d.name; devSave(); sessions.pushMe(id);
    return { ok: 1, devices: list() };
  }
  function revoke(id) {
    const i = devices.findIndex(d => d.id === id);
    if (i < 0) return { error: 'no existe' };
    devices.splice(i, 1); devSave();
    sessions.close(id, 4001, 'token');
    return { ok: 1, devices: list() };
  }
  function kickGuests() {
    for (const d of devices.filter(x => x.role === 'guest')) revoke(d.id);
    return { ok: 1, devices: list() };
  }
  /** Cambia los ajustes de acceso (desde el mando de un admin) y avisa a todos los conectados. */
  function setAccess(c = {}) {
    if (Number.isFinite(+c.guestHours)) access.guestHours = Math.min(24 * 30, Math.max(0, +c.guestHours));
    if (c.guest) access.guest = permSan(c.guest, access.guest);
    if (c.member) access.member = permSan(c.member, access.member);
    accessSave();
    for (const d of devices) sessions.pushMe(d.id);
    return access;
  }

  // ── emparejar: el código aparece en la tele (hay que estar en el salón) o se pide permiso a un admin conectado
  const pairs = new Map(); // pid -> {code, name, ts, tries} o {ask: true, name, ts, result?, denied?}
  const pairLast = new Map();
  const pairDone = pid => sessions.notifyAdmins({ t: 'pairdone', pid });
  function pairClean() {
    for (const [k, v] of pairs) if (now() - v.ts > PAIR_TTL) { pairs.delete(k); if (v.ask) pairDone(k); }
    if (![...pairs.values()].some(v => !v.ask)) tv.hideCode();
  }
  function pairAsk(name) {
    if (!sessions.adminCount()) return { error: 'No hay ningún administrador conectado ahora. Usa el código de la tele.', noAdmin: true };
    const pid = crypto.randomBytes(8).toString('hex');
    pairs.set(pid, { ask: true, name, ts: now() });
    sessions.notifyAdmins({ t: 'pairreq', pid, name });
    setTimeout(pairClean, PAIR_TTL + 500).unref?.();
    return { pid, mode: 'ask' };
  }
  async function pairStart(ip, nameIn, mode) {
    pairClean();
    if (now() - (pairLast.get(ip) || 0) < 4000) return { error: 'Espera unos segundos' };
    if (pairs.size >= 4) return { error: 'Hay otras peticiones pendientes; prueba en un minuto' };
    const name = cleanName(nameIn) || 'Un dispositivo';
    if (mode === 'ask') { const r = pairAsk(name); if (!r.error) pairLast.set(ip, now()); return r; }
    if (!tv.ready()) return { error: 'La tele no está disponible ahora mismo' };
    pairLast.set(ip, now());
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const pid = crypto.randomBytes(8).toString('hex');
    pairs.set(pid, { code, name, ts: now(), tries: 0 });
    await tv.showCode(code, name);
    setTimeout(pairClean, PAIR_TTL + 500).unref?.();
    return { pid };
  }
  function pairConfirm(pid, code) {
    pairClean();
    const p = pairs.get(String(pid));
    if (!p || p.ask) return { error: 'La petición ha caducado. Pide un código nuevo.' };
    if (String(code).trim() !== p.code) {
      if (++p.tries >= 3) { pairs.delete(String(pid)); pairClean(); return { error: 'Demasiados fallos. Pide un código nuevo.', dead: true }; }
      return { error: 'Código incorrecto' };
    }
    pairs.delete(String(pid)); pairClean();
    return newDevice(p.name, 'guest');
  }
  function pairAnswer(pid, ok, role) {
    const p = pairs.get(String(pid));
    if (!p || !p.ask || p.result || p.denied) return { error: 'Esa petición ya no está pendiente' };
    if (ok) p.result = newDevice(p.name, ['member', 'guest'].includes(role) ? role : 'guest');
    else p.denied = true;
    p.ts = now(); // un poco más de vida para que el invitado recoja la respuesta
    pairDone(String(pid));
    return { ok: 1 };
  }
  function pairPoll(pid) {
    const p = pairs.get(String(pid));
    if (!p || !p.ask) return { error: 'La petición ha caducado', dead: true };
    if (p.denied) { pairs.delete(String(pid)); return { denied: true }; }
    if (p.result) { pairs.delete(String(pid)); return p.result; }
    return { pending: true };
  }
  /** Peticiones de acceso que esperan respuesta (se mandan a un admin al conectarse). */
  const pendingAsks = () => [...pairs].filter(([, v]) => v.ask && !v.result && !v.denied).map(([pid, v]) => ({ pid, name: v.name }));

  // ── enlace o código de admin: un solo uso, caduca en 10 min; así el token maestro no llega nunca al móvil
  const adminCodes = new Map(); // sha(código) -> caducidad
  function adminLink() {
    for (const [k, exp] of adminCodes) if (now() > exp) adminCodes.delete(k);
    if (adminCodes.size >= 8) return { error: 'Hay demasiados enlaces sin usar; espera unos minutos' };
    let c = ''; for (const x of crypto.randomBytes(10)) c += CODE_ABC[x & 31];
    const expires = now() + ADMIN_TTL;
    adminCodes.set(sha(c), expires);
    const code = c.slice(0, 5) + '-' + c.slice(5);
    return { ok: 1, code, url: adminUrl + '/#admin=' + code, expires, minutes: ADMIN_TTL / 60_000 };
  }
  function adminDevice(name, cur) {
    const d = tokenDev(cur);
    if (!d) return newDevice(cleanName(name) || 'Admin', 'admin');
    d.role = 'admin'; d.expires = null; devSave(); sessions.pushMe(d.id);
    log.info('dispositivo ascendido a admin:', d.name);
    return { token: cur, id: d.id, role: 'admin', expires: null };
  }
  function adminClaim(code, name, cur) { // cur: token que ya tiene este navegador; si es de un dispositivo, se asciende ese
    const h = sha(codeNorm(code)), exp = adminCodes.get(h);
    if (!exp || now() > exp) { adminCodes.delete(h); return { error: 'El código no vale o ha caducado. Pide otro.' }; }
    adminCodes.delete(h);
    return adminDevice(name, cur);
  }

  let timer = null;
  return {
    masterToken: () => TOKEN,
    isMaster, tokenDev, okToken, permsOf, byId, cleanName,
    settings: () => access, setAccess,
    devices: { list, setRole, extend, rename, revoke, kickGuests, newDevice },
    pairing: { start: pairStart, confirm: pairConfirm, answer: pairAnswer, poll: pairPoll, pendingAsks },
    admin: { link: adminLink, claim: adminClaim, device: adminDevice },
    /** Caducidad de invitados: se revisa cada minuto. */
    start() { timer = setInterval(() => { for (const d of [...devices]) if (d.expires && now() > d.expires) expire(d); }, 60_000); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createAccess, cleanName, sha };
