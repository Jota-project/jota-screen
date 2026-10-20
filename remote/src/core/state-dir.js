'use strict';
// @ts-check
// Carpeta de estado (TV_STATE_DIR): se crea con 0700 y, al arrancar y antes de leer nada, se trae lo que hubiera en las
// ubicaciones antiguas (remote/token, remote/*.json y ~/tv/stage). Se MUEVE (rename; entre sistemas de ficheros, copia y
// borra), nunca se sobrescribe lo que ya esté en la carpeta nueva y en el registro solo salen rutas, nunca el contenido.
const fs = require('node:fs');
const path = require('node:path');

/** Mueve un fichero o carpeta; si rename no puede (EXDEV, otro sistema de ficheros), copia y borra el original. */
function move(src, dst) {
  try { fs.renameSync(src, dst); return; } catch (e) { if (/** @type {any} */ (e).code !== 'EXDEV') throw e; }
  fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  fs.rmSync(src, { recursive: true, force: true });
}

/** Permisos privados: 0700 las carpetas y 0600 los ficheros (recorre las carpetas). */
function privatize(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.chmodSync(p, 0o700);
    for (const f of fs.readdirSync(p)) privatize(path.join(p, f));
  } else if (st.isFile()) fs.chmodSync(p, 0o600);
}

const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const emptyDir = p => { try { return fs.lstatSync(p).isDirectory() && fs.readdirSync(p).length === 0; } catch { return false; } };

/**
 * @param {{ STATE_DIR: string, LEGACY: { files: readonly string[], stage: string } }} cfg
 * @param {(...a: any[]) => void} [log]
 * @returns {{ moved: string[], kept: string[] }} rutas antiguas movidas y las que se dejaron porque ya había una nueva
 */
function prepareStateDir({ STATE_DIR, LEGACY }, log = () => {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700); // también si ya existía con más permisos: aquí vive el token maestro
  const moved = [], kept = [];
  const pairs = [...LEGACY.files.map(f => [f, path.join(STATE_DIR, path.basename(f))]), [LEGACY.stage, path.join(STATE_DIR, 'stage')]];
  for (const [src, dst] of pairs) {
    if (path.resolve(src) === path.resolve(dst) || !exists(src)) continue;
    if (emptyDir(dst) && fs.lstatSync(src).isDirectory()) fs.rmdirSync(dst); // una carpeta nueva vacía no cuenta
    if (exists(dst)) {
      kept.push(src);
      log(`estado: ${src} no se mueve, ya existe ${dst} (se usa el nuevo; el antiguo se puede borrar)`);
      continue;
    }
    try {
      move(src, dst);
      privatize(dst);
      moved.push(src);
      log(`estado: movido ${src} -> ${dst}`);
    } catch (e) { log(`estado: no se pudo mover ${src} -> ${dst}: ${/** @type {any} */ (e).code || 'error'}`); }
  }
  return { moved, kept };
}

module.exports = { prepareStateDir };
