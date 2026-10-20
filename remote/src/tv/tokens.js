'use strict';
// @ts-check
// Tokens de Jota Dusk para la tele (public/shared/tokens-tv.css). El reposo los enlaza como CSS; la isla de Live Activities
// no puede: se inyecta por CDP en webs ajenas (con su propia CSP, sin acceso a nuestra red y sin tiempo para cargar nada),
// así que el servidor le pasa el cuerpo del bloque :root como texto, delante de tv-island.js.
const fs = require('node:fs');
const path = require('node:path');

const TOKENS = path.join('shared', 'tokens-tv.css');
const ISLAND = 'tv-island.js';
const TALK = 'tv-talk.js';

/**
 * Cuerpo del único bloque `:root{…}` de tokens-tv.css (las declaraciones, sin llaves ni comentarios).
 * Lanza un error si el fichero no tiene exactamente un bloque :root o si hay algo más que ese bloque.
 * @param {string} pubDir carpeta public/
 * @returns {string}
 */
function readTokens(pubDir) {
  const file = path.join(pubDir, TOKENS);
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...css.matchAll(/:root\s*\{([^{}]*)\}/g)];
  const rest = css.replace(/:root\s*\{[^{}]*\}/g, '').trim();
  if (blocks.length !== 1 || rest) {
    throw new Error(`${file}: debe tener exactamente un bloque :root{…} de declaraciones simples (hay ${blocks.length}${rest ? ' y algo más fuera' : ''})`);
  }
  return blocks[0][1].replace(/\s+/g, ' ').trim();
}

/**
 * Fuente de la isla tal como se evalúa en la página: los tokens en `__TV_TOKENS` y detrás tv-island.js.
 * Se relee en cada llamada, como antes, para que un cambio en public/ se vea sin reiniciar.
 * @param {string} pubDir carpeta public/
 * @returns {string}
 */
function islandSource(pubDir) {
  return withTokens(pubDir, ISLAND);
}

/**
 * Fuente de la capa de conversación (tv-talk.js), con los tokens delante como la isla.
 * @param {string} pubDir carpeta public/
 * @returns {string}
 */
function talkSource(pubDir) {
  return withTokens(pubDir, TALK);
}

/** @param {string} pubDir @param {string} file */
function withTokens(pubDir, file) {
  return 'var __TV_TOKENS=' + JSON.stringify(readTokens(pubDir)) + ';\n' + fs.readFileSync(path.join(pubDir, file), 'utf8');
}

module.exports = { readTokens, islandSource, talkSource };
