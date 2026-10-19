'use strict';
// @ts-check
// Configuración del servidor del mando: variables de entorno y rutas, en un solo objeto inmutable.
// Es el único sitio que lee process.env; el resto recibe lo que necesita de aquí.
const path = require('node:path');
const os = require('node:os');

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadConfig(env = process.env) {
  const ROOT = path.resolve(__dirname, '..', '..');           // remote/
  const PORT = Number(env.TV_PORT) || 8787;
  const SELF = `http://127.0.0.1:${PORT}`;
  const OC_BIN = env.TV_OPENCLAW || path.join(os.homedir(), '.npm-global/bin/openclaw');
  return Object.freeze({
    ROOT,
    PUB: path.join(ROOT, 'public'),
    PORT,
    CDP_PORT: Number(env.TV_CDP_PORT) || 9222,
    DEBUG: !!env.TV_DEBUG,
    NO_POINTER: !!env.TV_NO_POINTER,
    SELF,
    HOME_URL: env.TV_HOME_URL || SELF + '/idle.html',          // la pantalla en reposo
    STAGE_DIR: path.join(os.homedir(), 'tv', 'stage'),
    OC_BIN,                                                     // OpenClaw (agente), por su CLI
    OC_AGENT: env.TV_AGENT || 'jota',
    OC_ENV: Object.freeze({ ...env, PATH: path.dirname(OC_BIN) + ':' + (env.PATH || '') }),
    ADMIN_URL: (env.TV_ADMIN_URL || 'http://mando.local').replace(/\/+$/, ''),
    SPOTIFY_BANNER: !!env.TV_SPOTIFY_BANNER,
    SP_DEVICE: env.TV_SPOTIFY_DEVICE || 'Salón',
    PUBLIC_URL: (env.TV_PUBLIC_URL || 'https://green-house.tailf2c275.ts.net:8443').replace(/\/+$/, ''),
    DISPLAY: env.DISPLAY || ':0',
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`,
    FILES: Object.freeze({
      token: path.join(ROOT, 'token'),
      devices: path.join(ROOT, 'devices.json'),
      access: path.join(ROOT, 'access.json'),
      spotify: path.join(ROOT, 'spotify.json'),
      idle: path.join(ROOT, 'idle.json'),
    }),
  });
}

module.exports = { loadConfig };
