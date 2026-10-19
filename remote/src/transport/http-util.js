'use strict';
// @ts-check
// Piezas pequeñas de HTTP que comparten las rutas: responder, leer un cuerpo JSON con tope, la cookie del dispositivo,
// la IP real tras el proxy local y saber si quien pide es el navegador de la propia tele.

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
};

/** Cabeceras de seguridad en todas las respuestas. */
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}
const json = (res, code, obj, h = {}) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h });

/**
 * Lee el cuerpo entero sin pasar de `max` bytes. Devuelve el texto, o null si es demasiado grande.
 * @returns {Promise<string | null>}
 */
async function readBody(req, max) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString();
}

// cookie con el token del dispositivo: si el navegador pierde su almacenamiento, sigue entrando sin volver a emparejar
const cookieTok = req => (/(?:^|;\s*)tvt=([a-f0-9]{32})/.exec(req.headers.cookie || '') || [])[1] || '';
const setCookie = (t, exp) => ({ 'Set-Cookie': `tvt=${t}; Path=/; Max-Age=${exp ? Math.max(60, Math.round((exp - Date.now()) / 1000)) : 400 * 86400}; HttpOnly; SameSite=Lax` });
/** Token de la petición: cabecera Bearer, ?t= o cookie. */
const reqToken = (req, url) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || cookieTok(req);

// IP real del cliente cuando llega a través de un proxy local (nginx, tailscale serve)
function clientIp(req) {
  const a = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if ((a === '127.0.0.1' || a === '::1') && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
  return a;
}
// solo el navegador de la propia tele (bucle local, sin pasar por el proxy de Tailscale)
function isLocalTV(req) {
  const a = req.socket.remoteAddress || '';
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loop && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['tailscale-user-login'];
}

module.exports = { TYPES, send, json, readBody, cookieTok, setCookie, reqToken, clientIp, isLocalTV };
