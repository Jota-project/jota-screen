'use strict';
// @ts-check
// Tokens de Jota Dusk para la tele (public/shared/tokens-tv.css). El reposo los enlaza como CSS; la isla de Live Activities
// no puede: se inyecta por CDP en webs ajenas (con su propia CSP, sin acceso a nuestra red y sin tiempo para cargar nada),
// así que el servidor le pasa el cuerpo del bloque :root como texto, delante de tv-island.js (y de la capa del agente).
// La capa del agente lleva además sus fuentes (public/fonts/, OFL) como bytes: así se ve igual en el reposo y en una web
// con `font-src 'none'` (FontFace desde un ArrayBuffer no pide nada a la red).
const fs = require('node:fs');
const path = require('node:path');
const { FONT_SERIF, FONT_SANS } = require('./agent-contract');

const TOKENS = path.join('shared', 'tokens-tv.css');
const ISLAND = 'tv-island.js';
const AGENT = 'tv-agent.js';
// fuentes de la capa del agente: la que falte en public/ no se manda (y la capa usa su pila de reserva). Inter no está
// vendorizada aún: se pone aquí con su OFL y entra sola (la capa ya la pide con FONT_SANS)
const AGENT_FONTS = Object.freeze([
  { family: FONT_SERIF, file: path.join('fonts', 'fraunces-latin-opsz-normal.woff2'), weight: '100 900' },
  { family: FONT_SANS, file: path.join('fonts', 'inter-latin-wght-normal.woff2'), weight: '100 900' },
]);

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
 * Fuente de la capa del agente (tv-agent.js), con los tokens delante como la isla.
 * @param {string} pubDir carpeta public/
 * @returns {string}
 */
function agentSource(pubDir) {
  return 'var __TV_FONTS=' + JSON.stringify(agentFonts(pubDir)) + ';\n' + withTokens(pubDir, AGENT);
}

/** @type {Map<string, { mtime: number, data: string }>} */
const fontCache = new Map(); // base64 por fichero (se relee si cambia)
/**
 * Las fuentes de la capa que hay en public/: `{ family, weight, data }` con los bytes en base64.
 * @param {string} pubDir carpeta public/
 * @returns {{ family: string, weight: string, data: string }[]}
 */
function agentFonts(pubDir) {
  const out = [];
  for (const f of AGENT_FONTS) {
    const file = path.join(pubDir, f.file);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let c = fontCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) { c = { mtime: st.mtimeMs, data: fs.readFileSync(file).toString('base64') }; fontCache.set(file, c); }
    out.push({ family: f.family, weight: f.weight, data: c.data });
  }
  return out;
}

/** @param {string} pubDir @param {string} file */
function withTokens(pubDir, file) {
  return 'var __TV_TOKENS=' + JSON.stringify(readTokens(pubDir)) + ';\n' + fs.readFileSync(path.join(pubDir, file), 'utf8');
}

module.exports = { readTokens, islandSource, agentSource, agentFonts, AGENT_FONTS };
