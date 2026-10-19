'use strict';
// @ts-check
// Almacén JSON para el estado del servidor (dispositivos, accesos, Spotify, reposo…).
// Escritura atómica (fichero temporal + rename: un corte de luz no deja el JSON a medias) y permisos 0600.
const fs = require('node:fs');
const path = require('node:path');

/**
 * Lee un JSON; si no existe o está roto, devuelve `fallback`.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {any}
 */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Escribe de forma atómica con permisos 0600.
 * @param {string} file
 * @param {unknown} data
 * @param {{ pretty?: boolean }} [o]
 */
function writeJson(file, data, { pretty = false } = {}) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/**
 * Almacén ligado a un fichero: load() devuelve el valor saneado, save(v) lo guarda.
 * @param {string} file
 * @param {{ fallback?: any, sanitize?: (raw: any) => any, pretty?: boolean }} [o]
 */
function createJsonStore(file, { fallback = null, sanitize = x => x, pretty = false } = {}) {
  return {
    file,
    load: () => sanitize(readJson(file, fallback)),
    save: v => writeJson(file, v, { pretty }),
  };
}

module.exports = { readJson, writeJson, createJsonStore };
