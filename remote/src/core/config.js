'use strict';
// @ts-check
// Configuración del servidor del mando: variables de entorno y rutas, en un solo objeto inmutable.
// Es el único sitio que lee process.env; el resto recibe lo que necesita de aquí.
// Las variables y sus valores por defecto son las del contrato común (config/screen.env.example).
const path = require('node:path');
const os = require('node:os');

/** Zona horaria del sistema (la de Node), o UTC si no se sabe. */
const systemTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** Número de una variable, o null si está vacía o no es un número. @param {string | undefined} v */
const num = v => (v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** TV_SPEAKER_CMD (palabras separadas por espacios) → lista, o null si está vacío. @param {string} [v] */
const speakerCmd = v => { const a = String(v || '').trim().split(/\s+/).filter(Boolean); return a.length ? a : null; };
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
    GATEWAY_URL: (env.TV_GATEWAY_URL || '').trim(),             // J Gateway (voz): ws://<host>:8004/ws/stream; vacío = sin voz
    GATEWAY_KEY: (env.TV_GATEWAY_KEY || '').trim(),             // clave del cliente en el Gateway (nunca a logs ni al repo)
    SPEAKER_CMD: speakerCmd(env.TV_SPEAKER_CMD),   // altavoz de la tele (stdin = PCM16 24 kHz mono); vacío = pw-cat
    AGENT: (env.TV_AGENT || '').trim() || 'j-assistant',        // agente del Gateway
    ADMIN_URL: adminUrl(env, PORT, hostname),
    SPOTIFY_BANNER: !!env.TV_SPOTIFY_BANNER,
    SP_DEVICE: (env.TV_SPOTIFY_DEVICE || '').trim() || NAME,
    NETFLIX_PROFILE: (env.TV_NETFLIX_PROFILE || '').trim(),    // perfil de Netflix por defecto (el mando puede cambiarlo)
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
      netflix: path.join(STATE_DIR, 'netflix.json'),
      watching: path.join(STATE_DIR, 'watching.json'),       // «Seguir viendo» e historial de Netflix (lo lee netflix-watch)
    }),
    // dónde estaba el estado antes de TV_STATE_DIR (lo mueve src/core/state-dir.js al arrancar)
    LEGACY: Object.freeze({
      files: Object.freeze(['token', 'devices.json', 'access.json', 'spotify.json', 'idle.json'].map(f => path.join(ROOT, f))),
      stage: path.join(HOME, 'tv', 'stage'),
    }),
  });
}

module.exports = { loadConfig, adminUrl };
