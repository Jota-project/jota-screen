'use strict';
// @ts-check
// Estáticos de remote/public: se cargan en memoria al arrancar (con gzip para el HTML y ETag), cada página con su CSP.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { TYPES, send } = require('./http-util');

// el mando: todo en línea; solo las fuentes de Jota Dusk (Fraunces, Inter) vienen de Google, como en el reposo
const CSP = "default-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: https://*.scdn.co https://*.spotifycdn.com; manifest-src 'self'; base-uri 'none'; form-action 'none'";
// páginas del escenario: pueden cargar imágenes, fuentes, vídeo y librerías de internet, pero no hablar con otros servicios
const STAGE_CSP = "default-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; " +
  "img-src * data: blob:; media-src * data: blob:; font-src * data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const IDLE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
  "script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws:; base-uri 'none'; form-action 'none'";

/** @param {{ dir: string }} o */
function createStatic({ dir }) {
  const assets = new Map();
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    const ext = path.extname(f);
    assets.set('/' + f, {
      buf, gz: ext === '.html' ? zlib.gzipSync(buf, { level: 9 }) : null, type: TYPES[ext] || 'application/octet-stream',
      etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
    });
  }
  /** Sirve un fichero cargado (o 404). */
  function serve(req, res, p) {
    const a = assets.get(p);
    if (!a) return send(res, 404, 'no encontrado');
    const h = { 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': p === '/index.html' || /^\/(tpl-|tv-stage|tv-island|idle|stage\.css)/.test(p) ? 'no-cache' : 'public, max-age=86400' };
    if (p === '/index.html') h['Content-Security-Policy'] = CSP;
    else if (p.startsWith('/tpl-')) h['Content-Security-Policy'] = STAGE_CSP;
    else if (p === '/idle.html') h['Content-Security-Policy'] = IDLE_CSP;
    if (req.headers['if-none-match'] === a.etag) return send(res, 304, '', h);
    if (a.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; return send(res, 200, req.method === 'HEAD' ? '' : a.gz, h); }
    send(res, 200, req.method === 'HEAD' ? '' : a.buf, h);
  }
  return { get: p => assets.get(p), has: p => assets.has(p), serve };
}

/**
 * Manifiesto dinámico: si llega el token de un dispositivo, el acceso directo instalado lo conserva (el maestro, nunca).
 * @param {{ get: Function, has: Function }} statics @param {(t: any) => any} tokenDev
 */
function manifestRoute(statics, tokenDev) {
  return {
    path: '/manifest.webmanifest',
    run(req, res, { url, p }) {
      if (!statics.has(p)) return statics.serve(req, res, p);
      const man = JSON.parse(statics.get(p).buf.toString());
      const mt = url.searchParams.get('t'); if (tokenDev(mt)) man.start_url = '/?t=' + encodeURIComponent(mt);
      return send(res, 200, JSON.stringify(man), { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store' });
    },
  };
}

module.exports = { createStatic, manifestRoute, CSP, STAGE_CSP, IDLE_CSP };
