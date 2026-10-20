'use strict';
// @ts-check
// Estáticos de remote/public: se cargan en memoria al arrancar (con gzip para el HTML y ETag), cada página con su CSP.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { TYPES, send } = require('./http-util');

// el mando: su CSS y su JS van en ficheros (mando/styles/mando.css, mando/theme.js, mando/app.js), así que nada en línea;
// solo las fuentes de Jota Dusk (Fraunces, Inter) vienen de Google, como en el reposo
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; " +
  "connect-src 'self' ws: wss:; img-src 'self' data: https://*.scdn.co https://*.spotifycdn.com; media-src 'self' data: blob:; manifest-src 'self'; base-uri 'none'; " +
  "form-action 'none'; object-src 'none'; frame-ancestors 'none'";
// páginas del escenario: pueden cargar imágenes, fuentes, vídeo y librerías de internet, pero no hablar con otros servicios
const STAGE_CSP = "default-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; " +
  "img-src * data: blob:; media-src * data: blob:; font-src * data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
// el reposo: su CSS y su JS van en ficheros (idle.css, idle-app.js, shared/tokens-tv.css), así que nada en línea
const IDLE_CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
  "script-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws:; base-uri 'none'; form-action 'none'";

// rutas que ya tienen dueño: una carpeta de public/ con ese nombre quedaría tapada (o taparía la ruta)
const RESERVED = new Set(['api', 'pair', 'stage', 'idle', 'spotify', 'ws', 'idle-ws', 'stage-ws']);
const ZIP = new Set(['.html', '.css', '.js', '.svg', '.webmanifest', '.json']);
const LONG_CACHE = new Set(['.png', '.svg', '.woff2', '.jpg', '.webp', '.ico']);
// sin build no hay huellas en los nombres: lo que cambia con cada versión (html, js, css, tokens) se revalida siempre por ETag
const cacheFor = p => (LONG_CACHE.has(path.extname(p)) && !p.startsWith('/shared/') ? 'public, max-age=86400' : 'no-cache');
// CSP de cada página; los .js, .css e imágenes no la llevan
const pageCsp = p => (p === '/index.html' ? CSP : p === '/idle.html' ? IDLE_CSP : /^\/tpl-[\w-]+\.html$/.test(p) ? STAGE_CSP : null);

const escHtml = (/** @type {string} */ v) => v.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const escJson = (/** @type {string} */ v) => JSON.stringify(v).slice(1, -1);
/**
 * Pone los valores de la instalación ({{TV_NAME}}…) en el HTML y en el manifiesto, escapados para cada formato.
 * @param {Buffer} buf @param {string} ext @param {Record<string, string>} vars
 */
function fill(buf, ext, vars) {
  const esc = ext === '.html' ? escHtml : ext === '.webmanifest' || ext === '.json' ? escJson : null;
  if (!esc || !Object.keys(vars).length) return buf;
  const src = buf.toString('utf8');
  const out = src.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? esc(String(vars[k])) : m));
  return out === src ? buf : Buffer.from(out);
}

/**
 * Carga public/ en memoria al arrancar, con subcarpetas (hasta 2 niveles). Solo se sirve lo cargado aquí: una ruta con
 * «..» o %2F nunca llega al disco (la URL ya viene normalizada y se busca la clave exacta). Se saltan los ficheros
 * ocultos y los enlaces simbólicos (que podrían apuntar fuera de public/). En el HTML y el manifiesto, {{CLAVE}} se cambia
 * por vars.CLAVE (p. ej. el nombre de la pantalla).
 * @param {{ dir: string, maxDepth?: number, vars?: Record<string, string> }} o
 */
function createStatic({ dir, maxDepth = 2, vars = {} }) {
  const assets = new Map();
  function walk(abs, rel, depth) {
    for (const f of fs.readdirSync(abs)) {
      if (f.startsWith('.')) continue;
      const full = path.join(abs, f), st = fs.lstatSync(full), key = rel + '/' + f;
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth === 0 && RESERVED.has(f)) throw new Error(`public/${f} choca con la ruta /${f}/ del servidor`);
        if (depth < maxDepth) walk(full, key, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = path.extname(f);
      const buf = fill(fs.readFileSync(full), ext, vars);
      assets.set(key, {
        buf, gz: ZIP.has(ext) ? zlib.gzipSync(buf, { level: 9 }) : null, type: TYPES[ext] || 'application/octet-stream',
        etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
      });
    }
  }
  walk(dir, '', 0);
  /** Sirve un fichero cargado (o 404). */
  function serve(req, res, p) {
    const a = assets.get(p);
    if (!a) return send(res, 404, 'no encontrado');
    const h = { 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': cacheFor(p) };
    const csp = pageCsp(p);
    if (csp) h['Content-Security-Policy'] = csp;
    if (req.headers['if-none-match'] === a.etag) return send(res, 304, '', h);
    if (a.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; return send(res, 200, req.method === 'HEAD' ? '' : a.gz, h); }
    send(res, 200, req.method === 'HEAD' ? '' : a.buf, h);
  }
  return { get: p => assets.get(p), has: p => assets.has(p), serve };
}

/**
 * Manifiesto dinámico: si llega el token de un dispositivo, el acceso directo instalado lo conserva (el maestro, nunca).
 * @param {{ get: Function, has: Function, serve: Function }} statics @param {(t: any) => any} tokenDev
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

module.exports = { createStatic, manifestRoute, cacheFor, pageCsp, CSP, STAGE_CSP, IDLE_CSP };
