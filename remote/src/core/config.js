'use strict';
// @ts-check
// Configuración del servidor del mando: variables de entorno y rutas, en un solo objeto inmutable.
// Es el único sitio que lee process.env; el resto recibe lo que necesita de aquí.
// Las variables y sus valores por defecto son las del contrato común (config/screen.env.example).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Primer ejecutable con ese nombre en PATH, o null. @param {string} name @param {string} [PATH] */
function which(name, PATH = '') {
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

/** Zona horaria del sistema (la de Node), o UTC si no se sabe. */
const systemTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** Número de una variable, o null si está vacía o no es un número. @param {string | undefined} v */
const num = v => (v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const noSlash = (/** @type {string} */ s) => s.replace(/\/+$/, '');

/**
 * Enlaces de administración: TV_ADMIN_URL si se da; si no, el alias mDNS del mando (TV_MDNS_NAME, por defecto mando.local,
 * servido por nginx en el puerto 80); si el alias está vacío (no se publica), http://<hostname>.local:<puerto>.
 * @param {NodeJS.ProcessEnv} env @param {number} port @param {string} host
 */
function adminUrl(env, port, host) {
  if (env.TV_ADMIN_URL) return noSlash(env.TV_ADMIN_URL);
  const mdns = env.TV_MDNS_NAME === undefined ? 'mando.local' : env.TV_MDNS_NAME.trim();
  return mdns ? `http://${mdns}` : `http://${host}.local:${port}`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ hostname?: string }} [o] para las pruebas
 */
function loadConfig(env = process.env, { hostname = os.hostname() } = {}) {
  const ROOT = path.resolve(__dirname, '..', '..');           // remote/ (el código)
  const HOME = env.HOME || os.homedir();
  const PORT = Number(env.TV_PORT) || 8787;
  const SELF = `http://127.0.0.1:${PORT}`;
  const NAME = (env.TV_NAME || '').trim() || 'Pantalla';
  const STATE_DIR = path.resolve(env.TV_STATE_DIR || path.join(HOME, '.local', 'state', 'jota-screen'));
  const OC_BIN = env.TV_OPENCLAW || which('openclaw', env.PATH) || path.join(HOME, '.npm-global', 'bin', 'openclaw');
  return Object.freeze({
    ROOT,
    PUB: path.join(ROOT, 'public'),
    HOME,
    PORT,
    CDP_PORT: Number(env.TV_CDP_PORT) || 9222,
    DEBUG: !!env.TV_DEBUG,
    NO_POINTER: !!env.TV_NO_POINTER,
    SELF,
    NAME,                                                       // nombre visible de la pantalla
    OWNER: (env.TV_OWNER || '').trim(),                         // dueño (opcional): solo para las instrucciones del agente
    HOME_URL: env.TV_HOME_URL || SELF + '/idle.html',          // la pantalla en reposo
    STATE_DIR,                                                  // todo el estado: token, *.json y stage/
    STAGE_DIR: path.join(STATE_DIR, 'stage'),
    OC_BIN,                                                     // OpenClaw (agente), por su CLI
    OC_AGENT: env.TV_AGENT || 'jota',
    OC_ENV: Object.freeze({ ...env, PATH: path.dirname(OC_BIN) + ':' + (env.PATH || '') }),
    ADMIN_URL: adminUrl(env, PORT, hostname),
    SPOTIFY_BANNER: !!env.TV_SPOTIFY_BANNER,
    SP_DEVICE: (env.TV_SPOTIFY_DEVICE || '').trim() || NAME,
    PUBLIC_URL: noSlash(env.TV_PUBLIC_URL || SELF),
    DISPLAY: env.DISPLAY || ':0',
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`,
    // valores iniciales del tiempo en el reposo (idle.json manda si existe); sin lat/lon no se pide el tiempo
    PLACE: Object.freeze({ city: (env.TV_CITY || '').trim().slice(0, 60), lat: num(env.TV_LAT), lon: num(env.TV_LON), tz: (env.TV_TZ || '').trim() || systemTz() }),
    FILES: Object.freeze({
      token: path.join(STATE_DIR, 'token'),
      devices: path.join(STATE_DIR, 'devices.json'),
      access: path.join(STATE_DIR, 'access.json'),
      spotify: path.join(STATE_DIR, 'spotify.json'),
      idle: path.join(STATE_DIR, 'idle.json'),
    }),
    // dónde estaba el estado antes de TV_STATE_DIR (lo mueve src/core/state-dir.js al arrancar)
    LEGACY: Object.freeze({
      files: Object.freeze(['token', 'devices.json', 'access.json', 'spotify.json', 'idle.json'].map(f => path.join(ROOT, f))),
      stage: path.join(HOME, 'tv', 'stage'),
    }),
  });
}

module.exports = { loadConfig, adminUrl, which };
